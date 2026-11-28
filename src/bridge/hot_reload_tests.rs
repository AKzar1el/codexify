//! Isolated, real HTTP MCP fault-injection coverage for per-source reload.
use super::*;
use axum::Router;
use rmcp::{
    ErrorData as McpError, ServerHandler,
    model::{
        CallToolResponse, Implementation, InitializeResult, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerInfo,
    },
    service::{RequestContext, RoleServer},
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone)]
struct Fixture {
    version: &'static str,
    new_tool: bool,
    list_delay: Duration,
    call_delay: Duration,
    started: Arc<AtomicUsize>,
}

impl ServerHandler for Fixture {
    fn get_info(&self) -> ServerInfo {
        InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("hot-reload-fixture", self.version))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        tokio::time::sleep(self.list_delay).await;
        let schema = serde_json::json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        })
        .as_object()
        .cloned()
        .unwrap();
        let mut tools = vec![
            rmcp::model::Tool::new("probe", "Report this fixture's version", schema.clone()),
            rmcp::model::Tool::new(
                "slow",
                "Report this fixture's version after a delay",
                schema.clone(),
            ),
        ];
        if self.new_tool {
            tools.push(rmcp::model::Tool::new(
                "new_tool",
                "Added in version two",
                schema,
            ));
        }
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        self.started.fetch_add(1, Ordering::SeqCst);
        if request.name.as_ref() == "slow" {
            tokio::time::sleep(self.call_delay).await;
        }
        Ok(CallToolResult::success(vec![ContentBlock::text(self.version)]).into())
    }
}

async fn fixture(
    version: &'static str,
    new_tool: bool,
    list_delay: Duration,
    call_delay: Duration,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let fixture = Fixture {
        version,
        new_tool,
        list_delay,
        call_delay,
        started: calls.clone(),
    };
    let mut transport = StreamableHttpServerConfig::default();
    transport.json_response = true;
    let service = StreamableHttpService::new(
        move || Ok(fixture.clone()),
        Arc::new(LocalSessionManager::default()),
        transport,
    );
    let app = Router::new().nest_service("/mcp", service);
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}/mcp"), calls, task)
}

fn spec(url: &str, exposure: McpToolExposure) -> crate::types::McpServerSpec {
    crate::types::McpServerSpec {
        url: Some(url.to_string()),
        mode: Some(exposure),
        ..Default::default()
    }
}

async fn invoke(view: Arc<hot_reload::BridgeView>, name: &str) -> ToolResult {
    invoke_args(view, name, json!({})).await
}

async fn invoke_args(view: Arc<hot_reload::BridgeView>, name: &str, args: Value) -> ToolResult {
    let tool = view
        .tools
        .iter()
        .find(|tool| tool.name() == name)
        .unwrap_or_else(|| panic!("tool {name} missing from view"));
    tool.call(
        args,
        &crate::config::default_config(std::env::temp_dir()),
        &SessionState::new(),
    )
    .await
}

#[tokio::test]
async fn scoped_browser_reload_fails_closed_without_retiring_live_task_sessions() {
    let (url, _, task) = fixture("before", false, Duration::ZERO, Duration::ZERO).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    config
        .mcp_servers
        .insert("alpha".into(), spec(&url, McpToolExposure::Direct));
    let bridge = connect_upstreams(&config).await;
    let runtime = bridge.runtime.clone();
    let before = runtime.snapshot();
    let mut scoped = spec(&url, McpToolExposure::Direct);
    scoped.session_scope = McpSessionScope::PerChat;
    let error = runtime
        .reload_with_spec("alpha", scoped, None)
        .await
        .unwrap_err();
    assert_eq!(error, "SCOPED_BROWSER_RELOAD_REQUIRES_QUIESCENCE");
    let after = runtime.snapshot();
    assert!(Arc::ptr_eq(
        &before.sources["alpha"],
        &after.sources["alpha"]
    ));
    assert_eq!(invoke(after, "alpha__probe").await.joined_text(), "before");
    task.abort();
}

#[tokio::test]
async fn single_source_reload_updates_tools_but_not_other_mcp() {
    let (old_url, _, old_task) = fixture("1", false, Duration::ZERO, Duration::ZERO).await;
    let (new_url, _, new_task) = fixture("2", true, Duration::ZERO, Duration::ZERO).await;
    let (other_url, _, other_task) = fixture("other", false, Duration::ZERO, Duration::ZERO).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    config
        .mcp_servers
        .insert("alpha".into(), spec(&old_url, McpToolExposure::Direct));
    config
        .mcp_servers
        .insert("beta".into(), spec(&other_url, McpToolExposure::Direct));
    let bridge = connect_upstreams(&config).await;
    let runtime = bridge.runtime.clone();
    let before = runtime.snapshot();
    assert_eq!(
        invoke(before.clone(), "alpha__probe").await.joined_text(),
        "1"
    );
    assert_eq!(
        invoke(before.clone(), "beta__probe").await.joined_text(),
        "other"
    );

    let result = runtime
        .reload_with_spec("alpha", spec(&new_url, McpToolExposure::Direct), None)
        .await
        .unwrap();
    assert_eq!(result["outcome"], "reloaded");
    assert_eq!(result["previousGeneration"], 1);
    assert_eq!(result["replacementGeneration"], 2);
    assert_eq!(result["previousVersion"], "1");
    assert_eq!(result["replacementVersion"], "2");
    assert_eq!(result["toolChanges"]["added"], 1);
    assert_eq!(result["oldCallsDrained"], true);

    let after = runtime.snapshot();
    assert!(Arc::ptr_eq(&before.sources["beta"], &after.sources["beta"]));
    assert!(!Arc::ptr_eq(
        &before.sources["alpha"],
        &after.sources["alpha"]
    ));
    assert_eq!(
        invoke(after.clone(), "alpha__probe").await.joined_text(),
        "2"
    );
    assert_eq!(
        invoke(after.clone(), "alpha__new_tool").await.joined_text(),
        "2"
    );
    assert_eq!(invoke(after, "beta__probe").await.joined_text(), "other");
    assert_eq!(invoke(before, "alpha__probe").await.joined_text(), "1");
    old_task.abort();
    new_task.abort();
    other_task.abort();
}

