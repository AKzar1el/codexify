#[tokio::test]
async fn renewal_control_reaches_real_mcp_results_without_queue_or_progress_dependency() {
    use crate::agent_automation::turn_renewal::TurnSend;
    use crate::agent_automation::{
        AgentAutomationStore, AutomationActionKind, AutomationActionStatus,
    };
    let root = tempfile::tempdir().unwrap();
    let mut config = crate::config::default_config(root.path().to_owned());
    config.memory.dir = Some(root.path().join("state").display().to_string());
    config.markdown_chat.enabled = true;
    config.markdown_chat.automation.enabled = true;
    config.markdown_chat.turn_renewal.enabled = true;
    config.markdown_chat.rollout_enabled = false;
    let mut handler = handler_with_tools(
        root.path(),
        crate::registry::load_tools_for_config(&config),
        crate::types::ToolLogLevel::Info,
    );
    handler.config = Arc::new(config.clone());
    let identity = ConversationIdentity::from_openai_session("mcp-renewal").unwrap();
    let store = AgentAutomationStore::for_config(&config).unwrap();
    let now = crate::markdown_chat::now_ms();
    let pair = store
        .issue_pairing(&identity, "https://chatgpt.com/c/mcp-renewal", 0, now)
        .unwrap();
    store
        .record_pairing_canonical_url(
            &identity,
            pair.generation,
            "https://chatgpt.com/c/mcp-renewal",
            now,
        )
        .unwrap();
    store
        .verify_pairing(&identity, pair.generation, 0, &pair.reference, now)
        .unwrap();
    store
        .queue_action(
            &identity,
            "expired-send",
            AutomationActionKind::OfflineChat,
            pair.generation,
            None,
            now,
        )
        .unwrap();
    store
        .record_turn_send(
            &identity,
            TurnSend {
                action_id: "expired-send".into(),
                at_ms: now - 55 * 60_000,
                model: Some("gpt-6-astra".into()),
                effort: Some("max".into()),
                pairing_generation: pair.generation,
                owner_generation: 0,
            },
        )
        .unwrap();
    store
        .update_action_status(
            &identity,
            "expired-send",
            AutomationActionStatus::Idle,
            None,
            None,
            now,
        )
        .unwrap();
    store.turn_renewal_notice(&identity, now).unwrap();
    let chat = handler
        .markdown_chat
        .chat(&config, Some(&identity), &handler.session)
        .unwrap();
    chat.queue_user_message(
        "secret-queue".into(),
        "Do not expose this queued message".into(),
        vec![],
    )
    .await
    .unwrap();
    let (server_transport, client_transport) = tokio::io::duplex(128 * 1024);
    let server = tokio::spawn(async move {
        handler
            .serve(server_transport)
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap()
    });
    let client = ().serve(client_transport).await.unwrap();
    for tool in [
        "rollout_read",
        "chat_await",
        "turn_completed",
        "get_agent_brief",
    ] {
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            client.call_tool(automation_request(tool, json!({}), "mcp-renewal")),
        )
        .await
        .expect("handoff must not wait for user input")
        .unwrap();
        assert_ne!(response.is_error, Some(true), "{tool}: {response:?}");
        let data = response
            .structured_content
            .as_ref()
            .expect("structured MCP result");
        assert!(
            data["turn_renewal_required"]
                .as_str()
                .unwrap()
                .contains("FINAL CHATGPT ASSISTANT ANSWER"),
            "{tool}: {data}"
        );
        assert!(
            data.get("rollout_checkpoint_required")
                .is_none_or(|v| v.is_null())
        );
        assert!(!format!("{response:?}").contains("Do not expose this queued message"));
        if tool == "rollout_read" {
            assert!(data["content"].as_str().unwrap().contains("disabled"));
        }
    }
    assert_eq!(chat.queued_messages().await.unwrap().len(), 1);
    assert!(chat.unread_snapshot().await.unwrap().messages.is_empty());
    client.cancel().await.unwrap();
    server.await.unwrap();
}
