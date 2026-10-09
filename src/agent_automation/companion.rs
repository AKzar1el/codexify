use std::fmt;
use std::fs::OpenOptions;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Method, StatusCode, Url, header};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::markdown_chat::AgentAutomationConfig;

pub const PROTOCOL_VERSION: u32 = 1;
pub const COMPANION_KIND: &str = "codexify-browser-companion";

const MAX_DESCRIPTOR_BYTES: u64 = 8192;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_EVENT_STREAM_BYTES: usize = 16 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES: usize = 128 * 1024;
const MAX_DELTA_BYTES: usize = 64 * 1024;
const MAX_FINAL_ANSWER_BYTES: usize = 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 256 * 1024;
const MAX_UNREAD_MESSAGES: usize = 128;
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const EVENT_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct BrowserCompanionClient {
    endpoint: Url,
    token: Arc<Zeroizing<String>>,
    build: Arc<str>,
    pid: u32,
    http: reqwest::Client,
    request_timeout: Duration,
    event_idle_timeout: Duration,
}

impl fmt::Debug for BrowserCompanionClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BrowserCompanionClient")
            .field("build", &self.build)
            .field("pid", &self.pid)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CompanionDescriptor {
    version: u32,
    kind: String,
    pid: u32,
    endpoint: String,
    token: String,
    build: String,
    created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompanionSessionStatus {
    Idle,
    Busy,
    AuthenticationRequired,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompanionHealth {
    pub protocol_version: u32,
    pub kind: String,
    pub build: String,
    pub status: CompanionSessionStatus,
    pub authenticated: bool,
    pub account_fingerprint: Option<String>,
    pub active_action_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CapabilityCatalog {
    pub protocol_version: u32,
    pub build: String,
    pub account_fingerprint: String,
    pub catalog_revision: String,
    pub models: Vec<ModelCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModelCapability {
    pub id: String,
    pub label: String,
    pub efforts: Vec<EffortCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EffortCapability {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RevealWindowRequest {
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RevealWindowReceipt {
    pub protocol_version: u32,
    pub build: String,
    pub revealed: bool,
    pub active_action_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExecuteActionRequest {
    pub action_id: String,
    pub idempotency_key: String,
    pub url: String,
    pub pairing_generation: u64,
    pub connector_name: String,
    pub model: String,
    pub effort: String,
    pub prompt: ActionPrompt,
    pub expected_url: String,
    pub auto_approve_tool_calls: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ActionPrompt {
    PairVerify {
        reference: String,
    },
    OfflineChat {
        batch_id: String,
        messages: Vec<CompanionUnreadMessage>,
    },
    OfflineGoal {
        goal_revision: u64,
    },
    OfflineCombined {
        batch_id: String,
        messages: Vec<CompanionUnreadMessage>,
        goal_revision: u64,
    },
}

#[derive(Clone, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompanionUnreadMessage {
    pub id: String,
    pub markdown: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompanionActionState {
    Unpaired,
    Unverified,
    Queued,
    Navigating,
    Sending,
    Generating,
    Idle,
    ApprovalRequired,
    AuthenticationRequired,
    RateLimited,
    ExternalInterference,
    Ambiguous,
    Stalled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompanionSelection {
    pub model: String,
    pub effort: String,
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompanionAttention {
    pub code: String,
    pub message: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompanionActionSnapshot {
    pub protocol_version: u32,
    pub build: String,
    pub action_id: String,
    pub state: CompanionActionState,
    pub send_accepted: bool,
    pub canonical_url: Option<String>,
    pub selected: Option<CompanionSelection>,
    pub last_event_sequence: u64,
    pub attention: Option<CompanionAttention>,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CancelActionRequest<'a> {
    action_id: &'a str,
    idempotency_key: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CancelActionReceipt {
    pub protocol_version: u32,
    pub build: String,
    pub action_id: String,
    pub state: CompanionActionState,
    pub cancelled: bool,
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionEvent {
    pub sequence: u64,
    pub action_id: String,
    pub at_ms: u64,
    #[serde(flatten)]
    pub kind: CompanionEventKind,
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CompanionEventKind {
    Queued,
    Navigating,
    ComposerReady,
    ModelVerified {
        model: String,
        effort: String,
    },
    ConnectorVerified,
    SendAccepted,
    StatusDelta {
        text: String,
        continuation: bool,
    },
    CommentaryDelta {
        markdown: String,
        continuation: bool,
    },
    AnswerDelta {
        markdown: String,
        continuation: bool,
    },
    GenerationComplete {
        final_markdown: Option<String>,
        canonical_url: Option<String>,
    },
    ApprovalRequired {
        message: Option<String>,
    },
    AuthenticationRequired,
    RateLimited {
        message: Option<String>,
    },
    ExternalInterference {
        message: Option<String>,
    },
    AmbiguousSend {
        message: Option<String>,
    },
    Failed {
        code: String,
        message: String,
    },
}

enum ExecuteAttempt {
    Complete(CompanionActionSnapshot),
    Failed {
        message: String,
        retryable_if_absent: bool,
    },
}

impl CompanionEventKind {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::GenerationComplete { .. }
                | Self::ApprovalRequired { .. }
                | Self::AuthenticationRequired
                | Self::RateLimited { .. }
                | Self::ExternalInterference { .. }
                | Self::AmbiguousSend { .. }
                | Self::Failed { .. }
        )
    }
}

impl BrowserCompanionClient {
    pub fn from_config(config: &AgentAutomationConfig) -> Result<Self, String> {
        let path = expand_descriptor_path(&config.descriptor_path)?;
        Self::from_descriptor_path(&path)
    }

    pub fn from_descriptor_path(path: &Path) -> Result<Self, String> {
        Self::from_descriptor_path_with_timeout(path, DEFAULT_REQUEST_TIMEOUT)
    }

    #[doc(hidden)]
    pub fn from_descriptor_path_with_timeout(
        path: &Path,
        request_timeout: Duration,
    ) -> Result<Self, String> {
        Self::from_descriptor_path_with_timeouts(path, request_timeout, EVENT_IDLE_TIMEOUT)
    }

    #[doc(hidden)]
    pub fn from_descriptor_path_with_timeouts(
        path: &Path,
        request_timeout: Duration,
        event_idle_timeout: Duration,
    ) -> Result<Self, String> {
        if request_timeout.is_zero()
            || request_timeout > Duration::from_secs(600)
            || event_idle_timeout.is_zero()
            || event_idle_timeout > Duration::from_secs(600)
        {
            return Err("Browser companion request timeout is invalid".into());
        }
        let descriptor = read_descriptor(path)?;
        validate_descriptor(&descriptor)?;
        let endpoint = Url::parse(&descriptor.endpoint)
            .map_err(|_| "Browser companion descriptor endpoint is invalid".to_string())?;
        crate::tls::ensure_crypto_provider();
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(request_timeout.min(Duration::from_secs(10)))
            .build()
            .map_err(|_| "Could not initialize the browser companion client".to_string())?;
        Ok(Self {
            endpoint,
            token: Arc::new(Zeroizing::new(descriptor.token)),
            build: Arc::from(descriptor.build),
            pid: descriptor.pid,
            http,
            request_timeout,
            event_idle_timeout,
        })
    }

    pub fn build(&self) -> &str {
        &self.build
    }

    pub async fn health(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<CompanionHealth, String> {
        let health: CompanionHealth = self
            .request_json(
                Method::GET,
                "/v1/health",
                Option::<&Value>::None,
                cancellation,
            )
            .await?;
        self.validate_health(&health)?;
        Ok(health)
    }

    pub async fn login(&self, cancellation: &CancellationToken) -> Result<CompanionHealth, String> {
        let health: CompanionHealth = self
            .request_json(
                Method::POST,
                "/v1/session/login",
                Some(&serde_json::json!({})),
                cancellation,
            )
            .await?;
        self.validate_health(&health)?;
        Ok(health)
    }

    pub async fn capabilities(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<CapabilityCatalog, String> {
        let catalog: CapabilityCatalog = self
            .request_json(
                Method::POST,
                "/v1/session/capabilities",
                Some(&serde_json::json!({})),
                cancellation,
            )
            .await?;
        self.validate_envelope(catalog.protocol_version, &catalog.build)?;
        validate_catalog(&catalog)?;
        Ok(catalog)
    }

    pub async fn reveal(
        &self,
        request: &RevealWindowRequest,
        cancellation: &CancellationToken,
    ) -> Result<RevealWindowReceipt, String> {
        if let Some(url) = &request.url {
            validate_chatgpt_url(url)?;
        }
        let receipt: RevealWindowReceipt = self
            .request_json(
                Method::POST,
                "/v1/window/reveal",
                Some(request),
                cancellation,
            )
            .await?;
        self.validate_envelope(receipt.protocol_version, &receipt.build)?;
        if let Some(action_id) = &receipt.active_action_id {
            validate_opaque(action_id, "browser action ID")?;
        }
        Ok(receipt)
    }

    pub async fn execute(
        &self,
        request: &ExecuteActionRequest,
        cancellation: &CancellationToken,
    ) -> Result<CompanionActionSnapshot, String> {
        validate_execute_request(request)?;
        let first = self.execute_attempt(request, cancellation).await;
        match first {
            ExecuteAttempt::Complete(snapshot) => Ok(snapshot),
            ExecuteAttempt::Failed {
                message,
                retryable_if_absent,
            } => {
                if cancellation.is_cancelled() {
                    return Err(message);
                }
                match self.action_optional(&request.action_id, cancellation).await {
                    Ok(Some(snapshot)) => Ok(snapshot),
                    Ok(None) if retryable_if_absent => {
                        match self.execute_attempt(request, cancellation).await {
                            ExecuteAttempt::Complete(snapshot) => Ok(snapshot),
                            ExecuteAttempt::Failed { message, .. } => {
                                match self.action_optional(&request.action_id, cancellation).await {
                                    Ok(Some(snapshot)) => Ok(snapshot),
                                    Ok(None) | Err(_) => Err(message),
                                }
                            }
                        }
                    }
                    Ok(None) | Err(_) => Err(message),
                }
            }
        }
    }

    pub async fn cancel(
        &self,
        action_id: &str,
        idempotency_key: &str,
        cancellation: &CancellationToken,
    ) -> Result<CancelActionReceipt, String> {
        validate_opaque(action_id, "browser action ID")?;
        validate_opaque(idempotency_key, "browser action idempotency key")?;
        let request = CancelActionRequest {
            action_id,
            idempotency_key,
        };
        let receipt: CancelActionReceipt = self
            .request_json(
                Method::POST,
                "/v1/actions/cancel",
                Some(&request),
                cancellation,
            )
            .await?;
        self.validate_envelope(receipt.protocol_version, &receipt.build)?;
        if receipt.action_id != action_id {
            return Err("Browser companion returned the wrong action ID".into());
        }
        Ok(receipt)
    }

    pub async fn action(
        &self,
        action_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<CompanionActionSnapshot, String> {
        validate_opaque(action_id, "browser action ID")?;
        let path = format!("/v1/actions/{action_id}");
        let snapshot: CompanionActionSnapshot = self
            .request_json(Method::GET, &path, Option::<&Value>::None, cancellation)
            .await?;
        self.validate_action_snapshot(&snapshot, Some(action_id))?;
        Ok(snapshot)
    }

    pub async fn stream_action_events<F>(
        &self,
        action_id: &str,
        after_sequence: u64,
        cancellation: &CancellationToken,
        mut receive: F,
    ) -> Result<(), String>
    where
        F: FnMut(CompanionEvent) -> Result<(), String>,
    {
        validate_opaque(action_id, "browser action ID")?;
        let path = format!("/v1/actions/{action_id}/events?after={after_sequence}");
        let mut response = self
            .send_json_with_timeout::<Value>(Method::GET, &path, None, cancellation, None)
            .await?;
        if !response.status().is_success() {
            return Err(status_error(response.status()));
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !content_type
            .split(';')
            .next()
            .is_some_and(|value| value.trim() == "application/x-ndjson")
        {
            return Err("Browser companion event stream has an invalid content type".into());
        }

        let mut total = 0usize;
        let mut buffer = Vec::new();
        let mut last_sequence = after_sequence;
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(cancelled_error()),
                chunk = tokio::time::timeout(self.event_idle_timeout, response.chunk()) => chunk
                    .map_err(|_| "Browser companion event stream stalled".to_string())?
                    .map_err(|_| "Browser companion event stream failed".to_string())?,
            };
            let Some(chunk) = chunk else {
                break;
            };
            total = total
                .checked_add(chunk.len())
                .ok_or("Browser companion event stream is too large")?;
            if total > MAX_EVENT_STREAM_BYTES {
                return Err("Browser companion event stream is too large".into());
            }
            buffer.extend_from_slice(&chunk);
            while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
                let line = buffer.drain(..=newline).collect::<Vec<_>>();
                let line = &line[..line.len() - 1];
                if line.is_empty() {
                    continue;
                }
                if line.len() > MAX_EVENT_LINE_BYTES {
                    return Err("Browser companion event is too large".into());
                }
                let event: CompanionEvent = serde_json::from_slice(line)
                    .map_err(|_| "Browser companion event is invalid".to_string())?;
                validate_event(&event, action_id, last_sequence)?;
                last_sequence = event.sequence;
                let terminal = event.kind.is_terminal();
                receive(event)?;
                if terminal {
                    return Ok(());
                }
            }
            if buffer.len() > MAX_EVENT_LINE_BYTES {
                return Err("Browser companion event is too large".into());
            }
        }
        if !buffer.is_empty() {
            return Err("Browser companion event stream ended with an incomplete event".into());
        }
        Err("Browser companion event stream ended before a terminal event".into())
    }

    async fn execute_attempt(
        &self,
        request: &ExecuteActionRequest,
        cancellation: &CancellationToken,
    ) -> ExecuteAttempt {
        let response = self
            .send_json(
                Method::POST,
                "/v1/actions/execute",
                Some(request),
                cancellation,
            )
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                match self
                    .decode_json_response::<CompanionActionSnapshot>(response, cancellation)
                    .await
                {
                    Ok(snapshot) => {
                        match self.validate_action_snapshot(&snapshot, Some(&request.action_id)) {
                            Ok(()) => ExecuteAttempt::Complete(snapshot),
                            Err(message) => ExecuteAttempt::Failed {
                                message,
                                retryable_if_absent: false,
                            },
                        }
                    }
                    Err(message) => ExecuteAttempt::Failed {
                        message,
                        retryable_if_absent: false,
                    },
                }
            }
            Ok(response) => ExecuteAttempt::Failed {
                message: status_error(response.status()),
                retryable_if_absent: matches!(
                    response.status(),
                    StatusCode::BAD_GATEWAY
                        | StatusCode::SERVICE_UNAVAILABLE
                        | StatusCode::GATEWAY_TIMEOUT
                ),
            },
            Err(message) => ExecuteAttempt::Failed {
                message,
                retryable_if_absent: !cancellation.is_cancelled(),
            },
        }
    }

    async fn action_optional(
        &self,
        action_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<Option<CompanionActionSnapshot>, String> {
        validate_opaque(action_id, "browser action ID")?;
        let path = format!("/v1/actions/{action_id}");
        let response = self
            .send_json::<Value>(Method::GET, &path, None, cancellation)
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(status_error(response.status()));
        }
        let snapshot = self
            .decode_json_response::<CompanionActionSnapshot>(response, cancellation)
            .await?;
        self.validate_action_snapshot(&snapshot, Some(action_id))?;
        Ok(Some(snapshot))
    }

    fn validate_health(&self, health: &CompanionHealth) -> Result<(), String> {
        self.validate_envelope(health.protocol_version, &health.build)?;
        if health.kind != COMPANION_KIND {
            return Err("Browser companion kind does not match Codexify".into());
        }
        if let Some(fingerprint) = &health.account_fingerprint {
            validate_opaque(fingerprint, "browser account fingerprint")?;
        }
        if health.authenticated != health.account_fingerprint.is_some() {
            return Err("Browser companion authentication state is inconsistent".into());
        }
        if let Some(action_id) = &health.active_action_id {
            validate_opaque(action_id, "browser action ID")?;
        }
        Ok(())
    }

    fn validate_action_snapshot(
        &self,
        snapshot: &CompanionActionSnapshot,
        expected_action_id: Option<&str>,
    ) -> Result<(), String> {
        self.validate_envelope(snapshot.protocol_version, &snapshot.build)?;
        validate_opaque(&snapshot.action_id, "browser action ID")?;
        if expected_action_id.is_some_and(|expected| snapshot.action_id != expected) {
            return Err("Browser companion returned the wrong action ID".into());
        }
        if let Some(url) = &snapshot.canonical_url {
            validate_chatgpt_url(url)?;
        }
        if let Some(selected) = &snapshot.selected {
            validate_opaque(&selected.model, "browser model ID")?;
            validate_opaque(&selected.effort, "browser effort ID")?;
        }
        if let Some(attention) = &snapshot.attention {
            validate_opaque(&attention.code, "browser attention code")?;
            validate_optional_text(
                attention.message.as_deref(),
                4096,
                "browser attention message",
            )?;
        }
        Ok(())
    }

    fn validate_envelope(&self, version: u32, build: &str) -> Result<(), String> {
        if version != PROTOCOL_VERSION {
            return Err("Browser companion protocol version is incompatible".into());
        }
        if build != self.build.as_ref() {
            return Err("Browser companion build does not match its descriptor".into());
        }
        Ok(())
    }

    async fn request_json<T, B>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        cancellation: &CancellationToken,
    ) -> Result<T, String>
    where
        T: for<'de> Deserialize<'de>,
        B: Serialize + ?Sized,
    {
        let response = self.send_json(method, path, body, cancellation).await?;
        if !response.status().is_success() {
            return Err(status_error(response.status()));
        }
        self.decode_json_response(response, cancellation).await
    }

    async fn send_json<B>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        cancellation: &CancellationToken,
    ) -> Result<reqwest::Response, String>
    where
        B: Serialize + ?Sized,
    {
        self.send_json_with_timeout(method, path, body, cancellation, Some(self.request_timeout))
            .await
    }

    async fn send_json_with_timeout<B>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        cancellation: &CancellationToken,
        timeout: Option<Duration>,
    ) -> Result<reqwest::Response, String>
    where
        B: Serialize + ?Sized,
    {
        if cancellation.is_cancelled() {
            return Err(cancelled_error());
        }
        let url = self.request_url(path)?;
        let mut request = self
            .http
            .request(method, url)
            .bearer_auth(self.token.as_str())
            .header(header::ACCEPT, "application/json, application/x-ndjson");
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        if let Some(body) = body {
            let encoded = serde_json::to_vec(body)
                .map_err(|_| "Could not encode browser companion request".to_string())?;
            if encoded.len() > MAX_PROMPT_BYTES + 64 * 1024 {
                return Err("Browser companion request is too large".into());
            }
            request = request
                .header(header::CONTENT_TYPE, "application/json")
                .body(encoded);
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(cancelled_error()),
            response = request.send() => response
                .map_err(|_| "Browser companion request failed before a verified response".to_string()),
        }
    }

    async fn decode_json_response<T>(
        &self,
        response: reqwest::Response,
        cancellation: &CancellationToken,
    ) -> Result<T, String>
    where
        T: for<'de> Deserialize<'de>,
    {
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !content_type
            .split(';')
            .next()
            .is_some_and(|value| value.trim() == "application/json")
        {
            return Err("Browser companion JSON response has an invalid content type".into());
        }
        let bytes = read_bounded_response(response, cancellation, MAX_RESPONSE_BYTES).await?;
        serde_json::from_slice(&bytes)
            .map_err(|_| "Browser companion returned invalid JSON".to_string())
    }

    fn request_url(&self, path: &str) -> Result<Url, String> {
        if !path.starts_with('/') || path.starts_with("//") || path.contains('#') {
            return Err("Browser companion request path is invalid".into());
        }
        self.endpoint
            .join(path.trim_start_matches('/'))
            .map_err(|_| "Browser companion request path is invalid".to_string())
    }
}

fn expand_descriptor_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed == "~" {
        return crate::util::home_dir()
            .ok_or_else(|| "Browser companion descriptor path requires a home directory".into());
    }
    let path = if let Some(relative) = trimmed.strip_prefix("~/") {
        crate::util::home_dir()
            .ok_or("Browser companion descriptor path requires a home directory")?
            .join(relative)
    } else {
        PathBuf::from(trimmed)
    };
    if !path.is_absolute() || trimmed.starts_with('~') && !trimmed.starts_with("~/") {
        return Err("Browser companion descriptor path must be absolute or start with ~/".into());
    }
    Ok(path)
}

fn read_descriptor(path: &Path) -> Result<CompanionDescriptor, String> {
    if !path.is_absolute() {
        return Err("Browser companion descriptor path must be absolute".into());
    }
    let parent = path
        .parent()
        .ok_or("Browser companion descriptor has no parent directory")?;
    validate_private_directory(parent)?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "Browser companion descriptor is unavailable".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Browser companion descriptor must be a regular non-symlink file".into());
    }
    if metadata.len() > MAX_DESCRIPTOR_BYTES {
        return Err("Browser companion descriptor is too large".into());
    }
    validate_private_file(&metadata, "Browser companion descriptor")?;
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
        .map_err(|_| "Browser companion descriptor is unavailable".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "Browser companion descriptor is unavailable".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_DESCRIPTOR_BYTES {
        return Err("Browser companion descriptor is invalid".into());
    }
    validate_private_file(&metadata, "Browser companion descriptor")?;
    let mut bytes = Vec::new();
    file.take(MAX_DESCRIPTOR_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Browser companion descriptor is unreadable".to_string())?;
    if bytes.len() as u64 > MAX_DESCRIPTOR_BYTES {
        return Err("Browser companion descriptor is too large".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Browser companion descriptor is invalid JSON".to_string())
}

fn validate_descriptor(descriptor: &CompanionDescriptor) -> Result<(), String> {
    if descriptor.version != PROTOCOL_VERSION || descriptor.kind != COMPANION_KIND {
        return Err("Browser companion descriptor protocol is incompatible".into());
    }
    if descriptor.pid == 0 || !process_is_alive(descriptor.pid) {
        return Err("Browser companion descriptor process is not running".into());
    }
    let endpoint = Url::parse(&descriptor.endpoint)
        .map_err(|_| "Browser companion descriptor endpoint is invalid".to_string())?;
    if endpoint.scheme() != "http"
        || endpoint.host_str() != Some("127.0.0.1")
        || endpoint.port().is_none()
        || endpoint.username() != ""
        || endpoint.password().is_some()
        || endpoint.path() != "/"
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(
            "Browser companion descriptor endpoint must be a private IPv4 loopback URL".into(),
        );
    }
    if descriptor.token.len() != 43
        || URL_SAFE_NO_PAD
            .decode(&descriptor.token)
            .ok()
            .is_none_or(|bytes| bytes.len() != 32)
    {
        return Err("Browser companion descriptor bearer secret is invalid".into());
    }
    validate_build(&descriptor.build)?;
    chrono::DateTime::parse_from_rfc3339(&descriptor.created_at)
        .map_err(|_| "Browser companion descriptor timestamp is invalid".to_string())?;
    Ok(())
}

fn validate_private_directory(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "Browser companion descriptor directory is unavailable".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Browser companion descriptor directory must be a real directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(
                "Browser companion descriptor directory must be private to the current user".into(),
            );
        }
    }
    Ok(())
}

fn validate_private_file(metadata: &std::fs::Metadata, label: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(format!("{label} must be private to the current user"));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    if pid > i32::MAX as u32 {
        return false;
    }
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    unsafe { CloseHandle(handle) };
    true
}

#[cfg(not(any(unix, windows)))]
fn process_is_alive(_pid: u32) -> bool {
    true
}

fn validate_build(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
    {
        return Err("Browser companion build identifier is invalid".into());
    }
    Ok(())
}

fn validate_catalog(catalog: &CapabilityCatalog) -> Result<(), String> {
    validate_opaque(&catalog.account_fingerprint, "browser account fingerprint")?;
    validate_opaque(&catalog.catalog_revision, "browser catalog revision")?;
    if catalog.models.is_empty() || catalog.models.len() > 32 {
        return Err("Browser companion model catalog has an invalid size".into());
    }
    let mut model_ids = std::collections::HashSet::new();
    for model in &catalog.models {
        validate_opaque(&model.id, "browser model ID")?;
        validate_visible(&model.label, 128, "browser model label")?;
        if !model_ids.insert(&model.id) || model.efforts.is_empty() || model.efforts.len() > 16 {
            return Err("Browser companion model catalog is invalid".into());
        }
        let mut effort_ids = std::collections::HashSet::new();
        for effort in &model.efforts {
            validate_opaque(&effort.id, "browser effort ID")?;
            validate_visible(&effort.label, 128, "browser effort label")?;
            validate_optional_text(effort.reason.as_deref(), 256, "browser effort reason")?;
            if !effort.available && effort.reason.is_none() {
                return Err("Browser companion unavailable effort has no explanation".into());
            }
            if !effort_ids.insert(&effort.id) {
                return Err("Browser companion model catalog contains duplicate efforts".into());
            }
        }
    }
    Ok(())
}

fn validate_execute_request(request: &ExecuteActionRequest) -> Result<(), String> {
    validate_opaque(&request.action_id, "browser action ID")?;
    validate_opaque(&request.idempotency_key, "browser action idempotency key")?;
    validate_chatgpt_url(&request.url)?;
    validate_chatgpt_url(&request.expected_url)?;
    if request.pairing_generation == 0 {
        return Err("Browser action pairing generation must be positive".into());
    }
    validate_visible(&request.connector_name, 128, "browser connector name")?;
    validate_opaque(&request.model, "browser model ID")?;
    validate_opaque(&request.effort, "browser effort ID")?;
    validate_prompt(&request.prompt)?;
    let encoded = serde_json::to_vec(request)
        .map_err(|_| "Could not encode browser action request".to_string())?;
    if encoded.len() > MAX_PROMPT_BYTES + 64 * 1024 {
        return Err("Browser action request is too large".into());
    }
    Ok(())
}

fn validate_prompt(prompt: &ActionPrompt) -> Result<(), String> {
    match prompt {
        ActionPrompt::PairVerify { reference } => {
            if reference.len() != 43
                || URL_SAFE_NO_PAD
                    .decode(reference)
                    .ok()
                    .is_none_or(|bytes| bytes.len() != 32)
            {
                return Err("Browser pairing reference is invalid".into());
            }
        }
        ActionPrompt::OfflineChat { batch_id, messages } => {
            validate_batch(batch_id, messages)?;
        }
        ActionPrompt::OfflineGoal { goal_revision } => {
            if *goal_revision == 0 {
                return Err("Browser goal revision must be positive".into());
            }
        }
        ActionPrompt::OfflineCombined {
            batch_id,
            messages,
            goal_revision,
        } => {
            validate_batch(batch_id, messages)?;
            if *goal_revision == 0 {
                return Err("Browser goal revision must be positive".into());
            }
        }
    }
    Ok(())
}

fn validate_batch(batch_id: &str, messages: &[CompanionUnreadMessage]) -> Result<(), String> {
    validate_opaque(batch_id, "browser unread batch ID")?;
    if messages.is_empty() || messages.len() > MAX_UNREAD_MESSAGES {
        return Err("Browser unread batch has an invalid size".into());
    }
    let mut total = 0usize;
    let mut ids = std::collections::HashSet::new();
    for message in messages {
        validate_opaque(&message.id, "browser unread message ID")?;
        if !ids.insert(&message.id) || message.markdown.trim().is_empty() {
            return Err("Browser unread batch is invalid".into());
        }
        total = total
            .checked_add(message.markdown.len())
            .ok_or("Browser unread batch is too large")?;
        if total > MAX_PROMPT_BYTES {
            return Err("Browser unread batch is too large".into());
        }
    }
    Ok(())
}

fn validate_event(
    event: &CompanionEvent,
    expected_action_id: &str,
    last_sequence: u64,
) -> Result<(), String> {
    if event.sequence <= last_sequence {
        return Err("Browser companion event sequence is not strictly increasing".into());
    }
    if event.action_id != expected_action_id {
        return Err("Browser companion event belongs to the wrong action".into());
    }
    match &event.kind {
        CompanionEventKind::ModelVerified { model, effort } => {
            validate_opaque(model, "browser model ID")?;
            validate_opaque(effort, "browser effort ID")?;
        }
        CompanionEventKind::StatusDelta { text, .. } => {
            validate_text(text, MAX_DELTA_BYTES, "browser status delta")?;
        }
        CompanionEventKind::CommentaryDelta { markdown, .. }
        | CompanionEventKind::AnswerDelta { markdown, .. } => {
            validate_text(markdown, MAX_DELTA_BYTES, "browser Markdown delta")?;
        }
        CompanionEventKind::GenerationComplete {
            final_markdown,
            canonical_url,
        } => {
            validate_optional_text(
                final_markdown.as_deref(),
                MAX_FINAL_ANSWER_BYTES,
                "browser final answer",
            )?;
            if let Some(url) = canonical_url {
                validate_chatgpt_url(url)?;
            }
        }
        CompanionEventKind::ApprovalRequired { message }
        | CompanionEventKind::RateLimited { message }
        | CompanionEventKind::ExternalInterference { message }
        | CompanionEventKind::AmbiguousSend { message } => {
            validate_optional_text(message.as_deref(), 4096, "browser attention message")?;
        }
        CompanionEventKind::Failed { code, message } => {
            validate_opaque(code, "browser failure code")?;
            validate_text(message, 4096, "browser failure message")?;
        }
        CompanionEventKind::Queued
        | CompanionEventKind::Navigating
        | CompanionEventKind::ComposerReady
        | CompanionEventKind::ConnectorVerified
        | CompanionEventKind::SendAccepted
        | CompanionEventKind::AuthenticationRequired => {}
    }
    Ok(())
}

fn validate_chatgpt_url(value: &str) -> Result<(), String> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("ChatGPT conversation URL is invalid".into());
    }
    let url = Url::parse(value).map_err(|_| "ChatGPT conversation URL is invalid".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("chatgpt.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.path() == "/"
    {
        return Err("ChatGPT conversation URL is invalid".into());
    }
    Ok(())
}

fn validate_opaque(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_visible(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > max
        || value.chars().any(|character| character.is_control())
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_text(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > max || value.contains('\0') {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_optional_text(value: Option<&str>, max: usize, label: &str) -> Result<(), String> {
    if let Some(value) = value {
        validate_text(value, max, label)?;
    }
    Ok(())
}

async fn read_bounded_response(
    mut response: reqwest::Response,
    cancellation: &CancellationToken,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("Browser companion response is too large".into());
    }
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled_error()),
            chunk = response.chunk() => chunk
                .map_err(|_| "Browser companion response stream failed".to_string())?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("Browser companion response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn status_error(status: StatusCode) -> String {
    match status {
        StatusCode::UNAUTHORIZED => "Browser companion rejected its bearer authorization".into(),
        StatusCode::NOT_FOUND => "Browser companion resource is unavailable".into(),
        StatusCode::CONFLICT => {
            "Browser companion rejected the operation because its state changed".into()
        }
        StatusCode::TOO_MANY_REQUESTS => "Browser companion is rate limited".into(),
        _ => format!("Browser companion returned HTTP status {}", status.as_u16()),
    }
}

fn cancelled_error() -> String {
    "Browser companion request was cancelled".into()
}
