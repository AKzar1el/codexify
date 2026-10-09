use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::agent_automation::{GoalFinish, GoalRecord, GoalStatus, MAX_GOAL_BYTES};
use crate::exec_sessions::SessionState;
use crate::tool::{Tool, ToolBehavior, ToolRequestContext, empty_object_schema, parse_tool_args};
use crate::types::{AppConfig, ToolResult};

const MAX_GOAL_RESULT_BYTES: usize = 4096;

#[derive(Clone, Copy)]
pub enum GoalTool {
    Read,
    Finish,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FinishArgs {
    expected_revision: u64,
    status: FinishStatus,
    summary: Option<String>,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum FinishStatus {
    Completed,
    Blocked,
}

#[async_trait]
impl Tool for GoalTool {
    fn name(&self) -> &'static str {
        match self {
            Self::Read => "goal_read",
            Self::Finish => "goal_finish",
        }
    }

    fn title(&self) -> String {
        match self {
            Self::Read => "Read agent-chat goal",
            Self::Finish => "Finish agent-chat goal",
        }
        .into()
    }

    fn description(&self) -> String {
        match self {
            Self::Read => {
                "Read the current standalone agent-chat automation goal, revision, and status without changing it."
            }
            Self::Finish => {
                "Mark the exact current standalone agent-chat goal revision completed or blocked. A blocked goal requires a concrete reason; an ordinary final answer does not finish a goal."
            }
        }
        .into()
    }

    fn behavior(&self) -> ToolBehavior {
        match self {
            Self::Read => ToolBehavior::new(
                true,
                false,
                true,
                false,
                "Reads private task goal state without changing it.",
            ),
            Self::Finish => ToolBehavior::new(
                false,
                false,
                true,
                false,
                "Changes only private task goal state and is idempotent for the same terminal receipt.",
            ),
        }
    }

    fn input_schema(&self) -> Value {
        match self {
            Self::Read => empty_object_schema(),
            Self::Finish => json!({
                "type": "object",
                "properties": {
                    "expectedRevision": {
                        "type": "integer",
                        "minimum": 1
                    },
                    "status": {
                        "type": "string",
                        "enum": ["completed", "blocked"]
                    },
                    "summary": {
                        "type": "string",
                        "maxLength": MAX_GOAL_RESULT_BYTES
                    },
                    "reason": {
                        "type": "string",
                        "maxLength": MAX_GOAL_RESULT_BYTES
                    }
                },
                "required": ["expectedRevision", "status"],
                "additionalProperties": false
            }),
        }
    }

    fn output_schema(&self) -> Option<Value> {
        Some(json!({
            "type": "object",
            "properties": {
                "content": { "type": "string" },
                "enabled": { "type": "boolean" },
                "status": {
                    "type": "string",
                    "enum": ["absent", "configured", "active", "completed", "blocked", "error"]
                },
                "revision": {
                    "anyOf": [
                        { "type": "integer", "minimum": 1 },
                        { "type": "null" }
                    ]
                },
                "markdown": {
                    "anyOf": [
                        { "type": "string", "maxLength": MAX_GOAL_BYTES },
                        { "type": "null" }
                    ]
                },
                "summary": {
                    "anyOf": [
                        { "type": "string", "maxLength": MAX_GOAL_RESULT_BYTES },
                        { "type": "null" }
                    ]
                },
                "blockedReason": {
                    "anyOf": [
                        { "type": "string", "maxLength": MAX_GOAL_RESULT_BYTES },
                        { "type": "null" }
                    ]
                },
                "terminal": { "type": "boolean" }
            },
            "required": [
                "content",
                "enabled",
                "status",
                "revision",
                "markdown",
                "summary",
                "blockedReason",
                "terminal"
            ],
            "additionalProperties": false
        }))
    }

    async fn call(&self, _: Value, config: &AppConfig, _: &SessionState) -> ToolResult {
        if !config.markdown_chat.automation.enabled {
            return ToolResult::error("Agent-chat browser automation is disabled.");
        }
        ToolResult::error("Agent-chat goals require stable ChatGPT conversation and task context.")
    }

    async fn call_with_context(
        &self,
        args: Value,
        config: &AppConfig,
        _session: &SessionState,
        context: &ToolRequestContext,
    ) -> ToolResult {
        if !config.markdown_chat.automation.enabled {
            return ToolResult::error("Agent-chat browser automation is disabled.");
        }
        let (task, store) = match task_store(context) {
            Ok(value) => value,
            Err(error) => return ToolResult::error(error),
        };
        match self {
            Self::Read => match store.load(task) {
                Ok(state) => goal_result(state.goal.as_ref(), false),
                Err(error) => ToolResult::error(error),
            },
            Self::Finish => {
                let args = match parse_tool_args::<FinishArgs>(args) {
                    Ok(args) => args,
                    Err(error) => return *error,
                };
                let finish = match args.status {
                    FinishStatus::Completed => {
                        if args
                            .reason
                            .as_deref()
                            .is_some_and(|value| !value.trim().is_empty())
                        {
                            return ToolResult::error(
                                "A completed agent-chat goal accepts summary, not reason.",
                            );
                        }
                        GoalFinish::Completed {
                            summary: args.summary,
                        }
                    }
                    FinishStatus::Blocked => {
                        if args
                            .summary
                            .as_deref()
                            .is_some_and(|value| !value.trim().is_empty())
                        {
                            return ToolResult::error(
                                "A blocked agent-chat goal accepts reason, not summary.",
                            );
                        }
                        GoalFinish::Blocked {
                            reason: args.reason.unwrap_or_default(),
                        }
                    }
                };
                match store.finish_goal(
                    task,
                    args.expected_revision,
                    finish,
                    crate::markdown_chat::now_ms(),
                ) {
                    Ok(goal) => goal_result(Some(&goal), true),
                    Err(error) => ToolResult::error(error),
                }
            }
        }
    }
}

fn task_store(
    context: &ToolRequestContext,
) -> Result<
    (
        &crate::project_bindings::ConversationIdentity,
        &crate::agent_automation::AgentAutomationStore,
    ),
    String,
> {
    if context.conversation.is_none()
        || context.task_conversation.is_none()
        || context.task_owner_generation.is_none()
        || context.conversation_retired
    {
        return Err(
            "Agent-chat automation requires an active stable ChatGPT conversation and task.".into(),
        );
    }
    let task = context.task_conversation.as_ref().expect("checked task");
    let store = context
        .agent_automation
        .as_deref()
        .ok_or("Agent-chat automation state is unavailable for this task")?;
    Ok((task, store))
}

fn goal_result(goal: Option<&GoalRecord>, terminal_receipt: bool) -> ToolResult {
    let (content, status, revision, markdown, summary, blocked_reason, terminal) = match goal {
        None => (
            "No agent-chat goal is configured.".to_string(),
            "absent",
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            false,
        ),
        Some(goal) => {
            let status = goal_status(goal.status);
            let content = match goal.status {
                GoalStatus::Configured => format!(
                    "Agent-chat goal revision {} is configured but not active.",
                    goal.revision
                ),
                GoalStatus::Active => format!(
                    "Agent-chat goal revision {} is active. Evaluate this exact revision while working.",
                    goal.revision
                ),
                GoalStatus::Completed => format!(
                    "Agent-chat goal revision {} is completed. This browser-driven turn may end without another chat_await.",
                    goal.revision
                ),
                GoalStatus::Blocked => format!(
                    "Agent-chat goal revision {} is blocked. This browser-driven turn may end without another chat_await.",
                    goal.revision
                ),
                GoalStatus::Error => format!(
                    "Agent-chat goal revision {} is in an unrecoverable error state.",
                    goal.revision
                ),
            };
            (
                content,
                status,
                json!(goal.revision),
                json!(goal.markdown),
                json!(goal.summary),
                json!(goal.blocked_reason),
                terminal_receipt
                    && matches!(goal.status, GoalStatus::Completed | GoalStatus::Blocked),
            )
        }
    };
    ToolResult::text(content.clone()).with_structured(json!({
        "content": content,
        "enabled": true,
        "status": status,
        "revision": revision,
        "markdown": markdown,
        "summary": summary,
        "blockedReason": blocked_reason,
        "terminal": terminal
    }))
}

fn goal_status(status: GoalStatus) -> &'static str {
    match status {
        GoalStatus::Configured => "configured",
        GoalStatus::Active => "active",
        GoalStatus::Completed => "completed",
        GoalStatus::Blocked => "blocked",
        GoalStatus::Error => "error",
    }
}
