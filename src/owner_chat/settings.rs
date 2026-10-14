use super::*;

#[derive(Default)]
pub(super) struct GlobalRuntime {
    plan: Option<Value>,
    plan_account: Option<String>,
    plan_attempted: bool,
    plan_retry_at_ms: u64,
    refresh: Option<Value>,
    manual_refresh: Option<Value>,
}
impl GlobalRuntime {
    pub(super) fn reset_plan(&mut self) {
        self.plan = None;
        self.plan_attempted = false;
        self.plan_retry_at_ms = 0;
    }
    fn record_plan(&mut self, result: Result<Value, String>, now_ms: u64) {
        match result {
            Ok(plan) => {
                self.plan = Some(plan);
                self.plan_attempted = true;
                self.plan_retry_at_ms = 0;
            }
            Err(error) if error.to_lowercase().contains("busy") || error.contains("423") => {}
            Err(_) => {
                // Cache successful lookups only; retry transient failures after a cooldown.
                self.plan_retry_at_ms = now_ms.saturating_add(60_000);
            }
        }
    }
    fn observe_account(&mut self, account: Option<String>) {
        // A transient browser-health failure does not identify an account change.
        // Retain the startup cache until a different account is actually verified.
        if account.is_some() && account != self.plan_account {
            self.reset_plan();
            self.plan_account = account;
        }
    }
}

