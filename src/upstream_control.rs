//! Per-connection admission and failure containment; never retries tool calls.
use crate::types::McpRequestLimits;
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::{Semaphore, SemaphorePermit};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct State {
    failures: u32,
    open_until: Option<Instant>,
    probe_active: bool,
    last_outcome: Option<&'static str>,
}

pub(crate) struct UpstreamControl {
    limits: McpRequestLimits,
    active: Semaphore,
    pending: Semaphore,
    state: Mutex<State>,
    unavailable: tokio::sync::watch::Sender<bool>,
}

impl Default for UpstreamControl {
    fn default() -> Self {
        Self::new(McpRequestLimits::default())
    }
}

impl UpstreamControl {
    pub(crate) fn health_result(&self, healthy: bool) {
        let mut state = self.state.lock().unwrap();
        state.last_outcome = Some(if healthy {
            "health_response_received"
        } else {
            "health_probe_failed"
        });
        if healthy {
            state.failures = 0;
            state.open_until = None;
            self.unavailable.send_replace(false);
        } else {
            state.failures = state.failures.saturating_add(1);
            if state.failures >= self.limits.failure_threshold {
                state.open_until =
                    Some(Instant::now() + Duration::from_millis(self.limits.recovery_delay_ms));
                self.unavailable.send_replace(true);
            }
        }
    }
    pub(crate) fn new(limits: McpRequestLimits) -> Self {
        Self {
            active: Semaphore::new(limits.max_concurrent_requests),
            pending: Semaphore::new(limits.max_concurrent_requests + limits.max_pending_requests),
            limits,
            state: Mutex::new(State::default()),
            unavailable: tokio::sync::watch::channel(false).0,
        }
    }
    pub(crate) async fn wait_unavailable(&self) {
        let mut receiver = self.unavailable.subscribe();
        loop {
            if *receiver.borrow_and_update() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
    fn check(state: &State) -> Result<(), String> {
        if let Some(until) = state.open_until {
            let remaining = until.saturating_duration_since(Instant::now()).as_millis();
            if remaining > 0 {
                return Err(format!(
                    "upstream is unresponsive; retry admission is paused for {remaining} ms. Earlier operations may still be running."
                ));
            }
            if state.probe_active {
                return Err("upstream recovery probe is already in progress; earlier operations may still be running.".into());
            }
        }
        Ok(())
    }
    pub(crate) async fn admit(
        &self,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<Admission<'_>, String> {
        if cancellation.is_cancelled() {
            return Err("cancelled by downstream client before dispatch".into());
        }
        Self::check(&self.state.lock().unwrap())?;
        let pending = self
            .pending
            .try_acquire()
            .map_err(|_| "upstream queue is full; request was not dispatched".to_string())?;
        let active = crate::audit::stage("upstream_queue", async {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err("cancelled by downstream client before dispatch".to_string()),
                _ = tokio::time::sleep_until(deadline) => Err("upstream queue deadline exceeded; request was not dispatched".to_string()),
                permit = self.active.acquire() => Ok(permit.expect("upstream semaphore stays open")),
            }
        }).await?;
        let mut state = self.state.lock().unwrap();
        Self::check(&state)?;
        let probe = state.open_until.is_some();
        if probe {
            state.probe_active = true;
        }
        Ok(Admission {
            control: self,
            _active: active,
            _pending: pending,
            started: Instant::now(),
            probe,
            outcome: None,
        })
    }
    pub(crate) fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap();
        let active = self
            .limits
            .max_concurrent_requests
            .saturating_sub(self.active.available_permits());
        let admitted = (self.limits.max_concurrent_requests + self.limits.max_pending_requests)
            .saturating_sub(self.pending.available_permits());
        json!({"state": if state.probe_active {"probing"} else if state.open_until.is_some() {"unresponsive"} else if state.failures > 0 {"degraded"} else {"connected"},
            "activeRequests":active,"queuedRequests":admitted.saturating_sub(active),"consecutiveFailures":state.failures,
            "retryAfterMs":state.open_until.map(|until| until.saturating_duration_since(Instant::now()).as_millis() as u64).unwrap_or(0),
            "lastOutcome":state.last_outcome})
    }
}

