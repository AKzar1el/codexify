use async_trait::async_trait;
use serde_json::{Value, json};

use crate::exec_sessions::SessionState;
use crate::tool::{Tool, ToolBehavior, empty_object_schema};
use crate::types::{AppConfig, ToolResult};

#[derive(Clone, Copy)]
pub enum GoalTool {
    Read,
    Finish,
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
                        "maxLength": 4096
                    },
                    "reason": {
                        "type": "string",
                        "maxLength": 4096
                    }
                },
                "required": ["expectedRevision", "status"],
                "additionalProperties": false
            }),
        }
    }

    fn requires_project_root(&self) -> bool {
        false
    }

    async fn call(&self, _: Value, config: &AppConfig, _: &SessionState) -> ToolResult {
        if !config.markdown_chat.automation.enabled {
            return ToolResult::error("Agent-chat browser automation is disabled.");
        }
        match self {
            Self::Read => ToolResult::text("No agent-chat goal is configured."),
            Self::Finish => ToolResult::error("No active agent-chat goal is configured."),
        }
    }
}
