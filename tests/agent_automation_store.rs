use std::sync::{Arc, Barrier};

use codexify::agent_automation::{
    AgentAutomationStore, AutomationActionKind, AutomationActionStatus, GoalFinish, GoalStatus,
    PAIRING_REFERENCE_TTL_MS,
};
use codexify::project_bindings::ConversationIdentity;

fn task(name: &str) -> ConversationIdentity {
    ConversationIdentity::from_openai_session(name).unwrap()
}

#[test]
fn goal_state_round_trips_with_private_storage() {
    let root = tempfile::tempdir().unwrap();
    let state_root = root.path().join("automation");
    let store = AgentAutomationStore::new(state_root.clone()).unwrap();
    let task = task("goal-round-trip");

    let configured = store
        .set_goal(&task, "Ship the browser fallback", 10)
        .unwrap();
    assert_eq!(configured.revision, 1);
    assert_eq!(configured.status, GoalStatus::Configured);
    let active = store.run_goal(&task, configured.revision, 20).unwrap();
    assert_eq!(active.status, GoalStatus::Active);

    let reloaded = AgentAutomationStore::new(state_root).unwrap();
    let state = reloaded.load(&task).unwrap();
    let goal = state.goal.unwrap();
    assert_eq!(goal.markdown, "Ship the browser fallback");
    assert_eq!(goal.revision, 1);
    assert_eq!(goal.status, GoalStatus::Active);

    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let directory = reloaded.task_directory(&task).unwrap();
        assert_eq!(
            std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let path = directory.join("automation.json");
        let metadata = std::fs::metadata(path).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    }
}

#[test]
fn goals_are_bounded_revisioned_and_have_no_pause_state() {
    let root = tempfile::tempdir().unwrap();
    let store = AgentAutomationStore::new(root.path().join("automation")).unwrap();
    let task = task("goal-lifecycle");

    assert!(store.set_goal(&task, &"x".repeat(10 * 1024), 1).is_ok());
    assert!(
        store
            .set_goal(&task, &"x".repeat(10 * 1024 + 1), 2)
            .is_err()
    );
    let replacement = store.set_goal(&task, "replacement", 3).unwrap();
    assert_eq!(replacement.revision, 2);
    assert_eq!(replacement.status, GoalStatus::Configured);
    assert!(store.run_goal(&task, 1, 4).is_err());
    assert_eq!(
        store
            .run_goal(&task, replacement.revision, 4)
            .unwrap()
            .status,
        GoalStatus::Active
    );
    assert!(store.clear_goal(&task, replacement.revision).is_err());
    assert_eq!(
        store
            .stop_goal(&task, replacement.revision, 5)
            .unwrap()
            .status,
        GoalStatus::Configured
    );
    store.clear_goal(&task, replacement.revision).unwrap();
    assert!(store.load(&task).unwrap().goal.is_none());

    let serialized = serde_json::to_string(&store.load(&task).unwrap()).unwrap();
    assert!(!serialized.contains("pause"));
    assert!(!serialized.contains("resume"));
}

#[test]
fn finishing_requires_the_exact_active_revision_and_a_blocked_reason() {
    let root = tempfile::tempdir().unwrap();
    let store = AgentAutomationStore::new(root.path().join("automation")).unwrap();
    let task = task("goal-finish");
    let goal = store.set_goal(&task, "Complete me", 1).unwrap();
    store.run_goal(&task, goal.revision, 2).unwrap();

    assert!(
        store
            .finish_goal(
                &task,
                goal.revision + 1,
                GoalFinish::Completed { summary: None },
                3
            )
            .is_err()
    );
    assert!(
        store
            .finish_goal(
                &task,
                goal.revision,
                GoalFinish::Blocked {
                    reason: "  ".into()
                },
                3
            )
            .is_err()
    );
    let blocked = store
        .finish_goal(
            &task,
            goal.revision,
            GoalFinish::Blocked {
                reason: "Waiting for the user to approve a tool action".into(),
            },
            4,
        )
        .unwrap();
    assert_eq!(blocked.status, GoalStatus::Blocked);
    assert_eq!(
        blocked.blocked_reason.as_deref(),
        Some("Waiting for the user to approve a tool action")
    );
    assert!(
        store
            .finish_goal(
                &task,
                goal.revision,
                GoalFinish::Completed { summary: None },
                5
            )
            .is_err()
    );
}