pub(super) fn start(state: OwnerState) {
    if state.config.loaded_config_path.is_none() {
        return;
    }
    tokio::spawn(async move {
        let epoch = format!("{}-{}", std::process::id(), crate::markdown_chat::now_ms());
        loop {
            let pending = crate::global_settings::read_refresh_intent().filter(|intent| {
                intent["targetVersion"] == env!("CARGO_PKG_VERSION")
                    && intent["phase"] == "waiting_for_restart"
            });
            if state.config.markdown_chat.automation.enabled
                && companion_client(&state).is_err()
                && let Some(mut intent) = pending
                && intent["updateId"]
                    .as_str()
                    .and_then(|id| crate::self_update::read_update_status(id).ok())
                    .is_some_and(|record| {
                        record.state == crate::self_update::UpdatePhase::Succeeded
                    })
            {
                let upgraded = async {
                    let manager = crate::agent_automation::BrowserCompanionManager::from_config(
                        &state.config.markdown_chat.automation,
                    )?;
                    if !manager.status().await.installed {
                        manager.install().await?;
                    }
                    manager.start().await?;
                    Ok::<_, String>(())
                }
                .await;
                if let Err(error) = upgraded {
                    intent["phase"] = json!("failed");
                    intent["result"] = json!({"error":error});
                    let _ = crate::global_settings::write_refresh_intent(&intent);
                    state.global.lock().await.refresh = Some(intent);
                }
            }
            if let Ok(client) = companion_client(&state)
                && let Ok(health) = client.health(&CancellationToken::new()).await
            {
                let account = health.account_fingerprint.clone();
                let mut global = state.global.lock().await;
                global.observe_account(account);
                if health.authenticated
                    && !global.plan_attempted
                    && crate::markdown_chat::now_ms() >= global.plan_retry_at_ms
                    && health.active_action_id.is_none()
                {
                    drop(global);
                    let plan = client.account_plan(&epoch, &CancellationToken::new()).await;
                    global = state.global.lock().await;
                    global.record_plan(plan, crate::markdown_chat::now_ms());
                }
                drop(global);
                if health.authenticated && health.active_action_id.is_none() {
                    let intent = crate::global_settings::read_refresh_intent();
                    if let Some(mut intent) = intent.filter(|intent| {
                        intent["targetVersion"] == env!("CARGO_PKG_VERSION")
                            && intent["phase"] == "waiting_for_restart"
                    }) {
                        // Wait for the updater's readiness check, rather than refreshing a half-started server.
                        let succeeded = intent["updateId"]
                            .as_str()
                            .and_then(|id| crate::self_update::read_update_status(id).ok())
                            .is_some_and(|record| {
                                record.state == crate::self_update::UpdatePhase::Succeeded
                            });
                        if succeeded {
                            let result = client
                                .refresh_connector(
                                    &state.config.markdown_chat.automation.connector_name,
                                    &CancellationToken::new(),
                                )
                                .await;
                            if result.as_ref().is_err_and(|error| error.contains("423")) {
                                tokio::time::sleep(Duration::from_secs(5)).await;
                                continue;
                            }
                            intent["phase"] = json!(if result.is_ok() {
                                "completed"
                            } else {
                                "failed"
                            });
                            intent["result"] = match result {
                                Ok(value) => value,
                                Err(error) => json!({"error":error}),
                            };
                            let _ = crate::global_settings::write_refresh_intent(&intent);
                            state.global.lock().await.refresh = Some(intent);
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

pub(super) async fn health(State(state): State<OwnerState>) -> ApiResult {
    let response = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/health", state.config.port))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map_err(internal_error)?;
    let body = response.json::<Value>().await.map_err(internal_error)?;
    Ok(Json(body))
}

pub(super) async fn status(State(state): State<OwnerState>) -> ApiResult {
    let latest = crate::self_update::inspect_latest_version().await;
    let global = state.global.lock().await;
    let latest = match latest {
        Ok(value) => {
            json!({"version":value.latest.to_string(),"updateAvailable":value.status==crate::self_update::LatestVersionStatus::UpdateAvailable})
        }
        Err(_) => json!({"version":null,"updateAvailable":false,"unavailable":true}),
    };
    let refresh = global
        .manual_refresh
        .clone()
        .or_else(|| global.refresh.clone())
        .or_else(crate::global_settings::read_refresh_intent);
    Ok(Json(
        json!({"version":env!("CARGO_PKG_VERSION"),"instanceId":std::process::id().to_string(),"latest":latest,"plan":global.plan,"connectorRefresh":refresh,
        "settingsAvailable":state.config.loaded_config_path.is_some(),"restartAvailable":std::env::var_os(crate::process_env::SERVICE_SUPERVISED_ENV).as_deref()==Some(std::ffi::OsStr::new("1"))&&crate::service::is_installed().unwrap_or(false)}),
    ))
}

pub(super) async fn read(State(state): State<OwnerState>) -> ApiResult {
    let config = state.config.clone();
    let value = tokio::task::spawn_blocking(move || crate::global_settings::snapshot(&config))
        .await
        .map_err(internal_error)?
        .map_err(internal_error)?;
    Ok(Json(value))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SaveBody {
    revision: String,
    raw: Option<String>,
    changes: Option<serde_json::Map<String, Value>>,
}
pub(super) async fn save(State(state): State<OwnerState>, Json(body): Json<SaveBody>) -> ApiResult {
    let config = state.config.clone();
    let value = tokio::task::spawn_blocking(move || {
        crate::global_settings::save(&config, &body.revision, body.raw, body.changes)
    })
    .await
    .map_err(internal_error)?
    .map_err(|error| {
        (
            if error.contains("changed on disk") {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            },
            error,
        )
    })?;
    Ok(Json(value))
}

pub(super) async fn restart(State(_state): State<OwnerState>) -> ApiResult {
    tokio::task::spawn_blocking(crate::global_settings::schedule_restart)
        .await
        .map_err(internal_error)?
        .map_err(internal_error)?;
    Ok(Json(json!({"scheduled":true})))
}

pub(super) async fn update(State(state): State<OwnerState>) -> ApiResult {
    let receipt = crate::self_update::trigger(state.config.port)
        .await
        .map_err(internal_error)?;
    Ok(Json(serde_json::to_value(receipt).map_err(internal_error)?))
}

pub(super) async fn refresh_connector(State(state): State<OwnerState>) -> ApiResult {
    let mut global = state.global.lock().await;
    if let Some(pending) = global.manual_refresh.as_ref()
        && matches!(pending["phase"].as_str(), Some("queued" | "running"))
    {
        return Ok(Json(pending.clone()));
    }
    // Validate the companion connection before accepting a new job, then return
    // immediately. The job belongs to the server, not the requesting browser page.
    companion_client(&state)?;
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = format!(
        "refresh-{}-{}",
        crate::markdown_chat::now_ms(),
        SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let receipt = json!({"refreshId":id,"source":"manual","phase":"queued"});
    global.manual_refresh = Some(receipt.clone());
    drop(global);
    tokio::spawn(run_manual_refresh(state, id, Duration::from_secs(5)));
    Ok(Json(receipt))
}

async fn set_manual_refresh_phase(
    state: &OwnerState,
    id: &str,
    phase: &str,
    result: Option<Value>,
) {
    let mut global = state.global.lock().await;
    if let Some(refresh) = global.manual_refresh.as_mut()
        && refresh["refreshId"] == id
    {
        refresh["phase"] = json!(phase);
        if let Some(result) = result {
            refresh["result"] = result;
        }
    }
}

async fn run_manual_refresh(state: OwnerState, id: String, retry_after: Duration) {
    loop {
        let result = async {
            let client = companion_client(&state).map_err(|(_, error)| error)?;
            let health = client.health(&CancellationToken::new()).await?;
            if health.active_action_id.is_some()
                || health.status == crate::agent_automation::CompanionSessionStatus::Busy
            {
                return Err("Browser companion is busy".to_string());
            }
            set_manual_refresh_phase(&state, &id, "running", None).await;
            client
                .refresh_connector(
                    &state.config.markdown_chat.automation.connector_name,
                    &CancellationToken::new(),
                )
                .await
        }
        .await;
        match result {
            Err(error)
                if error.to_lowercase().contains("busy") || error.contains("HTTP status 423") =>
            {
                set_manual_refresh_phase(&state, &id, "queued", None).await;
                tokio::time::sleep(retry_after).await;
            }
            Ok(result) => {
                // A manual refresh also satisfies any previously pending update refresh.
                if state.config.loaded_config_path.is_some()
                    && let Some(mut intent) = crate::global_settings::read_refresh_intent()
                {
                    intent["phase"] = json!("completed");
                    intent["result"] = result.clone();
                    let _ = crate::global_settings::write_refresh_intent(&intent);
                }
                set_manual_refresh_phase(&state, &id, "completed", Some(result)).await;
                return;
            }
            Err(error) => {
                set_manual_refresh_phase(&state, &id, "failed", Some(json!({"error":error}))).await;
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Clone, Default)]
    struct RefreshFixture {
        mode: Arc<std::sync::atomic::AtomicUsize>,
        health_calls: Arc<std::sync::atomic::AtomicUsize>,
        calls: Arc<std::sync::atomic::AtomicUsize>,
        successes: Arc<std::sync::atomic::AtomicUsize>,
        release: Arc<tokio::sync::Notify>,
    }
    async fn refresh_health(State(fixture): State<RefreshFixture>) -> Json<Value> {
        use std::sync::atomic::Ordering;
        fixture.health_calls.fetch_add(1, Ordering::SeqCst);
        Json(
            json!({"protocolVersion":1,"kind":"codexify-browser-companion",
            "build":format!("1.7.0{}",crate::agent_automation::PROTOCOL_BUILD_SUFFIX),
            "authenticated":true,"accountFingerprint":"fixture-account","activeActionId":null,
            "status":if fixture.mode.load(Ordering::SeqCst)==0 {"busy"} else {"idle"}}),
        )
    }
    async fn fixture_refresh(
        State(fixture): State<RefreshFixture>,
        headers: axum::http::HeaderMap,
        Json(body): Json<Value>,
    ) -> Response {
        use std::sync::atomic::Ordering;
        assert_eq!(
            headers[header::AUTHORIZATION],
            "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        );
        assert_eq!(body["name"], "Fixture connector");
        fixture.calls.fetch_add(1, Ordering::SeqCst);
        match fixture.mode.load(Ordering::SeqCst) {
            1 => (
                StatusCode::LOCKED,
                Json(json!({"error":"Browser companion is busy"})),
            )
                .into_response(),
            2 => {
                fixture.release.notified().await;
                fixture.successes.fetch_add(1, Ordering::SeqCst);
                Json(json!({"refreshObserved":true,"permissionChanged":false,"schemaVerified":false})).into_response()
            }
            4 => (
                StatusCode::CONFLICT,
                Json(json!({"error":"Selector changed"})),
            )
                .into_response(),
            _ => {
                fixture.successes.fetch_add(1, Ordering::SeqCst);
                Json(json!({"refreshObserved":true,"permissionChanged":false,"schemaVerified":false})).into_response()
            }
        }
    }
    async fn refresh_fixture(
        root: &FilePath,
    ) -> (
        OwnerState,
        RefreshFixture,
        String,
        tokio::task::JoinHandle<()>,
        tokio::task::JoinHandle<()>,
    ) {
        crate::tls::ensure_crypto_provider();
        let fixture = RefreshFixture::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/v1/health", get(refresh_health))
            .route("/v1/connectors/refresh", post(fixture_refresh))
            .with_state(fixture.clone());
        let companion = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let browser_directory = root.join("browser");
        std::fs::create_dir_all(&browser_directory).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&browser_directory, std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        let descriptor = browser_directory.join("descriptor.json");
        std::fs::write(&descriptor, json!({"version":1,"kind":"codexify-browser-companion","pid":std::process::id(),
            "endpoint":endpoint,"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "build":format!("1.7.0{}",crate::agent_automation::PROTOCOL_BUILD_SUFFIX),"createdAt":"2026-10-14T00:00:00Z"}).to_string()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&descriptor, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let mut config = crate::config::default_config(root.to_owned());
        config.markdown_chat.automation.enabled = true;
        config.markdown_chat.automation.descriptor_path = descriptor.display().to_string();
        config.markdown_chat.automation.connector_name = "Fixture connector".into();
        let state = OwnerState {
            config: Arc::new(config),
            chats: Arc::default(),
            project_bindings: Arc::new(crate::project_bindings::ProjectBindingStore::new(
                root.join("bindings"),
            )),
            creation_lock: Arc::default(),
            artifacts: Arc::new(ArtifactEgressStore::new_at(
                crate::types::ArtifactEgressConfig::default(),
                root.join("artifacts"),
            )),
            continuations: Arc::new(
                ConversationContinuationStore::new(root.join("continuations.json")).unwrap(),
            ),
            automation: None,
            open_browser: Arc::new(|_| Ok(())),
            catalog_cache: Arc::default(),
            global: Arc::default(),
            token: "owner-test-token".into(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        companion_client(&state).expect("fixture companion descriptor must be valid");
        let app = router(state.clone());
        let owner = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (state, fixture, base, owner, companion)
    }
    async fn wait_refresh_phase(state: &OwnerState, phase: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                let refresh = state.global.lock().await.manual_refresh.clone().unwrap();
                if refresh["phase"] == phase {
                    return refresh;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("refresh changed phase")
    }
    #[tokio::test]
    async fn manual_refresh_queues_and_deduplicates_until_busy_tab_becomes_available() {
        use std::sync::atomic::Ordering;
        let root = tempfile::tempdir().unwrap();
        let (state, fixture, base, owner, companion) = refresh_fixture(root.path()).await;
        let client = reqwest::Client::new();
        let url = format!("{base}/api/settings/refresh-connector");
        assert_eq!(
            client.post(&url).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let receipt: Value = tokio::time::timeout(
            Duration::from_secs(1),
            client.post(&url).bearer_auth("owner-test-token").send(),
        )
        .await
        .unwrap()
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!(receipt["phase"], "queued");
        let duplicate: Value = client
            .post(&url)
            .bearer_auth("owner-test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(duplicate["refreshId"], receipt["refreshId"]);
        assert_eq!(
            fixture.calls.load(Ordering::SeqCst),
            0,
            "health-busy tabs are left untouched"
        );
        fixture.mode.store(1, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(6), async {
            while fixture.calls.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        wait_refresh_phase(&state, "queued").await;
        assert_eq!(
            fixture.successes.load(Ordering::SeqCst),
            0,
            "HTTP 423 keeps the job queued"
        );
        fixture.mode.store(2, Ordering::SeqCst);
        wait_refresh_phase(&state, "running").await;
        let duplicate: Value = client
            .post(&url)
            .bearer_auth("owner-test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(duplicate["refreshId"], receipt["refreshId"]);
        assert_eq!(duplicate["phase"], "running");
        fixture.release.notify_one();
        let done = wait_refresh_phase(&state, "completed").await;
        assert_eq!(done["refreshId"], receipt["refreshId"]);
        assert_eq!(done["result"]["refreshObserved"], true);
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
        assert_eq!(fixture.successes.load(Ordering::SeqCst), 1);
        owner.abort();
        companion.abort();
    }
    #[tokio::test]
    async fn manual_refresh_reports_real_failure_and_allows_a_new_retry() {
        use std::sync::atomic::Ordering;
        let root = tempfile::tempdir().unwrap();
        let (state, fixture, base, owner, companion) = refresh_fixture(root.path()).await;
        fixture.mode.store(4, Ordering::SeqCst);
        let client = reqwest::Client::new();
        let url = format!("{base}/api/settings/refresh-connector");
        let first: Value = client
            .post(&url)
            .bearer_auth("owner-test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let failed = wait_refresh_phase(&state, "failed").await;
        assert!(
            failed["result"]["error"]
                .as_str()
                .unwrap()
                .contains("state changed")
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
        fixture.mode.store(3, Ordering::SeqCst);
        let retry: Value = client
            .post(&url)
            .bearer_auth("owner-test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_ne!(first["refreshId"], retry["refreshId"]);
        wait_refresh_phase(&state, "completed").await;
        assert_eq!(fixture.successes.load(Ordering::SeqCst), 1);
        owner.abort();
        companion.abort();
    }
    #[test]
    fn failed_plan_lookup_retries_and_success_is_cached_until_restart() {
        let mut runtime = GlobalRuntime::default();
        runtime.record_plan(Err("Browser operation timed out".into()), 1000);
        assert!(!runtime.plan_attempted);
        assert!(runtime.plan.is_none());
        assert_eq!(runtime.plan_retry_at_ms, 61_000);
        runtime.record_plan(Ok(json!({"label":"Pro 20x","kind":"pro"})), 61_000);
        assert!(runtime.plan_attempted);
        assert_eq!(runtime.plan_retry_at_ms, 0);
        assert_eq!(runtime.plan.as_ref().unwrap()["label"], "Pro 20x");
        runtime.reset_plan();
        assert!(!runtime.plan_attempted);
        assert!(runtime.plan.is_none());
        assert_eq!(runtime.plan_retry_at_ms, 0);
    }
    #[test]
    fn cached_plan_survives_transient_health_failures_and_resets_for_a_verified_new_account() {
        let mut runtime = GlobalRuntime {
            plan: Some(json!({"label":"Pro 20x","kind":"pro"})),
            plan_account: Some("account-one".into()),
            plan_attempted: true,
            plan_retry_at_ms: 0,
            refresh: None,
            manual_refresh: None,
        };
        runtime.observe_account(None);
        runtime.observe_account(Some("account-one".into()));
        assert_eq!(runtime.plan.as_ref().unwrap()["label"], "Pro 20x");
        assert!(runtime.plan_attempted);
        runtime.observe_account(Some("account-two".into()));
        assert!(runtime.plan.is_none());
        assert!(!runtime.plan_attempted);
    }
    #[tokio::test]
    async fn global_editor_is_owner_authenticated_and_invalid_saves_leave_the_file_unchanged() {
        crate::tls::ensure_crypto_provider();
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("config.json");
        std::fs::write(
            &file,
            format!(
                "{{\"workDir\":{},\"codexMcp\":{{\"enabled\":false}},\"debug\":false}}",
                serde_json::to_string(root.path()).unwrap()
            ),
        )
        .unwrap();
        let mut config = crate::config::default_config(root.path().to_owned());
        config.loaded_config_path = Some(file.clone());
        let state = OwnerState {
            config: Arc::new(config),
            chats: Arc::default(),
            project_bindings: Arc::new(crate::project_bindings::ProjectBindingStore::new(
                root.path().join("bindings"),
            )),
            creation_lock: Arc::default(),
            artifacts: Arc::new(ArtifactEgressStore::new_at(
                crate::types::ArtifactEgressConfig::default(),
                root.path().join("artifacts"),
            )),
            continuations: Arc::new(
                ConversationContinuationStore::new(root.path().join("continuations.json")).unwrap(),
            ),
            automation: None,
            open_browser: Arc::new(|_| Ok(())),
            catalog_cache: Arc::default(),
            global: Arc::default(),
            token: "test-token".into(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server =
            tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
        let client = reqwest::Client::new();
        assert_eq!(
            client
                .get(format!("{base}/api/settings"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let snapshot: Value = client
            .get(format!("{base}/api/settings"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let before = std::fs::read(&file).unwrap();
        let rejected = client
            .post(format!("{base}/api/settings"))
            .bearer_auth("test-token")
            .json(&json!({"revision":snapshot["revision"],"raw":"{\"port\":99999}"}))
            .send()
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert_eq!(std::fs::read(&file).unwrap(), before);
        let saved: Value = client
            .post(format!("{base}/api/settings"))
            .bearer_auth("test-token")
            .json(&json!({"revision":snapshot["revision"],"changes":{"debug":true}}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(saved["document"]["debug"], true);
        let stale = client
            .post(format!("{base}/api/settings"))
            .bearer_auth("test-token")
            .json(&json!({"revision":snapshot["revision"],"changes":{"debug":false}}))
            .send()
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        server.abort();
    }
}
