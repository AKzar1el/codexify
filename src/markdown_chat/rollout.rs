//! Conversation-local, append-only progress reports with bounded recovery reads.
use super::{ChatFile, io_error, open_regular, private_directory, private_options};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const DEFAULT_REMINDER_INTERVAL: u64 = 25;
pub const REMINDER_FIELD: &str = "rollout_checkpoint_required";
pub const REMINDER_DESCRIPTION: &str = "A progress checkpoint is due. Append current status, concrete progress and next steps using rollout_update before more work, then run the next task tool. A checkpoint never authorizes a final answer or ending the assistant turn. Omitted when no checkpoint is due.";
pub const RESTORE_GUIDANCE: &str = "Before task work in each new turn, call rollout_read to read up to five recent progress reports from this chat's rollout.md, then use the current goal if one is configured. When the progress journal is enabled (rollout_read reports if disabled), use rollout_update regularly to append status, progress and next steps. Treat reports as history; current instructions and live state take precedence. Setup and pairing verification must finish before task work.";
pub const ROTATE_BYTES: usize = 256 * 1024;
pub const RECENT_REPORTS: usize = 5;
const MAX_REPORT_BYTES: usize = 16 * 1024;
const MAX_READ_BYTES: usize = 64 * 1024;
const ROTATE_REPORTS: usize = 50;
const HEADER: &str = "# Chat rollout\n\nAppend progress reports with rollout_update. Read recent reports with rollout_read.\n\n";
const START: &str = "<!-- chat-rollout:v1 ";
const END: &str = "\n<!-- chat-rollout:v1:end -->\n";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportHeader {
    request_id: String,
    digest: String,
    created_at_ms: u64,
    work_calls: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportReceipt {
    header: ReportHeader,
    committed: bool,
}

fn receipt_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    let hash = format!("{:x}", Sha256::digest(id.as_bytes()));
    let root = dir.join("rollout-receipts");
    private_directory(&root)?;
    let folder = root.join(&hash[..2]);
    private_directory(&folder)?;
    Ok(folder.join(format!("{hash}.json")))
}
fn save_receipt(path: &Path, header: &ReportHeader, committed: bool) -> Result<(), String> {
    let receipt = ReportReceipt {
        header: header.clone(),
        committed,
    };
    save(
        path,
        &serde_json::to_string(&receipt).map_err(|_| "Could not encode progress receipt")?,
        true,
    )
}

