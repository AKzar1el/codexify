use std::sync::{Arc, Barrier};

use codexify::agent_automation::{
    AgentAutomationStore, GoalFinish, GoalStatus, PAIRING_REFERENCE_TTL_MS,
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
