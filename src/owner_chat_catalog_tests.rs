#[tokio::test]
async fn unreadable_automation_is_local_to_one_chat_and_preserves_the_record() {
    use super::*;
    let root = tempfile::tempdir().unwrap();
    let mut config = crate::config::default_config(root.path().into());
    config.memory.dir = Some(root.path().join("state").display().to_string());
    config.markdown_chat.enabled = true;
    let chats = Arc::new(MarkdownChatStore::default());
    for name in ["healthy", "bad"] {
        let task = ConversationIdentity::from_openai_session(name).unwrap();
        let chat = chats
            .chat(&config, Some(&task), &SessionState::new())
            .unwrap();
        chat.ensure().await.unwrap();
        chat.set_owner_title(name.into()).await.unwrap();
    }
    let bad_task = ConversationIdentity::from_openai_session("bad").unwrap();
    let bad = chats
        .chat(&config, Some(&bad_task), &SessionState::new())
        .unwrap();
    let path = bad.path().with_file_name("automation.json");
    AgentAutomationStore::for_config(&config)
        .unwrap()
        .set_goal(
            &bad_task,
            "Preserve saved state",
            crate::markdown_chat::now_ms(),
        )
        .unwrap();
    let state = OwnerState {
        project_bindings: Arc::new(crate::project_bindings::ProjectBindingStore::new(
            root.path().join("bindings"),
        )),
        creation_lock: Arc::default(),
        artifacts: Arc::new(ArtifactEgressStore::new_at(
            config.artifact_egress.clone(),
            root.path().join("artifacts"),
        )),
        continuations: Arc::new(
            ConversationContinuationStore::new(root.path().join("continuations.json")).unwrap(),
        ),
        config: Arc::new(config),
        chats,
        automation: None,
        open_browser: Arc::new(|_| Ok(())),
        catalog_cache: Arc::default(),
        global: Arc::default(),
        token: "fixture-token".into(),
    };
    for (bytes, expected) in [
        (
            r#"{"pairing":{"canonicalUrl":"https://chatgpt.com/c/preserve-this"},"futureExtension":{"value":true}}"#,
            "schema",
        ),
        ("{broken", "malformed JSON"),
    ] {
        std::fs::write(&path, bytes).unwrap();
        let Json(list) = list_chats(State(state.clone()), Query(ListQuery { q: None }))
            .await
            .expect("one unreadable record must not fail the list");
        let rows = list["chats"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter().find(|r| r["title"] == "healthy").unwrap()["automationError"].is_null()
        );
        let bad = rows.iter().find(|r| r["title"] == "bad").unwrap();
        assert!(bad["automationError"].as_str().unwrap().contains(expected));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            bytes,
            "listing must not discard a saved pairing or repair unknown fields by overwriting them"
        );
    }
}
