use std::collections::VecDeque;

/// Future multi-executor dispatch must be bounded by the snapshot queue
/// length and must not promote work belonging to an unavailable lane.
/// Returns the oldest eligible item without changing any other queue entry.
pub(crate) fn take_oldest_verified_lane<T>(
    queue: &mut VecDeque<T>,
    lane: usize,
    authenticated_executors: &[bool],
    mut assigned_lane: impl FnMut(&T) -> Option<usize>,
) -> Option<T> {
    if !authenticated_executors.get(lane).copied().unwrap_or(false) {
        return None;
    }
    let position = queue
        .iter()
        .position(|entry| assigned_lane(entry) == Some(lane))?;
    queue.remove(position)
}

/// Select the next authenticated lane in round-robin order without changing
/// sticky ownership. Empty or unavailable lanes are skipped, never borrowed.
/// The returned cursor is the lane to probe on the following dispatch.
pub(crate) fn next_verified_lane<T>(
    queue: &VecDeque<T>,
    cursor: usize,
    authenticated_executors: &[bool],
    mut assigned_lane: impl FnMut(&T) -> Option<usize>,
) -> Option<(usize, usize)> {
    let capacity = authenticated_executors.len();
    if capacity == 0 {
        return None;
    }
    for offset in 0..capacity {
        let lane = (cursor % capacity + offset) % capacity;
        if authenticated_executors[lane]
            && queue.iter().any(|entry| assigned_lane(entry) == Some(lane))
        {
            return Some((lane, (lane + 1) % capacity));
        }
    }
    None
}

/// Dispatch only on an authenticated, idle executor. A busy lane retains its
/// queue entries until the in-flight action has a definitive outcome.
pub(crate) fn next_idle_verified_lane<T>(
    queue: &VecDeque<T>,
    cursor: usize,
    authenticated_executors: &[bool],
    busy_lanes: &[bool],
    assigned_lane: impl FnMut(&T) -> Option<usize>,
) -> Option<(usize, usize)> {
    if authenticated_executors.len() != busy_lanes.len() {
        return None;
    }
    let available = authenticated_executors
        .iter()
        .zip(busy_lanes)
        .map(|(authenticated, busy)| *authenticated && !*busy)
        .collect::<Vec<_>>();
    next_verified_lane(queue, cursor, &available, assigned_lane)
}

/// Stable explicit canary ownership; never migrate tasks by modulo/hash.
#[cfg(test)]
pub fn owns(task_key: &str, canary_key: Option<&str>, lane: usize) -> bool {
    owns_operation(task_key, canary_key, lane, true)
}

/// Pairing, creation and turn-renewal actions always stay on the primary
/// browser. Only ordinary offline work may enter the explicitly chosen canary.
pub fn owns_operation(
    task_key: &str,
    canary_key: Option<&str>,
    lane: usize,
    eligible_offline: bool,
) -> bool {
    let second = eligible_offline && canary_key.is_some_and(|key| key == task_key);
    match lane {
        0 => !second,
        1 => second,
        _ => false,
    }
}

/// The two-task pilot pins every operation for the selected secondary task
/// to its own browser, including creation, pairing and renewal. Legacy mode
/// below retains the original primary-only pairing behavior.
/// Never enable this routing without first checking accepted in-flight Sends.
pub fn owns_operation_in_pilot(
    task_key: &str,
    pilot_primary_key: Option<&str>,
    canary_key: Option<&str>,
    lane: usize,
    eligible_offline: bool,
) -> bool {
    if let Some(primary) = pilot_primary_key {
        if primary == task_key {
            return lane == 0;
        }
        return canary_key == Some(task_key) && lane == 1;
    }
    owns_operation(task_key, canary_key, lane, eligible_offline)
}

pub fn first_operation_in_pilot_lane<T>(
    queue: &VecDeque<T>,
    pilot_primary_key: Option<&str>,
    canary_key: Option<&str>,
    lane: usize,
    route: impl Fn(&T) -> (&str, bool),
) -> Option<usize> {
    queue.iter().position(|entry| {
        let (key, offline) = route(entry);
        owns_operation_in_pilot(key, pilot_primary_key, canary_key, lane, offline)
    })
}

pub fn first_operation_in_lane<T>(
    queue: &VecDeque<T>,
    canary_key: Option<&str>,
    lane: usize,
    route: impl Fn(&T) -> (&str, bool),
) -> Option<usize> {
    queue.iter().position(|entry| {
        let (task_key, eligible_offline) = route(entry);
        owns_operation(task_key, canary_key, lane, eligible_offline)
    })
}

