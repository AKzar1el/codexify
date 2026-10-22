use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use codexify::agent_automation::{
    ActionPrompt, BrowserCompanionClient, CancelActionReceipt, CapabilityCatalog,
    CompanionActionSnapshot, CompanionActionState, CompanionEvent, CompanionEventKind,
    CompanionHealth, CompanionSessionStatus, CompanionUnreadMessage, ExecuteActionRequest,
    PROTOCOL_BUILD_SUFFIX, PROTOCOL_SCHEMA_HASH, RevealWindowReceipt, RevealWindowRequest,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

const FIXTURE_START_TIMEOUT: Duration = Duration::from_secs(60);

struct FixtureProcess {
    child: Child,
    descriptor: PathBuf,
}

impl Drop for FixtureProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.descriptor);
    }
}

fn bun_path() -> PathBuf {
    std::env::var_os("CODEXIFY_TEST_BROWSER_COMPANION_BUN")
        .map(PathBuf::from)
        .expect("CODEXIFY_TEST_BROWSER_COMPANION_BUN must name the Bun executable")
}

fn start_fixture(root: &Path) -> FixtureProcess {
    start_fixture_mode(root, "immediate")
}

fn start_fixture_mode(root: &Path, mode: &str) -> FixtureProcess {
    let descriptor = root.join("browser/descriptor.json");
    let child = Command::new(bun_path())
        .arg("browser-companion/tests/fixture-server.ts")
        .arg(&descriptor)
        .arg(format!("contract-build{PROTOCOL_BUILD_SUFFIX}"))
        .arg(mode)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start TypeScript browser companion fixture");
    let mut fixture = FixtureProcess { child, descriptor };
    let deadline = Instant::now() + FIXTURE_START_TIMEOUT;
    loop {
        if fixture.descriptor.is_file() {
            break;
        }
        if let Some(status) = fixture.child.try_wait().unwrap() {
            panic!("browser companion fixture exited before publishing its descriptor: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "browser companion descriptor was not published"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    fixture
}

fn contract_request(action_id: &str, idempotency_key: &str) -> ExecuteActionRequest {
    ExecuteActionRequest {
        action_id: action_id.into(),
        idempotency_key: idempotency_key.into(),
        url: "https://chatgpt.com/c/contract".into(),
        pairing_generation: 7,
        connector_name: "Codexify".into(),
        expected_account_fingerprint: "contract-account".into(),
        model: Some("gpt-6-sol".into()),
        effort: Some("high".into()),
        prompt: ActionPrompt::OfflineCombined {
            batch_id: "contract-batch".into(),
            messages: vec![CompanionUnreadMessage {
                id: "contract-message".into(),
                markdown: "Preserve <data> & Markdown.".into(),
            }],
            goal_revision: 3,
        },
        expected_url: "https://chatgpt.com/c/contract".into(),
        auto_approve_tool_calls: false,
        bypass_conversation_cooldown: false,
    }
}

fn private_write(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}

fn golden_fixture() -> Value {
    serde_json::from_slice(include_bytes!(
        "../browser-companion/protocol-fixtures/v1.json"
    ))
    .unwrap()
}

#[test]
fn protocol_schema_hash_matches_the_checked_in_contract() {
    let digest = format!(
        "{:x}",
        Sha256::digest(include_bytes!(
            "../browser-companion/protocol-schema-v1.json"
        ))
    );
    assert_eq!(digest, PROTOCOL_SCHEMA_HASH);
    let fixture = golden_fixture();
    assert_eq!(fixture["schemaHash"], PROTOCOL_SCHEMA_HASH);
    assert_eq!(
        fixture["build"].as_str().unwrap(),
        format!("fixture{PROTOCOL_BUILD_SUFFIX}")
    );
}

#[test]
fn rust_shapes_match_every_golden_protocol_fixture() {
    let fixture = golden_fixture();
    let _: CompanionHealth = serde_json::from_value(fixture["health"].clone()).unwrap();
    let _: CapabilityCatalog = serde_json::from_value(fixture["capabilities"].clone()).unwrap();
    let reveal = RevealWindowRequest {
        url: Some("https://chatgpt.com/c/fixture".into()),
    };
    assert_eq!(
        serde_json::to_value(reveal).unwrap(),
        fixture["revealRequest"]
    );
    let _: RevealWindowReceipt = serde_json::from_value(fixture["revealReceipt"].clone()).unwrap();

    let base = |action_id: &str, idempotency_key: &str, prompt| ExecuteActionRequest {
        action_id: action_id.into(),
        idempotency_key: idempotency_key.into(),
        url: "https://chatgpt.com/c/fixture".into(),
        pairing_generation: 7,
        connector_name: "Codexify".into(),
        expected_account_fingerprint: "fixture-account".into(),
        model: (!matches!(&prompt, ActionPrompt::PairVerify { .. })).then(|| "gpt-6-sol".into()),
        effort: (!matches!(&prompt, ActionPrompt::PairVerify { .. })).then(|| "high".into()),
        prompt,
        expected_url: "https://chatgpt.com/c/fixture".into(),
        auto_approve_tool_calls: false,
        bypass_conversation_cooldown: false,
    };
    let requests = vec![
        base(
            "fixture-pair",
            "fixture-pair-execute",
            ActionPrompt::PairVerify {
                reference: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            },
        ),
        base(
            "fixture-chat",
            "fixture-chat-execute",
            ActionPrompt::OfflineChat {
                batch_id: "fixture-batch".into(),
                messages: vec![CompanionUnreadMessage {
                    id: "fixture-message".into(),
                    markdown: "Preserve <data> & Markdown.".into(),
                }],
            },
        ),
        base(
            "fixture-goal",
            "fixture-goal-execute",
            ActionPrompt::OfflineGoal { goal_revision: 3 },
        ),
        base(
            "fixture-action",
            "fixture-execute",
            ActionPrompt::OfflineCombined {
                batch_id: "fixture-batch".into(),
                messages: vec![CompanionUnreadMessage {
                    id: "fixture-message".into(),
                    markdown: "Preserve <data> & Markdown.".into(),
                }],
                goal_revision: 3,
            },
        ),
    ];
    let mut requests = requests;
    requests.push(base(
        "fixture-renewal",
        "fixture-renewal-execute",
        ActionPrompt::TurnRenewal {
            handoff_id: format!("renew-{}", "a".repeat(64)),
        },
    ));
    assert_eq!(
        serde_json::to_value(requests).unwrap(),
        fixture["executeRequests"]
    );

    let _: CompanionActionSnapshot =
        serde_json::from_value(fixture["actionSnapshot"].clone()).unwrap();
    let _: CancelActionReceipt = serde_json::from_value(fixture["cancelReceipt"].clone()).unwrap();
    for event in fixture["events"].as_array().unwrap() {
        let _: CompanionEvent = serde_json::from_value(event.clone()).unwrap();
    }
}

#[tokio::test]
#[ignore = "requires CODEXIFY_TEST_BROWSER_COMPANION_BUN; exercised explicitly by CI"]
async fn rust_client_round_trips_the_real_typescript_protocol() {
    let root = tempfile::tempdir().unwrap();
    let fixture = start_fixture(root.path());
    let client = BrowserCompanionClient::from_descriptor_path_with_timeouts(
        &fixture.descriptor,
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    let cancellation = CancellationToken::new();

    let health = client.health(&cancellation).await.unwrap();
    assert_eq!(health.status, CompanionSessionStatus::Idle);
    assert!(health.authenticated);
    assert_eq!(
        health.account_fingerprint.as_deref(),
        Some("contract-account")
    );
    assert_eq!(health.active_action_id, None);

    let login = client.login(&cancellation).await.unwrap();
    assert_eq!(login.status, CompanionSessionStatus::Idle);
    let catalog = client.capabilities(&cancellation).await.unwrap();
    assert_eq!(catalog.catalog_revision, "contract-catalog");
    assert_eq!(catalog.models[0].id, "gpt-6-sol");
    assert_eq!(catalog.models[0].efforts[0].id, "high");

    let revealed = client
        .reveal(
            &RevealWindowRequest {
                url: Some("https://chatgpt.com/c/contract".into()),
            },
            &cancellation,
        )
        .await
        .unwrap();
    assert!(revealed.revealed);
    assert!(revealed.active_action_id.is_none());

    let mut pairing_request = contract_request("model-free-pair", "model-free-pair-execute");
    pairing_request.model = None;
    pairing_request.effort = None;
    pairing_request.prompt = ActionPrompt::PairVerify {
        reference: "A".repeat(43),
    };
    client
        .execute(&pairing_request, &cancellation)
        .await
        .unwrap();
    client
        .stream_action_events(&pairing_request.action_id, 0, &cancellation, |_| Ok(()))
        .await
        .unwrap();
    let paired_snapshot = client
        .action(&pairing_request.action_id, &cancellation)
        .await
        .unwrap();
    assert!(paired_snapshot.send_accepted);
    assert!(paired_snapshot.selected.is_none());

    let request = contract_request("contract-action", "contract-execute");
    let accepted = client.execute(&request, &cancellation).await.unwrap();
    assert_eq!(accepted.action_id, request.action_id);
    assert!(matches!(
        accepted.state,
        CompanionActionState::Queued
            | CompanionActionState::Navigating
            | CompanionActionState::Sending
            | CompanionActionState::Generating
            | CompanionActionState::Idle
    ));

    let mut events = Vec::new();
    client
        .stream_action_events(&request.action_id, 0, &cancellation, |event| {
            events.push(event);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        (1..=events.len() as u64).collect::<Vec<_>>()
    );
    assert!(matches!(events[0].kind, CompanionEventKind::Queued));
    assert!(events.iter().any(|event| matches!(
        event.kind,
        CompanionEventKind::StatusDelta { ref text, .. } if text == "Working"
    )));
    assert!(events.iter().any(|event| matches!(
        event.kind,
        CompanionEventKind::CommentaryDelta { ref markdown, .. }
            if markdown == "Visible commentary"
    )));
    assert!(events.iter().any(|event| matches!(
        event.kind,
        CompanionEventKind::AnswerDelta { ref markdown, .. }
            if markdown == "Contract answer"
    )));
    assert!(matches!(
        events.last().unwrap().kind,
        CompanionEventKind::GenerationComplete {
            final_markdown: Some(ref markdown),
            canonical_url: Some(ref url),
        } if markdown == "Contract answer" && url == "https://chatgpt.com/c/contract"
    ));

    let settled = client
        .action(&request.action_id, &cancellation)
        .await
        .unwrap();
    assert_eq!(settled.state, CompanionActionState::Idle);
    assert!(settled.send_accepted);
    assert_eq!(
        settled.canonical_url.as_deref(),
        Some("https://chatgpt.com/c/contract")
    );
    assert_eq!(settled.selected.as_ref().unwrap().model, "gpt-6-sol");
    assert_eq!(settled.selected.as_ref().unwrap().effort, "high");
    let replay = client.execute(&request, &cancellation).await.unwrap();
    assert_eq!(replay.last_event_sequence, settled.last_event_sequence);

    let descriptor: Value =
        serde_json::from_slice(&fs::read(&fixture.descriptor).unwrap()).unwrap();
    let mismatched_path = fixture.descriptor.with_file_name("mismatched.json");
    let mut mismatched = descriptor;
    mismatched["build"] = Value::String(format!("wrong-build{PROTOCOL_BUILD_SUFFIX}"));
    private_write(
        &mismatched_path,
        serde_json::to_string(&mismatched).unwrap().as_bytes(),
    );
    let mismatched_client = BrowserCompanionClient::from_descriptor_path_with_timeouts(
        &mismatched_path,
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(
        mismatched_client
            .health(&cancellation)
            .await
            .unwrap_err()
            .contains("build does not match")
    );
}

#[tokio::test]
#[ignore = "requires CODEXIFY_TEST_BROWSER_COMPANION_BUN; exercised explicitly by CI"]
async fn rust_client_cancels_an_accepted_typescript_action_without_replay() {
    let root = tempfile::tempdir().unwrap();
    let fixture = start_fixture_mode(root.path(), "blocking");
    let client = BrowserCompanionClient::from_descriptor_path_with_timeouts(
        &fixture.descriptor,
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    let cancellation = CancellationToken::new();
    let request = contract_request("contract-cancel", "contract-cancel-execute");

    client.execute(&request, &cancellation).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = client
            .action(&request.action_id, &cancellation)
            .await
            .unwrap();
        if snapshot.send_accepted {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "fixture never accepted the browser Send"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let first = client
        .cancel(&request.action_id, "contract-cancel-request", &cancellation)
        .await
        .unwrap();
    assert!(first.cancelled);
    assert_eq!(first.state, CompanionActionState::Ambiguous);
    let repeated = client
        .cancel(&request.action_id, "contract-cancel-request", &cancellation)
        .await
        .unwrap();
    assert_eq!(repeated, first);

    let mut events = Vec::new();
    client
        .stream_action_events(&request.action_id, 0, &cancellation, |event| {
            events.push(event);
            Ok(())
        })
        .await
        .unwrap();
    assert!(matches!(
        events.last().unwrap().kind,
        CompanionEventKind::AmbiguousSend { .. }
    ));
    let settled = client
        .action(&request.action_id, &cancellation)
        .await
        .unwrap();
    assert_eq!(settled.state, CompanionActionState::Ambiguous);
    let replay = client.execute(&request, &cancellation).await.unwrap();
    assert_eq!(replay.state, CompanionActionState::Ambiguous);
    assert_eq!(replay.last_event_sequence, settled.last_event_sequence);
}

#[tokio::test]
#[ignore = "requires CODEXIFY_TEST_BROWSER_COMPANION_BUN; exercised explicitly by CI"]
async fn companion_restart_republishes_the_descriptor_without_inventing_old_action_state() {
    let root = tempfile::tempdir().unwrap();
    let descriptor = root.path().join("browser/descriptor.json");
    {
        let fixture = start_fixture(root.path());
        let client = BrowserCompanionClient::from_descriptor_path_with_timeouts(
            &fixture.descriptor,
            Duration::from_secs(5),
            Duration::from_secs(5),
        )
        .unwrap();
        let cancellation = CancellationToken::new();
        let request = contract_request("restart-action", "restart-execute");
        client.execute(&request, &cancellation).await.unwrap();
        client
            .stream_action_events(&request.action_id, 0, &cancellation, |_| Ok(()))
            .await
            .unwrap();
        assert_eq!(
            client
                .action(&request.action_id, &cancellation)
                .await
                .unwrap()
                .state,
            CompanionActionState::Idle
        );
    }
    assert!(!descriptor.exists());

    let restarted = start_fixture(root.path());
    let client = BrowserCompanionClient::from_descriptor_path_with_timeouts(
        &restarted.descriptor,
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    let cancellation = CancellationToken::new();
    assert_eq!(
        client.health(&cancellation).await.unwrap().status,
        CompanionSessionStatus::Idle
    );
    let error = client
        .action("restart-action", &cancellation)
        .await
        .err()
        .expect("a restarted companion must not invent previous in-memory action state");
    assert!(error.contains("unavailable"), "{error}");
}
