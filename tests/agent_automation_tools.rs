use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use codexify::agent_automation::{AgentAutomationStore, GoalStatus, PAIRING_REFERENCE_TTL_MS};
use codexify::config::default_config;
use codexify::exec_sessions::SessionState;
use codexify::markdown_chat::MarkdownChatStore;
use codexify::project_bindings::ConversationIdentity;
use codexify::tool::{Tool, ToolRequestContext};
use codexify::tools::automation_pair::AutomationVerifyPairing;
use codexify::tools::get_agent_brief::GetAgentBrief;
use codexify::tools::goal::GoalTool;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

struct Fixture {
    _root: tempfile::TempDir,
    config: codexify::types::AppConfig,
    session: SessionState,
    task: ConversationIdentity,
    automation: Arc<AgentAutomationStore>,
    context: ToolRequestContext,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn fixture(name: &str) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let mut config = default_config(root.path().to_path_buf());
    config.memory.dir = Some(root.path().join("metadata").display().to_string());
    config.markdown_chat.enabled = true;
    config.markdown_chat.automation.enabled = true;
    let task = ConversationIdentity::from_openai_session(name).unwrap();
    let automation =
        Arc::new(AgentAutomationStore::new(root.path().join("metadata/chats")).unwrap());
    let context = context(
        root.path(),
        Some(task.clone()),
        Some(task.clone()),
        Some(0),
        Some(automation.clone()),
    );
    Fixture {
        _root: root,
        config,
        session: SessionState::new(),
        task,
        automation,
        context,
    }
}

fn context(
    root: &std::path::Path,
    conversation: Option<ConversationIdentity>,
    task_conversation: Option<ConversationIdentity>,
    task_owner_generation: Option<u64>,
    agent_automation: Option<Arc<AgentAutomationStore>>,
) -> ToolRequestContext {
    ToolRequestContext {
        conversation,
        task_conversation,
        task_owner_generation,
        conversation_retired: false,
        connector_schema_version: None,
        conversation_schema_version: None,
        conversation_authorizations: Arc::new(
            codexify::conversation_auth::ConversationAuthorizationStore::new(),
        ),
        project_bindings: Arc::new(codexify::project_bindings::ProjectBindingStore::new(
            root.join("bindings"),
        )),
        diff_checkpoints: Arc::new(codexify::diff::DiffCheckpointManager::new()),
        artifact_egress: Arc::new(codexify::artifact_egress::ArtifactEgressStore::new_at(
            codexify::types::ArtifactEgressConfig::default(),
            root.join("artifacts"),
        )),
        markdown_chat: Arc::new(MarkdownChatStore::default()),
        agent_automation,
        cancellation: CancellationToken::new(),
    }
}

fn payload(result: &codexify::types::ToolResult) -> &Value {
    result.structured_content.as_ref().unwrap()
}

#[test]
fn tool_contracts_are_closed_bounded_and_classified() {
    let pair = AutomationVerifyPairing;
    let read = GoalTool::Read;
    let finish = GoalTool::Finish;

    assert!(!pair.behavior().read_only);
    assert!(read.behavior().read_only);
    assert!(!finish.behavior().read_only);
    assert_eq!(
        pair.input_schema()["properties"]["reference"]["minLength"],
        43
    );
    assert_eq!(
        pair.input_schema()["properties"]["reference"]["maxLength"],
        43
    );
    assert_eq!(
        pair.input_schema()["properties"]["reference"]["writeOnly"],
        true
    );
    for tool in [&pair as &dyn Tool, &read, &finish] {
        assert_eq!(tool.input_schema()["additionalProperties"], false);
        let output = tool
            .output_schema()
            .expect("automation tools declare output schemas");
        assert_eq!(output["type"], "object");
        assert_eq!(output["additionalProperties"], false);
        jsonschema::validator_for(&tool.input_schema()).unwrap();
        jsonschema::validator_for(&output).unwrap();
    }
}

