//! Per-ChatGPT-task Playwright MCP stdio connections.
//! A single upstream Playwright peer has mutable current-tab state. Never share
//! that peer across physical conversations or durable task continuations.
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rmcp::RoleClient;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::service::{Peer, RunningService};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, OnceCell, Semaphore};

use crate::bridge::connect_one;
use crate::project_bindings::ConversationIdentity;
use crate::types::{AppConfig, McpServerSpec, McpSessionScope};
use crate::upstream_control::UpstreamControl;

const MAX_LIVE_SESSIONS: usize = 16;
const MAX_PARALLEL_BROWSER_STARTS: usize = 3;
const IDLE_SESSION_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_PRIVATE_PROFILES: usize = 16;
const SHARED_PROFILES_ENV: &str = "CODEXIFY_SHARED_PLAYWRIGHT_PROFILES";
pub(crate) const OWNED_BROWSER_ENV: &[&str] = &[
    "PLAYWRIGHT_MCP_USER_DATA_DIR",
    "PLAYWRIGHT_MCP_CDP_ENDPOINT",
    "PLAYWRIGHT_MCP_STORAGE_STATE",
    "PLAYWRIGHT_MCP_ISOLATED",
    "PLAYWRIGHT_MCP_CONFIG",
    "PLAYWRIGHT_MCP_PORT",
];
pub(crate) const PROFILE_TOOL: &str = "codexify_browser_session";

pub(crate) fn profile_tool() -> rmcp::model::Tool {
    rmcp::model::Tool::new(
        PROFILE_TOOL,
        "Manage named persistent Playwright profiles. list is a read-only inventory (last observed tabs, no browser launch); create provisions and selects a new private profile; launch creates one and opens a blank tab; select/reconnect selects a known profile and reuses its live connection or saved login on the next browser call; release relinquishes an idle owned connection without deleting its profile. Shared profiles require explicit operator configuration and exclusive ownership. Use browser_tabs list for a fresh list in the selected browser.",
        json!({
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "create", "launch", "select", "reconnect", "release"]},
                "profile": {"type": "string", "description": "Lowercase profile name, 1-40 ASCII letters, digits, hyphens or underscores. Required except list/release; default is the original per-chat profile."}
            },
            "required": ["action"], "additionalProperties": false
        }).as_object().unwrap().clone(),
    )
}

pub(crate) enum ProfileAction {
    Local(Value),
    Launch(String),
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

#[derive(Debug, Clone)]
struct TabObservation {
    observed: Instant,
    tabs: Vec<Value>,
}

// Playwright's human-readable tab output is not a stable API. Only accept a
// recognised, complete section; never retain titles, paths, queries or tokens.
fn observed_tabs(result: &CallToolResult, tool: &str) -> Option<TabObservation> {
    if result.is_error == Some(true) {
        return None;
    }
    for block in &result.content {
        let ContentBlock::Text(text) = block else {
            continue;
        };
        let mut lines = text.text.lines().peekable();
        while let Some(line) = lines.next() {
            if line.trim() != "### Open tabs"
                && !(tool == "browser_tabs" && line.trim() == "### Result")
            {
                continue;
            }
            let mut tabs = Vec::new();
            let mut complete = false;
            for row in lines.by_ref() {
                let row = row.trim();
                if row.is_empty() {
                    continue;
                }
                if row.starts_with("### ") {
                    complete = !tabs.is_empty();
                    break;
                }
                if row.starts_with("No open tabs") {
                    complete = tabs.is_empty();
                    break;
                }
                let Some((index, detail)) = row.strip_prefix("- ").and_then(|s| s.split_once(": "))
                else {
                    complete = false;
                    break;
                };
                let Ok(index) = index.parse::<usize>() else {
                    complete = false;
                    break;
                };
                if index != tabs.len() || tabs.len() >= 200 {
                    complete = false;
                    break;
                }
                let origin = detail
                    .rsplit_once("](")
                    .and_then(|(_, url)| url.strip_suffix(')'))
                    .and_then(|url| reqwest::Url::parse(url).ok())
                    .filter(|url| matches!(url.scheme(), "http" | "https"))
                    .map(|url| url.origin().ascii_serialization());
                tabs.push(json!({"index": index, "current": detail.starts_with("(current)"), "origin": origin}));
                complete = true;
            }
            if complete {
                return Some(TabObservation {
                    observed: Instant::now(),
                    tabs,
                });
            }
        }
    }
    None
}

pub(crate) struct ScopedConnection {
    // Hold the upstream process and transport alive for this conversation.
    _service: RunningService<RoleClient, ()>,
    pub(crate) peer: Peer<RoleClient>,
    pub(crate) control: Arc<UpstreamControl>,
    tabs: Mutex<Option<TabObservation>>,
}

impl ScopedConnection {
    pub(crate) fn observe_tabs(&self, result: Option<&CallToolResult>, tool: &str) {
        if tool.starts_with("browser_") {
            *self.tabs.lock().unwrap_or_else(|e| e.into_inner()) =
                result.and_then(|r| observed_tabs(r, tool));
        }
    }
}

struct SessionSlot {
    owner: String,
    connection: OnceCell<Arc<ScopedConnection>>,
    last_used: Mutex<Instant>,
}

impl SessionSlot {
    fn new(owner: String) -> Self {
        Self {
            owner,
            connection: OnceCell::new(),
            last_used: Mutex::new(Instant::now()),
        }
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }

