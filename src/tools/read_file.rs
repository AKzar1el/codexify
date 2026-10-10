use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::exec_sessions::SessionState;
use crate::output_budget::{file_budget, window_file_lines};
use crate::safe_path::resolve_safe_path;
use crate::tool::{
    Tool, ToolBehavior, ToolRequestContext, parse_tool_args, schema_for, text_output_schema,
};
use crate::types::{AppConfig, ToolResult};

pub struct ReadFile;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReadFileArgs {
    /// Project-relative file path.
    #[schemars(length(min = 1))]
    path: String,
    /// Zero-based first line. Defaults to 0.
    offset: Option<u64>,
    /// Maximum lines to return before the server's own line and byte ceilings.
    limit: Option<u64>,
    #[serde(rename = "timeoutMs")]
    _timeout_ms: Option<u64>,
}

#[async_trait]
impl Tool for ReadFile {
    fn name(&self) -> &'static str {
        "read_file"
    }

    fn title(&self) -> String {
        "Read file".to_string()
    }

    fn behavior(&self) -> ToolBehavior {
        ToolBehavior::new(
            true,
            false,
            true,
            false,
            "Reads one project file without changing local or external state.",
        )
    }

    fn description(&self) -> String {
        "Read the contents of a file. Path is relative to the project root (work-dir). Output is prefixed with line numbers (e.g. '1\\tconst x = 1'). Large files come back a window at a time; when the result says so, call again with the offset it names. Use this tool to inspect source code, configs, or any text file before making changes.".into()
    }

    fn input_schema(&self) -> Value {
        schema_for::<ReadFileArgs>()
    }

    fn output_schema(&self) -> Option<Value> {
        Some(text_output_schema())
    }

    async fn call(&self, args: Value, config: &AppConfig, _session: &SessionState) -> ToolResult {
        config
            .filesystem_worker
            .run(
                crate::filesystem::Operation::ReadFile,
                args,
                config,
                &tokio_util::sync::CancellationToken::new(),
                None,
            )
            .await
    }

    async fn call_with_context(
        &self,
        args: Value,
        config: &AppConfig,
        session: &SessionState,
        context: &ToolRequestContext,
    ) -> ToolResult {
        match crate::markdown_chat::history_call(&args, config, session, context).await {
            Ok(Some((args, history_config))) => {
                let mut result = history_config
                    .filesystem_worker
                    .run(
                        crate::filesystem::Operation::ReadFile,
                        args,
                        &history_config,
                        &context.cancellation,
                        None,
                    )
                    .await;
                result.audit.sensitive_output = true;
                result
            }
            Ok(None) => {
                config
                    .filesystem_worker
                    .run(
                        crate::filesystem::Operation::ReadFile,
                        args,
                        config,
                        &context.cancellation,
                        None,
                    )
                    .await
            }
            Err(error) => ToolResult::error(error),
        }
    }
}

impl ReadFile {
    pub(crate) fn run_inner(args: Value, config: &AppConfig) -> ToolResult {
        let ReadFileArgs {
            path,
            offset,
            limit,
            _timeout_ms: _,
        } = match parse_tool_args(args) {
            Ok(args) => args,
            Err(error) => return *error,
        };
        let file_path = match resolve_safe_path(&path, &config.work_dir, false) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        let metadata = match std::fs::metadata(&file_path) {
            Ok(meta) if meta.is_file() => meta,
            _ => return ToolResult::error(format!("File not found or not a regular file: {path}")),
        };
        let budget = file_budget(config);
        let offset = usize::try_from(offset.unwrap_or(0)).unwrap_or(usize::MAX);
        let limit = limit.map(|value| usize::try_from(value).unwrap_or(usize::MAX));
        let small = metadata.len()
            <= (crate::output_budget::DEFAULT_MAX_FILE_BYTES as u64)
                .min(config.filesystem.max_scan_bytes);
        let mut reader = match crate::filesystem::Lines::open(&file_path) {
            Ok(reader) => reader,
            Err(error) => return ToolResult::error(error.to_string()),
        };
        let mut lines = Vec::new();
        let mut index = 0usize;
        let mut bytes = 0usize;
        let wanted = limit.unwrap_or(budget.max_lines).min(budget.max_lines);
        loop {
            let line = match reader.next() {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(error) => return ToolResult::error(error.to_string()),
            };
            if small || index >= offset {
                bytes = bytes.saturating_add(line.len() + 1);
                lines.push(line);
                if !small && (lines.len() > wanted || bytes > budget.max_bytes) {
                    break;
                }
            }
            index = index.saturating_add(1);
        }
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let window = window_file_lines(&refs, if small { offset } else { 0 }, limit, budget);
        let first = if small { window.start } else { offset };
        let numbered = window
            .lines
            .iter()
            .enumerate()
            .map(|(i, line)| format!("{}\t{}", first.saturating_add(i).saturating_add(1), line))
            .collect::<Vec<_>>()
            .join("\n");
        let notice = if small {
            window.notice
        } else if window.notice.is_some() {
            Some(format!(
                "(showing a bounded window starting at line {} — call again with offset={} for the rest; total lines were not scanned)",
                first.saturating_add(1),
                first.saturating_add(window.lines.len())
            ))
        } else {
            None
        };
        let truncated = notice.is_some();
        let body = notice.map_or_else(
            || numbered.clone(),
            |notice| format!("{numbered}\n\n{notice}"),
        );
        ToolResult::text(body).with_truncation(truncated)
    }
}