#[tokio::test]
async fn active_calls_keep_their_original_generation_without_replay() {
    let (old_url, old_count, old_task) =
        fixture("1", false, Duration::ZERO, Duration::from_millis(450)).await;
    let (new_url, new_count, new_task) = fixture("2", true, Duration::ZERO, Duration::ZERO).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    config
        .mcp_servers
        .insert("alpha".into(), spec(&old_url, McpToolExposure::Direct));
    let runtime = connect_upstreams(&config).await.runtime;
    let initial = runtime.snapshot();
    let pending = tokio::spawn(invoke(initial, "alpha__slow"));
    tokio::time::timeout(Duration::from_secs(2), async {
        while old_count.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let started = std::time::Instant::now();
    let result = runtime
        .reload_with_spec("alpha", spec(&new_url, McpToolExposure::Direct), None)
        .await
        .unwrap();
    assert_eq!(result["oldCallsDrained"], true);
    assert!(started.elapsed() >= Duration::from_millis(100));
    assert_eq!(pending.await.unwrap().joined_text(), "1");
    assert_eq!(old_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        invoke(runtime.snapshot(), "alpha__probe")
            .await
            .joined_text(),
        "2"
    );
    assert_eq!(new_count.load(Ordering::SeqCst), 1);
    old_task.abort();
    new_task.abort();
}

#[tokio::test]
async fn failed_replacement_and_unknown_ids_cannot_mutate_active_generation() {
    let (old_url, _, old_task) = fixture("1", false, Duration::ZERO, Duration::ZERO).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    config
        .mcp_servers
        .insert("alpha".into(), spec(&old_url, McpToolExposure::Direct));
    let runtime = connect_upstreams(&config).await.runtime;
    let old = runtime.snapshot();

    assert_eq!(
        runtime
            .reload_with_spec(
                "missing",
                spec("http://127.0.0.1:9/mcp", McpToolExposure::Direct),
                None
            )
            .await
            .unwrap_err(),
        "SOURCE_UNKNOWN"
    );
    assert_eq!(
        runtime
            .reload_with_spec(
                "alpha",
                spec("http://127.0.0.1:9/mcp", McpToolExposure::Direct),
                None
            )
            .await
            .unwrap_err(),
        "INITIALIZE_FAILED"
    );
    let after = runtime.snapshot();
    assert!(Arc::ptr_eq(&old, &after));
    assert_eq!(invoke(after, "alpha__probe").await.joined_text(), "1");
    old_task.abort();
}

#[tokio::test]
async fn same_source_reload_conflicts_while_other_source_can_reload() {
    let (a1, _, first_task) = fixture("1", false, Duration::ZERO, Duration::ZERO).await;
    let (a2, _, second_task) = fixture("2", true, Duration::from_millis(300), Duration::ZERO).await;
    let (b1, _, third_task) = fixture("other1", false, Duration::ZERO, Duration::ZERO).await;
    let (b2, _, fourth_task) = fixture("other2", false, Duration::ZERO, Duration::ZERO).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    config
        .mcp_servers
        .insert("alpha".into(), spec(&a1, McpToolExposure::Direct));
    config
        .mcp_servers
        .insert("beta".into(), spec(&b1, McpToolExposure::Direct));
    let runtime = connect_upstreams(&config).await.runtime;
    let clone = runtime.clone();
    let initial = tokio::spawn(async move {
        clone
            .reload_with_spec("alpha", spec(&a2, McpToolExposure::Direct), None)
            .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        runtime
            .reload_with_spec("alpha", spec(&a1, McpToolExposure::Direct), None)
            .await
            .unwrap_err(),
        "RELOAD_IN_PROGRESS"
    );
    let other = runtime
        .reload_with_spec("beta", spec(&b2, McpToolExposure::Direct), None)
        .await
        .unwrap();
    assert_eq!(other["replacementGeneration"], 2);
    assert_eq!(initial.await.unwrap().unwrap()["replacementGeneration"], 2);
    let view = runtime.snapshot();
    assert_eq!(
        invoke(view.clone(), "alpha__probe").await.joined_text(),
        "2"
    );
    assert_eq!(invoke(view, "beta__probe").await.joined_text(), "other2");
    first_task.abort();
    second_task.abort();
    third_task.abort();
    fourth_task.abort();
}

#[tokio::test]
async fn catalog_reload_refreshes_search_schema_and_call_routing() {
    let (old_url, _, old_task) = fixture("1", false, Duration::ZERO, Duration::ZERO).await;
    let (new_url, _, new_task) = fixture("2", true, Duration::ZERO, Duration::ZERO).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    config
        .mcp_servers
        .insert("catalog".into(), spec(&old_url, McpToolExposure::Catalog));
    let runtime = connect_upstreams(&config).await.runtime;
    let before = runtime.snapshot();
    let source = invoke(before, "mcp_list_sources")
        .await
        .structured_content
        .unwrap();
    assert_eq!(source["sources"][0]["toolCount"], 2);
    let result = runtime
        .reload_with_spec("catalog", spec(&new_url, McpToolExposure::Catalog), None)
        .await
        .unwrap();
    assert_eq!(result["toolChanges"]["added"], 1);
    let after = runtime.snapshot();
    let list = invoke(after.clone(), "mcp_list_sources")
        .await
        .structured_content
        .unwrap();
    assert_eq!(list["sources"][0]["toolCount"], 3);
    let source_id = list["sources"][0]["id"].as_str().unwrap();
    let found = invoke_args(
        after.clone(),
        "mcp_search_tools",
        json!({"query":"new_tool","source":source_id}),
    )
    .await
    .structured_content
    .unwrap();
    assert!(found["total"].as_u64().unwrap_or(0) >= 1);
    let tool_id = found["matches"][0]["toolId"].as_str().unwrap();
    let call = invoke_args(
        after,
        "mcp_call_tool",
        json!({"source":source_id,"tool":tool_id,"arguments":{}}),
    )
    .await;
    assert!(!call.is_error);
    assert_eq!(call.joined_text(), "2");
    old_task.abort();
    new_task.abort();
}

#[tokio::test]
async fn gateway_reload_reflects_added_functions() {
    let (old_url, _, old_task) = fixture("1", false, Duration::ZERO, Duration::ZERO).await;
    let (new_url, _, new_task) = fixture("2", true, Duration::ZERO, Duration::ZERO).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    config
        .mcp_servers
        .insert("gateway".into(), spec(&old_url, McpToolExposure::Gateway));
    let runtime = connect_upstreams(&config).await.runtime;
    let before = runtime.snapshot();
    let old = invoke_args(
        before,
        "gateway",
        json!({"function":"probe","arguments":{}}),
    )
    .await;
    assert_eq!(old.joined_text(), "1");
    runtime
        .reload_with_spec("gateway", spec(&new_url, McpToolExposure::Gateway), None)
        .await
        .unwrap();
    let after = runtime.snapshot();
    let tool = after
        .tools
        .iter()
        .find(|tool| tool.name() == "gateway")
        .unwrap();
    assert!(
        tool.input_schema()["properties"]["function"]["enum"]
            .as_array()
            .unwrap()
            .contains(&json!("new_tool"))
    );
    let new = invoke_args(
        after,
        "gateway",
        json!({"function":"new_tool","arguments":{}}),
    )
    .await;
    assert_eq!(new.joined_text(), "2");
    old_task.abort();
    new_task.abort();
}

#[tokio::test]
async fn reconnect_failed_initial_source_and_cancel_without_switching() {
    let (url, _, task) = fixture("recovered", false, Duration::ZERO, Duration::ZERO).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    config.mcp_servers.insert(
        "unavailable".into(),
        crate::types::McpServerSpec {
            url: Some("http://127.0.0.1:9/mcp".into()),
            startup_timeout_sec: Some(0.5),
            ..Default::default()
        },
    );
    let runtime = connect_upstreams(&config).await.runtime;
    assert!(!runtime.snapshot().sources.contains_key("unavailable"));
    let result = runtime
        .reload_with_spec("unavailable", spec(&url, McpToolExposure::Direct), None)
        .await
        .unwrap();
    assert_eq!(result["previousGeneration"], 0);
    assert_eq!(result["replacementGeneration"], 1);
    assert_eq!(
        invoke(runtime.snapshot(), "unavailable__probe")
            .await
            .joined_text(),
        "recovered"
    );

    let old = runtime.snapshot();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert_eq!(
        runtime
            .reload_with_spec(
                "unavailable",
                spec(&url, McpToolExposure::Direct),
                Some(&cancelled)
            )
            .await
            .unwrap_err(),
        "CANCELLED"
    );
    assert!(Arc::ptr_eq(&old, &runtime.snapshot()));
    task.abort();
}

#[tokio::test]
async fn repeated_reloads_keep_one_active_generation_per_source() {
    let (url, _, task) = fixture("stable", false, Duration::ZERO, Duration::ZERO).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    config
        .mcp_servers
        .insert("alpha".into(), spec(&url, McpToolExposure::Direct));
    let runtime = connect_upstreams(&config).await.runtime;
    for expected in 2..=6 {
        let result = runtime
            .reload_with_spec("alpha", spec(&url, McpToolExposure::Direct), None)
            .await
            .unwrap();
        assert_eq!(result["replacementGeneration"], expected);
        assert_eq!(result["oldCallsDrained"], true);
        let view = runtime.snapshot();
        assert_eq!(view.sources.len(), 1);
        assert_eq!(invoke(view, "alpha__probe").await.joined_text(), "stable");
    }
    task.abort();
}

#[tokio::test]
async fn direct_name_collisions_are_not_ambiguous_after_reload() {
    let (url1, _, task1) = fixture("one", false, Duration::ZERO, Duration::ZERO).await;
    let (url2, _, task2) = fixture("two", true, Duration::ZERO, Duration::ZERO).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    // sanitize("dup!")==sanitize("dup?"), so both would generate dup___probe.
    config
        .mcp_servers
        .insert("dup!".into(), spec(&url1, McpToolExposure::Direct));
    config
        .mcp_servers
        .insert("dup?".into(), spec(&url2, McpToolExposure::Direct));
    let runtime = connect_upstreams(&config).await.runtime;
    let view = runtime.snapshot();
    let names = view
        .tools
        .iter()
        .map(|tool| tool.name())
        .collect::<Vec<_>>();
    let unique = names
        .iter()
        .copied()
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(unique.len(), names.len());
    assert_eq!(
        names.iter().filter(|name| **name == "dup___probe").count(),
        1
    );
    task1.abort();
    task2.abort();
}

#[tokio::test]
async fn old_generation_is_released_after_draining_without_stale_snapshots() {
    let (old_url, _, old_task) = fixture("old", false, Duration::ZERO, Duration::ZERO).await;
    let (new_url, _, new_task) = fixture("new", true, Duration::ZERO, Duration::ZERO).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    config
        .mcp_servers
        .insert("alpha".into(), spec(&old_url, McpToolExposure::Direct));
    let bridge = connect_upstreams(&config).await;
    let runtime = bridge.runtime.clone();
    let first = runtime.snapshot();
    let weak = Arc::downgrade(&first.sources["alpha"]);
    drop(first);
    // The service keeps only the runtime after consuming the startup report.
    drop(bridge);
    assert!(weak.upgrade().is_some());

    let result = runtime
        .reload_with_spec("alpha", spec(&new_url, McpToolExposure::Direct), None)
        .await
        .unwrap();
    assert_eq!(result["oldCallsDrained"], true);
    assert!(
        weak.upgrade().is_none(),
        "retired service generation leaked"
    );
    assert_eq!(
        invoke(runtime.snapshot(), "alpha__probe")
            .await
            .joined_text(),
        "new"
    );
    old_task.abort();
    new_task.abort();
}

#[tokio::test]
async fn unrelated_in_flight_call_does_not_retain_a_retired_source() {
    let (a1, _, task_a1) = fixture("alpha-1", false, Duration::ZERO, Duration::ZERO).await;
    let (a2, _, task_a2) = fixture("alpha-2", false, Duration::ZERO, Duration::ZERO).await;
    let (b, b_calls, task_b) =
        fixture("beta", false, Duration::ZERO, Duration::from_millis(400)).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    config
        .mcp_servers
        .insert("alpha".into(), spec(&a1, McpToolExposure::Direct));
    config
        .mcp_servers
        .insert("beta".into(), spec(&b, McpToolExposure::Direct));
    let runtime = connect_upstreams(&config).await.runtime;
    let initial = runtime.snapshot();
    let alpha = Arc::downgrade(&initial.sources["alpha"]);
    // Copy only beta's validated descriptor, just as server dispatch does.
    let beta = initial
        .tools
        .iter()
        .find(|tool| tool.name() == "beta__slow")
        .unwrap()
        .clone();
    drop(initial);

    let pending = tokio::spawn(async move {
        beta.call(
            json!({}),
            &crate::config::default_config(std::env::temp_dir()),
            &SessionState::new(),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while b_calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();

    let result = runtime
        .reload_with_spec("alpha", spec(&a2, McpToolExposure::Direct), None)
        .await
        .unwrap();
    assert_eq!(result["oldCallsDrained"], true);
    assert!(
        alpha.upgrade().is_none(),
        "a beta request must not retain alpha's retired connection"
    );
    assert_eq!(pending.await.unwrap().joined_text(), "beta");
    assert_eq!(
        invoke(runtime.snapshot(), "alpha__probe")
            .await
            .joined_text(),
        "alpha-2"
    );
    task_a1.abort();
    task_a2.abort();
    task_b.abort();
}

fn isolated_stdio_spec(version: &str) -> crate::types::McpServerSpec {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("fixtures")
        .join("hot-reload-stdio-mcp.mjs");
    crate::types::McpServerSpec {
        command: Some("node".into()),
        args: vec![fixture.to_string_lossy().into_owned(), version.into()],
        mode: Some(McpToolExposure::Direct),
        startup_timeout_sec: Some(25.0),
        ..Default::default()
    }
}

fn stdio_process_id(result: ToolResult, expected_version: &str) -> u32 {
    assert!(
        !result.is_error,
        "stdio call failed: {}",
        result.joined_text()
    );
    let response = result.joined_text();
    let (version, pid) = response
        .trim()
        .split_once(':')
        .unwrap_or_else(|| panic!("invalid stdio fixture response: {response}"));
    assert_eq!(version, expected_version);
    pid.parse()
        .expect("stdio fixture process id must be numeric")
}

async fn stdio_process_still_alive(pid: u32) -> bool {
    // Signal 0 checks existence without terminating or signaling a process.
    tokio::process::Command::new("node")
        .arg("-e")
        .arg("try { process.kill(Number(process.argv[1]), 0); } catch { process.exit(1); }")
        .arg(pid.to_string())
        .status()
        .await
        .is_ok_and(|status| status.success())
}

#[tokio::test]
async fn distinct_task_owners_get_distinct_stdio_browser_peers_without_global_fallback() {
    // A real MCP stdio process is spawned once for tool discovery and once
    // for EACH owner. No user Chrome profile or network destination is used.
    let mut config = crate::config::default_config(std::env::temp_dir());
    let mut source_spec = isolated_stdio_spec("perchat");
    source_spec.session_scope = McpSessionScope::PerChat;
    config
        .mcp_servers
        .insert("playwright-ownership-fixture".into(), source_spec);
    let bridge = connect_upstreams(&config).await;
    let view = bridge.runtime.snapshot();
    let source = view
        .sources
        .get("playwright-ownership-fixture")
        .unwrap()
        .clone();
    assert!(source.control.scoped_playwright.is_some());

    let owner_a = ConversationIdentity::from_openai_session("isolated-fixture-owner-a")
        .expect("unique valid owner A");
    let owner_b = ConversationIdentity::from_openai_session("isolated-fixture-owner-b")
        .expect("unique valid owner B");

    async fn probe(
        source: &hot_reload::Generation,
        resources: &BridgedResourceStore,
        owner: Option<&ConversationIdentity>,
    ) -> ToolResult {
        forward_tool_call(
            &source.peer,
            CallToolRequestParams::new("probe"),
            "playwright-ownership-fixture",
            "probe",
            source.timeout,
            None,
            UpstreamCallContext {
                resources,
                control: &source.control,
                conversation: owner,
            },
        )
        .await
    }

    let denied = probe(&source, &bridge.resources, None).await;
    assert!(denied.is_error);
    assert!(
        denied
            .joined_text()
            .contains("refusing the shared global browser")
    );

    let a1 = stdio_process_id(
        probe(&source, &bridge.resources, Some(&owner_a)).await,
        "perchat",
    );
    let b1 = stdio_process_id(
        probe(&source, &bridge.resources, Some(&owner_b)).await,
        "perchat",
    );
    let a2 = stdio_process_id(
        probe(&source, &bridge.resources, Some(&owner_a)).await,
        "perchat",
    );
    let b2 = stdio_process_id(
        probe(&source, &bridge.resources, Some(&owner_b)).await,
        "perchat",
    );
    assert_ne!(
        a1, b1,
        "two task owners must never share an MCP child process"
    );
    assert_eq!(a1, a2, "one task must keep its own browser connection");
    assert_eq!(
        b1, b2,
        "the second task must retain its distinct connection"
    );
}

#[tokio::test]
async fn named_profile_manager_routes_launch_reconnect_and_inventory_through_real_stdio() {
    let temp = tempfile::tempdir().unwrap();
    let config = crate::config::default_config(temp.path().to_path_buf());
    let mut spec = isolated_stdio_spec("profile-manager");
    spec.session_scope = McpSessionScope::PerChat;
    spec.env.insert(
        "CODEXIFY_SHARED_PLAYWRIGHT_PROFILES".into(),
        "authority".into(),
    );
    let server = "playwright-profile-manager-fixture";
    let (service, tools, timeout, mut pool) =
        connect_owned_source(server, &spec, &config).await.unwrap();
    assert_eq!(
        tools
            .iter()
            .filter(|t| t.name.as_ref() == crate::playwright_sessions::PROFILE_TOOL)
            .count(),
        1
    );
    Arc::get_mut(pool.as_mut().unwrap())
        .unwrap()
        .set_test_root(temp.path().join("profiles"));
    let source = hot_reload::Generation::for_source(server, spec, service, tools, timeout, pool, 1);
    let resources = BridgedResourceStore::new(config.artifact_egress.clone());
    let a = ConversationIdentity::from_openai_session("profile-manager-owner-a").unwrap();
    let b = ConversationIdentity::from_openai_session("profile-manager-owner-b").unwrap();

    async fn call(
        source: &hot_reload::Generation,
        resources: &BridgedResourceStore,
        owner: Option<&ConversationIdentity>,
        tool: &'static str,
        args: Value,
    ) -> ToolResult {
        forward_tool_call(
            &source.peer,
            CallToolRequestParams::new(tool).with_arguments(args.as_object().unwrap().clone()),
            "playwright-profile-manager-fixture",
            tool,
            source.timeout,
            None,
            UpstreamCallContext {
                resources,
                control: &source.control,
                conversation: owner,
            },
        )
        .await
    }
    let manager = crate::playwright_sessions::PROFILE_TOOL;
    let no_owner = call(&source, &resources, None, manager, json!({"action":"list"})).await;
    assert!(no_owner.is_error);
    let before = call(
        &source,
        &resources,
        Some(&a),
        manager,
        json!({"action":"list"}),
    )
    .await;
    assert!(!before.is_error);
    assert!(!temp.path().join("profiles").exists());
    let launched = call(
        &source,
        &resources,
        Some(&a),
        manager,
        json!({"action":"launch","profile":"private-a"}),
    )
    .await;
    assert!(!launched.is_error, "{}", launched.joined_text());
    let launch_text = launched.joined_text();
    assert!(launch_text.contains("### Open tabs"));
    let first_pid = launch_text.lines().last().unwrap();
    let inventory = call(
        &source,
        &resources,
        Some(&a),
        manager,
        json!({"action":"list"}),
    )
    .await;
    let inventory: Value = serde_json::from_str(&inventory.joined_text()).unwrap();
    let owned = inventory["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["profile"] == "private-a")
        .unwrap();
    assert_eq!(
        owned["last_observed_tabs"]["tabs"][0]["origin"],
        "https://example.invalid"
    );
    assert!(!inventory.to_string().contains("secret=synthetic"));
    let b_inventory = call(
        &source,
        &resources,
        Some(&b),
        manager,
        json!({"action":"list"}),
    )
    .await;
    assert!(!b_inventory.joined_text().contains("private-a"));
    assert!(!b_inventory.joined_text().contains("example.invalid"));

    let selected = call(
        &source,
        &resources,
        Some(&a),
        manager,
        json!({"action":"select","profile":"authority"}),
    )
    .await;
    assert!(!selected.is_error, "{}", selected.joined_text());
    let refused = call(
        &source,
        &resources,
        Some(&b),
        manager,
        json!({"action":"select","profile":"authority"}),
    )
    .await;
    assert!(refused.is_error);
    let shared_pid = stdio_process_id(
        call(&source, &resources, Some(&a), "probe", json!({})).await,
        "profile-manager",
    );
    assert_ne!(first_pid, format!("profile-manager:{shared_pid}"));
    let reconnect = call(
        &source,
        &resources,
        Some(&a),
        manager,
        json!({"action":"reconnect","profile":"private-a"}),
    )
    .await;
    assert!(!reconnect.is_error);
    let reused = call(
        &source,
        &resources,
        Some(&a),
        "browser_tabs",
        json!({"action":"list"}),
    )
    .await;
    assert!(!reused.is_error);
    assert_eq!(reused.joined_text().lines().last().unwrap(), first_pid);
    let released = call(
        &source,
        &resources,
        Some(&a),
        manager,
        json!({"action":"release","profile":"authority"}),
    )
    .await;
    assert!(!released.is_error);
    let claimed = call(
        &source,
        &resources,
        Some(&b),
        manager,
        json!({"action":"reconnect","profile":"authority"}),
    )
    .await;
    assert!(!claimed.is_error);
    let new_pid = stdio_process_id(
        call(&source, &resources, Some(&b), "probe", json!({})).await,
        "profile-manager",
    );
    assert_ne!(shared_pid, new_pid);
    assert_eq!(
        call(
            &source,
            &resources,
            Some(&a),
            "browser_tabs",
            json!({"action":"list"})
        )
        .await
        .joined_text()
        .lines()
        .last()
        .unwrap(),
        first_pid
    );
    drop(source);
}

// Only opt in with an explicitly pinned Playwright MCP CLI. The browser uses
// disposable managed profiles, headless Chrome and a loopback synthetic page.
#[tokio::test]
#[ignore = "requires a pinned Playwright MCP CLI and installed Chrome"]
async fn named_profiles_real_chrome_canary() {
    let entry = std::env::var("CODEXIFY_TEST_PLAYWRIGHT_MCP_ENTRY")
        .expect("provide the pinned Playwright MCP CLI entry");
    assert!(std::path::Path::new(&entry).is_file());
    let temp = tempfile::tempdir().unwrap();
    let config = crate::config::default_config(temp.path().to_path_buf());
    let spec = crate::types::McpServerSpec {
        command: Some("node".into()),
        args: vec![entry, "--headless".into(), "--browser=chrome".into()],
        session_scope: McpSessionScope::PerChat,
        startup_timeout_sec: Some(45.0),
        tool_timeout_sec: Some(45.0),
        env: HashMap::from([(
            "CODEXIFY_SHARED_PLAYWRIGHT_PROFILES".into(),
            "shared-canary".into(),
        )]),
        ..Default::default()
    };
    let server = "playwright-disposable-chrome-canary";
    let (service, tools, timeout, mut pool) =
        connect_owned_source(server, &spec, &config).await.unwrap();
    assert!(
        tools
            .iter()
            .any(|t| t.name.as_ref() == crate::playwright_sessions::PROFILE_TOOL)
    );
    Arc::get_mut(pool.as_mut().unwrap())
        .unwrap()
        .set_test_root(temp.path().join("profiles"));
    let source = hot_reload::Generation::for_source(server, spec, service, tools, timeout, pool, 1);
    let resources = BridgedResourceStore::new(config.artifact_egress.clone());
    let a = ConversationIdentity::from_openai_session("real-chrome-canary-a").unwrap();
    let b = ConversationIdentity::from_openai_session("real-chrome-canary-b").unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let app = Router::new().route("/", axum::routing::get(|| async {
        axum::response::Html("<html><title>Codexify local canary</title><body>Local synthetic test</body></html>")
    }));
    let http = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let manager = crate::playwright_sessions::PROFILE_TOOL;

    async fn call(
        source: &hot_reload::Generation,
        resources: &BridgedResourceStore,
        owner: &ConversationIdentity,
        name: &'static str,
        args: Value,
    ) -> ToolResult {
        forward_tool_call(
            &source.peer,
            CallToolRequestParams::new(name).with_arguments(args.as_object().unwrap().clone()),
            "playwright-disposable-chrome-canary",
            name,
            source.timeout,
            None,
            UpstreamCallContext {
                resources,
                control: &source.control,
                conversation: Some(owner),
            },
        )
        .await
    }
    async fn ok(
        source: &hot_reload::Generation,
        resources: &BridgedResourceStore,
        owner: &ConversationIdentity,
        name: &'static str,
        args: Value,
    ) -> String {
        let result = call(source, resources, owner, name, args).await;
        assert!(!result.is_error, "{name}: {}", result.joined_text());
        result.joined_text()
    }
    let initial = ok(&source, &resources, &a, manager, json!({"action":"list"})).await;
    assert!(!temp.path().join("profiles").exists());
    assert!(initial.contains("default"));
    for owner in [&a, &b] {
        ok(
            &source,
            &resources,
            owner,
            manager,
            json!({"action":"launch","profile":"private-canary"}),
        )
        .await;
        ok(
            &source,
            &resources,
            owner,
            "browser_navigate",
            json!({"url":url}),
        )
        .await;
    }
    let read = json!({"function":"() => localStorage.getItem('codexify-canary')"});
    ok(
        &source,
        &resources,
        &a,
        "browser_evaluate",
        json!({"function":"() => localStorage.setItem('codexify-canary', 'isolated-a-marker')"}),
    )
    .await;
    assert!(
        ok(&source, &resources, &a, "browser_evaluate", read.clone())
            .await
            .contains("isolated-a-marker")
    );
    assert!(
        !ok(&source, &resources, &b, "browser_evaluate", read.clone())
            .await
            .contains("isolated-a-marker")
    );
    ok(
        &source,
        &resources,
        &a,
        "browser_tabs",
        json!({"action":"new","url":url}),
    )
    .await;
    ok(
        &source,
        &resources,
        &a,
        "browser_tabs",
        json!({"action":"list"}),
    )
    .await;
    let inventory: Value =
        serde_json::from_str(&ok(&source, &resources, &a, manager, json!({"action":"list"})).await)
            .unwrap();
    let tabs = inventory["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["profile"] == "private-canary")
        .unwrap()["last_observed_tabs"]["tabs"]
        .as_array()
        .unwrap();
    assert!(
        tabs.len() >= 2,
        "real Playwright tab inventory: {inventory}"
    );
    // The other task must retain its original profile and current page.
    assert!(
        !ok(&source, &resources, &b, "browser_evaluate", read.clone())
            .await
            .contains("isolated-a-marker")
    );
    ok(&source, &resources, &a, "browser_close", json!({})).await;
    ok(
        &source,
        &resources,
        &a,
        manager,
        json!({"action":"release"}),
    )
    .await;
    ok(
        &source,
        &resources,
        &a,
        manager,
        json!({"action":"select","profile":"shared-canary"}),
    )
    .await;
    ok(
        &source,
        &resources,
        &a,
        "browser_navigate",
        json!({"url":url}),
    )
    .await;
    ok(&source, &resources, &a, "browser_evaluate", json!({"function":"() => localStorage.setItem('codexify-canary', 'shared-persistence-marker')"})).await;
    assert!(
        call(
            &source,
            &resources,
            &b,
            manager,
            json!({"action":"select","profile":"shared-canary"})
        )
        .await
        .is_error
    );
    ok(&source, &resources, &a, "browser_close", json!({})).await;
    ok(
        &source,
        &resources,
        &a,
        manager,
        json!({"action":"release"}),
    )
    .await;
    ok(
        &source,
        &resources,
        &b,
        manager,
        json!({"action":"reconnect","profile":"shared-canary"}),
    )
    .await;
    ok(
        &source,
        &resources,
        &b,
        "browser_navigate",
        json!({"url":url}),
    )
    .await;
    assert!(
        ok(&source, &resources, &b, "browser_evaluate", read)
            .await
            .contains("shared-persistence-marker")
    );
    ok(&source, &resources, &b, "browser_close", json!({})).await;
    ok(
        &source,
        &resources,
        &b,
        manager,
        json!({"action":"release"}),
    )
    .await;
    ok(
        &source,
        &resources,
        &b,
        manager,
        json!({"action":"reconnect","profile":"private-canary"}),
    )
    .await;
    ok(&source, &resources, &b, "browser_close", json!({})).await;
    ok(
        &source,
        &resources,
        &b,
        manager,
        json!({"action":"release"}),
    )
    .await;
    http.abort();
    drop(source);
}

#[tokio::test]
async fn service_isolated_real_stdio_process_reload_preserves_unrelated_sources() {
    // This fixture actually spawns three independent OS processes through the
    // production TokioChildProcess transport; no live Codexify is involved.
    let directory = tempfile::tempdir().unwrap();
    let started = directory.path().join("slow_started");
    let mut old_spec = isolated_stdio_spec("old");
    old_spec.env.insert(
        "HOT_RELOAD_SLOW_MARKER_FILE".into(),
        started.to_string_lossy().into_owned(),
    );

    let mut config = crate::config::default_config(std::env::temp_dir());
    config.mcp_servers.insert("alpha".into(), old_spec);
    config
        .mcp_servers
        .insert("beta".into(), isolated_stdio_spec("beta"));
    config
        .mcp_servers
        .insert("gamma".into(), isolated_stdio_spec("gamma"));
    let bridge = connect_upstreams(&config).await;
    assert_eq!(
        bridge.runtime.snapshot().sources.len(),
        3,
        "all isolated stdio fixtures must start: {:?}",
        bridge.report
    );
    let runtime = bridge.runtime.clone();
    drop(bridge);

    let initial = runtime.snapshot();
    let retired = Arc::downgrade(&initial.sources["alpha"]);
    let old_probe = initial
        .tools
        .iter()
        .find(|tool| tool.name() == "alpha__probe")
        .unwrap()
        .clone();
    let old_slow = initial
        .tools
        .iter()
        .find(|tool| tool.name() == "alpha__slow")
        .unwrap()
        .clone();
    drop(initial);
    let config_for_call = crate::config::default_config(std::env::temp_dir());
    let original_pid = stdio_process_id(
        old_probe
            .call(json!({}), &config_for_call, &SessionState::new())
            .await,
        "old",
    );
    let beta_pid = stdio_process_id(invoke(runtime.snapshot(), "beta__probe").await, "beta");
    let gamma_pid = stdio_process_id(invoke(runtime.snapshot(), "gamma__probe").await, "gamma");

    let pending = tokio::spawn(async move {
        old_slow
            .call(
                json!({}),
                &crate::config::default_config(std::env::temp_dir()),
                &SessionState::new(),
            )
            .await
    });
    // The marker is written by the actual old process when it receives the
    // slow request, making this test independent of host scheduling.
    tokio::time::timeout(Duration::from_secs(4), async {
        while !started.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("old stdio process did not begin the slow call");

    let result = runtime
        .reload_with_spec("alpha", isolated_stdio_spec("new"), None)
        .await
        .unwrap();
    assert_eq!(result["previousVersion"], "old");
    assert_eq!(result["replacementVersion"], "new");
    assert_eq!(result["previousGeneration"], 1);
    assert_eq!(result["replacementGeneration"], 2);
    assert_eq!(result["toolChanges"]["added"], 1);
    assert_eq!(result["oldCallsDrained"], true);
    assert_eq!(
        stdio_process_id(pending.await.unwrap(), "old"),
        original_pid
    );
    assert_eq!(
        stdio_process_id(
            old_probe
                .call(json!({}), &config_for_call, &SessionState::new())
                .await,
            "old",
        ),
        original_pid,
        "a pinned retired generation must remain callable until released"
    );
    let new_pid = stdio_process_id(invoke(runtime.snapshot(), "alpha__probe").await, "new");
    assert_ne!(
        new_pid, original_pid,
        "replacement must be a new OS process"
    );
    assert_eq!(
        stdio_process_id(invoke(runtime.snapshot(), "alpha__new_tool").await, "new"),
        new_pid
    );
    assert_eq!(
        stdio_process_id(invoke(runtime.snapshot(), "beta__probe").await, "beta"),
        beta_pid,
        "beta must not reconnect"
    );
    assert_eq!(
        stdio_process_id(invoke(runtime.snapshot(), "gamma__probe").await, "gamma"),
        gamma_pid,
        "gamma must not reconnect"
    );

    let mut invalid_spec = isolated_stdio_spec("broken");
    invalid_spec.command = Some("codexify-nonexistent-hot-reload-fixture".into());
    assert_eq!(
        runtime
            .reload_with_spec("alpha", invalid_spec, None)
            .await
            .err(),
        Some("INITIALIZE_FAILED")
    );
    assert_eq!(
        stdio_process_id(invoke(runtime.snapshot(), "alpha__probe").await, "new"),
        new_pid,
        "an unsuccessful replacement must preserve the healthy process"
    );

    assert!(
        stdio_process_still_alive(original_pid).await,
        "retiring process must remain alive while a pinned old handle exists"
    );
    drop(old_probe);
    tokio::task::yield_now().await;
    assert!(
        retired.upgrade().is_none(),
        "the retired generation must be released after its last handle drops"
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while stdio_process_still_alive(original_pid).await {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("retired OS child process remained alive after the last handle dropped");

    let repeated = runtime
        .reload_with_spec("alpha", isolated_stdio_spec("new"), None)
        .await
        .unwrap();
    assert_eq!(repeated["previousGeneration"], 2);
    assert_eq!(repeated["replacementGeneration"], 3);
    assert_eq!(repeated["toolChanges"]["unchanged"], 3);
    assert_eq!(
        stdio_process_id(invoke(runtime.snapshot(), "beta__probe").await, "beta"),
        beta_pid
    );
    assert_eq!(
        stdio_process_id(invoke(runtime.snapshot(), "gamma__probe").await, "gamma"),
        gamma_pid
    );
}

/// Opt-in, isolated acceptance test using two real, read-only GodPrompt stdio
/// installs. Only initialize, tools/list, and ping are sent; no GodPrompt tool
/// calls, external APIs, operator configuration, or running service are touched.
///
/// CI installs and selects the pinned published 1.0.3 / 1.1.1 npm versions.
/// A developer can instead supply two existing entrypoint paths locally.
#[tokio::test]
async fn service_local_godprompt_candidate_upgrade_and_failed_rollback() {
    let old_entry = std::env::var_os("CODEXIFY_CANARY_OLD_GODPROMPT");
    let new_entry = std::env::var_os("CODEXIFY_CANARY_NEW_GODPROMPT");
    let (Some(old_entry), Some(new_entry)) = (old_entry, new_entry) else {
        assert!(
            std::env::var_os("CODEXIFY_CANARY_OLD_GODPROMPT").is_none()
                && std::env::var_os("CODEXIFY_CANARY_NEW_GODPROMPT").is_none(),
            "provide both isolated GodPrompt entrypoints, or neither"
        );
        return;
    };
    let node = std::env::var("CODEXIFY_CANARY_NODE").unwrap_or_else(|_| "node".into());
    for entry in [&old_entry, &new_entry] {
        assert!(
            std::path::Path::new(entry).is_file(),
            "GodPrompt candidate stdio entrypoint does not exist"
        );
    }
    let make_candidate = |entry: &std::ffi::OsStr| crate::types::McpServerSpec {
        command: Some(node.clone()),
        args: vec![entry.to_string_lossy().into_owned()],
        mode: Some(McpToolExposure::Direct),
        startup_timeout_sec: Some(18.0),
        ..Default::default()
    };

    let (beta_url, _, beta_server) = fixture("beta", false, Duration::ZERO, Duration::ZERO).await;
    let (gamma_url, _, gamma_server) =
        fixture("gamma", false, Duration::ZERO, Duration::ZERO).await;
    let mut config = crate::config::default_config(std::env::temp_dir());
    config.mcp_servers.insert(
        "godprompt_canary".into(),
        make_candidate(old_entry.as_os_str()),
    );
    config
        .mcp_servers
        .insert("beta".into(), spec(&beta_url, McpToolExposure::Direct));
    config
        .mcp_servers
        .insert("gamma".into(), spec(&gamma_url, McpToolExposure::Direct));

    let bridge = connect_upstreams(&config).await;
    assert_eq!(
        bridge.runtime.snapshot().sources.len(),
        3,
        "{:?}",
        bridge.report
    );
    let runtime = bridge.runtime.clone();
    drop(bridge);
    let before = runtime.snapshot();
    let old = before.sources["godprompt_canary"].clone();
    let beta = before.sources["beta"].clone();
    let gamma = before.sources["gamma"].clone();
    let old_tool_count = old.tools.len();
    assert!(old_tool_count > 0, "old GodPrompt must advertise tools");
    drop(before);

    let result = runtime
        .reload_with_spec(
            "godprompt_canary",
            make_candidate(new_entry.as_os_str()),
            None,
        )
        .await
        .expect("replacement GodPrompt must initialize, discover tools and pass ping");
    assert_eq!(result["previousGeneration"], 1);
    assert_eq!(result["replacementGeneration"], 2);
    assert_eq!(result["ready"], true);
    assert_eq!(result["previousVersion"], "1.0.3");
    assert_eq!(result["replacementVersion"], "1.1.1");
    let updated = runtime.snapshot();
    let new = updated.sources["godprompt_canary"].clone();
    assert!(!Arc::ptr_eq(&old, &new));
    assert!(Arc::ptr_eq(&beta, &updated.sources["beta"]));
    assert!(Arc::ptr_eq(&gamma, &updated.sources["gamma"]));
    assert!(!new.tools.is_empty(), "new GodPrompt must advertise tools");
    println!(
        "isolated GodPrompt {} -> {}: {} -> {} tools; timings {:?}; testing rollback",
        result["previousVersion"],
        result["replacementVersion"],
        old_tool_count,
        new.tools.len(),
        result["timingsMs"]
    );
    drop(updated);

    let mut broken = make_candidate(new_entry.as_os_str());
    broken.command = Some("codexify-nonexistent-godprompt-canary".into());
    assert_eq!(
        runtime
            .reload_with_spec("godprompt_canary", broken, None)
            .await
            .err(),
        Some("INITIALIZE_FAILED")
    );
    let after_rollback = runtime.snapshot();
    assert!(Arc::ptr_eq(
        &new,
        &after_rollback.sources["godprompt_canary"]
    ));
    assert!(Arc::ptr_eq(&beta, &after_rollback.sources["beta"]));
    assert!(Arc::ptr_eq(&gamma, &after_rollback.sources["gamma"]));
    beta_server.abort();
    gamma_server.abort();
}