    fn expired_at(&self, now: Instant) -> bool {
        now.saturating_duration_since(*self.last_used.lock().unwrap_or_else(|e| e.into_inner()))
            >= IDLE_SESSION_TTL
    }
}

fn in_use(slot: &Arc<SessionSlot>) -> bool {
    Arc::strong_count(slot) > 1
        || slot
            .connection
            .get()
            .is_some_and(|c| Arc::strong_count(c) > 1)
}

#[derive(Default)]
struct ProfileState {
    sessions: HashMap<String, Arc<SessionSlot>>,
    // Absent means the legacy default. None means explicitly released; do not
    // silently redirect the next action to a different browser.
    selected: HashMap<String, Option<String>>,
}

pub(crate) struct ScopedPlaywrightPool {
    server: String,
    instance_port: u16,
    config: AppConfig,
    spec: McpServerSpec,
    extension: bool,
    profiles_root: PathBuf,
    state: AsyncMutex<ProfileState>,
    shared_profiles: BTreeSet<String>,
    startup_capacity: Semaphore,
}

impl ScopedPlaywrightPool {
    pub(crate) fn new(
        server: &str,
        spec: &McpServerSpec,
        config: &AppConfig,
    ) -> Result<Self, String> {
        if spec.session_scope != McpSessionScope::PerChat {
            return Err("per-chat Playwright requires sessionScope=per-chat".into());
        }
        if spec.command.is_none() || spec.url.is_some() {
            return Err("per-chat Playwright requires a local stdio MCP server".into());
        }
        let playwright = server.to_ascii_lowercase().contains("playwright")
            || spec
                .args
                .iter()
                .any(|arg| arg.to_ascii_lowercase().contains("playwright"));
        if !playwright {
            return Err("sessionScope=per-chat is only supported for Playwright MCP".into());
        }
        let extension = is_extension(server, spec);
        for key in OWNED_BROWSER_ENV {
            if spec.env.contains_key(*key) {
                return Err(format!(
                    "per-chat Playwright must own its session lifecycle; remove {key}"
                ));
            }
        }
        let mut shared_profiles = BTreeSet::new();
        if let Some(names) = spec.env.get(SHARED_PROFILES_ENV) {
            if extension {
                return Err("named shared Playwright profiles require managed browser mode, not extension mode".into());
            }
            for name in names.split(',').map(str::trim) {
                if !valid_name(name)
                    || name == "default"
                    || !shared_profiles.insert(name.to_owned())
                {
                    return Err("invalid or duplicate configured shared Playwright profile".into());
                }
            }
            if shared_profiles.len() > MAX_LIVE_SESSIONS {
                return Err("too many configured shared Playwright profiles".into());
            }
        }
        for forbidden in [
            "--user-data-dir",
            "--shared-browser-context",
            "--cdp-endpoint",
            "--endpoint",
            "--storage-state",
            "--isolated",
            "--no-tab-group",
            "--session-name",
            "--profile-dir-name",
            "--config",
            "--port",
        ] {
            if spec
                .args
                .iter()
                .any(|arg| arg == forbidden || arg.starts_with(&format!("{forbidden}=")))
            {
                return Err(format!(
                    "per-chat Playwright must own its session lifecycle; remove {forbidden}"
                ));
            }
        }
        if spec
            .env
            .get("PLAYWRIGHT_MCP_NO_TAB_GROUP")
            .is_some_and(|v| v == "1")
        {
            return Err("per-chat extension mode requires tab groups for ownership".into());
        }
        if extension {
            let profile = spec.env.get("PLAYWRIGHT_MCP_PROFILE_DIR_NAME");
            if profile.is_none_or(|name| name.is_empty() || name == "Default") {
                return Err("per-chat extension mode requires an explicitly dedicated                    non-default Chrome profile (PLAYWRIGHT_MCP_PROFILE_DIR_NAME)".into());
            }
            let configured_token = spec
                .env
                .get("PLAYWRIGHT_MCP_EXTENSION_TOKEN")
                .is_some_and(|v| !v.trim().is_empty());
            let configured_file = spec
                .env
                .get("PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE")
                .is_some_and(|v| !v.trim().is_empty());
            // Consent must be explicit in this dedicated MCP source, never an
            // ambient token inherited from the interactive user session.
            if !configured_token && !configured_file {
                return Err("per-chat Playwright extension needs PLAYWRIGHT_MCP_EXTENSION_TOKEN                   or PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE for a dedicated browser profile;                   refusing manual approval prompts".into());
            }
            if configured_token && configured_file {
                return Err("configure only one Playwright extension token source".into());
            }
        }
        let root = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| config.work_dir.clone())
            .join(".codexify")
            .join("playwright-agent-profiles");
        Ok(Self {
            server: server.to_string(),
            instance_port: config.port,
            config: config.clone(),
            spec: spec.clone(),
            extension,
            profiles_root: root,
            state: AsyncMutex::new(ProfileState::default()),
            shared_profiles,
            startup_capacity: Semaphore::new(MAX_PARALLEL_BROWSER_STARTS),
        })
    }

    pub(crate) fn supports_profiles(&self) -> bool {
        !self.extension
    }

    #[cfg(test)]
    pub(crate) fn set_test_root(&mut self, root: PathBuf) {
        self.profiles_root = root;
    }

    fn scoped_spec(&self, owner: &ConversationIdentity) -> Result<McpServerSpec, String> {
        self.scoped_spec_for(owner, "default")
    }

