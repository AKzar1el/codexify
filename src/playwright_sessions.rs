//! Per-ChatGPT-task Playwright MCP stdio connections.
//! A single upstream Playwright peer has mutable current-tab state. Never share
//! that peer across physical conversations or durable task continuations.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rmcp::RoleClient;
use rmcp::service::{Peer, RunningService};
use tokio::sync::{Mutex as AsyncMutex, OnceCell, Semaphore};

use crate::bridge::connect_one;
use crate::project_bindings::ConversationIdentity;
use crate::types::{AppConfig, McpServerSpec, McpSessionScope};
use crate::upstream_control::UpstreamControl;

const MAX_LIVE_SESSIONS: usize = 16;
const MAX_PARALLEL_BROWSER_STARTS: usize = 3;
const IDLE_SESSION_TTL: Duration = Duration::from_secs(60 * 60);

pub(crate) struct ScopedConnection {
    // Hold the upstream process and transport alive for this conversation.
    _service: RunningService<RoleClient, ()>,
    pub(crate) peer: Peer<RoleClient>,
    pub(crate) control: Arc<UpstreamControl>,
}

struct SessionSlot {
    connection: OnceCell<Arc<ScopedConnection>>,
    last_used: Mutex<Instant>,
}

impl SessionSlot {
    fn new() -> Self {
        Self {
            connection: OnceCell::new(),
            last_used: Mutex::new(Instant::now()),
        }
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }

    fn expired(&self) -> bool {
        self.last_used
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .elapsed()
            >= IDLE_SESSION_TTL
    }
}

pub(crate) struct ScopedPlaywrightPool {
    server: String,
    instance_port: u16,
    config: AppConfig,
    spec: McpServerSpec,
    extension: bool,
    profiles_root: PathBuf,
    sessions: AsyncMutex<HashMap<String, Arc<SessionSlot>>>,
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
            sessions: AsyncMutex::new(HashMap::new()),
            startup_capacity: Semaphore::new(MAX_PARALLEL_BROWSER_STARTS),
        })
    }

    fn scoped_spec(&self, owner: &ConversationIdentity) -> Result<McpServerSpec, String> {
        let key = owner.stable_key();
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid per-chat browser owner identity".into());
        }
        let mut spec = self.spec.clone();
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

    pub(crate) async fn acquire(
        &self,
        owner: Option<&ConversationIdentity>,
    ) -> Result<Arc<ScopedConnection>, String> {
        let owner = owner.ok_or(
            "per-chat Playwright needs a verified ChatGPT conversation/task identity; \
             refusing the shared global browser",
        )?;
        let key = owner.stable_key().to_owned();
        let slot = {
            let mut sessions = self.sessions.lock().await;
            // Never reclaim an in-use connection. This cap prevents unattended
            // chats from spawning arbitrarily many Chromium processes.
            sessions.retain(|_, entry| {
                !entry.expired()
                    || Arc::strong_count(entry) > 1
                    // A request may hold the connection but not its slot.
                    // Do not evict and respawn while that browser is in use.
                    || entry
                        .connection
                        .get()
                        .is_some_and(|connection| Arc::strong_count(connection) > 1)
            });
            let slot = if let Some(entry) = sessions.get(&key) {
                entry.clone()
            } else {
                if sessions.len() >= MAX_LIVE_SESSIONS {
                    return Err(
                        "per-chat Playwright capacity reached; wait for an idle session to \
                         expire rather than sharing another agent's browser"
                            .into(),
                    );
                }
                let entry = Arc::new(SessionSlot::new());
                sessions.insert(key, entry.clone());
                entry
            };
            slot.touch();
            slot
        };
        let connection = slot
            .connection
            .get_or_try_init(|| async {
                let _start = self
                    .startup_capacity
                    .acquire()
                    .await
                    .map_err(|_| "per-chat browser startup limiter closed")?;
                let scoped = self.scoped_spec(owner)?;
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
        assert_eq!(pool.sessions.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn bounded_capacity_rejects_new_owner_without_reusing_another_session() {
        let pool = ScopedPlaywrightPool::new("playwright", &spec(false), &stub_config()).unwrap();
        {
            let mut sessions = pool.sessions.lock().await;
            for index in 0..MAX_LIVE_SESSIONS {
                sessions.insert(format!("{index:064x}"), Arc::new(SessionSlot::new()));
            }
        }
        let new_owner = ConversationIdentity::from_openai_session("seventeenth-owner").unwrap();
        let error = pool
            .acquire(Some(&new_owner))
            .await
            .err()
            .expect("limit enforced");
        assert!(error.contains("capacity reached"));
        assert_eq!(pool.sessions.lock().await.len(), MAX_LIVE_SESSIONS);
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