#[tokio::test]
async fn disabled_automation_returns_an_explicit_error_without_state_access() {
    let mut fixture = fixture("disabled");
    fixture.config.markdown_chat.automation.enabled = false;
    fixture.context.agent_automation = None;

    for (tool, args) in [
        (&GoalTool::Read as &dyn Tool, json!({})),
        (
            &GoalTool::Finish as &dyn Tool,
            json!({"expectedRevision":1,"status":"completed"}),
        ),
        (
            &AutomationVerifyPairing as &dyn Tool,
            json!({"reference":"a".repeat(43)}),
        ),
    ] {
        let result = tool
            .call_with_context(args, &fixture.config, &fixture.session, &fixture.context)
            .await;
        assert!(result.is_error);
        assert!(result.joined_text().contains("disabled"));
    }
}

#[tokio::test]
async fn automation_tools_require_physical_and_stable_task_identity() {
    let fixture = fixture("missing-context");
    let missing = context(
        fixture._root.path(),
        None,
        None,
        None,
        Some(fixture.automation.clone()),
    );

    for (tool, args) in [
        (&GoalTool::Read as &dyn Tool, json!({})),
        (
            &GoalTool::Finish as &dyn Tool,
            json!({"expectedRevision":1,"status":"completed"}),
        ),
        (
            &AutomationVerifyPairing as &dyn Tool,
            json!({"reference":"a".repeat(43)}),
        ),
    ] {
        let result = tool
            .call_with_context(args, &fixture.config, &fixture.session, &missing)
            .await;
        assert!(result.is_error);
        assert!(result.joined_text().contains("stable ChatGPT conversation"));
    }
}

#[tokio::test]
async fn goal_read_and_finish_use_the_exact_stable_task_revision() {
    let fixture = fixture("goal-success");
    let goal = fixture
        .automation
        .set_goal(&fixture.task, "Ship the browser fallback", 1000)
        .unwrap();
    fixture
        .automation
        .run_goal(&fixture.task, goal.revision, 1001)
        .unwrap();

    let read = GoalTool::Read
        .call_with_context(
            json!({}),
            &fixture.config,
            &fixture.session,
            &fixture.context,
        )
        .await;
    assert!(!read.is_error, "{}", read.joined_text());
    assert_eq!(payload(&read)["status"], "active");
    assert_eq!(payload(&read)["revision"], goal.revision);
    assert_eq!(payload(&read)["markdown"], "Ship the browser fallback");
    assert_eq!(payload(&read)["terminal"], false);

    let finish_args = json!({
        "expectedRevision": goal.revision,
        "status": "completed",
        "summary": "Implemented and verified"
    });
    let finished = GoalTool::Finish
        .call_with_context(
            finish_args.clone(),
            &fixture.config,
            &fixture.session,
            &fixture.context,
        )
        .await;
    assert!(!finished.is_error, "{}", finished.joined_text());
    assert_eq!(payload(&finished)["status"], "completed");
    assert_eq!(payload(&finished)["summary"], "Implemented and verified");
    assert_eq!(payload(&finished)["terminal"], true);

    let replay = GoalTool::Finish
        .call_with_context(
            finish_args,
            &fixture.config,
            &fixture.session,
            &fixture.context,
        )
        .await;
    assert!(!replay.is_error, "{}", replay.joined_text());
    assert_eq!(payload(&replay), payload(&finished));

    let stale = GoalTool::Finish
        .call_with_context(
            json!({"expectedRevision":goal.revision + 1,"status":"completed"}),
            &fixture.config,
            &fixture.session,
            &fixture.context,
        )
        .await;
    assert!(stale.is_error);
    assert_eq!(
        fixture
            .automation
            .load(&fixture.task)
            .unwrap()
            .goal
            .unwrap()
            .status,
        GoalStatus::Completed
    );
}

#[tokio::test]
async fn blocked_goal_requires_a_concrete_reason() {
    let fixture = fixture("goal-blocked");
    let goal = fixture
        .automation
        .set_goal(&fixture.task, "Wait for unavailable hardware", 1000)
        .unwrap();
    fixture
        .automation
        .run_goal(&fixture.task, goal.revision, 1001)
        .unwrap();

    for args in [
        json!({"expectedRevision":goal.revision,"status":"blocked"}),
        json!({"expectedRevision":goal.revision,"status":"blocked","reason":"   "}),
    ] {
        let result = GoalTool::Finish
            .call_with_context(args, &fixture.config, &fixture.session, &fixture.context)
            .await;
        assert!(result.is_error);
        assert!(result.joined_text().contains("concrete reason"));
    }

    let blocked = GoalTool::Finish
        .call_with_context(
            json!({
                "expectedRevision":goal.revision,
                "status":"blocked",
                "reason":"The required device is not connected"
            }),
            &fixture.config,
            &fixture.session,
            &fixture.context,
        )
        .await;
    assert!(!blocked.is_error, "{}", blocked.joined_text());
    assert_eq!(payload(&blocked)["status"], "blocked");
    assert_eq!(
        payload(&blocked)["blockedReason"],
        "The required device is not connected"
    );
    assert_eq!(payload(&blocked)["terminal"], true);
}

