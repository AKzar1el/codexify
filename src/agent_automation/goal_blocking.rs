//! Require persistent, independently revisited blockers before ending an autonomous goal.
//! Adapted from LeZergan/codexify PR #24, without unbounded retries.
//! A separate, private sidecar preserves rollback compatibility with older
//! strict AutomationTaskState schemas: the original state format is unchanged.
use super::{AgentAutomationStore, GoalStatus};
use crate::project_bindings::ConversationIdentity;
use serde::{Deserialize, Serialize};

#[path = "goal_blocking_policy.rs"]
mod policy;

const BLOCKER_AUDIT_RECORD: &str = "goal-blocker-audit.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BlockerAudit {
    pub revision: u64,
    pub reason: String,
    pub attempts: u32,
    pub last_turn: u64,
    pub first_at_ms: u64,
    pub activation_at_ms: u64,
}

impl AgentAutomationStore {
    fn blocker_audit_path(
        &self,
        task: &ConversationIdentity,
    ) -> Result<std::path::PathBuf, String> {
        Ok(self.task_directory(task)?.join(BLOCKER_AUDIT_RECORD))
    }

    fn read_blocker_audit(
        &self,
        task: &ConversationIdentity,
    ) -> Result<Option<BlockerAudit>, String> {
        let path = self.blocker_audit_path(task)?;
        super::store::read_private_record(&path)?
            .map(|bytes| {
                serde_json::from_slice(&bytes).map_err(|_| {
                    "Persistent goal blocker audit contains invalid JSON; file preserved".into()
                })
            })
            .transpose()
    }

    pub fn audit_goal_blocker(
        &self,
        task: &ConversationIdentity,
        revision: u64,
        reason: &str,
        now: u64,
    ) -> Result<(), String> {
        if !self.persistent_goal_blockers {
            return Ok(());
        }
        let reason = reason.trim();
        if reason.is_empty() || reason.len() > 4096 {
            return Err("A blocked goal requires a concrete reason of at most 4096 bytes".into());
        }
        let path = self.blocker_audit_path(task)?;
        // Reuse the task-state mutation lock, so concurrent goal_finish calls
        // cannot each increment the same turn or overwrite each other's audit.
        let deferred = self.mutate(task, |state| {
            let goal = state.goal.as_ref().ok_or("No agent-chat goal is configured")?;
            if goal.revision != revision {
                return Err("The goal revision changed; read goal_read again".into());
            }
            if goal.status != GoalStatus::Active {
                return Ok(None);
            }
            let previous = self.read_blocker_audit(task)?;
            let same = previous.as_ref().is_some_and(|audit| {
                audit.revision == revision
                    && audit.reason == reason
                    && audit.activation_at_ms == goal.updated_at_ms
            });
            let audit = if same {
                let mut previous = previous.expect("a matching audit exists");
                previous.attempts = policy::next_attempts(
                    previous.attempts,
                    previous.last_turn,
                    goal.turn_count,
                );
                previous.last_turn = goal.turn_count;
                previous
            } else {
                BlockerAudit {
                    revision,
                    reason: reason.into(),
                    attempts: 1,
                    last_turn: goal.turn_count,
                    first_at_ms: now,
                    activation_at_ms: goal.updated_at_ms,
                }
            };
            super::store::persist_private_record(&path, &audit)?;
            Ok((!policy::sufficient(audit.attempts, audit.first_at_ms, now))
                .then(|| format!(
                    "Goal remains active. Blocker audit {}/3: {}. Investigate alternate free-only work, record evidence in rollout_update, and revisit the exact blocker in a later goal turn. Repeated goal_finish calls within one turn do not count. Three distinct turns spanning at least 60 seconds are required to block this autonomous goal. This does not authorize payments, contracts, private data access, or restricted operations.",
                    audit.attempts.min(3), audit.reason
                )))
        })?;
        if let Some(message) = deferred {
            return Err(message);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_store(
        enabled: bool,
    ) -> (
        tempfile::TempDir,
        AgentAutomationStore,
        ConversationIdentity,
    ) {
        let root = tempfile::tempdir().unwrap();
        let mut config = crate::config::default_config(root.path().to_path_buf());
        config.markdown_chat.automation.persistent_goal_blockers = enabled;
        let store = AgentAutomationStore::for_config(&config).unwrap();
        let task = ConversationIdentity::from_openai_session("revenue-blocker-check").unwrap();
        store
            .set_goal(&task, "Work towards verified revenue", 1)
            .unwrap();
        store.run_goal(&task, 1, 2).unwrap();
        (root, store, task)
    }

    #[test]
    fn first_blocker_requires_three_distinct_turns_and_one_minute() {
        let (_root, store, task) = fixture_store(true);
        let reason = "Payment setup requires owner approval; continue independent research.";
        assert!(store.audit_goal_blocker(&task, 1, reason, 100).is_err());
        assert!(store.audit_goal_blocker(&task, 1, reason, 100_000).is_err());
        assert_eq!(
            store.read_blocker_audit(&task).unwrap().unwrap().attempts,
            1
        );
        store
            .mutate(&task, |state| {
                state.goal.as_mut().unwrap().turn_count = 2;
                Ok(())
            })
            .unwrap();
        assert!(store.audit_goal_blocker(&task, 1, reason, 101_000).is_err());
        store
            .mutate(&task, |state| {
                state.goal.as_mut().unwrap().turn_count = 3;
                Ok(())
            })
            .unwrap();
        assert!(store.audit_goal_blocker(&task, 1, reason, 120_000).is_ok());
    }

    #[test]
    fn changed_reason_and_new_revision_reset_the_sidecar_audit() {
        let (_root, store, task) = fixture_store(true);
        assert!(
            store
                .audit_goal_blocker(&task, 1, "payment gate", 1_000)
                .is_err()
        );
        store
            .mutate(&task, |state| {
                state.goal.as_mut().unwrap().turn_count = 2;
                Ok(())
            })
            .unwrap();
        assert!(
            store
                .audit_goal_blocker(&task, 1, "publication gate", 70_000)
                .is_err()
        );
        let audit = store.read_blocker_audit(&task).unwrap().unwrap();
        assert_eq!(audit.attempts, 1);
        assert_eq!(audit.reason, "publication gate");
        let next = store.set_goal(&task, "New task revision", 90_000).unwrap();
        store.run_goal(&task, next.revision, 90_001).unwrap();
        assert!(
            store
                .audit_goal_blocker(&task, next.revision, "new review gate", 90_002)
                .is_err()
        );
        assert_eq!(
            store.read_blocker_audit(&task).unwrap().unwrap().revision,
            next.revision
        );
    }

    #[test]
    fn sidecar_does_not_change_original_goal_state_schema_or_default_policy() {
        let (_root, store, task) = fixture_store(true);
        assert!(
            store
                .audit_goal_blocker(&task, 1, "Needs legal approval", 100)
                .is_err()
        );
        let state = store.load(&task).unwrap();
        let encoded = serde_json::to_value(&state).unwrap();
        assert!(encoded.get("blockerAudit").is_none());
        assert!(store.read_blocker_audit(&task).unwrap().is_some());
        let (_root, disabled, task) = fixture_store(false);
        assert!(
            disabled
                .audit_goal_blocker(&task, 1, "Needs legal approval", 100)
                .is_ok()
        );
    }
}
