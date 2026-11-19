# Minimal v2.4 single-lane recovery candidate

This branch starts from the official Codexify v2.4.0 source commit
`b14eacde810531a451535ee546ca7e07c65c5a1d`. It intentionally does **not** import the experimental two-browser
integration, global primary-goal pin, second companion/watchdog, or private
profile logic.

The native v2.4 scheduler defaults to one browser action page and protects
dispatch with a one-permit semaphore. Other saved goals remain durable and
eligible in their existing queue; no second browser process or goal pin is
needed to serialize actions.

## Changes

- Preserve state publication through short Windows sharing locks: if a
  read-only no-op comparison is blocked by a genuine Win32 sharing violation,
  let the existing bounded atomic-replacement retry handle the lock. Other
  file-read errors still fail closed.
- Test transient/persistent sharing violations with old state preserved.
- Make an existing ambiguous Git checkout test compare canonicalized paths
  on Windows, without changing real checkout selection.
- Retry a brief Windows status-file rename gap during self-update reads,
  bounded to missing-file or sharing-violation errors.
- Run targeted and full library tests on Windows and stage a native binary,
  without performing a service installation.

## Production cutover gates

1. Verify the current authenticated primary companion and native service are
   healthy, and confirm exactly one configured browser action lane.
2. Preserve the existing service binary, version-matched browser runtime,
   config and all original goal/journal/action receipt files.
3. Verify there is no actively dispatched or uncertain accepted browser Send,
   and no unverified terminal/renewal handoff in the intended maintenance
   interval. A queued action is not proof of being safely idle.
4. Use only the official version-matched browser companion; never install the
   older two-browser candidate or restart another agent's Chrome profile.
5. Upgrade via a guarded verified native service procedure, run doctor,
   confirm authenticated browser health, and verify read-only goal continuity
   before resuming admissions. Roll back executable/runtime if health fails,
   without rewriting goal journals or replaying accepted Sends.

**No production change is authorized or executed by this branch.**
