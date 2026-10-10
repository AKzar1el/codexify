use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Notify, RwLock, mpsc};
use tokio_util::sync::CancellationToken;

use super::companion::{MAX_PROMPT_BYTES, MAX_UNREAD_MESSAGES, rendered_action_prompt_bytes};
use super::store::{MAX_CHAT_MIRROR_IDS, MAX_PRIVATE_TEXT_BYTES, QueueFailure};
use super::{
    AcceptedChatBatch, ActionPrompt, AgentAutomationStore, AutomationActionKind,
    AutomationActionStatus, BrowserCompanionClient, CapabilityCatalog, CompanionActionSnapshot,
    CompanionActionState, CompanionEvent, CompanionEventKind, CompanionSessionStatus,
    CompanionUnreadMessage, ExecuteActionRequest, GoalStatus,
};
use crate::markdown_chat::{AgentAutomationConfig, ChatFile, OFFLINE_AFTER_MS};
use crate::project_bindings::ConversationIdentity;

#[derive(Clone)]
pub struct AutomationExecution {
    pub task_key: String,
    pub owner_generation: u64,
    pub account_fingerprint: String,
    pub catalog_revision: String,
    pub activity_epoch: String,
    pub activity_sequence: u64,
    pub tool_call_count_at_start: u64,
    pub unread_message_ids: Vec<String>,
    pub transcript_revision: String,
    pub pairing_commit: Option<PairingCommit>,
    pub request: ExecuteActionRequest,
}

#[derive(Clone)]
pub struct PairingCommit {
    task: ConversationIdentity,
    store: Arc<AgentAutomationStore>,
    generation: u64,
}

