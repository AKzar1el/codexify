use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

use crate::exec_sessions::SessionState;
use crate::ignore_rules::build_ignore;
use crate::output_budget::{entry_budget, limit_list};
use crate::safe_path::resolve_safe_path;
use crate::tool::{Tool, ToolBehavior, parse_tool_args, schema_for, text_output_schema};
use crate::types::{AppConfig, ToolResult};

pub struct ListDirectory;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ListDirectoryArgs {
    /// Project-relative directory. Defaults to the project root.
    path: Option<String>,
    #[serde(rename = "timeoutMs")]
    _timeout_ms: Option<u64>,
}

#[async_trait]
impl Tool for ListDirectory {
    fn name(&self) -> &'static str {
        "list_directory"
    }

    fn title(&self) -> String {
        "List directory".to_string()
    }

    fn behavior(&self) -> ToolBehavior {
        ToolBehavior::new(
            true,
            false,
            true,
            false,
            "Lists local directory entries without modifying filesystem state.",
        )
    }

    fn description(&self) -> String {
        "List all files and subdirectories in a directory with their type (file/dir) and size. Returns tab-separated lines. Use this to inspect a specific directory's contents in detail, unlike tree which shows the full hierarchy.".into()
    }

    fn input_schema(&self) -> Value {
        schema_for::<ListDirectoryArgs>()
    }

    fn output_schema(&self) -> Option<Value> {
        Some(text_output_schema())
    }

    async fn call(&self, args: Value, config: &AppConfig, _session: &SessionState) -> ToolResult {
        config
            .filesystem_worker
            .run(
                crate::filesystem::Operation::ListDirectory,
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
        _session: &SessionState,
        context: &crate::tool::ToolRequestContext,
    ) -> ToolResult {
        config
            .filesystem_worker
            .run(
                crate::filesystem::Operation::ListDirectory,
                args,
                config,
                &context.cancellation,
                None,
            )
            .await
    }
}
impl ListDirectory {
    pub(crate) fn run_inner(args: Value, config: &AppConfig) -> ToolResult {
        let ListDirectoryArgs {
            path,
            _timeout_ms: _,
        } = match parse_tool_args(args) {
            Ok(args) => args,
            Err(error) => return *error,
        };
        // Treat an empty-string path the same as an absent one (TS falsy check).
        let dir_path: PathBuf = match path.as_deref().filter(|path| !path.is_empty()) {
            Some(p) => match resolve_safe_path(p, &config.work_dir, false) {
                Ok(resolved) => resolved,
                Err(e) => return ToolResult::error(e),
            },
            None => config.work_dir.clone(),
        };

        let ig = build_ignore(config);
        // Escape hatch: when the caller points `path` straight at an ignored
        // directory (e.g. list_directory node_modules), show its contents rather
        // than an empty listing. Filtering only hides ignored entries from an
        // otherwise-visible directory.
        let target_ignored = ig.is_ignored(&dir_path, true);

        let mut rd = match std::fs::read_dir(&dir_path) {
            Ok(r) => r,
            Err(e) => return ToolResult::error(e.to_string()),
        };

        let mut all: Vec<(String, bool)> = Vec::new();
        for entry in rd.by_ref() {
            if !crate::filesystem::visit_entry() {
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => return ToolResult::error(error.to_string()),
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            all.push((name, is_dir));
        }

        all.retain(|(name, is_dir)| {
            target_ignored || !ig.is_ignored(&dir_path.join(name), *is_dir)
        });
        all.sort_by(|a, b| a.0.cmp(&b.0));

        // Cut before stat()ing, so a directory with 50k files does not cost 50k
        // syscalls to produce output that would be thrown away anyway.
        let (entries, dropped) = limit_list(all, entry_budget(config));
        let mut lines: Vec<String> = Vec::new();

        for (name, is_dir) in &entries {
            if *is_dir {
                lines.push(format!("dir\t-\t{name}/"));
            } else {
                let meta = match std::fs::metadata(dir_path.join(name)) {
                    Ok(m) => m,
                    Err(e) => return ToolResult::error(e.to_string()),
                };
                lines.push(format!("file\t{}\t{name}", format_size(meta.len())));
            }
        }

        if lines.is_empty() {
            return ToolResult::text("Directory is empty.");
        }

        let text = if dropped > 0 {
            format!(
                "{}\n\n(showing {} of {} entries \u{2014} use glob for a filtered view)",
                lines.join("\n"),
                lines.len(),
                lines.len() + dropped
            )
        } else {
            lines.join("\n")
        };
        ToolResult::text(text).with_truncation(dropped > 0)
    }
}

fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}
