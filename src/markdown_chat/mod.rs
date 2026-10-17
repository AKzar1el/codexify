//! Optional conversation-scoped Markdown communication, separate from repository files.

pub mod attachments;
pub mod notification;
mod offline;
pub(crate) mod output;
mod storage;
mod wait;

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::exec_sessions::SessionState;
use crate::project_bindings::ConversationIdentity;
use crate::types::AppConfig;

pub use storage::rollout;
pub use storage::{
    AGENT_STOP_MESSAGE, AppendReceipt, BrowserAppendReceipt, ChatFile, ChatSnapshot,
    NotificationState, OwnerChatOrganization, OwnerChatSummary, TranscriptCheckpoint,
    UnreadMessage, UnreadSnapshot, UserSendReceipt, WidgetPage,
};
pub use storage::{QueueReceipt, QueueSubmission, QueuedMessage};
pub use wait::WaitOutcome;

pub const DEFAULT_MAX_WAIT_MS: u64 = 55_000;
pub const DEFAULT_OWNER_CHAT_PORT: u16 = 3120;
pub const MAX_UNREAD_BYTES: usize = 16 * 1024 * 1024;
pub const USER_MESSAGE_FIELD: &str = "new_chat_message_from_user";
pub const AWAY_AFTER_MS: u64 = 180_000;
pub const OFFLINE_AFTER_MS: u64 = 300_000;
pub const AUTOMATION_OFFLINE_AFTER_MS: u64 = OFFLINE_AFTER_MS - 60_000;
pub const PAIRING_PRESENCE_GRACE_MS: u64 = 5_000;
pub const DEFAULT_AUTOMATION_DESCRIPTOR_PATH: &str = "~/.codexify/browser/descriptor.json";
pub const DEFAULT_AUTOMATION_CONNECTOR_NAME: &str = "Codexify";
pub const DEFAULT_AUTOMATION_MAX_QUEUED_ACTIONS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentAutomationConfig {
    pub enabled: bool,
    pub descriptor_path: String,
    pub connector_name: String,
    pub max_queued_actions: usize,
    pub auto_approve_tool_calls: bool,
    pub chatgpt_project_url: Option<String>,
    #[serde(deserialize_with = "deserialize_request_block_list")]
    pub request_block_list: Vec<String>,
}

impl Default for AgentAutomationConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            descriptor_path: DEFAULT_AUTOMATION_DESCRIPTOR_PATH.into(),
            connector_name: DEFAULT_AUTOMATION_CONNECTOR_NAME.into(),
            max_queued_actions: DEFAULT_AUTOMATION_MAX_QUEUED_ACTIONS,
            auto_approve_tool_calls: false,
            chatgpt_project_url: None,
            request_block_list: Vec::new(),
        }
    }
}

impl AgentAutomationConfig {
    fn validate(&self) -> Result<(), String> {
        if self.request_block_list.len() > 128 {
            return Err(
                "agentChat.automation.requestBlockList accepts at most 128 patterns".into(),
            );
        }
        for (index, pattern) in self.request_block_list.iter().enumerate() {
            if pattern.is_empty()
                || pattern.len() > 4096
                || !pattern.is_ascii()
                || pattern.chars().any(char::is_control)
            {
                return Err(format!(
                    "agentChat.automation.requestBlockList[{index}] must be 1 to 4096 printable ASCII characters"
                ));
            }
        }
        if let Some(project) = &self.chatgpt_project_url {
            let url = reqwest::Url::parse(project).map_err(
                |_| "agentChat.automation.chatgptProjectUrl must be a ChatGPT project URL",
            )?;
            let parts = url
                .path()
                .trim_end_matches('/')
                .split('/')
                .collect::<Vec<_>>();
            if project.len() > 4096
                || parts.get(2).is_none_or(|id| id.len() <= 4)
                || url.scheme() != "https"
                || url.host_str() != Some("chatgpt.com")
                || url.port().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || parts.len() != 4
                || parts[1] != "g"
                || !parts[2].starts_with("g-p-")
                || parts[3] != "project"
            {
                return Err("agentChat.automation.chatgptProjectUrl must be an HTTPS ChatGPT project URL ending in /project".into());
            }
        }
        if self.descriptor_path.trim().is_empty()
            || self.descriptor_path.len() > 4096
            || self.descriptor_path.contains('\0')
        {
            return Err(
                "agentChat.automation.descriptorPath must be a nonempty path up to 4096 bytes"
                    .into(),
            );
        }
        if self.connector_name.trim().is_empty()
            || self.connector_name.len() > 128
            || self.connector_name.chars().any(char::is_control)
        {
            return Err(
                "agentChat.automation.connectorName must be 1 to 128 visible characters".into(),
            );
        }
        if !(1..=1024).contains(&self.max_queued_actions) {
            return Err("agentChat.automation.maxQueuedActions must be between 1 and 1024".into());
        }
        Ok(())
    }
}