#[test]
fn pairing_references_are_random_digest_only_expiring_and_single_use() {
    let root = tempfile::tempdir().unwrap();
    let state_root = root.path().join("automation");
    let store = AgentAutomationStore::new(state_root.clone()).unwrap();
    let task = task("pairing");

    let first = store
        .issue_pairing(&task, "https://chatgpt.com/c/first", 7, 1_000)
        .unwrap();
    let second = store
        .issue_pairing(&task, "https://chatgpt.com/c/second", 7, 2_000)
        .unwrap();
    assert_ne!(first.reference, second.reference);
    assert_eq!(second.generation, first.generation + 1);

    let bytes =
        std::fs::read_to_string(store.task_directory(&task).unwrap().join("automation.json"))
            .unwrap();
    assert!(!bytes.contains(&first.reference));
    assert!(!bytes.contains(&second.reference));
    assert!(bytes.contains("referenceDigest"));

    store
        .record_pairing_canonical_url(
            &task,
            second.generation,
            "https://chatgpt.com/c/canonical",
            2_100,
        )
        .unwrap();
    let verified = store
        .verify_pairing(&task, second.generation, 7, &second.reference, 2_200)
        .unwrap();
    assert_eq!(
        verified.canonical_url.as_deref(),
        Some("https://chatgpt.com/c/canonical")
    );
    assert_eq!(verified.verified_owner_generation, Some(7));
    assert!(
        store
            .verify_pairing(&task, second.generation, 7, &second.reference, 2_300)
            .is_err()
    );

    let expired = store
        .issue_pairing(&task, "https://chatgpt.com/c/expired", 8, 10_000)
        .unwrap();
    assert!(
        store
            .verify_pairing(
                &task,
                expired.generation,
                8,
                &expired.reference,
                10_000 + PAIRING_REFERENCE_TTL_MS + 1,
            )
            .is_err()
    );
    assert!(store.load(&task).unwrap().pairing.pending.is_none());
}

#[test]
fn pairing_urls_discard_noncanonical_query_data_before_persistence() {
    let root = tempfile::tempdir().unwrap();
    let store = AgentAutomationStore::new(root.path().join("automation")).unwrap();
    let task = task("pairing-query");

    let pairing = store
        .issue_pairing(
            &task,
            "https://chatgpt.com/c/query-example?temporary-chat=false&source=sidebar",
            0,
            1_000,
        )
        .unwrap();
    assert_eq!(
        store.load(&task).unwrap().pairing.candidate_url.as_deref(),
        Some("https://chatgpt.com/c/query-example")
    );

    let recorded = store
        .record_pairing_canonical_url(
            &task,
            pairing.generation,
            "https://chatgpt.com/c/query-example?source=browser",
            1_001,
        )
        .unwrap();
    assert_eq!(
        recorded.canonical_url.as_deref(),
        Some("https://chatgpt.com/c/query-example")
    );
}

#[test]
fn pairing_rejects_the_chatgpt_homepage_without_a_conversation_path() {
    let root = tempfile::tempdir().unwrap();
    let store = AgentAutomationStore::new(root.path().join("automation")).unwrap();
    let task = task("pairing-root");

    let error = store
        .issue_pairing(&task, "https://chatgpt.com/", 0, 1_000)
        .unwrap_err();

    assert!(error.contains("conversation URL"), "{error}");
    assert!(store.load(&task).unwrap().pairing.candidate_url.is_none());
}

#[test]
fn pairing_preserves_project_conversation_urls() {
    let root = tempfile::tempdir().unwrap();
    let store = AgentAutomationStore::new(root.path().join("automation")).unwrap();
    let task = task("project-pairing");
    let url = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-example-project/c/01234567-89ab-cdef-0123-456789abcdef";
    let pairing = store.issue_pairing(&task, url, 0, 1_000).unwrap();
    assert_eq!(
        store.load(&task).unwrap().pairing.candidate_url.as_deref(),
        Some(url)
    );
    let recorded = store
        .record_pairing_canonical_url(&task, pairing.generation, url, 1_001)
        .unwrap();
    assert_eq!(recorded.canonical_url.as_deref(), Some(url));
}

