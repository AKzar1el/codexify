//! Read-only, optional analytics. Never shares automation locks or error paths.
use super::*;
use crate::agent_automation::turn_analytics::{self, Summary};
use std::sync::{
    OnceLock,
    atomic::{AtomicBool, Ordering},
};

struct ReaderPermit(Arc<AtomicBool>);
impl Drop for ReaderPermit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
static READING: OnceLock<Arc<AtomicBool>> = OnceLock::new();

async fn best_effort<T: Default + Send + 'static>(
    busy: Arc<AtomicBool>,
    deadline: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> T {
    if busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return T::default();
    }
    let permit = ReaderPermit(busy);
    let (tx, rx) = tokio::sync::oneshot::channel();
    // A slow or inaccessible analytics disk must not occupy an async worker or
    // spawn unbounded readers. A timed-out reader retains its permit until exit.
    let _ = std::thread::Builder::new()
        .name("turn-cutoff-summary".into())
        .spawn(move || {
            let _permit = permit;
            let _ = tx.send(work());
        });
    tokio::time::timeout(deadline, rx)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default()
}

pub(super) async fn read(State(state): State<OwnerState>) -> Json<Summary> {
    let busy = READING.get_or_init(Default::default).clone();
    Json(
        best_effort(busy, Duration::from_secs(1), move || {
            turn_analytics::summary(
                locate(&state.config, &state.project_bindings)
                    .into_iter()
                    .map(|chat| chat.path),
            )
        })
        .await,
    )
}

#[derive(Deserialize)]
pub(super) struct UsageQuery {
    days: Option<String>,
}

pub(super) async fn extras(
    State(state): State<OwnerState>,
) -> Result<Json<crate::usage_extras::Snapshot>, (StatusCode, String)> {
    static EXTRAS_READING: OnceLock<Arc<AtomicBool>> = OnceLock::new();
    best_effort(
        EXTRAS_READING.get_or_init(Default::default).clone(),
        Duration::from_secs(2),
        move || {
            Some(crate::usage_extras::snapshot(
                &state.config,
                locate(&state.config, &state.project_bindings)
                    .into_iter()
                    .map(|c| (c.id, c.path))
                    .collect(),
                crate::markdown_chat::now_ms(),
            ))
        },
    )
    .await
    .ok_or_else(|| (StatusCode::SERVICE_UNAVAILABLE, "Statistics busy".into()))?
    .map(Json)
    .map_err(internal_error)
}

