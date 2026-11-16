# Secondary companion watchdog contract (design only)

This is a proposed read-only interface for three to five independently provisioned browser profiles. It is not enabled or deployed.

- Identity: each slot has a stable, locally configured slot ID, expected isolated profile path fingerprint, companion instance nonce, and authenticated account fingerprint. Never trust a descriptor PID alone: Windows can reuse it for an unrelated process.
- Probe: authenticate each companion's loopback `/v1/liveness`, `/v1/health`, and `/v1/send-gate/status`; compare build, instance identity, expected account fingerprint and shared Send-gate fingerprint. Do not read or replicate cookies.
- State: report `healthy`, `busy`, `suspect`, `dead`, or `identity_mismatch`, with observation timestamp and reason. Two failed probes may mark `suspect`; do not infer death or ownership from a PID. Never auto-restart a busy or unverified instance.
- Recovery: an accepted Send remains immutable and non-replayable after stream disconnect or companion death. Reattach to the original action ID and cursor when the same instance is alive. Across instance replacement, require native durable action reconciliation and exact same-account, same-conversation assistant-turn proof; a transport ACK, idle tab, or new process alone is not completion evidence.
- Safety: no automatic profile creation, account migration, duplicate Send, goal admission, provider quota bypass, or Rust scheduler mutation. Any future restart mechanism requires owner approval, profile-lock checks and a separate staged rollout.

Synthetic contract fixture: `control-server.test.ts` exercises event-subscriber disconnect after `send_accepted`, reattachment by action ID, and idempotent execute without replay. It does not simulate cross-process durable recovery; that remains native-owner work.