fn deserialize_request_block_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<Vec<String>>::deserialize(deserializer).map(Option::unwrap_or_default)
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageMode {
    #[default]
    Steer,
    Queue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct MarkdownChatConfig {
    pub enabled: bool,
    pub port: Option<u16>,
    pub max_wait_ms: u64,
    pub default_message_mode: MessageMode,
    pub rollout_reminder_interval: u64,
    pub rollout_enabled: bool,
    pub analytics_enabled: bool,
    pub turn_renewal: crate::agent_automation::turn_renewal::TurnRenewalConfig,
    pub notifications: Option<NotificationsConfig>,
    pub automation: AgentAutomationConfig,
}

impl Default for MarkdownChatConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: Some(DEFAULT_OWNER_CHAT_PORT),
            max_wait_ms: DEFAULT_MAX_WAIT_MS,
            default_message_mode: MessageMode::Steer,
            rollout_reminder_interval: rollout::DEFAULT_REMINDER_INTERVAL,
            rollout_enabled: true,
            analytics_enabled: true,
            turn_renewal: Default::default(),
            notifications: None,
            automation: AgentAutomationConfig::default(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotificationsConfig {
    pub urls: Vec<String>,
    #[serde(default = "default_notification_python")]
    pub python_path: String,
    #[serde(default = "default_notification_timeout")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub events: NotificationEvents,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct NotificationEvents {
    pub messages: bool,
    pub completed: bool,
    pub input_required: bool,
    pub goal_blocked: bool,
    pub errors: bool,
    pub offline: bool,
}

impl Default for NotificationEvents {
    fn default() -> Self {
        Self {
            messages: true,
            completed: true,
            input_required: true,
            goal_blocked: true,
            errors: true,
            offline: true,
        }
    }
}

fn default_notification_python() -> String {
    if cfg!(windows) { "python" } else { "python3" }.into()
}

fn default_notification_timeout() -> u64 {
    15_000
}

impl fmt::Debug for NotificationsConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NotificationsConfig")
            .field("destinations", &self.urls.len())
            .field("python_path", &self.python_path)
            .field("timeout_ms", &self.timeout_ms)
            .field("events", &self.events)
            .finish()
    }
}

impl NotificationsConfig {
    fn validate(&self) -> Result<(), String> {
        if self.urls.is_empty() || self.urls.len() > 32 {
            return Err(
                "agentChat.notifications.urls must contain 1 to 32 Apprise service URLs".into(),
            );
        }
        if self.urls.iter().any(|url| {
            url.len() > 16_384
                || !url.contains("://")
                || url.chars().any(char::is_control)
                || reqwest::Url::parse(url).is_err()
        }) {
            return Err("agentChat.notifications.urls contains an invalid service URL".into());
        }
        if self.python_path.trim().is_empty() || self.python_path.contains('\0') {
            return Err("agentChat.notifications.pythonPath must name a Python interpreter with Apprise installed".into());
        }
        if !(1_000..=60_000).contains(&self.timeout_ms) {
            return Err("agentChat.notifications.timeoutMs must be between 1000 and 60000".into());
        }
        Ok(())
    }
}

impl MarkdownChatConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.port == Some(0) {
            return Err("agentChat.port must be between 1 and 65535, or null".into());
        }
        if !(1_000..=300_000).contains(&self.max_wait_ms) {
            return Err("agentChat.maxWaitMs must be between 1000 and 300000".into());
        }
        self.turn_renewal.validate()?;
        if !(1..=10000).contains(&self.rollout_reminder_interval) {
            return Err("agentChat.rolloutReminderInterval must be between 1 and 10000".into());
        }
        if let Some(notifications) = &self.notifications {
            notifications.validate()?;
        }
        if self.automation.enabled && !self.enabled {
            return Err(
                "agentChat.automation.enabled requires agentChat.enabled to be true".into(),
            );
        }
        self.automation.validate()?;
        Ok(())
    }
}

pub struct MarkdownChatStore {
    channels: Mutex<HashMap<PathBuf, Arc<ChatFile>>>,
    activity: Mutex<HashMap<String, AgentActivityState>>,
    offline_monitors: Mutex<HashMap<PathBuf, Arc<tokio::sync::Notify>>>,
    transport_namespace: String,
}

