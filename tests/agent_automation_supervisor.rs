use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use axum::Router;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use codexify::agent_automation::{
    ActionPrompt, AgentAutomationStore, AgentAutomationSupervisor, AutomationActionStatus,
    AutomationExecution, AutomationExecutionError, AutomationExecutor, AutomationTaskHandle,
    BrowserAutomationExecutor, CompanionActionSnapshot, CompanionActionState, CompanionEvent,
    CompanionEventKind,
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
const COMPANION_BUILD: &str = "supervisor-fake-build";

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

struct AmbiguousExecutor;

struct PreSendFailureExecutor {
    calls: AtomicUsize,
}

struct AcceptedTerminalFailureExecutor;

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

struct StreamingExecutor {
    started: Arc<Notify>,
    release: Arc<Notify>,
}

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
    let (events, _) = mpsc::unbounded_channel();

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
async fn real_executor_rejects_a_different_canonical_conversation_after_send() {
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
    let execution = AutomationExecution {
        task_key: "b".repeat(64),
        owner_generation: 0,
        account_fingerprint: "account-1".into(),
        catalog_revision: "catalog-1".into(),
        activity_epoch: "epoch-1".into(),
        activity_sequence: 1,
        tool_call_count_at_start: 1,
        unread_message_ids: vec!["canonical-message".into()],
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
            prompt: ActionPrompt::OfflineChat {
                batch_id: "canonical-batch".into(),
                messages: vec![codexify::agent_automation::CompanionUnreadMessage {
                    id: "canonical-message".into(),
                    markdown: "Check the canonical URL.".into(),
                }],
            },
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
