use std::collections::VecDeque;

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
    fn selected_canary_pairing_and_turn_renewal_remain_primary() {
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