#[tokio::test]
async fn pairing_verification_consumes_the_reference_and_discloses_no_private_values() {
    let fixture = fixture("pair-success");
    let issued = fixture
        .automation
        .issue_pairing(
            &fixture.task,
            "https://chatgpt.com/c/private-id",
            0,
            now_ms(),
        )
        .unwrap();
    fixture
        .automation
        .record_pairing_canonical_url(
            &fixture.task,
            issued.generation,
            "https://chatgpt.com/c/private-id",
            now_ms(),
        )
        .unwrap();

    let verified = AutomationVerifyPairing
        .call_with_context(
            json!({"reference":issued.reference}),
            &fixture.config,
            &fixture.session,
            &fixture.context,
        )
        .await;
    assert!(!verified.is_error, "{}", verified.joined_text());
    assert_eq!(payload(&verified)["verified"], true);
    assert_eq!(payload(&verified)["pairingGeneration"], issued.generation);
    let visible = format!("{} {}", verified.joined_text(), payload(&verified));
    assert!(!visible.contains("private-id"));

    let state = fixture.automation.load(&fixture.task).unwrap();
    assert_eq!(state.pairing.verified_owner_generation, Some(0));
    assert!(state.pairing.pending.is_none());

    let replay = AutomationVerifyPairing
        .call_with_context(
            json!({"reference":issued.reference}),
            &fixture.config,
            &fixture.session,
            &fixture.context,
        )
        .await;
    assert!(replay.is_error);
}

#[tokio::test]
async fn pairing_mismatch_consumes_the_intended_tasks_pending_reference() {
    let fixture = fixture("pair-owner");
    let issued = fixture
        .automation
        .issue_pairing(&fixture.task, "https://chatgpt.com/c/owner", 0, now_ms())
        .unwrap();
    fixture
        .automation
        .record_pairing_canonical_url(
            &fixture.task,
            issued.generation,
            "https://chatgpt.com/c/owner",
            now_ms(),
        )
        .unwrap();
    let other = ConversationIdentity::from_openai_session("pair-other").unwrap();
    let wrong_context = context(
        fixture._root.path(),
        Some(other.clone()),
        Some(other),
        Some(0),
        Some(fixture.automation.clone()),
    );

    let mismatch = AutomationVerifyPairing
        .call_with_context(
            json!({"reference":issued.reference}),
            &fixture.config,
            &fixture.session,
            &wrong_context,
        )
        .await;
    assert!(mismatch.is_error);
    assert!(
        fixture
            .automation
            .load(&fixture.task)
            .unwrap()
            .pairing
            .pending
            .is_none()
    );

    let retry = AutomationVerifyPairing
        .call_with_context(
            json!({"reference":issued.reference}),
            &fixture.config,
            &fixture.session,
            &fixture.context,
        )
        .await;
    assert!(retry.is_error);
}

