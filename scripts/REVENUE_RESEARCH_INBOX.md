# Revenue Shot Research Inbox V1

Status: SOURCE AND SYNTHETIC CI ONLY. Not installed into live God v5 and not active in the six schedules.

## Purpose

Keep all six Revenue Shot workers and the original single God v5 tunnel. Workers research actionable, evidence-backed improvements and add proposals to one local file. The owner then selects tasks for interactive implementation and testing. Overwatch remains unchanged.

Fixed output root for owner-approved activation:
C:\Users\Tomi\.codexify\revenue-shot-research

Files:
- tasks.txt: generated, human-readable review queue; proposal only
- tasks.json: durable canonical queue state, identity and original evidence
- .tasks.lock: temporary exclusive writer lock; never auto-break if stale

The root must exist before enabling the tool, be configured privately, and be outside every project checkout.

## Tool boundary

The V3 direct MCP bridge has two opt-in methods behind enableResearchInbox=false by default:
- read_research_tasks: read-only queue summary.
- propose_research_task: host-approved bounded write ONLY to the fixed inbox.

No arbitrary filesystem path, command, executable, Git ref, provider API, package installer, source-file edit, deployment, or canonical run-journal write is accepted by either tool. The write method is correctly annotated as not read-only.

Finding fields include fixed project name, stable issue_key, original run_key, P0-P3, HIGH/MEDIUM confidence, impact, precise problem, at least one concrete path or URL evidence, suggested implementation and independent validation instructions.

Deduplication uses SHA-256(project + issue_key) as a stable ID. Limit to two new tasks per project per UTC day, 36 open and 200 total. Reject unsafe path inputs, malformed issue keys, missing evidence, stale locks, changed state identity, untrusted target roots and unbounded fields. Each successful write produces its own read-back verified tasks.txt SHA-256. A duplicate never creates a second task; if tasks.txt was lost after the durable JSON write, exact duplicate replay may repair the generated view.

Workers must not claim that a proposal was implemented or that a scheduled run alone proved the file was written.

## Suggested research override (activate only after a real writer canary)

RESEARCH_ONLY_OVERRIDE_V1 supersedes ONLY the old objective to autonomously edit/publish code; preserve all original safety, ownership, compliance, financial, archived kernel and scheduler requirements.

On each existing hourly wake, investigate one or two concrete, project-relevant issues or profitable/free opportunities. Prefer validated source and authoritative links. Distinguish verified defect, documented limitation and unconfirmed hypothesis. Report only genuinely novel actionable findings. For each worthy new finding, call the operator-approved propose_research_task tool with the exact fixed project ID and run key, stable root-cause issue key, evidence, priority, expected impact, minimal implementation and independent tests. Confirm an actual QUEUED_FOR_HUMAN_REVIEW receipt and read-only queue readback. If no meaningful finding exists, do not write filler. Do not run code, use shells/package managers, push/merge/deploy, write canonical journals, change worktrees, call previously denied operations by another route, or alter your own schedule.

The existing prompts are very long (roughly 51-65 KiB). Do not blindly concatenate and overflow them. Verify byte-for-byte backups and preserve the original instructions before a carefully controlled replacement. Do not update prompts before the queue writer actually works from the hosted runtime.

## Owner-controlled deployment gate

1. At an idle window, independently inspect the live Codexify 2.3.25 sidecar, config and allowed existing MCP actions. Back up all relevant private files.
2. Create the fixed dedicated research directory, not inside a project root.
3. Stage the reviewed new module and fleet-server-v3 integration in the existing single sidecar; add only enableResearchInbox=true and the fixed researchInboxRoot to private operator config. Existing source and journal write gates remain unchanged.
4. Validate the direct MCP tool catalog in isolation; restart only the existing service with explicit operator approval and refresh the connector tool list.
5. Submit one labeled synthetic canary through the native research writer and read the exact tasks.txt on the owner's Windows machine. Verify no source/journal changed.
6. Test one authentic unattended scheduled research wake. If the host denies the new tool, roll back and report RESEARCH_QUEUE_HOST_DENIED without another execution-route attempt.
7. Only after the canary succeeds, migrate the six existing prompts from coding to research-only, preserving original safety instructions, schedules, and each task identity. Overwatch remains separate.

## Daily review

Open tasks.txt. Each entry has a stable ID, project, priority, confidence, first seen, problem, impact, evidence, suggested implementation and tests. Ask ChatGPT to implement chosen IDs interactively with approved tools, independent code review and regression tests.

tasks.txt is a derived view: do not edit its checkboxes, because regeneration may overwrite them. Human decisions and closing items use the separate interactive owner-only CLI (fleet-research-owner-review.mjs), which is never exposed as an MCP action. With REVENUE_SHOT_PROJECTS_FILE set to the approved private config, an owner can run: node fleet-research-owner-review.mjs TASK_ID APPROVED (or DEFERRED, DONE, REJECTED). The command requires a real terminal and an exact typed confirmation; it performs a SHA-256 CAS check and refuses to reopen final DONE/REJECTED items. None of the scheduled workers receives approval or completion authority.

Operational acceptance is NOT a CI pass alone: one real unattended agent must write one real proposal locally, it must survive readback, and the next run must dedupe without repeating or implementing the task.
