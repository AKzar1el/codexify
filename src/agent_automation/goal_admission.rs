use std::collections::HashSet;

// Windows accepts either separator and case-insensitive path aliases. This
// lexical check is not a replacement for trusted canonical-path probing.
fn normalized_path_label(path: &str) -> String {
    path.trim().replace('\\', "/").to_lowercase()
}

/// A verified browser executor must have its own process and profile.
/// Account identity must match across lanes: the authenticated user may run
/// multiple independent browsers, but an unrelated account cannot join.
/// This is evidence supplied by a trusted runtime probe, not a self-attested
/// descriptor from the queued task.
#[derive(Debug, Clone)]
pub(crate) struct VerifiedBrowserExecutor {
    pub(crate) process_id: u32,
    pub(crate) profile_path: String,
    pub(crate) account_identity: String,
    pub(crate) authenticated: bool,
}

/// Admission slots are bound to browser executors, not to the number of
/// persisted goal records. Legacy active records may be parked without losing
/// their accepted Send or handoff evidence.
#[derive(Debug, Clone)]
pub(crate) struct GoalAdmission {
    assigned_task_keys: Vec<String>,
}

impl GoalAdmission {
    /// Reject missing authentication and shared process/profile resources.
    /// This check must be repeated against fresh runtime probes before Send.
    pub(crate) fn require_independent_executors(
        executors: &[VerifiedBrowserExecutor],
    ) -> Result<(), String> {
        if executors.is_empty() {
            return Err("No verified browser executors".into());
        }
        let mut processes = HashSet::new();
        let mut profiles = HashSet::new();
        let mut expected_account: Option<&str> = None;
        for executor in executors {
            let account = executor.account_identity.trim();
            if !executor.authenticated
                || executor.process_id == 0
                || account.is_empty()
                || executor.profile_path.trim().is_empty()
                || !processes.insert(executor.process_id)
                || !profiles.insert(normalized_path_label(&executor.profile_path))
                || expected_account.is_some_and(|expected| expected != account)
            {
                return Err(
                    "Browser executors require distinct authenticated processes and profiles"
                        .into(),
                );
            }
            expected_account = Some(account);
        }
        Ok(())
    }
    /// Reject aliases before assigning any task to an executor. Descriptor
    /// existence and authenticated process identity must be checked separately
    /// at dispatch; distinct paths alone are never proof of a live browser.
    pub(crate) fn require_distinct_descriptors(descriptors: &[String]) -> Result<(), String> {
        if descriptors.is_empty()
            || descriptors.iter().any(|path| path.trim().is_empty())
            || descriptors.iter().enumerate().any(|(index, path)| {
                descriptors[..index]
                    .iter()
                    .any(|previous| normalized_path_label(previous) == normalized_path_label(path))
            })
        {
            return Err("Browser lanes require nonempty, distinct descriptor paths".into());
        }
        Ok(())
    }
    pub(crate) fn new(
        assigned_task_keys: Vec<String>,
        available_browser_slots: usize,
    ) -> Result<Self, String> {
        if available_browser_slots == 0 && !assigned_task_keys.is_empty() {
            return Err("Cannot activate goals without a browser executor".into());
        }
        if assigned_task_keys.len() > available_browser_slots {
            return Err(format!(
                "Goal admission capacity exceeded: {} assigned goals, {} browser executors",
                assigned_task_keys.len(),
                available_browser_slots
            ));
        }
        let mut unique = HashSet::with_capacity(assigned_task_keys.len());
        for key in &assigned_task_keys {
            if key.len() != 64
                || !key
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                || !unique.insert(key)
            {
                return Err("Goal admission requires distinct stable lowercase task keys".into());
            }
        }
        Ok(Self { assigned_task_keys })
    }

    pub(crate) fn require_slot(&self, task_key: &str) -> Result<(), String> {
        if self.lane_index(task_key).is_some() {
            Ok(())
        } else {
            Err(format!(
                "All {} browser goal slots are reserved. This goal stays configured or parked; preserve existing state and activate only after assigning a verified browser slot.",
                self.assigned_task_keys.len()
            ))
        }
    }

    /// Stable zero-based lane reservation. An unavailable executor must freeze
    /// this reservation, not silently shift a goal to a different browser.
    pub(crate) fn lane_index(&self, task_key: &str) -> Option<usize> {
        self.assigned_task_keys
            .iter()
            .position(|key| key == task_key)
    }

