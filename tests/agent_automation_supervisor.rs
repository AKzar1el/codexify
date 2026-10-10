use std::io::Write as _;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use codexify::agent_automation::{
    AcceptedChatBatch, ActionPrompt, AgentAutomationStore, AgentAutomationSupervisor,
    AutomationActionStatus, AutomationExecution, AutomationExecutionError, AutomationExecutor,
    AutomationTaskHandle, BrowserAutomationExecutor, CompanionActionSnapshot, CompanionActionState,
    CompanionEvent, CompanionEventKind, PairingCommit,
};
use codexify::config::default_config;
use codexify::exec_sessions::SessionState;
use codexify::markdown_chat::{MarkdownChatStore, OFFLINE_AFTER_MS};
use codexify::project_bindings::ConversationIdentity;
use tokio::sync::Notify;
use tokio::sync::Semaphore;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const COMPANION_TOKEN: &str = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE";
const COMPANION_BUILD: &str = "supervisor-fake-build+protocol.edc90b30a9de09b1e992d4384ac1df24b08e4a98d8e52687a2542dee561877b2";

struct FakeExecutor {
    calls: AtomicUsize,
    executions: Mutex<Vec<AutomationExecution>>,
    events: Mutex<Vec<CompanionEventKind>>,
}

impl Default for FakeExecutor {
    fn default() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            executions: Mutex::new(Vec::new()),
            events: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl AutomationExecutor for FakeExecutor {
    async fn execute(
        &self,
        execution: AutomationExecution,
        events: mpsc::UnboundedSender<CompanionEvent>,
        _cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.executions.lock().unwrap().push(execution.clone());
        let configured = self.events.lock().unwrap().clone();
        for (index, kind) in configured.into_iter().enumerate() {
            events
                .send(CompanionEvent {
                    sequence: index as u64 + 1,
                    action_id: execution.request.action_id.clone(),
                    at_ms: index as u64 + 1,
                    kind,
                })
                .unwrap();
        }
        Ok(snapshot_for(execution))
    }
}

fn snapshot_for(execution: AutomationExecution) -> CompanionActionSnapshot {
    CompanionActionSnapshot {
        protocol_version: codexify::agent_automation::PROTOCOL_VERSION,
        build: "fake-build".into(),
        action_id: execution.request.action_id,
        state: CompanionActionState::Idle,
        send_accepted: true,
        canonical_url: Some(execution.request.expected_url),
        selected: Some(codexify::agent_automation::CompanionSelection {
            model: execution.request.model,
            effort: execution.request.effort,
        }),
        last_event_sequence: 2,
        attention: None,
    }
}

struct ChatWritingExecutor {
    chat: Arc<codexify::markdown_chat::ChatFile>,
}

struct PairVerifyingExecutor {
    store: Arc<AgentAutomationStore>,
    task: ConversationIdentity,
    generation: u64,
    reference: String,
}

struct PairVerifyingFailureExecutor {
    store: Arc<AgentAutomationStore>,
    task: ConversationIdentity,
    generation: u64,
    reference: String,
}

struct AmbiguousExecutor;

struct PreSendFailureExecutor {
    calls: AtomicUsize,
}

struct AcceptedTerminalFailureExecutor;

struct AcceptedEventThenTransportErrorExecutor;

impl Default for PreSendFailureExecutor {
    fn default() -> Self {
        Self {
            calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl AutomationExecutor for AmbiguousExecutor {
    async fn execute(
        &self,
        _execution: AutomationExecution,
        _events: mpsc::UnboundedSender<CompanionEvent>,
        _cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        Err(AutomationExecutionError {
            message: "Send may have been accepted".into(),
            send_accepted: true,
        })
    }
}

#[async_trait]
impl AutomationExecutor for PreSendFailureExecutor {
    async fn execute(
        &self,
        _execution: AutomationExecution,
        _events: mpsc::UnboundedSender<CompanionEvent>,
        _cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(AutomationExecutionError {
            message: "Selector verification failed before Send".into(),
            send_accepted: false,
        })
    }
}

#[async_trait]
impl AutomationExecutor for AcceptedTerminalFailureExecutor {
    async fn execute(
        &self,
        execution: AutomationExecution,
        events: mpsc::UnboundedSender<CompanionEvent>,
        _cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        events
            .send(CompanionEvent {
                sequence: 1,
                action_id: execution.request.action_id.clone(),
                at_ms: 1,
                kind: CompanionEventKind::SendAccepted,
            })
            .unwrap();
        events
            .send(CompanionEvent {
                sequence: 2,
                action_id: execution.request.action_id.clone(),
                at_ms: 2,
                kind: CompanionEventKind::Failed {
                    code: "response_failed".into(),
                    message: "ChatGPT failed after accepting the message".into(),
                },
            })
            .unwrap();
        let mut snapshot = snapshot_for(execution);
        snapshot.state = CompanionActionState::Failed;
        Ok(snapshot)
    }
}

#[async_trait]
impl AutomationExecutor for AcceptedEventThenTransportErrorExecutor {
    async fn execute(
        &self,
        execution: AutomationExecution,
        events: mpsc::UnboundedSender<CompanionEvent>,
        _cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        events
            .send(CompanionEvent {
                sequence: 1,
                action_id: execution.request.action_id,
                at_ms: 1,
                kind: CompanionEventKind::SendAccepted,
            })
            .unwrap();
        Err(AutomationExecutionError {
            message: "Browser companion status reconciliation failed".into(),
            send_accepted: false,
        })
    }
}

struct StreamingExecutor {
    started: Arc<Notify>,
    release: Arc<Notify>,
}

struct LargeTransientExecutor;

struct LargeFinalAnswerExecutor;

struct SerialExecutor {
    calls: AtomicUsize,
    active: AtomicUsize,
    max_active: AtomicUsize,
    started: mpsc::UnboundedSender<usize>,
    release: Arc<Semaphore>,
}

#[async_trait]
impl AutomationExecutor for SerialExecutor {
    async fn execute(
        &self,
        execution: AutomationExecution,
        _events: mpsc::UnboundedSender<CompanionEvent>,
        _cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        self.started.send(call).unwrap();
        let permit = self.release.acquire().await.unwrap();
        permit.forget();
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(snapshot_for(execution))
    }
}

#[async_trait]
impl AutomationExecutor for StreamingExecutor {
    async fn execute(
        &self,
        execution: AutomationExecution,
        events: mpsc::UnboundedSender<CompanionEvent>,
        _cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        for (sequence, kind) in [
            CompanionEventKind::StatusDelta {
                text: "Using the browser".into(),
                continuation: false,
            },
            CompanionEventKind::CommentaryDelta {
                markdown: "Visible commentary".into(),
                continuation: false,
            },
            CompanionEventKind::AnswerDelta {
                markdown: "Partial answer".into(),
                continuation: false,
            },
        ]
        .into_iter()
        .enumerate()
        {
            events
                .send(CompanionEvent {
                    sequence: sequence as u64 + 1,
                    action_id: execution.request.action_id.clone(),
                    at_ms: sequence as u64 + 1,
                    kind,
                })
                .unwrap();
        }
        self.started.notify_one();
        self.release.notified().await;
        events
            .send(CompanionEvent {
                sequence: 4,
                action_id: execution.request.action_id.clone(),
                at_ms: 4,
                kind: CompanionEventKind::GenerationComplete {
                    final_markdown: Some("Complete answer".into()),
                    canonical_url: Some(execution.request.expected_url.clone()),
                },
            })
            .unwrap();
        Ok(snapshot_for(execution))
    }
}

#[async_trait]
impl AutomationExecutor for LargeTransientExecutor {
    async fn execute(
        &self,
        execution: AutomationExecution,
        events: mpsc::UnboundedSender<CompanionEvent>,
        _cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        events
            .send(CompanionEvent {
                sequence: 1,
                action_id: execution.request.action_id.clone(),
                at_ms: 1,
                kind: CompanionEventKind::SendAccepted,
            })
            .unwrap();
        for index in 0..17_u64 {
            events
                .send(CompanionEvent {
                    sequence: index + 2,
                    action_id: execution.request.action_id.clone(),
                    at_ms: index + 2,
                    kind: CompanionEventKind::StatusDelta {
                        text: "x".repeat(64 * 1024),
                        continuation: index != 0,
                    },
                })
                .unwrap();
        }
        events
            .send(CompanionEvent {
                sequence: 19,
                action_id: execution.request.action_id.clone(),
                at_ms: 19,
                kind: CompanionEventKind::GenerationComplete {
                    final_markdown: Some("Complete after long transient output.".into()),
                    canonical_url: Some(execution.request.expected_url.clone()),
                },
            })
            .unwrap();
        Ok(snapshot_for(execution))
    }
}

#[async_trait]
impl AutomationExecutor for LargeFinalAnswerExecutor {
    async fn execute(
        &self,
        execution: AutomationExecution,
        events: mpsc::UnboundedSender<CompanionEvent>,
        _cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        events
            .send(CompanionEvent {
                sequence: 1,
                action_id: execution.request.action_id.clone(),
                at_ms: 1,
                kind: CompanionEventKind::SendAccepted,
            })
            .unwrap();
        for (index, markdown) in ["a".repeat(40 * 1024), "b".repeat(40 * 1024)]
            .into_iter()
            .enumerate()
        {
            events
                .send(CompanionEvent {
                    sequence: index as u64 + 2,
                    action_id: execution.request.action_id.clone(),
                    at_ms: index as u64 + 2,
                    kind: CompanionEventKind::AnswerDelta {
                        markdown,
                        continuation: index != 0,
                    },
                })
                .unwrap();
        }
        events
            .send(CompanionEvent {
                sequence: 4,
                action_id: execution.request.action_id.clone(),
                at_ms: 4,
                kind: CompanionEventKind::GenerationComplete {
                    final_markdown: None,
                    canonical_url: Some(execution.request.expected_url.clone()),
                },
            })
            .unwrap();
        Ok(snapshot_for(execution))
    }
}

#[async_trait]
impl AutomationExecutor for ChatWritingExecutor {
    async fn execute(
        &self,
        execution: AutomationExecution,
        events: mpsc::UnboundedSender<CompanionEvent>,
        _cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        self.chat
            .append("Authoritative output from chat_write.".into())
            .await
            .unwrap();
        events
            .send(CompanionEvent {
                sequence: 1,
                action_id: execution.request.action_id.clone(),
                at_ms: 1,
                kind: CompanionEventKind::SendAccepted,
            })
            .unwrap();
        events
            .send(CompanionEvent {
                sequence: 2,
                action_id: execution.request.action_id.clone(),
                at_ms: 2,
                kind: CompanionEventKind::GenerationComplete {
                    final_markdown: Some("Duplicate browser final answer.".into()),
                    canonical_url: Some(execution.request.expected_url.clone()),
                },
            })
            .unwrap();
        Ok(snapshot_for(execution))
    }
}

#[async_trait]
impl AutomationExecutor for PairVerifyingExecutor {
    async fn execute(
        &self,
        execution: AutomationExecution,
        events: mpsc::UnboundedSender<CompanionEvent>,
        _cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        self.store
            .record_pairing_canonical_url(
                &self.task,
                self.generation,
                &execution.request.expected_url,
                102,
            )
            .unwrap();
        self.store
            .verify_pairing(
                &self.task,
                self.generation,
                execution.owner_generation,
                &self.reference,
                103,
            )
            .unwrap();
        events
            .send(CompanionEvent {
                sequence: 1,
                action_id: execution.request.action_id.clone(),
                at_ms: 1,
                kind: CompanionEventKind::GenerationComplete {
                    final_markdown: None,
                    canonical_url: Some(execution.request.expected_url.clone()),
                },
            })
            .unwrap();
        Ok(snapshot_for(execution))
    }
}

#[async_trait]
impl AutomationExecutor for PairVerifyingFailureExecutor {
    async fn execute(
        &self,
        execution: AutomationExecution,
        _events: mpsc::UnboundedSender<CompanionEvent>,
        _cancellation: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        self.store
            .record_pairing_canonical_url(
                &self.task,
                self.generation,
                &execution.request.expected_url,
                102,
            )
            .unwrap();
        self.store
            .verify_pairing(
                &self.task,
                self.generation,
                execution.owner_generation,
                &self.reference,
                103,
            )
            .unwrap();
        Err(AutomationExecutionError {
            message: "Browser companion returned a different conversation URL".into(),
            send_accepted: true,
        })
    }
}

struct Fixture {
    _root: tempfile::TempDir,
    config: codexify::types::AppConfig,
    task: ConversationIdentity,
    chat: Arc<codexify::markdown_chat::ChatFile>,
    store: Arc<AgentAutomationStore>,
    supervisor: Arc<AgentAutomationSupervisor>,
    executor: Arc<FakeExecutor>,
}

async fn fixture() -> Fixture {
    fixture_with_queue_limit(64).await
}

async fn fixture_with_queue_limit(max_queued_actions: usize) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let mut config = default_config(project);
    config.memory.dir = Some(root.path().join("state").display().to_string());
    config.markdown_chat.enabled = true;
    config.markdown_chat.automation.enabled = true;
    config.markdown_chat.automation.max_queued_actions = max_queued_actions;

    let task = ConversationIdentity::from_openai_session("supervisor-online").unwrap();
    let chat = MarkdownChatStore::default()
        .chat(&config, Some(&task), &SessionState::new())
        .unwrap();
    chat.ensure().await.unwrap();
    let store = Arc::new(AgentAutomationStore::for_config(&config).unwrap());
    store
        .set_selection(&task, "gpt-6-sol", "high", "catalog-1", "account-1", 100)
        .unwrap();
    let pairing = store
        .issue_pairing(&task, "https://chatgpt.com/c/example", 0, 100)
        .unwrap();
    store
        .record_pairing_canonical_url(
            &task,
            pairing.generation,
            "https://chatgpt.com/c/example",
            101,
        )
        .unwrap();
    store
        .verify_pairing(&task, pairing.generation, 0, &pairing.reference, 102)
        .unwrap();

    let executor = Arc::new(FakeExecutor::default());
    let supervisor =
        AgentAutomationSupervisor::new(config.markdown_chat.automation.clone(), executor.clone());
    supervisor
        .register_task(AutomationTaskHandle::new(
            task.clone(),
            0,
            store.clone(),
            chat.clone(),
        ))
        .await
        .unwrap();

    Fixture {
        _root: root,
        config,
        task,
        chat,
        store,
        supervisor,
        executor,
    }
}

async fn add_task(
    fixture: &Fixture,
    name: &str,
    url: &str,
) -> (ConversationIdentity, Arc<codexify::markdown_chat::ChatFile>) {
    let task = ConversationIdentity::from_openai_session(name).unwrap();
    let chat = MarkdownChatStore::default()
        .chat(&fixture.config, Some(&task), &SessionState::new())
        .unwrap();
    chat.ensure().await.unwrap();
    fixture
        .store
        .set_selection(&task, "gpt-6-sol", "high", "catalog-1", "account-1", 100)
        .unwrap();
    let pairing = fixture.store.issue_pairing(&task, url, 0, 100).unwrap();
    fixture
        .store
        .record_pairing_canonical_url(&task, pairing.generation, url, 101)
        .unwrap();
    fixture
        .store
        .verify_pairing(&task, pairing.generation, 0, &pairing.reference, 102)
        .unwrap();
    fixture
        .supervisor
        .register_task(AutomationTaskHandle::new(
            task.clone(),
            0,
            fixture.store.clone(),
            chat.clone(),
        ))
        .await
        .unwrap();
    (task, chat)
}

fn write_companion_descriptor(root: &std::path::Path, endpoint: &str) -> std::path::PathBuf {
    let directory = root.join("browser");
    std::fs::create_dir_all(&directory).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let path = directory.join("descriptor.json");
    std::fs::write(
        &path,
        serde_json::json!({
            "version":1,
            "kind":"codexify-browser-companion",
            "pid":std::process::id(),
            "endpoint":endpoint,
            "token":COMPANION_TOKEN,
            "build":COMPANION_BUILD,
            "createdAt":chrono::Utc::now().to_rfc3339()
        })
        .to_string(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    path
}

fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some(&format!("Bearer {COMPANION_TOKEN}"))
}

#[tokio::test]
async fn online_unread_messages_never_enqueue_or_call_the_companion() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user("online-message".into(), "Do not automate this yet.".into())
        .await
        .unwrap();

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS - 1)
        .await
        .unwrap();

    assert_eq!(fixture.supervisor.queued_count().await, 0);
    assert_eq!(fixture.executor.calls.load(Ordering::SeqCst), 0);
    assert!(
        fixture
            .store
            .load(&fixture.task)
            .unwrap()
            .chat_mirror
            .message_ids
            .is_empty()
    );
}

#[tokio::test]
async fn offline_unread_messages_enqueue_without_a_goal_and_remain_unread() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "offline-message".into(),
            "Please continue from the standalone chat.".into(),
        )
        .await
        .unwrap();

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();

