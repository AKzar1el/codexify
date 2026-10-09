use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::project_bindings::ConversationIdentity;
use crate::types::AppConfig;

const STATE_VERSION: u32 = 1;
const MAX_STATE_BYTES: u64 = 1024 * 1024;
const MAX_PRIVATE_TEXT_BYTES: usize = 64 * 1024;
const MAX_GOAL_RESULT_BYTES: usize = 4096;
const MAX_CHAT_MIRROR_IDS: usize = 1024;
const STATE_FILE: &str = "automation.json";
const LOCK_FILE: &str = "automation.lock";

pub const MAX_GOAL_BYTES: usize = 10 * 1024;
pub const PAIRING_REFERENCE_TTL_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Configured,
    Active,
    Completed,
    Blocked,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GoalRecord {
    pub revision: u64,
    pub markdown: String,
    pub status: GoalStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub summary: Option<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalFinish {
    Completed { summary: Option<String> },
    Blocked { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PendingPairing {
    pub generation: u64,
    pub owner_generation: u64,
    pub reference_digest: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct PairingState {
    pub candidate_url: Option<String>,
    pub canonical_url: Option<String>,
    pub generation: u64,
    pub verified_owner_generation: Option<u64>,
    pub verified_at_ms: Option<u64>,
    pub pending: Option<PendingPairing>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingIssue {
    pub reference: String,
    pub generation: u64,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct SelectionState {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub catalog_revision: Option<String>,
    pub account_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationActionKind {
    PairVerify,
    OfflineChat,
    OfflineGoal,
    OfflineCombined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AutomationActionStatus {
    Unpaired,
    Unverified,
    Queued,
    Navigating,
    Sending,
    Generating,
    #[default]
    Idle,
    ApprovalRequired,
    AuthenticationRequired,
    RateLimited,
    Interference,
    Ambiguous,
    Stalled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct AutomationActionState {
    pub id: Option<String>,
    pub kind: Option<AutomationActionKind>,
    pub status: AutomationActionStatus,
    pub pairing_generation: Option<u64>,
    pub goal_revision: Option<u64>,
    pub last_error: Option<String>,
    pub last_stable_answer: Option<String>,
    pub updated_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct ChatMirrorState {
    pub last_accepted_batch_id: Option<String>,
    pub message_ids: Vec<String>,
    pub transcript_revision_at_start: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct GoalWakeState {
    pub activity_epoch: Option<String>,
    pub activity_sequence: Option<u64>,
    pub nudged_epoch: Option<String>,
    pub nudged_sequence: Option<u64>,
    pub last_nudged_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct AutomationTaskState {
    pub version: u32,
    pub pairing: PairingState,
    pub selection: SelectionState,
    pub goal: Option<GoalRecord>,
    pub chat_mirror: ChatMirrorState,
    pub action: AutomationActionState,
    pub goal_wake: GoalWakeState,
}

impl Default for AutomationTaskState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            pairing: PairingState::default(),
            selection: SelectionState::default(),
            goal: None,
            chat_mirror: ChatMirrorState::default(),
            action: AutomationActionState::default(),
            goal_wake: GoalWakeState::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentAutomationStore {
    root: PathBuf,
}

static PROCESS_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();

impl AgentAutomationStore {
    pub fn for_config(config: &AppConfig) -> Result<Self, String> {
        Self::new(crate::memory::memory_dir(config).join("chats"))
    }

    pub fn new(root: PathBuf) -> Result<Self, String> {
        if !root.is_absolute() {
            return Err("Agent automation state root must be absolute".into());
        }
        if root.exists() {
            ensure_private_directory(&root, "Agent automation state root")?;
        }
        Ok(Self { root })
    }

    pub fn task_directory(&self, task: &ConversationIdentity) -> Result<PathBuf, String> {
        validate_task_key(task.stable_key())?;
        Ok(self.root.join(task.stable_key()))
    }

    pub fn load(&self, task: &ConversationIdentity) -> Result<AutomationTaskState, String> {
        self.with_locked_task(task, load_state)
    }

    pub fn set_goal(
        &self,
        task: &ConversationIdentity,
        markdown: &str,
        now_ms: u64,
    ) -> Result<GoalRecord, String> {
        if markdown.trim().is_empty() {
            return Err("Agent-chat goal Markdown must not be empty".into());
        }
        if markdown.len() > MAX_GOAL_BYTES {
            return Err(format!(
                "Agent-chat goal Markdown must not exceed {MAX_GOAL_BYTES} UTF-8 bytes"
            ));
        }
        self.mutate(task, |state| {
            let revision = state.goal.as_ref().map_or(Ok(1), |goal| {
                goal.revision
                    .checked_add(1)
                    .ok_or("Agent-chat goal revision overflow")
            })?;
            let goal = GoalRecord {
                revision,
                markdown: markdown.to_string(),
                status: GoalStatus::Configured,
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
                finished_at_ms: None,
                summary: None,
                blocked_reason: None,
            };
            state.goal = Some(goal.clone());
            state.goal_wake = GoalWakeState::default();
            if state.action.goal_revision.is_some() {
                state.action = AutomationActionState::default();
            }
            Ok(goal)
        })
    }

    pub fn run_goal(
        &self,
        task: &ConversationIdentity,
        expected_revision: u64,
        now_ms: u64,
    ) -> Result<GoalRecord, String> {
        self.mutate(task, |state| {
            let result = {
                let goal = exact_goal_mut(state, expected_revision)?;
                match goal.status {
                    GoalStatus::Configured => {
                        goal.status = GoalStatus::Active;
                        goal.updated_at_ms = now_ms;
                        goal.finished_at_ms = None;
                        goal.summary = None;
                        goal.blocked_reason = None;
                    }
                    GoalStatus::Active => {}
                    GoalStatus::Completed | GoalStatus::Blocked | GoalStatus::Error => {
                        return Err(
                            "Only a configured agent-chat goal can be started; create a new revision first"
                                .into(),
                        );
                    }
                }
                goal.clone()
            };
            state.goal_wake = GoalWakeState::default();
            Ok(result)
        })
    }

    pub fn stop_goal(
        &self,
        task: &ConversationIdentity,
        expected_revision: u64,
        now_ms: u64,
    ) -> Result<GoalRecord, String> {
        self.mutate(task, |state| {
            let result = {
                let goal = exact_goal_mut(state, expected_revision)?;
                match goal.status {
                    GoalStatus::Active => {
                        goal.status = GoalStatus::Configured;
                        goal.updated_at_ms = now_ms;
                        goal.finished_at_ms = None;
                        goal.summary = None;
                        goal.blocked_reason = None;
                    }
                    GoalStatus::Configured => {}
                    GoalStatus::Completed | GoalStatus::Blocked | GoalStatus::Error => {
                        return Err("This agent-chat goal is already terminal".into());
                    }
                }
                goal.clone()
            };
            state.goal_wake = GoalWakeState::default();
            if state.action.goal_revision == Some(expected_revision) {
                state.action = AutomationActionState::default();
            }
            Ok(result)
        })
    }

    pub fn clear_goal(
        &self,
        task: &ConversationIdentity,
        expected_revision: u64,
    ) -> Result<(), String> {
        self.mutate(task, |state| {
            let goal = exact_goal(state, expected_revision)?;
            if goal.status == GoalStatus::Active {
                return Err("Stop the active agent-chat goal before clearing it".into());
            }
            state.goal = None;
            state.goal_wake = GoalWakeState::default();
            if state.action.goal_revision == Some(expected_revision) {
                state.action = AutomationActionState::default();
            }
            Ok(())
        })
    }

    pub fn finish_goal(
        &self,
        task: &ConversationIdentity,
        expected_revision: u64,
        finish: GoalFinish,
        now_ms: u64,
    ) -> Result<GoalRecord, String> {
        let normalized = normalize_goal_finish(finish)?;
        self.mutate(task, |state| {
            let result = {
                let goal = exact_goal_mut(state, expected_revision)?;
                if terminal_finish_matches(goal, &normalized) {
                    return Ok(goal.clone());
                }
                if goal.status != GoalStatus::Active {
                    return Err("Only an active agent-chat goal can be finished".into());
                }
                match &normalized {
                    GoalFinish::Completed { summary } => {
                        goal.status = GoalStatus::Completed;
                        goal.summary = summary.clone();
                        goal.blocked_reason = None;
                    }
                    GoalFinish::Blocked { reason } => {
                        goal.status = GoalStatus::Blocked;
                        goal.summary = None;
                        goal.blocked_reason = Some(reason.clone());
                    }
                }
                goal.updated_at_ms = now_ms;
                goal.finished_at_ms = Some(now_ms);
                goal.clone()
            };
            state.goal_wake = GoalWakeState::default();
            if state.action.goal_revision == Some(expected_revision) {
                state.action.status = AutomationActionStatus::Idle;
                state.action.updated_at_ms = Some(now_ms);
            }
            Ok(result)
        })
    }

    pub fn issue_pairing(
        &self,
        task: &ConversationIdentity,
        candidate_url: &str,
        owner_generation: u64,
        now_ms: u64,
    ) -> Result<PairingIssue, String> {
        let candidate_url = normalize_chatgpt_url(candidate_url)?;
        let reference = generate_reference()?;
        let digest = reference_digest(&reference);
        self.mutate(task, |state| {
            let generation = state
                .pairing
                .generation
                .checked_add(1)
                .ok_or("Agent-chat pairing generation overflow")?;
            let expires_at_ms = now_ms
                .checked_add(PAIRING_REFERENCE_TTL_MS)
                .ok_or("Agent-chat pairing expiry overflow")?;
            state.pairing = PairingState {
                candidate_url: Some(candidate_url),
                canonical_url: None,
                generation,
                verified_owner_generation: None,
                verified_at_ms: None,
                pending: Some(PendingPairing {
                    generation,
                    owner_generation,
                    reference_digest: digest,
                    expires_at_ms,
                }),
            };
            state.action = AutomationActionState {
                kind: Some(AutomationActionKind::PairVerify),
                status: AutomationActionStatus::Unverified,
                pairing_generation: Some(generation),
                updated_at_ms: Some(now_ms),
                ..Default::default()
            };
            Ok(PairingIssue {
                reference,
                generation,
                expires_at_ms,
            })
        })
    }

    pub fn record_pairing_canonical_url(
        &self,
        task: &ConversationIdentity,
        expected_generation: u64,
        canonical_url: &str,
        now_ms: u64,
    ) -> Result<PairingState, String> {
        let canonical_url = normalize_chatgpt_url(canonical_url)?;
        self.mutate_persisting_errors(task, |state| {
            let pending = state
                .pairing
                .pending
                .as_ref()
                .ok_or("No agent-chat pairing request is pending")?;
            if state.pairing.generation != expected_generation
                || pending.generation != expected_generation
            {
                return Err("The agent-chat pairing request is stale".into());
            }
            if now_ms > pending.expires_at_ms {
                state.pairing.pending = None;
                return Err("The agent-chat pairing reference expired".into());
            }
            state.pairing.canonical_url = Some(canonical_url);
            state.action.updated_at_ms = Some(now_ms);
            Ok(state.pairing.clone())
        })
    }

    pub fn verify_pairing(
        &self,
        task: &ConversationIdentity,
        expected_generation: u64,
        owner_generation: u64,
        reference: &str,
        now_ms: u64,
    ) -> Result<PairingState, String> {
        validate_reference(reference)?;
        let supplied_digest = reference_digest(reference);
        self.mutate_persisting_errors(task, |state| {
            let Some(pending) = state.pairing.pending.clone() else {
                return Err(
                    "The agent-chat pairing reference is invalid, expired, or already used".into(),
                );
            };
            if now_ms > pending.expires_at_ms {
                state.pairing.pending = None;
                return Err(
                    "The agent-chat pairing reference is invalid, expired, or already used".into(),
                );
            }
            let valid = state.pairing.generation == expected_generation
                && pending.generation == expected_generation
                && pending.owner_generation == owner_generation
                && pending.reference_digest == supplied_digest
                && state.pairing.canonical_url.is_some();
            if !valid {
                state.pairing.pending = None;
                return Err(
                    "The agent-chat pairing reference is invalid, expired, or already used".into(),
                );
            }
            state.pairing.pending = None;
            state.pairing.candidate_url = None;
            state.pairing.verified_owner_generation = Some(owner_generation);
            state.pairing.verified_at_ms = Some(now_ms);
            state.action.status = AutomationActionStatus::Idle;
            state.action.updated_at_ms = Some(now_ms);
            Ok(state.pairing.clone())
        })
    }

    pub fn invalidate_pairing(
        &self,
        task: &ConversationIdentity,
        now_ms: u64,
    ) -> Result<PairingState, String> {
        self.mutate(task, |state| {
            state.pairing.pending = None;
            state.pairing.verified_owner_generation = None;
            state.pairing.verified_at_ms = None;
            state.action.status = AutomationActionStatus::Unverified;
            state.action.updated_at_ms = Some(now_ms);
            Ok(state.pairing.clone())
        })
    }

    fn mutate<R>(
        &self,
        task: &ConversationIdentity,
        mutation: impl FnOnce(&mut AutomationTaskState) -> Result<R, String>,
    ) -> Result<R, String> {
        self.with_locked_task(task, |path| {
            let mut state = load_state(path)?;
            let result = mutation(&mut state)?;
            validate_state(&state)?;
            persist_state(path, &state)?;
            Ok(result)
        })
    }

    fn mutate_persisting_errors<R>(
        &self,
        task: &ConversationIdentity,
        mutation: impl FnOnce(&mut AutomationTaskState) -> Result<R, String>,
    ) -> Result<R, String> {
        self.with_locked_task(task, |path| {
            let mut state = load_state(path)?;
            let result = mutation(&mut state);
            validate_state(&state)?;
            persist_state(path, &state)?;
            result
        })
    }

    fn with_locked_task<R>(
        &self,
        task: &ConversationIdentity,
        action: impl FnOnce(&Path) -> Result<R, String>,
    ) -> Result<R, String> {
        let directory = self.task_directory(task)?;
        ensure_private_directory(&self.root, "Agent automation state root")?;
        ensure_private_directory(&directory, "Agent automation task directory")?;

        let process_lock = process_lock(directory.join(LOCK_FILE))?;
        let _process_guard = process_lock
            .lock()
            .map_err(|_| "Agent automation process lock is unavailable")?;
        let lock_file = open_lock_file(&directory.join(LOCK_FILE))?;
        lock_file
            .lock()
            .map_err(|error| format!("Could not lock agent automation state: {error}"))?;
        action(&directory.join(STATE_FILE))
    }
}

fn exact_goal(state: &AutomationTaskState, expected_revision: u64) -> Result<&GoalRecord, String> {
    let goal = state
        .goal
        .as_ref()
        .ok_or("No agent-chat goal is configured")?;
    if goal.revision != expected_revision {
        return Err("The agent-chat goal revision changed".into());
    }
    Ok(goal)
}

fn exact_goal_mut(
    state: &mut AutomationTaskState,
    expected_revision: u64,
) -> Result<&mut GoalRecord, String> {
    let goal = state
        .goal
        .as_mut()
        .ok_or("No agent-chat goal is configured")?;
    if goal.revision != expected_revision {
        return Err("The agent-chat goal revision changed".into());
    }
    Ok(goal)
}

fn normalize_goal_finish(finish: GoalFinish) -> Result<GoalFinish, String> {
    match finish {
        GoalFinish::Completed { summary } => {
            let summary = summary
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            if summary
                .as_ref()
                .is_some_and(|value| value.len() > MAX_GOAL_RESULT_BYTES)
            {
                return Err("Agent-chat goal summary is too large".into());
            }
            Ok(GoalFinish::Completed { summary })
        }
        GoalFinish::Blocked { reason } => {
            let reason = reason.trim().to_string();
            if reason.is_empty() {
                return Err("A blocked agent-chat goal requires a concrete reason".into());
            }
            if reason.len() > MAX_GOAL_RESULT_BYTES {
                return Err("Agent-chat goal blocked reason is too large".into());
            }
            Ok(GoalFinish::Blocked { reason })
        }
    }
}

fn terminal_finish_matches(goal: &GoalRecord, finish: &GoalFinish) -> bool {
    match (goal.status, finish) {
        (GoalStatus::Completed, GoalFinish::Completed { summary }) => {
            goal.summary == *summary && goal.blocked_reason.is_none()
        }
        (GoalStatus::Blocked, GoalFinish::Blocked { reason }) => {
            goal.blocked_reason.as_deref() == Some(reason.as_str()) && goal.summary.is_none()
        }
        _ => false,
    }
}

fn validate_task_key(value: &str) -> Result<(), String> {
    if valid_digest(value) {
        Ok(())
    } else {
        Err("Agent automation task identity is invalid".into())
    }
}

fn process_lock(path: PathBuf) -> Result<Arc<Mutex<()>>, String> {
    let locks = PROCESS_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .map_err(|_| "Agent automation process lock registry is unavailable")?;
    if let Some(lock) = locks.get(&path).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path, Arc::downgrade(&lock));
    Ok(lock)
}

fn open_lock_file(path: &Path) -> Result<File, String> {
    if let Ok(metadata) = std::fs::symlink_metadata(path)
        && (!metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err("Agent automation lock must be a regular non-symlink file".into());
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Could not open agent automation lock: {error}"))?;
    set_private_file_permissions(path, "agent automation lock")?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect agent automation lock: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Agent automation lock must remain a regular file".into());
    }
    validate_private_file(&metadata, "Agent automation lock")?;
    Ok(file)
}

fn load_state(path: &Path) -> Result<AutomationTaskState, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AutomationTaskState::default());
        }
        Err(error) => return Err(format!("Could not inspect agent automation state: {error}")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Agent automation state must be a regular non-symlink file".into());
    }
    if metadata.len() > MAX_STATE_BYTES {
        return Err("Agent automation state is too large".into());
    }
    validate_private_file(&metadata, "Agent automation state")?;

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Could not open agent automation state: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect open agent automation state: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Agent automation state must remain a regular file".into());
    }
    validate_private_file(&metadata, "Agent automation state")?;
    let mut bytes = Vec::new();
    file.take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read agent automation state: {error}"))?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("Agent automation state is too large".into());
    }
    let state: AutomationTaskState = serde_json::from_slice(&bytes)
        .map_err(|_| "Agent automation state is invalid JSON".to_string())?;
    validate_state(&state)?;
    Ok(state)
}

fn persist_state(path: &Path, state: &AutomationTaskState) -> Result<(), String> {
    validate_state(state)?;
    let parent = path
        .parent()
        .ok_or("Agent automation state has no parent directory")?;
    ensure_private_directory(parent, "Agent automation task directory")?;
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("Agent automation state must be a regular non-symlink file".into());
        }
        validate_private_file(&metadata, "Agent automation state")?;
    }
    let bytes = serde_json::to_vec(state)
        .map_err(|error| format!("Could not encode agent automation state: {error}"))?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("Agent automation state is too large".into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Could not create agent automation state: {error}"))?;
    set_private_file_permissions(temporary.path(), "temporary agent automation state")?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Could not write agent automation state: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Could not publish agent automation state: {}", error.error))?;
    set_private_file_permissions(path, "agent automation state")?;
    #[cfg(unix)]
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn ensure_private_directory(path: &Path, label: &str) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| format!("Could not create {label}: {error}"))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect {label}: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("{label} must be a real directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(format!("{label} must belong to the current user"));
        }
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not protect {label}: {error}"))?;
    }
    Ok(())
}

fn validate_private_file(metadata: &std::fs::Metadata, label: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(format!(
                "{label} must belong to the current user and have mode 0600"
            ));
        }
    }
    Ok(())
}

fn set_private_file_permissions(path: &Path, label: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not protect {label}: {error}"))?;
    }
    Ok(())
}