#[test]
fn pairing_reference_index_is_private_and_digest_only() {
    let root = tempfile::tempdir().unwrap();
    let state_root = root.path().join("automation");
    let store = AgentAutomationStore::new(state_root.clone()).unwrap();
    let task = task("pairing-index");

    let issued = store
        .issue_pairing(&task, "https://chatgpt.com/c/private", 0, 1_000)
        .unwrap();
    let index_root = state_root.join(".pairings");
    let entries = std::fs::read_dir(&index_root)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(entries.len(), 1);
    let index_path = entries[0].path();
    assert_eq!(index_path.file_name().unwrap().to_string_lossy().len(), 64);
    let stored = std::fs::read_to_string(&index_path).unwrap();
    assert!(!stored.contains(&issued.reference));
    assert!(stored.contains("taskRoot"));
    assert!(stored.contains("taskKey"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        assert_eq!(
            std::fs::metadata(&index_root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(index_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn invalidating_pairing_revokes_its_pending_reference_index() {
    let root = tempfile::tempdir().unwrap();
    let state_root = root.path().join("automation");
    let store = AgentAutomationStore::new(state_root.clone()).unwrap();
    let task = task("pairing-invalidate");

    let issued = store
        .issue_pairing(&task, "https://chatgpt.com/c/pairing-invalidate", 0, 1_000)
        .unwrap();
    assert_eq!(
        std::fs::read_dir(state_root.join(".pairings"))
            .unwrap()
            .count(),
        1
    );

    let pairing = store.invalidate_pairing(&task, 1_001).unwrap();

    assert!(pairing.pending.is_none());
    assert_eq!(
        std::fs::read_dir(state_root.join(".pairings"))
            .unwrap()
            .count(),
        0
    );
    assert!(
        store
            .verify_pairing_reference(&task, 0, &issued.reference, 1_002)
            .is_err()
    );
}

#[test]
fn account_change_revokes_a_pending_pairing_reference() {
    let root = tempfile::tempdir().unwrap();
    let state_root = root.path().join("automation");
    let store = AgentAutomationStore::new(state_root.clone()).unwrap();
    let task = task("pairing-account-change");
    store
        .set_selection(
            &task,
            "gpt-6-sol",
            "high",
            "catalog-one",
            "account-one",
            1_000,
        )
        .unwrap();
    let issued = store
        .issue_pairing(
            &task,
            "https://chatgpt.com/c/pairing-account-change",
            0,
            1_001,
        )
        .unwrap();
    store
        .record_pairing_canonical_url(
            &task,
            issued.generation,
            "https://chatgpt.com/c/pairing-account-change",
            1_002,
        )
        .unwrap();
    assert_eq!(
        std::fs::read_dir(state_root.join(".pairings"))
            .unwrap()
            .count(),
        1
    );

    store
        .set_selection(
            &task,
            "gpt-6-sol",
            "high",
            "catalog-two",
            "account-two",
            1_003,
        )
        .unwrap();

    let state = store.load(&task).unwrap();
    assert!(state.pairing.pending.is_none());
    assert!(state.pairing.verified_owner_generation.is_none());
    assert_eq!(state.action.status, AutomationActionStatus::Unverified);
    assert_eq!(
        std::fs::read_dir(state_root.join(".pairings"))
            .unwrap()
            .count(),
        0
    );
    assert!(
        store
            .verify_pairing_reference(&task, 0, &issued.reference, 1_004)
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn pairing_reference_index_rejects_a_symlinked_root() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let real = root.path().join("real-index");
    std::fs::create_dir(&real).unwrap();
    let link = root.path().join("index-link");
    symlink(&real, &link).unwrap();

    assert!(
        AgentAutomationStore::new_with_pairing_index(root.path().join("automation"), link,)
            .is_err()
    );
}

#[test]
fn independent_store_instances_serialize_mutations() {
    let root = tempfile::tempdir().unwrap();
    let state_root = root.path().join("automation");
    let first = Arc::new(AgentAutomationStore::new(state_root.clone()).unwrap());
    let second = Arc::new(AgentAutomationStore::new(state_root).unwrap());
    let task = Arc::new(task("concurrent"));
    let barrier = Arc::new(Barrier::new(3));

    let workers = [first, second]
        .into_iter()
        .enumerate()
        .map(|(index, store)| {
            let task = task.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store
                    .set_goal(&task, &format!("goal-{index}"), index as u64 + 1)
                    .unwrap()
                    .revision
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let mut revisions = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    revisions.sort_unstable();
    assert_eq!(revisions, vec![1, 2]);
}

#[test]
fn corrupt_or_symlinked_state_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    let state_root = root.path().join("automation");
    let store = AgentAutomationStore::new(state_root.clone()).unwrap();
    let task = task("unsafe-state");
    store.set_goal(&task, "safe", 1).unwrap();
    let state_path = store.task_directory(&task).unwrap().join("automation.json");
    std::fs::write(&state_path, b"not json").unwrap();
    assert!(
        AgentAutomationStore::new(state_root.clone())
            .unwrap()
            .load(&task)
            .is_err()
    );

    #[cfg(unix)]
    {
        let target = root.path().join("target.json");
        std::fs::write(&target, b"{}").unwrap();
        std::fs::remove_file(&state_path).unwrap();
        std::os::unix::fs::symlink(&target, &state_path).unwrap();
        assert!(
            AgentAutomationStore::new(state_root)
                .unwrap()
                .load(&task)
                .is_err()
        );
    }
}

#[test]
fn logically_inconsistent_persisted_state_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    let state_root = root.path().join("automation");
    let store = AgentAutomationStore::new(state_root.clone()).unwrap();

    let partial_selection = task("partial-selection-state");
    store
        .set_selection(
            &partial_selection,
            "gpt-6-sol",
            "high",
            "catalog-one",
            "account-one",
            1,
        )
        .unwrap();
    let partial_path = store
        .task_directory(&partial_selection)
        .unwrap()
        .join("automation.json");
    let mut partial: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&partial_path).unwrap()).unwrap();
    partial["selection"]["effort"] = serde_json::Value::Null;
    std::fs::write(&partial_path, serde_json::to_vec(&partial).unwrap()).unwrap();
    assert!(
        AgentAutomationStore::new(state_root.clone())
            .unwrap()
            .load(&partial_selection)
            .is_err()
    );

    let duplicate_mirror = task("duplicate-mirror-state");
    store
        .set_goal(&duplicate_mirror, "Create state", 1)
        .unwrap();
    let mirror_path = store
        .task_directory(&duplicate_mirror)
        .unwrap()
        .join("automation.json");
    let mut mirror: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&mirror_path).unwrap()).unwrap();
    mirror["chatMirror"] = serde_json::json!({
        "ownerGeneration": 0,
        "lastAcceptedBatchId": "duplicate-batch",
        "messageIds": ["duplicate-message", "duplicate-message"],
        "transcriptRevisionAtStart": "duplicate-revision"
    });
    std::fs::write(&mirror_path, serde_json::to_vec(&mirror).unwrap()).unwrap();
    assert!(
        AgentAutomationStore::new(state_root.clone())
            .unwrap()
            .load(&duplicate_mirror)
            .is_err()
    );

    let pending_and_verified = task("pending-and-verified-state");
    store
        .set_selection(
            &pending_and_verified,
            "gpt-6-sol",
            "high",
            "catalog-two",
            "account-two",
            1,
        )
        .unwrap();
    let issue = store
        .issue_pairing(
            &pending_and_verified,
            "https://chatgpt.com/c/pending-and-verified",
            7,
            2,
        )
        .unwrap();
    let pairing_path = store
        .task_directory(&pending_and_verified)
        .unwrap()
        .join("automation.json");
    let mut pairing: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&pairing_path).unwrap()).unwrap();
    pairing["pairing"]["canonicalUrl"] =
        serde_json::Value::String("https://chatgpt.com/c/pending-and-verified".into());
    pairing["pairing"]["verifiedOwnerGeneration"] = serde_json::json!(7);
    pairing["pairing"]["verifiedAtMs"] = serde_json::json!(3);
    assert_eq!(pairing["pairing"]["generation"], issue.generation);
    std::fs::write(&pairing_path, serde_json::to_vec(&pairing).unwrap()).unwrap();
    assert!(
        AgentAutomationStore::new(state_root)
            .unwrap()
            .load(&pending_and_verified)
            .is_err()
    );

    let incomplete_action = task("incomplete-action-state");
    store
        .set_goal(&incomplete_action, "Create action state", 1)
        .unwrap();
    let action_path = store
        .task_directory(&incomplete_action)
        .unwrap()
        .join("automation.json");
    let mut action: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&action_path).unwrap()).unwrap();
    action["action"] = serde_json::json!({
        "id": null,
        "kind": "offline_chat",
        "status": "queued",
        "pairingGeneration": 1,
        "goalRevision": null,
        "lastError": null,
        "lastStableAnswer": null,
        "updatedAtMs": 1
    });
    std::fs::write(&action_path, serde_json::to_vec(&action).unwrap()).unwrap();
    assert!(
        AgentAutomationStore::new(root.path().join("automation"))
            .unwrap()
            .load(&incomplete_action)
            .is_err()
    );

    let failed_without_id = task("failed-action-without-id");
    store
        .set_goal(&failed_without_id, "Create failed action state", 1)
        .unwrap();
    let failed_path = store
        .task_directory(&failed_without_id)
        .unwrap()
        .join("automation.json");
    let mut failed: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&failed_path).unwrap()).unwrap();
    failed["action"] = serde_json::json!({
        "id": null,
        "kind": "offline_chat",
        "status": "failed",
        "pairingGeneration": 1,
        "goalRevision": null,
        "lastError": "Retryable queue failure",
        "lastStableAnswer": null,
        "updatedAtMs": 1
    });
    std::fs::write(&failed_path, serde_json::to_vec(&failed).unwrap()).unwrap();
    assert!(
        AgentAutomationStore::new(root.path().join("automation"))
            .unwrap()
            .load(&failed_without_id)
            .is_err()
    );

    let incomplete_wake = task("incomplete-goal-wake-state");
    store
        .set_goal(&incomplete_wake, "Create wake state", 1)
        .unwrap();
    let wake_path = store
        .task_directory(&incomplete_wake)
        .unwrap()
        .join("automation.json");
    let mut wake: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&wake_path).unwrap()).unwrap();
    wake["goalWake"]["nudgedEpoch"] = serde_json::json!("epoch-one");
    std::fs::write(&wake_path, serde_json::to_vec(&wake).unwrap()).unwrap();
    assert!(
        AgentAutomationStore::new(root.path().join("automation"))
            .unwrap()
            .load(&incomplete_wake)
            .is_err()
    );
}

