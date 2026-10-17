use async_trait::async_trait;
use rmcp::model::MetaObject;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::exec_sessions::SessionState;
use crate::markdown_chat_ui::CHAT_WIDGET_META;
use crate::tool::{Tool, ToolBehavior, ToolRequestContext, parse_tool_args, text_output_schema};
use crate::types::{AppConfig, ToolContent, ToolResult};

pub enum ChatUiTool {
    Send,
    State,
    File,
    Queue,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileArgs {
    href: String,
    expected_workspace: Option<String>,
    expected_chat_file: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendArgs {
    request_id: String,
    message: String,
    #[serde(default)]
    stop_agent: bool,
    #[serde(default)]
    attachment_ids: Vec<String>,
    #[serde(default)]
    message_mode: Option<crate::markdown_chat::MessageMode>,
    expected_workspace: Option<String>,
    expected_chat_file: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StateArgs {
    #[serde(default)]
    before: Option<u64>,
    #[serde(default)]
    revision: Option<String>,
    expected_workspace: Option<String>,
    expected_chat_file: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueueArgs {
    id: String,
    revision: u64,
    action: crate::markdown_chat::QueueSubmission,
    message: Option<String>,
    expected_workspace: Option<String>,
    expected_chat_file: Option<String>,
}

fn check_destination(
    config: &AppConfig,
    chat_file: &std::path::Path,
    expected_workspace: Option<&str>,
    expected_chat_file: Option<&str>,
    requires_destination: bool,
) -> Result<(), Box<ToolResult>> {
    let missing = config.multi_project && requires_destination && expected_chat_file.is_none();
    let changed = expected_workspace
        .is_some_and(|path| std::path::Path::new(path) != config.work_dir)
        || expected_chat_file.is_some_and(|path| std::path::Path::new(path) != chat_file);
    if !missing && !changed {
        return Ok(());
    }
    let mut result = ToolResult::error(if missing {
        "Reload the chat widget before sending or downloading: it must identify the transcript currently displayed. No message was appended or file resolved."
    } else {
        "Workspace changed. Refresh the selected workspace before retrying. No message was appended or file resolved."
    });
    result.meta = Some(
        serde_json::from_value(json!({CHAT_WIDGET_META:{"workspace_changed":true}}))
            .expect("chat context metadata"),
    );
    result.audit.sensitive_output = true;
    Err(Box::new(result))
}

fn private_result(value: Value) -> ToolResult {
    let mut result = ToolResult::text("Markdown chat widget state updated.");
    result.meta =
        Some(serde_json::from_value(json!({CHAT_WIDGET_META: value})).expect("widget metadata"));
    result.audit.sensitive_output = true;
    result
}

#[async_trait]
impl Tool for ChatUiTool {
    fn name(&self) -> &'static str {
        match self {
            Self::Send => "chat_ui_send",
            Self::State => "chat_ui_state",
            Self::File => "chat_ui_file",
            Self::Queue => "chat_ui_queue",
        }
    }
    fn title(&self) -> String {
        match self {
            Self::Send => "Send user chat message",
            Self::State => "Read chat widget state",
            Self::File => "Download referenced chat file",
            Self::Queue => "Edit, remove, or steer a queued message",
        }
        .into()
    }
    fn description(&self) -> String {
        match self {
            Self::Send => "App-only: append the user's Markdown to this Codexify task's CHAT.md. Reusing request_id with the same text is idempotent. Does not acknowledge or deliver text to the agent.",
            Self::State => "App-only: read a page of this Codexify task's chat history and delivery receipts without acknowledging messages. No arbitrary path or task selector is accepted.",
            Self::Queue => "App-only: edit, remove, or immediately steer one private queued message in the displayed conversation. Other queued messages are not changed.",
            Self::File => "App-only: resolve an exported or project-relative Markdown file link in the active workspace for a user-requested download. Sandbox names must match an unambiguous prior export. Does not read or acknowledge chat messages.",
        }.into()
    }
    fn meta(&self) -> Option<MetaObject> {
        Some(serde_json::from_value(json!({
            "ui":{"visibility":["app"]}, "openai/visibility":"private", "openai/widgetAccessible":true
        })).expect("app-only metadata"))
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior::new(
            !matches!(self, Self::Send | Self::Queue),
            false,
            true,
            false,
            "The widget reads its conversation or an active-workspace file, or idempotently appends a user message; it never publishes externally or advances agent delivery.",
        )
    }
    fn input_schema(&self) -> Value {
        let mut schema = match self {
            Self::Send => json!({"type":"object", "properties":{
                "request_id":{"type":"string", "pattern":"^[A-Za-z0-9_-]{1,80}$"},
                "message_mode":{"type":"string","enum":["steer","queue"],"description":"Steer immediately or keep the message private until a completed turn. Defaults to the user's configured mode."},
                "stop_agent":{"type":"boolean", "description":"Request that the current turn stop on its next tool response, pause its goal, and show this agent offline. The message field is ignored for this action."},
                "message":{"type":"string", "writeOnly":true},
                "attachment_ids":{"type":"array","maxItems":20,"uniqueItems":true,"items":{"type":"string","pattern":"^[a-fA-F0-9]{32}$"}}
            }, "required":["request_id","message"], "additionalProperties":false}),
            Self::Queue => json!({"type":"object","properties":{
                "id":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,80}$"},
                "revision":{"type":"integer","minimum":1},
                "action":{"type":"string","enum":["steer","trash","edit"]},
                "message":{"type":"string","writeOnly":true}
            },"required":["id","revision","action"],"additionalProperties":false}),
            Self::State => json!({"type":"object", "properties":{
                "before":{"type":"integer", "minimum":0},
                "revision":{"type":"string", "maxLength":128}
            }, "additionalProperties":false}),
            Self::File => {
                json!({"type":"object", "properties":{"href":{"type":"string", "minLength":1, "maxLength":4096}}, "required":["href"], "additionalProperties":false})
            }
        };
        for (name, description) in [
            (
                "expected_workspace",
                "The selected workspace displayed by setup. Compared with the server-resolved workspace; never used to select a path.",
            ),
            (
                "expected_chat_file",
                "The chat_file returned by the displayed chat state. Required for sends and file actions in multi-project mode; never used to select a transcript.",
            ),
        ] {
            schema["properties"][name] =
                json!({"type":"string","minLength":1,"description":description});
        }
        schema
    }
    fn output_schema(&self) -> Option<Value> {
        Some(text_output_schema())
    }
    async fn call(&self, _: Value, _: &AppConfig, _: &SessionState) -> ToolResult {
        ToolResult::error("Chat widget actions require conversation context.")
    }
    async fn call_with_context(
        &self,
        args: Value,
        config: &AppConfig,
        session: &SessionState,
        context: &ToolRequestContext,
    ) -> ToolResult {
        if !config.ui_widgets || !config.markdown_chat.enabled {
            return ToolResult::error("The Markdown chat widget is disabled.");
        }
        if context.cancellation.is_cancelled() {
            return ToolResult::error("Chat widget request was cancelled.");
        }
        let chat =
            match context
                .markdown_chat
                .chat(config, context.task_conversation.as_ref(), session)
            {
                Ok(chat) => chat,
                Err(error) => return ToolResult::error(error),
            };
        match self {
            Self::File => {
                let FileArgs {
                    href,
                    expected_workspace,
                    expected_chat_file,
                } = match parse_tool_args(args) {
                    Ok(args) => args,
                    Err(error) => return *error,
                };
                if let Err(error) = check_destination(
                    config,
                    chat.path(),
                    expected_workspace.as_deref(),
                    expected_chat_file.as_deref(),
                    true,
                ) {
                    return *error;
                }
                match context
                    .artifact_egress
                    .chat_file_link(&config.work_dir, &href, &context.cancellation)
                    .await
                {
                    Ok(resource) => {
                        let mut file = serde_json::to_value(&resource).expect("file resource");
                        file["type"] = json!("resource_link");
                        let mut result = private_result(json!({"file":file}));
                        result.content.push(ToolContent::ResourceLink(resource));
                        result
                    }
                    Err(error) => ToolResult::error(error.to_string()),
                }
            }
            Self::Send => {
                let SendArgs {
                    request_id,
                    message,
                    stop_agent,
                    attachment_ids,
                    message_mode,
                    expected_workspace,
                    expected_chat_file,
                } = match parse_tool_args(args) {
                    Ok(args) => args,
                    Err(error) => return *error,
                };
                if let Err(error) = check_destination(
                    config,
                    chat.path(),
                    expected_workspace.as_deref(),
                    expected_chat_file.as_deref(),
                    true,
                ) {
                    return *error;
                }
                if stop_agent {
                    if request_id.is_empty()
                        || request_id.len() > 80
                        || !request_id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                    {
                        return ToolResult::error("Invalid agent stop request ID.");
                    }
                    if config.markdown_chat.automation.enabled {
                        let Some(store) = context.agent_automation.as_ref() else {
                            return ToolResult::error(
                                "Agent automation state is unavailable; the turn was not stopped.",
                            );
                        };
                        let Some(task) = context.task_conversation.as_ref() else {
                            return ToolResult::error("Agent stop requires conversation context.");
                        };
                        if let Err(error) = store.pause_goal_for_agent_stop(
                            task,
                            &request_id,
                            crate::markdown_chat::now_ms(),
                        ) {
                            return ToolResult::error(error);
                        }
                    }
                    return match chat.request_agent_stop(request_id).await {
                        Ok(()) => private_result(json!({"stopped":true})),
                        Err(error) => ToolResult::error(error),
                    };
                }
                let mode = match message_mode {
                    Some(mode) => mode,
                    None => match crate::global_settings::default_message_mode(config) {
                        Ok(mode) => mode,
                        Err(error) => return ToolResult::error(error),
                    },
                };
                if mode == crate::markdown_chat::MessageMode::Queue {
                    return match chat
                        .queue_user_message(request_id, message, attachment_ids)
                        .await
                    {
                        Ok(receipt) => match chat.queued_messages().await {
                            Ok(messages) => private_result(
                                json!({"queue_receipt":receipt,"queued_messages":messages}),
                            ),
                            Err(error) => ToolResult::error(error),
                        },
                        Err(error) => ToolResult::error(error),
                    };
                }
                match chat
                    .append_user_with_attachments(request_id, message, attachment_ids)
                    .await
                {
                    Ok(receipt) => private_result(json!({"sent":receipt})),
                    Err(error) => ToolResult::error(error),
                }
            }
            Self::Queue => {
                let args: QueueArgs = match parse_tool_args(args) {
                    Ok(args) => args,
                    Err(error) => return *error,
                };
                if let Err(error) = check_destination(
                    config,
                    chat.path(),
                    args.expected_workspace.as_deref(),
                    args.expected_chat_file.as_deref(),
                    true,
                ) {
                    return *error;
                }
                match chat
                    .update_queued_message(args.id, args.revision, args.action, args.message)
                    .await
                {
                    Ok(receipt) => match chat.queued_messages().await {
                        Ok(messages) => private_result(
                            json!({"queue_receipt":receipt,"queued_messages":messages}),
                        ),
                        Err(error) => ToolResult::error(error),
                    },
                    Err(error) => ToolResult::error(error),
                }
            }
            Self::State => {
                let StateArgs {
                    before,
                    revision,
                    expected_workspace,
                    expected_chat_file,
                } = match parse_tool_args(args) {
                    Ok(args) => args,
                    Err(error) => return *error,
                };
                if let Err(error) = check_destination(
                    config,
                    chat.path(),
                    expected_workspace.as_deref(),
                    expected_chat_file.as_deref(),
                    false,
                ) {
                    return *error;
                }
                if let Some(activity) = context
                    .markdown_chat
                    .agent_activity(context.task_conversation.as_ref(), session)
                    && let Err(error) = chat.sync_agent_activity(activity).await
                {
                    return ToolResult::error(error);
                }
                match chat.widget_page(before, revision).await {
                    Ok(page) => {
                        let mut page = serde_json::to_value(page).expect("chat page");
                        page["queued_messages"] = match chat.queued_messages().await {
                            Ok(messages) => json!(messages),
                            Err(error) => return ToolResult::error(error),
                        };
                        page["default_message_mode"] =
                            match crate::global_settings::default_message_mode(config) {
                                Ok(mode) => json!(mode),
                                Err(error) => return ToolResult::error(error),
                            };
                        page["workspace_path"] = json!(config.work_dir);
                        page["retired"] = json!(context.conversation_retired);
                        private_result(page)
                    }
                    Err(error) => ToolResult::error(error),
                }
            }
        }
    }
}