    /// A reservation is not an execution permit. A lane is runnable only
    /// when its exact executor has been independently authenticated. Missing
    /// health evidence is fail-closed; another lane never takes its work.
    pub(crate) fn runnable_lane(
        &self,
        task_key: &str,
        authenticated_executors: &[bool],
    ) -> Option<usize> {
        let lane = self.lane_index(task_key)?;
        authenticated_executors
            .get(lane)
            .copied()
            .filter(|ready| *ready)
            .map(|_| lane)
    }

    /// A persisted reservation alone cannot run: its exact authenticated
    /// executor must also be idle. A mismatched health snapshot fails closed.
    pub(crate) fn runnable_idle_lane(
        &self,
        task_key: &str,
        authenticated_executors: &[bool],
        busy_lanes: &[bool],
    ) -> Option<usize> {
        if authenticated_executors.len() != busy_lanes.len()
            || authenticated_executors.len() != self.assigned_task_keys.len()
        {
            return None;
        }
        let lane = self.runnable_lane(task_key, authenticated_executors)?;
        (!busy_lanes[lane]).then_some(lane)
    }

    pub(crate) fn is_assigned(&self, task_key: &str) -> bool {
        self.assigned_task_keys.iter().any(|key| key == task_key)
    }

    #[cfg(test)]
    fn slots(&self) -> usize {
        self.assigned_task_keys.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(index: usize) -> String {
        format!("{index:064x}")
    }

    #[test]
    fn two_browsers_admit_only_two_distinct_goals() {
        let seats = GoalAdmission::new(vec![key(1), key(2)], 2).unwrap();
        assert_eq!(seats.slots(), 2);
        assert!(seats.require_slot(&key(1)).is_ok());
        assert!(seats.require_slot(&key(2)).is_ok());
        assert!(seats.require_slot(&key(3)).is_err());
        assert!(GoalAdmission::new(vec![key(1), key(2), key(3)], 2).is_err());
    }

    #[test]
    fn same_rule_scales_to_five_without_overbooking_or_implicit_reassignment() {
        let assigned = (1..=5).map(key).collect::<Vec<_>>();
        let five = GoalAdmission::new(assigned.clone(), 5).unwrap();
        assert_eq!(five.slots(), 5);
        for key in &assigned {
            assert!(five.is_assigned(key));
        }
        assert!(five.require_slot(&key(6)).is_err());
        assert!(GoalAdmission::new(assigned.clone(), 4).is_err());
        assert!(GoalAdmission::new(vec![key(1), key(1)], 5).is_err());
        assert!(GoalAdmission::new(vec![key(1)], 0).is_err());
    }

    #[test]
    fn invalid_key_or_no_executor_never_creates_a_slot() {
        assert!(GoalAdmission::new(vec!["legacy".into()], 1).is_err());
        assert!(GoalAdmission::new(vec!["A".repeat(64)], 1).is_err());
        assert!(GoalAdmission::new(vec![], 0).is_ok());
    }

    #[test]
    fn lane_reservations_are_sticky_and_never_promote_waiting_goals() {
        let admission = GoalAdmission::new(vec![key(3), key(1), key(2)], 3).unwrap();
        assert_eq!(admission.lane_index(&key(3)), Some(0));
        assert_eq!(admission.lane_index(&key(1)), Some(1));
        assert_eq!(admission.lane_index(&key(2)), Some(2));
        assert_eq!(admission.lane_index(&key(4)), None);
        assert!(admission.require_slot(&key(4)).is_err());
        // A failed executor must not cause the remaining goals to be
        // reindexed or a waiting goal to be promoted.
        assert_eq!(admission.lane_index(&key(2)), Some(2));
    }

    #[test]
    fn idle_admission_rejects_busy_missing_and_stale_health_snapshots() {
        let admission = GoalAdmission::new(vec![key(1), key(2), key(3)], 3).unwrap();
        assert_eq!(
            admission.runnable_idle_lane(&key(1), &[true, true, true], &[false, true, false]),
            Some(0)
        );
        assert_eq!(
            admission.runnable_idle_lane(&key(2), &[true, true, true], &[false, true, false]),
            None
        );
        assert_eq!(
            admission.runnable_idle_lane(&key(3), &[true, true, false], &[false, false, false]),
            None
        );
        assert_eq!(
            admission.runnable_idle_lane(&key(1), &[true], &[false]),
            None
        );
        assert_eq!(
            admission.runnable_idle_lane(&key(1), &[true, true, true], &[false, false]),
            None
        );
        assert_eq!(
            admission.runnable_idle_lane(&key(4), &[true, true, true], &[false, false, false]),
            None
        );
        assert_eq!(admission.lane_index(&key(2)), Some(1));
    }

    #[test]
    fn executor_loss_fails_closed_without_cross_lane_takeover() {
        let admission = GoalAdmission::new(vec![key(1), key(2), key(3)], 3).unwrap();
        assert_eq!(
            admission.runnable_lane(&key(1), &[true, true, true]),
            Some(0)
        );
        assert_eq!(admission.runnable_lane(&key(2), &[true, false, true]), None);
        assert_eq!(
            admission.runnable_lane(&key(3), &[true, false, true]),
            Some(2)
        );
        assert_eq!(admission.runnable_lane(&key(2), &[true]), None);
        assert_eq!(admission.runnable_lane(&key(4), &[true, true, true]), None);
        assert_eq!(
            admission.runnable_lane(&key(2), &[true, true, true]),
            Some(1)
        );
    }

    #[test]
    fn descriptor_aliases_cannot_create_fake_browser_capacity() {
        assert!(GoalAdmission::require_distinct_descriptors(&[]).is_err());
        assert!(GoalAdmission::require_distinct_descriptors(&[" ".into()]).is_err());
        assert!(GoalAdmission::require_distinct_descriptors(&["A".into(), "a".into()]).is_err());
        assert!(GoalAdmission::require_distinct_descriptors(&[" A ".into(), "a".into()]).is_err());
        assert!(
            GoalAdmission::require_distinct_descriptors(&[
                "C:\\profiles\\one\\descriptor.json".into(),
                "c:/PROFILES/one/descriptor.json".into()
            ])
            .is_err()
        );
        assert!(
            GoalAdmission::require_distinct_descriptors(&[
                "browser-1".into(),
                "browser-2".into(),
                "browser-3".into()
            ])
            .is_ok()
        );
    }

    #[test]
    fn verified_executor_evidence_rejects_shared_process_and_profile() {
        let first = VerifiedBrowserExecutor {
            process_id: 101,
            profile_path: "C:/profiles/one".into(),
            account_identity: "same-user".into(),
            authenticated: true,
        };
        let second = VerifiedBrowserExecutor {
            process_id: 202,
            profile_path: "C:/profiles/two".into(),
            account_identity: "same-user".into(),
            authenticated: true,
        };
        assert!(
            GoalAdmission::require_independent_executors(&[first.clone(), second.clone()]).is_ok()
        );
        let mut duplicate_pid = second.clone();
        duplicate_pid.process_id = first.process_id;
        assert!(
            GoalAdmission::require_independent_executors(&[first.clone(), duplicate_pid]).is_err()
        );
        let mut duplicate_profile = second.clone();
        duplicate_profile.profile_path = " C:/PROFILES/ONE ".into();
        assert!(
            GoalAdmission::require_independent_executors(&[first.clone(), duplicate_profile])
                .is_err()
        );
        let mut separator_alias = second.clone();
        separator_alias.profile_path = "C:\\profiles\\ONE".into();
        assert!(
            GoalAdmission::require_independent_executors(&[first.clone(), separator_alias])
                .is_err()
        );
        let mut wrong_account = second.clone();
        wrong_account.account_identity = "other-user".into();
        assert!(
            GoalAdmission::require_independent_executors(&[first.clone(), wrong_account]).is_err()
        );
        let mut padded_account = second.clone();
        padded_account.account_identity = " same-user ".into();
        assert!(
            GoalAdmission::require_independent_executors(&[first.clone(), padded_account]).is_ok()
        );
        let mut unauthenticated = second;
        unauthenticated.authenticated = false;
        assert!(GoalAdmission::require_independent_executors(&[first, unauthenticated]).is_err());
        assert!(GoalAdmission::require_independent_executors(&[]).is_err());
    }

    #[test]
    fn executor_evidence_requires_nonempty_identity_and_real_process() {
        let valid = VerifiedBrowserExecutor {
            process_id: 42,
            profile_path: "C:/profiles/primary".into(),
            account_identity: "owner".into(),
            authenticated: true,
        };
        for invalid in [
            VerifiedBrowserExecutor {
                process_id: 0,
                ..valid.clone()
            },
            VerifiedBrowserExecutor {
                profile_path: "  ".into(),
                ..valid.clone()
            },
            VerifiedBrowserExecutor {
                account_identity: "  ".into(),
                ..valid.clone()
            },
        ] {
            assert!(GoalAdmission::require_independent_executors(&[invalid]).is_err());
        }
    }
}