#[test]
fn only_pre_send_failed_non_pair_actions_can_be_reset_for_explicit_retry() {
    let root = tempfile::tempdir().unwrap();
    let store = AgentAutomationStore::new(root.path().join("automation")).unwrap();
    let task = task("retry-action");
    store
        .set_selection(&task, "gpt-6-sol", "high", "catalog-1", "account-1", 1)
        .unwrap();
    let pairing = store
        .issue_pairing(&task, "https://chatgpt.com/c/retry", 0, 2)
        .unwrap();
    store
        .record_pairing_canonical_url(&task, pairing.generation, "https://chatgpt.com/c/retry", 3)
        .unwrap();
    store
        .verify_pairing(&task, pairing.generation, 0, &pairing.reference, 4)
        .unwrap();
    store
        .queue_action(
            &task,
            "failed-action",
            AutomationActionKind::OfflineChat,
            pairing.generation,
            None,
            5,
        )
        .unwrap();
    store
        .update_action_status(
            &task,
            "failed-action",
            AutomationActionStatus::Failed,
            Some("Selector verification failed before Send"),
            None,
            6,
        )
        .unwrap();

    let reset = store
        .reset_failed_action_for_retry(&task, "failed-action", 7)
        .unwrap();
    assert_eq!(reset.status, AutomationActionStatus::Idle);
    assert!(reset.id.is_none());
    assert!(reset.kind.is_none());
    assert!(reset.last_error.is_none());

    store
        .queue_action(
            &task,
            "ambiguous-action",
            AutomationActionKind::OfflineChat,
            pairing.generation,
            None,
            8,
        )
        .unwrap();
    store
        .update_action_status(
            &task,
            "ambiguous-action",
            AutomationActionStatus::Ambiguous,
            Some("Send may have been accepted"),
            None,
            9,
        )
        .unwrap();
    assert!(
        store
            .reset_failed_action_for_retry(&task, "ambiguous-action", 10)
            .unwrap_err()
            .contains("failed before Send")
    );
}
