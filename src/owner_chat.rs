//! Local-only owner view of the persisted agent chats. This is deliberately not
//! nested under `/mcp` and never shares the connector's tunnel listener.

use std::io::{Read, Write};
use std::path::{Path as FilePath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{Request, StatusCode, header};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::agent_automation::{
    AgentAutomationStore, AgentAutomationSupervisor, AutomationTaskHandle, BrowserCompanionClient,
    RevealWindowRequest,
};
use crate::artifact_egress::ArtifactEgressStore;
use crate::conversation_continuations::ConversationContinuationStore;
use crate::markdown_chat::{MarkdownChatStore, OwnerChatSummary};
use crate::markdown_chat_ui::{CHAT_UI_HTML, CHAT_WIDGET_META};
use crate::project_bindings::ConversationIdentity;
use crate::types::AppConfig;
use crate::util::home_dir;

type ApiResult = Result<Json<Value>, (StatusCode, String)>;

#[derive(Debug, Clone, PartialEq, Eq)]
enum OwnerMessage {
    Chat(String),
    Goal(crate::agent_automation::OwnerGoalCommand),
}

fn parse_owner_message(message: &str) -> Result<OwnerMessage, String> {
    if message == "//goal" || message.starts_with("//goal ") {
        return Ok(OwnerMessage::Chat(message[1..].to_string()));
    }
    if message != "/goal" && !message.starts_with("/goal ") {
        return Ok(OwnerMessage::Chat(message.to_string()));
    }
    if let Some(markdown) = message.strip_prefix("/goal set ") {
        if markdown.trim().is_empty() {
            return Err("Goal Markdown must not be empty".into());
        }
        if markdown.len() > crate::agent_automation::MAX_GOAL_BYTES {
            return Err("Goal Markdown must not exceed 10 KiB of UTF-8".into());
        }
        return Ok(OwnerMessage::Goal(
            crate::agent_automation::OwnerGoalCommand::Set {
                markdown: markdown.to_string(),
            },
        ));
    }
    let command = match message {
        "/goal run" => crate::agent_automation::OwnerGoalCommand::Run,
        "/goal stop" => crate::agent_automation::OwnerGoalCommand::Stop,
        "/goal clear" => crate::agent_automation::OwnerGoalCommand::Clear,
        "/goal status" => crate::agent_automation::OwnerGoalCommand::Status,
        "/goal set" => return Err("Goal Markdown must not be empty".into()),
        _ => return Err("Unknown /goal command".into()),
    };
    Ok(OwnerMessage::Goal(command))
}

#[derive(Clone)]
struct OwnerState {
    config: Arc<AppConfig>,
    chats: Arc<MarkdownChatStore>,
    artifacts: Arc<ArtifactEgressStore>,
    continuations: Arc<ConversationContinuationStore>,
    automation: Option<Arc<AgentAutomationSupervisor>>,
    token: String,
}

#[derive(Serialize, Deserialize)]
struct RuntimeInfo {
    port: u16,
    token: String,
}

pub struct OwnerServer {
    task: tokio::task::JoinHandle<()>,
}

impl Drop for OwnerServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn runtime_path() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codexify")
        .join("owner-chat.json")
}

fn read_runtime(path: &FilePath) -> anyhow::Result<Option<RuntimeInfo>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("inspect saved owner-chat credentials"),
    };
    anyhow::ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Owner-chat credentials must be a regular non-symlink file: {}",
        path.display()
    );
    let mut options = std::fs::OpenOptions::new();
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
        .context("open saved owner-chat credentials")?;
    let metadata = file.metadata()?;
    anyhow::ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Owner-chat credentials must be a regular non-symlink file: {}",
        path.display()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        anyhow::ensure!(
            metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0,
            "Owner-chat credentials must belong to the current user and have mode 0600: {}",
            path.display()
        );
    }
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() <= 4096,
        "Saved owner-chat credentials are too large"
    );
    let info: RuntimeInfo = serde_json::from_slice(&bytes).map_err(|_| {
        anyhow::anyhow!("Invalid saved owner-chat credentials in {}", path.display())
    })?;
    anyhow::ensure!(
        info.port != 0
            && info
                .token
                .strip_prefix("codexify_")
                .and_then(|token| URL_SAFE_NO_PAD.decode(token).ok())
                .is_some_and(|bytes| bytes.len() == 32),
        "Invalid saved owner-chat credentials in {}",
        path.display()
    );
    Ok(Some(info))
}

fn prepare_runtime(
    parent: &FilePath,
    info: &RuntimeInfo,
) -> anyhow::Result<tempfile::NamedTempFile> {
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut temporary, info)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    Ok(temporary)
}

fn load_or_create_runtime(path: &FilePath, port: u16) -> anyhow::Result<RuntimeInfo> {
    let parent = path
        .parent()
        .context("owner-chat credentials have no parent directory")?;
    std::fs::create_dir_all(parent)?;
    let mut info = match read_runtime(path)? {
        Some(info) => info,
        None => {
            let candidate = RuntimeInfo {
                port,
                token: crate::auth::generate_internal_bearer_token()?,
            };
            // Concurrent first starts must adopt the same credential, not overwrite it.
            match prepare_runtime(parent, &candidate)?.persist_noclobber(path) {
                Ok(_) => candidate,
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    read_runtime(path)?
                        .context("owner-chat credentials disappeared during initialization")?
                }
                Err(error) => return Err(error.into()),
            }
        }
    };
    if info.port != port {
        info.port = port;
        prepare_runtime(parent, &info)?.persist(path)?;
    }
    Ok(info)
}

fn is_real_dir(path: &FilePath) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
}

fn is_real_file(path: &FilePath) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
}

fn stable_owner(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

struct LocatedChat {
    id: String,
    owner: String,
    path: PathBuf,
    state_root: PathBuf,
    work_dir: Option<PathBuf>,
    workspace: String,
}

fn state_roots(config: &AppConfig) -> Vec<PathBuf> {
    if !config.multi_project {
        return vec![crate::memory::memory_dir(config)];
    }
    let base = config
        .memory
        .dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".codexify/projects")
        });
    if !is_real_dir(&base) {
        return Vec::new();
    }
    std::fs::read_dir(base)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_real_dir(path))
        .collect()
}

fn work_dir_for_root(config: &AppConfig, root: &FilePath) -> Option<PathBuf> {
    if !config.multi_project {
        return Some(config.work_dir.clone());
    }
    let path = root.join("memory.json");
    if !is_real_file(&path) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 1024 * 1024 {
        return None;
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value.get("workDir")?.as_str().map(PathBuf::from)
}

fn locate(config: &AppConfig) -> Vec<LocatedChat> {
    let mut found = Vec::new();
    for root in state_roots(config) {
        let chats_dir = root.join("chats");
        if !is_real_dir(&chats_dir) {
            continue;
        }
        let work_dir = work_dir_for_root(config, &root);
        for entry in std::fs::read_dir(chats_dir).into_iter().flatten().flatten() {
            let owner = entry.file_name().to_string_lossy().into_owned();
            let dir = entry.path();
            if !stable_owner(&owner) || !is_real_dir(&dir) {
                continue;
            }
            let path = dir.join("CHAT.md");
            if !is_real_file(&path) {
                continue;
            }
            let path = if path.is_absolute() {
                path
            } else if let Ok(cwd) = std::env::current_dir() {
                cwd.join(path)
            } else {
                continue;
            };
            let mut hasher = Sha256::new();
            hasher.update(path.to_string_lossy().as_bytes());
            let active_work_dir = work_dir.clone();
            let workspace = active_work_dir
                .as_ref()
                .and_then(|path| path.file_name())
                .unwrap_or_else(|| root.file_name().unwrap_or_default())
                .to_string_lossy()
                .into_owned();
            found.push(LocatedChat {
                id: format!("{:x}", hasher.finalize()),
                owner,
                path,
                state_root: root.clone(),
                work_dir: active_work_dir,
                workspace,
            });
        }
    }
    found
}

fn selected(config: &AppConfig, id: &str) -> Result<LocatedChat, (StatusCode, String)> {
    if !stable_owner(id) {
        return Err((StatusCode::NOT_FOUND, "Conversation not found".into()));
    }
    locate(config)
        .into_iter()
        .find(|chat| chat.id == id)
        .ok_or((StatusCode::NOT_FOUND, "Conversation not found".into()))
}

fn internal_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::CONFLICT, error.to_string())
}