impl PairingCommit {
    #[doc(hidden)]
    pub fn new(
        task: ConversationIdentity,
        store: Arc<AgentAutomationStore>,
        generation: u64,
    ) -> Self {
        Self {
            task,
            store,
            generation,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationExecutionError {
    pub message: String,
    pub send_accepted: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationLiveState {
    pub action_id: Option<String>,
    pub phase: AutomationActionStatus,
    pub status: Option<String>,
    pub commentary: Option<String>,
    pub answer: Option<String>,
    pub updated_at_ms: u64,
}

#[async_trait]
pub trait AutomationExecutor: Send + Sync {
    async fn execute(
        &self,
        execution: AutomationExecution,
        events: mpsc::UnboundedSender<CompanionEvent>,
        cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError>;
}

#[derive(Clone)]
pub struct BrowserAutomationExecutor {
    config: AgentAutomationConfig,
}

impl BrowserAutomationExecutor {
    pub fn new(config: AgentAutomationConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl AutomationExecutor for BrowserAutomationExecutor {
    async fn execute(
        &self,
        execution: AutomationExecution,
        events: mpsc::UnboundedSender<CompanionEvent>,
        cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        let client = BrowserCompanionClient::from_config(&self.config)
            .map_err(|message| execution_error(message, false))?;
        let health = client
            .health(&cancellation)
            .await
            .map_err(|message| execution_error(message, false))?;
        if !health.authenticated {
            return Err(execution_error(
                "Browser companion authentication is required".into(),
                false,
            ));
        }
        if health.account_fingerprint.as_deref() != Some(execution.account_fingerprint.as_str()) {
            return Err(execution_error(
                "Browser companion account changed; refresh capabilities and verify the pairing again"
                    .into(),
                false,
            ));
        }
        if health.status != CompanionSessionStatus::Idle || health.active_action_id.is_some() {
            return Err(execution_error(
                "Browser companion is busy with another action".into(),
                false,
            ));
        }
        let catalog = client
            .capabilities(&cancellation)
            .await
            .map_err(|message| execution_error(message, false))?;
        validate_execution_catalog(&execution, &catalog)
            .map_err(|message| execution_error(message, false))?;

        if let Some(commit) = &execution.pairing_commit {
            commit
                .store
                .record_pairing_canonical_url(
                    &commit.task,
                    commit.generation,
                    &execution.request.expected_url,
                    crate::markdown_chat::now_ms(),
                )
                .map_err(|message| execution_error(message, false))?;
        }

        let initial = client
            .execute_with_acceptance(&execution.request, &cancellation)
            .await
            .map_err(|error| execution_error(error.message, error.send_accepted))?;
        if action_is_terminal(initial.state) {
            if initial.last_event_sequence > 0 {
                let mut last_event_sequence = 0;
                let first = client
                    .stream_action_events(&execution.request.action_id, 0, &cancellation, |event| {
                        let sequence = event.sequence;
                        events.send(event).map_err(|_| {
                            "Browser automation event receiver is unavailable".to_string()
                        })?;
                        last_event_sequence = sequence;
                        Ok(())
                    })
                    .await;
                if let Err(message) = first {
                    client
                        .stream_action_events(
                            &execution.request.action_id,
                            last_event_sequence,
                            &cancellation,
                            |event| {
                                let sequence = event.sequence;
                                events.send(event).map_err(|_| {
                                    "Browser automation event receiver is unavailable".to_string()
                                })?;
                                last_event_sequence = sequence;
                                Ok(())
                            },
                        )
                        .await
                        .map_err(|retry| {
                            execution_error(
                                format!(
                                    "{message}; retained browser event reconciliation failed: {retry}"
                                ),
                                initial.send_accepted,
                            )
                        })?;
                }
            }
            validate_terminal_snapshot(&execution, &initial)?;
            return Ok(initial);
        }

        let mut last_event_sequence = 0;
        let mut previous_stream_error: Option<String> = None;
        loop {
            let stream = client
                .stream_action_events(
                    &execution.request.action_id,
                    last_event_sequence,
                    &cancellation,
                    |event| {
                        last_event_sequence = event.sequence;
                        events.send(event).map_err(|_| {
                            "Browser automation event receiver is unavailable".to_string()
                        })
                    },
                )
                .await;
            let Err(stream_error) = stream else {
                break;
            };
            let message = previous_stream_error.as_ref().map_or_else(
                || stream_error.clone(),
                |previous| {
                    format!("{previous}; retained browser event reconnect failed: {stream_error}")
                },
            );
            let reconciled = client
                .action(&execution.request.action_id, &cancellation)
                .await;
            if let Ok(ref snapshot) = reconciled
                && action_is_terminal(snapshot.state)
            {
                if last_event_sequence < snapshot.last_event_sequence {
                    client
                        .stream_action_events(
                            &execution.request.action_id,
                            last_event_sequence,
                            &cancellation,
                            |event| {
                                last_event_sequence = event.sequence;
                                events.send(event).map_err(|_| {
                                    "Browser automation event receiver is unavailable".to_string()
                                })
                            },
                        )
                        .await
                        .map_err(|retry| {
                            execution_error(
                                format!(
                                    "{message}; retained browser event reconciliation failed: {retry}"
                                ),
                                snapshot.send_accepted,
                            )
                        })?;
                }
                validate_terminal_snapshot(&execution, snapshot)?;
                return Ok(snapshot.clone());
            }
            if previous_stream_error.is_none() {
                previous_stream_error = Some(stream_error);
                continue;
            }
            return Err(execution_error(message, true));
        }
        let terminal = client
            .action(&execution.request.action_id, &cancellation)
            .await
            .map_err(|message| execution_error(message, initial.send_accepted))?;
        if !action_is_terminal(terminal.state) {
            return Err(execution_error(
                "Browser companion action did not reach a terminal state".into(),
                terminal.send_accepted || initial.send_accepted,
            ));
        }
        validate_terminal_snapshot(&execution, &terminal)?;
        Ok(terminal)
    }
}

#[derive(Clone)]
pub struct AutomationTaskHandle {
    task: ConversationIdentity,
    owner_generation: u64,
    store: Arc<AgentAutomationStore>,
    chat: Arc<ChatFile>,
}

impl AutomationTaskHandle {
    pub fn new(
        task: ConversationIdentity,
        owner_generation: u64,
        store: Arc<AgentAutomationStore>,
        chat: Arc<ChatFile>,
    ) -> Self {
        Self {
            task,
            owner_generation,
            store,
            chat,
        }
    }
}

pub struct AgentAutomationSupervisor {
    config: AgentAutomationConfig,
    executor: Arc<dyn AutomationExecutor>,
    tasks: RwLock<HashMap<String, AutomationTaskHandle>>,
    queue: Mutex<VecDeque<AutomationExecution>>,
    scan_lock: Mutex<()>,
    run_lock: Mutex<()>,
    live: RwLock<HashMap<String, AutomationLiveState>>,
    wake: Arc<Notify>,
}

pub struct AutomationSupervisorWorker {
    task: tokio::task::JoinHandle<()>,
}

impl Drop for AutomationSupervisorWorker {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl AgentAutomationSupervisor {
    pub fn new(config: AgentAutomationConfig, executor: Arc<dyn AutomationExecutor>) -> Arc<Self> {
        Arc::new(Self {
            config,
            executor,
            tasks: RwLock::new(HashMap::new()),
            queue: Mutex::new(VecDeque::new()),
            scan_lock: Mutex::new(()),
            run_lock: Mutex::new(()),
            live: RwLock::new(HashMap::new()),
            wake: Arc::new(Notify::new()),
        })
    }

    pub fn start(self: &Arc<Self>) -> AutomationSupervisorWorker {
        let supervisor = self.clone();
        let task = tokio::spawn(async move {
            loop {
                if let Err(error) = supervisor.scan_once(crate::markdown_chat::now_ms()).await {
                    tracing::warn!(%error, "agent automation scan failed");
                }
                loop {
                    match supervisor.run_next(crate::markdown_chat::now_ms()).await {
                        Ok(Some(_)) => {}
                        Ok(None) => break,
                        Err(error) => {
                            tracing::warn!(%error, "agent automation action failed");
                        }
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {},
                    _ = supervisor.wake.notified() => {},
                }
            }
        });
        AutomationSupervisorWorker { task }
    }

    pub fn notify(&self) {
        self.wake.notify_one();
    }

    pub async fn register_task(&self, task: AutomationTaskHandle) -> Result<(), String> {
        if !self.config.enabled {
            return Err("Agent-chat browser automation is disabled".into());
        }
        let first_registration = !self.tasks.read().await.contains_key(task.task.stable_key());
        let state = task.store.load(&task.task)?;
        let owner_changed = state
            .pairing
            .verified_owner_generation
            .is_some_and(|generation| generation != task.owner_generation)
            || state
                .pairing
                .pending
                .as_ref()
                .is_some_and(|pending| pending.owner_generation != task.owner_generation);
        let orphaned_pairing = first_registration
            && state.action.status == AutomationActionStatus::Queued
            && state.action.kind == Some(AutomationActionKind::PairVerify);
        let orphaned_action = (first_registration
            && state.action.status == AutomationActionStatus::Queued
            && state.action.kind != Some(AutomationActionKind::PairVerify))
        .then(|| state.action.id.clone())
        .flatten();
        if owner_changed || orphaned_pairing {
            task.store.invalidate_pairing_and_supersede_action(
                &task.task,
                crate::markdown_chat::now_ms(),
            )?;
            self.queue
                .lock()
                .await
                .retain(|queued| queued.task_key != task.task.stable_key());
            self.live.write().await.remove(task.task.stable_key());
        } else if let Some(action_id) = orphaned_action {
            task.store.clear_persisted_queued_action(
                &task.task,
                &action_id,
                crate::markdown_chat::now_ms(),
            )?;
            self.queue
                .lock()
                .await
                .retain(|queued| queued.task_key != task.task.stable_key());
            self.live.write().await.remove(task.task.stable_key());
        }
        task.chat.ensure().await?;
        self.tasks
            .write()
            .await
            .insert(task.task.stable_key().to_string(), task);
        self.notify();
        Ok(())
    }

    pub async fn queued_count(&self) -> usize {
        self.queue.lock().await.len()
    }

    pub async fn queue_position(&self, task: &ConversationIdentity) -> Option<(usize, usize)> {
        let queue = self.queue.lock().await;
        let total = queue.len();
        queue
            .iter()
            .position(|execution| execution.task_key == task.stable_key())
            .map(|position| (position + 1, total))
    }

    pub async fn discard_queued_actions(&self, task: &ConversationIdentity) -> usize {
        let task_key = task.stable_key();
        let mut queue = self.queue.lock().await;
        let before = queue.len();
        queue.retain(|execution| execution.task_key != task_key);
        let removed = before.saturating_sub(queue.len());
        drop(queue);
        if removed > 0 {
            self.wake.notify_one();
        }
        removed
    }

    pub async fn cancel_queued_action(
        &self,
        task: &ConversationIdentity,
        expected_action_id: &str,
        now_ms: u64,
    ) -> Result<super::AutomationActionState, String> {
        let handle = self
            .tasks
            .read()
            .await
            .get(task.stable_key())
            .cloned()
            .ok_or("Browser automation task is not registered")?;
        let state = handle.store.load(&handle.task)?;
        if state.action.id.as_deref() != Some(expected_action_id)
            || state.action.status != AutomationActionStatus::Queued
        {
            return Err("Only the exact queued browser action can be cancelled here".into());
        }
        let removed = {
            let mut queue = self.queue.lock().await;
            let Some(position) = queue.iter().position(|execution| {
                execution.task_key == handle.task.stable_key()
                    && execution.request.action_id == expected_action_id
            }) else {
                return Err("The browser action already started or left the queue".into());
            };
            queue.remove(position);
            true
        };
        debug_assert!(removed);
        self.live.write().await.remove(handle.task.stable_key());
        let action = if state.action.kind == Some(AutomationActionKind::PairVerify) {
            handle.store.unlink_pairing(&handle.task, now_ms)?;
            handle.store.load(&handle.task)?.action
        } else {
            handle.store.update_action_status(
                &handle.task,
                expected_action_id,
                AutomationActionStatus::Failed,
                Some("Browser action cancelled before Send"),
                None,
                now_ms,
            )?
        };
        self.notify();
        Ok(action)
    }

    pub async fn retry_failed_action(
        &self,
        task: &ConversationIdentity,
        expected_action_id: &str,
        now_ms: u64,
    ) -> Result<super::AutomationActionState, String> {
        let handle = self
            .tasks
            .read()
            .await
            .get(task.stable_key())
            .cloned()
            .ok_or("Browser automation task is not registered")?;
        handle
            .store
            .reset_failed_action_for_retry(&handle.task, expected_action_id, now_ms)?;
        self.live.write().await.remove(handle.task.stable_key());
        self.scan_once(now_ms).await?;
        self.notify();
        Ok(handle.store.load(&handle.task)?.action)
    }

    #[doc(hidden)]
    pub async fn registered_count(&self) -> usize {
        self.tasks.read().await.len()
    }

    pub async fn queue_pair_verification(
        &self,
        task: &ConversationIdentity,
        reference: &str,
        generation: u64,
        now_ms: u64,
    ) -> Result<(), String> {
        let handle = self
            .tasks
            .read()
            .await
            .get(task.stable_key())
            .cloned()
            .ok_or("Browser automation task is not registered")?;
        let pairing = handle.store.validate_pending_pairing(
            &handle.task,
            generation,
            handle.owner_generation,
            reference,
            now_ms,
        )?;
        let candidate_url = pairing
            .candidate_url
            .ok_or("Agent automation pairing has no candidate URL")?;
        let state = handle.store.load(&handle.task)?;
        let (Some(model), Some(effort), Some(catalog_revision), Some(account_fingerprint)) = (
            state.selection.model,
            state.selection.effort,
            state.selection.catalog_revision,
            state.selection.account_fingerprint,
        ) else {
            return Err("Select a browser model and effort before pairing".into());
        };
        let mut queue = self.queue.lock().await;
        if let Some(position) = queue
            .iter()
            .position(|queued| queued.task_key == handle.task.stable_key())
        {
            queue.remove(position);
        }
        if queue.len() >= self.config.max_queued_actions {
            return Err("Browser automation queue capacity is exhausted".into());
        }
        let action_id = random_id("action")?;
        handle.store.queue_action(
            &handle.task,
            &action_id,
            AutomationActionKind::PairVerify,
            generation,
            None,
            now_ms,
        )?;
        queue.push_back(AutomationExecution {
            task_key: handle.task.stable_key().to_string(),
            owner_generation: handle.owner_generation,
            account_fingerprint,
            catalog_revision,
            activity_epoch: "pair-verification".into(),
            activity_sequence: generation,
            tool_call_count_at_start: 0,
            unread_message_ids: Vec::new(),
            transcript_revision: String::new(),
            pairing_commit: Some(PairingCommit::new(
                handle.task.clone(),
                handle.store.clone(),
                generation,
            )),
            request: ExecuteActionRequest {
                action_id,
                idempotency_key: random_id("execute")?,
                url: candidate_url.clone(),
                pairing_generation: generation,
                connector_name: self.config.connector_name.clone(),
                model,
                effort,
                prompt: ActionPrompt::PairVerify {
                    reference: reference.to_string(),
                },
                expected_url: candidate_url,
                auto_approve_tool_calls: self.config.auto_approve_tool_calls,
            },
        });
        queue
            .make_contiguous()
            .sort_by_key(|execution| action_priority(execution_kind(execution)));
        self.notify();
        Ok(())
    }

    #[doc(hidden)]
    pub async fn next_queued_kind(&self) -> Option<AutomationActionKind> {
        self.queue.lock().await.front().map(execution_kind)
    }

    pub async fn live_state(&self, task: &ConversationIdentity) -> Option<AutomationLiveState> {
        self.live.read().await.get(task.stable_key()).cloned()
    }

    pub async fn scan_once(&self, now_ms: u64) -> Result<(), String> {
        let _scan_guard = self.scan_lock.lock().await;
        let tasks = self
            .tasks
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for task in tasks {
            let activity = task.chat.offline_activity().await?;
            let Some(last_call_at_ms) = activity.last_call_at_ms else {
                continue;
            };
            if now_ms.saturating_sub(last_call_at_ms) < OFFLINE_AFTER_MS {
                continue;
            }
            let state = task.store.load(&task.task)?;
            let Some(url) = state.pairing.canonical_url.clone() else {
                continue;
            };
            if state.pairing.verified_owner_generation != Some(task.owner_generation) {
                continue;
            }
            if blocks_automatic_requeue(state.action.status) {
                continue;
            }
            let (Some(model), Some(effort), Some(catalog_revision), Some(account_fingerprint)) = (
                state.selection.model.clone(),
                state.selection.effort.clone(),
                state.selection.catalog_revision.clone(),
                state.selection.account_fingerprint.clone(),
            ) else {
                continue;
            };
            let unread = task.chat.unread_snapshot().await?;
            let unread_ids = unread
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            let retained_accepted =
                if state.chat_mirror.owner_generation == Some(task.owner_generation) {
                    state
                        .chat_mirror
                        .message_ids
                        .iter()
                        .filter(|id| unread_ids.contains(id.as_str()))
                        .cloned()
                        .collect::<Vec<_>>()
                } else {
                    Vec::new()
                };
            if state.chat_mirror.owner_generation != Some(task.owner_generation)
                || retained_accepted.len() != state.chat_mirror.message_ids.len()
            {
                task.store.retain_accepted_messages(
                    &task.task,
                    task.owner_generation,
                    &retained_accepted,
                )?;
            }
            let accepted = retained_accepted
                .iter()
                .collect::<std::collections::HashSet<_>>();
            let all_pending_messages = unread
                .messages
                .iter()
                .filter(|message| !accepted.contains(&message.id))
                .cloned()
                .collect::<Vec<_>>();
            let goal_revision = state
                .goal
                .as_ref()
                .filter(|goal| goal.status == GoalStatus::Active)
                .map(|goal| goal.revision);
            if !all_pending_messages.is_empty() && retained_accepted.len() >= MAX_CHAT_MIRROR_IDS {
                let kind = if goal_revision.is_some() {
                    AutomationActionKind::OfflineCombined
                } else {
                    AutomationActionKind::OfflineChat
                };
                let action_id = random_id("action")?;
                task.store.record_queue_failure(
                    &task.task,
                    QueueFailure {
                        action_id: &action_id,
                        kind,
                        pairing_generation: state.pairing.generation,
                        goal_revision,
                        message: "Browser automation accepted chat history is full; consume pending messages before retrying",
                        now_ms,
                    },
                )?;
                continue;
            }
            let pending_messages = match bounded_unread_batch(&all_pending_messages, goal_revision)
            {
                Ok(messages) => messages,
                Err(error) => {
                    let kind = if goal_revision.is_some() {
                        AutomationActionKind::OfflineCombined
                    } else {
                        AutomationActionKind::OfflineChat
                    };
                    let action_id = random_id("action")?;
                    task.store.record_queue_failure(
                        &task.task,
                        QueueFailure {
                            action_id: &action_id,
                            kind,
                            pairing_generation: state.pairing.generation,
                            goal_revision,
                            message: &error,
                            now_ms,
                        },
                    )?;
                    continue;
                }
            };
            let activity_epoch = activity
                .activity_epoch
                .clone()
                .unwrap_or_else(|| "legacy-activity".into());
            let activity_sequence = if activity.activity_sequence == 0 {
                activity.tool_call_count
            } else {
                activity.activity_sequence
            };
            if pending_messages.is_empty()
                && goal_revision.is_some()
                && state.goal_wake.nudged_epoch.as_deref() == Some(activity_epoch.as_str())
                && state.goal_wake.nudged_sequence == Some(activity_sequence)
            {
                continue;
            }
            if pending_messages.is_empty() && goal_revision.is_none() {
                continue;
            }
            let batch_id = (!pending_messages.is_empty()).then(|| {
                unread_batch_id(
                    task.task.stable_key(),
                    task.owner_generation,
                    state.pairing.generation,
                    &unread.revision,
                    pending_messages.iter().map(|message| message.id.as_str()),
                )
            });
            let messages = pending_messages
                .iter()
                .map(|message| CompanionUnreadMessage {
                    id: message.id.clone(),
                    markdown: message.markdown.clone(),
                })
                .collect::<Vec<_>>();
            let unread_message_ids = messages
                .iter()
                .map(|message| message.id.clone())
                .collect::<Vec<_>>();
            let (kind, prompt) = match (batch_id, goal_revision) {
                (Some(batch_id), Some(goal_revision)) => (
                    AutomationActionKind::OfflineCombined,
                    ActionPrompt::OfflineCombined {
                        batch_id,
                        messages,
                        goal_revision,
                    },
                ),
                (Some(batch_id), None) => (
                    AutomationActionKind::OfflineChat,
                    ActionPrompt::OfflineChat { batch_id, messages },
                ),
                (None, Some(goal_revision)) => (
                    AutomationActionKind::OfflineGoal,
                    ActionPrompt::OfflineGoal { goal_revision },
                ),
                (None, None) => continue,
            };
            let mut queue = self.queue.lock().await;
            if let Some(position) = queue
                .iter()
                .position(|queued| queued.task_key == task.task.stable_key())
            {
                let can_coalesce = queued_context_matches(
                    queue.get(position).expect("queued action position"),
                    task.owner_generation,
                    state.pairing.generation,
                    &url,
                    &model,
                    &effort,
                    &catalog_revision,
                    &account_fingerprint,
                    goal_revision,
                );
                if can_coalesce {
                    let queued = queue.get_mut(position).expect("queued action position");
                    task.store.queue_action(
                        &task.task,
                        &queued.request.action_id,
                        kind,
                        state.pairing.generation,
                        goal_revision,
                        now_ms,
                    )?;
                    queued.activity_epoch = activity_epoch.clone();
                    queued.activity_sequence = activity_sequence;
                    queued.tool_call_count_at_start = activity.tool_call_count;
                    queued.unread_message_ids = unread_message_ids;
                    queued.transcript_revision = unread.revision;
                    queued.request.prompt = prompt;
                    queue
                        .make_contiguous()
                        .sort_by_key(|execution| action_priority(execution_kind(execution)));
                    continue;
                }
                queue.remove(position);
            }
            if queue.len() >= self.config.max_queued_actions {
                let action_id = random_id("action")?;
                task.store.record_queue_failure(
                    &task.task,
                    QueueFailure {
                        action_id: &action_id,
                        kind,
                        pairing_generation: state.pairing.generation,
                        goal_revision,
                        message: "Browser automation queue capacity is exhausted; pending chat and goal work were preserved",
                        now_ms,
                    },
                )?;
                continue;
            }
            let action_id = random_id("action")?;
            let idempotency_key = random_id("execute")?;
            task.store.queue_action(
                &task.task,
                &action_id,
                kind,
                state.pairing.generation,
                goal_revision,
                now_ms,
            )?;
            queue.push_back(AutomationExecution {
                task_key: task.task.stable_key().to_string(),
                owner_generation: task.owner_generation,
                account_fingerprint,
                catalog_revision,
                activity_epoch,
                activity_sequence,
                tool_call_count_at_start: activity.tool_call_count,
                unread_message_ids,
                transcript_revision: unread.revision,
                pairing_commit: None,
                request: ExecuteActionRequest {
                    action_id,
                    idempotency_key,
                    url: url.clone(),
                    pairing_generation: state.pairing.generation,
                    connector_name: self.config.connector_name.clone(),
                    model,
                    effort,
                    prompt,
                    expected_url: url,
                    auto_approve_tool_calls: self.config.auto_approve_tool_calls,
                },
            });
            queue
                .make_contiguous()
                .sort_by_key(|execution| action_priority(execution_kind(execution)));
        }
        Ok(())
    }

    pub async fn run_next(&self, now_ms: u64) -> Result<Option<CompanionActionSnapshot>, String> {
        let _run_guard = self.run_lock.lock().await;
        let (execution, task) = loop {
            let Some(execution) = self.queue.lock().await.pop_front() else {
                return Ok(None);
            };
            let Some(task) = self.tasks.read().await.get(&execution.task_key).cloned() else {
                continue;
            };
            if !execution_matches(&task, &execution, now_ms).await? {
                let _ = task.store.update_action_status(
                    &task.task,
                    &execution.request.action_id,
                    AutomationActionStatus::Idle,
                    Some("Queued browser action became stale before execution"),
                    None,
                    now_ms,
                );
                continue;
            }
            break (execution, task);
        };

        let pair_verification = execution_kind(&execution) == AutomationActionKind::PairVerify;
        let checkpoint = if pair_verification {
            None
        } else {
            Some(task.chat.transcript_checkpoint().await?)
        };
        task.store.update_action_status(
            &task.task,
            &execution.request.action_id,
            AutomationActionStatus::Navigating,
            None,
            None,
            now_ms,
        )?;
        self.live.write().await.insert(
            execution.task_key.clone(),
            AutomationLiveState {
                action_id: Some(execution.request.action_id.clone()),
                phase: AutomationActionStatus::Navigating,
                updated_at_ms: now_ms,
                ..Default::default()
            },
        );
        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let execute = self
            .executor
            .execute(execution.clone(), events_tx, CancellationToken::new());
        tokio::pin!(execute);
        let mut accumulator = EventAccumulator::default();
        let mut events_open = true;
        let outcome = loop {
            tokio::select! {
                result = &mut execute => break result,
                event = events_rx.recv(), if events_open => match event {
                    Some(event) => self.apply_event(&execution, &mut accumulator, event).await?,
                    None => events_open = false,
                }
            }
        };
        while let Ok(event) = events_rx.try_recv() {
            self.apply_event(&execution, &mut accumulator, event)
                .await?;
        }

        let snapshot = match outcome {
            Ok(snapshot) => {
                accumulator.send_accepted |= snapshot.send_accepted;
                snapshot
            }
            Err(error) => {
                let action_current = current_action_matches(&task, &execution)?;
                let send_accepted = error.send_accepted || accumulator.send_accepted;
                if pair_verification && action_current {
                    task.store.invalidate_pairing(&task.task, now_ms)?;
                }
                if send_accepted {
                    if let Some(batch_id) = execution_batch_id(&execution) {
                        if action_current {
                            task.store.record_accepted_batch(
                                &task.task,
                                &execution.request.action_id,
                                AcceptedChatBatch {
                                    owner_generation: execution.owner_generation,
                                    batch_id,
                                    message_ids: &execution.unread_message_ids,
                                    transcript_revision: &execution.transcript_revision,
                                },
                                now_ms,
                            )?;
                        } else {
                            task.store.record_superseded_accepted_batch(
                                &task.task,
                                &execution.request.action_id,
                                AcceptedChatBatch {
                                    owner_generation: execution.owner_generation,
                                    batch_id,
                                    message_ids: &execution.unread_message_ids,
                                    transcript_revision: &execution.transcript_revision,
                                },
                            )?;
                        }
                    }
                    if action_current && execution_goal_revision(&execution).is_some() {
                        task.store.record_goal_nudge(
                            &task.task,
                            &execution.request.action_id,
                            &execution.activity_epoch,
                            execution.activity_sequence,
                            now_ms,
                        )?;
                        let _ = task
                            .chat
                            .claim_offline_automation_goal(now_ms, OFFLINE_AFTER_MS)
                            .await?;
                    }
                }
                if !action_current {
                    self.clear_live_if_action(&execution).await;
                    return Err(error.message);
                }
                let status = if send_accepted {
                    AutomationActionStatus::Ambiguous
                } else {
                    AutomationActionStatus::Failed
                };
                task.store.update_action_status(
                    &task.task,
                    &execution.request.action_id,
                    status,
                    Some(&error.message),
                    None,
                    now_ms,
                )?;
                self.update_live_terminal(&execution, status, Some(error.message.clone()), now_ms)
                    .await;
                return Err(error.message);
            }
        };

        if !current_action_matches(&task, &execution)? {
            if accumulator.send_accepted
                && let Some(batch_id) = execution_batch_id(&execution)
            {
                task.store.record_superseded_accepted_batch(
                    &task.task,
                    &execution.request.action_id,
                    AcceptedChatBatch {
                        owner_generation: execution.owner_generation,
                        batch_id,
                        message_ids: &execution.unread_message_ids,
                        transcript_revision: &execution.transcript_revision,
                    },
                )?;
            }
            self.clear_live_if_action(&execution).await;
            return Ok(Some(snapshot));
        }

        if let Some(commit) = &execution.pairing_commit {
            let pairing = commit.store.load(&commit.task)?.pairing;
            if pairing.pending.is_some() {
                let canonical_url = snapshot
                    .canonical_url
                    .as_deref()
                    .ok_or("Browser companion did not return the canonical pairing URL")?;
                commit.store.record_pairing_canonical_url(
                    &commit.task,
                    commit.generation,
                    canonical_url,
                    now_ms,
                )?;
            }
        }

        if accumulator.send_accepted
            && let Some(batch_id) = execution_batch_id(&execution)
        {
            task.store.record_accepted_batch(
                &task.task,
                &execution.request.action_id,
                AcceptedChatBatch {
                    owner_generation: execution.owner_generation,
                    batch_id,
                    message_ids: &execution.unread_message_ids,
                    transcript_revision: &execution.transcript_revision,
                },
                now_ms,
            )?;
        }
        if accumulator.send_accepted && execution_goal_revision(&execution).is_some() {
            task.store.record_goal_nudge(
                &task.task,
                &execution.request.action_id,
                &execution.activity_epoch,
                execution.activity_sequence,
                now_ms,
            )?;
            let _ = task
                .chat
                .claim_offline_automation_goal(now_ms, OFFLINE_AFTER_MS)
                .await?;
        }
        if !pair_verification
            && let Some(answer) = accumulator
                .final_markdown
                .as_deref()
                .filter(|answer| !answer.trim().is_empty())
            && !task
                .chat
                .has_agent_message_after(checkpoint.as_ref().expect("non-pair checkpoint"))
                .await?
        {
            task.chat
                .append_browser_answer(&execution.request.action_id, answer)
                .await?;
        }

        let activity_after = task.chat.offline_activity().await?;
        let no_tool_activity = activity_after.tool_call_count == execution.tool_call_count_at_start;
        let terminal_status = accumulator
            .terminal_status
            .unwrap_or_else(|| companion_status(snapshot.state));
        let status = if pair_verification {
            let pairing = task.store.load(&task.task)?.pairing;
            if pairing.verified_owner_generation == Some(execution.owner_generation) {
                AutomationActionStatus::Idle
            } else {
                AutomationActionStatus::Unverified
            }
        } else if accumulator.send_accepted && terminal_status == AutomationActionStatus::Failed {
            AutomationActionStatus::Ambiguous
        } else if accumulator.send_accepted
            && execution_goal_revision(&execution).is_some()
            && no_tool_activity
            && terminal_status == AutomationActionStatus::Idle
        {
            AutomationActionStatus::Stalled
        } else {
            terminal_status
        };
        task.store.update_action_status(
            &task.task,
            &execution.request.action_id,
            status,
            None,
            (!pair_verification)
                .then_some(accumulator.final_markdown.as_deref())
                .flatten()
                .filter(|answer| answer.len() <= MAX_PRIVATE_TEXT_BYTES),
            now_ms,
        )?;
        self.update_live_terminal(&execution, status, None, now_ms)
            .await;
        Ok(Some(snapshot))
    }

    async fn apply_event(
        &self,
        execution: &AutomationExecution,
        accumulator: &mut EventAccumulator,
        event: CompanionEvent,
    ) -> Result<(), String> {
        let mut live = self.live.write().await;
        let state = live
            .entry(execution.task_key.clone())
            .or_insert_with(AutomationLiveState::default);
        state.action_id = Some(execution.request.action_id.clone());
        state.updated_at_ms = event.at_ms;
        match event.kind {
            CompanionEventKind::Queued => state.phase = AutomationActionStatus::Queued,
            CompanionEventKind::Navigating
            | CompanionEventKind::ComposerReady
            | CompanionEventKind::ModelVerified { .. }
            | CompanionEventKind::ConnectorVerified => {
                state.phase = AutomationActionStatus::Navigating;
            }
            CompanionEventKind::SendAccepted => {
                accumulator.send_accepted = true;
                state.phase = AutomationActionStatus::Sending;
            }
            CompanionEventKind::StatusDelta { text, continuation } => {
                apply_live_delta(&mut state.status, &text, continuation);
                state.phase = AutomationActionStatus::Generating;
            }
            CompanionEventKind::CommentaryDelta {
                markdown,
                continuation,
            } => {
                apply_live_delta(&mut state.commentary, &markdown, continuation);
                state.phase = AutomationActionStatus::Generating;
            }
            CompanionEventKind::AnswerDelta {
                markdown,
                continuation,
            } => {
                apply_live_delta(&mut state.answer, &markdown, continuation);
                accumulator.answer_truncated |=
                    apply_live_delta(&mut accumulator.answer_markdown, &markdown, continuation);
                state.phase = AutomationActionStatus::Generating;
            }
            CompanionEventKind::GenerationComplete { final_markdown, .. } => {
                let final_markdown = final_markdown.or_else(|| {
                    (!accumulator.answer_truncated)
                        .then(|| accumulator.answer_markdown.take())
                        .flatten()
                });
                if let Some(answer) = final_markdown.as_ref() {
                    state.answer = Some(answer.clone());
                }
                accumulator.final_markdown = final_markdown;
                accumulator.terminal_status = Some(AutomationActionStatus::Idle);
                state.phase = AutomationActionStatus::Idle;
            }
            CompanionEventKind::ApprovalRequired { message } => {
                state.status = message;
                accumulator.terminal_status = Some(AutomationActionStatus::ApprovalRequired);
                state.phase = AutomationActionStatus::ApprovalRequired;
            }
            CompanionEventKind::AuthenticationRequired => {
                accumulator.terminal_status = Some(AutomationActionStatus::AuthenticationRequired);
                state.phase = AutomationActionStatus::AuthenticationRequired;
            }
            CompanionEventKind::RateLimited { message } => {
                state.status = message;
                accumulator.terminal_status = Some(AutomationActionStatus::RateLimited);
                state.phase = AutomationActionStatus::RateLimited;
            }
            CompanionEventKind::ExternalInterference { message } => {
                state.status = message;
                accumulator.terminal_status = Some(AutomationActionStatus::Interference);
                state.phase = AutomationActionStatus::Interference;
            }
            CompanionEventKind::AmbiguousSend { message } => {
                accumulator.send_accepted = true;
                state.status = message;
                accumulator.terminal_status = Some(AutomationActionStatus::Ambiguous);
                state.phase = AutomationActionStatus::Ambiguous;
            }
            CompanionEventKind::Failed { message, .. } => {
                state.status = Some(message);
                accumulator.terminal_status = Some(AutomationActionStatus::Failed);
                state.phase = AutomationActionStatus::Failed;
            }
        }
        Ok(())
    }

    async fn update_live_terminal(
        &self,
        execution: &AutomationExecution,
        phase: AutomationActionStatus,
        status: Option<String>,
        now_ms: u64,
    ) {
        let mut live = self.live.write().await;
        let state = live
            .entry(execution.task_key.clone())
            .or_insert_with(AutomationLiveState::default);
        state.action_id = Some(execution.request.action_id.clone());
        state.phase = phase;
        if status.is_some() {
            state.status = status;
        }
        state.updated_at_ms = now_ms;
    }

    async fn clear_live_if_action(&self, execution: &AutomationExecution) {
        let mut live = self.live.write().await;
        if live
            .get(&execution.task_key)
            .and_then(|state| state.action_id.as_deref())
            == Some(execution.request.action_id.as_str())
        {
            live.remove(&execution.task_key);
        }
    }
}

#[derive(Default)]
struct EventAccumulator {
    send_accepted: bool,
    answer_markdown: Option<String>,
    answer_truncated: bool,
    final_markdown: Option<String>,
    terminal_status: Option<AutomationActionStatus>,
}

fn current_action_matches(
    task: &AutomationTaskHandle,
    execution: &AutomationExecution,
) -> Result<bool, String> {
    Ok(task.store.load(&task.task)?.action.id.as_deref()
        == Some(execution.request.action_id.as_str()))
}

const MAX_LIVE_TEXT_BYTES: usize = 1024 * 1024;

fn apply_live_delta(destination: &mut Option<String>, value: &str, continuation: bool) -> bool {
    if !continuation {
        let end = utf8_prefix_end(value, MAX_LIVE_TEXT_BYTES);
        *destination = Some(value[..end].to_string());
        return end < value.len();
    }
    let destination = destination.get_or_insert_with(String::new);
    let remaining = MAX_LIVE_TEXT_BYTES.saturating_sub(destination.len());
    let end = utf8_prefix_end(value, remaining);
    destination.push_str(&value[..end]);
    end < value.len()
}

fn utf8_prefix_end(value: &str, maximum: usize) -> usize {
    let mut end = value.len().min(maximum);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn execution_error(message: String, send_accepted: bool) -> AutomationExecutionError {
    AutomationExecutionError {
        message,
        send_accepted,
    }
}

fn validate_execution_catalog(
    execution: &AutomationExecution,
    catalog: &CapabilityCatalog,
) -> Result<(), String> {
    if catalog.account_fingerprint != execution.account_fingerprint {
        return Err(
            "Browser companion account changed; refresh capabilities and verify the pairing again"
                .into(),
        );
    }
    if catalog.catalog_revision != execution.catalog_revision {
        return Err("Browser companion capability catalog changed; refresh model options".into());
    }
    let model = catalog
        .models
        .iter()
        .find(|model| model.id == execution.request.model)
        .ok_or("The selected browser model is no longer available")?;
    let effort = model
        .efforts
        .iter()
        .find(|effort| effort.id == execution.request.effort)
        .ok_or("The selected browser effort is no longer available")?;
    if !effort.available {
        return Err("The selected browser effort is unavailable for this account".into());
    }
    Ok(())
}

fn validate_terminal_snapshot(
    execution: &AutomationExecution,
    snapshot: &CompanionActionSnapshot,
) -> Result<(), AutomationExecutionError> {
    if snapshot.action_id != execution.request.action_id {
        return Err(execution_error(
            "Browser companion returned the wrong action".into(),
            true,
        ));
    }
    if !snapshot.send_accepted {
        if matches!(
            snapshot.state,
            CompanionActionState::Idle
                | CompanionActionState::ApprovalRequired
                | CompanionActionState::Ambiguous
                | CompanionActionState::Stalled
        ) {
            return Err(execution_error(
                "Browser companion reached a post-Send terminal state without proving Send acceptance"
                    .into(),
                true,
            ));
        }
        return Ok(());
    }
    let selected = snapshot.selected.as_ref().ok_or_else(|| {
        execution_error(
            "Browser companion did not prove the selected model and effort".into(),
            true,
        )
    })?;
    if selected.model != execution.request.model || selected.effort != execution.request.effort {
        return Err(execution_error(
            "Browser companion selected a different model or effort".into(),
            true,
        ));
    }
    if snapshot.canonical_url.as_deref() != Some(execution.request.expected_url.as_str()) {
        return Err(execution_error(
            "Browser companion returned a different conversation URL".into(),
            true,
        ));
    }
    Ok(())
}

fn blocks_automatic_requeue(status: AutomationActionStatus) -> bool {
    matches!(
        status,
        AutomationActionStatus::Navigating
            | AutomationActionStatus::Sending
            | AutomationActionStatus::Generating
            | AutomationActionStatus::ApprovalRequired
            | AutomationActionStatus::AuthenticationRequired
            | AutomationActionStatus::RateLimited
            | AutomationActionStatus::Interference
            | AutomationActionStatus::Ambiguous
            | AutomationActionStatus::Failed
    )
}

fn bounded_unread_batch(
    messages: &[crate::markdown_chat::UnreadMessage],
    goal_revision: Option<u64>,
) -> Result<Vec<crate::markdown_chat::UnreadMessage>, String> {
    let mut selected = Vec::new();
    for message in messages {
        if selected.len() >= MAX_UNREAD_MESSAGES {
            break;
        }
        let candidate_messages = selected
            .iter()
            .chain(std::iter::once(message))
            .map(|message| CompanionUnreadMessage {
                id: message.id.clone(),
                markdown: message.markdown.clone(),
            })
            .collect::<Vec<_>>();
        let prompt = if let Some(goal_revision) = goal_revision {
            ActionPrompt::OfflineCombined {
                batch_id: "0".repeat(64),
                messages: candidate_messages,
                goal_revision,
            }
        } else {
            ActionPrompt::OfflineChat {
                batch_id: "0".repeat(64),
                messages: candidate_messages,
            }
        };
        if rendered_action_prompt_bytes(&prompt) > MAX_PROMPT_BYTES {
            if selected.is_empty() {
                return Err(
                    "Browser automation unread message is too large; it was preserved without truncation"
                        .into(),
                );
            }
            break;
        }
        selected.push(message.clone());
    }
    Ok(selected)
}

fn action_is_terminal(state: CompanionActionState) -> bool {
    !matches!(
        state,
        CompanionActionState::Queued
            | CompanionActionState::Navigating
            | CompanionActionState::Sending
            | CompanionActionState::Generating
    )
}

async fn execution_matches(
    task: &AutomationTaskHandle,
    execution: &AutomationExecution,
    now_ms: u64,
) -> Result<bool, String> {
    if task.owner_generation != execution.owner_generation {
        return Ok(false);
    }
    let state = task.store.load(&task.task)?;
    if state.action.id.as_deref() != Some(execution.request.action_id.as_str())
        || state.action.status != AutomationActionStatus::Queued
        || state.pairing.generation != execution.request.pairing_generation
        || state.selection.model.as_deref() != Some(execution.request.model.as_str())
        || state.selection.effort.as_deref() != Some(execution.request.effort.as_str())
        || state.selection.catalog_revision.as_deref() != Some(execution.catalog_revision.as_str())
        || state.selection.account_fingerprint.as_deref()
            != Some(execution.account_fingerprint.as_str())
    {
        return Ok(false);
    }
    if let ActionPrompt::PairVerify { reference } = &execution.request.prompt {
        if state.pairing.candidate_url.as_deref() != Some(execution.request.url.as_str())
            || state.pairing.pending.as_ref().is_none_or(|pending| {
                pending.generation != execution.request.pairing_generation
                    || pending.owner_generation != execution.owner_generation
            })
            || execution.pairing_commit.as_ref().is_none_or(|commit| {
                commit.generation != execution.request.pairing_generation
                    || commit.task.stable_key() != task.task.stable_key()
            })
        {
            return Ok(false);
        }
        return task
            .store
            .validate_pending_pairing(
                &task.task,
                execution.request.pairing_generation,
                execution.owner_generation,
                reference,
                now_ms,
            )
            .map(|_| true)
            .or_else(|error| {
                if error.contains("invalid, expired, or already used") {
                    Ok(false)
                } else {
                    Err(error)
                }
            });
    }
    let activity = task.chat.offline_activity().await?;
    if activity
        .last_call_at_ms
        .is_none_or(|last| now_ms.saturating_sub(last) < OFFLINE_AFTER_MS)
        || state.pairing.canonical_url.as_deref() != Some(execution.request.url.as_str())
        || state.pairing.verified_owner_generation != Some(execution.owner_generation)
    {
        return Ok(false);
    }
    if let Some(revision) = execution_goal_revision(execution)
        && state
            .goal
            .as_ref()
            .is_none_or(|goal| goal.revision != revision || goal.status != GoalStatus::Active)
    {
        return Ok(false);
    }
    if !execution.unread_message_ids.is_empty() {
        let unread = task.chat.unread_snapshot().await?;
        let queued_messages = execution_unread_messages(execution);
        let accepted = if state.chat_mirror.owner_generation == Some(execution.owner_generation) {
            state
                .chat_mirror
                .message_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
        } else {
            std::collections::HashSet::new()
        };
        let current_messages = unread
            .messages
            .iter()
            .filter(|message| !accepted.contains(&message.id))
            .take(queued_messages.len())
            .collect::<Vec<_>>();
        if queued_messages.len() != execution.unread_message_ids.len()
            || current_messages.len() != queued_messages.len()
            || queued_messages
                .iter()
                .zip(&execution.unread_message_ids)
                .any(|(message, id)| &message.id != id)
            || queued_messages
                .iter()
                .zip(current_messages)
                .any(|(queued, current)| {
                    current.id != queued.id || current.markdown != queued.markdown
                })
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn execution_goal_revision(execution: &AutomationExecution) -> Option<u64> {
    match &execution.request.prompt {
        ActionPrompt::OfflineGoal { goal_revision }
        | ActionPrompt::OfflineCombined { goal_revision, .. } => Some(*goal_revision),
        ActionPrompt::PairVerify { .. } | ActionPrompt::OfflineChat { .. } => None,
    }
}

fn execution_kind(execution: &AutomationExecution) -> AutomationActionKind {
    match &execution.request.prompt {
        ActionPrompt::PairVerify { .. } => AutomationActionKind::PairVerify,
        ActionPrompt::OfflineChat { .. } => AutomationActionKind::OfflineChat,
        ActionPrompt::OfflineGoal { .. } => AutomationActionKind::OfflineGoal,
        ActionPrompt::OfflineCombined { .. } => AutomationActionKind::OfflineCombined,
    }
}

fn action_priority(kind: AutomationActionKind) -> u8 {
    match kind {
        AutomationActionKind::PairVerify => 0,
        AutomationActionKind::OfflineChat | AutomationActionKind::OfflineCombined => 1,
        AutomationActionKind::OfflineGoal => 2,
    }
}

fn execution_batch_id(execution: &AutomationExecution) -> Option<&str> {
    match &execution.request.prompt {
        ActionPrompt::OfflineChat { batch_id, .. }
        | ActionPrompt::OfflineCombined { batch_id, .. } => Some(batch_id),
        ActionPrompt::PairVerify { .. } | ActionPrompt::OfflineGoal { .. } => None,
    }
}

fn execution_unread_messages(execution: &AutomationExecution) -> &[CompanionUnreadMessage] {
    match &execution.request.prompt {
        ActionPrompt::OfflineChat { messages, .. }
        | ActionPrompt::OfflineCombined { messages, .. } => messages,
        ActionPrompt::PairVerify { .. } | ActionPrompt::OfflineGoal { .. } => &[],
    }
}

#[allow(clippy::too_many_arguments)]
fn queued_context_matches(
    queued: &AutomationExecution,
    owner_generation: u64,
    pairing_generation: u64,
    url: &str,
    model: &str,
    effort: &str,
    catalog_revision: &str,
    account_fingerprint: &str,
    goal_revision: Option<u64>,
) -> bool {
    queued.owner_generation == owner_generation
        && queued.request.pairing_generation == pairing_generation
        && queued.request.url == url
        && queued.request.expected_url == url
        && queued.request.model == model
        && queued.request.effort == effort
        && queued.catalog_revision == catalog_revision
        && queued.account_fingerprint == account_fingerprint
        && execution_goal_revision(queued) == goal_revision
}

fn companion_status(status: super::CompanionActionState) -> AutomationActionStatus {
    match status {
        super::CompanionActionState::Unpaired => AutomationActionStatus::Unpaired,
        super::CompanionActionState::Unverified => AutomationActionStatus::Unverified,
        super::CompanionActionState::Queued => AutomationActionStatus::Queued,
        super::CompanionActionState::Navigating => AutomationActionStatus::Navigating,
        super::CompanionActionState::Sending => AutomationActionStatus::Sending,
        super::CompanionActionState::Generating => AutomationActionStatus::Generating,
        super::CompanionActionState::Idle => AutomationActionStatus::Idle,
        super::CompanionActionState::ApprovalRequired => AutomationActionStatus::ApprovalRequired,
        super::CompanionActionState::AuthenticationRequired => {
            AutomationActionStatus::AuthenticationRequired
        }
        super::CompanionActionState::RateLimited => AutomationActionStatus::RateLimited,
        super::CompanionActionState::ExternalInterference => AutomationActionStatus::Interference,
        super::CompanionActionState::Ambiguous => AutomationActionStatus::Ambiguous,
        super::CompanionActionState::Stalled => AutomationActionStatus::Stalled,
        super::CompanionActionState::Failed => AutomationActionStatus::Failed,
    }
}

fn random_id(prefix: &str) -> Result<String, String> {
    let mut bytes = [0u8; 18];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("Could not generate a browser automation ID: {error}"))?;
    Ok(format!("{prefix}-{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn unread_batch_id<'a>(
    task_key: &str,
    owner_generation: u64,
    pairing_generation: u64,
    revision: &str,
    message_ids: impl Iterator<Item = &'a str>,
) -> String {
    let mut hash = Sha256::new();
    hash.update(b"codexify-unread-batch-v1\0");
    hash.update(task_key.as_bytes());
    hash.update(owner_generation.to_le_bytes());
    hash.update(pairing_generation.to_le_bytes());
    hash.update(revision.as_bytes());
    for id in message_ids {
        hash.update((id.len() as u64).to_le_bytes());
        hash.update(id.as_bytes());
    }
    format!("{:x}", hash.finalize())
}