    assert_eq!(fixture.supervisor.queued_count().await, 1);
    assert_eq!(fixture.executor.calls.load(Ordering::SeqCst), 0);
    let state = fixture.store.load(&fixture.task).unwrap();
    assert_eq!(
        state.action.kind,
        Some(codexify::agent_automation::AutomationActionKind::OfflineChat)
    );
    assert_eq!(
        state.action.status,
        codexify::agent_automation::AutomationActionStatus::Queued
    );
    assert!(
        fixture
            .chat
            .read(false)
            .await
            .unwrap()
            .text
            .contains("Please continue from the standalone chat.")
    );
}

#[tokio::test]
async fn goal_only_action_runs_once_per_activity_epoch_and_stalls_without_tool_activity() {
    let fixture = fixture().await;
    let goal = fixture
        .store
        .set_goal(&fixture.task, "Finish the current implementation.", 100)
        .unwrap();
    fixture
        .store
        .run_goal(&fixture.task, goal.revision, 101)
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::GenerationComplete {
            final_markdown: None,
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    fixture
        .supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();

    {
        let executions = fixture.executor.executions.lock().unwrap();
        assert_eq!(executions.len(), 1);
        assert!(matches!(
            executions[0].request.prompt,
            ActionPrompt::OfflineGoal { goal_revision } if goal_revision == goal.revision
        ));
    }
    assert_eq!(fixture.supervisor.queued_count().await, 0);
    assert_eq!(
        fixture.store.load(&fixture.task).unwrap().action.status,
        AutomationActionStatus::Stalled
    );

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS + 2)
        .await
        .unwrap();
    assert_eq!(fixture.supervisor.queued_count().await, 0);
}

#[tokio::test]
async fn accepted_unread_batch_is_not_acknowledged_or_automatically_mirrored_twice() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "dedup-message".into(),
            "Mirror me once, but leave me unread.".into(),
        )
        .await
        .unwrap();
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::GenerationComplete {
            final_markdown: None,
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    fixture
        .supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();

    let state = fixture.store.load(&fixture.task).unwrap();
    assert_eq!(state.chat_mirror.message_ids, vec!["dedup-message"]);
    assert!(state.chat_mirror.last_accepted_batch_id.is_some());
    assert!(
        fixture
            .chat
            .read(false)
            .await
            .unwrap()
            .text
            .contains("Mirror me once, but leave me unread.")
    );

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS + 2)
        .await
        .unwrap();
    assert_eq!(fixture.supervisor.queued_count().await, 0);
    assert_eq!(fixture.executor.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn accepted_unread_batch_is_rearmed_for_a_new_physical_owner_generation() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "owner-generation-message".into(),
            "Mirror me again after the physical owner changes.".into(),
        )
        .await
        .unwrap();
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::GenerationComplete {
            final_markdown: None,
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);
    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    fixture
        .supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fixture.supervisor.queued_count().await, 0);

    fixture
        .supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            1,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    let replacement = fixture
        .store
        .issue_pairing(
            &fixture.task,
            "https://chatgpt.com/c/replacement-owner",
            1,
            2_000,
        )
        .unwrap();
    fixture
        .store
        .record_pairing_canonical_url(
            &fixture.task,
            replacement.generation,
            "https://chatgpt.com/c/replacement-owner",
            2_001,
        )
        .unwrap();
    fixture
        .store
        .verify_pairing(
            &fixture.task,
            replacement.generation,
            1,
            &replacement.reference,
            2_002,
        )
        .unwrap();

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS + 2_000)
        .await
        .unwrap();

    assert_eq!(fixture.supervisor.queued_count().await, 1);
}

#[tokio::test]
async fn consumed_accepted_message_ids_are_pruned_before_the_history_limit_blocks_delivery() {
    let fixture = fixture().await;
    let pairing_generation = fixture
        .store
        .load(&fixture.task)
        .unwrap()
        .pairing
        .generation;
    let stale_ids = (0..1024)
        .map(|index| format!("consumed-{index:04}"))
        .collect::<Vec<_>>();
    fixture
        .store
        .queue_action(
            &fixture.task,
            "consumed-history-action",
            codexify::agent_automation::AutomationActionKind::OfflineChat,
            pairing_generation,
            None,
            900,
        )
        .unwrap();
    fixture
        .store
        .record_accepted_batch(
            &fixture.task,
            "consumed-history-action",
            AcceptedChatBatch {
                owner_generation: 0,
                batch_id: "consumed-history-batch",
                message_ids: &stale_ids,
                transcript_revision: "consumed-history-revision",
            },
            901,
        )
        .unwrap();
    fixture
        .store
        .update_action_status(
            &fixture.task,
            "consumed-history-action",
            AutomationActionStatus::Idle,
            None,
            None,
            902,
        )
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "new-after-consumed-history".into(),
            "This unread message must still reach the replacement browser turn.".into(),
        )
        .await
        .unwrap();
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::GenerationComplete {
            final_markdown: None,
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    fixture
        .supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        fixture
            .store
            .load(&fixture.task)
            .unwrap()
            .chat_mirror
            .message_ids,
        vec!["new-after-consumed-history"]
    );
}

#[tokio::test]
async fn full_unread_accepted_history_blocks_a_new_send_before_browser_execution() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    let accepted_ids = (0..1024)
        .map(|index| format!("retained-{index:04}"))
        .collect::<Vec<_>>();
    let mut blocks = String::new();
    for (index, id) in accepted_ids.iter().enumerate() {
        blocks.push_str(&format!(
            "\n\n<!-- codexify-user-message:v1:start id=\"{id}\" created_at_ms=\"{}\" tool_call_count=\"0\" -->\n\n## User\n\nPending accepted message {index}.\n\n<!-- codexify-user-message:v1:end id=\"{id}\" -->\n",
            1_001 + index as u64,
        ));
    }
    std::fs::OpenOptions::new()
        .append(true)
        .open(fixture.chat.path())
        .unwrap()
        .write_all(blocks.as_bytes())
        .unwrap();
    assert_eq!(
        fixture.chat.unread_snapshot().await.unwrap().messages.len(),
        1024
    );

    let pairing_generation = fixture
        .store
        .load(&fixture.task)
        .unwrap()
        .pairing
        .generation;
    fixture
        .store
        .queue_action(
            &fixture.task,
            "full-history-action",
            codexify::agent_automation::AutomationActionKind::OfflineChat,
            pairing_generation,
            None,
            2_100,
        )
        .unwrap();
    fixture
        .store
        .record_accepted_batch(
            &fixture.task,
            "full-history-action",
            AcceptedChatBatch {
                owner_generation: 0,
                batch_id: "full-history-batch",
                message_ids: &accepted_ids,
                transcript_revision: "full-history-revision",
            },
            2_101,
        )
        .unwrap();
    fixture
        .store
        .update_action_status(
            &fixture.task,
            "full-history-action",
            AutomationActionStatus::Idle,
            None,
            None,
            2_102,
        )
        .unwrap();
    fixture
        .chat
        .append_user(
            "new-after-full-history".into(),
            "This message must remain unread until a mirror receipt can be persisted.".into(),
        )
        .await
        .unwrap();

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();

    assert_eq!(fixture.supervisor.queued_count().await, 0);
    assert_eq!(fixture.executor.calls.load(Ordering::SeqCst), 0);
    let state = fixture.store.load(&fixture.task).unwrap();
    assert_eq!(state.action.status, AutomationActionStatus::Failed);
    assert!(
        state
            .action
            .last_error
            .as_deref()
            .is_some_and(|message| message.contains("accepted chat history"))
    );
    assert!(
        fixture
            .chat
            .unread_snapshot()
            .await
            .unwrap()
            .messages
            .iter()
            .any(|message| message.id == "new-after-full-history")
    );
}

#[tokio::test]
async fn queued_unread_action_coalesces_messages_arriving_before_execution() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user("first-message".into(), "First pending message.".into())
        .await
        .unwrap();
    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    fixture
        .chat
        .append_user("second-message".into(), "Second pending message.".into())
        .await
        .unwrap();
    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap();
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::GenerationComplete {
            final_markdown: None,
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);

    fixture
        .supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 2)
        .await
        .unwrap()
        .unwrap();

    let executions = fixture.executor.executions.lock().unwrap();
    assert_eq!(executions.len(), 1);
    let ActionPrompt::OfflineChat { messages, .. } = &executions[0].request.prompt else {
        panic!("expected an offline chat action");
    };
    assert_eq!(
        messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec!["first-message", "second-message"]
    );
}