#[derive(Clone)]
pub(crate) struct AgentActivity {
    pub at_ms: u64,
    pub epoch: String,
    pub sequence: u64,
}

#[derive(Default)]
struct AgentActivityState {
    last_call_at_ms: u64,
    sequence: u64,
}

impl Default for MarkdownChatStore {
    fn default() -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Self {
            channels: Mutex::new(HashMap::new()),
            activity: Mutex::new(HashMap::new()),
            offline_monitors: Mutex::new(HashMap::new()),
            transport_namespace: format!("{}-{timestamp}", std::process::id()),
        }
    }
}

impl MarkdownChatStore {
    fn owner(&self, conversation: Option<&ConversationIdentity>, session: &SessionState) -> String {
        match conversation {
            Some(identity) => identity.stable_key().to_string(),
            None => format!(
                "transport-{}-{}",
                self.transport_namespace,
                session.audit_id()
            ),
        }
    }

    pub(crate) fn record_agent_call(
        &self,
        conversation: Option<&ConversationIdentity>,
        session: &SessionState,
        at_ms: u64,
    ) -> Option<AgentActivity> {
        let mut activity = self.activity.lock().ok()?;
        let state = activity
            .entry(self.owner(conversation, session))
            .or_default();
        state.last_call_at_ms = state.last_call_at_ms.max(at_ms);
        state.sequence = state.sequence.saturating_add(1);
        Some(AgentActivity {
            at_ms: state.last_call_at_ms,
            epoch: self.transport_namespace.clone(),
            sequence: state.sequence,
        })
    }

    pub(crate) fn agent_activity(
        &self,
        conversation: Option<&ConversationIdentity>,
        session: &SessionState,
    ) -> Option<AgentActivity> {
        let activity = self.activity.lock().ok()?;
        let state = activity.get(&self.owner(conversation, session))?;
        Some(AgentActivity {
            at_ms: state.last_call_at_ms,
            epoch: self.transport_namespace.clone(),
            sequence: state.sequence,
        })
    }

    pub fn chat(
        &self,
        config: &AppConfig,
        conversation: Option<&ConversationIdentity>,
        session: &SessionState,
    ) -> Result<Arc<ChatFile>, String> {
        if !config.markdown_chat.enabled {
            return Err("Markdown chat is disabled in the server configuration.".into());
        }
        let owner = self.owner(conversation, session);
        let path = crate::memory::task_state_dir(config)
            .join("chats")
            .join(owner)
            .join("CHAT.md");
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map_err(|_| "Cannot resolve the Markdown chat directory")?
                .join(path)
        };
        self.chat_at_path(path, conversation.is_some())
    }

    pub(crate) fn chat_at_path(
        &self,
        path: PathBuf,
        persistent: bool,
    ) -> Result<Arc<ChatFile>, String> {
        let mut channels = self
            .channels
            .lock()
            .map_err(|_| "Markdown chat store is unavailable")?;
        let chat = channels
            .entry(path.clone())
            .or_insert_with(|| Arc::new(ChatFile::new(path, persistent)))
            .clone();
        drop(channels);
        chat.start_queue_monitor();
        Ok(chat)
    }

    pub(crate) fn monitor_offline(
        &self,
        chat: Arc<ChatFile>,
        config: &MarkdownChatConfig,
        workspace: String,
    ) {
        if !notification::enabled(config, notification::NotificationEvent::Offline) {
            return;
        }
        let Ok(mut monitors) = self.offline_monitors.lock() else {
            tracing::warn!("could not start agent chat offline notification monitor");
            return;
        };
        let wake = monitors
            .entry(chat.path().to_path_buf())
            .or_insert_with(|| {
                let wake = Arc::new(tokio::sync::Notify::new());
                let config = config.clone();
                let monitor_wake = wake.clone();
                tokio::spawn(async move {
                    offline::monitor(chat, monitor_wake, OFFLINE_AFTER_MS, move || {
                        let config = config.clone();
                        let workspace = workspace.clone();
                        async move {
                            notification::publish_event(
                                &config,
                                notification::NotificationEvent::Offline,
                                &workspace,
                                offline::MESSAGE.to_string(),
                                &tokio_util::sync::CancellationToken::new(),
                            )
                            .await
                        }
                    })
                    .await;
                });
                wake
            });
        wake.notify_one();
    }

    #[cfg(test)]
    pub(crate) fn offline_monitor_count(&self) -> usize {
        self.offline_monitors.lock().unwrap().len()
    }
}