#[derive(Clone)]
struct Report {
    header: ReportHeader,
    markdown: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ProgressState {
    version: u32,
    work_calls: u64,
    reported_calls: u64,
    reminded_calls: u64,
}
#[derive(Serialize)]
pub struct RolloutRead {
    pub rollout_file: String,
    pub report_count: usize,
    pub content: String,
    pub archive_count: usize,
}
#[derive(Serialize)]
pub struct RolloutReceipt {
    pub rollout_file: String,
    pub request_id: String,
    pub created_at_ms: u64,
    pub already_recorded: bool,
    pub rotated_archive: Option<String>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
fn read(path: &Path, max: usize) -> Result<String, String> {
    let file = open_regular(path, false)?;
    if file.metadata().map_err(io_error)?.len() > max as u64 {
        return Err(
            "Rollout file exceeds its size limit; restore or archive it before retrying".into(),
        );
    }
    let mut body = String::new();
    file.take(max as u64 + 1)
        .read_to_string(&mut body)
        .map_err(io_error)?;
    if body.len() > max {
        return Err("Rollout file changed beyond its size limit".into());
    }
    Ok(body)
}
fn save(path: &Path, text: &str, replace: bool) -> Result<(), String> {
    if path.exists() {
        let _ = open_regular(path, false)?;
    }
    let parent = path.parent().ok_or("Rollout has no parent directory")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
    file.write_all(text.as_bytes()).map_err(io_error)?;
    file.as_file().sync_all().map_err(io_error)?;
    if replace {
        file.persist(path).map_err(|e| io_error(e.error))?;
    } else {
        file.persist_noclobber(path)
            .map_err(|e| io_error(e.error))?;
    }
    #[cfg(unix)]
    File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(io_error)?;
    Ok(())
}
fn with_lock<T>(
    chat: &ChatFile,
    operation: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let dir = chat.path().parent().ok_or("Chat has no state directory")?;
    private_directory(dir.parent().ok_or("Chat has no state root")?)?;
    private_directory(dir)?;
    let lock_path = dir.join("rollout.lock");
    if std::fs::symlink_metadata(&lock_path).is_ok() {
        let _ = open_regular(&lock_path, false)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    private_options(&mut options);
    let lock = options.open(&lock_path).map_err(io_error)?;
    if !lock.metadata().map_err(io_error)?.is_file() {
        return Err("Rollout lock must be a regular file".into());
    }
    lock.lock().map_err(io_error)?;
    let active = dir.join("rollout.md");
    if !active.try_exists().map_err(io_error)? {
        save(&active, HEADER, false)?;
    }
    operation(dir)
}
pub(super) fn ensure(chat: &ChatFile) -> Result<(), String> {
    let active = chat.path().with_file_name("rollout.md");
    if active.try_exists().map_err(io_error)? {
        let _ = open_regular(&active, false)?;
        return Ok(());
    }
    with_lock(chat, |_| Ok(()))
}
fn state(dir: &Path) -> Result<ProgressState, String> {
    let path = dir.join("rollout-state.json");
    if !path.try_exists().map_err(io_error)? {
        return Ok(ProgressState {
            version: 1,
            ..Default::default()
        });
    }
    let state: ProgressState = serde_json::from_str(&read(&path, 4096)?)
        .map_err(|_| "Rollout reminder state is invalid; progress reports have been preserved")?;
    if state.version != 1
        || state.reported_calls > state.work_calls
        || state.reminded_calls > state.work_calls
    {
        return Err("Rollout reminder state is inconsistent".into());
    }
    Ok(state)
}
fn save_state(dir: &Path, state: &ProgressState) -> Result<(), String> {
    save(
        &dir.join("rollout-state.json"),
        &serde_json::to_string(state).map_err(|_| "Could not encode progress state")?,
        true,
    )
}
fn reports(body: &str) -> Result<Vec<Report>, String> {
    let mut remaining = body
        .strip_prefix(HEADER)
        .ok_or("Rollout header is invalid; the file was preserved")?;
    let mut reports = Vec::new();
    let mut ids = BTreeSet::new();
    while !remaining.is_empty() {
        let start = remaining.strip_prefix(START).ok_or(
            "Rollout contains an incomplete or unrecognized report; the file was preserved",
        )?;
        let (metadata, rest) = start
            .split_once(" -->\n")
            .ok_or("Rollout report header is incomplete")?;
        let header: ReportHeader =
            serde_json::from_str(metadata).map_err(|_| "Rollout report header is invalid")?;
        if !valid_id(&header.request_id)
            || header.digest.len() != 64
            || !header.digest.bytes().all(|b| b.is_ascii_hexdigit())
            || header.created_at_ms > i64::MAX as u64
            || !ids.insert(header.request_id.clone())
        {
            return Err("Rollout report identity is invalid".into());
        }
        let (markdown, rest) = rest
            .split_once(END)
            .ok_or("Rollout report is incomplete; the file was preserved")?;
        reports.push(Report {
            header,
            markdown: markdown.into(),
        });
        remaining = rest;
    }
    Ok(reports)
}
fn archives(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let folder = dir.join("rollouts");
    if !folder.try_exists().map_err(io_error)? {
        return Ok(vec![]);
    }
    private_directory(&folder)?;
    let pattern = regex::Regex::new(r"^rollout-[0-9TZ.\-]+-[a-f0-9]{16}\.md$")
        .expect("rollout archive pattern");
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(folder).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| pattern.is_match(name))
        {
            paths.push(entry.path());
        }
    }
    paths.sort();
    Ok(paths)
}
fn archived_report(dir: &Path, request_id: &str) -> Result<Option<Report>, String> {
    for path in archives(dir)?.into_iter().rev() {
        if let Some(report) = reports(&read(&path, ROTATE_BYTES)?)?
            .into_iter()
            .find(|report| report.header.request_id == request_id)
        {
            return Ok(Some(report));
        }
    }
    Ok(None)
}
impl ChatFile {
    pub async fn ensure_rollout(self: &Arc<Self>) -> Result<(), String> {
        self.run(ensure).await
    }
    pub async fn record_rollout_work(self: &Arc<Self>) -> Result<(), String> {
        self.run(|chat| {
            with_lock(chat, |dir| {
                let mut state = state(dir)?;
                state.work_calls = state
                    .work_calls
                    .checked_add(1)
                    .ok_or("Rollout work counter overflow")?;
                save_state(dir, &state)
            })
        })
        .await
    }
    pub async fn rollout_reminder(
        self: &Arc<Self>,
        interval: u64,
    ) -> Result<Option<String>, String> {
        self.run(move|chat|with_lock(chat,|dir|{
            if !(1..=10000).contains(&interval){return Err("Progress report interval must be between 1 and 10000 tool calls".into());}
            let mut state=state(dir)?;
            if state.work_calls-state.reported_calls<interval||state.work_calls-state.reminded_calls<interval{return Ok(None);}
            state.reminded_calls=state.work_calls;save_state(dir,&state)?;
            Ok(Some(format!("Progress checkpoint required: {} agent work tool calls have run since the last report. Before more work, call rollout_update with current status, concrete progress or findings, and next steps. Append to this chat's rollout.md at {}. Use a fresh request_id and reuse it only for an identical retry. After the checkpoint, run the next task tool; if input is needed call chat_await, or finish a resolved goal with goal_finish and its report. A checkpoint never authorizes a normal final answer or ending the assistant turn, including near an anticipated timeout. This reminder does not change the goal or deliver queued messages.",state.work_calls-state.reported_calls,dir.join("rollout.md").display())))
        })).await
    }
    pub async fn read_rollout(self: &Arc<Self>) -> Result<RolloutRead, String> {
        self.run(|chat| {
            with_lock(chat, |dir| {
                let archive_paths = archives(dir)?;
                let mut paths = vec![dir.join("rollout.md")];
                paths.extend(archive_paths.iter().rev().cloned());
                let mut recent = Vec::new();
                let mut bytes = 0;
                let mut seen = BTreeSet::new();
                'files: for path in paths {
                    for report in reports(&read(&path, ROTATE_BYTES)?)?.into_iter().rev() {
                        if !seen.insert(report.header.request_id.clone()) {
                            continue;
                        }
                        if recent.len() >= RECENT_REPORTS
                            || bytes + report.markdown.len() + 2 > MAX_READ_BYTES
                        {
                            break 'files;
                        }
                        bytes += report.markdown.len() + 2;
                        recent.push(report.markdown);
                    }
                }
                recent.reverse();
                Ok(RolloutRead {
                    rollout_file: dir.join("rollout.md").display().to_string(),
                    report_count: recent.len(),
                    content: recent.join("\n\n"),
                    archive_count: archive_paths.len(),
                })
            })
        })
        .await
    }
    pub async fn append_rollout(
        self: &Arc<Self>,
        request_id: String,
        status: String,
        progress: String,
        next_steps: String,
    ) -> Result<RolloutReceipt, String> {
        if !valid_id(&request_id) {
            return Err("Invalid rollout request_id".into());
        }
        if [&status, &progress, &next_steps]
            .iter()
            .any(|s| s.trim().is_empty() || s.contains(START) || s.contains(END))
            || status.len() + progress.len() + next_steps.len() > MAX_REPORT_BYTES
        {
            return Err("Provide nonempty status, progress and next_steps totaling at most 16 KiB, without reserved report markers".into());
        }
        self.run(move |chat| {
            with_lock(chat, |dir| {
                let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&(&status, &progress, &next_steps)).map_err(|_| "Could not identify progress report")?));
                let active = dir.join("rollout.md");
                let body = read(&active, ROTATE_BYTES)?;
                let previous = reports(&body)?;
                let receipt_path = receipt_path(dir, &request_id)?;
                let receipt: Option<ReportReceipt> = if receipt_path.try_exists().map_err(io_error)? {
                    Some(serde_json::from_str(&read(&receipt_path, 4096)?).map_err(|_| "Progress receipt is invalid; history was preserved")?)
                } else { None };
                if let Some(receipt) = &receipt
                    && (receipt.header.request_id != request_id || receipt.header.digest != digest)
                { return Err("This rollout request_id belongs to a different report".into()); }
                let mut state = state(dir)?;
                // Normal appends never scan old archives. Only an interrupted publication
                // needs to locate its report before finishing the durable receipt.
                let existing = if let Some(receipt) = &receipt {
                    if receipt.committed { Some(receipt.header.clone()) }
                    else {
                        previous.iter().find(|r| r.header.request_id == request_id).map(|r| r.header.clone())
                            .map_or_else(|| archived_report(dir, &request_id).map(|r| r.map(|r| r.header)), |r| Ok(Some(r)))?
                    }
                } else { previous.iter().find(|r| r.header.request_id == request_id).map(|r| r.header.clone()) };
                if let Some(existing) = existing {
                    if existing.digest != digest { return Err("This rollout request_id belongs to a different report".into()); }
                    if existing.work_calls > state.work_calls { return Err("Rollout counter is behind its report history; history was preserved".into()); }
                    save_receipt(&receipt_path, &existing, true)?;
                    if existing.work_calls > state.reported_calls {
                        state.reported_calls = existing.work_calls;
                        state.reminded_calls = state.reminded_calls.max(existing.work_calls);
                        save_state(dir, &state)?;
                    }
                    return Ok(RolloutReceipt {rollout_file:active.display().to_string(), request_id, created_at_ms:existing.created_at_ms, already_recorded:true, rotated_archive:None});
                }
                let header = receipt.map(|r| r.header).unwrap_or_else(|| ReportHeader {
                    request_id:request_id.clone(), digest, created_at_ms:crate::markdown_chat::now_ms(), work_calls:state.work_calls,
                });
                if header.work_calls > state.work_calls { return Err("Progress receipt counter is inconsistent; history was preserved".into()); }
                let time=chrono::DateTime::from_timestamp_millis(header.created_at_ms as i64).ok_or("Progress timestamp is invalid")?;
                let block=format!("{START}{} -->\n## {}\n\n### Status\n{}\n\n### Progress\n{}\n\n### Next steps\n{}\n{END}", serde_json::to_string(&header).map_err(|_| "Could not encode progress report")?, time.format("%Y-%m-%d %H:%M:%S UTC"), status.trim(), progress.trim(), next_steps.trim());
                save_receipt(&receipt_path, &header, false)?;
                let mut rotated_archive = None;
                let content = if body.len()+block.len()>ROTATE_BYTES || previous.len()>=ROTATE_REPORTS {
                    let folder=dir.join("rollouts"); private_directory(&folder)?;
                    let last=previous.last().ok_or("A single progress report exceeds the rotation limit")?;
                    let time=chrono::DateTime::from_timestamp_millis(last.header.created_at_ms as i64).ok_or("Archive timestamp is invalid")?;
                    let hash=format!("{:x}", Sha256::digest(body.as_bytes()));
                    let archive=folder.join(format!("rollout-{}-{}.md", time.format("%Y-%m-%dT%H-%M-%S%.3fZ"), &hash[..16]));
                    if archive.try_exists().map_err(io_error)? {
                        if read(&archive, ROTATE_BYTES)? != body { return Err("Rollout archive identity conflict; history was preserved".into()); }
                    } else { save(&archive, &body, false)?; }
                    rotated_archive=Some(archive.display().to_string()); format!("{HEADER}{block}")
                } else {body+&block};
                save(&active, &content, true)?;
                save_receipt(&receipt_path, &header, true)?;
                state.reported_calls=state.reported_calls.max(header.work_calls);
                state.reminded_calls=state.reminded_calls.max(header.work_calls);
                save_state(dir, &state)?;
                Ok(RolloutReceipt {rollout_file:active.display().to_string(), request_id, created_at_ms:header.created_at_ms, already_recorded:false, rotated_archive})
            })
        }).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> (tempfile::TempDir, Arc<ChatFile>) {
        let dir = tempfile::tempdir().unwrap();
        let chat = Arc::new(ChatFile::new(dir.path().join("chats/one/CHAT.md"), true));
        chat.ensure().await.unwrap();
        (dir, chat)
    }
    async fn report(chat: &Arc<ChatFile>, id: &str) -> RolloutReceipt {
        chat.append_rollout(
            id.into(),
            format!("status {id}"),
            format!("verified progress {id}"),
            format!("next steps {id}"),
        )
        .await
        .unwrap()
    }
    async fn calls(chat: &Arc<ChatFile>, n: usize) {
        for _ in 0..n {
            chat.record_rollout_work().await.unwrap();
        }
    }
    #[tokio::test]
    async fn report_file_is_per_chat_and_never_enters_the_chat_transcript() {
        let (_dir, chat) = fixture().await;
        assert!(chat.path().with_file_name("rollout.md").exists());
        let before = std::fs::read(chat.path()).unwrap();
        let saved = report(&chat, "one").await;
        assert!(!saved.already_recorded);
        let read = chat.read_rollout().await.unwrap();
        assert_eq!(read.report_count, 1);
        assert!(read.content.contains("### Status\nstatus one"));
        assert!(read.content.contains("### Progress\nverified progress one"));
        assert!(read.content.contains("### Next steps\nnext steps one"));
        assert_eq!(std::fs::read(chat.path()).unwrap(), before);
        assert!(chat.read(true).await.unwrap().text.is_empty());
        let other = Arc::new(ChatFile::new(
            chat.path()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("other/CHAT.md"),
            true,
        ));
        other.ensure().await.unwrap();
        assert_eq!(other.read_rollout().await.unwrap().report_count, 0);
    }
    #[tokio::test]
    async fn reminders_repeat_every_interval_and_survive_reopening() {
        let (_dir, chat) = fixture().await;
        for count in 1..=40 {
            chat.record_rollout_work().await.unwrap();
            let reminder = chat.rollout_reminder(20).await.unwrap();
            assert_eq!(reminder.is_some(), count % 20 == 0);
            assert!(chat.rollout_reminder(20).await.unwrap().is_none());
        }
        let reopened = Arc::new(ChatFile::new(chat.path().to_owned(), true));
        calls(&reopened, 19).await;
        assert!(reopened.rollout_reminder(20).await.unwrap().is_none());
        reopened.record_rollout_work().await.unwrap();
        assert!(
            reopened
                .rollout_reminder(20)
                .await
                .unwrap()
                .unwrap()
                .contains("rollout_update")
        );
        report(&reopened, "checkpoint").await;
        calls(&reopened, 49).await;
        assert!(reopened.rollout_reminder(50).await.unwrap().is_none());
        reopened.record_rollout_work().await.unwrap();
        assert!(reopened.rollout_reminder(50).await.unwrap().is_some());
    }
    #[tokio::test]
    async fn editing_the_interval_applies_to_already_accumulated_work() {
        let (_dir, chat) = fixture().await;
        calls(&chat, 25).await;
        assert!(chat.rollout_reminder(50).await.unwrap().is_none());
        assert!(chat.rollout_reminder(20).await.unwrap().is_some());
        assert!(chat.rollout_reminder(0).await.is_err());
        assert!(chat.rollout_reminder(10001).await.is_err());
    }
    #[tokio::test]
    async fn identical_retries_do_not_duplicate_reports_or_postpone_new_reminders() {
        let (_dir, chat) = fixture().await;
        calls(&chat, 20).await;
        let first = report(&chat, "request").await;
        calls(&chat, 19).await;
        let retry = report(&chat, "request").await;
        assert!(retry.already_recorded);
        assert_eq!(retry.created_at_ms, first.created_at_ms);
        assert_eq!(chat.read_rollout().await.unwrap().report_count, 1);
        assert!(
            chat.append_rollout(
                "request".into(),
                "changed".into(),
                "progress".into(),
                "next".into()
            )
            .await
            .is_err()
        );
        chat.record_rollout_work().await.unwrap();
        assert!(chat.rollout_reminder(20).await.unwrap().is_some());
    }
    #[tokio::test]
    async fn reports_rotate_without_losing_the_recent_context_or_archived_retry_identity() {
        let (_dir, chat) = fixture().await;
        for id in 0..51 {
            report(&chat, &format!("report-{id}")).await;
        }
        let read = chat.read_rollout().await.unwrap();
        assert_eq!(read.archive_count, 1);
        assert_eq!(read.report_count, 5);
        assert!(read.content.contains("status report-46"));
        assert!(read.content.contains("status report-50"));
        assert!(!read.content.contains("status report-45"));
        let active = read_report_file(&chat);
        assert!(!active.contains("status report-49"));
        assert!(active.contains("status report-50"));
        assert!(report(&chat, "report-0").await.already_recorded);
        assert_eq!(chat.read_rollout().await.unwrap().archive_count, 1);
    }
    fn read_report_file(chat: &ChatFile) -> String {
        std::fs::read_to_string(chat.path().with_file_name("rollout.md")).unwrap()
    }
    #[tokio::test]
    async fn byte_rotation_and_recovery_reads_are_bounded_by_complete_reports() {
        let (_dir, chat) = fixture().await;
        let large = "你好 🌳".repeat(1000);
        for id in 0..24 {
            chat.append_rollout(
                format!("large-{id}"),
                format!("Status {id}"),
                large.clone(),
                "Next step".into(),
            )
            .await
            .unwrap();
        }
        assert!(read_report_file(&chat).len() <= ROTATE_BYTES);
        let read = chat.read_rollout().await.unwrap();
        assert!(read.archive_count > 0);
        assert!(read.content.len() <= MAX_READ_BYTES);
        assert!((1..=RECENT_REPORTS).contains(&read.report_count));
        assert_eq!(
            read.content.matches("### Next steps\nNext step").count(),
            read.report_count
        );
    }
    #[tokio::test]
    async fn concurrent_updates_and_counters_do_not_overwrite_each_other() {
        let (_dir, chat) = fixture().await;
        let mut tasks = vec![];
        for id in 0..30 {
            let chat = chat.clone();
            tasks.push(tokio::spawn(async move {
                chat.record_rollout_work().await.unwrap();
                report(&chat, &format!("concurrent-{id}")).await;
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(reports(&read_report_file(&chat)).unwrap().len(), 30);
        let state = state(chat.path().parent().unwrap()).unwrap();
        assert_eq!(state.work_calls, 30);
        assert_eq!(state.reported_calls, 30);
    }
    #[tokio::test]
    async fn retry_repairs_a_crash_after_report_publication_without_dropping_later_work() {
        let (_dir, chat) = fixture().await;
        calls(&chat, 20).await;
        report(&chat, "saved-before-crash").await;
        with_lock(&chat, |dir| {
            let mut s = state(dir)?;
            s.reported_calls = 0;
            s.reminded_calls = 0;
            save_state(dir, &s)
        })
        .unwrap();
        calls(&chat, 5).await;
        assert!(report(&chat, "saved-before-crash").await.already_recorded);
        let s = state(chat.path().parent().unwrap()).unwrap();
        assert_eq!(s.work_calls, 25);
        assert_eq!(s.reported_calls, 20);
        assert_eq!(s.reminded_calls, 20);
    }
    #[tokio::test]
    async fn corrupt_progress_files_fail_closed_without_breaking_chat_messages() {
        let (_dir, chat) = fixture().await;
        report(&chat, "saved").await;
        let path = chat.path().with_file_name("rollout.md");
        let valid = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("{valid}incomplete edit")).unwrap();
        assert!(chat.read_rollout().await.is_err());
        assert!(
            chat.append_rollout(
                "new".into(),
                "status".into(),
                "progress".into(),
                "next".into()
            )
            .await
            .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{valid}incomplete edit")
        );
        chat.append_user("steer".into(), "Continue the chat".into())
            .await
            .unwrap();
        assert!(
            chat.read(true)
                .await
                .unwrap()
                .text
                .contains("Continue the chat")
        );
        std::fs::write(chat.path().with_file_name("rollout-state.json"), "{").unwrap();
        assert!(chat.record_rollout_work().await.is_err());
        assert!(chat.rollout_reminder(20).await.is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{valid}incomplete edit")
        );
    }
    #[tokio::test]
    async fn invalid_or_oversized_reports_do_not_change_the_log() {
        let (_dir, chat) = fixture().await;
        let before = read_report_file(&chat);
        for (id, status) in [("../escape", "status"), ("empty", " "), ("marker", START)] {
            assert!(
                chat.append_rollout(id.into(), status.into(), "progress".into(), "next".into())
                    .await
                    .is_err()
            );
        }
        assert!(
            chat.append_rollout(
                "oversize".into(),
                "x".repeat(MAX_REPORT_BYTES),
                "progress".into(),
                "next".into()
            )
            .await
            .is_err()
        );
        assert_eq!(read_report_file(&chat), before);
    }
    #[tokio::test]
    async fn private_queued_messages_are_not_read_or_released_by_checkpoints() {
        let (_dir, chat) = fixture().await;
        // Keep the agent online: blocked offline chats intentionally release
        // queued messages through their ordinary wake-up monitor.
        chat.record_agent_call(crate::markdown_chat::now_ms())
            .await
            .unwrap();
        std::fs::write(
            chat.path().with_file_name("automation.json"),
            r#"{"goal":{"status":"blocked"}}"#,
        )
        .unwrap();
        chat.queue_user_message("private".into(), "secret future request".into(), vec![])
            .await
            .unwrap();
        report(&chat, "visible").await;
        calls(&chat, 20).await;
        assert!(
            !chat
                .read_rollout()
                .await
                .unwrap()
                .content
                .contains("secret future")
        );
        assert!(
            !chat
                .rollout_reminder(20)
                .await
                .unwrap()
                .unwrap()
                .contains("secret future")
        );
        assert_eq!(chat.queued_messages().await.unwrap().len(), 1);
        assert!(chat.read(true).await.unwrap().text.is_empty());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_progress_files_and_archive_directories_are_rejected() {
        use std::os::unix::fs::symlink;
        let (root, chat) = fixture().await;
        let outside = root.path().join("outside");
        std::fs::write(&outside, "untouched").unwrap();
        let log = chat.path().with_file_name("rollout.md");
        std::fs::remove_file(&log).unwrap();
        symlink(&outside, &log).unwrap();
        assert!(chat.read_rollout().await.is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "untouched");
        std::fs::remove_file(&log).unwrap();
        chat.ensure().await.unwrap();
        let directory = root.path().join("outside-dir");
        std::fs::create_dir(&directory).unwrap();
        symlink(&directory, chat.path().with_file_name("rollouts")).unwrap();
        assert!(chat.read_rollout().await.is_err());
    }
    #[tokio::test]
    async fn pending_receipts_reconcile_publication_after_the_report_has_rotated() {
        let (_dir, chat) = fixture().await;
        report(&chat, "interrupted").await;
        with_lock(&chat, |dir| {
            let path = receipt_path(dir, "interrupted")?;
            let mut r: ReportReceipt = serde_json::from_str(&read(&path, 4096)?).unwrap();
            r.committed = false;
            save_receipt(&path, &r.header, false)
        })
        .unwrap();
        for id in 0..50 {
            report(&chat, &format!("following-{id}")).await;
        }
        assert!(report(&chat, "interrupted").await.already_recorded);
        let all = with_lock(&chat, |dir| {
            let mut n = reports(&read(&dir.join("rollout.md"), ROTATE_BYTES)?)?.len();
            for p in archives(dir)? {
                n += reports(&read(&p, ROTATE_BYTES)?)?.len();
            }
            Ok(n)
        })
        .unwrap();
        assert_eq!(all, 51);
    }
    #[tokio::test]
    async fn a_new_report_does_not_scan_unrelated_old_archives() {
        let (_dir, chat) = fixture().await;
        let folder = chat.path().with_file_name("rollouts");
        private_directory(&folder).unwrap();
        std::fs::write(
            folder.join("rollout-2020-01-01T00-00-00.000Z-aaaaaaaaaaaaaaaa.md"),
            "damaged old archive",
        )
        .unwrap();
        assert!(!report(&chat, "new-status").await.already_recorded);
        assert!(report(&chat, "new-status").await.already_recorded);
        assert!(read_report_file(&chat).contains("status new-status"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn receipt_directory_cannot_redirect_progress_writes() {
        let (root, chat) = fixture().await;
        let outside = root.path().join("outside-receipts");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, chat.path().with_file_name("rollout-receipts"))
            .unwrap();
        assert!(
            chat.append_rollout(
                "blocked".into(),
                "status".into(),
                "progress".into(),
                "next".into()
            )
            .await
            .is_err()
        );
        assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
    }
}
