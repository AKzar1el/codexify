# Unified Codexify v2.4.0: two independent browser-process lanes (Windows)

This is a source-only candidate and a release safety checklist, not authority to
restart the installed service or replay an accepted Send.

## Version and scope

- Upstream Codexify v2.4.0 at b14eacde810531a451535ee546ca7e07c65c5a1d.
- One independently authenticated secondary Chromium browser for the pinned canary
  task, and a primary companion for the pinned pilot task.
- Within each process, v2.4.0's browser-pool, tab ownership, and response recovery
  are preserved. This candidate does NOT turn on five autonomous goal seats.
- Browser profiles remain private and distinct. Both may authenticate to the
  same ChatGPT account but may not share a user-data-dir.

## Guaranteed fail-closed behaviors

1. Pilot task keys must be distinct, exactly 64 lowercase hex chars, with one
   page lane per physical browser for this opt-in pilot.
2. Separate companion descriptors, process IDs, private Chrome profiles, matching
   account identity and a shared Send-gate digest are prerequisites to admissions.
3. The authenticated /v1/send-gate/status endpoint reveals only the digest.
   The lock is held across final destination/draft/account validation, clicking
   Send, and semantic acceptance. Uncertain accepted Sends are never repeated.
4. Pairing-picker control reacquisition is bounded to one verified pre-Send
   timeout on the original unchanged conversation.
5. Cloudflare cf-mitigated: challenge fails closed; ordinary 403/429 preserve
   upstream error and cooldown handling.
6. submission_complete is a provider submission receipt, not proof that the
   model finished generating a complete response.

## Build and test

From this isolated integration worktree (not the active original checkout):

    cargo check --lib --offline -j 2
    cargo build --bin codexify --offline -j 2
    cd browser-companion
    node node_modules/typescript/bin/tsc --noEmit --project tsconfig.json
    bun test tests/navigation.test.ts tests/pairing-submit.test.ts tests/browser-window.test.ts tests/chrome-surface.test.ts tests/control-server.test.ts tests/package-stage.test.ts
    node --test tests/provider-send-gate.node.cjs tests/two-lane-browser-canary.node.cjs tests/challenge-navigation.node.cjs tests/pairing-retry.node.cjs tests/archive-tool.node.cjs tests/bun-executable.node.cjs
    bun run build
    node scripts/package.cjs
    node scripts/smoke-package.cjs

The independent read-only release verifier validates ZIP paths, expansion bounds,
manifest build/protocol, Chromium payload, native executable version and hashes:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/audit-unified-v240-release.ps1 -SelfTest

Supply exact artifact, binary, and protocol schema paths for a release audit.
It never touches the service.

## Cutover prerequisites and rollback policy

Do NOT run scripts/install-local-two-browser-upgrade.ps1 for this v2.4.0
candidate: that script and two-browser-secondary-maintenance.ps1 still
target browser/runtime/2.3.29. They are preserved only for the working
v2.3.29 pilot, not a safe version-aware major-minor upgrade.

A v2.4.0 activation requires a separately reviewed and tested transactional
installer running in a separate elevated PowerShell after a verified fleet-quiet
window. It must stage browser/runtime/2.4.0 side-by-side, preserve the native
binary, old runtime, both private profiles, descriptors, configuration, and
accepted action records, and verify no held Send lock or ambiguous action.
Only process trees positively proven to be the two Codexify companions may stop.
After the native executable swap, both physical companions must restart with
their original distinct profiles and the identical shared gate; account,
runtime build, protocol, process identity, and service health must be checked.
Any failure restores the old executable and both old browser processes without
touching goals, replaying Sends, or rewriting their journals.

Passing source tests and a packaged-browser smoke do not alone constitute a
successful production upgrade.