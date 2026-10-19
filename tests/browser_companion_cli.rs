use std::process::Command;

use serde_json::{Value, json};

fn write_config(root: &tempfile::TempDir, automation_enabled: bool) -> std::path::PathBuf {
    let project = root.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let config = root.path().join("codexify.config.json");
    std::fs::write(
        &config,
        serde_json::to_vec_pretty(&json!({
            "workDir": project,
            "agentChat": {
                "enabled": automation_enabled,
                "automation": {
                    "enabled": automation_enabled,
                    "descriptorPath": root.path().join("browser/descriptor.json"),
                    "connectorName": "Codexify",
                    "maxQueuedActions": 64,
                    "autoApproveToolCalls": false
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    config
}

#[test]
fn disabled_browser_status_is_machine_readable_private_and_side_effect_free() {
    let root = tempfile::tempdir().unwrap();
    let config = write_config(&root, false);
    let browser_home = root.path().join("browser");
    let output = Command::new(env!("CARGO_BIN_EXE_codexify"))
        .args(["browser", "status", "--json", "--config"])
        .arg(&config)
        .env("CODEXIFY_BROWSER_HOME", &browser_home)
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(4));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["state"], "disabled");
    assert_eq!(value["enabled"], false);
    assert_eq!(value["installed"], false);
    let rendered = String::from_utf8(output.stdout).unwrap();
    for secret_field in ["token", "endpoint", "accountFingerprint"] {
        assert!(!rendered.contains(secret_field));
    }
    assert!(!browser_home.exists());
}

#[test]
fn disabled_browser_install_refuses_before_downloading_or_creating_state() {
    let root = tempfile::tempdir().unwrap();
    let config = write_config(&root, false);
    let browser_home = root.path().join("browser");
    let output = Command::new(env!("CARGO_BIN_EXE_codexify"))
        .args(["browser", "install", "--config"])
        .arg(&config)
        .env("CODEXIFY_BROWSER_HOME", &browser_home)
        .env("CODEXIFY_BROWSER_RELEASE_ROOT", "http://127.0.0.1:1")
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("disabled"));
    assert!(!browser_home.exists());
}

#[test]
fn browser_status_does_not_persist_config_schema_migrations() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let config = root.path().join("codexify.config.json");
    let original = serde_json::to_vec_pretty(&json!({
        "workDir": project,
        "codexMcp": {"enabled": false},
        "markdownChat": {"enabled": true}
    }))
    .unwrap();
    std::fs::write(&config, &original).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_codexify"))
        .args(["browser", "status", "--json", "--config"])
        .arg(&config)
        .env("CODEXIFY_BROWSER_HOME", root.path().join("browser"))
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(4));
    assert_eq!(std::fs::read(&config).unwrap(), original);
    assert!(
        !config
            .with_file_name("codexify.config.json.before-schema-v1.bak")
            .exists()
    );
}

#[test]
fn maintenance_stop_preserves_the_automatic_start_preference_and_config() {
    for automatic_start in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let config = write_config(&root, true);
        let mut document: Value = serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
        document["codexMcp"] = json!({"enabled":false});
        let original = serde_json::to_vec_pretty(&document).unwrap();
        std::fs::write(&config, &original).unwrap();
        let browser = root.path().join("browser");
        std::fs::create_dir(&browser).unwrap();
        let lifecycle = browser.join("lifecycle.json");
        std::fs::write(&lifecycle, json!({"version":1,"automaticStart":automatic_start,"restartFromPid":null,"changedAtMs":1}).to_string()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&browser, std::fs::Permissions::from_mode(0o700)).unwrap();
            std::fs::set_permissions(&lifecycle, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let output = Command::new(env!("CARGO_BIN_EXE_codexify"))
            .args(["browser", "stop-for-restart", "--config"])
            .arg(&config)
            .env("CODEXIFY_BROWSER_HOME", &browser)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let desired: Value = serde_json::from_slice(&std::fs::read(&lifecycle).unwrap()).unwrap();
        assert_eq!(desired["automaticStart"], automatic_start);
        assert_ne!(
            desired["restartFromPid"].as_u64(),
            Some(u64::from(std::process::id()))
        );
        assert!(desired["restartFromPid"].as_u64().is_some());
        assert_eq!(
            std::fs::read(&config).unwrap(),
            original,
            "maintenance must not rewrite the service configuration"
        );
        let stopped = Command::new(env!("CARGO_BIN_EXE_codexify"))
            .args(["browser", "stop", "--config"])
            .arg(&config)
            .env("CODEXIFY_BROWSER_HOME", &browser)
            .output()
            .unwrap();
        assert!(
            stopped.status.success(),
            "{}",
            String::from_utf8_lossy(&stopped.stderr)
        );
        let desired: Value = serde_json::from_slice(&std::fs::read(&lifecycle).unwrap()).unwrap();
        assert_eq!(
            desired["automaticStart"], false,
            "an explicit browser stop is still persistent"
        );
        assert!(desired["restartFromPid"].is_null());
    }
}
