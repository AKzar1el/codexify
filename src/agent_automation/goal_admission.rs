use std::collections::HashSet;

/// Admission slots are bound to browser executors, not to the number of
/// persisted goal records. Legacy active records may be parked without losing
/// their accepted Send or handoff evidence.
#[derive(Debug, Clone)]
pub(crate) struct GoalAdmission {
    assigned_task_keys: Vec<String>,
}

impl GoalAdmission {
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
}