    fn scoped_spec_for(
        &self,
        owner: &ConversationIdentity,
        name: &str,
    ) -> Result<McpServerSpec, String> {
        let key = owner.stable_key();
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid per-chat browser owner identity".into());
        }
        let mut spec = self.spec.clone();
        spec.env.remove(SHARED_PROFILES_ENV);
        // Managed Chromium can take longer than the generic 20-second MCP
        // default to cold-start under desktop load. Keep explicit overrides.
        if !self.extension && spec.startup_timeout_sec.is_none() {
            spec.startup_timeout_sec = Some(60.0);
        }
        if self.extension {
            load_extension_token(&mut spec)?;
            spec.env.insert(
                "PLAYWRIGHT_MCP_SESSION_NAME".into(),
                format!("Codexify-{}-{}", self.instance_port, &key[..12]),
            );
            // The extension owns each client's tab group and token-based
            // connections start on a new blank tab (never an existing tab).
            spec.env
                .insert("PLAYWRIGHT_MCP_NO_TAB_GROUP".into(), "0".into());
            spec.env
                .insert("PLAYWRIGHT_MCP_BACKGROUND".into(), "1".into());
        } else if name != "default" {
            let relative = self.named_relative(key, name);
            self.checked_dir(&relative, true)?
                .ok_or("could not prepare named Playwright profile")?;
            // Canonicalization is for containment checks, not for passing a
            // Windows extended-length path to a third-party browser process.
            let profile = self.profiles_root.join(relative);
            spec.args
                .push(format!("--user-data-dir={}", profile.display()));
        } else {
            let safe_server: String = self
                .server
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let profile = self
                .profiles_root
                .join(safe_server)
                .join(self.instance_port.to_string())
                .join(key);
            std::fs::create_dir_all(&profile)
                .map_err(|e| format!("could not prepare per-chat browser profile: {e}"))?;
            spec.args
                .push(format!("--user-data-dir={}", profile.display()));
        }
        Ok(spec)
    }

    /// An isolated catalog-discovery connection is only used to fetch schemas.
    /// It must not attach to any real task or browser session.
    pub(crate) fn discovery_spec(&self) -> Result<McpServerSpec, String> {
        let identity = ConversationIdentity::from_openai_session(
            "codexify-playwright-catalog-discovery-not-a-user",
        )
        .ok_or("could not create discovery owner")?;
        self.scoped_spec(&identity)
    }

    fn named_base(&self) -> PathBuf {
        // Preserve legacy default paths; hash the source name to avoid aliases.
        PathBuf::from("named-v1")
            .join(format!("{:x}", Sha256::digest(self.server.as_bytes())))
            .join(self.instance_port.to_string())
    }

    fn private_base(&self, owner: &str) -> PathBuf {
        self.named_base().join("private").join(owner)
    }

    fn named_relative(&self, owner: &str, name: &str) -> PathBuf {
        let base = if self.shared_profiles.contains(name) {
            self.named_base().join("shared")
        } else {
            self.private_base(owner)
        };
        base.join(format!("p-{name}"))
    }

    // Reject redirects under the trusted managed root, including junctions.
    fn checked_dir(&self, relative: &Path, create: bool) -> Result<Option<PathBuf>, String> {
        if create {
            std::fs::create_dir_all(&self.profiles_root)
                .map_err(|_| "could not prepare managed browser root")?;
        }
        let mut current = match std::fs::canonicalize(&self.profiles_root) {
            Ok(path) => path,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !create => return Ok(None),
            Err(_) => return Err("managed browser root is unavailable".into()),
        };
        for part in relative.components() {
            let std::path::Component::Normal(part) = part else {
                return Err("invalid managed browser profile path".into());
            };
            let child = current.join(part);
            match std::fs::symlink_metadata(&child) {
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
                Ok(_) => return Err("managed browser profile path is not a directory".into()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if !create {
                        return Ok(None);
                    }
                    if let Err(error) = std::fs::create_dir(&child)
                        && error.kind() != std::io::ErrorKind::AlreadyExists
                    {
                        return Err("could not create managed browser profile directory".into());
                    }
                    let meta = std::fs::symlink_metadata(&child)
                        .map_err(|_| "could not inspect new managed browser profile directory")?;
                    if !meta.is_dir() || meta.file_type().is_symlink() {
                        return Err("new managed browser profile path is not a directory".into());
                    }
                }
                Err(_) => return Err("could not inspect managed browser profile directory".into()),
            }
            let resolved = std::fs::canonicalize(&child)
                .map_err(|_| "could not resolve managed browser profile directory")?;
            if resolved != child {
                return Err("managed browser profile directory is redirected".into());
            }
            current = resolved;
        }
        Ok(Some(current))
    }

    fn private_names(&self, owner: &str) -> Result<BTreeSet<String>, String> {
        let mut names = BTreeSet::new();
        let Some(dir) = self.checked_dir(&self.private_base(owner), false)? else {
            return Ok(names);
        };
        for entry in
            std::fs::read_dir(dir).map_err(|_| "could not list managed browser profiles")?
        {
            let entry = entry.map_err(|_| "could not read managed browser profile entry")?;
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str().and_then(|n| n.strip_prefix("p-")) else {
                continue;
            };
            if valid_name(name)
                && name != "default"
                && entry
                    .file_type()
                    .is_ok_and(|t| t.is_dir() && !t.is_symlink())
            {
                names.insert(name.to_owned());
            }
        }
        Ok(names)
    }

    fn session_key(&self, owner: &str, name: &str) -> String {
        if name == "default" {
            owner.to_owned()
        } else if self.shared_profiles.contains(name) {
            format!("shared:{name}")
        } else {
            format!("{owner}:{name}")
        }
    }

    fn selected(state: &ProfileState, owner: &str) -> Option<String> {
        state
            .selected
            .get(owner)
            .cloned()
            .unwrap_or_else(|| Some("default".into()))
    }

    fn prune_idle(state: &mut ProfileState) {
        Self::prune_idle_at(state, Instant::now());
    }

    fn prune_idle_at(state: &mut ProfileState, now: Instant) {
        let mut expired_shared = Vec::new();
        state.sessions.retain(|key, slot| {
            let keep = !slot.expired_at(now) || in_use(slot);
            if !keep && let Some(name) = key.strip_prefix("shared:") {
                expired_shared.push((slot.owner.clone(), name.to_owned()));
            }
            keep
        });
        for (owner, name) in expired_shared {
            // An expired shared lease is no longer an explicit selection.
            // A former owner must reconnect rather than silently reclaim it.
            if Self::selected(state, &owner).as_deref() == Some(name.as_str()) {
                state.selected.insert(owner, None);
            }
        }
    }

    fn reserve(
        &self,
        state: &mut ProfileState,
        owner: &str,
        name: &str,
    ) -> Result<Arc<SessionSlot>, String> {
        let key = self.session_key(owner, name);
        if let Some(slot) = state.sessions.get(&key) {
            if slot.owner != owner {
                return Err("browser profile is leased by another task; choose a different profile or ask its owner to release it".into());
            }
            slot.touch();
            return Ok(slot.clone());
        }
        if state.sessions.len() >= MAX_LIVE_SESSIONS {
            return Err("per-chat Playwright capacity reached; wait for an idle session to expire rather than sharing another agent's browser".into());
        }
        let slot = Arc::new(SessionSlot::new(owner.to_owned()));
        state.sessions.insert(key, slot.clone());
        Ok(slot)
    }

    fn inventory(&self, state: &ProfileState, owner: &str) -> Result<Value, String> {
        let selected = Self::selected(state, owner);
        let mut names = self.private_names(owner)?;
        names.extend(self.shared_profiles.iter().cloned());
        names.insert("default".into());
        let mut profiles = Vec::new();
        for name in names {
            let slot = state.sessions.get(&self.session_key(owner, &name));
            let mine = slot.is_some_and(|s| s.owner == owner);
            let connection = slot.and_then(|s| s.connection.get());
            let tabs = if mine {
                connection.and_then(|c| {
                    let guard = c.tabs.lock().unwrap_or_else(|e| e.into_inner());
                    guard.as_ref().map(
                        |t| json!({"age_seconds": t.observed.elapsed().as_secs(), "tabs": t.tabs}),
                    )
                })
            } else {
                None
            };
            let observed_count = connection.and_then(|c| {
                let guard = c.tabs.lock().unwrap_or_else(|e| e.into_inner());
                guard.as_ref().map(|t| json!({"age_seconds": t.observed.elapsed().as_secs(), "count": t.tabs.len()}))
            });
            profiles.push(json!({
                "profile": name,
                "shared": self.shared_profiles.contains(&name),
                "selected": selected.as_deref() == Some(name.as_str()),
                "lease": if mine {"owned"} else if slot.is_some() {"busy"} else {"available"},
                "mcp_connected": connection.is_some(),
                "last_observed_tabs": tabs,
                "last_observed_tab_count": observed_count,
            }));
        }
        let mut other_private_sessions = state.sessions.iter()
            .filter(|(key, slot)| slot.owner != owner && !key.starts_with("shared:"))
            .map(|(_, slot)| {
                let connection = slot.connection.get();
                let observation = connection.and_then(|c| {
                    let guard = c.tabs.lock().unwrap_or_else(|e| e.into_inner());
                    guard.as_ref().map(|t| json!({"age_seconds": t.observed.elapsed().as_secs(), "count": t.tabs.len()}))
                });
                json!({"mcp_connected": connection.is_some(), "last_observed_tab_count": observation})
            }).collect::<Vec<_>>();
        // Do not reveal the other worker's identity, profile name or URL.
        other_private_sessions.sort_by_key(|entry| entry.to_string());
        Ok(json!({
            "source": self.server,
            "selected": selected,
            "profiles": profiles,
            "other_worker_leases": state.sessions.values().filter(|s| s.owner != owner).count(),
            "other_private_sessions": other_private_sessions,
            "lease_capacity": MAX_LIVE_SESSIONS,
            "inventory_is_cached": true,
            "note": "No browser was launched or focused. Tab observations are not live guarantees; use browser_tabs list in an owned profile to refresh. Other workers' private tab identities and unmanaged Chrome windows are not exposed."
        }))
    }

    pub(crate) async fn manage(
        &self,
        owner: Option<&ConversationIdentity>,
        args: Option<&serde_json::Map<String, Value>>,
    ) -> Result<ProfileAction, String> {
        let owner = owner.ok_or("browser profile management requires a verified task identity")?;
        if !self.supports_profiles() {
            return Err("named profiles require managed Playwright; extension tab groups are not separate profiles".into());
        }
        let args = args.ok_or("action is required")?;
        if args.keys().any(|key| key != "action" && key != "profile") {
            return Err("unsupported browser profile argument".into());
        }
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .ok_or("action is required")?;
        let supplied = match args.get("profile") {
            None => None,
            Some(Value::String(name)) if valid_name(name) => Some(name.as_str()),
            Some(_) => return Err("invalid profile name; use 1-40 lowercase ASCII letters, digits, hyphens or underscores".into()),
        };
        let owner = owner.stable_key();
        let mut state = self.state.lock().await;
        if action == "list" {
            if supplied.is_some() {
                return Err("list does not take a profile name".into());
            }
            // Even idle cleanup may close a browser; inventory never prunes.
            return self.inventory(&state, owner).map(ProfileAction::Local);
        }
        let name = match supplied {
            Some(name) => name.to_owned(),
            None if action == "release" => {
                Self::selected(&state, owner).ok_or("no browser profile selected")?
            }
            None => return Err("profile is required".into()),
        };
        let key = self.session_key(owner, &name);
        if action == "release" {
            let Some(slot) = state.sessions.get(&key) else {
                return Err("no owned browser lease to release".into());
            };
            if slot.owner != owner {
                return Err("cannot release another task's browser profile".into());
            }
            if in_use(slot) {
                return Err("browser profile is in use; release refused".into());
            }
            state.sessions.remove(&key);
            if Self::selected(&state, owner).as_deref() == Some(name.as_str()) {
                state.selected.insert(owner.to_owned(), None);
            }
            return Ok(ProfileAction::Local(
                json!({"profile": name, "released": true, "profile_preserved": true}),
            ));
        }
        if !matches!(action, "create" | "launch" | "select" | "reconnect") {
            return Err("unknown browser profile action".into());
        }
        Self::prune_idle(&mut state);
        if let Some(previous) = Self::selected(&state, owner)
            && previous != name
            && state
                .sessions
                .get(&self.session_key(owner, &previous))
                .is_some_and(in_use)
        {
            return Err("selected browser profile is in use; switching refused".into());
        }
        let create = matches!(action, "create" | "launch");
        if create {
            if name == "default" || self.shared_profiles.contains(&name) {
                return Err("use select for default or operator-configured shared profiles".into());
            }
            let names = self.private_names(owner)?;
            if names.contains(&name) {
                return Err("profile already exists; use select or reconnect".into());
            }
            if names.len() >= MAX_PRIVATE_PROFILES {
                return Err("private profile limit reached; reuse an existing profile".into());
            }
        } else if name != "default"
            && !self.shared_profiles.contains(&name)
            && self
                .checked_dir(&self.named_relative(owner, &name), false)?
                .is_none()
        {
            return Err("unknown private browser profile; use create or launch".into());
        }
        if let Some(slot) = state.sessions.get(&key) {
            if slot.owner != owner {
                return Err(
                    "browser profile is leased by another task; select a different profile".into(),
                );
            }
        } else if state.sessions.len() >= MAX_LIVE_SESSIONS {
            return Err(
                "per-chat Playwright capacity reached; release an idle owned profile".into(),
            );
        }
        if name != "default" {
            self.checked_dir(&self.named_relative(owner, &name), true)?;
        }
        let slot = self.reserve(&mut state, owner, &name)?;
        let connected = slot.connection.get().is_some();
        state.selected.insert(owner.to_owned(), Some(name.clone()));
        if action == "launch" {
            return Ok(ProfileAction::Launch(name));
        }
        Ok(ProfileAction::Local(json!({
            "profile": name, "selected": true, "created": create,
            "mcp_connected": connected, "browser_started_by_this_call": false,
            "next": "Use browser_tabs list or another browser tool to reuse the existing peer or start the saved profile."
        })))
    }

    pub(crate) async fn acquire(
        &self,
        owner: Option<&ConversationIdentity>,
    ) -> Result<Arc<ScopedConnection>, String> {
        self.acquire_for(owner, None).await
    }

    pub(crate) async fn acquire_for(
        &self,
        owner: Option<&ConversationIdentity>,
        expected_profile: Option<&str>,
    ) -> Result<Arc<ScopedConnection>, String> {
        let owner = owner.ok_or(
            "per-chat Playwright needs a verified ChatGPT conversation/task identity; \
             refusing the shared global browser",
        )?;
        let key = owner.stable_key().to_owned();
        let (slot, name) = {
            let mut state = self.state.lock().await;
            Self::prune_idle(&mut state);
            let name = Self::selected(&state, &key)
                .ok_or("no browser profile selected; use select or reconnect")?;
            if expected_profile.is_some_and(|expected| expected != name) {
                return Err(
                    "selected browser changed before launch; no browser operation dispatched"
                        .into(),
                );
            }
            (self.reserve(&mut state, &key, &name)?, name)
        };
        let connection = slot
            .connection
            .get_or_try_init(|| async {
                let _start = self
                    .startup_capacity
                    .acquire()
                    .await
                    .map_err(|_| "per-chat browser startup limiter closed")?;
                let scoped = self.scoped_spec_for(owner, &name)?;
                let (service, _tools, _timeout) =
                    connect_one(&self.server, &scoped, &self.config).await?;
                let peer = service.peer().clone();
                let control = Arc::new(
                    UpstreamControl::new(scoped.request_limits.clone())
                        .for_server(&self.server, &scoped),
                );
                Ok::<_, String>(Arc::new(ScopedConnection {
                    _service: service,
                    peer,
                    control,
                    tabs: Mutex::new(None),
                }))
            })
            .await?;
        Ok(connection.clone())
    }
}

