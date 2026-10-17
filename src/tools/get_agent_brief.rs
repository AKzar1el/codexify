use async_trait::async_trait;
use serde_json::{Value, json};

use crate::exec_sessions::SessionState;
use crate::instructions::build_instructions;
use crate::tool::{Tool, ToolBehavior, ToolRequestContext, empty_object_schema};
use crate::types::{AppConfig, ToolResult};

pub struct GetAgentBrief;

#[async_trait]
impl Tool for GetAgentBrief {
    fn name(&self) -> &'static str {
        "get_agent_brief"
    }

    fn title(&self) -> String {
        "Read agent brief".to_string()
    }

    fn behavior(&self) -> ToolBehavior {
        ToolBehavior::new(
            true,
            false,
            true,
            false,
            "Reads generated workspace guidance without changing state.",
        )
    }

    fn description(&self) -> String {
        "Read this once per conversation/workspace, after selecting the workspace. Returns the full operating brief: behavior, environment, saved state, skills, and the project's AGENTS.md rules. Skip it when the brief is already in context, including when supplied through MCP instructions; do not reload it for every task. Read it again after a workspace change, relevant instruction changes, or context compaction that dropped the earlier brief. Follow it for the rest of the conversation.".into()
    }

    fn input_schema(&self) -> Value {
        empty_object_schema()
    }

    fn output_schema(&self) -> Option<Value> {
        Some(json!({
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "The operating brief: behaviour, environment, and project instructions."
                }
            },
            "required": ["content"],
            "additionalProperties": false
        }))
    }

    async fn call(&self, _args: Value, config: &AppConfig, _session: &SessionState) -> ToolResult {
        ToolResult::text(build_instructions(config))
    }

    async fn call_with_context(
        &self,
        _args: Value,
        config: &AppConfig,
        session: &SessionState,
        context: &ToolRequestContext,
    ) -> ToolResult {
        let mut brief = build_instructions(config);
        if config.markdown_chat.enabled {
            let chat = match context.markdown_chat.chat(
                config,
                context.task_conversation.as_ref(),
                session,
            ) {
                Ok(chat) => chat,
                Err(error) => return ToolResult::error(error),
            };
            if let Err(error) = chat.ensure().await {
                return ToolResult::error(error);
            }
            brief.push_str(&format!("\n\n## This task's Markdown chat\n\nCHAT.md: `{}`\n\nRead this task's new messages using chat_read whenever possible. Direct read_file or grep is for finding previous messages only and does not acknowledge new messages. You have read-only access to the transcript through ordinary file tools; send or append messages only with chat_write. Unrelated conversations and workspace-only resumptions have separate files; a full continue_task handoff keeps this task's existing file and cursor.\n", chat.path().display()));
            brief.push_str(&format!("\n\n## Durable progress\n\nrollout.md: `{}`\n\n{} Read with rollout_read before work in every new turn or after context loss. Append status, concrete progress and verification, and next steps with rollout_update when reminded, before a planned handoff, and at meaningful milestones. Do not replace or edit old reports. Only recent reports are loaded; dated archives preserve older history.\n", chat.path().with_file_name("rollout.md").display(), crate::markdown_chat::rollout::RESTORE_GUIDANCE));
        }
        if config.markdown_chat.automation.enabled
            && let (Some(task), Some(store)) = (
                context.task_conversation.as_ref(),
                context.agent_automation.as_deref(),
            )
        {
            match store.load(task) {
                Ok(state)
                    if state.goal.as_ref().is_some_and(|goal| {
                        goal.status == crate::agent_automation::GoalStatus::Active
                    }) =>
                {
                    brief.push_str("\n\n## Active agent-chat goal\n\n- Call `goal_read` before goal work to obtain the exact current revision.\n- Continue using `chat_read`, `chat_write`, and `chat_await` for owner communication.\n- During each offline browser wake-up, evaluate the current goal in the same turn.\n- Call `goal_finish` only for the exact current revision when it is completed or genuinely blocked.\n- A blocked goal requires a concrete reason.\n- Do not request a separate turn merely to assess completion.\n- Do not treat an ordinary final answer as goal completion. A successful `goal_finish` receipt is the browser-driven turn's explicit terminal condition.\n");
                    brief.push_str("- The read-only-tools and concurrent-work exceptions under Turn handoffs also authorize ending the turn; a turn handoff is not goal completion.\n");
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(%error, "could not read agent automation state for the agent brief");
                }
            }
        }
        ToolResult::text(brief)
    }
}