#[tokio::test]
async fn queued_unread_action_is_rebuilt_when_message_markdown_changes() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "edited-before-send".into(),
            "Original pending message.".into(),
        )
        .await
        .unwrap();
    let offline_at = 1_000 + OFFLINE_AFTER_MS;
    fixture.supervisor.scan_once(offline_at).await.unwrap();
    assert_eq!(fixture.supervisor.queued_count().await, 1);

    let path = fixture.chat.path().to_path_buf();
    let transcript = std::fs::read_to_string(&path).unwrap();
    assert!(transcript.contains("Original pending message."));
    std::fs::write(
        &path,
        transcript.replace("Original pending message.", "Revised pending message."),
    )
    .unwrap();

    assert!(
        fixture
            .supervisor
            .run_next(offline_at + 1)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(fixture.executor.calls.load(Ordering::SeqCst), 0);

    fixture.supervisor.scan_once(offline_at + 2).await.unwrap();
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::GenerationComplete {
            final_markdown: None,
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);
    fixture
        .supervisor
        .run_next(offline_at + 3)
        .await
        .unwrap()
        .unwrap();

    let executions = fixture.executor.executions.lock().unwrap();
    assert_eq!(executions.len(), 1);
    let ActionPrompt::OfflineChat { messages, .. } = &executions[0].request.prompt else {
        panic!("expected an offline chat action");
    };
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, "edited-before-send");
    assert_eq!(messages[0].markdown, "Revised pending message.");
}

#[tokio::test]
async fn queued_unread_action_is_rebuilt_when_message_order_changes() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user("reordered-first".into(), "First pending message.".into())
        .await
        .unwrap();
    fixture
        .chat
        .append_user("reordered-second".into(), "Second pending message.".into())
        .await
        .unwrap();
    let offline_at = 1_000 + OFFLINE_AFTER_MS;
    fixture.supervisor.scan_once(offline_at).await.unwrap();
    assert_eq!(fixture.supervisor.queued_count().await, 1);

    let path = fixture.chat.path().to_path_buf();
    let transcript = std::fs::read_to_string(&path).unwrap();
    let first_marker = "<!-- codexify-user-message:v1:start id=\"reordered-first\"";
    let second_marker = "<!-- codexify-user-message:v1:start id=\"reordered-second\"";
    let second_end_marker = "<!-- codexify-user-message:v1:end id=\"reordered-second\" -->\n";
    let first_start = transcript.find(first_marker).unwrap();
    let second_start = transcript.find(second_marker).unwrap();
    let second_end = transcript[second_start..]
        .find(second_end_marker)
        .map(|offset| second_start + offset + second_end_marker.len())
        .unwrap();
    let reordered = format!(
        "{}{}{}{}",
        &transcript[..first_start],
        &transcript[second_start..second_end],
        &transcript[first_start..second_start],
        &transcript[second_end..]
    );
    std::fs::write(&path, reordered).unwrap();
    assert_eq!(
        fixture
            .chat
            .unread_snapshot()
            .await
            .unwrap()
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec!["reordered-second", "reordered-first"]
    );

    assert!(
        fixture
            .supervisor
            .run_next(offline_at + 1)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(fixture.executor.calls.load(Ordering::SeqCst), 0);

    fixture.supervisor.scan_once(offline_at + 2).await.unwrap();
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::GenerationComplete {
            final_markdown: None,
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);
    fixture
        .supervisor
        .run_next(offline_at + 3)
        .await
        .unwrap()
        .unwrap();

    let executions = fixture.executor.executions.lock().unwrap();
    assert_eq!(executions.len(), 1);
    let ActionPrompt::OfflineChat { messages, .. } = &executions[0].request.prompt else {
        panic!("expected an offline chat action");
    };
    assert_eq!(
        messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec!["reordered-second", "reordered-first"]
    );
}

#[tokio::test]
async fn unread_chat_is_queued_ahead_of_goal_only_work_across_tasks() {
    let fixture = fixture().await;
    let goal = fixture
        .store
        .set_goal(&fixture.task, "Continue the goal-only task.", 100)
        .unwrap();
    fixture
        .store
        .run_goal(&fixture.task, goal.revision, 101)
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();

    let (_chat_task, chat) = add_task(
        &fixture,
        "priority-unread-task",
        "https://chatgpt.com/c/priority-unread",
    )
    .await;
    chat.record_agent_call(1_000).await.unwrap();
    chat.append_user(
        "priority-message".into(),
        "Handle this owner message first.".into(),
    )
    .await
    .unwrap();

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();

    assert_eq!(fixture.supervisor.queued_count().await, 2);
    assert_eq!(
        fixture.supervisor.next_queued_kind().await,
        Some(codexify::agent_automation::AutomationActionKind::OfflineChat)
    );
}

#[tokio::test]
async fn concurrent_run_next_calls_still_execute_only_one_global_action_at_a_time() {
    let fixture = fixture().await;
    let (other_task, other_chat) = add_task(
        &fixture,
        "serialized-second-task",
        "https://chatgpt.com/c/serialized-second",
    )
    .await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    other_chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user("serialized-first".into(), "Run first.".into())
        .await
        .unwrap();
    other_chat
        .append_user("serialized-second".into(), "Run second.".into())
        .await
        .unwrap();

    let (started_tx, mut started_rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let executor = Arc::new(SerialExecutor {
        calls: AtomicUsize::new(0),
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
        started: started_tx,
        release: release.clone(),
    });
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        executor.clone(),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    supervisor
        .register_task(AutomationTaskHandle::new(
            other_task,
            0,
            fixture.store.clone(),
            other_chat,
        ))
        .await
        .unwrap();
    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    assert_eq!(supervisor.queued_count().await, 2);

    let first = tokio::spawn({
        let supervisor = supervisor.clone();
        async move { supervisor.run_next(1_000 + OFFLINE_AFTER_MS + 1).await }
    });
    let second = tokio::spawn({
        let supervisor = supervisor.clone();
        async move { supervisor.run_next(1_000 + OFFLINE_AFTER_MS + 1).await }
    });
    assert_eq!(started_rx.recv().await, Some(1));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), started_rx.recv())
            .await
            .is_err()
    );

    release.add_permits(1);
    assert_eq!(started_rx.recv().await, Some(2));
    release.add_permits(1);
    first.await.unwrap().unwrap().unwrap();
    second.await.unwrap().unwrap().unwrap();
    assert_eq!(executor.max_active.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn stable_browser_final_is_persisted_once_when_chat_write_produces_no_output() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "fallback-message".into(),
            "Produce a browser fallback answer.".into(),
        )
        .await
        .unwrap();
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::GenerationComplete {
            final_markdown: Some("Stable browser fallback answer.".into()),
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    fixture
        .supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();

    let transcript = fixture.chat.clean_markdown_transcript().await.unwrap();
    assert_eq!(
        transcript
            .matches("Stable browser fallback answer.")
            .count(),
        1
    );
    assert_eq!(
        fixture
            .store
            .load(&fixture.task)
            .unwrap()
            .action
            .last_stable_answer
            .as_deref(),
        Some("Stable browser fallback answer.")
    );
}

#[tokio::test]
async fn oversized_transient_browser_status_is_bounded_without_orphaning_the_action() {
    let fixture = fixture().await;
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        Arc::new(LargeTransientExecutor),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "large-transient-message".into(),
            "Complete despite verbose transient browser status.".into(),
        )
        .await
        .unwrap();

    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();

    let live = supervisor.live_state(&fixture.task).await.unwrap();
    assert!(
        live.status
            .as_ref()
            .is_some_and(|value| value.len() <= 1024 * 1024)
    );
    assert_eq!(live.phase, AutomationActionStatus::Idle);
    assert!(
        fixture
            .chat
            .clean_markdown_transcript()
            .await
            .unwrap()
            .contains("Complete after long transient output.")
    );
}

#[tokio::test]
async fn streamed_answer_deltas_reconstruct_a_final_omitted_from_the_terminal_event() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "streamed-fallback-message".into(),
            "Produce a browser answer whose terminal event omits the full body.".into(),
        )
        .await
        .unwrap();
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::AnswerDelta {
            markdown: "Stable streamed browser ".into(),
            continuation: false,
        },
        CompanionEventKind::AnswerDelta {
            markdown: "fallback answer.".into(),
            continuation: true,
        },
        CompanionEventKind::GenerationComplete {
            final_markdown: None,
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    fixture
        .supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();

    let expected = "Stable streamed browser fallback answer.";
    let transcript = fixture.chat.clean_markdown_transcript().await.unwrap();
    assert_eq!(transcript.matches(expected).count(), 1);
    assert_eq!(
        fixture
            .store
            .load(&fixture.task)
            .unwrap()
            .action
            .last_stable_answer
            .as_deref(),
        Some(expected)
    );
}

#[tokio::test]
async fn large_stable_browser_final_does_not_orphan_the_persisted_action() {
    let fixture = fixture().await;
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        Arc::new(LargeFinalAnswerExecutor),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "large-stable-final".into(),
            "Persist a stable browser answer larger than its diagnostic preview.".into(),
        )
        .await
        .unwrap();

    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();

    let expected = format!("{}{}", "a".repeat(40 * 1024), "b".repeat(40 * 1024));
    assert!(
        fixture
            .chat
            .clean_markdown_transcript()
            .await
            .unwrap()
            .contains(&expected)
    );
    let state = fixture.store.load(&fixture.task).unwrap();
    assert_eq!(state.action.status, AutomationActionStatus::Idle);
    assert!(
        state
            .action
            .last_stable_answer
            .as_ref()
            .is_none_or(|answer| answer.len() <= 64 * 1024)
    );
}

#[tokio::test]
async fn chat_write_output_suppresses_duplicate_browser_final_persistence() {
    let fixture = fixture().await;
    let executor = Arc::new(ChatWritingExecutor {
        chat: fixture.chat.clone(),
    });
    let supervisor =
        AgentAutomationSupervisor::new(fixture.config.markdown_chat.automation.clone(), executor);
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user("racing-message".into(), "Trigger both output paths.".into())
        .await
        .unwrap();

    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();

    let transcript = fixture.chat.clean_markdown_transcript().await.unwrap();
    assert!(transcript.contains("Authoritative output from chat_write."));
    assert!(!transcript.contains("Duplicate browser final answer."));
    assert_eq!(
        fixture
            .store
            .load(&fixture.task)
            .unwrap()
            .action
            .last_stable_answer
            .as_deref(),
        Some("Duplicate browser final answer.")
    );
}

#[tokio::test]
async fn changing_selection_invalidates_queued_work_instead_of_mutating_its_identity() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "selection-message".into(),
            "Use the newly selected effort.".into(),
        )
        .await
        .unwrap();
    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    let old_action = fixture
        .store
        .load(&fixture.task)
        .unwrap()
        .action
        .id
        .unwrap();

    fixture
        .store
        .set_selection(
            &fixture.task,
            "gpt-6-sol",
            "medium",
            "catalog-2",
            "account-1",
            2_000,
        )
        .unwrap();
    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap();

    let new_action = fixture
        .store
        .load(&fixture.task)
        .unwrap()
        .action
        .id
        .unwrap();
    assert_ne!(new_action, old_action);
    assert_eq!(fixture.supervisor.queued_count().await, 1);
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::GenerationComplete {
            final_markdown: None,
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);
    fixture
        .supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 2)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        fixture.executor.executions.lock().unwrap()[0]
            .request
            .effort,
        "medium"
    );
}

#[tokio::test]
async fn owner_generation_change_invalidates_pairing_and_queued_work_before_send() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "owner-change-message".into(),
            "Do not send this to the previous physical owner.".into(),
        )
        .await
        .unwrap();
    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    assert_eq!(fixture.supervisor.queued_count().await, 1);

    fixture
        .supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            1,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();

    assert_eq!(fixture.supervisor.queued_count().await, 0);
    let state = fixture.store.load(&fixture.task).unwrap();
    assert!(state.pairing.verified_owner_generation.is_none());
    assert_eq!(state.action.status, AutomationActionStatus::Unverified);
    assert!(
        fixture
            .supervisor
            .run_next(1_000 + OFFLINE_AFTER_MS + 1)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(fixture.executor.calls.load(Ordering::SeqCst), 0);
    assert!(!fixture.chat.read(false).await.unwrap().text.is_empty());
}

#[tokio::test]
async fn queue_capacity_leaves_messages_unread_and_records_one_bounded_failure() {
    let fixture = fixture_with_queue_limit(1).await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user("capacity-first".into(), "First capacity message.".into())
        .await
        .unwrap();
    let (other_task, other_chat) = add_task(
        &fixture,
        "capacity-second-task",
        "https://chatgpt.com/c/capacity-second",
    )
    .await;
    other_chat.record_agent_call(1_000).await.unwrap();
    other_chat
        .append_user("capacity-second".into(), "Second capacity message.".into())
        .await
        .unwrap();

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();

    assert_eq!(fixture.supervisor.queued_count().await, 1);
    let states = [
        fixture.store.load(&fixture.task).unwrap(),
        fixture.store.load(&other_task).unwrap(),
    ];
    assert_eq!(
        states
            .iter()
            .filter(|state| state.action.status == AutomationActionStatus::Failed)
            .count(),
        1
    );
    let failure = states
        .iter()
        .find(|state| state.action.status == AutomationActionStatus::Failed)
        .unwrap();
    let failed_action_id = failure
        .action
        .id
        .as_deref()
        .expect("queue-local failures need an explicit retry identity")
        .to_string();
    assert!(
        failure
            .action
            .last_error
            .as_deref()
            .unwrap()
            .contains("queue capacity")
    );
    assert!(!fixture.chat.read(false).await.unwrap().text.is_empty());
    assert!(!other_chat.read(false).await.unwrap().text.is_empty());

    fixture
        .supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();
    let failed_task = if states[0].action.status == AutomationActionStatus::Failed {
        fixture.task.clone()
    } else {
        other_task
    };
    let retried = fixture
        .supervisor
        .retry_failed_action(
            &failed_task,
            &failed_action_id,
            1_000 + OFFLINE_AFTER_MS + 2,
        )
        .await
        .unwrap();
    assert_eq!(retried.status, AutomationActionStatus::Queued);
    assert_ne!(retried.id.as_deref(), Some(failed_action_id.as_str()));
    assert_eq!(fixture.supervisor.queued_count().await, 1);
}