fn validate_state(state: &AutomationTaskState) -> Result<(), String> {
    if state.version != STATE_VERSION {
        return Err(format!(
            "Unsupported agent automation state version {}",
            state.version
        ));
    }
    validate_pairing(&state.pairing)?;
    validate_selection(&state.selection)?;
    if let Some(goal) = &state.goal {
        validate_goal(goal)?;
    }
    if state.chat_mirror.message_ids.len() > MAX_CHAT_MIRROR_IDS
        || state
            .chat_mirror
            .message_ids
            .iter()
            .any(|value| !valid_opaque(value))
        || state
            .chat_mirror
            .last_accepted_batch_id
            .as_deref()
            .is_some_and(|value| !valid_opaque(value))
        || state
            .chat_mirror
            .transcript_revision_at_start
            .as_deref()
            .is_some_and(|value| !bounded_private(value))
    {
        return Err("Agent automation chat mirror state is invalid".into());
    }
    if state
        .action
        .id
        .as_deref()
        .is_some_and(|value| !valid_opaque(value))
        || state
            .action
            .last_error
            .as_deref()
            .is_some_and(|value| !bounded_private(value))
        || state
            .action
            .last_stable_answer
            .as_deref()
            .is_some_and(|value| value.len() > MAX_PRIVATE_TEXT_BYTES)
    {
        return Err("Agent automation action state is invalid".into());
    }
    for value in [
        state.goal_wake.activity_epoch.as_deref(),
        state.goal_wake.nudged_epoch.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !valid_opaque(value) {
            return Err("Agent automation goal wake state is invalid".into());
        }
    }
    Ok(())
}

