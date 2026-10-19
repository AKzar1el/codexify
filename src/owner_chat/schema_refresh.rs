//! Durable trailing debounce. Hints refresh live; structural changes wait for restart.
use super::*;

pub(super) async fn queue(config: Arc<AppConfig>, saved: &Value) -> Result<(), String> {
    let restart = saved["schemaRestartRequired"] == true;
    tokio::task::spawn_blocking(move || {
        let now = crate::markdown_chat::now_ms();
        let revision = crate::global_settings::schema_revision(&config)?;
        let previous=crate::global_settings::read_schema_intent(&config).unwrap_or(Value::Null);
        // A subsequent hint edit must not bypass an unapplied structural edit.
        let restart=restart || (previous["requiresRestart"]==true && previous["originPid"]==std::process::id() && !matches!(previous["phase"].as_str(),Some("completed"|"cancelled")));
        crate::global_settings::write_schema_intent(&config, &json!({
            "refreshId":format!("settings-{now}-{revision}"),"source":"settings",
            "phase":if restart {"waiting_for_restart"} else {"queued"},
            "requiresRestart":restart,"originPid":std::process::id(),
            "dueAtMs":now+10_000,"revision":revision,"observedRevision":previous["observedRevision"],"observedStructuralRevision":previous["observedStructuralRevision"]
        }))
    }).await.map_err(|e|e.to_string())?
}
async fn set_phase(
    config: &Arc<AppConfig>,
    intent: &mut Value,
    phase: &str,
    result: Option<Value>,
) {
    intent["phase"] = json!(phase);
    if let Some(result) = result {
        intent["result"] = result;
    }
    let config = config.clone();
    let intent = intent.clone();
    let _ = tokio::task::spawn_blocking(move || {
        crate::global_settings::update_schema_intent(
            &config,
            intent["refreshId"].as_str().unwrap_or(""),
            &intent,
        )
    })
    .await;
}
pub(crate) fn start(config: Arc<AppConfig>) {
    if config.loaded_config_path.is_none() {
        return;
    }
    tokio::spawn(async move {
        let reader = config.clone();
        let Ok(Ok((initial, active_structural))) =
            tokio::task::spawn_blocking(move || crate::global_settings::schema_versions(&reader))
                .await
        else {
            return;
        };
        if crate::global_settings::read_schema_intent(&config).is_none() {
            let _ = crate::global_settings::write_schema_intent(
                &config,
                &json!({"phase":"idle","source":"settings","observedRevision":initial,"observedStructuralRevision":active_structural}),
            );
        }
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let reader = config.clone();
            let Some(mut intent) = tokio::task::spawn_blocking(move || {
                crate::global_settings::read_schema_intent(&reader)
            })
            .await
            .ok()
            .flatten() else {
                continue;
            };
            let reader = config.clone();
            let Ok(Ok((current, current_structural))) = tokio::task::spawn_blocking(move || {
                crate::global_settings::schema_versions(&reader)
            })
            .await
            else {
                continue;
            };
            if intent["observedRevision"].is_null() {
                intent["observedRevision"] = json!(initial);
                intent["observedStructuralRevision"] = json!(active_structural);
                let _ = crate::global_settings::update_schema_intent(
                    &config,
                    intent["refreshId"].as_str().unwrap_or(""),
                    &intent,
                );
            }
            if intent["observedRevision"] != current && intent["revision"] != current {
                let _ = queue(
                    config.clone(),
                    &json!({"schemaRestartRequired":current_structural!=active_structural}),
                )
                .await;
                continue;
            }
            if !matches!(
                intent["phase"].as_str(),
                Some("queued" | "waiting_for_restart" | "starting_browser" | "running")
            ) || intent["dueAtMs"].as_u64().unwrap_or(u64::MAX) > crate::markdown_chat::now_ms()
            {
                continue;
            }
            if intent["requiresRestart"] == true && intent["originPid"] == std::process::id() {
                continue;
            }
            if intent["phase"] == "waiting_for_restart" {
                intent["requiresRestart"] = json!(false);
                set_phase(&config, &mut intent, "queued", None).await;
            }
            {
                let health = async {
                    reqwest::Client::new()
                        .get(format!("http://127.0.0.1:{}/health", config.port))
                        .timeout(Duration::from_secs(2))
                        .send()
                        .await?
                        .json::<Value>()
                        .await
                }
                .await;
                if !health.is_ok_and(|h| {
                    h["status"] == "ok" && h["tunnelsReady"] == h["tunnelsConfigured"]
                }) {
                    continue;
                }
            }
            let reader = config.clone();
            let revision = tokio::task::spawn_blocking(move || {
                crate::global_settings::schema_revision(&reader)
            })
            .await
            .ok()
            .and_then(Result::ok);
            if revision.as_deref() != intent["revision"].as_str() {
                set_phase(&config, &mut intent, "cancelled", None).await;
                continue;
            }
            if !config.markdown_chat.automation.enabled {
                set_phase(&config,&mut intent,"failed",Some(json!({"error":"Browser automation is disabled. Refresh tools in ChatGPT."}))).await;
                continue;
            }
            if crate::agent_automation::BrowserCompanionControl::new(
                &config.markdown_chat.automation,
            )
            .is_ok_and(|control| control.public_status()["manuallyStopped"] == true)
            {
                continue;
            }
            set_phase(&config, &mut intent, "starting_browser", None).await;
            let client = match refresh_client(&config).await {
                Ok(client) => client,
                Err(error) => {
                    set_phase(&config, &mut intent, "failed", Some(json!({"error":error}))).await;
                    continue;
                }
            };
            set_phase(&config, &mut intent, "running", None).await;
            match client
                .refresh_connector(
                    &config.markdown_chat.automation.connector_name,
                    &CancellationToken::new(),
                )
                .await
            {
                Ok(result) => {
                    intent["observedRevision"] = json!(current);
                    intent["observedStructuralRevision"] = json!(current_structural);
                    set_phase(&config, &mut intent, "completed", Some(result)).await;
                }
                Err(error) if error.contains("423") => {
                    intent["dueAtMs"] = json!(crate::markdown_chat::now_ms() + 5000);
                    set_phase(&config, &mut intent, "queued", None).await;
                }
                Err(error) => {
                    set_phase(&config, &mut intent, "failed", Some(json!({"error":error}))).await
                }
            }
        }
    });
}

pub(super) async fn refresh_client(
    config: &AppConfig,
) -> Result<crate::agent_automation::BrowserCompanionClient, String> {
    crate::agent_automation::BrowserCompanionControl::new(&config.markdown_chat.automation)?
        .ensure_running(&CancellationToken::new())
        .await
}