#[cfg(test)]
pub fn first_in_lane<T>(
    queue: &VecDeque<T>,
    canary_key: Option<&str>,
    lane: usize,
    key: impl Fn(&T) -> &str,
) -> Option<usize> {
    queue
        .iter()
        .position(|entry| owns(key(entry), canary_key, lane))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn busy_lane_cannot_receive_another_goal_or_steal_queued_work() {
        let queue = VecDeque::from([(Some(0), "inflight-followup"), (Some(1), "ready")]);
        assert_eq!(
            next_idle_verified_lane(&queue, 0, &[true, true], &[true, false], |item| item.0),
            Some((1, 0))
        );
        assert_eq!(
            next_idle_verified_lane(&queue, 0, &[true, true], &[true, true], |item| item.0),
            None
        );
        assert_eq!(
            next_idle_verified_lane(&queue, 0, &[true, true], &[false], |item| item.0),
            None
        );
        assert_eq!(queue.len(), 2);
    }
    #[test]
    fn round_robin_is_bounded_and_preserves_lane_affinity() {
        let queue = VecDeque::from([(0, "a"), (0, "b"), (2, "c"), (1, "d")]);
        let ready = [true, false, true];
        let first = next_verified_lane(&queue, 0, &ready, |entry| Some(entry.0));
        assert_eq!(first, Some((0, 1)));
        assert_eq!(
            next_verified_lane(&queue, first.unwrap().1, &ready, |entry| Some(entry.0)),
            Some((2, 0))
        );
        assert_eq!(
            next_verified_lane(&queue, 0, &[false, false, false], |entry| Some(entry.0)),
            None
        );
        assert_eq!(
            next_verified_lane(&queue, 0, &[], |entry| Some(entry.0)),
            None
        );
    }
    #[test]
    fn multi_lane_fifo_skips_unverified_executor_without_migrating_work() {
        let mut queue = VecDeque::from([(2, "c1"), (1, "b1"), (0, "a1"), (2, "c2"), (1, "b2")]);
        let lanes = [true, false, true];
        assert_eq!(
            take_oldest_verified_lane(&mut queue, 1, &lanes, |entry| Some(entry.0)),
            None
        );
        assert_eq!(
            take_oldest_verified_lane(&mut queue, 2, &lanes, |entry| Some(entry.0)),
            Some((2, "c1"))
        );
        assert_eq!(
            take_oldest_verified_lane(&mut queue, 0, &lanes, |entry| Some(entry.0)),
            Some((0, "a1"))
        );
        assert_eq!(
            take_oldest_verified_lane(&mut queue, 2, &lanes, |entry| Some(entry.0)),
            Some((2, "c2"))
        );
        assert_eq!(queue, VecDeque::from([(1, "b1"), (1, "b2")]));
        assert_eq!(
            take_oldest_verified_lane(&mut queue, 1, &[true, true, true], |entry| Some(entry.0)),
            Some((1, "b1"))
        );
    }

    #[test]
    fn recovery_preserves_unassigned_and_ambiguous_handoffs_in_queue() {
        // These entries model persisted, unresolved work after a restart.
        // Only the explicitly reserved task may resume on its exact lane.
        let mut queue = VecDeque::from([
            (None, "legacy-accepted-send"),
            (None, "uncertain-handoff"),
            (Some(0), "verified-primary"),
            (Some(1), "verified-secondary"),
        ]);
        assert_eq!(
            take_oldest_verified_lane(&mut queue, 0, &[true, false], |entry| entry.0),
            Some((Some(0), "verified-primary"))
        );
        assert_eq!(
            take_oldest_verified_lane(&mut queue, 1, &[true, false], |entry| entry.0),
            None
        );
        assert_eq!(queue.len(), 3);
        assert_eq!(queue[0].1, "legacy-accepted-send");
        assert_eq!(queue[1].1, "uncertain-handoff");
        assert_eq!(
            take_oldest_verified_lane(&mut queue, 1, &[true, true], |entry| entry.0),
            Some((Some(1), "verified-secondary"))
        );
        assert_eq!(queue[0].1, "legacy-accepted-send");
        assert_eq!(queue[1].1, "uncertain-handoff");
    }
    #[test]
    fn pilot_fences_old_goal_states_on_both_lanes_without_touching_their_records() {
        let queue = VecDeque::from([
            "old-unconfirmed",
            "pilot-two",
            "old-revenue",
            "pilot-one",
            "pilot-two",
        ]);
        assert_eq!(
            first_operation_in_pilot_lane(&queue, Some("pilot-one"), Some("pilot-two"), 0, |s| (
                s, true
            )),
            Some(3)
        );
        assert_eq!(
            first_operation_in_pilot_lane(&queue, Some("pilot-one"), Some("pilot-two"), 1, |s| (
                s, true
            )),
            Some(1)
        );
        assert!(!owns_operation_in_pilot(
            "pilot-two",
            Some("pilot-one"),
            Some("pilot-two"),
            0,
            false
        ));
        assert!(owns_operation_in_pilot(
            "pilot-two",
            Some("pilot-one"),
            Some("pilot-two"),
            1,
            false
        ));
        assert!(!owns_operation_in_pilot(
            "pilot-two",
            Some("pilot-one"),
            Some("pilot-two"),
            0,
            true
        ));
        assert!(!owns_operation_in_pilot(
            "old-revenue",
            Some("pilot-one"),
            Some("pilot-two"),
            0,
            false
        ));
        assert!(!owns_operation_in_pilot(
            "old-revenue",
            Some("pilot-one"),
            Some("pilot-two"),
            1,
            true
        ));
        assert!(!owns_operation_in_pilot(
            "pilot-one",
            Some("pilot-one"),
            Some("pilot-two"),
            1,
            true
        ));
        assert_eq!(
            first_operation_in_pilot_lane(&queue, None, Some("pilot-two"), 0, |s| (s, true)),
            Some(0)
        );
    }
    #[test]
    fn pilot_creation_pairing_and_renewal_stay_with_the_secondary_task() {
        // The flag is false for creation, verification and renewal; the
        // strict pilot must still keep every secondary-task operation on 1.
        let queue = VecDeque::from([
            ("secondary", false),
            ("primary", false),
            ("legacy", true),
            ("secondary", true),
            ("secondary", false),
        ]);
        assert_eq!(
            first_operation_in_pilot_lane(&queue, Some("primary"), Some("secondary"), 0, |item| (
                item.0, item.1
            ),),
            Some(1)
        );
        assert_eq!(
            first_operation_in_pilot_lane(&queue, Some("primary"), Some("secondary"), 1, |item| (
                item.0, item.1
            ),),
            Some(0)
        );
        assert!(owns_operation_in_pilot(
            "secondary",
            Some("primary"),
            Some("secondary"),
            1,
            false
        ));
        assert!(!owns_operation_in_pilot(
            "secondary",
            Some("primary"),
            Some("secondary"),
            0,
            false
        ));
        assert!(!owns_operation_in_pilot(
            "legacy",
            Some("primary"),
            Some("secondary"),
            0,
            false
        ));
    }
    #[test]
    fn single_lane_preserves_original_order() {
        let queue = VecDeque::from(["revenue", "canary", "new"]);
        assert_eq!(first_in_lane(&queue, None, 0, |s| s), Some(0));
        assert_eq!(first_in_lane(&queue, None, 1, |s| s), None);
    }
    #[test]
    fn exact_canary_never_leaks_into_primary_lane() {
        let queue = VecDeque::from(["canary", "revenue", "canary", "another"]);
        assert_eq!(first_in_lane(&queue, Some("canary"), 0, |s| s), Some(1));
        assert_eq!(first_in_lane(&queue, Some("canary"), 1, |s| s), Some(0));
        assert!(!owns("revenue", Some("canary"), 1));
        assert!(!owns("canary", Some("canary"), 0));
    }
    #[test]
    fn lane_priority_remains_fifo_within_each_lane() {
        let mut queue = VecDeque::from(["canary", "revenue1", "canary", "revenue2"]);
        assert_eq!(
            queue.remove(first_in_lane(&queue, Some("canary"), 0, |s| s).unwrap()),
            Some("revenue1")
        );
        assert_eq!(
            queue.remove(first_in_lane(&queue, Some("canary"), 1, |s| s).unwrap()),
            Some("canary")
        );
        assert_eq!(
            queue.remove(first_in_lane(&queue, Some("canary"), 0, |s| s).unwrap()),
            Some("revenue2")
        );
        assert_eq!(
            queue.remove(first_in_lane(&queue, Some("canary"), 1, |s| s).unwrap()),
            Some("canary")
        );
        assert!(queue.is_empty());
    }
    #[test]
    fn only_one_explicit_canary_can_own_secondary() {
        assert!(owns("selected", Some("selected"), 1));
        for key in ["unknown", "selected-2", "Selected", ""] {
            assert!(!owns(key, Some("selected"), 1));
            assert!(owns(key, Some("selected"), 0));
        }
        assert!(!owns("selected", Some("selected"), 2));
    }

    #[test]
    fn legacy_canary_pairing_and_turn_renewal_remain_primary() {
        let queue = VecDeque::from([
            ("selected", false), // Pairing on lane 1
            ("selected", true),  // Offline work on lane 2
            ("revenue", true),   // Revenue goal stays on lane 1
            ("selected", false), // Turn renewal on lane 1
        ]);
        assert_eq!(
            first_operation_in_lane(&queue, Some("selected"), 0, |(key, offline)| (
                key, *offline
            )),
            Some(0)
        );
        assert_eq!(
            first_operation_in_lane(&queue, Some("selected"), 1, |(key, offline)| (
                key, *offline
            )),
            Some(1)
        );
        assert!(owns_operation("selected", Some("selected"), 0, false));
        assert!(!owns_operation("selected", Some("selected"), 1, false));
    }
}