#[tokio::test]
async fn pre_send_failure_preserves_unread_chat_without_automatic_retry() {
    let fixture = fixture().await;
    let executor = Arc::new(PreSendFailureExecutor::default());
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        executor.clone(),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "pre-send-failure".into(),
            "Keep this unread until the browser is repaired.".into(),
        )
        .await
        .unwrap();

    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    let error = match supervisor.run_next(1_000 + OFFLINE_AFTER_MS + 1).await {
        Ok(_) => panic!("pre-Send failure must remain an error"),
        Err(error) => error,
    };
    assert!(error.contains("before Send"));
    assert_eq!(
        fixture.store.load(&fixture.task).unwrap().action.status,
        AutomationActionStatus::Failed
    );
    assert!(!fixture.chat.read(false).await.unwrap().text.is_empty());

    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS + 2)
        .await
        .unwrap();
    assert_eq!(supervisor.queued_count().await, 0);
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn ambiguous_combined_send_is_never_replayed_in_the_same_activity_epoch() {
    let fixture = fixture().await;
    let goal = fixture
        .store
        .set_goal(&fixture.task, "Continue after the owner message.", 100)
        .unwrap();
    fixture
        .store
        .run_goal(&fixture.task, goal.revision, 101)
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "ambiguous-message".into(),
            "This send must not be replayed.".into(),
        )
        .await
        .unwrap();
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        Arc::new(AmbiguousExecutor),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();

    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    let error = match supervisor.run_next(1_000 + OFFLINE_AFTER_MS + 1).await {
        Ok(_) => panic!("ambiguous send must fail closed"),
        Err(error) => error,
    };
    assert!(error.contains("may have been accepted"));
    let state = fixture.store.load(&fixture.task).unwrap();
    assert_eq!(state.action.status, AutomationActionStatus::Ambiguous);
    assert_eq!(state.chat_mirror.message_ids, vec!["ambiguous-message"]);
    assert!(state.goal_wake.nudged_epoch.is_some());

    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS + 2)
        .await
        .unwrap();
    assert_eq!(supervisor.queued_count().await, 0);
}

