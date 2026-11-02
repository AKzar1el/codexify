# Revenue Shot Research Inbox V3 — continuous evidence-backed research

**Status:** Research-only scheduled prompts updated for all six projects on November 2, 2026. The old inbox module is installed locally; this revised unlimited/revision-history module is implemented and tested on PR #4, **not yet deployed**. Do not treat a CI result as a successful unattended queue write.

## Architecture

Single existing God v5 / Codexify tunnel; six original hourly Research Shot tasks; Overwatch unchanged. No additional server or paid service.

Fixed local inbox (never inside a source repo):

    C:\Users\Tomi\.codexify\revenue-shot-research\

- tasks.json — canonical status, original findings, all task revisions and owner status events.
- tasks.txt — aggregate active task view, regenerated from tasks.json.
- history.txt — complete task evolution, including old evidence/fix/test proposals and owner status changes.
- godprompt/, gsc/, geo/, webvalidator/, trendpulse/, nofax/ — per-project tasks.txt and history.txt views.
- .tasks.lock — exclusive writer lock; a stale lock is not automatically broken.

All historical events are retained in tasks.json. The text files are generated views, not an editable database. Finished or rejected tasks remain in history even when no longer shown in active tasks.txt.

## What each hourly worker does

Research as many independently supported useful improvements as time, reliable source access, and external provider rate limits allow. Do not stop merely because two tasks have already been found in the day. A research finding needs a specific issue, root-cause key, evidence locator, user impact, minimal change, and independent verification plan. A plausible hypothesis must remain labeled as such; no imaginary code run or security impact.

The existing native write action, propose_research_task, is the sole supported automated queue writer:
- New project + issue_key => QUEUED_FOR_HUMAN_REVIEW, stable task ID, owner status OPEN.
- Existing same issue_key with **materially changed fields** and a new run_key => TASK_REFINED. Preserve the original identity and created timestamp, increment the revision, and write the complete previous fields into history. An unchanged candidate is a duplicate, not a new task.
- An already DONE/REJECTED task cannot be reopened by a scheduled worker.
- A reused run_key with different content cannot change a task.
- If the native tool is missing or explicitly denied, do NOT fall back to shell, generic file tools, browser or another connector. Report UNSAVED_LOCAL_TASKS_TXT in the scheduled run.
- Previous valuable unsaved proposals should be independently rechecked and backfilled, not counted as consumed daily quota.

When a researched path is stale or blocked, record the dead end in the scheduled run result, stop retrying that path, and investigate another independent frontier. Repeat this process while useful time and approved sources remain. It is impossible to guarantee that every avenue yields a new finding; refuse filler, fabricated validations and circular audits.

## Safe local limits

**No arbitrary proposal-per-day, open-task-count, total-task-count, or research-frontier quotas.** The fixed field sizes and 32 MiB maximum canonical/view file size are safeguards against unbounded file growth, not business quotas. If the inbox reaches that filesystem bound, preserve it and require a separate, owner-approved archival migration. Do not silently delete task history, disable source verification, or bypass host approvals.

All writes remain scoped to the fixed inbox, with exclusive lock, atomic same-folder replacement and readback hashes. The canonical JSON is written before derived text views, so a later identical proposal can rebuild text files after an interrupted write. The server checks source paths and queue identity. JSON history is not independently tamper-proof; protect it with ordinary local backups and permissions.

## Owner review

Use the owner-only interactive review CLI (fleet-research-owner-review.mjs) with exact task ID, typed confirmation, and compare-and-swap state SHA. The scheduled agents cannot approve or complete their own work. Interactive implementation still requires independent tests and explicit owner approval where necessary. Worker proposals are research, never deployed code.

## Deploying the new revision

The initial V1 research module is installed in the operator's sidecar, and the current direct action tools have been observed in a manual GodPrompt run. Installing a new version of the module is a separate owner-approved update; updating scheduled prompts alone **does not** replace the loaded module.

At a safe idle boundary, back up the installed module, server, projects.json and private Codexify bridge configuration. Upgrade only if the module matches the exact previously reviewed known baseline and no installed files changed during the preflight. Verify Node syntax, original tool catalog and existing read-only capabilities, then restart the existing service and refresh the ChatGPT God v5 connection. Test one newly created proposal, a substantive same-key refinement, revision history and cross-project separation using authorized native actions.

Do not reset journals, remove worktrees with unmerged code, alter Git release state, reinstall Codexify, change seven schedule times, or retry host-denied operations by using different tools.

## Operational acceptance

A real unattended hourly research wake must create or refine an actual task in the local queue, verified by tasks.json SHA and corresponding tasks.txt/history.txt views. A plain scheduler "completed" status or successful read_research_tasks call does **not** prove that writing was approved or successful.
