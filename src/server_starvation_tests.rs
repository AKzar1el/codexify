struct ReadDuringPoll;
#[async_trait]
impl Tool for ReadDuringPoll {
    fn name(&self) -> &'static str {
        "read_during_poll"
    }
    fn title(&self) -> String {
        "Read during poll".into()
    }
    fn description(&self) -> String {
        "Read-only dispatch regression probe.".into()
    }
    fn behavior(&self) -> crate::tool::ToolBehavior {
        crate::tool::ToolBehavior::new(true, false, true, false, "Reads test state.")
    }
    fn input_schema(&self) -> Value {
        crate::tool::empty_object_schema()
    }
    fn output_schema(&self) -> Option<Value> {
        Some(crate::tool::text_output_schema())
    }
    async fn call(&self, _: Value, _: &AppConfig, _: &SessionState) -> ToolResult {
        ToolResult::text("read completed")
    }
}

#[cfg(unix)]
#[tokio::test]
async fn command_polling_does_not_block_reads_through_real_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let handler = handler_with_tools(
        root.path(),
        vec![
            Box::new(crate::tools::exec_command::ExecCommand),
            Box::new(crate::tools::write_stdin::WriteStdin),
            Box::new(ReadDuringPoll),
        ],
        crate::types::ToolLogLevel::Info,
    );
    bind_fixture_workspace(&handler, None).await;
    let (server, client_transport) = tokio::io::duplex(128 * 1024);
    let task = tokio::spawn(async move {
        handler
            .serve(server)
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap()
    });
    let client = ().serve(client_transport).await.unwrap();
    let request = |name: &str, args: Value| {
        CallToolRequestParams::new(name.to_owned())
            .with_arguments(args.as_object().unwrap().clone())
    };
    let started = client
        .call_tool(request(
            "exec_command",
            json!({"cmd":"sleep 1; printf done","shell":"/bin/sh","yield_time_ms":50}),
        ))
        .await
        .unwrap();
    assert_ne!(started.is_error, Some(true), "{started:?}");
    let id = started
        .structured_content
        .as_ref()
        .and_then(|v| {
            v["session_id"]
                .as_u64()
                .or_else(|| v["upstream_result"]["session_id"].as_u64())
        })
        .unwrap_or_else(|| panic!("{started:?}"));
    let peer = client.peer().clone();
    let poll = tokio::spawn(async move {
        peer.call_tool(
            CallToolRequestParams::new("write_stdin").with_arguments(
                json!({"session_id":id,"yield_time_ms":60000})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap()
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!poll.is_finished());
    let read = tokio::time::timeout(
        Duration::from_millis(500),
        client.call_tool(request("read_during_poll", json!({}))),
    )
    .await
    .expect("read waited for the command poll")
    .unwrap();
    assert_ne!(read.is_error, Some(true), "{read:?}");
    assert!(!poll.is_finished());
    tokio::time::timeout(Duration::from_secs(2), poll)
        .await
        .unwrap()
        .unwrap();
    drop(client);
    task.abort();
}