#[tokio::test]
async fn browser_deltas_are_visible_live_but_not_persisted_before_completion() {
    let fixture = fixture().await;
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        Arc::new(StreamingExecutor {
            started: started.clone(),
            release: release.clone(),
        }),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user("stream-message".into(), "Show browser progress.".into())
        .await
        .unwrap();
    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();

    let runner = tokio::spawn({
        let supervisor = supervisor.clone();
        async move { supervisor.run_next(1_000 + OFFLINE_AFTER_MS + 1).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    let live = supervisor.live_state(&fixture.task).await.unwrap();
    assert_eq!(live.status.as_deref(), Some("Using the browser"));
    assert_eq!(live.commentary.as_deref(), Some("Visible commentary"));
    assert_eq!(live.answer.as_deref(), Some("Partial answer"));
    assert!(
        !fixture
            .chat
            .clean_markdown_transcript()
            .await
            .unwrap()
            .contains("Partial answer")
    );

    release.notify_one();
    runner.await.unwrap().unwrap().unwrap();
    assert!(
        fixture
            .chat
            .clean_markdown_transcript()
            .await
            .unwrap()
            .contains("Complete answer")
    );
}

#[tokio::test]
async fn replacing_a_goal_during_generation_does_not_apply_the_old_terminal_receipt() {
    let fixture = fixture().await;
    let goal = fixture
        .store
        .set_goal(&fixture.task, "Original browser goal.", 100)
        .unwrap();
    fixture
        .store
        .run_goal(&fixture.task, goal.revision, 101)
        .unwrap();
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        Arc::new(StreamingExecutor {
            started: started.clone(),
            release: release.clone(),
        }),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    let runner = tokio::spawn({
        let supervisor = supervisor.clone();
        async move { supervisor.run_next(1_000 + OFFLINE_AFTER_MS + 1).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
        .await
        .unwrap();

    let replacement = fixture
        .store
        .set_goal(&fixture.task, "Replacement browser goal.", 2_000)
        .unwrap();
    release.notify_one();

    assert!(runner.await.unwrap().unwrap().is_some());
    let state = fixture.store.load(&fixture.task).unwrap();
    assert_eq!(state.goal.as_ref().unwrap().revision, replacement.revision);
    assert_eq!(
        state.goal.as_ref().unwrap().markdown,
        "Replacement browser goal."
    );
    assert!(state.action.id.is_none());
    assert!(
        !fixture
            .chat
            .clean_markdown_transcript()
            .await
            .unwrap()
            .contains("Complete answer")
    );
}

#[tokio::test]
async fn owner_generation_change_during_generation_discards_old_browser_output() {
    let fixture = fixture().await;
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        Arc::new(StreamingExecutor {
            started: started.clone(),
            release: release.clone(),
        }),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "owner-changed-during-generation".into(),
            "Do not persist output from the previous physical owner.".into(),
        )
        .await
        .unwrap();
    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    let runner = tokio::spawn({
        let supervisor = supervisor.clone();
        async move { supervisor.run_next(1_000 + OFFLINE_AFTER_MS + 1).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
        .await
        .unwrap();

    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            1,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    release.notify_one();

    assert!(runner.await.unwrap().unwrap().is_some());
    let state = fixture.store.load(&fixture.task).unwrap();
    assert!(state.pairing.verified_owner_generation.is_none());
    assert_eq!(state.action.status, AutomationActionStatus::Unverified);
    assert!(
        !fixture
            .chat
            .clean_markdown_transcript()
            .await
            .unwrap()
            .contains("Complete answer")
    );
    assert!(
        fixture
            .chat
            .unread_snapshot()
            .await
            .unwrap()
            .messages
            .iter()
            .any(|message| message.id == "owner-changed-during-generation")
    );
}

#[tokio::test]
async fn account_change_during_generation_discards_old_browser_output() {
    let fixture = fixture().await;
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        Arc::new(StreamingExecutor {
            started: started.clone(),
            release: release.clone(),
        }),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "account-changed-during-generation".into(),
            "Do not persist output from the previous ChatGPT account.".into(),
        )
        .await
        .unwrap();
    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    let runner = tokio::spawn({
        let supervisor = supervisor.clone();
        async move { supervisor.run_next(1_000 + OFFLINE_AFTER_MS + 1).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
        .await
        .unwrap();

    fixture
        .store
        .set_selection(
            &fixture.task,
            "gpt-6-sol",
            "high",
            "catalog-2",
            "account-2",
            2_000,
        )
        .unwrap();
    release.notify_one();

    assert!(runner.await.unwrap().unwrap().is_some());
    let state = fixture.store.load(&fixture.task).unwrap();
    assert!(state.pairing.verified_owner_generation.is_none());
    assert_eq!(state.action.status, AutomationActionStatus::Unverified);
    assert!(
        !fixture
            .chat
            .clean_markdown_transcript()
            .await
            .unwrap()
            .contains("Complete answer")
    );
}

#[tokio::test]
async fn superseded_combined_action_still_fences_its_accepted_unread_batch() {
    let fixture = fixture().await;
    let goal = fixture
        .store
        .set_goal(&fixture.task, "Original combined goal.", 100)
        .unwrap();
    fixture
        .store
        .run_goal(&fixture.task, goal.revision, 101)
        .unwrap();
    fixture
        .chat
        .append_user(
            "superseded-combined-message".into(),
            "Do not mirror this accepted message twice.".into(),
        )
        .await
        .unwrap();
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        Arc::new(StreamingExecutor {
            started: started.clone(),
            release: release.clone(),
        }),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    let runner = tokio::spawn({
        let supervisor = supervisor.clone();
        async move { supervisor.run_next(1_000 + OFFLINE_AFTER_MS + 1).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
        .await
        .unwrap();

    fixture
        .store
        .set_goal(&fixture.task, "Replacement combined goal.", 2_000)
        .unwrap();
    release.notify_one();

    assert!(runner.await.unwrap().unwrap().is_some());
    let state = fixture.store.load(&fixture.task).unwrap();
    assert_eq!(
        state.chat_mirror.message_ids,
        vec!["superseded-combined-message"]
    );
    assert!(state.action.id.is_none());
    assert!(!fixture.chat.read(false).await.unwrap().text.is_empty());
}

#[tokio::test]
async fn real_executor_rejects_account_mismatch_before_execute() {
    let execute_calls = Arc::new(AtomicUsize::new(0));
    let execute_counter = execute_calls.clone();
    let app = Router::new()
        .route(
            "/v1/health",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "kind":"codexify-browser-companion",
                    "build":COMPANION_BUILD,
                    "status":"idle",
                    "authenticated":true,
                    "accountFingerprint":"different-account",
                    "activeActionId":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/session/capabilities",
            post(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
        )
        .route(
            "/v1/actions/execute",
            post(move || {
                let execute_counter = execute_counter.clone();
                async move {
                    execute_counter.fetch_add(1, Ordering::SeqCst);
                    StatusCode::INTERNAL_SERVER_ERROR
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let descriptor = write_companion_descriptor(root.path(), &endpoint);
    let config = codexify::markdown_chat::AgentAutomationConfig {
        enabled: true,
        descriptor_path: descriptor.display().to_string(),
        ..Default::default()
    };
    let executor = BrowserAutomationExecutor::new(config);
    let execution = AutomationExecution {
        task_key: "a".repeat(64),
        owner_generation: 0,
        account_fingerprint: "expected-account".into(),
        catalog_revision: "catalog-1".into(),
        activity_epoch: "epoch-1".into(),
        activity_sequence: 1,
        tool_call_count_at_start: 1,
        unread_message_ids: Vec::new(),
        transcript_revision: "revision-1".into(),
        pairing_commit: None,
        request: codexify::agent_automation::ExecuteActionRequest {
            action_id: "action-account-check".into(),
            idempotency_key: "execute-account-check".into(),
            url: "https://chatgpt.com/c/example".into(),
            pairing_generation: 1,
            connector_name: "Codexify".into(),
            model: "gpt-6-sol".into(),
            effort: "high".into(),
            prompt: ActionPrompt::OfflineGoal { goal_revision: 1 },
            expected_url: "https://chatgpt.com/c/example".into(),
            auto_approve_tool_calls: false,
        },
    };
    let (events, _events_rx) = mpsc::unbounded_channel();

    let error = executor
        .execute(execution, events, CancellationToken::new())
        .await
        .err()
        .unwrap();

    assert!(!error.send_accepted);
    assert!(error.message.contains("account"));
    assert_eq!(execute_calls.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
async fn real_executor_marks_an_unreconciled_execute_receipt_as_ambiguous() {
    let app = Router::new()
        .route(
            "/v1/health",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "kind":"codexify-browser-companion",
                    "build":COMPANION_BUILD,
                    "status":"idle",
                    "authenticated":true,
                    "accountFingerprint":"account-1",
                    "activeActionId":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/session/capabilities",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "accountFingerprint":"account-1",
                    "catalogRevision":"catalog-1",
                    "models":[{
                        "id":"gpt-6-sol",
                        "label":"GPT-6 Sol",
                        "efforts":[{
                            "id":"high",
                            "label":"High",
                            "available":true,
                            "reason":null
                        }]
                    }]
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/execute",
            post(|| async {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from("{"))
                    .unwrap()
            }),
        )
        .route(
            "/v1/actions/{action_id}",
            get(|| async { StatusCode::SERVICE_UNAVAILABLE }),
        );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let descriptor = write_companion_descriptor(root.path(), &endpoint);
    let config = codexify::markdown_chat::AgentAutomationConfig {
        enabled: true,
        descriptor_path: descriptor.display().to_string(),
        ..Default::default()
    };
    let executor = BrowserAutomationExecutor::new(config);
    let execution = AutomationExecution {
        task_key: "f".repeat(64),
        owner_generation: 0,
        account_fingerprint: "account-1".into(),
        catalog_revision: "catalog-1".into(),
        activity_epoch: "epoch-1".into(),
        activity_sequence: 1,
        tool_call_count_at_start: 1,
        unread_message_ids: vec!["ambiguous-execute-message".into()],
        transcript_revision: "revision-1".into(),
        pairing_commit: None,
        request: codexify::agent_automation::ExecuteActionRequest {
            action_id: "ambiguous-execute-action".into(),
            idempotency_key: "ambiguous-execute-idempotency".into(),
            url: "https://chatgpt.com/c/ambiguous-execute".into(),
            pairing_generation: 1,
            connector_name: "Codexify".into(),
            model: "gpt-6-sol".into(),
            effort: "high".into(),
            prompt: ActionPrompt::OfflineChat {
                batch_id: "ambiguous-execute-batch".into(),
                messages: vec![codexify::agent_automation::CompanionUnreadMessage {
                    id: "ambiguous-execute-message".into(),
                    markdown: "Do not replay an action whose execute receipt was lost.".into(),
                }],
            },
            expected_url: "https://chatgpt.com/c/ambiguous-execute".into(),
            auto_approve_tool_calls: false,
        },
    };
    let (events, _events_rx) = mpsc::unbounded_channel();

    let error = match executor
        .execute(execution, events, CancellationToken::new())
        .await
    {
        Ok(_) => panic!("an unreconciled execute receipt must fail closed"),
        Err(error) => error,
    };

    assert!(error.send_accepted);
    server.abort();
}

#[tokio::test]
async fn successful_execute_receipt_stays_ambiguous_when_status_returns_not_found() {
    let app = Router::new()
        .route(
            "/v1/health",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "kind":"codexify-browser-companion",
                    "build":COMPANION_BUILD,
                    "status":"idle",
                    "authenticated":true,
                    "accountFingerprint":"account-1",
                    "activeActionId":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/session/capabilities",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "accountFingerprint":"account-1",
                    "catalogRevision":"catalog-1",
                    "models":[{
                        "id":"gpt-6-sol",
                        "label":"GPT-6 Sol",
                        "efforts":[{
                            "id":"high",
                            "label":"High",
                            "available":true,
                            "reason":null
                        }]
                    }]
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/execute",
            post(|| async {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from("{"))
                    .unwrap()
            }),
        )
        .route(
            "/v1/actions/{action_id}",
            get(|| async { StatusCode::NOT_FOUND }),
        );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let descriptor = write_companion_descriptor(root.path(), &endpoint);
    let config = codexify::markdown_chat::AgentAutomationConfig {
        enabled: true,
        descriptor_path: descriptor.display().to_string(),
        ..Default::default()
    };
    let executor = BrowserAutomationExecutor::new(config);
    let execution = AutomationExecution {
        task_key: "e".repeat(64),
        owner_generation: 0,
        account_fingerprint: "account-1".into(),
        catalog_revision: "catalog-1".into(),
        activity_epoch: "epoch-1".into(),
        activity_sequence: 1,
        tool_call_count_at_start: 1,
        unread_message_ids: vec!["ambiguous-not-found-message".into()],
        transcript_revision: "revision-1".into(),
        pairing_commit: None,
        request: codexify::agent_automation::ExecuteActionRequest {
            action_id: "ambiguous-not-found-action".into(),
            idempotency_key: "ambiguous-not-found-idempotency".into(),
            url: "https://chatgpt.com/c/ambiguous-not-found".into(),
            pairing_generation: 1,
            connector_name: "Codexify".into(),
            model: "gpt-6-sol".into(),
            effort: "high".into(),
            prompt: ActionPrompt::OfflineChat {
                batch_id: "ambiguous-not-found-batch".into(),
                messages: vec![codexify::agent_automation::CompanionUnreadMessage {
                    id: "ambiguous-not-found-message".into(),
                    markdown: "Do not trust a racy status 404 after a successful execute receipt."
                        .into(),
                }],
            },
            expected_url: "https://chatgpt.com/c/ambiguous-not-found".into(),
            auto_approve_tool_calls: false,
        },
    };
    let (events, _events_rx) = mpsc::unbounded_channel();

    let error = match executor
        .execute(execution, events, CancellationToken::new())
        .await
    {
        Ok(_) => panic!("a malformed successful execute receipt remains ambiguous"),
        Err(error) => error,
    };

    assert!(error.send_accepted);
    server.abort();
}

#[tokio::test]
async fn terminal_idle_receipt_without_send_proof_is_ambiguous() {
    let app = Router::new()
        .route(
            "/v1/health",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "kind":"codexify-browser-companion",
                    "build":COMPANION_BUILD,
                    "status":"idle",
                    "authenticated":true,
                    "accountFingerprint":"account-1",
                    "activeActionId":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/session/capabilities",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "accountFingerprint":"account-1",
                    "catalogRevision":"catalog-1",
                    "models":[{
                        "id":"gpt-6-sol",
                        "label":"GPT-6 Sol",
                        "efforts":[{
                            "id":"high",
                            "label":"High",
                            "available":true,
                            "reason":null
                        }]
                    }]
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/execute",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "actionId":"idle-without-send-action",
                    "state":"idle",
                    "sendAccepted":false,
                    "canonicalUrl":null,
                    "selected":null,
                    "lastEventSequence":0,
                    "attention":null
                }))
                .into_response()
            }),
        );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let descriptor = write_companion_descriptor(root.path(), &endpoint);
    let config = codexify::markdown_chat::AgentAutomationConfig {
        enabled: true,
        descriptor_path: descriptor.display().to_string(),
        ..Default::default()
    };
    let executor = BrowserAutomationExecutor::new(config);
    let execution = AutomationExecution {
        task_key: "d".repeat(64),
        owner_generation: 0,
        account_fingerprint: "account-1".into(),
        catalog_revision: "catalog-1".into(),
        activity_epoch: "epoch-1".into(),
        activity_sequence: 1,
        tool_call_count_at_start: 1,
        unread_message_ids: vec!["idle-without-send-message".into()],
        transcript_revision: "revision-1".into(),
        pairing_commit: None,
        request: codexify::agent_automation::ExecuteActionRequest {
            action_id: "idle-without-send-action".into(),
            idempotency_key: "idle-without-send-idempotency".into(),
            url: "https://chatgpt.com/c/idle-without-send".into(),
            pairing_generation: 1,
            connector_name: "Codexify".into(),
            model: "gpt-6-sol".into(),
            effort: "high".into(),
            prompt: ActionPrompt::OfflineChat {
                batch_id: "idle-without-send-batch".into(),
                messages: vec![codexify::agent_automation::CompanionUnreadMessage {
                    id: "idle-without-send-message".into(),
                    markdown: "Do not accept a successful terminal receipt without Send proof."
                        .into(),
                }],
            },
            expected_url: "https://chatgpt.com/c/idle-without-send".into(),
            auto_approve_tool_calls: false,
        },
    };
    let (events, _events_rx) = mpsc::unbounded_channel();

    let error = match executor
        .execute(execution, events, CancellationToken::new())
        .await
    {
        Ok(_) => panic!("idle without Send proof must fail closed"),
        Err(error) => error,
    };

    assert!(error.send_accepted);
    assert!(error.message.contains("Send acceptance"));
    server.abort();
}

#[tokio::test]
async fn accepted_execute_with_unreconciled_event_stream_is_ambiguous() {
    let app = Router::new()
        .route(
            "/v1/health",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "kind":"codexify-browser-companion",
                    "build":COMPANION_BUILD,
                    "status":"idle",
                    "authenticated":true,
                    "accountFingerprint":"account-1",
                    "activeActionId":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/session/capabilities",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "accountFingerprint":"account-1",
                    "catalogRevision":"catalog-1",
                    "models":[{
                        "id":"gpt-6-sol",
                        "label":"GPT-6 Sol",
                        "efforts":[{
                            "id":"high",
                            "label":"High",
                            "available":true,
                            "reason":null
                        }]
                    }]
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/execute",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "actionId":"unreconciled-stream-action",
                    "state":"queued",
                    "sendAccepted":false,
                    "canonicalUrl":null,
                    "selected":null,
                    "lastEventSequence":0,
                    "attention":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/{action_id}/events",
            get(|| async { StatusCode::NOT_FOUND }),
        )
        .route(
            "/v1/actions/{action_id}",
            get(|| async { StatusCode::NOT_FOUND }),
        );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let descriptor = write_companion_descriptor(root.path(), &endpoint);
    let config = codexify::markdown_chat::AgentAutomationConfig {
        enabled: true,
        descriptor_path: descriptor.display().to_string(),
        ..Default::default()
    };
    let executor = BrowserAutomationExecutor::new(config);
    let execution = AutomationExecution {
        task_key: "c".repeat(64),
        owner_generation: 0,
        account_fingerprint: "account-1".into(),
        catalog_revision: "catalog-1".into(),
        activity_epoch: "epoch-1".into(),
        activity_sequence: 1,
        tool_call_count_at_start: 1,
        unread_message_ids: vec!["unreconciled-stream-message".into()],
        transcript_revision: "revision-1".into(),
        pairing_commit: None,
        request: codexify::agent_automation::ExecuteActionRequest {
            action_id: "unreconciled-stream-action".into(),
            idempotency_key: "unreconciled-stream-idempotency".into(),
            url: "https://chatgpt.com/c/unreconciled-stream".into(),
            pairing_generation: 1,
            connector_name: "Codexify".into(),
            model: "gpt-6-sol".into(),
            effort: "high".into(),
            prompt: ActionPrompt::OfflineChat {
                batch_id: "unreconciled-stream-batch".into(),
                messages: vec![codexify::agent_automation::CompanionUnreadMessage {
                    id: "unreconciled-stream-message".into(),
                    markdown: "Do not retry after losing observation of an accepted action.".into(),
                }],
            },
            expected_url: "https://chatgpt.com/c/unreconciled-stream".into(),
            auto_approve_tool_calls: false,
        },
    };
    let (events, _events_rx) = mpsc::unbounded_channel();

    let error = match executor
        .execute(execution, events, CancellationToken::new())
        .await
    {
        Ok(_) => panic!("an unreconciled accepted action must fail closed"),
        Err(error) => error,
    };

    assert!(error.send_accepted);
    server.abort();
}

#[tokio::test]
async fn real_pair_executor_records_the_candidate_before_the_async_send_receipt() {
    let expected_url = "https://chatgpt.com/c/pair-production";
    let app = Router::new()
        .route(
            "/v1/health",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "kind":"codexify-browser-companion",
                    "build":COMPANION_BUILD,
                    "status":"idle",
                    "authenticated":true,
                    "accountFingerprint":"account-1",
                    "activeActionId":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/session/capabilities",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "accountFingerprint":"account-1",
                    "catalogRevision":"catalog-1",
                    "models":[{
                        "id":"gpt-6-sol",
                        "label":"GPT-6 Sol",
                        "efforts":[{"id":"high","label":"High","available":true,"reason":null}]
                    }]
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/execute",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "actionId":"pair-production-action",
                    "state":"queued",
                    "sendAccepted":false,
                    "canonicalUrl":null,
                    "selected":null,
                    "lastEventSequence":0,
                    "attention":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/pair-production-action/events",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                let events = [
                    serde_json::json!({
                        "sequence":1,"actionId":"pair-production-action","atMs":1,
                        "type":"navigating"
                    }),
                    serde_json::json!({
                        "sequence":2,"actionId":"pair-production-action","atMs":2,
                        "type":"model_verified","model":"gpt-6-sol","effort":"high"
                    }),
                    serde_json::json!({
                        "sequence":3,"actionId":"pair-production-action","atMs":3,
                        "type":"connector_verified"
                    }),
                    serde_json::json!({
                        "sequence":4,"actionId":"pair-production-action","atMs":4,
                        "type":"send_accepted"
                    }),
                    serde_json::json!({
                        "sequence":5,"actionId":"pair-production-action","atMs":5,
                        "type":"generation_complete","finalMarkdown":null,
                        "canonicalUrl":"https://chatgpt.com/c/pair-production"
                    }),
                ];
                let body = events
                    .into_iter()
                    .map(|event| format!("{event}\n"))
                    .collect::<String>();
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/x-ndjson")
                    .body(Body::from(body))
                    .unwrap()
            }),
        )
        .route(
            "/v1/actions/pair-production-action",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "actionId":"pair-production-action",
                    "state":"idle",
                    "sendAccepted":true,
                    "canonicalUrl":"https://chatgpt.com/c/pair-production",
                    "selected":{"model":"gpt-6-sol","effort":"high"},
                    "lastEventSequence":5,
                    "attention":null
                }))
                .into_response()
            }),
        );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let mut app_config = default_config(project);
    app_config.memory.dir = Some(root.path().join("state").display().to_string());
    app_config.markdown_chat.enabled = true;
    app_config.markdown_chat.automation.enabled = true;
    app_config.markdown_chat.automation.descriptor_path =
        write_companion_descriptor(root.path(), &endpoint)
            .display()
            .to_string();
    let task = ConversationIdentity::from_openai_session("pair-production-task").unwrap();
    let store = Arc::new(AgentAutomationStore::for_config(&app_config).unwrap());
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    store
        .set_selection(&task, "gpt-6-sol", "high", "catalog-1", "account-1", now_ms)
        .unwrap();
    let pairing = store.issue_pairing(&task, expected_url, 0, now_ms).unwrap();
    let executor = BrowserAutomationExecutor::new(app_config.markdown_chat.automation.clone());
    let execution = AutomationExecution {
        task_key: "c".repeat(64),
        owner_generation: 0,
        account_fingerprint: "account-1".into(),
        catalog_revision: "catalog-1".into(),
        activity_epoch: "pair-verification".into(),
        activity_sequence: pairing.generation,
        tool_call_count_at_start: 0,
        unread_message_ids: Vec::new(),
        transcript_revision: String::new(),
        pairing_commit: Some(PairingCommit::new(
            task.clone(),
            store.clone(),
            pairing.generation,
        )),
        request: codexify::agent_automation::ExecuteActionRequest {
            action_id: "pair-production-action".into(),
            idempotency_key: "pair-production-execute".into(),
            url: expected_url.into(),
            pairing_generation: pairing.generation,
            connector_name: "Codexify".into(),
            model: "gpt-6-sol".into(),
            effort: "high".into(),
            prompt: ActionPrompt::PairVerify {
                reference: pairing.reference,
            },
            expected_url: expected_url.into(),
            auto_approve_tool_calls: false,
        },
    };
    let (events, mut events_rx) = mpsc::unbounded_channel();

    let snapshot = executor
        .execute(execution, events, CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(snapshot.state, CompanionActionState::Idle);
    while events_rx.try_recv().is_ok() {}
    assert_eq!(
        store.load(&task).unwrap().pairing.canonical_url.as_deref(),
        Some(expected_url)
    );
    server.abort();
}

#[tokio::test]
async fn real_executor_reconnects_a_dropped_stream_before_accepting_terminal_state() {
    let stream_calls = Arc::new(AtomicUsize::new(0));
    let event_counter = stream_calls.clone();
    let status_calls = Arc::new(AtomicUsize::new(0));
    let status_counter = status_calls.clone();
    let app = Router::new()
        .route(
            "/v1/health",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "kind":"codexify-browser-companion",
                    "build":COMPANION_BUILD,
                    "status":"idle",
                    "authenticated":true,
                    "accountFingerprint":"account-1",
                    "activeActionId":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/session/capabilities",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "accountFingerprint":"account-1",
                    "catalogRevision":"catalog-1",
                    "models":[{
                        "id":"gpt-6-sol",
                        "label":"GPT-6 Sol",
                        "efforts":[{"id":"high","label":"High","available":true,"reason":null}]
                    }]
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/execute",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "actionId":"stream-reconnect-action",
                    "state":"queued",
                    "sendAccepted":false,
                    "canonicalUrl":null,
                    "selected":null,
                    "lastEventSequence":0,
                    "attention":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/stream-reconnect-action/events",
            get(move |headers: HeaderMap| {
                let event_counter = event_counter.clone();
                async move {
                    if !authorized(&headers) {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    let call = event_counter.fetch_add(1, Ordering::SeqCst);
                    let body = if call == 0 {
                        concat!(
                            "{\"sequence\":1,\"actionId\":\"stream-reconnect-action\",\"atMs\":1,\"type\":\"send_accepted\"}\n",
                            "{\"sequence\":2,\"actionId\":\"stream-reconnect-action\",\"atMs\":2,\"type\":\"answer_delta\",\"markdown\":\"Recovered answer\",\"continuation\":false}\n",
                            "{\"sequence\":3"
                        )
                        .to_string()
                    } else {
                        concat!(
                            "{\"sequence\":3,\"actionId\":\"stream-reconnect-action\",\"atMs\":3,",
                            "\"type\":\"generation_complete\",\"finalMarkdown\":\"Recovered answer\",",
                            "\"canonicalUrl\":\"https://chatgpt.com/c/stream-reconnect\"}\n"
                        )
                        .to_string()
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/x-ndjson")
                        .body(Body::from(body))
                        .unwrap()
                }
            }),
        )
        .route(
            "/v1/actions/stream-reconnect-action",
            get(move |headers: HeaderMap| {
                let status_counter = status_counter.clone();
                async move {
                    if !authorized(&headers) {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    let generating = status_counter.fetch_add(1, Ordering::SeqCst) == 0;
                    axum::Json(serde_json::json!({
                        "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                        "build":COMPANION_BUILD,
                        "actionId":"stream-reconnect-action",
                        "state":if generating { "generating" } else { "idle" },
                        "sendAccepted":true,
                        "canonicalUrl":"https://chatgpt.com/c/stream-reconnect",
                        "selected":{"model":"gpt-6-sol","effort":"high"},
                        "lastEventSequence":if generating { 2 } else { 3 },
                        "attention":null
                    }))
                    .into_response()
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let descriptor = write_companion_descriptor(root.path(), &endpoint);
    let executor = BrowserAutomationExecutor::new(codexify::markdown_chat::AgentAutomationConfig {
        enabled: true,
        descriptor_path: descriptor.display().to_string(),
        ..Default::default()
    });
    let execution = AutomationExecution {
        task_key: "d".repeat(64),
        owner_generation: 0,
        account_fingerprint: "account-1".into(),
        catalog_revision: "catalog-1".into(),
        activity_epoch: "epoch-1".into(),
        activity_sequence: 1,
        tool_call_count_at_start: 1,
        unread_message_ids: vec!["stream-reconnect-message".into()],
        transcript_revision: "revision-1".into(),
        pairing_commit: None,
        request: codexify::agent_automation::ExecuteActionRequest {
            action_id: "stream-reconnect-action".into(),
            idempotency_key: "stream-reconnect-idempotency".into(),
            url: "https://chatgpt.com/c/stream-reconnect".into(),
            pairing_generation: 1,
            connector_name: "Codexify".into(),
            model: "gpt-6-sol".into(),
            effort: "high".into(),
            prompt: ActionPrompt::OfflineChat {
                batch_id: "stream-reconnect-batch".into(),
                messages: vec![codexify::agent_automation::CompanionUnreadMessage {
                    id: "stream-reconnect-message".into(),
                    markdown: "Recover the retained browser stream.".into(),
                }],
            },
            expected_url: "https://chatgpt.com/c/stream-reconnect".into(),
            auto_approve_tool_calls: false,
        },
    };
    let (events_tx, mut events_rx) = mpsc::unbounded_channel();

    let snapshot = executor
        .execute(execution, events_tx, CancellationToken::new())
        .await
        .unwrap();
    let mut kinds = Vec::new();
    while let Ok(event) = events_rx.try_recv() {
        kinds.push(event.kind);
    }

    assert_eq!(snapshot.state, CompanionActionState::Idle);
    assert_eq!(stream_calls.load(Ordering::SeqCst), 2);
    assert_eq!(status_calls.load(Ordering::SeqCst), 2);
    assert!(matches!(
        kinds.last(),
        Some(CompanionEventKind::GenerationComplete {
            final_markdown: Some(markdown),
            ..
        }) if markdown == "Recovered answer"
    ));
    server.abort();
}

#[tokio::test]
async fn real_executor_replays_retained_prefix_from_an_idempotent_generating_receipt() {
    let app = Router::new()
        .route(
            "/v1/health",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "kind":"codexify-browser-companion",
                    "build":COMPANION_BUILD,
                    "status":"idle",
                    "authenticated":true,
                    "accountFingerprint":"account-1",
                    "activeActionId":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/session/capabilities",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "accountFingerprint":"account-1",
                    "catalogRevision":"catalog-1",
                    "models":[{
                        "id":"gpt-6-sol",
                        "label":"GPT-6 Sol",
                        "efforts":[{"id":"high","label":"High","available":true,"reason":null}]
                    }]
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/execute",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "actionId":"generating-replay-action",
                    "state":"generating",
                    "sendAccepted":true,
                    "canonicalUrl":"https://chatgpt.com/c/generating-replay",
                    "selected":{"model":"gpt-6-sol","effort":"high"},
                    "lastEventSequence":2,
                    "attention":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/generating-replay-action/events",
            get(
                |headers: HeaderMap,
                 Query(query): Query<std::collections::HashMap<String, String>>| async move {
                    if !authorized(&headers) {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    let body = if query.get("after").map(String::as_str) == Some("0") {
                        concat!(
                            "{\"sequence\":1,\"actionId\":\"generating-replay-action\",\"atMs\":1,\"type\":\"send_accepted\"}\n",
                            "{\"sequence\":2,\"actionId\":\"generating-replay-action\",\"atMs\":2,\"type\":\"answer_delta\",\"markdown\":\"Retained prefix\",\"continuation\":false}\n",
                            "{\"sequence\":3,\"actionId\":\"generating-replay-action\",\"atMs\":3,\"type\":\"answer_delta\",\"markdown\":\" and suffix\",\"continuation\":true}\n",
                            "{\"sequence\":4,\"actionId\":\"generating-replay-action\",\"atMs\":4,\"type\":\"generation_complete\",\"finalMarkdown\":null,\"canonicalUrl\":\"https://chatgpt.com/c/generating-replay\"}\n"
                        )
                    } else {
                        concat!(
                            "{\"sequence\":3,\"actionId\":\"generating-replay-action\",\"atMs\":3,\"type\":\"answer_delta\",\"markdown\":\" and suffix\",\"continuation\":true}\n",
                            "{\"sequence\":4,\"actionId\":\"generating-replay-action\",\"atMs\":4,\"type\":\"generation_complete\",\"finalMarkdown\":null,\"canonicalUrl\":\"https://chatgpt.com/c/generating-replay\"}\n"
                        )
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/x-ndjson")
                        .body(Body::from(body))
                        .unwrap()
                },
            ),
        )
        .route(
            "/v1/actions/generating-replay-action",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "actionId":"generating-replay-action",
                    "state":"idle",
                    "sendAccepted":true,
                    "canonicalUrl":"https://chatgpt.com/c/generating-replay",
                    "selected":{"model":"gpt-6-sol","effort":"high"},
                    "lastEventSequence":4,
                    "attention":null
                }))
                .into_response()
            }),
        );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let descriptor = write_companion_descriptor(root.path(), &endpoint);
    let executor = BrowserAutomationExecutor::new(codexify::markdown_chat::AgentAutomationConfig {
        enabled: true,
        descriptor_path: descriptor.display().to_string(),
        ..Default::default()
    });
    let execution = AutomationExecution {
        task_key: "f".repeat(64),
        owner_generation: 0,
        account_fingerprint: "account-1".into(),
        catalog_revision: "catalog-1".into(),
        activity_epoch: "epoch-1".into(),
        activity_sequence: 1,
        tool_call_count_at_start: 1,
        unread_message_ids: vec!["generating-replay-message".into()],
        transcript_revision: "revision-1".into(),
        pairing_commit: None,
        request: codexify::agent_automation::ExecuteActionRequest {
            action_id: "generating-replay-action".into(),
            idempotency_key: "generating-replay-idempotency".into(),
            url: "https://chatgpt.com/c/generating-replay".into(),
            pairing_generation: 1,
            connector_name: "Codexify".into(),
            model: "gpt-6-sol".into(),
            effort: "high".into(),
            prompt: ActionPrompt::OfflineChat {
                batch_id: "generating-replay-batch".into(),
                messages: vec![codexify::agent_automation::CompanionUnreadMessage {
                    id: "generating-replay-message".into(),
                    markdown: "Recover an in-progress retained browser stream.".into(),
                }],
            },
            expected_url: "https://chatgpt.com/c/generating-replay".into(),
            auto_approve_tool_calls: false,
        },
    };
    let (events_tx, mut events_rx) = mpsc::unbounded_channel();

    let snapshot = executor
        .execute(execution, events_tx, CancellationToken::new())
        .await
        .unwrap();
    let mut answer = String::new();
    while let Ok(event) = events_rx.try_recv() {
        if let CompanionEventKind::AnswerDelta { markdown, .. } = event.kind {
            answer.push_str(&markdown);
        }
    }

    assert_eq!(snapshot.state, CompanionActionState::Idle);
    assert_eq!(answer, "Retained prefix and suffix");
    server.abort();
}

#[tokio::test]
async fn real_executor_reconnects_retained_events_from_an_idempotent_terminal_receipt() {
    let stream_calls = Arc::new(AtomicUsize::new(0));
    let event_counter = stream_calls.clone();
    let app = Router::new()
        .route(
            "/v1/health",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "kind":"codexify-browser-companion",
                    "build":COMPANION_BUILD,
                    "status":"idle",
                    "authenticated":true,
                    "accountFingerprint":"account-1",
                    "activeActionId":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/session/capabilities",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "accountFingerprint":"account-1",
                    "catalogRevision":"catalog-1",
                    "models":[{
                        "id":"gpt-6-sol",
                        "label":"GPT-6 Sol",
                        "efforts":[{"id":"high","label":"High","available":true,"reason":null}]
                    }]
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/execute",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "actionId":"terminal-replay-action",
                    "state":"idle",
                    "sendAccepted":true,
                    "canonicalUrl":"https://chatgpt.com/c/terminal-replay",
                    "selected":{"model":"gpt-6-sol","effort":"high"},
                    "lastEventSequence":3,
                    "attention":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/terminal-replay-action/events",
            get(move |headers: HeaderMap| {
                let event_counter = event_counter.clone();
                async move {
                    if !authorized(&headers) {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    let call = event_counter.fetch_add(1, Ordering::SeqCst);
                    let body = if call == 0 {
                        concat!(
                            "{\"sequence\":1,\"actionId\":\"terminal-replay-action\",\"atMs\":1,\"type\":\"send_accepted\"}\n",
                            "{\"sequence\":2,\"actionId\":\"terminal-replay-action\",\"atMs\":2,\"type\":\"answer_delta\",\"markdown\":\"Terminal replay answer\",\"continuation\":false}\n",
                            "{\"sequence\":3"
                        )
                    } else {
                        concat!(
                            "{\"sequence\":3,\"actionId\":\"terminal-replay-action\",\"atMs\":3,",
                            "\"type\":\"generation_complete\",\"finalMarkdown\":\"Terminal replay answer\",",
                            "\"canonicalUrl\":\"https://chatgpt.com/c/terminal-replay\"}\n"
                        )
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/x-ndjson")
                        .body(Body::from(body))
                        .unwrap()
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let descriptor = write_companion_descriptor(root.path(), &endpoint);
    let executor = BrowserAutomationExecutor::new(codexify::markdown_chat::AgentAutomationConfig {
        enabled: true,
        descriptor_path: descriptor.display().to_string(),
        ..Default::default()
    });
    let execution = AutomationExecution {
        task_key: "e".repeat(64),
        owner_generation: 0,
        account_fingerprint: "account-1".into(),
        catalog_revision: "catalog-1".into(),
        activity_epoch: "epoch-1".into(),
        activity_sequence: 1,
        tool_call_count_at_start: 1,
        unread_message_ids: vec!["terminal-replay-message".into()],
        transcript_revision: "revision-1".into(),
        pairing_commit: None,
        request: codexify::agent_automation::ExecuteActionRequest {
            action_id: "terminal-replay-action".into(),
            idempotency_key: "terminal-replay-idempotency".into(),
            url: "https://chatgpt.com/c/terminal-replay".into(),
            pairing_generation: 1,
            connector_name: "Codexify".into(),
            model: "gpt-6-sol".into(),
            effort: "high".into(),
            prompt: ActionPrompt::OfflineChat {
                batch_id: "terminal-replay-batch".into(),
                messages: vec![codexify::agent_automation::CompanionUnreadMessage {
                    id: "terminal-replay-message".into(),
                    markdown: "Recover an already completed action.".into(),
                }],
            },
            expected_url: "https://chatgpt.com/c/terminal-replay".into(),
            auto_approve_tool_calls: false,
        },
    };
    let (events_tx, mut events_rx) = mpsc::unbounded_channel();

    let snapshot = executor
        .execute(execution, events_tx, CancellationToken::new())
        .await
        .unwrap();
    let mut kinds = Vec::new();
    while let Ok(event) = events_rx.try_recv() {
        kinds.push(event.kind);
    }

    assert_eq!(snapshot.state, CompanionActionState::Idle);
    assert_eq!(stream_calls.load(Ordering::SeqCst), 2);
    assert!(matches!(
        kinds.last(),
        Some(CompanionEventKind::GenerationComplete {
            final_markdown: Some(markdown),
            ..
        }) if markdown == "Terminal replay answer"
    ));
    server.abort();
}

#[tokio::test]
async fn failed_pre_send_action_is_not_retried_and_chat_remains_usable() {
    let fixture = fixture().await;
    let executor = Arc::new(PreSendFailureExecutor::default());
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        executor.clone(),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "pre-send-failure".into(),
            "Keep this message pending after browser failure.".into(),
        )
        .await
        .unwrap();

    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    assert!(
        supervisor
            .run_next(1_000 + OFFLINE_AFTER_MS + 1)
            .await
            .is_err()
    );
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.store.load(&fixture.task).unwrap().action.status,
        AutomationActionStatus::Failed
    );

    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS + 2)
        .await
        .unwrap();
    assert_eq!(supervisor.queued_count().await, 0);
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
    assert!(
        fixture
            .chat
            .read(false)
            .await
            .unwrap()
            .text
            .contains("Keep this message pending after browser failure.")
    );
    fixture
        .chat
        .append_user("after-failure".into(), "Ordinary chat still works.".into())
        .await
        .unwrap();
    assert!(
        fixture
            .chat
            .read(false)
            .await
            .unwrap()
            .text
            .contains("Ordinary chat still works.")
    );
}

#[tokio::test]
async fn explicit_retry_rearms_only_a_pre_send_failed_action() {
    let fixture = fixture().await;
    let executor = Arc::new(PreSendFailureExecutor::default());
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        executor.clone(),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "retry-pre-send".into(),
            "Retry this only after explicit owner action.".into(),
        )
        .await
        .unwrap();
    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    let failed_action = fixture
        .store
        .load(&fixture.task)
        .unwrap()
        .action
        .id
        .unwrap();
    assert!(
        supervisor
            .run_next(1_000 + OFFLINE_AFTER_MS + 1)
            .await
            .is_err()
    );

    let retried = supervisor
        .retry_failed_action(&fixture.task, &failed_action, 1_000 + OFFLINE_AFTER_MS + 2)
        .await
        .unwrap();
    assert_eq!(retried.status, AutomationActionStatus::Queued);
    assert_ne!(retried.id.as_deref(), Some(failed_action.as_str()));
    assert_eq!(supervisor.queued_count().await, 1);
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn queued_pair_verification_can_be_cancelled_without_replaying_its_reference() {
    let fixture = fixture().await;
    let replacement = fixture
        .store
        .issue_pairing(&fixture.task, "https://chatgpt.com/c/replacement", 0, 1_000)
        .unwrap();
    fixture
        .supervisor
        .queue_pair_verification(
            &fixture.task,
            &replacement.reference,
            replacement.generation,
            1_001,
        )
        .await
        .unwrap();
    let action_id = fixture
        .store
        .load(&fixture.task)
        .unwrap()
        .action
        .id
        .unwrap();

    let cancelled = fixture
        .supervisor
        .cancel_queued_action(&fixture.task, &action_id, 1_002)
        .await
        .unwrap();

    assert_eq!(cancelled.status, AutomationActionStatus::Unpaired);
    assert_eq!(fixture.supervisor.queued_count().await, 0);
    let state = fixture.store.load(&fixture.task).unwrap();
    assert!(state.pairing.candidate_url.is_none());
    assert!(state.pairing.pending.is_none());
    assert_eq!(fixture.executor.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn terminal_failure_after_send_acceptance_is_ambiguous_and_never_retryable() {
    let fixture = fixture().await;
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        Arc::new(AcceptedTerminalFailureExecutor),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "accepted-terminal-failure".into(),
            "Do not replay this message after an accepted failure.".into(),
        )
        .await
        .unwrap();

    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();

    let state = fixture.store.load(&fixture.task).unwrap();
    assert_eq!(state.action.status, AutomationActionStatus::Ambiguous);
    assert_eq!(
        state.chat_mirror.message_ids,
        vec!["accepted-terminal-failure"]
    );
    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS + 2)
        .await
        .unwrap();
    assert_eq!(supervisor.queued_count().await, 0);
    assert!(
        fixture
            .chat
            .read(false)
            .await
            .unwrap()
            .text
            .contains("Do not replay this message")
    );
}

#[tokio::test]
async fn delivered_send_acceptance_outweighs_a_stale_pre_send_error_flag() {
    let fixture = fixture().await;
    let supervisor = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        Arc::new(AcceptedEventThenTransportErrorExecutor),
    );
    supervisor
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "accepted-event-before-error".into(),
            "Do not replay after the event stream proves Send acceptance.".into(),
        )
        .await
        .unwrap();
    supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();

    assert!(
        supervisor
            .run_next(1_000 + OFFLINE_AFTER_MS + 1)
            .await
            .is_err()
    );

    let state = fixture.store.load(&fixture.task).unwrap();
    assert_eq!(state.action.status, AutomationActionStatus::Ambiguous);
    assert_eq!(
        state.chat_mirror.message_ids,
        vec!["accepted-event-before-error"]
    );
}

#[tokio::test]
async fn persisted_in_flight_action_is_not_replayed_after_supervisor_restart() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "restart-message".into(),
            "Do not replay an action whose Send state is uncertain.".into(),
        )
        .await
        .unwrap();
    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    let action_id = fixture
        .store
        .load(&fixture.task)
        .unwrap()
        .action
        .id
        .unwrap();
    fixture
        .store
        .update_action_status(
            &fixture.task,
            &action_id,
            AutomationActionStatus::Navigating,
            None,
            None,
            1_000 + OFFLINE_AFTER_MS + 1,
        )
        .unwrap();

    let restarted_executor = Arc::new(FakeExecutor::default());
    let restarted = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        restarted_executor.clone(),
    );
    restarted
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    restarted
        .scan_once(1_000 + OFFLINE_AFTER_MS + 2)
        .await
        .unwrap();

    assert_eq!(restarted.queued_count().await, 0);
    assert_eq!(restarted_executor.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.store.load(&fixture.task).unwrap().action.status,
        AutomationActionStatus::Navigating
    );
}

#[tokio::test]
async fn persisted_queued_pairing_is_revoked_after_supervisor_restart() {
    let fixture = fixture().await;
    let pairing = fixture
        .store
        .issue_pairing(
            &fixture.task,
            "https://chatgpt.com/c/restart-pairing",
            0,
            1_000,
        )
        .unwrap();
    fixture
        .store
        .queue_action(
            &fixture.task,
            "restart-pairing-action",
            codexify::agent_automation::AutomationActionKind::PairVerify,
            pairing.generation,
            None,
            1_001,
        )
        .unwrap();

    let restarted = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        Arc::new(FakeExecutor::default()),
    );
    restarted
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();

    let state = fixture.store.load(&fixture.task).unwrap();
    assert!(state.pairing.pending.is_none());
    assert_eq!(state.action.status, AutomationActionStatus::Unverified);
    assert_eq!(restarted.queued_count().await, 0);
    assert!(
        fixture
            .store
            .verify_pairing_reference(&fixture.task, 0, &pairing.reference, 1_002)
            .is_err()
    );
}

#[tokio::test]
async fn persisted_queued_chat_without_remaining_work_is_cleared_after_restart() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "restart-consumed-message".into(),
            "Consume me before the queued action can run.".into(),
        )
        .await
        .unwrap();
    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    assert_eq!(fixture.supervisor.queued_count().await, 1);
    fixture.chat.read(true).await.unwrap();

    let restarted = AgentAutomationSupervisor::new(
        fixture.config.markdown_chat.automation.clone(),
        Arc::new(FakeExecutor::default()),
    );
    restarted
        .register_task(AutomationTaskHandle::new(
            fixture.task.clone(),
            0,
            fixture.store.clone(),
            fixture.chat.clone(),
        ))
        .await
        .unwrap();
    restarted
        .scan_once(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap();

    let state = fixture.store.load(&fixture.task).unwrap();
    assert_eq!(state.action.status, AutomationActionStatus::Idle);
    assert!(state.action.id.is_none());
    assert_eq!(restarted.queued_count().await, 0);
}

#[tokio::test]
async fn unread_batches_are_split_without_truncating_messages() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    for index in 0..130 {
        fixture
            .chat
            .append_user(
                format!("split-{index:03}"),
                format!("Message {index:03} must remain intact."),
            )
            .await
            .unwrap();
    }
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::GenerationComplete {
            final_markdown: None,
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    fixture
        .supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();

    {
        let executions = fixture.executor.executions.lock().unwrap();
        let ActionPrompt::OfflineChat { messages, .. } = &executions[0].request.prompt else {
            panic!("expected an offline chat action");
        };
        assert_eq!(messages.len(), 128);
        assert_eq!(messages[0].markdown, "Message 000 must remain intact.");
        assert_eq!(messages[127].markdown, "Message 127 must remain intact.");
    }
    assert_eq!(
        fixture
            .store
            .load(&fixture.task)
            .unwrap()
            .chat_mirror
            .message_ids
            .len(),
        128
    );

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS + 2)
        .await
        .unwrap();
    assert_eq!(fixture.supervisor.queued_count().await, 1);
}

#[tokio::test]
async fn unread_batches_account_for_xml_escaping_before_queueing() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    let escaped_heavy = "<".repeat(40 * 1024);
    for id in ["escaped-first", "escaped-second"] {
        fixture
            .chat
            .append_user(id.into(), escaped_heavy.clone())
            .await
            .unwrap();
    }

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();
    fixture
        .supervisor
        .run_next(1_000 + OFFLINE_AFTER_MS + 1)
        .await
        .unwrap()
        .unwrap();

    let executions = fixture.executor.executions.lock().unwrap();
    let ActionPrompt::OfflineChat { messages, .. } = &executions[0].request.prompt else {
        panic!("expected an offline chat action");
    };
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, "escaped-first");
    assert_eq!(messages[0].markdown, escaped_heavy);
}

#[tokio::test]
async fn one_oversized_unread_message_fails_without_queueing_or_truncation() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    let message = "x".repeat(256 * 1024 + 1);
    fixture
        .chat
        .append_user("oversized-browser-message".into(), message.clone())
        .await
        .unwrap();

    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();

    assert_eq!(fixture.supervisor.queued_count().await, 0);
    let state = fixture.store.load(&fixture.task).unwrap();
    assert_eq!(state.action.status, AutomationActionStatus::Failed);
    assert!(
        state
            .action
            .last_error
            .as_deref()
            .unwrap()
            .contains("too large")
    );
    assert_eq!(
        fixture.chat.unread_snapshot().await.unwrap().messages[0].markdown,
        message
    );
}

#[tokio::test]
async fn stale_priority_action_is_skipped_without_blocking_the_next_ready_action() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "ready-chat".into(),
            "This ready action must still execute.".into(),
        )
        .await
        .unwrap();
    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();

    let pair_task = ConversationIdentity::from_openai_session("stale-pair-task").unwrap();
    let pair_chat = MarkdownChatStore::default()
        .chat(&fixture.config, Some(&pair_task), &SessionState::new())
        .unwrap();
    pair_chat.ensure().await.unwrap();
    fixture
        .store
        .set_selection(
            &pair_task,
            "gpt-6-sol",
            "high",
            "catalog-1",
            "account-1",
            100,
        )
        .unwrap();
    let pairing = fixture
        .store
        .issue_pairing(&pair_task, "https://chatgpt.com/c/stale-pair", 0, 100)
        .unwrap();
    fixture
        .supervisor
        .register_task(AutomationTaskHandle::new(
            pair_task.clone(),
            0,
            fixture.store.clone(),
            pair_chat,
        ))
        .await
        .unwrap();
    fixture
        .supervisor
        .queue_pair_verification(&pair_task, &pairing.reference, pairing.generation, 101)
        .await
        .unwrap();
    fixture
        .store
        .issue_pairing(&pair_task, "https://chatgpt.com/c/replacement-pair", 0, 102)
        .unwrap();
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::GenerationComplete {
            final_markdown: None,
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);

    assert!(
        fixture
            .supervisor
            .run_next(1_000 + OFFLINE_AFTER_MS + 1)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(fixture.executor.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.supervisor.queued_count().await, 0);
    let executions = fixture.executor.executions.lock().unwrap();
    assert!(matches!(
        executions[0].request.prompt,
        ActionPrompt::OfflineChat { .. }
    ));
}

#[tokio::test]
async fn real_executor_rejects_a_different_canonical_conversation_for_every_prompt_kind() {
    let app = Router::new()
        .route(
            "/v1/health",
            get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "kind":"codexify-browser-companion",
                    "build":COMPANION_BUILD,
                    "status":"idle",
                    "authenticated":true,
                    "accountFingerprint":"account-1",
                    "activeActionId":null
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/session/capabilities",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "accountFingerprint":"account-1",
                    "catalogRevision":"catalog-1",
                    "models":[{"id":"gpt-6-sol","label":"GPT-6 Sol","efforts":[{"id":"high","label":"High","available":true,"reason":null}]}]
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/actions/execute",
            post(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({
                    "protocolVersion":codexify::agent_automation::PROTOCOL_VERSION,
                    "build":COMPANION_BUILD,
                    "actionId":"canonical-check",
                    "state":"idle",
                    "sendAccepted":true,
                    "canonicalUrl":"https://chatgpt.com/c/different-conversation",
                    "selected":{"model":"gpt-6-sol","effort":"high"},
                    "lastEventSequence":0,
                    "attention":null
                }))
                .into_response()
            }),
        );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let descriptor = write_companion_descriptor(root.path(), &endpoint);
    let config = codexify::markdown_chat::AgentAutomationConfig {
        enabled: true,
        descriptor_path: descriptor.display().to_string(),
        ..Default::default()
    };
    let executor = BrowserAutomationExecutor::new(config);
    for (prompt, unread_message_ids) in [
        (
            ActionPrompt::OfflineChat {
                batch_id: "canonical-batch".into(),
                messages: vec![codexify::agent_automation::CompanionUnreadMessage {
                    id: "canonical-message".into(),
                    markdown: "Check the canonical URL.".into(),
                }],
            },
            vec!["canonical-message".into()],
        ),
        (
            ActionPrompt::PairVerify {
                reference: "A".repeat(43),
            },
            Vec::new(),
        ),
    ] {
        let execution = AutomationExecution {
            task_key: "b".repeat(64),
            owner_generation: 0,
            account_fingerprint: "account-1".into(),
            catalog_revision: "catalog-1".into(),
            activity_epoch: "epoch-1".into(),
            activity_sequence: 1,
            tool_call_count_at_start: 1,
            unread_message_ids,
            transcript_revision: "revision-1".into(),
            pairing_commit: None,
            request: codexify::agent_automation::ExecuteActionRequest {
                action_id: "canonical-check".into(),
                idempotency_key: "canonical-idempotency".into(),
                url: "https://chatgpt.com/c/expected-conversation".into(),
                pairing_generation: 1,
                connector_name: "Codexify".into(),
                model: "gpt-6-sol".into(),
                effort: "high".into(),
                prompt,
                expected_url: "https://chatgpt.com/c/expected-conversation".into(),
                auto_approve_tool_calls: false,
            },
        };
        let (events, _) = mpsc::unbounded_channel();

        let error = executor
            .execute(execution, events, CancellationToken::new())
            .await
            .err()
            .unwrap();

        assert!(error.send_accepted);
        assert!(error.message.contains("conversation"));
    }
    server.abort();
}