pub(crate) struct Admission<'a> {
    control: &'a UpstreamControl,
    _active: SemaphorePermit<'a>,
    _pending: SemaphorePermit<'a>,
    started: Instant,
    probe: bool,
    outcome: Option<&'static str>,
}
impl Admission<'_> {
    pub(crate) fn is_probe(&self) -> bool {
        self.probe
    }
    pub(crate) fn complete(&mut self, outcome: &'static str) {
        self.outcome = Some(outcome);
    }
}
impl Drop for Admission<'_> {
    fn drop(&mut self) {
        let outcome = self.outcome.unwrap_or("completion_unconfirmed");
        let mut state = self.control.state.lock().unwrap();
        state.last_outcome = Some(outcome);
        if self.probe {
            state.probe_active = false;
        }
        if outcome == "response_received" {
            state.failures = 0;
            state.open_until = None;
            self.control.unavailable.send_replace(false);
        } else if matches!(outcome, "deadline_exceeded" | "transport_failed")
            || self.started.elapsed()
                >= Duration::from_millis(self.control.limits.slow_cancellation_ms)
        {
            state.failures = state.failures.saturating_add(1);
            if self.probe || state.failures >= self.control.limits.failure_threshold {
                state.open_until = Some(
                    Instant::now() + Duration::from_millis(self.control.limits.recovery_delay_ms),
                );
                self.control.unavailable.send_replace(true);
            }
        } else if self.probe {
            state.open_until =
                Some(Instant::now() + Duration::from_millis(self.control.limits.recovery_delay_ms));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn failures_pause_calls_and_recovery_allows_only_one_probe() {
        let limits = McpRequestLimits {
            failure_threshold: 2,
            recovery_delay_ms: 20,
            ..Default::default()
        };
        let control = UpstreamControl::new(limits);
        let token = CancellationToken::new();
        for _ in 0..2 {
            let mut admission = control
                .admit(Instant::now() + Duration::from_secs(1), &token)
                .await
                .unwrap();
            admission.complete("deadline_exceeded");
        }
        assert_eq!(control.snapshot()["state"], "unresponsive");
        assert!(
            control
                .admit(Instant::now() + Duration::from_secs(1), &token)
                .await
                .is_err()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
        let mut probe = control
            .admit(Instant::now() + Duration::from_secs(1), &token)
            .await
            .unwrap();
        assert!(
            control
                .admit(Instant::now() + Duration::from_secs(1), &token)
                .await
                .is_err()
        );
        probe.complete("response_received");
        drop(probe);
        assert_eq!(control.snapshot()["state"], "connected");
    }

    #[tokio::test]
    async fn admission_limits_do_not_spread_to_another_upstream() {
        let control = UpstreamControl::new(McpRequestLimits {
            max_concurrent_requests: 1,
            max_pending_requests: 0,
            ..Default::default()
        });
        let token = CancellationToken::new();
        let mut first = control
            .admit(Instant::now() + Duration::from_secs(1), &token)
            .await
            .unwrap();
        assert!(
            control
                .admit(Instant::now() + Duration::from_secs(1), &token)
                .await
                .err()
                .unwrap()
                .contains("queue is full")
        );
        let other = UpstreamControl::default();
        let mut independent = other
            .admit(Instant::now() + Duration::from_secs(1), &token)
            .await
            .unwrap();
        independent.complete("response_received");
        first.complete("response_received");
    }

    #[tokio::test]
    async fn queued_cancellation_does_not_count_as_an_upstream_failure() {
        let control = UpstreamControl::new(McpRequestLimits {
            max_concurrent_requests: 1,
            max_pending_requests: 1,
            ..Default::default()
        });
        let token = CancellationToken::new();
        let mut first = control
            .admit(Instant::now() + Duration::from_secs(1), &token)
            .await
            .unwrap();
        let cancellation = CancellationToken::new();
        let work = control.admit(Instant::now() + Duration::from_secs(1), &cancellation);
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            cancellation.cancel();
        };
        let (result, ()) = tokio::join!(work, cancel);
        assert!(result.err().unwrap().contains("before dispatch"));
        assert_eq!(control.snapshot()["consecutiveFailures"], 0);
        first.complete("response_received");
    }
}
