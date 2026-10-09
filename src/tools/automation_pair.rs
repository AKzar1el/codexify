use async_trait::async_trait;
use serde_json::{Value, json};

use crate::exec_sessions::SessionState;
use crate::tool::{Tool, ToolBehavior};
use crate::types::{AppConfig, ToolResult};

pub struct AutomationVerifyPairing;

#[async_trait]
impl Tool for AutomationVerifyPairing {
    fn name(&self) -> &'static str {
        "automation_verify_pairing"
    }

    fn title(&self) -> String {
        "Verify agent-chat pairing".into()
    }

    fn description(&self) -> String {
        "Consume the one-time pairing reference sent by Codexify's standalone agent chat. The call verifies only that this already-authorized ChatGPT conversation owns the intended Codexify task; it does not transfer task ownership or authorize setup.".into()
    }

    fn behavior(&self) -> ToolBehavior {
        ToolBehavior::new(
            false,
            false,
            false,
            false,
            "Consumes one task-scoped pairing reference without modifying project files or external systems.",
        )
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "reference": {
                    "type": "string",
                    "minLength": 32,
                    "maxLength": 256,
                    "pattern": "^[A-Za-z0-9_-]+$",
                    "writeOnly": true,
                    "description": "The one-time pairing reference supplied by the standalone Codexify chat."
                }
            },
            "required": ["reference"],
            "additionalProperties": false
        })
    }

    fn requires_project_root(&self) -> bool {
        false
    }

    async fn call(&self, _: Value, config: &AppConfig, _: &SessionState) -> ToolResult {
        if !config.markdown_chat.automation.enabled {
            return ToolResult::error("Agent-chat browser automation is disabled.");
        }
        ToolResult::error("No agent-chat pairing request is pending.")
    }
}
