use crate::exec_sessions::SessionState;
use crate::tool::{Tool, ToolBehavior, ToolRequestContext, empty_object_schema, parse_tool_args};
use crate::types::{AppConfig, ToolResult};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};

pub enum RolloutTool {
    Read,
    Update,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateArgs {
    request_id: String,
    status: String,
    progress: String,
    next_steps: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArgs {}
#[async_trait]
impl Tool for RolloutTool {
    fn manages_model_output_budget(&self) -> bool {
        matches!(self, Self::Read)
    }
    fn name(&self) -> &'static str {
        match self {
            Self::Read => "rollout_read",
            Self::Update => "rollout_update",
        }
    }
    fn title(&self) -> String {
        match self {
            Self::Read => "Read recent chat progress",
            Self::Update => "Append a progress checkpoint",
        }
        .into()
    }
    fn description(&self) -> String {
        match self {
  Self::Read=>"Read up to five recent progress reports from this chat's rollout.md, bounded to 64 KiB and spanning rotated archives when necessary. Call at the start of each new turn and after context loss, before task work. Use the current goal too, if configured. This does not read queued messages or acknowledge CHAT.md.",
  Self::Update=>"Append to this chat's chronological activity timeline in rollout.md. Record what was done or learned, what is underway, and what comes next or is blocked. Reports may reference supporting files. Update regularly and whenever rollout_checkpoint_required appears in a tool result. Use a fresh request_id for each report; reuse it only for an identical retry. Reports rotate automatically at 256 KiB or 50 reports. This does not change the goal, send a chat message, complete a turn, or expose queued messages."
 }.into()
    }
    fn behavior(&self) -> ToolBehavior {
        match self {
            Self::Read => ToolBehavior::new(
                true,
                false,
                true,
                false,
                "Reads this task's own saved progress.",
            ),
            Self::Update => ToolBehavior::new(
                false,
                false,
                true,
                false,
                "Appends one idempotent progress report outside the project and preserves rotated history.",
            ),
        }
    }
    fn may_modify_project(&self) -> bool {
        false
    }
    fn input_schema(&self) -> Value {
        match self {
            Self::Read => empty_object_schema(),
            Self::Update => json!({"type":"object","properties":{
 "request_id":{"type":"string","minLength":1,"maxLength":80,"pattern":"^[A-Za-z0-9_-]+$","description":"Unique report identity, reused only for an identical retry."},
 "status":{"type":"string","minLength":1,"maxLength":16384,"writeOnly":true,"description":"What is currently happening or blocked."},"progress":{"type":"string","minLength":1,"maxLength":16384,"writeOnly":true,"description":"What was done or learned since the previous report; may reference supporting files."},"next_steps":{"type":"string","minLength":1,"maxLength":16384,"writeOnly":true,"description":"Intended next actions or input needed to proceed."}
 },"required":["request_id","status","progress","next_steps"],"additionalProperties":false}),
        }
    }
    fn output_schema(&self) -> Option<Value> {
        Some(match self {
            Self::Read => {
                json!({"type":"object","properties":{"rollout_file":{"type":"string"},"report_count":{"type":"integer","minimum":0},"content":{"type":"string"},"archive_count":{"type":"integer","minimum":0}},"required":["rollout_file","report_count","content","archive_count"],"additionalProperties":false})
            }
            Self::Update => {
                json!({"type":"object","properties":{"rollout_file":{"type":"string"},"request_id":{"type":"string"},"created_at_ms":{"type":"integer","minimum":0},"already_recorded":{"type":"boolean"},"rotated_archive":{"type":["string","null"]}},"required":["rollout_file","request_id","created_at_ms","already_recorded","rotated_archive"],"additionalProperties":false})
            }
        })
    }
    async fn call(&self, _: Value, _: &AppConfig, _: &SessionState) -> ToolResult {
        ToolResult::error("Progress reports require chat context.")
    }
    async fn call_with_context(
        &self,
        args: Value,
        config: &AppConfig,
        session: &SessionState,
        context: &ToolRequestContext,
    ) -> ToolResult {
        if context.cancellation.is_cancelled() {
            return ToolResult::error("Progress operation was cancelled.");
        }
        let chat =
            match context
                .markdown_chat
                .chat(config, context.task_conversation.as_ref(), session)
            {
                Ok(c) => c,
                Err(e) => return ToolResult::error(e),
            };
        let result = match self {
            Self::Read => {
                if let Err(e) = parse_tool_args::<EmptyArgs>(args) {
                    return *e;
                }
                chat.read_rollout()
                    .await
                    .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
            }
            Self::Update => {
                let a: UpdateArgs = match parse_tool_args(args) {
                    Ok(a) => a,
                    Err(e) => return *e,
                };
                chat.append_rollout(a.request_id, a.status, a.progress, a.next_steps)
                    .await
                    .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
            }
        };
        match result {
            Ok(value) => {
                let mut result=ToolResult::text(match self {Self::Read=>value["content"].as_str().filter(|s|!s.is_empty()).unwrap_or("No progress reports yet. Start with the user's current request and goal."),Self::Update=>"Progress checkpoint saved. Continue with the current request and next steps."}).with_structured(value);
                result.audit.sensitive_output = true;
                result
            }
            Err(e) => ToolResult::error(e),
        }
    }
}