#[tokio::test]
async fn explicit_pair_verification_outranks_pending_offline_chat() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1_000).await.unwrap();
    fixture
        .chat
        .append_user(
            "lower-priority-chat".into(),
            "This can wait for pairing.".into(),
        )
        .await
        .unwrap();
    fixture
        .supervisor
        .scan_once(1_000 + OFFLINE_AFTER_MS)
        .await
        .unwrap();

    let pair_task = ConversationIdentity::from_openai_session("pair-priority-task").unwrap();
    let pair_chat = MarkdownChatStore::default()
        .chat(&fixture.config, Some(&pair_task), &SessionState::new())
        .unwrap();
    pair_chat.ensure().await.unwrap();
    fixture
        .store
        .set_selection(
            &pair_task,
            "gpt-6-sol",
            "high",
            "catalog-1",
            "account-1",
            100,
        )
        .unwrap();
    let pairing = fixture
        .store
        .issue_pairing(&pair_task, "https://chatgpt.com/c/pair-priority", 0, 100)
        .unwrap();
    fixture
        .supervisor
        .register_task(AutomationTaskHandle::new(
            pair_task.clone(),
            0,
            fixture.store.clone(),
            pair_chat,
        ))
        .await
        .unwrap();

    fixture
        .supervisor
        .queue_pair_verification(&pair_task, &pairing.reference, pairing.generation, 101)
        .await
        .unwrap();

    assert_eq!(fixture.supervisor.queued_count().await, 2);
    assert_eq!(
        fixture.supervisor.next_queued_kind().await,
        Some(codexify::agent_automation::AutomationActionKind::PairVerify)
    );
    let state = fixture.store.load(&pair_task).unwrap();
    assert_eq!(
        state.action.kind,
        Some(codexify::agent_automation::AutomationActionKind::PairVerify)
    );
    assert_eq!(state.action.status, AutomationActionStatus::Queued);
}