fn wrap(value: Value) -> Json<Value> {
    Json(json!({"_meta": { CHAT_WIDGET_META: value }}))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatListing {
    id: String,
    title: String,
    workspace: String,
    last_entry_end: u64,
    last_entry_at_ms: u64,
    last_agent_call_at_ms: Option<u64>,
    agent_waiting_until_ms: Option<u64>,
    total_tool_calls: u64,
}

async fn list_chats(State(state): State<OwnerState>) -> ApiResult {
    let mut list = Vec::new();
    for located in locate(&state.config) {
        let chat = state
            .chats
            .chat_at_path(located.path.clone(), true)
            .map_err(internal_error)?;
        let OwnerChatSummary {
            title,
            last_entry_end,
            last_entry_at_ms,
            last_agent_call_at_ms,
            agent_waiting_until_ms,
            total_tool_calls,
        } = match chat.owner_summary().await {
            Ok(summary) => summary,
            Err(error) => {
                tracing::warn!("owner chat transcript unavailable: {error}");
                let metadata = std::fs::metadata(&located.path).map_err(internal_error)?;
                OwnerChatSummary {
                    title: "Conversation unavailable".into(),
                    last_entry_end: metadata.len(),
                    last_entry_at_ms: metadata
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|duration| duration.as_millis() as u64)
                        .unwrap_or_default(),
                    last_agent_call_at_ms: None,
                    agent_waiting_until_ms: None,
                    total_tool_calls: 0,
                }
            }
        };
        list.push(ChatListing {
            id: located.id,
            title,
            workspace: located.workspace,
            last_entry_end,
            last_entry_at_ms,
            last_agent_call_at_ms,
            agent_waiting_until_ms,
            total_tool_calls,
        });
    }
    list.sort_by(|a, b| {
        b.last_entry_at_ms
            .cmp(&a.last_entry_at_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(Json(
        json!({"chats": list, "serverTimeMs": crate::markdown_chat::now_ms()}),
    ))
}

#[derive(Deserialize)]
struct PageQuery {
    before: Option<u64>,
    revision: Option<String>,
}

async fn chat_state(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Query(query): Query<PageQuery>,
) -> ApiResult {
    if query
        .revision
        .as_ref()
        .is_some_and(|revision| revision.len() > 128)
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid chat revision".into()));
    }
    let located = selected(&state.config, &id)?;
    let chat = state
        .chats
        .chat_at_path(located.path, true)
        .map_err(internal_error)?;
    let page = chat
        .widget_page(query.before, query.revision)
        .await
        .map_err(internal_error)?;
    Ok(wrap(serde_json::to_value(page).expect("chat page")))
}

async fn automation_state(State(state): State<OwnerState>, Path(id): Path<String>) -> ApiResult {
    if !state.config.markdown_chat.automation.enabled {
        return Ok(Json(json!({
            "enabled": false,
            "serverTimeMs": crate::markdown_chat::now_ms()
        })));
    }
    let located = selected(&state.config, &id)?;
    let context = automation_context(&state, &located).await?;
    let automation = context.store.load(&context.task).map_err(internal_error)?;
    let summary = context.chat.owner_summary().await.map_err(internal_error)?;
    let live = match state.automation.as_ref() {
        Some(supervisor) => supervisor.live_state(&context.task).await,
        None => None,
    };
    let queue = match state.automation.as_ref() {
        Some(supervisor) => supervisor
            .queue_position(&context.task)
            .await
            .map(|(position, total)| json!({"position": position, "total": total})),
        None => None,
    };
    let companion = match companion_client(&state) {
        Ok(client) => match client.health(&CancellationToken::new()).await {
            Ok(health) => public_companion_health(&health),
            Err(_) => json!({
                "status": "unavailable",
                "authenticated": false,
                "activeActionId": null,
                "detail": "Browser companion is unavailable"
            }),
        },
        Err(_) => json!({
            "status": "unavailable",
            "authenticated": false,
            "activeActionId": null,
            "detail": "Browser companion is unavailable"
        }),
    };
    Ok(Json(json!({
        "enabled": true,
        "ownerGeneration": context.owner_generation,
        "pairing": public_pairing(&automation.pairing, context.owner_generation),
        "selection": {
            "model": automation.selection.model,
            "effort": automation.selection.effort,
            "catalogRevision": automation.selection.catalog_revision
        },
        "goal": automation.goal,
        "action": automation.action,
        "live": live,
        "queue": queue,
        "companion": companion,
        "presence": {
            "lastAgentCallAtMs": summary.last_agent_call_at_ms,
            "agentWaitingUntilMs": summary.agent_waiting_until_ms,
            "totalToolCalls": summary.total_tool_calls
        },
        "serverTimeMs": crate::markdown_chat::now_ms()
    })))
}

async fn automation_capabilities(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Json(_): Json<Value>,
) -> ApiResult {
    let located = selected(&state.config, &id)?;
    let _ = automation_context(&state, &located).await?;
    let client = companion_client(&state)?;
    let cancellation = CancellationToken::new();
    let health = client.health(&cancellation).await.map_err(internal_error)?;
    if !health.authenticated {
        return Err(internal_error("ChatGPT authentication is required"));
    }
    let catalog = client
        .capabilities(&cancellation)
        .await
        .map_err(internal_error)?;
    if health.account_fingerprint.as_deref() != Some(catalog.account_fingerprint.as_str()) {
        return Err(internal_error(
            "Browser companion account changed during capability discovery",
        ));
    }
    Ok(Json(json!({
        "companion": public_companion_health(&health),
        "catalogRevision": catalog.catalog_revision,
        "models": catalog.models
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectionBody {
    request_id: String,
    model: String,
    effort: String,
}

async fn automation_selection(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Json(body): Json<SelectionBody>,
) -> ApiResult {
    validate_owner_request_id(&body.request_id)?;
    let located = selected(&state.config, &id)?;
    let context = automation_context(&state, &located).await?;
    let catalog = companion_client(&state)?
        .capabilities(&CancellationToken::new())
        .await
        .map_err(internal_error)?;
    let model = catalog
        .models
        .iter()
        .find(|model| model.id == body.model)
        .ok_or_else(|| internal_error("The selected ChatGPT model is unavailable"))?;
    let effort = model
        .efforts
        .iter()
        .find(|effort| effort.id == body.effort)
        .ok_or_else(|| internal_error("The selected ChatGPT effort is unavailable"))?;
    if !effort.available {
        return Err(internal_error(
            effort
                .reason
                .as_deref()
                .unwrap_or("The selected ChatGPT effort is unavailable"),
        ));
    }
    let selection = context
        .store
        .set_selection(
            &context.task,
            &model.id,
            &effort.id,
            &catalog.catalog_revision,
            &catalog.account_fingerprint,
            crate::markdown_chat::now_ms(),
        )
        .map_err(internal_error)?;
    if let Some(supervisor) = state.automation.as_ref() {
        supervisor.discard_queued_actions(&context.task).await;
        supervisor.notify();
    }
    Ok(Json(json!({
        "selection": {
            "model": selection.model,
            "effort": selection.effort,
            "catalogRevision": selection.catalog_revision
        }
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairBody {
    request_id: String,
    url: String,
}

async fn automation_pair(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Json(body): Json<PairBody>,
) -> ApiResult {
    validate_owner_request_id(&body.request_id)?;
    let located = selected(&state.config, &id)?;
    let context = automation_context(&state, &located).await?;
    let current = context.store.load(&context.task).map_err(internal_error)?;
    if current.selection.model.is_none()
        || current.selection.effort.is_none()
        || current.selection.catalog_revision.is_none()
        || current.selection.account_fingerprint.is_none()
    {
        return Err(internal_error(
            "Select a verified ChatGPT model and effort before pairing",
        ));
    }
    let supervisor = state
        .automation
        .as_ref()
        .ok_or_else(|| internal_error("Browser automation supervisor is unavailable"))?;
    supervisor.discard_queued_actions(&context.task).await;
    let now_ms = crate::markdown_chat::now_ms();
    let issue = context
        .store
        .issue_pairing(&context.task, &body.url, context.owner_generation, now_ms)
        .map_err(internal_error)?;
    if let Err(error) = supervisor
        .queue_pair_verification(&context.task, &issue.reference, issue.generation, now_ms)
        .await
    {
        let _ = context.store.unlink_pairing(&context.task, now_ms);
        return Err(internal_error(error));
    }
    supervisor.notify();
    let current = context.store.load(&context.task).map_err(internal_error)?;
    Ok(Json(json!({
        "pairing": public_pairing(&current.pairing, context.owner_generation),
        "action": current.action
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerMutationBody {
    request_id: String,
}

async fn automation_unlink(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Json(body): Json<OwnerMutationBody>,
) -> ApiResult {
    validate_owner_request_id(&body.request_id)?;
    let located = selected(&state.config, &id)?;
    let context = automation_context(&state, &located).await?;
    let pairing = context
        .store
        .unlink_pairing(&context.task, crate::markdown_chat::now_ms())
        .map_err(internal_error)?;
    if let Some(supervisor) = state.automation.as_ref() {
        supervisor.discard_queued_actions(&context.task).await;
        supervisor.notify();
    }
    Ok(Json(json!({
        "pairing": public_pairing(&pairing, context.owner_generation)
    })))
}

async fn automation_login(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Json(_): Json<Value>,
) -> ApiResult {
    let located = selected(&state.config, &id)?;
    let _ = automation_context(&state, &located).await?;
    let health = companion_client(&state)?
        .login(&CancellationToken::new())
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({"companion": public_companion_health(&health)})))
}

async fn automation_reveal(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Json(_): Json<Value>,
) -> ApiResult {
    let located = selected(&state.config, &id)?;
    let context = automation_context(&state, &located).await?;
    let automation = context.store.load(&context.task).map_err(internal_error)?;
    let receipt = companion_client(&state)?
        .reveal(
            &RevealWindowRequest {
                url: automation
                    .pairing
                    .canonical_url
                    .or(automation.pairing.candidate_url),
            },
            &CancellationToken::new(),
        )
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({
        "revealed": receipt.revealed,
        "activeActionId": receipt.active_action_id
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionMutationBody {
    request_id: String,
    action_id: String,
}

async fn automation_action_state(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
) -> ApiResult {
    let located = selected(&state.config, &id)?;
    let context = automation_context(&state, &located).await?;
    let action = context
        .store
        .load(&context.task)
        .map_err(internal_error)?
        .action;
    let (live, queue) = match state.automation.as_ref() {
        Some(supervisor) => {
            let live = supervisor.live_state(&context.task).await;
            let queue = supervisor
                .queue_position(&context.task)
                .await
                .map(|(position, total)| json!({"position": position, "total": total}));
            (live, queue)
        }
        None => (None, None),
    };
    Ok(Json(
        json!({"action": action, "live": live, "queue": queue}),
    ))
}

async fn automation_action_cancel(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Json(body): Json<ActionMutationBody>,
) -> ApiResult {
    validate_owner_request_id(&body.request_id)?;
    let located = selected(&state.config, &id)?;
    let context = automation_context(&state, &located).await?;
    let supervisor = state
        .automation
        .as_ref()
        .ok_or_else(|| internal_error("Browser automation supervisor is unavailable"))?;
    let action = supervisor
        .cancel_queued_action(
            &context.task,
            &body.action_id,
            crate::markdown_chat::now_ms(),
        )
        .await
        .map_err(internal_error)?;
    let queue = supervisor
        .queue_position(&context.task)
        .await
        .map(|(position, total)| json!({"position": position, "total": total}));
    Ok(Json(json!({"action": action, "queue": queue})))
}

async fn automation_action_retry(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Json(body): Json<ActionMutationBody>,
) -> ApiResult {
    validate_owner_request_id(&body.request_id)?;
    let located = selected(&state.config, &id)?;
    let context = automation_context(&state, &located).await?;
    let supervisor = state
        .automation
        .as_ref()
        .ok_or_else(|| internal_error("Browser automation supervisor is unavailable"))?;
    let action = supervisor
        .retry_failed_action(
            &context.task,
            &body.action_id,
            crate::markdown_chat::now_ms(),
        )
        .await
        .map_err(internal_error)?;
    let queue = supervisor
        .queue_position(&context.task)
        .await
        .map(|(position, total)| json!({"position": position, "total": total}));
    Ok(Json(json!({"action": action, "queue": queue})))
}

async fn chat_markdown(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    let located = selected(&state.config, &id)?;
    let chat = state
        .chats
        .chat_at_path(located.path, true)
        .map_err(internal_error)?;
    let transcript = chat
        .clean_markdown_transcript()
        .await
        .map_err(internal_error)?;
    let mut response = transcript.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/markdown; charset=utf-8"),
    );
    Ok(response)
}

#[derive(Deserialize)]
struct SendBody {
    request_id: String,
    message: String,
}

fn automation_task(
    located: &LocatedChat,
) -> Result<crate::project_bindings::ConversationIdentity, (StatusCode, String)> {
    crate::project_bindings::ConversationIdentity::from_stable_keys(
        located.owner.clone(),
        located.owner.clone(),
    )
    .ok_or_else(|| internal_error("Conversation has an invalid stable task identity"))
}

struct OwnerAutomationContext {
    task: ConversationIdentity,
    owner_generation: u64,
    store: Arc<AgentAutomationStore>,
    chat: Arc<crate::markdown_chat::ChatFile>,
}

async fn automation_context(
    state: &OwnerState,
    located: &LocatedChat,
) -> Result<OwnerAutomationContext, (StatusCode, String)> {
    if !state.config.markdown_chat.automation.enabled {
        return Err(internal_error("Agent-chat browser automation is disabled"));
    }
    let task = automation_task(located)?;
    let owner_generation = state
        .continuations
        .owner_generation_for_task_key(task.stable_key())
        .map_err(internal_error)?;
    let store = Arc::new(
        AgentAutomationStore::for_state_root(&state.config, &located.state_root)
            .map_err(internal_error)?,
    );
    let chat = state
        .chats
        .chat_at_path(located.path.clone(), true)
        .map_err(internal_error)?;
    if let Some(supervisor) = state.automation.as_ref() {
        supervisor
            .register_task(AutomationTaskHandle::new(
                task.clone(),
                owner_generation,
                store.clone(),
                chat.clone(),
            ))
            .await
            .map_err(internal_error)?;
    }
    Ok(OwnerAutomationContext {
        task,
        owner_generation,
        store,
        chat,
    })
}

fn validate_owner_request_id(request_id: &str) -> Result<(), (StatusCode, String)> {
    if request_id.is_empty()
        || request_id.len() > 512
        || request_id.contains('\0')
        || request_id.chars().any(char::is_control)
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid request ID".into()));
    }
    Ok(())
}

fn companion_client(state: &OwnerState) -> Result<BrowserCompanionClient, (StatusCode, String)> {
    BrowserCompanionClient::from_config(&state.config.markdown_chat.automation)
        .map_err(internal_error)
}

fn public_companion_health(health: &crate::agent_automation::CompanionHealth) -> Value {
    json!({
        "status": health.status,
        "authenticated": health.authenticated,
        "activeActionId": health.active_action_id
    })
}

fn pairing_status(
    pairing: &crate::agent_automation::PairingState,
    owner_generation: u64,
) -> &'static str {
    if pairing.canonical_url.is_some()
        && pairing.verified_owner_generation == Some(owner_generation)
    {
        "verified"
    } else if pairing.candidate_url.is_some() || pairing.canonical_url.is_some() {
        "unverified"
    } else {
        "unpaired"
    }
}

fn public_pairing(pairing: &crate::agent_automation::PairingState, owner_generation: u64) -> Value {
    json!({
        "status": pairing_status(pairing, owner_generation),
        "candidateUrl": pairing.candidate_url,
        "canonicalUrl": pairing.canonical_url,
        "generation": pairing.generation,
        "verifiedAtMs": pairing.verified_at_ms,
        "expiresAtMs": pairing.pending.as_ref().map(|pending| pending.expires_at_ms)
    })
}

async fn chat_send(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Json(body): Json<SendBody>,
) -> ApiResult {
    let located = selected(&state.config, &id)?;
    match parse_owner_message(&body.message).map_err(|error| (StatusCode::BAD_REQUEST, error))? {
        OwnerMessage::Chat(message) => {
            let chat = state
                .chats
                .chat_at_path(located.path, true)
                .map_err(internal_error)?;
            let sent = chat
                .append_user(body.request_id, message)
                .await
                .map_err(internal_error)?;
            Ok(wrap(json!({"sent": sent})))
        }
        OwnerMessage::Goal(command) => {
            let context = automation_context(&state, &located).await?;
            let receipt = context
                .store
                .apply_owner_goal_command(
                    &context.task,
                    &body.request_id,
                    command,
                    crate::markdown_chat::now_ms(),
                )
                .map_err(internal_error)?;
            if let Some(supervisor) = state.automation.as_ref() {
                supervisor.notify();
            }
            Ok(wrap(json!({
                "localCommand": receipt.clone(),
                "goal": receipt.goal,
                "goalCommand": receipt.kind,
                "replayed": receipt.replayed
            })))
        }
    }
}

#[derive(Deserialize)]
struct FileQuery {
    href: String,
}

async fn chat_file(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> ApiResult {
    if query.href.is_empty() || query.href.len() > 4096 {
        return Err((StatusCode::BAD_REQUEST, "Invalid file reference".into()));
    }
    let located = selected(&state.config, &id)?;
    let work_dir = crate::project_bindings::ProjectBindingStore::for_current_user()
        .owner_chat_work_dirs(&state.config)
        .remove(&located.owner)
        .or(located.work_dir)
        .ok_or_else(|| internal_error("Workspace path is unavailable for this conversation"))?;
    let resource = state
        .artifacts
        .chat_file_link(&work_dir, &query.href, &CancellationToken::new())
        .await
        .map_err(internal_error)?;
    let mut file = serde_json::to_value(resource).expect("file resource");
    file["type"] = json!("resource_link");
    Ok(wrap(json!({"file": file})))
}

#[derive(Deserialize)]
struct DownloadQuery {
    uri: String,
}

async fn download(
    State(state): State<OwnerState>,
    Query(query): Query<DownloadQuery>,
) -> Result<Response, (StatusCode, String)> {
    let Some(contents) = state
        .artifacts
        .read_resource(&query.uri, &CancellationToken::new())
        .await
        .map_err(internal_error)?
    else {
        return Err((StatusCode::NOT_FOUND, "File not found".into()));
    };
    let rmcp::model::ResourceContents::BlobResourceContents {
        blob, mime_type, ..
    } = contents
    else {
        return Err(internal_error("File content is unavailable"));
    };
    let bytes = STANDARD.decode(blob).map_err(internal_error)?;
    let mut response = bytes.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        mime_type
            .as_deref()
            .unwrap_or("application/octet-stream")
            .parse()
            .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_static("attachment"),
    );
    Ok(response)
}

async fn page() -> Html<String> {
    Html(OWNER_HTML.clone())
}

async fn authorize(
    State(state): State<OwnerState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let host_ok = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host.starts_with("127.0.0.1:"));
    if !host_ok {
        return StatusCode::FORBIDDEN.into_response();
    }
    if request.uri().path() != "/" {
        let expected = format!("Bearer {}", state.token);
        if request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            != Some(&expected)
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        header::HeaderValue::from_static("no-referrer"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_static("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"),
    );
    response
}

static OWNER_HTML: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    let style = CHAT_UI_HTML
        .split_once("<style>")
        .unwrap()
        .1
        .split_once("</style>")
        .unwrap()
        .0
        .replace(
            ":root:not([data-theme=\"light\"])",
            ":host(:not([data-theme=\"light\"]))",
        )
        .replace(":root[data-theme=\"dark\"]", ":host([data-theme=\"dark\"])")
        .replace(":root", ":host")
        .replace("body {", ":host { display:block;");
    let body = CHAT_UI_HTML
        .split_once("<body>")
        .unwrap()
        .1
        .split_once("<script>")
        .unwrap()
        .0;
    let script = CHAT_UI_HTML
        .split_once("<script>")
        .unwrap()
        .1
        .split_once("</script>")
        .unwrap()
        .0;
    include_str!("owner_chat.html")
        .replace("<!-- CHAT_TEMPLATE -->", &format!("<template id=\"chat-template\"><style>{style}\n#chat {{ max-width:none; height:100%; border:0; border-radius:0; display:flex; flex-direction:column; }} #panel {{ display:flex; flex:1; min-height:0; flex-direction:column; }} #panel[hidden] {{ display:none; }} #messages {{ flex:1; max-height:none; min-height:0; }}\n</style>{body}</template>"))
        .replace("/* CHAT_SCRIPT */", script)
});

pub async fn start(
    config: Arc<AppConfig>,
    chats: Arc<MarkdownChatStore>,
    artifacts: Arc<ArtifactEgressStore>,
) -> anyhow::Result<OwnerServer> {
    let continuations = Arc::new(
        ConversationContinuationStore::for_current_user(&config).map_err(anyhow::Error::msg)?,
    );
    start_with_automation(config, chats, artifacts, continuations, None).await
}

pub(crate) async fn start_with_automation(
    config: Arc<AppConfig>,
    chats: Arc<MarkdownChatStore>,
    artifacts: Arc<ArtifactEgressStore>,
    continuations: Arc<ConversationContinuationStore>,
    automation: Option<Arc<AgentAutomationSupervisor>>,
) -> anyhow::Result<OwnerServer> {
    let listener = bind_owner_listener(&config).await?;
    let port = listener.local_addr()?.port();
    let info = load_or_create_runtime(&runtime_path(), port)?;
    let state = OwnerState {
        config,
        chats,
        artifacts,
        continuations,
        automation,
        token: info.token,
    };
    let app = router(state);
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!("owner chat listener stopped: {error}");
        }
    });
    Ok(OwnerServer { task })
}

async fn bind_owner_listener(config: &AppConfig) -> anyhow::Result<tokio::net::TcpListener> {
    let port = config.markdown_chat.port.unwrap_or(0);
    tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .with_context(|| match config.markdown_chat.port {
            Some(port) => format!("bind standalone agent chat to 127.0.0.1:{port}"),
            None => "bind standalone agent chat to an ephemeral loopback port".into(),
        })
}

fn router(state: OwnerState) -> Router {
    Router::new()
        .route("/", get(page))
        .route("/api/chats", get(list_chats))
        .route("/api/chats/{id}", get(chat_state))
        .route("/api/chats/{id}/automation", get(automation_state))
        .route(
            "/api/chats/{id}/automation/capabilities",
            post(automation_capabilities),
        )
        .route(
            "/api/chats/{id}/automation/selection",
            post(automation_selection),
        )
        .route("/api/chats/{id}/automation/pair", post(automation_pair))
        .route("/api/chats/{id}/automation/unlink", post(automation_unlink))
        .route("/api/chats/{id}/automation/login", post(automation_login))
        .route("/api/chats/{id}/automation/reveal", post(automation_reveal))
        .route(
            "/api/chats/{id}/automation/action",
            get(automation_action_state),
        )
        .route(
            "/api/chats/{id}/automation/action/cancel",
            post(automation_action_cancel),
        )
        .route(
            "/api/chats/{id}/automation/action/retry",
            post(automation_action_retry),
        )
        .route("/api/chats/{id}/markdown", get(chat_markdown))
        .route("/api/chats/{id}/send", post(chat_send))
        .route("/api/chats/{id}/file", get(chat_file))
        .route("/api/files", get(download))
        // A 16 MiB chat entry may expand sixfold when JSON-escaped.
        .layer(axum::extract::DefaultBodyLimit::max(
            crate::markdown_chat::MAX_UNREAD_BYTES * 6 + 1024,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            authorize,
        ))
        .with_state(state)
}

/// Return a verified local URL. The secret is only printed by this explicit CLI command.
pub async fn dashboard_url() -> anyhow::Result<String> {
    crate::tls::ensure_crypto_provider();
    let info = read_runtime(&runtime_path())?.ok_or_else(|| {
        anyhow::anyhow!(
            "Owner chat is unavailable; start the Codexify service with agentChat enabled"
        )
    })?;
    let url = format!("http://127.0.0.1:{}/", info.port);
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?
        .get(format!("{url}api/chats"))
        .bearer_auth(&info.token)
        .send()
        .await?;
    if !response.status().is_success()
        || !response
            .json::<Value>()
            .await?
            .get("chats")
            .is_some_and(Value::is_array)
    {
        anyhow::bail!(
            "Owner chat is unavailable; start the Codexify service with agentChat enabled"
        );
    }
    Ok(format!("{url}#{}", info.token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::agent_automation::{
        AutomationExecution, AutomationExecutionError, AutomationExecutor, CompanionActionSnapshot,
        PROTOCOL_VERSION,
    };
    use crate::exec_sessions::SessionState;
    use crate::project_bindings::ConversationIdentity;

    struct OwnerNoopExecutor;

    const OWNER_COMPANION_TOKEN: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
    const OWNER_COMPANION_BUILD: &str = "owner-companion-test-v1";

    #[derive(Clone, Default)]
    struct OwnerCompanionState {
        login_calls: Arc<AtomicUsize>,
        capabilities_calls: Arc<AtomicUsize>,
        reveal_calls: Arc<AtomicUsize>,
        revealed_url: Arc<std::sync::Mutex<Option<String>>>,
    }

    fn owner_companion_authorized(headers: &axum::http::HeaderMap) -> bool {
        headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            == Some(&format!("Bearer {OWNER_COMPANION_TOKEN}"))
    }

    fn owner_companion_health_value() -> Value {
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": crate::agent_automation::COMPANION_KIND,
            "build": OWNER_COMPANION_BUILD,
            "status": "idle",
            "authenticated": true,
            "accountFingerprint": "owner_account_1",
            "activeActionId": null
        })
    }

    async fn owner_companion_health(headers: axum::http::HeaderMap) -> Response {
        if !owner_companion_authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        Json(owner_companion_health_value()).into_response()
    }

    async fn owner_companion_login(
        State(state): State<OwnerCompanionState>,
        headers: axum::http::HeaderMap,
    ) -> Response {
        if !owner_companion_authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        state.login_calls.fetch_add(1, Ordering::SeqCst);
        Json(owner_companion_health_value()).into_response()
    }

    async fn owner_companion_capabilities(
        State(state): State<OwnerCompanionState>,
        headers: axum::http::HeaderMap,
    ) -> Response {
        if !owner_companion_authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        state.capabilities_calls.fetch_add(1, Ordering::SeqCst);
        Json(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "build": OWNER_COMPANION_BUILD,
            "accountFingerprint": "owner_account_1",
            "catalogRevision": "owner_catalog_1",
            "models": [{
                "id": "gpt-6-sol",
                "label": "GPT-6 Sol",
                "efforts": [
                    {"id":"high","label":"High","available":true,"reason":null},
                    {"id":"max","label":"Max","available":false,"reason":"not_available_for_account"}
                ]
            }]
        }))
        .into_response()
    }

    async fn owner_companion_reveal(
        State(state): State<OwnerCompanionState>,
        headers: axum::http::HeaderMap,
        Json(body): Json<Value>,
    ) -> Response {
        if !owner_companion_authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        state.reveal_calls.fetch_add(1, Ordering::SeqCst);
        *state.revealed_url.lock().unwrap() = body["url"].as_str().map(str::to_string);
        Json(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "build": OWNER_COMPANION_BUILD,
            "revealed": true,
            "activeActionId": null
        }))
        .into_response()
    }

    async fn spawn_owner_companion(
        root: &FilePath,
    ) -> (PathBuf, OwnerCompanionState, tokio::task::JoinHandle<()>) {
        let state = OwnerCompanionState::default();
        let app = Router::new()
            .route("/v1/health", get(owner_companion_health))
            .route("/v1/session/login", post(owner_companion_login))
            .route(
                "/v1/session/capabilities",
                post(owner_companion_capabilities),
            )
            .route("/v1/window/reveal", post(owner_companion_reveal))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let directory = root.join("browser");
        std::fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let descriptor = directory.join("descriptor.json");
        std::fs::write(
            &descriptor,
            serde_json::to_vec(&json!({
                "version": PROTOCOL_VERSION,
                "kind": crate::agent_automation::COMPANION_KIND,
                "pid": std::process::id(),
                "endpoint": endpoint,
                "token": OWNER_COMPANION_TOKEN,
                "build": OWNER_COMPANION_BUILD,
                "createdAt": "2026-10-09T12:00:00Z"
            }))
            .unwrap(),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&descriptor, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        (descriptor, state, task)
    }

    #[async_trait::async_trait]
    impl AutomationExecutor for OwnerNoopExecutor {
        async fn execute(
            &self,
            _execution: AutomationExecution,
            _events: tokio::sync::mpsc::UnboundedSender<crate::agent_automation::CompanionEvent>,
            _cancellation: CancellationToken,
        ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
            panic!("owner API goal commands must not execute the browser while the agent is online")
        }
    }

    #[test]
    fn owner_credentials_reuse_existing_runtime_format_and_only_update_the_port() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("owner-chat.json");
        let token = crate::auth::generate_internal_bearer_token().unwrap();
        let mut legacy = tempfile::NamedTempFile::new_in(temp.path()).unwrap();
        serde_json::to_writer(&mut legacy, &json!({"port":3120,"token":token})).unwrap();
        legacy.persist(&path).unwrap();

        let restored = load_or_create_runtime(&path, 43123).unwrap();
        assert!(restored.token == token);
        assert_eq!(restored.port, 43123);
        let persisted = read_runtime(&path).unwrap().unwrap();
        assert!(persisted.token == token);
        assert_eq!(persisted.port, 43123);
    }

    #[test]
    fn owner_credentials_concurrent_initialization_chooses_one_token() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("owner-chat.json");
        let barrier = std::sync::Barrier::new(8);
        let tokens = std::thread::scope(|scope| {
            let tasks: Vec<_> = (0..8)
                .map(|offset| {
                    let path = &path;
                    let barrier = &barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        load_or_create_runtime(path, 3120 + offset).unwrap().token
                    })
                })
                .collect();
            tasks
                .into_iter()
                .map(|task| task.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(tokens.iter().all(|token| token == &tokens[0]));
        assert!(read_runtime(&path).unwrap().unwrap().token == tokens[0]);
    }

    #[test]
    fn owner_credentials_reject_corruption_without_rotating_or_disclosing_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("owner-chat.json");
        load_or_create_runtime(&path, 3120).unwrap();
        for contents in [
            Vec::new(),
            b"not json".to_vec(),
            br#"{"port":3120,"token":""}"#.to_vec(),
            br#"{"port":3120,"token":"codexify_short"}"#.to_vec(),
            br#"{"port":"private-marker","token":"private-marker"}"#.to_vec(),
            vec![b' '; 4097],
        ] {
            std::fs::write(&path, &contents).unwrap();
            let error = load_or_create_runtime(&path, 43123).err().unwrap();
            assert!(!format!("{error:#}").contains("private-marker"));
            assert!(std::fs::read(&path).unwrap() == contents);
        }
    }

    #[cfg(unix)]
    #[test]
    fn owner_credentials_are_private_and_reject_unsafe_paths() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("owner-chat.json");
        load_or_create_runtime(&path, 3120).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let contents = std::fs::read(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_or_create_runtime(&path, 43123).is_err());
        assert!(std::fs::read(&path).unwrap() == contents);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        load_or_create_runtime(&path, 43123).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        let link = temp.path().join("linked.json");
        symlink(&path, &link).unwrap();
        assert!(load_or_create_runtime(&link, 3120).is_err());
        let dangling = temp.path().join("dangling.json");
        symlink(temp.path().join("missing.json"), &dangling).unwrap();
        assert!(load_or_create_runtime(&dangling, 3120).is_err());
        assert!(!temp.path().join("missing.json").exists());
        let directory = temp.path().join("directory.json");
        std::fs::create_dir(&directory).unwrap();
        assert!(load_or_create_runtime(&directory, 3120).is_err());
    }

    #[tokio::test]
    async fn owner_listener_uses_the_configured_port_or_an_ephemeral_default() {
        let temp = tempfile::tempdir().unwrap();
        let mut config = crate::config::default_config(temp.path().into());
        assert_eq!(
            config.markdown_chat.port,
            Some(crate::markdown_chat::DEFAULT_OWNER_CHAT_PORT)
        );

        config.markdown_chat.port = None;
        let ephemeral = bind_owner_listener(&config).await.unwrap();
        assert_ne!(ephemeral.local_addr().unwrap().port(), 0);
        drop(ephemeral);

        let reservation = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let fixed_port = reservation.local_addr().unwrap().port();
        drop(reservation);
        config.markdown_chat.port = Some(fixed_port);

        let fixed = bind_owner_listener(&config).await.unwrap();
        assert_eq!(fixed.local_addr().unwrap().port(), fixed_port);
        let error = bind_owner_listener(&config).await.err().unwrap();
        assert!(
            error
                .to_string()
                .contains(&format!("127.0.0.1:{fixed_port}"))
        );
    }

    #[tokio::test]
    async fn owner_api_lists_sends_and_reads_the_same_persisted_chat() {
        crate::tls::ensure_crypto_provider();
        let temp = tempfile::tempdir().unwrap();
        let mut config = crate::config::default_config(temp.path().into());
        config.markdown_chat.enabled = true;
        config.memory.dir = Some(temp.path().join("state").display().to_string());
        let identity = ConversationIdentity::from_openai_session("owner-api-test").unwrap();
        let chats = Arc::new(MarkdownChatStore::default());
        let chat = chats
            .chat(&config, Some(&identity), &SessionState::new())
            .unwrap();
        chat.ensure().await.unwrap();
        let artifacts = Arc::new(ArtifactEgressStore::new_at(
            config.artifact_egress.clone(),
            temp.path().join("artifacts"),
        ));
        let continuations = Arc::new(
            ConversationContinuationStore::new(temp.path().join("continuations-owner-api.json"))
                .unwrap(),
        );
        let state = OwnerState {
            config: Arc::new(config),
            chats,
            artifacts,
            continuations,
            automation: None,
            token: "test-token".into(),
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            axum::serve(listener, router(state)).await.unwrap();
        });
        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::new();
        let unauthorized = client
            .get(format!("{base}/api/chats"))
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        let rebinding = client
            .get(format!("{base}/api/chats"))
            .header(header::HOST, "other.example")
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap();
        assert_eq!(rebinding.status(), StatusCode::FORBIDDEN);
        let list: Value = client
            .get(format!("{base}/api/chats"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(list["chats"].as_array().unwrap().len(), 1);
        let id = list["chats"][0]["id"].as_str().unwrap();
        assert_eq!(list["chats"][0]["title"], "Untitled conversation");
        let sent: Value = client
            .post(format!("{base}/api/chats/{id}/send"))
            .bearer_auth("test-token")
            .json(&json!({"request_id":"owner-send", "message":"Check the build"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(sent["_meta"][CHAT_WIDGET_META]["sent"]["id"], "owner-send");
        assert_eq!(
            sent["_meta"][CHAT_WIDGET_META]["sent"]["tool_call_count"],
            0
        );
        let same_chat = chat.read(false).await.unwrap();
        assert!(same_chat.text.contains("Check the build"));
        let page: Value = client
            .get(format!("{base}/api/chats/{id}"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            page["_meta"][CHAT_WIDGET_META]["messages"][0]["markdown"],
            "Check the build"
        );
        assert_eq!(
            page["_meta"][CHAT_WIDGET_META]["messages"][0]["tool_call_count"],
            0
        );
        let renamed: Value = client
            .get(format!("{base}/api/chats"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(renamed["chats"][0]["title"], "Check the build");
        for index in 0..55 {
            chat.append(format!("Agent answer {index}")).await.unwrap();
        }
        let unauthorized_markdown = client
            .get(format!("{base}/api/chats/{id}/markdown"))
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized_markdown.status(), StatusCode::UNAUTHORIZED);
        let copied = client
            .get(format!("{base}/api/chats/{id}/markdown"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap();
        assert_eq!(copied.status(), StatusCode::OK);
        assert_eq!(
            copied.headers()[header::CONTENT_TYPE],
            "text/markdown; charset=utf-8"
        );
        let copied = copied.text().await.unwrap();
        assert!(copied.starts_with("## You\n\nCheck the build\n\n## Agent\n\nAgent answer 0"));
        assert!(copied.ends_with("## Agent\n\nAgent answer 54"));
        assert_eq!(copied.matches("## Agent\n\n").count(), 55);
        chat.record_agent_call(crate::markdown_chat::now_ms())
            .await
            .unwrap();
        let active: Value = client
            .get(format!("{base}/api/chats"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(active["chats"][0]["totalToolCalls"], 1);
        assert!(active["chats"][0]["lastAgentCallAtMs"].as_u64().unwrap() > 0);
        task.abort();
    }

    #[tokio::test]
    async fn owner_goal_commands_are_authenticated_idempotent_local_and_visible_in_state() {
        crate::tls::ensure_crypto_provider();
        let temp = tempfile::tempdir().unwrap();
        let mut config = crate::config::default_config(temp.path().join("project"));
        std::fs::create_dir_all(&config.work_dir).unwrap();
        config.markdown_chat.enabled = true;
        config.markdown_chat.automation.enabled = true;
        config.memory.dir = Some(temp.path().join("state").display().to_string());
        let identity = ConversationIdentity::from_openai_session("owner-goal-api").unwrap();
        let chats = Arc::new(MarkdownChatStore::default());
        let chat = chats
            .chat(&config, Some(&identity), &SessionState::new())
            .unwrap();
        chat.ensure().await.unwrap();
        let artifacts = Arc::new(ArtifactEgressStore::new_at(
            config.artifact_egress.clone(),
            temp.path().join("artifacts"),
        ));
        let continuations = Arc::new(
            crate::conversation_continuations::ConversationContinuationStore::new(
                temp.path().join("continuations.json"),
            )
            .unwrap(),
        );
        let supervisor = crate::agent_automation::AgentAutomationSupervisor::new(
            config.markdown_chat.automation.clone(),
            Arc::new(OwnerNoopExecutor),
        );
        let state = OwnerState {
            config: Arc::new(config),
            chats,
            artifacts,
            continuations,
            automation: Some(supervisor),
            token: "test-token".into(),
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            axum::serve(listener, router(state)).await.unwrap();
        });
        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::new();
        let list: Value = client
            .get(format!("{base}/api/chats"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = list["chats"][0]["id"].as_str().unwrap();

        let set_goal = || {
            client
                .post(format!("{base}/api/chats/{id}/send"))
                .bearer_auth("test-token")
                .json(&json!({
                    "request_id":"goal-set-request",
                    "message":"/goal set Finish the owner automation API."
                }))
                .send()
        };
        let first: Value = set_goal().await.unwrap().json().await.unwrap();
        let repeated: Value = set_goal().await.unwrap().json().await.unwrap();
        assert_eq!(first["_meta"][CHAT_WIDGET_META]["goal"]["revision"], 1);
        assert_eq!(repeated["_meta"][CHAT_WIDGET_META]["goal"]["revision"], 1);
        assert!(chat.clean_markdown_transcript().await.unwrap().is_empty());

        let run: Value = client
            .post(format!("{base}/api/chats/{id}/send"))
            .bearer_auth("test-token")
            .json(&json!({"request_id":"goal-run-request", "message":"/goal run"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(run["_meta"][CHAT_WIDGET_META]["goal"]["status"], "active");

        let automation: Value = client
            .get(format!("{base}/api/chats/{id}/automation"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(automation["enabled"], true);
        assert_eq!(automation["goal"]["revision"], 1);
        assert_eq!(automation["goal"]["status"], "active");
        assert_eq!(automation["pairing"]["status"], "unpaired");
        let serialized = automation.to_string();
        assert!(!serialized.contains("descriptorPath"));
        assert!(!serialized.contains("test-token"));
        assert!(!serialized.contains("Bearer"));

        let literal: Value = client
            .post(format!("{base}/api/chats/{id}/send"))
            .bearer_auth("test-token")
            .json(&json!({"request_id":"literal-goal", "message":"//goal status"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            literal["_meta"][CHAT_WIDGET_META]["sent"]["id"],
            "literal-goal"
        );
        assert!(
            chat.clean_markdown_transcript()
                .await
                .unwrap()
                .contains("/goal status")
        );
        task.abort();
    }

    #[tokio::test]
    async fn owner_automation_management_keeps_companion_credentials_server_side() {
        crate::tls::ensure_crypto_provider();
        let temp = tempfile::tempdir().unwrap();
        let (descriptor, companion_state, companion_task) =
            spawn_owner_companion(temp.path()).await;
        let bearer = OWNER_COMPANION_TOKEN;

        let mut config = crate::config::default_config(temp.path().join("project"));
        std::fs::create_dir_all(&config.work_dir).unwrap();
        config.markdown_chat.enabled = true;
        config.markdown_chat.automation.enabled = true;
        config.markdown_chat.automation.descriptor_path = descriptor.display().to_string();
        config.memory.dir = Some(temp.path().join("state").display().to_string());
        let identity = ConversationIdentity::from_openai_session("owner-management-api").unwrap();
        let chats = Arc::new(MarkdownChatStore::default());
        let chat = chats
            .chat(&config, Some(&identity), &SessionState::new())
            .unwrap();
        chat.ensure().await.unwrap();
        let artifacts = Arc::new(ArtifactEgressStore::new_at(
            config.artifact_egress.clone(),
            temp.path().join("artifacts"),
        ));
        let continuations = Arc::new(
            ConversationContinuationStore::new(temp.path().join("continuations-management.json"))
                .unwrap(),
        );
        let supervisor = crate::agent_automation::AgentAutomationSupervisor::new(
            config.markdown_chat.automation.clone(),
            Arc::new(OwnerNoopExecutor),
        );
        let state = OwnerState {
            config: Arc::new(config),
            chats,
            artifacts,
            continuations,
            automation: Some(supervisor.clone()),
            token: "test-token".into(),
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let owner_task = tokio::spawn(async move {
            axum::serve(listener, router(state)).await.unwrap();
        });
        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::new();
        let list: Value = client
            .get(format!("{base}/api/chats"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = list["chats"][0]["id"].as_str().unwrap();

        let unauthorized = client
            .post(format!("{base}/api/chats/{id}/automation/capabilities"))
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        let capabilities_response = client
            .post(format!("{base}/api/chats/{id}/automation/capabilities"))
            .bearer_auth("test-token")
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        let capabilities_status = capabilities_response.status();
        let capabilities_body = capabilities_response.text().await.unwrap();
        assert_eq!(capabilities_status, StatusCode::OK, "{capabilities_body}");
        let capabilities: Value = serde_json::from_str(&capabilities_body).unwrap();
        assert_eq!(capabilities["catalogRevision"], "owner_catalog_1");
        assert_eq!(capabilities["models"][0]["id"], "gpt-6-sol");
        assert!(capabilities.get("accountFingerprint").is_none());

        let login: Value = client
            .post(format!("{base}/api/chats/{id}/automation/login"))
            .bearer_auth("test-token")
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(login["companion"]["authenticated"], true);

        let selection: Value = client
            .post(format!("{base}/api/chats/{id}/automation/selection"))
            .bearer_auth("test-token")
            .json(&json!({
                "requestId":"selection-1",
                "model":"gpt-6-sol",
                "effort":"high"
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(selection["selection"]["model"], "gpt-6-sol");
        assert_eq!(selection["selection"]["effort"], "high");
        assert!(selection.to_string().find("owner_account_1").is_none());

        let paired: Value = client
            .post(format!("{base}/api/chats/{id}/automation/pair"))
            .bearer_auth("test-token")
            .json(&json!({
                "requestId":"pair-1",
                "url":"https://chatgpt.com/c/owner-management"
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(paired["pairing"]["status"], "unverified");
        assert_eq!(paired["action"]["status"], "queued");
        assert!(paired.get("reference").is_none());
        assert_eq!(supervisor.queued_count().await, 1);

        let queued: Value = client
            .get(format!("{base}/api/chats/{id}/automation"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(queued["queue"]["position"], 1);
        assert_eq!(queued["queue"]["total"], 1);

        let cancelled: Value = client
            .post(format!("{base}/api/chats/{id}/automation/action/cancel"))
            .bearer_auth("test-token")
            .json(&json!({
                "requestId":"cancel-pair-1",
                "actionId":paired["action"]["id"]
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(cancelled["action"]["status"], "unpaired");
        assert!(cancelled["queue"].is_null());
        assert_eq!(supervisor.queued_count().await, 0);

        let paired_again: Value = client
            .post(format!("{base}/api/chats/{id}/automation/pair"))
            .bearer_auth("test-token")
            .json(&json!({
                "requestId":"pair-2",
                "url":"https://chatgpt.com/c/owner-management"
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(paired_again["pairing"]["status"], "unverified");
        assert_eq!(supervisor.queued_count().await, 1);

        let action_status: Value = client
            .get(format!("{base}/api/chats/{id}/automation/action"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(action_status["action"]["status"], "queued");
        assert_eq!(action_status["queue"]["position"], 1);

        let revealed: Value = client
            .post(format!("{base}/api/chats/{id}/automation/reveal"))
            .bearer_auth("test-token")
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(revealed["revealed"], true);

        let unlinked: Value = client
            .post(format!("{base}/api/chats/{id}/automation/unlink"))
            .bearer_auth("test-token")
            .json(&json!({"requestId":"unlink-1"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(unlinked["pairing"]["status"], "unpaired");
        assert_eq!(supervisor.queued_count().await, 0);

        let joined = serde_json::to_string(&[
            capabilities,
            login,
            selection,
            paired,
            cancelled,
            paired_again,
            action_status,
            revealed,
            unlinked,
        ])
        .unwrap();
        assert!(!joined.contains(bearer));
        assert!(!joined.contains("owner_account_1"));
        assert!(!joined.contains(&descriptor.display().to_string()));
        assert_eq!(companion_state.login_calls.load(Ordering::SeqCst), 1);
        assert_eq!(companion_state.capabilities_calls.load(Ordering::SeqCst), 2);
        assert_eq!(companion_state.reveal_calls.load(Ordering::SeqCst), 1);
        owner_task.abort();
        companion_task.abort();
    }

    #[tokio::test]
    async fn owner_action_retry_and_cancel_preserve_unread_chat_until_tool_delivery() {
        crate::tls::ensure_crypto_provider();
        let temp = tempfile::tempdir().unwrap();
        let mut config = crate::config::default_config(temp.path().join("project"));
        std::fs::create_dir_all(&config.work_dir).unwrap();
        config.markdown_chat.enabled = true;
        config.markdown_chat.automation.enabled = true;
        config.memory.dir = Some(temp.path().join("state").display().to_string());
        let identity = ConversationIdentity::from_openai_session("owner-action-api").unwrap();
        let chats = Arc::new(MarkdownChatStore::default());
        let chat = chats
            .chat(&config, Some(&identity), &SessionState::new())
            .unwrap();
        chat.ensure().await.unwrap();
        let now_ms = crate::markdown_chat::now_ms();
        chat.record_agent_call(now_ms.saturating_sub(crate::markdown_chat::OFFLINE_AFTER_MS + 1))
            .await
            .unwrap();
        chat.append_user(
            "owner-action-message".into(),
            "Keep this pending through cancel and retry.".into(),
        )
        .await
        .unwrap();
        let store = Arc::new(AgentAutomationStore::for_config(&config).unwrap());
        store
            .set_selection(
                &identity,
                "gpt-6-sol",
                "high",
                "owner-catalog",
                "owner-account",
                now_ms,
            )
            .unwrap();
        let pairing = store
            .issue_pairing(&identity, "https://chatgpt.com/c/owner-action", 0, now_ms)
            .unwrap();
        store
            .record_pairing_canonical_url(
                &identity,
                pairing.generation,
                "https://chatgpt.com/c/owner-action",
                now_ms,
            )
            .unwrap();
        store
            .verify_pairing(&identity, pairing.generation, 0, &pairing.reference, now_ms)
            .unwrap();
        let supervisor = AgentAutomationSupervisor::new(
            config.markdown_chat.automation.clone(),
            Arc::new(OwnerNoopExecutor),
        );
        supervisor
            .register_task(AutomationTaskHandle::new(
                identity.clone(),
                0,
                store.clone(),
                chat.clone(),
            ))
            .await
            .unwrap();
        supervisor.scan_once(now_ms).await.unwrap();
        let failed_action = store.load(&identity).unwrap().action.id.unwrap();
        supervisor.discard_queued_actions(&identity).await;
        store
            .update_action_status(
                &identity,
                &failed_action,
                crate::agent_automation::AutomationActionStatus::Failed,
                Some("Selector verification failed before Send"),
                None,
                now_ms,
            )
            .unwrap();

        let artifacts = Arc::new(ArtifactEgressStore::new_at(
            config.artifact_egress.clone(),
            temp.path().join("artifacts"),
        ));
        let continuations = Arc::new(
            ConversationContinuationStore::new(temp.path().join("continuations-actions.json"))
                .unwrap(),
        );
        let state = OwnerState {
            config: Arc::new(config),
            chats,
            artifacts,
            continuations,
            automation: Some(supervisor.clone()),
            token: "test-token".into(),
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let owner_task = tokio::spawn(async move {
            axum::serve(listener, router(state)).await.unwrap();
        });
        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::new();
        let list: Value = client
            .get(format!("{base}/api/chats"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = list["chats"][0]["id"].as_str().unwrap();

        let retried: Value = client
            .post(format!("{base}/api/chats/{id}/automation/action/retry"))
            .bearer_auth("test-token")
            .json(&json!({
                "requestId":"retry-owner-action",
                "actionId":failed_action
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(retried["action"]["status"], "queued");
        assert_eq!(retried["queue"]["position"], 1);
        let queued_action = retried["action"]["id"].as_str().unwrap().to_string();

        let cancelled: Value = client
            .post(format!("{base}/api/chats/{id}/automation/action/cancel"))
            .bearer_auth("test-token")
            .json(&json!({
                "requestId":"cancel-owner-action",
                "actionId":queued_action
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(cancelled["action"]["status"], "failed");
        assert!(cancelled["queue"].is_null());
        assert_eq!(supervisor.queued_count().await, 0);
        assert!(
            chat.read(false)
                .await
                .unwrap()
                .text
                .contains("Keep this pending through cancel and retry.")
        );
        assert!(
            store
                .load(&identity)
                .unwrap()
                .chat_mirror
                .message_ids
                .is_empty()
        );
        owner_task.abort();
    }

    #[test]
    fn embedded_owner_page_reuses_chat_component_without_exposing_an_initial_chat() {
        assert!(OWNER_HTML.contains("id=\"chat-template\""));
        assert!(OWNER_HTML.contains("window.mountCodexifyChat"));
        assert!(OWNER_HTML.contains("/api/chats"));
        assert_eq!(OWNER_HTML.matches("id=\"chat\"").count(), 1);
    }

    #[test]
    fn goal_commands_are_exact_bounded_and_double_slash_escapes_to_chat() {
        assert_eq!(
            parse_owner_message("/goal set Finish the browser automation."),
            Ok(OwnerMessage::Goal(
                crate::agent_automation::OwnerGoalCommand::Set {
                    markdown: "Finish the browser automation.".into()
                }
            ))
        );
        assert_eq!(
            parse_owner_message("/goal run"),
            Ok(OwnerMessage::Goal(
                crate::agent_automation::OwnerGoalCommand::Run
            ))
        );
        assert_eq!(
            parse_owner_message("/goal stop"),
            Ok(OwnerMessage::Goal(
                crate::agent_automation::OwnerGoalCommand::Stop
            ))
        );
        assert_eq!(
            parse_owner_message("/goal clear"),
            Ok(OwnerMessage::Goal(
                crate::agent_automation::OwnerGoalCommand::Clear
            ))
        );
        assert_eq!(
            parse_owner_message("/goal status"),
            Ok(OwnerMessage::Goal(
                crate::agent_automation::OwnerGoalCommand::Status
            ))
        );
        assert_eq!(
            parse_owner_message("//goal status"),
            Ok(OwnerMessage::Chat("/goal status".into()))
        );
        assert_eq!(
            parse_owner_message("ordinary text"),
            Ok(OwnerMessage::Chat("ordinary text".into()))
        );
        assert!(
            parse_owner_message("/goal pause")
                .unwrap_err()
                .contains("Unknown")
        );
        assert!(
            parse_owner_message("/goal resume")
                .unwrap_err()
                .contains("Unknown")
        );
        assert!(
            parse_owner_message("/goal set")
                .unwrap_err()
                .contains("Markdown")
        );
        assert!(
            parse_owner_message(&format!("/goal set {}", "x".repeat(10 * 1024 + 1)))
                .unwrap_err()
                .contains("10 KiB")
        );
    }
}