#[tokio::test]
async fn pairing_mismatch_across_project_state_roots_consumes_the_reference() {
    let root = tempfile::tempdir().unwrap();
    let index = root.path().join("global-pairings");
    let owner_store = Arc::new(
        AgentAutomationStore::new_with_pairing_index(
            root.path().join("owner/chats"),
            index.clone(),
        )
        .unwrap(),
    );
    let other_store = Arc::new(
        AgentAutomationStore::new_with_pairing_index(root.path().join("other/chats"), index)
            .unwrap(),
    );
    let owner = ConversationIdentity::from_openai_session("cross-root-owner").unwrap();
    let other = ConversationIdentity::from_openai_session("cross-root-other").unwrap();
    let issued = owner_store
        .issue_pairing(&owner, "https://chatgpt.com/c/cross-root", 0, now_ms())
        .unwrap();
    owner_store
        .record_pairing_canonical_url(
            &owner,
            issued.generation,
            "https://chatgpt.com/c/cross-root",
            now_ms(),
        )
        .unwrap();
    let mut config = default_config(root.path().to_path_buf());
    config.markdown_chat.enabled = true;
    config.markdown_chat.automation.enabled = true;
    let wrong_context = context(
        root.path(),
        Some(other.clone()),
        Some(other),
        Some(0),
        Some(other_store),
    );

    let mismatch = AutomationVerifyPairing
        .call_with_context(
            json!({"reference":issued.reference}),
            &config,
            &SessionState::new(),
            &wrong_context,
        )
        .await;

    assert!(mismatch.is_error);
    assert!(owner_store.load(&owner).unwrap().pairing.pending.is_none());
}

#[tokio::test]
async fn expired_pairing_reference_is_consumed() {
    let fixture = fixture("pair-expired");
    let current = now_ms();
    let issued_at = current.saturating_sub(PAIRING_REFERENCE_TTL_MS + 10);
    let issued = fixture
        .automation
        .issue_pairing(&fixture.task, "https://chatgpt.com/c/expired", 0, issued_at)
        .unwrap();
    fixture
        .automation
        .record_pairing_canonical_url(
            &fixture.task,
            issued.generation,
            "https://chatgpt.com/c/expired",
            issued_at + 1,
        )
        .unwrap();

    let result = AutomationVerifyPairing
        .call_with_context(
            json!({"reference":issued.reference}),
            &fixture.config,
            &fixture.session,
            &fixture.context,
        )
        .await;
    assert!(result.is_error);
    assert!(
        fixture
            .automation
            .load(&fixture.task)
            .unwrap()
            .pairing
            .pending
            .is_none()
    );
}

#[tokio::test]
async fn changed_owner_generation_invalidates_and_consumes_pairing() {
    let fixture = fixture("pair-owner-generation");
    let issued = fixture
        .automation
        .issue_pairing(
            &fixture.task,
            "https://chatgpt.com/c/owner-generation",
            3,
            now_ms(),
        )
        .unwrap();
    fixture
        .automation
        .record_pairing_canonical_url(
            &fixture.task,
            issued.generation,
            "https://chatgpt.com/c/owner-generation",
            now_ms(),
        )
        .unwrap();
    let wrong_generation = context(
        fixture._root.path(),
        Some(fixture.task.clone()),
        Some(fixture.task.clone()),
        Some(4),
        Some(fixture.automation.clone()),
    );

    let result = AutomationVerifyPairing
        .call_with_context(
            json!({"reference":issued.reference}),
            &fixture.config,
            &fixture.session,
            &wrong_generation,
        )
        .await;

    assert!(result.is_error);
    let pairing = fixture.automation.load(&fixture.task).unwrap().pairing;
    assert!(pairing.pending.is_none());
    assert!(pairing.verified_owner_generation.is_none());
}

#[tokio::test]
async fn active_goal_adds_browser_specific_guidance_to_the_agent_brief() {
    let fixture = fixture("brief-goal");
    let configured = fixture
        .automation
        .set_goal(&fixture.task, "Complete the active revision", 1000)
        .unwrap();

    let inactive = GetAgentBrief
        .call_with_context(
            json!({}),
            &fixture.config,
            &fixture.session,
            &fixture.context,
        )
        .await;
    assert!(!inactive.joined_text().contains("## Active agent-chat goal"));

    fixture
        .automation
        .run_goal(&fixture.task, configured.revision, 1001)
        .unwrap();
    let active = GetAgentBrief
        .call_with_context(
            json!({}),
            &fixture.config,
            &fixture.session,
            &fixture.context,
        )
        .await;
    let text = active.joined_text();
    assert!(text.contains("## Active agent-chat goal"));
    assert!(text.contains("goal_read"));
    assert!(text.contains("goal_finish"));
    assert!(text.contains("exact current revision"));
    assert!(text.contains("concrete reason"));
    assert!(text.contains("Do not request a separate turn"));
    assert!(!text.contains("Complete the active revision"));
}