#[derive(Deserialize)]
pub(super) struct Claim {
    id: String,
}
pub(super) async fn claim_extra(
    State(state): State<OwnerState>,
    Json(input): Json<Claim>,
) -> Result<Json<Value>, (StatusCode, String)> {
    static CLAIMING: OnceLock<Arc<AtomicBool>> = OnceLock::new();
    best_effort(
        CLAIMING.get_or_init(Default::default).clone(),
        Duration::from_secs(2),
        move || Some(crate::usage_extras::claim(&state.config, &input.id)),
    )
    .await
    .ok_or_else(|| (StatusCode::SERVICE_UNAVAILABLE, "Statistics busy".into()))?
    .map(|claimed| Json(json!({"claimed":claimed})))
    .map_err(internal_error)
}
pub(super) async fn usage(
    State(state): State<OwnerState>,
    Query(query): Query<UsageQuery>,
) -> Json<crate::usage_analytics::Dashboard> {
    let days = match query.days.as_deref() {
        Some("all") => None,
        value => Some(
            value
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(7)
                .clamp(1, 3660),
        ),
    };
    // Separate permits keep optional dashboard reads independent of cutoff stats.
    static USAGE_READING: OnceLock<Arc<AtomicBool>> = OnceLock::new();
    let busy = USAGE_READING.get_or_init(Default::default).clone();
    Json(
        best_effort(busy, Duration::from_secs(2), move || {
            crate::usage_analytics::dashboard(
                locate(&state.config, &state.project_bindings)
                    .into_iter()
                    .map(|c| (c.id, c.path)),
                days,
                crate::markdown_chat::now_ms(),
                &crate::usage_analytics::Options::from_config(&state.config),
            )
        })
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn timeout_and_concurrent_reads_return_empty_without_blocking() {
        let busy = Arc::new(AtomicBool::new(false));
        let (tx, rx) = std::sync::mpsc::channel();
        let result = best_effort(busy.clone(), Duration::from_millis(10), move || {
            let _ = rx.recv();
            Summary::default()
        })
        .await;
        assert_eq!(result.samples, 0);
        assert!(busy.load(Ordering::Acquire));
        let result = best_effort::<Summary>(busy.clone(), Duration::from_millis(10), || {
            panic!("busy readers must be skipped")
        })
        .await;
        assert_eq!(result.samples, 0);
        tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while busy.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            best_effort(busy, Duration::from_secs(1), Summary::default)
                .await
                .samples,
            0
        );
    }
    #[tokio::test]
    async fn owner_endpoint_is_authenticated_and_corrupt_analytics_cannot_break_chats() {
        crate::tls::ensure_crypto_provider();
        let temp = tempfile::tempdir().unwrap();
        let mut config = crate::config::default_config(temp.path().into());
        config.markdown_chat.enabled = true;
        config.memory.dir = Some(temp.path().join("state").display().to_string());
        let identity = ConversationIdentity::from_openai_session("analytics-api-test").unwrap();
        let chats = Arc::new(MarkdownChatStore::default());
        let chat = chats
            .chat(
                &config,
                Some(&identity),
                &crate::exec_sessions::SessionState::new(),
            )
            .unwrap();
        chat.ensure().await.unwrap();
        let bad = chat.path().with_file_name("turn-cutoff-estimates.json");
        std::fs::write(&bad, b"bad analytics").unwrap();
        let state = OwnerState {
            project_bindings: Arc::new(crate::project_bindings::ProjectBindingStore::new(
                temp.path().join("bindings"),
            )),
            creation_lock: Arc::default(),
            artifacts: Arc::new(ArtifactEgressStore::new_at(
                config.artifact_egress.clone(),
                temp.path().join("artifacts"),
            )),
            config: Arc::new(config),
            chats,
            continuations: Arc::new(
                ConversationContinuationStore::new(temp.path().join("continuations.json")).unwrap(),
            ),
            automation: None,
            open_browser: Arc::new(|_| Ok(())),
            catalog_cache: Arc::default(),
            global: Arc::default(),
            token: "test-token".into(),
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server =
            tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
        let client = reqwest::Client::new();
        let endpoint = format!("http://127.0.0.1:{port}/api/analytics/turn-cutoffs");
        assert_eq!(
            client.get(&endpoint).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let response = client
            .get(&endpoint)
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"samples":0,"models":[]})
        );
        let chats = client
            .get(format!("http://127.0.0.1:{port}/api/chats"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap();
        assert_eq!(chats.status(), StatusCode::OK);
        assert_eq!(
            chats.json::<Value>().await.unwrap()["chats"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let usage = client
            .get(format!(
                "http://127.0.0.1:{port}/api/analytics/usage?days=30"
            ))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap();
        assert_eq!(usage.status(), StatusCode::OK);
        assert_eq!(usage.json::<Value>().await.unwrap()["totals"]["turns"], 0);
        let extras_url = format!("http://127.0.0.1:{port}/api/analytics/extras");
        assert_eq!(
            client.get(&extras_url).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .post(format!("{extras_url}/claim"))
                .json(&json!({"id":"week:2026-10-11"}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let extras = client
            .get(&extras_url)
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap();
        assert_eq!(extras.status(), StatusCode::OK);
        let extras = extras.json::<Value>().await.unwrap();
        assert_eq!(extras["badges"].as_array().unwrap().len(), 8);
        assert_eq!(extras["week"]["ready"], false);
        assert_eq!(extras["preferences"]["animations"], true);
        let milestones = temp.path().join("state/statistics-extras.json");
        std::fs::write(&milestones, b"broken milestones").unwrap();
        assert_eq!(
            client
                .get(&extras_url)
                .bearer_auth("test-token")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            client
                .get(format!("http://127.0.0.1:{port}/api/chats"))
                .bearer_auth("test-token")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(std::fs::read(&milestones).unwrap(), b"broken milestones");

        assert_eq!(std::fs::read(&bad).unwrap(), b"bad analytics");
        server.abort();
    }
}