// Never log, store in the upstream catalog, or place in MCP metadata.
// The file is provisioned once with a user-only ACL by the optional setup
// script. Reading it at connection time also supports safe token rotation.
fn load_extension_token(spec: &mut McpServerSpec) -> Result<(), String> {
    let token_file = spec.env.remove("PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE");
    if let Some(filename) = token_file {
        if spec.env.contains_key("PLAYWRIGHT_MCP_EXTENSION_TOKEN") {
            return Err("multiple Playwright extension token sources".into());
        }
        let path = PathBuf::from(filename);
        if !path.is_absolute() {
            return Err("Playwright extension token file must be an absolute path".into());
        }
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| "Playwright extension token file could not be opened")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1024 {
            return Err("Playwright extension token file must be a regular, small file".into());
        }
        let source = std::fs::read_to_string(&path)
            .map_err(|_| "Playwright extension token file could not be read")?;
        let token = source.trim_end_matches(['\r', '\n']);
        if !(16..=512).contains(&token.len())
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("Playwright extension token file has an invalid token format".into());
        }
        spec.env
            .insert("PLAYWRIGHT_MCP_EXTENSION_TOKEN".into(), token.into());
    }
    Ok(())
}

fn is_extension(server: &str, spec: &McpServerSpec) -> bool {
    server.to_ascii_lowercase().contains("extension")
        || spec
            .args
            .iter()
            .any(|arg| arg == "--extension" || arg == "--extension=true")
        || spec
            .env
            .get("PLAYWRIGHT_MCP_EXTENSION")
            .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::McpSessionScope;

    fn stub_config() -> AppConfig {
        crate::config::default_config(std::env::temp_dir())
    }

    fn spec(extension: bool) -> McpServerSpec {
        let mut spec = McpServerSpec {
            command: Some("node".into()),
            args: vec!["@playwright/mcp".into()],
            session_scope: McpSessionScope::PerChat,
            ..Default::default()
        };
        if extension {
            spec.args.push("--extension".into());
            spec.env
                .insert("PLAYWRIGHT_MCP_PROFILE_DIR_NAME".into(), "Codexify".into());
            spec.env.insert(
                "PLAYWRIGHT_MCP_EXTENSION_TOKEN".into(),
                "test-token-not-a-real-secret".into(),
            );
        }
        spec
    }

    fn named_pool(root: &Path, shared: Option<&str>) -> ScopedPlaywrightPool {
        let mut initial = spec(false);
        if let Some(names) = shared {
            initial.env.insert(SHARED_PROFILES_ENV.into(), names.into());
        }
        let mut pool = ScopedPlaywrightPool::new("playwright", &initial, &stub_config()).unwrap();
        pool.profiles_root = root.to_owned();
        pool
    }

    async fn manage_for(
        pool: &ScopedPlaywrightPool,
        owner: &ConversationIdentity,
        action: &str,
        name: Option<&str>,
    ) -> Result<ProfileAction, String> {
        let mut args = serde_json::Map::new();
        args.insert("action".into(), json!(action));
        if let Some(name) = name {
            args.insert("profile".into(), json!(name));
        }
        pool.manage(Some(owner), Some(&args)).await
    }

    fn local_value(result: Result<ProfileAction, String>) -> Value {
        match result {
            Ok(ProfileAction::Local(value)) => value,
            _ => panic!("expected local profile response"),
        }
    }

    #[tokio::test]
    async fn named_profiles_are_private_persistent_and_inventory_never_starts_a_browser() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("not-created");
        let pool = named_pool(&root, None);
        let a = ConversationIdentity::from_openai_session("named-A").unwrap();
        let b = ConversationIdentity::from_openai_session("named-B").unwrap();
        let before = local_value(manage_for(&pool, &a, "list", None).await);
        assert_eq!(before["selected"], "default");
        assert_eq!(before["profiles"].as_array().unwrap().len(), 1);
        assert!(!root.exists());
        assert!(pool.state.lock().await.sessions.is_empty());
        let created = local_value(manage_for(&pool, &a, "create", Some("authority")).await);
        assert_eq!(created["created"], true);
        assert_eq!(created["mcp_connected"], false);
        assert!(
            manage_for(&pool, &a, "create", Some("authority"))
                .await
                .is_err()
        );
        assert!(
            manage_for(&pool, &b, "select", Some("authority"))
                .await
                .is_err()
        );
        let b_list = local_value(manage_for(&pool, &b, "list", None).await);
        assert_eq!(b_list["profiles"].as_array().unwrap().len(), 1);
        assert_eq!(b_list["other_worker_leases"], 1);
        local_value(manage_for(&pool, &b, "create", Some("authority")).await);
        let a_spec = pool.scoped_spec_for(&a, "authority").unwrap();
        let b_spec = pool.scoped_spec_for(&b, "authority").unwrap();
        assert_ne!(a_spec.args, b_spec.args);
        assert!(
            a_spec
                .args
                .iter()
                .any(|arg| arg.starts_with("--user-data-dir="))
        );
        local_value(manage_for(&pool, &a, "release", None).await);
        assert!(
            pool.acquire(Some(&a))
                .await
                .err()
                .unwrap()
                .contains("no browser profile selected")
        );
        let restarted = named_pool(&root, None);
        let a_list = local_value(manage_for(&restarted, &a, "list", None).await);
        assert!(
            a_list["profiles"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["profile"] == "authority")
        );
        local_value(manage_for(&restarted, &a, "reconnect", Some("authority")).await);
        assert_eq!(
            restarted.scoped_spec_for(&a, "authority").unwrap().args,
            a_spec.args
        );
        assert!(
            restarted
                .state
                .lock()
                .await
                .sessions
                .values()
                .all(|s| s.connection.get().is_none())
        );
    }

    #[tokio::test]
    async fn explicitly_shared_profiles_require_exclusive_leases_and_preserve_login_directory() {
        let temp = tempfile::tempdir().unwrap();
        let pool = named_pool(temp.path(), Some("authority-research"));
        let a = ConversationIdentity::from_openai_session("shared-A").unwrap();
        let b = ConversationIdentity::from_openai_session("shared-B").unwrap();
        assert!(
            manage_for(&pool, &a, "create", Some("authority-research"))
                .await
                .is_err()
        );
        let (first, second) = tokio::join!(
            manage_for(&pool, &a, "select", Some("authority-research")),
            manage_for(&pool, &b, "select", Some("authority-research"))
        );
        assert_ne!(first.is_ok(), second.is_ok());
        let (winner, loser) = if first.is_ok() { (&a, &b) } else { (&b, &a) };
        let busy = local_value(manage_for(&pool, loser, "list", None).await);
        let entry = busy["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["profile"] == "authority-research")
            .unwrap();
        assert_eq!(entry["lease"], "busy");
        assert!(entry["last_observed_tabs"].is_null());
        assert!(
            manage_for(&pool, loser, "release", Some("authority-research"))
                .await
                .is_err()
        );
        let original = pool.scoped_spec_for(winner, "authority-research").unwrap();
        assert!(!original.env.contains_key(SHARED_PROFILES_ENV));
        // Simulate an in-flight acquisition without starting Chromium.
        let held = {
            let state = pool.state.lock().await;
            state
                .sessions
                .get("shared:authority-research")
                .unwrap()
                .clone()
        };
        assert!(manage_for(&pool, winner, "release", None).await.is_err());
        assert!(
            manage_for(&pool, winner, "select", Some("default"))
                .await
                .is_err()
        );
        drop(held);
        local_value(manage_for(&pool, winner, "release", None).await);
        local_value(manage_for(&pool, loser, "reconnect", Some("authority-research")).await);
        assert_eq!(
            pool.scoped_spec_for(loser, "authority-research")
                .unwrap()
                .args,
            original.args
        );
        assert!(
            pool.acquire(Some(winner))
                .await
                .err()
                .unwrap()
                .contains("no browser profile selected")
        );
    }

    #[tokio::test]
    async fn profile_management_rejects_invalid_names_missing_identity_and_changed_launch_selection()
     {
        let temp = tempfile::tempdir().unwrap();
        let pool = named_pool(temp.path(), None);
        let a = ConversationIdentity::from_openai_session("launch-A").unwrap();
        let args = json!({"action": "list"});
        assert!(pool.manage(None, args.as_object()).await.is_err());
        for name in [
            "../escape",
            "a/b",
            "C:\\secret",
            "Upper",
            ".",
            "default",
            "",
        ] {
            assert!(manage_for(&pool, &a, "create", Some(name)).await.is_err());
        }
        assert!(
            matches!(manage_for(&pool, &a, "launch", Some("fresh")).await, Ok(ProfileAction::Launch(name)) if name == "fresh")
        );
        local_value(manage_for(&pool, &a, "select", Some("default")).await);
        assert!(
            pool.acquire_for(Some(&a), Some("fresh"))
                .await
                .err()
                .unwrap()
                .contains("changed before launch")
        );
        assert!(
            pool.state
                .lock()
                .await
                .sessions
                .values()
                .all(|s| s.connection.get().is_none())
        );
        let extension =
            ScopedPlaywrightPool::new("playwright-extension", &spec(true), &stub_config()).unwrap();
        assert!(!extension.supports_profiles());
        assert!(extension.manage(Some(&a), args.as_object()).await.is_err());
    }

    #[test]
    fn tab_inventory_redacts_titles_paths_queries_and_credentials() {
        let result = CallToolResult::success(vec![ContentBlock::text(
            "### Open tabs\n- 0: (current) [PRIVATE-TITLE](https://user:pass@example.com/private?token=secret#fragment)\n- 1: [Other](about:blank)\n### Page\n",
        )]);
        let observation = observed_tabs(&result, "browser_navigate").unwrap();
        assert_eq!(observation.tabs.len(), 2);
        assert_eq!(observation.tabs[0]["origin"], "https://example.com");
        assert_eq!(observation.tabs[0]["current"], true);
        let serialized = json!(observation.tabs).to_string();
        for secret in [
            "PRIVATE-TITLE",
            "user:pass",
            "/private",
            "token",
            "fragment",
        ] {
            assert!(!serialized.contains(secret));
        }
        assert!(observation.tabs[1]["origin"].is_null());
        let malformed = CallToolResult::success(vec![ContentBlock::text(
            "### Open tabs\n- 0: [a](https://example.com)\n[truncated]",
        )]);
        assert!(observed_tabs(&malformed, "browser_tabs").is_none());
        let empty = CallToolResult::success(vec![ContentBlock::text(
            "### Open tabs\nNo open tabs. Use browser_navigate.",
        )]);
        assert!(
            observed_tabs(&empty, "browser_tabs")
                .unwrap()
                .tabs
                .is_empty()
        );
    }

    #[tokio::test]
    async fn inventory_never_reaps_a_lease_and_expired_shared_selection_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let pool = named_pool(temp.path(), Some("shared-lane"));
        let a = ConversationIdentity::from_openai_session("expiry-A").unwrap();
        let b = ConversationIdentity::from_openai_session("expiry-B").unwrap();
        local_value(manage_for(&pool, &a, "select", Some("shared-lane")).await);
        let before = local_value(manage_for(&pool, &b, "list", None).await);
        assert_eq!(before["other_worker_leases"], 1);
        assert_eq!(pool.state.lock().await.sessions.len(), 1);
        {
            let mut state = pool.state.lock().await;
            ScopedPlaywrightPool::prune_idle_at(
                &mut state,
                Instant::now() + IDLE_SESSION_TTL + Duration::from_secs(1),
            );
            assert!(state.sessions.is_empty());
        }
        local_value(manage_for(&pool, &b, "select", Some("shared-lane")).await);
        assert!(
            pool.acquire(Some(&a))
                .await
                .err()
                .unwrap()
                .contains("no browser profile selected")
        );
    }

    #[test]
    fn scoped_sources_reject_profile_redirecting_environment_and_invalid_shared_names() {
        for key in OWNED_BROWSER_ENV {
            let mut initial = spec(false);
            initial.env.insert((*key).into(), "fixture".into());
            assert!(ScopedPlaywrightPool::new("playwright", &initial, &stub_config()).is_err());
        }
        for names in ["default", "../escape", "same,same", "Upper", ""] {
            let mut initial = spec(false);
            initial.env.insert(SHARED_PROFILES_ENV.into(), names.into());
            assert!(ScopedPlaywrightPool::new("playwright", &initial, &stub_config()).is_err());
        }
        let mut extension = spec(true);
        extension
            .env
            .insert(SHARED_PROFILES_ENV.into(), "authority".into());
        assert!(
            ScopedPlaywrightPool::new("playwright-extension", &extension, &stub_config()).is_err()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_a_redirected_profile_directory() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let pool = named_pool(root.path(), None);
        let a = ConversationIdentity::from_openai_session("redirect-A").unwrap();
        let base = pool
            .checked_dir(&pool.private_base(a.stable_key()), true)
            .unwrap()
            .unwrap();
        std::os::unix::fs::symlink(outside.path(), base.join("p-redirect")).unwrap();
        assert!(
            manage_for(&pool, &a, "create", Some("redirect"))
                .await
                .is_err()
        );
        assert!(
            manage_for(&pool, &a, "select", Some("redirect"))
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn managed_playwright_cold_start_is_bounded_but_respects_owner_override() {
        let initial = spec(false);
        let pool = ScopedPlaywrightPool::new("playwright", &initial, &stub_config()).unwrap();
        let discovery = pool.discovery_spec().unwrap();
        assert_eq!(discovery.startup_timeout_sec, Some(60.0));
        let owner = ConversationIdentity::from_openai_session("agent-a").unwrap();
        assert_eq!(
            pool.scoped_spec(&owner).unwrap().startup_timeout_sec,
            Some(60.0)
        );
        let mut overridden = spec(false);
        overridden.startup_timeout_sec = Some(95.0);
        let pool = ScopedPlaywrightPool::new("playwright", &overridden, &stub_config()).unwrap();
        assert_eq!(
            pool.discovery_spec().unwrap().startup_timeout_sec,
            Some(95.0)
        );
    }

    #[test]
    fn distinct_conversations_receive_distinct_persistent_profiles() {
        let pool = ScopedPlaywrightPool::new("playwright", &spec(false), &stub_config()).unwrap();
        let a = ConversationIdentity::from_openai_session("account-A-chat-A").unwrap();
        let b = ConversationIdentity::from_openai_session("account-A-chat-B").unwrap();
        let aa = pool.scoped_spec(&a).unwrap();
        let bb = pool.scoped_spec(&b).unwrap();
        assert_ne!(aa.args, bb.args);
        assert_eq!(aa.args, pool.scoped_spec(&a).unwrap().args);
        assert!(
            aa.args
                .iter()
                .any(|arg| arg.starts_with("--user-data-dir="))
        );
    }

    #[test]
    fn extension_is_grouped_per_client_without_overwriting_the_token() {
        let config = stub_config();
        let pool = ScopedPlaywrightPool::new("playwright-extension", &spec(true), &config).unwrap();
        let a = ConversationIdentity::from_openai_session("chat-A").unwrap();
        let b = ConversationIdentity::from_openai_session("chat-B").unwrap();
        let aa = pool.scoped_spec(&a).unwrap();
        let bb = pool.scoped_spec(&b).unwrap();
        assert_ne!(
            aa.env.get("PLAYWRIGHT_MCP_SESSION_NAME"),
            bb.env.get("PLAYWRIGHT_MCP_SESSION_NAME")
        );
        assert_eq!(
            aa.env.get("PLAYWRIGHT_MCP_EXTENSION_TOKEN"),
            bb.env.get("PLAYWRIGHT_MCP_EXTENSION_TOKEN")
        );
        assert_eq!(aa.env.get("PLAYWRIGHT_MCP_BACKGROUND"), Some(&"1".into()));
        assert!(!aa.args.iter().any(|a| a.starts_with("--user-data-dir=")));
    }

    #[tokio::test]
    async fn missing_owner_is_rejected_before_launching_any_browser() {
        let pool = ScopedPlaywrightPool::new("playwright", &spec(false), &stub_config()).unwrap();
        let error = pool
            .acquire(None)
            .await
            .err()
            .expect("missing owner rejected");
        assert!(error.contains("refusing the shared global browser"));
        assert_eq!(pool.state.lock().await.sessions.len(), 0);
    }

    #[tokio::test]
    async fn bounded_capacity_rejects_new_owner_without_reusing_another_session() {
        let pool = ScopedPlaywrightPool::new("playwright", &spec(false), &stub_config()).unwrap();
        {
            let mut state = pool.state.lock().await;
            for index in 0..MAX_LIVE_SESSIONS {
                let key = format!("{index:064x}");
                state
                    .sessions
                    .insert(key.clone(), Arc::new(SessionSlot::new(key)));
            }
        }
        let new_owner = ConversationIdentity::from_openai_session("seventeenth-owner").unwrap();
        let error = pool
            .acquire(Some(&new_owner))
            .await
            .err()
            .expect("limit enforced");
        assert!(error.contains("capacity reached"));
        assert_eq!(pool.state.lock().await.sessions.len(), MAX_LIVE_SESSIONS);
    }

    #[test]
    fn extension_without_token_fails_closed_before_any_mcp_connection() {
        let mut s = spec(true);
        s.env.remove("PLAYWRIGHT_MCP_EXTENSION_TOKEN");
        s.env.remove("PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE");
        assert!(ScopedPlaywrightPool::new("playwright-extension", &s, &stub_config()).is_err());
    }

    #[test]
    fn token_file_is_loaded_only_for_a_scoped_child_and_errors_are_secret_free() {
        let mut s = spec(true);
        s.env
            .insert("PLAYWRIGHT_MCP_PROFILE_DIR_NAME".into(), "Codexify".into());
        s.env.remove("PLAYWRIGHT_MCP_EXTENSION_TOKEN");
        let file = std::env::temp_dir().join(format!(
            "codexify-playwright-token-test-{}-{}.txt",
            std::process::id(),
            "f48a"
        ));
        assert!(!file.exists());
        std::fs::write(&file, "testtoken_with_123456789").unwrap();
        s.env.insert(
            "PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE".into(),
            file.display().to_string(),
        );
        let pool = ScopedPlaywrightPool::new("playwright-extension", &s, &stub_config()).unwrap();
        let owner = ConversationIdentity::from_openai_session("chat-A").unwrap();
        let child = pool.scoped_spec(&owner).unwrap();
        assert_eq!(
            child
                .env
                .get("PLAYWRIGHT_MCP_EXTENSION_TOKEN")
                .map(String::as_str),
            Some("testtoken_with_123456789")
        );
        assert!(
            !child
                .env
                .contains_key("PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE")
        );
        assert!(
            pool.spec
                .env
                .contains_key("PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE")
        );
        std::fs::remove_file(&file).unwrap();
        let error = pool.scoped_spec(&owner).unwrap_err();
        assert!(!error.contains("testtoken_with"));
        assert!(!error.contains(&file.display().to_string()));
    }

    #[test]
    fn per_chat_extension_must_select_a_dedicated_profile() {
        let mut s = spec(true);
        s.env.remove("PLAYWRIGHT_MCP_PROFILE_DIR_NAME");
        assert!(ScopedPlaywrightPool::new("playwright-extension", &s, &stub_config()).is_err());
        s.env
            .insert("PLAYWRIGHT_MCP_PROFILE_DIR_NAME".into(), "Default".into());
        assert!(ScopedPlaywrightPool::new("playwright-extension", &s, &stub_config()).is_err());
        s.env
            .insert("PLAYWRIGHT_MCP_PROFILE_DIR_NAME".into(), "Profile 3".into());
        assert!(ScopedPlaywrightPool::new("playwright-extension", &s, &stub_config()).is_ok());
    }

    #[test]
    fn refuses_context_sharing_and_arbitrary_non_browser_sources() {
        for flag in [
            "--shared-browser-context",
            "--cdp-endpoint=ws://localhost:22",
        ] {
            let mut s = spec(false);
            s.args.push(flag.into());
            assert!(ScopedPlaywrightPool::new("playwright", &s, &stub_config()).is_err());
        }
        assert!(
            ScopedPlaywrightPool::new(
                "non-browser",
                &McpServerSpec {
                    args: vec!["echo".into()],
                    ..spec(false)
                },
                &stub_config()
            )
            .is_err()
        );
    }
}
