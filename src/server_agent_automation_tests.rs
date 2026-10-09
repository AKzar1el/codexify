fn automation_request(
    name: &str,
    arguments: Value,
    conversation: &str,
) -> CallToolRequestParams {
    let mut request = CallToolRequestParams::new(name.to_owned())
        .with_arguments(arguments.as_object().unwrap().clone());
    request.meta = Some(
        serde_json::from_value(json!({"openai/session":conversation})).unwrap(),
    );
    request
}

struct ServerAutomationNoopExecutor;

#[async_trait::async_trait]
impl crate::agent_automation::AutomationExecutor for ServerAutomationNoopExecutor {
    async fn execute(
        &self,
        _execution: crate::agent_automation::AutomationExecution,
        _events: tokio::sync::mpsc::UnboundedSender<crate::agent_automation::CompanionEvent>,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<
        crate::agent_automation::CompanionActionSnapshot,
        crate::agent_automation::AutomationExecutionError,
    > {
        panic!("an online server call must not execute browser automation")
    }
}

#[tokio::test]
async fn pairing_verification_respects_setup_and_receives_the_owner_generation() {
    let root = tempfile::tempdir().unwrap();
    let mut config = crate::config::default_config(root.path().to_path_buf());
    config.memory.dir = Some(root.path().join("metadata").display().to_string());
    config.markdown_chat.enabled = true;
    config.markdown_chat.automation.enabled = true;
    config.conversation_auth_token = Some("a".repeat(64).into());
    let mut handler = handler_with_tools(
        root.path(),
        crate::registry::load_tools_for_config(&config),
        crate::types::ToolLogLevel::Info,
    );
    handler.config = Arc::new(config.clone());
    let authorizations = handler.conversation_authorizations.clone();
    let conversation = "automation-pair-owner";
    let identity = ConversationIdentity::from_openai_session(conversation).unwrap();
    let store = crate::agent_automation::AgentAutomationStore::for_config(&config).unwrap();
    let issued = store
        .issue_pairing(
            &identity,
            "https://chatgpt.com/c/server-pairing",
            0,
            crate::markdown_chat::now_ms(),
        )
        .unwrap();
    store
        .record_pairing_canonical_url(
            &identity,
            issued.generation,
            "https://chatgpt.com/c/server-pairing",
            crate::markdown_chat::now_ms(),
        )
        .unwrap();

    let (server_transport, client_transport) = tokio::io::duplex(32 * 1024);
    let task = tokio::spawn(async move {
        handler
            .serve(server_transport)
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap()
    });
    let client = ().serve(client_transport).await.unwrap();

    let unauthorized = client
        .call_tool(automation_request(
            "automation_verify_pairing",
            json!({"reference":issued.reference}),
            conversation,
        ))
        .await
        .unwrap();
    assert_eq!(unauthorized.is_error, Some(true));
    assert!(
        unauthorized
            .content
            .iter()
            .any(|content| format!("{content:?}").contains("setup"))
    );
    assert!(store.load(&identity).unwrap().pairing.pending.is_some());

    authorizations
        .authorize(Some(&identity), &SessionState::new())
        .unwrap();
    let verified = client
        .call_tool(automation_request(
            "automation_verify_pairing",
            json!({"reference":issued.reference}),
            conversation,
        ))
        .await
        .unwrap();
    assert_ne!(verified.is_error, Some(true));
    let structured = verified.structured_content.as_ref().unwrap();
    assert_eq!(structured["verified"], true);
    assert_eq!(structured["pairingGeneration"], issued.generation);
    assert_eq!(
        store
            .load(&identity)
            .unwrap()
            .pairing
            .verified_owner_generation,
        Some(0)
    );

    client.cancel().await.unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn model_visible_calls_register_the_stable_task_with_the_shared_supervisor() {
    let root = tempfile::tempdir().unwrap();
    let mut config = crate::config::default_config(root.path().to_path_buf());
    config.memory.dir = Some(root.path().join("metadata").display().to_string());
    config.markdown_chat.enabled = true;
    config.markdown_chat.automation.enabled = true;
    let mut handler = handler_with_tools(
        root.path(),
        crate::registry::load_tools_for_config(&config),
        crate::types::ToolLogLevel::Info,
    );
    handler.config = Arc::new(config.clone());
    let supervisor = crate::agent_automation::AgentAutomationSupervisor::new(
        config.markdown_chat.automation.clone(),
        Arc::new(ServerAutomationNoopExecutor),
    );
    handler.agent_automation = Some(supervisor.clone());
    let conversation = "automation-registration-owner";
    let identity = ConversationIdentity::from_openai_session(conversation).unwrap();
    let chat = handler
        .markdown_chat
        .chat(&config, Some(&identity), &handler.session)
        .unwrap();

    let (server_transport, client_transport) = tokio::io::duplex(32 * 1024);
    let task = tokio::spawn(async move {
        handler
            .serve(server_transport)
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap()
    });
    let client = ().serve(client_transport).await.unwrap();

    let result = client
        .call_tool(automation_request(
            "clock_curr_time",
            json!({}),
            conversation,
        ))
        .await
        .unwrap();

    assert_ne!(result.is_error, Some(true));
    assert_eq!(supervisor.registered_count().await, 1);
    assert!(
        chat.owner_summary()
            .await
            .unwrap()
            .last_agent_call_at_ms
            .is_some()
    );
    client.cancel().await.unwrap();
    task.await.unwrap();
}