#[tokio::test]
async fn pair_verification_records_canonical_url_without_polluting_chat() {
    let fixture = fixture().await;
    let pair_task = ConversationIdentity::from_openai_session("pair-execution-task").unwrap();
    let pair_chat = MarkdownChatStore::default()
        .chat(&fixture.config, Some(&pair_task), &SessionState::new())
        .unwrap();
    pair_chat.ensure().await.unwrap();
    fixture
        .store
        .set_selection(
            &pair_task,
            "gpt-6-sol",
            "high",
            "catalog-1",
            "account-1",
            100,
        )
        .unwrap();
    let pairing = fixture
        .store
        .issue_pairing(&pair_task, "https://chatgpt.com/c/pair-execution", 0, 100)
        .unwrap();
    fixture
        .supervisor
        .register_task(AutomationTaskHandle::new(
            pair_task.clone(),
            0,
            fixture.store.clone(),
            pair_chat.clone(),
        ))
        .await
        .unwrap();
    fixture
        .executor
        .events
        .lock()
        .unwrap()
        .push(CompanionEventKind::GenerationComplete {
            final_markdown: Some("Pairing setup response.".into()),
            canonical_url: Some("https://chatgpt.com/c/pair-execution".into()),
        });
    fixture
        .supervisor
        .queue_pair_verification(&pair_task, &pairing.reference, pairing.generation, 101)
        .await
        .unwrap();

    fixture.supervisor.run_next(102).await.unwrap().unwrap();

    let state = fixture.store.load(&pair_task).unwrap();
    assert_eq!(
        state.pairing.canonical_url.as_deref(),
        Some("https://chatgpt.com/c/pair-execution")
    );
    assert!(state.pairing.verified_owner_generation.is_none());
    assert_eq!(state.action.status, AutomationActionStatus::Unverified);
    assert!(
        pair_chat
            .clean_markdown_transcript()
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn pair_verification_may_finish_before_the_browser_response_settles() {
    let fixture = fixture().await;
    let pair_task = ConversationIdentity::from_openai_session("pair-tool-race-task").unwrap();
    let pair_chat = MarkdownChatStore::default()
        .chat(&fixture.config, Some(&pair_task), &SessionState::new())
        .unwrap();
    pair_chat.ensure().await.unwrap();
    fixture
        .store
        .set_selection(
            &pair_task,
            "gpt-6-sol",
            "high",
            "catalog-1",
            "account-1",
            100,
        )
        .unwrap();
    let pairing = fixture
        .store
        .issue_pairing(&pair_task, "https://chatgpt.com/c/pair-tool-race", 0, 100)
        .unwrap();
    let executor = Arc::new(PairVerifyingExecutor {
        store: fixture.store.clone(),
        task: pair_task.clone(),
        generation: pairing.generation,
        reference: pairing.reference.clone(),
    });
    let supervisor =
        AgentAutomationSupervisor::new(fixture.config.markdown_chat.automation.clone(), executor);
    supervisor
        .register_task(AutomationTaskHandle::new(
            pair_task.clone(),
            0,
            fixture.store.clone(),
            pair_chat,
        ))
        .await
        .unwrap();
    supervisor
        .queue_pair_verification(&pair_task, &pairing.reference, pairing.generation, 101)
        .await
        .unwrap();

    supervisor.run_next(104).await.unwrap().unwrap();

    let state = fixture.store.load(&pair_task).unwrap();
    assert_eq!(state.pairing.verified_owner_generation, Some(0));
    assert_eq!(state.action.status, AutomationActionStatus::Idle);
}

#[tokio::test]
async fn failed_pair_turn_revokes_a_pairing_verified_before_terminal_reconciliation() {
    let fixture = fixture().await;
    let pair_task = ConversationIdentity::from_openai_session("pair-failed-after-tool").unwrap();
    let pair_chat = MarkdownChatStore::default()
        .chat(&fixture.config, Some(&pair_task), &SessionState::new())
        .unwrap();
    pair_chat.ensure().await.unwrap();
    fixture
        .store
        .set_selection(
            &pair_task,
            "gpt-6-sol",
            "high",
            "catalog-1",
            "account-1",
            100,
        )
        .unwrap();
    let pairing = fixture
        .store
        .issue_pairing(
            &pair_task,
            "https://chatgpt.com/c/pair-failed-after-tool",
            0,
            100,
        )
        .unwrap();
    let executor = Arc::new(PairVerifyingFailureExecutor {
        store: fixture.store.clone(),
        task: pair_task.clone(),
        generation: pairing.generation,
        reference: pairing.reference.clone(),
    });
    let supervisor =
        AgentAutomationSupervisor::new(fixture.config.markdown_chat.automation.clone(), executor);
    supervisor
        .register_task(AutomationTaskHandle::new(
            pair_task.clone(),
            0,
            fixture.store.clone(),
            pair_chat,
        ))
        .await
        .unwrap();
    supervisor
        .queue_pair_verification(&pair_task, &pairing.reference, pairing.generation, 101)
        .await
        .unwrap();

    assert!(supervisor.run_next(104).await.is_err());

    let state = fixture.store.load(&pair_task).unwrap();
    assert!(state.pairing.pending.is_none());
    assert!(state.pairing.verified_owner_generation.is_none());
    assert!(state.pairing.verified_at_ms.is_none());
}

#[tokio::test]
async fn background_worker_scans_notified_tasks_and_runs_the_global_queue() {
    let fixture = fixture().await;
    fixture.chat.record_agent_call(1).await.unwrap();
    fixture
        .chat
        .append_user(
            "worker-message".into(),
            "Wake the background worker.".into(),
        )
        .await
        .unwrap();
    fixture.executor.events.lock().unwrap().extend([
        CompanionEventKind::SendAccepted,
        CompanionEventKind::GenerationComplete {
            final_markdown: None,
            canonical_url: Some("https://chatgpt.com/c/example".into()),
        },
    ]);
    let worker = fixture.supervisor.start();
    fixture.supervisor.notify();

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while fixture.executor.calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    assert_eq!(fixture.executor.calls.load(Ordering::SeqCst), 1);
    drop(worker);
}
