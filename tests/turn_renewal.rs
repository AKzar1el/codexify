use async_trait::async_trait;
use codexify::agent_automation::turn_renewal::{TurnRenewalConfig, TurnSend};
use codexify::{
    agent_automation::*, config::default_config, exec_sessions::SessionState,
    markdown_chat::MarkdownChatStore, project_bindings::ConversationIdentity,
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Executor {
    complete: AtomicBool,
    accepted_at_ms: AtomicU64,
    sent: Mutex<Vec<AutomationExecution>>,
    fail: AtomicBool,
    ambiguous: AtomicBool,
}
#[async_trait]
impl AutomationExecutor for Executor {
    async fn turn_handoff_complete(&self, _: &str, _: &str, _: &str) -> Result<bool, String> {
        Ok(self.complete.load(Ordering::SeqCst))
    }
    async fn execute(
        &self,
        e: AutomationExecution,
        events: mpsc::UnboundedSender<CompanionEvent>,
        _: CancellationToken,
    ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
        self.sent.lock().unwrap().push(e.clone());
        if self.fail.load(Ordering::SeqCst) {
            return Err(AutomationExecutionError {
                message: "No send".into(),
                send_accepted: self.ambiguous.load(Ordering::SeqCst),
            });
        }
        events
            .send(CompanionEvent {
                sequence: 1,
                action_id: e.request.action_id.clone(),
                at_ms: 90_000,
                kind: CompanionEventKind::ModelVerified {
                    model: "gpt-5.6-sol".into(),
                    effort: "max".into(),
                },
            })
            .unwrap();
        events
            .send(CompanionEvent {
                sequence: 2,
                action_id: e.request.action_id.clone(),
                at_ms: match self.accepted_at_ms.load(Ordering::SeqCst) {
                    0 => 100_000,
                    at => at,
                },
                kind: CompanionEventKind::SendAccepted,
            })
            .unwrap();
        Ok(serde_json::from_value(serde_json::json!({"protocolVersion":1,"build":format!("test{}",PROTOCOL_BUILD_SUFFIX),"actionId":e.request.action_id,"state":"idle","sendAccepted":true,"canonicalUrl":e.request.url,"selected":{"model":"gpt-5.6-sol","effort":"max"},"lastEventSequence":2,"attention":null})).unwrap())
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    config: codexify::types::AppConfig,
    task: ConversationIdentity,
    chat: Arc<codexify::markdown_chat::ChatFile>,
    store: Arc<AgentAutomationStore>,
    supervisor: Arc<AgentAutomationSupervisor>,
    executor: Arc<Executor>,
}
async fn fixture(enabled: bool) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let mut config = default_config(project);
    config.memory.dir = Some(root.path().join("state").display().to_string());
    config.markdown_chat.enabled = true;
    config.markdown_chat.automation.enabled = true;
    config.markdown_chat.turn_renewal.enabled = enabled;
    let task = ConversationIdentity::from_openai_session("renewal-test").unwrap();
    let chat = MarkdownChatStore::default()
        .chat(&config, Some(&task), &SessionState::new())
        .unwrap();
    chat.ensure().await.unwrap();
    let store = Arc::new(AgentAutomationStore::for_config(&config).unwrap());
    store
        .set_selection(&task, "gpt-6-astra", "max", "catalog", "account", 100)
        .unwrap();
    let pair = store
        .issue_pairing(&task, "https://chatgpt.com/c/renewal", 0, 100)
        .unwrap();
    store
        .record_pairing_canonical_url(&task, pair.generation, "https://chatgpt.com/c/renewal", 101)
        .unwrap();
    store
        .verify_pairing(&task, pair.generation, 0, &pair.reference, 102)
        .unwrap();
    let executor = Arc::new(Executor::default());
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
    let pair = store.load(&task).unwrap().pairing.generation;
    store
        .queue_action(
            &task,
            "original",
            AutomationActionKind::OfflineChat,
            pair,
            None,
            1000,
        )
        .unwrap();
    store
        .record_turn_send(
            &task,
            TurnSend {
                action_id: "original".into(),
                at_ms: 1000,
                model: Some("gpt-6-astra".into()),
                effort: Some("max".into()),
                pairing_generation: pair,
                owner_generation: 0,
            },
        )
        .unwrap();
    store
        .update_action_status(
            &task,
            "original",
            AutomationActionStatus::Idle,
            None,
            None,
            1000,
        )
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
const DUE: u64 = 1000 + 55 * 60_000;
fn wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[test]
fn opt_in_defaults_and_strict_model_limits() {
    let mut c = TurnRenewalConfig::default();
    assert!(!c.enabled);
    assert_eq!(c.minutes(Some("gpt-5.6-sol"), Some("max")), 115);
    assert_eq!(c.minutes(Some("gpt-6-astra"), Some("max")), 55);
    assert_eq!(c.minutes(Some("gpt-5.6-sol"), Some("high")), 55);
    assert_eq!(c.minutes(Some("new-model"), Some("max")), 55);
    c.limits[0].minutes = 50;
    assert_eq!(c.minutes(Some("gpt-6-astra"), Some("max")), 50);
    assert!(c.validate().is_ok());
    c.limits.push(c.limits[0].clone());
    assert!(c.validate().is_err());
    c.limits.pop();
    c.limits[0].minutes = 0;
    assert!(c.validate().is_err());
}
#[tokio::test]
async fn exact_deadline_and_restart_keep_first_actual_send() {
    let f = fixture(true).await;
    assert!(
        f.store
            .turn_renewal_notice(&f.task, DUE - 1)
            .unwrap()
            .is_none()
    );
    let note = f.store.turn_renewal_notice(&f.task, DUE).unwrap().unwrap();
    assert!(note.contains("FINAL CHATGPT"));
    assert!(note.contains("Do not use chat_write"));
    let original = f.store.load(&f.task).unwrap();
    let mut duplicate = original.turn_renewal.send.clone().unwrap();
    duplicate.at_ms = DUE + 10;
    f.store.record_turn_send(&f.task, duplicate).unwrap();
    let reopened = AgentAutomationStore::for_config(&f.config).unwrap();
    assert_eq!(
        reopened.load(&f.task).unwrap().turn_renewal,
        original.turn_renewal
    );
    assert_eq!(
        reopened
            .turn_renewal_notice(&f.task, DUE + 50)
            .unwrap()
            .unwrap(),
        note
    );
}
#[tokio::test]
async fn no_goal_renewal_waits_for_final_report_and_sends_once_without_queue() {
    let f = fixture(true).await;
    f.chat
        .queue_user_message("queued".into(), "Private next request".into(), Vec::new())
        .await
        .unwrap();
    f.store.turn_renewal_notice(&f.task, DUE).unwrap();
    assert!(
        f.chat
            .release_queued_message(DUE + 10_000)
            .await
            .unwrap()
            .is_none()
    );
    f.supervisor.scan_once(DUE + 10_000).await.unwrap();
    assert_eq!(f.supervisor.queued_count().await, 0);
    f.executor.complete.store(true, Ordering::SeqCst);
    f.supervisor.scan_once(DUE + 11_000).await.unwrap();
    assert_eq!(f.supervisor.queued_count().await, 1);
    f.supervisor.run_next(DUE + 11_000).await.unwrap();
    let sent = f.executor.sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert!(matches!(
        sent[0].request.prompt,
        ActionPrompt::TurnRenewal { .. }
    ));
    assert!(sent[0].unread_message_ids.is_empty());
    drop(sent);
    assert!(
        f.store
            .load(&f.task)
            .unwrap()
            .turn_renewal
            .handoff
            .is_none()
    );
    let send = f.store.load(&f.task).unwrap().turn_renewal.send.unwrap();
    assert_eq!(send.at_ms, 100_000);
    assert_eq!(send.model.as_deref(), Some("gpt-5.6-sol"));
    assert!(
        f.store
            .turn_renewal_notice(&f.task, 100_000 + 55 * 60_000)
            .unwrap()
            .is_none()
    );
    // Pro fallback gets 115 minutes even though the saved preference is Astra.
    assert!(
        f.store
            .turn_renewal_notice(&f.task, 100_000 + 115 * 60_000)
            .unwrap()
            .is_some()
    );
}
#[tokio::test]
async fn active_goal_and_queue_survive_handoff() {
    let f = fixture(true).await;
    let goal = f.store.set_goal(&f.task, "Keep working", 1000).unwrap();
    f.store.run_goal(&f.task, goal.revision, 1000).unwrap();
    f.store.turn_renewal_notice(&f.task, DUE).unwrap();
    f.executor.complete.store(true, Ordering::SeqCst);
    f.supervisor.scan_once(DUE + 10_000).await.unwrap();
    f.supervisor.run_next(DUE + 10_000).await.unwrap();
    let now = f.store.load(&f.task).unwrap();
    assert_eq!(now.goal.as_ref().unwrap().revision, goal.revision);
    assert_eq!(now.goal.as_ref().unwrap().status, GoalStatus::Active);
}
#[tokio::test]
async fn feature_disabled_never_nudges_and_stop_prevents_continuation() {
    let f = fixture(false).await;
    assert!(
        f.store
            .turn_renewal_notice(&f.task, u64::MAX)
            .unwrap()
            .is_none()
    );
    let f = fixture(true).await;
    f.store.turn_renewal_notice(&f.task, DUE).unwrap();
    f.chat.request_agent_stop("stop".into()).await.unwrap();
    f.executor.complete.store(true, Ordering::SeqCst);
    f.supervisor.scan_once(DUE + 10_000).await.unwrap();
    assert_eq!(f.supervisor.queued_count().await, 0);
    assert!(
        f.store
            .load(&f.task)
            .unwrap()
            .turn_renewal
            .handoff
            .is_none()
    );
}
#[tokio::test]
async fn ambiguous_continuation_never_replays() {
    let f = fixture(true).await;
    f.store.turn_renewal_notice(&f.task, DUE).unwrap();
    f.executor.complete.store(true, Ordering::SeqCst);
    f.executor.fail.store(true, Ordering::SeqCst);
    f.executor.ambiguous.store(true, Ordering::SeqCst);
    f.supervisor.scan_once(DUE + 10_000).await.unwrap();
    let _ = f.supervisor.run_next(DUE + 10_000).await;
    f.supervisor.scan_once(DUE + 1_000_000).await.unwrap();
    assert_eq!(f.supervisor.queued_count().await, 0);
    assert_eq!(f.executor.sent.lock().unwrap().len(), 1);
    assert!(
        f.store
            .load(&f.task)
            .unwrap()
            .turn_renewal
            .handoff
            .is_some()
    );
}

#[tokio::test]
async fn hot_settings_disable_pending_handoff_without_restart() {
    let f = fixture(true).await;
    let path = f._root.path().join("config.json");
    std::fs::write(
        &path,
        r#"{"agentChat":{"rolloutEnabled":false,"turnRenewal":{"enabled":true}}}"#,
    )
    .unwrap();
    let mut config = f.config.clone();
    config.loaded_config_path = Some(path.clone());
    let store = Arc::new(AgentAutomationStore::for_config(&config).unwrap());
    assert!(!codexify::global_settings::rollout_enabled(&config).unwrap());
    assert!(store.turn_renewal_notice(&f.task, DUE).unwrap().is_some());
    let supervisor =
        AgentAutomationSupervisor::new(config.markdown_chat.automation.clone(), f.executor.clone());
    supervisor
        .register_task(AutomationTaskHandle::new(
            f.task.clone(),
            0,
            store.clone(),
            f.chat.clone(),
        ))
        .await
        .unwrap();
    std::fs::write(
        &path,
        r#"{"agentChat":{"rolloutEnabled":true,"turnRenewal":{"enabled":false}}}"#,
    )
    .unwrap();
    assert!(codexify::global_settings::rollout_enabled(&config).unwrap());
    f.executor.complete.store(true, Ordering::SeqCst);
    supervisor.scan_once(DUE + 10_000).await.unwrap();
    assert_eq!(supervisor.queued_count().await, 0);
    assert!(store.load(&f.task).unwrap().turn_renewal.handoff.is_none());
}

#[tokio::test]
async fn pending_handoff_resumes_after_restart_without_a_queue_file() {
    let f = fixture(true).await;
    assert!(!f.chat.path().with_file_name("message-queue.json").exists());
    f.store.turn_renewal_notice(&f.task, DUE).unwrap();
    let restarted = AgentAutomationSupervisor::new(
        f.config.markdown_chat.automation.clone(),
        f.executor.clone(),
    );
    let store = Arc::new(AgentAutomationStore::for_config(&f.config).unwrap());
    restarted
        .register_task(AutomationTaskHandle::new(
            f.task.clone(),
            0,
            store,
            f.chat.clone(),
        ))
        .await
        .unwrap();
    f.executor.complete.store(true, Ordering::SeqCst);
    restarted.scan_once(DUE + 10_000).await.unwrap();
    assert_eq!(restarted.queued_count().await, 1);
    restarted.run_next(DUE + 10_000).await.unwrap();
    assert_eq!(f.executor.sent.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn completed_handoff_supersedes_old_browser_error_but_pausing_goal_cancels_renewal() {
    let f = fixture(true).await;
    f.store.turn_renewal_notice(&f.task, DUE).unwrap();
    f.store
        .update_action_status(
            &f.task,
            "original",
            AutomationActionStatus::Ambiguous,
            Some("Old interface error"),
            None,
            DUE,
        )
        .unwrap();
    f.executor.complete.store(true, Ordering::SeqCst);
    f.supervisor.scan_once(DUE + 10_000).await.unwrap();
    assert_eq!(
        f.supervisor.next_queued_kind().await,
        Some(AutomationActionKind::TurnRenewal)
    );
    f.supervisor.run_next(DUE + 10_000).await.unwrap();
    assert_eq!(f.executor.sent.lock().unwrap().len(), 1);
    let f = fixture(true).await;
    let g = f.store.set_goal(&f.task, "Work", 1000).unwrap();
    f.store.run_goal(&f.task, g.revision, 1000).unwrap();
    f.store.turn_renewal_notice(&f.task, DUE).unwrap();
    f.store.stop_goal(&f.task, g.revision, DUE + 1).unwrap();
    f.executor.complete.store(true, Ordering::SeqCst);
    f.supervisor.scan_once(DUE + 10_000).await.unwrap();
    assert_eq!(f.supervisor.queued_count().await, 0);
}
#[tokio::test]
async fn unlisted_or_unavailable_selection_uses_fifty_five_minutes() {
    let f = fixture(true).await;
    let pair = f.store.load(&f.task).unwrap().pairing.generation;
    f.store
        .queue_action(
            &f.task,
            "unknown-selection",
            AutomationActionKind::OfflineChat,
            pair,
            None,
            1000,
        )
        .unwrap();
    f.store
        .record_turn_send(
            &f.task,
            TurnSend {
                action_id: "unknown-selection".into(),
                at_ms: 1000,
                model: None,
                effort: None,
                pairing_generation: pair,
                owner_generation: 0,
            },
        )
        .unwrap();
    f.store
        .update_action_status(
            &f.task,
            "unknown-selection",
            AutomationActionStatus::Idle,
            None,
            None,
            1000,
        )
        .unwrap();
    assert!(
        f.store
            .turn_renewal_notice(&f.task, DUE - 1)
            .unwrap()
            .is_none()
    );
    assert!(f.store.turn_renewal_notice(&f.task, DUE).unwrap().is_some());
}

#[tokio::test]
async fn native_activity_after_verified_handoff_clears_uncertain_receipt_and_late_errors() {
    let f = fixture(true).await;
    f.store.turn_renewal_notice(&f.task, DUE).unwrap();
    f.executor.complete.store(true, Ordering::SeqCst);
    f.executor.fail.store(true, Ordering::SeqCst);
    f.executor.ambiguous.store(true, Ordering::SeqCst);
    f.supervisor.scan_once(DUE + 10_000).await.unwrap();
    let _ = f.supervisor.run_next(DUE + 10_000).await;
    let state = f.store.load(&f.task).unwrap();
    let at = state.action.updated_at_ms.unwrap() + 1;
    assert!(f.store.record_turn_activity(&f.task, 0, at).unwrap());
    let id = state.action.id.unwrap();
    let state = f.store.load(&f.task).unwrap();
    assert!(state.turn_renewal.handoff.is_none());
    assert_eq!(state.action.status, AutomationActionStatus::Idle);
    assert_eq!(state.action.send_accepted, Some(true));
    f.store
        .update_action_status(
            &f.task,
            &id,
            AutomationActionStatus::Ambiguous,
            Some("Late browser error"),
            None,
            at + 1,
        )
        .unwrap();
    assert!(f.store.load(&f.task).unwrap().action.last_error.is_none());
    let before = f.store.load(&f.task).unwrap();
    f.store
        .record_turn_send(
            &f.task,
            TurnSend {
                action_id: id,
                at_ms: at - 10,
                model: Some("gpt-5.6-sol".into()),
                effort: Some("max".into()),
                pairing_generation: before.pairing.generation,
                owner_generation: 0,
            },
        )
        .unwrap();
    let confirmed = f.store.load(&f.task).unwrap().turn_renewal.send.unwrap();
    assert_eq!(confirmed.at_ms, at - 10);
    assert_eq!(confirmed.model.as_deref(), Some("gpt-5.6-sol"));
    assert!(
        f.store
            .turn_renewal_notice(&f.task, at + 55 * 60_000)
            .unwrap()
            .is_none()
    );
    assert!(
        f.store
            .turn_renewal_notice(&f.task, at + 1)
            .unwrap()
            .is_none()
    );
}
#[tokio::test]
async fn first_native_call_releases_continuation_grace_for_normal_completion() {
    let f = fixture(true).await;
    f.executor.accepted_at_ms.store(wall_ms(), Ordering::SeqCst);
    f.store.turn_renewal_notice(&f.task, DUE).unwrap();
    f.chat
        .queue_user_message(
            "after-renewal".into(),
            "Private later request".into(),
            vec![],
        )
        .await
        .unwrap();
    f.executor.complete.store(true, Ordering::SeqCst);
    f.supervisor.scan_once(DUE + 10_000).await.unwrap();
    f.supervisor.run_next(DUE + 10_000).await.unwrap();
    assert!(
        f.store
            .load(&f.task)
            .unwrap()
            .turn_renewal
            .resume_wait_until_ms
            .is_some()
    );
    let now = wall_ms();
    f.chat.record_agent_call(now).await.unwrap();
    f.store.record_turn_activity(&f.task, 0, now).unwrap();
    assert!(
        f.store
            .load(&f.task)
            .unwrap()
            .turn_renewal
            .resume_wait_until_ms
            .is_none()
    );
    assert!(f.chat.queue_turn_completed().await.unwrap());
    assert_eq!(
        f.chat
            .release_queued_message(now)
            .await
            .unwrap()
            .unwrap()
            .id,
        "after-renewal"
    );
}

#[tokio::test]
async fn stalled_goal_renewal_retries_after_three_minutes_only_with_fresh_report_proof() {
    let f = fixture(true).await;
    let goal = f.store.set_goal(&f.task, "Keep working", 1000).unwrap();
    f.store.run_goal(&f.task, goal.revision, 1000).unwrap();
    f.store.turn_renewal_notice(&f.task, DUE).unwrap();
    f.executor.complete.store(true, Ordering::SeqCst);
    f.executor.fail.store(true, Ordering::SeqCst);
    f.executor.ambiguous.store(true, Ordering::SeqCst);
    f.supervisor.scan_once(DUE + 10_000).await.unwrap();
    let _ = f.supervisor.run_next(DUE + 10_000).await;
    let failed_at = f.store.load(&f.task).unwrap().action.updated_at_ms.unwrap();
    f.supervisor
        .scan_once(failed_at + 180_000 - 1)
        .await
        .unwrap();
    assert_eq!(f.supervisor.queued_count().await, 0);
    f.executor.complete.store(false, Ordering::SeqCst);
    f.supervisor.scan_once(failed_at + 180_000).await.unwrap();
    assert_eq!(f.supervisor.queued_count().await, 0);
    f.executor.complete.store(true, Ordering::SeqCst);
    f.supervisor.scan_once(failed_at + 180_001).await.unwrap();
    assert_eq!(
        f.supervisor.next_queued_kind().await,
        Some(AutomationActionKind::TurnRenewal)
    );
    f.executor.fail.store(false, Ordering::SeqCst);
    f.supervisor.run_next(failed_at + 180_001).await.unwrap();
    assert_eq!(f.executor.sent.lock().unwrap().len(), 2);
    assert!(
        f.store
            .load(&f.task)
            .unwrap()
            .turn_renewal
            .handoff
            .is_none()
    );
}
