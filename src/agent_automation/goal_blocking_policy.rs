//! Dependency-free policy for persistent, repeated autonomous goal blockers.
//! This file can be tested with rustc --test without linking the main Codexify app.

/// Repeated calls in the same accepted goal turn must not advance the audit.
pub(crate) fn next_attempts(attempts: u32, previous_turn: u64, current_turn: u64) -> u32 {
    if previous_turn == current_turn {
        attempts
    } else {
        attempts.saturating_add(1)
    }
}

/// Require three distinct turns and at least one real minute.
pub(crate) fn sufficient(attempts: u32, first_at_ms: u64, now_ms: u64) -> bool {
    attempts >= 3 && now_ms.saturating_sub(first_at_ms) >= 60_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_calls_in_one_turn_do_not_count() {
        assert_eq!(next_attempts(1, 7, 7), 1);
        assert_eq!(next_attempts(2, 8, 8), 2);
        assert_eq!(next_attempts(2, 8, 9), 3);
    }

    #[test]
    fn requires_three_distinct_turns_and_elapsed_time() {
        assert!(!sufficient(1, 100, 100_000));
        assert!(!sufficient(2, 100, 100_000));
        assert!(!sufficient(3, 100, 60_099));
        assert!(sufficient(3, 100, 60_100));
    }

    #[test]
    fn clock_rollback_and_overflow_are_safe() {
        assert!(!sufficient(3, 90_000, 1_000));
        assert_eq!(next_attempts(u32::MAX, 1, 2), u32::MAX);
    }
}