fn validate_pairing(pairing: &PairingState) -> Result<(), String> {
    for url in [
        pairing.candidate_url.as_deref(),
        pairing.canonical_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        normalize_chatgpt_url(url)?;
    }
    if pairing.verified_owner_generation.is_some() != pairing.verified_at_ms.is_some() {
        return Err("Agent automation pairing verification state is incomplete".into());
    }
    if pairing.verified_owner_generation.is_some() && pairing.canonical_url.is_none() {
        return Err("Agent automation pairing is verified without a canonical URL".into());
    }
    if let Some(pending) = &pairing.pending
        && (pending.generation == 0
            || pending.generation != pairing.generation
            || !valid_digest(&pending.reference_digest)
            || pairing.candidate_url.is_none()
            || pending.expires_at_ms == 0)
    {
        return Err("Agent automation pending pairing state is invalid".into());
    }
    Ok(())
}

fn validate_selection(selection: &SelectionState) -> Result<(), String> {
    for value in [
        selection.model.as_deref(),
        selection.effort.as_deref(),
        selection.catalog_revision.as_deref(),
        selection.account_fingerprint.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !valid_opaque(value) {
            return Err("Agent automation selection state is invalid".into());
        }
    }
    Ok(())
}

fn validate_goal(goal: &GoalRecord) -> Result<(), String> {
    if goal.revision == 0
        || goal.markdown.trim().is_empty()
        || goal.markdown.len() > MAX_GOAL_BYTES
        || goal
            .summary
            .as_deref()
            .is_some_and(|value| value.len() > MAX_GOAL_RESULT_BYTES)
        || goal
            .blocked_reason
            .as_deref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > MAX_GOAL_RESULT_BYTES)
    {
        return Err("Agent automation goal state is invalid".into());
    }
    match goal.status {
        GoalStatus::Configured | GoalStatus::Active => {
            if goal.finished_at_ms.is_some()
                || goal.summary.is_some()
                || goal.blocked_reason.is_some()
            {
                return Err("Nonterminal agent automation goal contains terminal data".into());
            }
        }
        GoalStatus::Completed => {
            if goal.finished_at_ms.is_none() || goal.blocked_reason.is_some() {
                return Err("Completed agent automation goal state is invalid".into());
            }
        }
        GoalStatus::Blocked => {
            if goal.finished_at_ms.is_none()
                || goal.summary.is_some()
                || goal.blocked_reason.is_none()
            {
                return Err("Blocked agent automation goal state is invalid".into());
            }
        }
        GoalStatus::Error => {}
    }
    Ok(())
}

fn normalize_chatgpt_url(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("ChatGPT conversation URL is invalid".into());
    }
    let mut url = reqwest::Url::parse(value).map_err(|_| "ChatGPT conversation URL is invalid")?;
    if url.scheme() != "https"
        || url.host_str() != Some("chatgpt.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("ChatGPT conversation URL must use the https://chatgpt.com origin".into());
    }
    url.set_fragment(None);
    Ok(url.to_string())
}

fn generate_reference() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("Could not generate an agent-chat pairing reference: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn validate_reference(reference: &str) -> Result<(), String> {
    if reference.len() != 43
        || URL_SAFE_NO_PAD
            .decode(reference)
            .ok()
            .is_none_or(|bytes| bytes.len() != 32)
    {
        return Err("The agent-chat pairing reference is invalid, expired, or already used".into());
    }
    Ok(())
}

fn reference_digest(reference: &str) -> String {
    format!("{:x}", Sha256::digest(reference.as_bytes()))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.contains('\0')
        && !value.chars().any(char::is_control)
}

fn bounded_private(value: &str) -> bool {
    value.len() <= MAX_PRIVATE_TEXT_BYTES && !value.contains('\0')
}
