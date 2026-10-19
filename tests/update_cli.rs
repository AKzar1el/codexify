use std::fs;
use std::process::Command;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_codexify")
}

#[test]
fn update_is_a_public_command_with_its_own_help() {
    let help = Command::new(binary()).arg("--help").output().unwrap();
    assert!(help.status.success());
    let text = String::from_utf8(help.stdout).unwrap();
    assert!(
        text.lines()
            .any(|line| line.trim_start().starts_with("update "))
    );
    let help = Command::new(binary())
        .args(["update", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    let text = String::from_utf8(help.stdout).unwrap();
    assert!(text.contains("Download and verify"), "{text}");
    assert!(text.contains("running background service"), "{text}");
}

#[test]
fn update_from_a_source_build_cannot_replace_another_installation() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let install = home.join(".codexify/bin");
    fs::create_dir_all(&install).unwrap();
    let target = install.join(format!("codexify{}", std::env::consts::EXE_SUFFIX));
    let original = b"unrelated installed executable fixture";
    fs::write(&target, original).unwrap();
    let config = home.join(".codexify/codexify.config.json");
    let document = serde_json::json!({
        "workDir":root.path(),
        "openaiTunnel":{"tunnelId":"tunnel_0123456789abcdef0123456789abcdef","apiKeyRef":"env:CODEXIFY_UPDATE_TEST_SECRET_MUST_NOT_BE_NEEDED"},
        "codexMcp":{"enabled":false,"useCli":false},
        "worktrees":{"root":root.path().join("worktrees"),"autoCleanupEnabled":false},
        "agentChat":{"enabled":false,"automation":{"enabled":false}}
    })
    .to_string();
    fs::write(&config, &document).unwrap();
    let result = Command::new(binary())
        .arg("update")
        .current_dir(root.path())
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env_remove("CODEXIFY_CONFIG")
        .env_remove("CODEXIFY_UPDATE_TEST_SECRET_MUST_NOT_BE_NEEDED")
        .output()
        .unwrap();
    assert!(!result.status.success());
    let error = String::from_utf8_lossy(&result.stderr);
    assert!(
        error.contains("refuses to replace a different installation"),
        "{error}"
    );
    assert_eq!(fs::read(&target).unwrap(), original);
    assert_eq!(fs::read_to_string(config).unwrap(), document);
    assert!(!home.join(".codexify/update").exists());
    assert!(!root.path().join("worktrees").exists());
}