pub(crate) async fn history_call(
    args: &serde_json::Value,
    config: &AppConfig,
    session: &SessionState,
    context: &crate::tool::ToolRequestContext,
) -> Result<Option<(serde_json::Value, AppConfig)>, String> {
    if !config.markdown_chat.enabled {
        return Ok(None);
    }
    let Some(input) = args.get("path").and_then(serde_json::Value::as_str) else {
        return Ok(None);
    };
    let chat = context
        .markdown_chat
        .chat(config, context.task_conversation.as_ref(), session)?;
    let requested = crate::safe_path::lexical_normalize(&config.work_dir.join(input));
    let file = crate::safe_path::lexical_normalize(chat.path());
    let channel_dir = file.parent().ok_or("CHAT.md has no parent")?;
    let chats_dir = channel_dir
        .parent()
        .ok_or("CHAT.md has no metadata directory")?;
    if !requested.starts_with(chats_dir) {
        return Ok(None);
    }
    if requested != file {
        return Err("Only this Codexify task's CHAT.md is available through chat history reads. Use chat_read for new messages.".into());
    }
    chat.ensure().await?;
    let mut args = args.clone();
    args["path"] = serde_json::Value::String("CHAT.md".into());
    let mut config = config.clone();
    config.work_dir = channel_dir.to_path_buf();
    Ok(Some((args, config)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_block_list_defaults_and_configuration_bounds() {
        for value in [
            serde_json::json!({}),
            serde_json::json!({"requestBlockList":null}),
        ] {
            let config: AgentAutomationConfig = serde_json::from_value(value).unwrap();
            assert!(config.request_block_list.is_empty());
        }
        let mut config: AgentAutomationConfig = serde_json::from_value(
            serde_json::json!({"requestBlockList":["^https?://example\\.com/"]}),
        )
        .unwrap();
        assert!(config.validate().is_ok());
        for pattern in ["".to_string(), "é".to_string(), "x".repeat(4097)] {
            config.request_block_list = vec![pattern];
            assert!(config.validate().is_err());
        }
        config.request_block_list = vec!["x".into(); 129];
        assert!(config.validate().is_err());
        assert!(
            serde_json::from_value::<AgentAutomationConfig>(
                serde_json::json!({"requestBlockList":[1]})
            )
            .is_err()
        );
    }

    #[test]
    fn new_chat_project_configuration_is_optional_and_validated() {
        assert!(AgentAutomationConfig::default().validate().is_ok());
        for (url, valid) in [
            (
                "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project",
                true,
            ),
            (
                "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-example/project/",
                true,
            ),
            ("https://example.com/g/g-p-id/project", false),
            ("http://chatgpt.com/g/g-p-id/project", false),
            ("https://chatgpt.com/c/id", false),
            ("https://chatgpt.com/g/g-p-id/project?token=private", false),
            ("https://user:secret@chatgpt.com/g/g-p-id/project", false),
        ] {
            let config = AgentAutomationConfig {
                chatgpt_project_url: Some(url.into()),
                ..AgentAutomationConfig::default()
            };
            assert_eq!(config.validate().is_ok(), valid);
        }
    }

    #[test]
    fn activity_is_conversation_scoped_with_transport_fallback() {
        let store = MarkdownChatStore::default();
        let first = SessionState::new();
        let second = SessionState::new();
        let a = ConversationIdentity::from_openai_session("a").unwrap();
        let b = ConversationIdentity::from_openai_session("b").unwrap();
        let first_call = store.record_agent_call(Some(&a), &first, 1000).unwrap();
        let second_call = store.record_agent_call(Some(&a), &second, 800).unwrap();
        assert_eq!(first_call.sequence, 1);
        assert_eq!(second_call.sequence, 2);
        let shared = store.agent_activity(Some(&a), &second).unwrap();
        assert_eq!(shared.at_ms, 1000);
        assert_eq!(shared.sequence, 2);
        assert!(store.agent_activity(Some(&b), &first).is_none());
        assert!(store.agent_activity(None, &first).is_none());
        let transport = store.record_agent_call(None, &first, 1500).unwrap();
        assert_eq!(transport.at_ms, 1500);
        assert_eq!(transport.sequence, 1);
        assert!(store.agent_activity(None, &second).is_none());
    }

    #[tokio::test]
    async fn no_offline_monitor_is_started_without_notifications() {
        let root = tempfile::tempdir().unwrap();
        let mut config = crate::config::default_config(root.path().to_path_buf());
        config.markdown_chat.enabled = true;
        let store = MarkdownChatStore::default();
        let session = SessionState::new();
        let chat = store.chat(&config, None, &session).unwrap();

        store.monitor_offline(chat, &config.markdown_chat, "test".into());

        assert_eq!(store.offline_monitor_count(), 0);
    }
}
