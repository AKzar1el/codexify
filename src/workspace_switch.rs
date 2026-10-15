use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChange {
    pub revision: String,
    pub previous_root: PathBuf,
    pub awaiting_selection: bool,
}

impl WorkspaceChange {
    pub fn notice(&self, active: Option<&Path>) -> String {
        match active {
            Some(path) => format!(
                "The user switched this Codexify task's workspace. Previous path: {}. Current path: {}. Stop using the previous workspace assumptions. Before further project work, call get_agent_brief to load the new environment, AGENTS.md, skills and saved state, then recall as needed. Existing files and running commands in the previous workspace were not moved or deleted.",
                self.previous_root.display(),
                path.display()
            ),
            None => format!(
                "The user opened workspace selection. The previous workspace ({}) is no longer selected. Do not select scratch or guess a project. Leave the setup picker open; use chat_await to wait for the user's selection. Existing files were preserved.",
                self.previous_root.display()
            ),
        }
    }

    pub(crate) fn new(previous_root: PathBuf) -> Self {
        Self {
            revision: format!(
                "{}-{}",
                chrono::Utc::now().timestamp_micros(),
                ATOMIC_COUNTER.fetch_add(1, Ordering::SeqCst)
            ),
            previous_root,
            awaiting_selection: true,
        }
    }
}

impl ProjectBindingStore {
    /// Change only the workspace binding; the chat and automation state keep
    /// their original directory and the agent must acknowledge the new root.
    pub(crate) async fn change_owner_workspace(
        &self,
        config: &AppConfig,
        identity: &ConversationIdentity,
        expected_path: &Path,
        path: &Path,
        state_root: &Path,
    ) -> Result<PathBuf, String> {
        if !config.multi_project {
            return Err("Workspace editing requires multi-project mode.".into());
        }
        if !path.is_absolute() {
            return Err("Enter an absolute project directory.".into());
        }
        let (access_root, source_root, root, managed, git_root, worktrees_root) =
            match resolve_project_root(config, &path.to_string_lossy()) {
                Ok((access, root)) => (access, root.clone(), root, false, None, None),
                Err(direct_error) => {
                    let ProjectBindingState::Project(selection) =
                        self.binding_state(config, identity)?
                    else {
                        return Err(direct_error);
                    };
                    let choice = crate::worktrees::existing_worktree_choice(
                        config,
                        &selection.source_project_root,
                        path,
                    )
                    .await
                    .map_err(|_| direct_error)?;
                    let worktrees_root = if choice.managed_worktree {
                        Some(
                            load_metadata(
                                &metadata_path_for_worktree(&choice.git_root)
                                    .ok_or("Missing worktree metadata")?,
                            )?
                            .worktrees_root,
                        )
                    } else {
                        None
                    };
                    (
                        selection.access_root,
                        selection.source_project_root,
                        choice.path,
                        choice.managed_worktree,
                        Some(choice.git_root),
                        worktrees_root,
                    )
                }
            };
        let expected_path =
            std::fs::canonicalize(expected_path).map_err(|error| error.to_string())?;
        let binding_path = self.binding_path(&access_root, identity);
        let _lock = acquire_lock(&binding_path).await?;
        let current = self
            .selected_project_root(config, identity)?
            .unwrap_or_else(|| expected_path.clone());
        if current != expected_path {
            return Err("The project path changed. Refresh before saving.".into());
        }
        if current == root {
            return Ok(root);
        }
        if !state_root.is_absolute()
            || !state_root
                .join("chats")
                .join(identity.stable_key())
                .join("CHAT.md")
                .is_file()
        {
            return Err("The conversation state directory is unavailable.".into());
        }
        let stored = StoredProjectBinding {
            version: BINDING_VERSION,
            access_root: access_root.to_string_lossy().into_owned(),
            project_root: root.to_string_lossy().into_owned(),
            source_project_root: Some(source_root.to_string_lossy().into_owned()),
            state_root: Some(state_root.to_string_lossy().into_owned()),
            repository_url: None,
            managed_worktree: managed,
            worktree_git_root: git_root.map(|root| root.to_string_lossy().into_owned()),
            worktrees_root,
        };
        // Keep the previous binding recoverable before publishing the change.
        let mut change = WorkspaceChange::new(current);
        let archive = self
            .access_root_dir(&access_root)
            .join("previous-workspaces")
            .join(&change.revision);
        std::fs::create_dir_all(&archive).map_err(|error| error.to_string())?;
        for previous in self.active_record_paths(&access_root, identity) {
            if previous.is_file() {
                std::fs::copy(
                    &previous,
                    archive.join(previous.file_name().ok_or("Invalid binding filename")?),
                )
                .map_err(|error| error.to_string())?;
            }
        }
        self.save_change(&access_root, identity, &change)?;
        self.write_binding(&binding_path, &stored)?;
        let scratch = self.without_project_path(&access_root, identity);
        if scratch.exists() {
            std::fs::remove_file(scratch).map_err(|error| error.to_string())?;
        }
        change.awaiting_selection = false;
        self.save_change(&access_root, identity, &change)?;
        Ok(root)
    }

    pub async fn dispatch_workspace(
        &self,
        config: &AppConfig,
        identity: &ConversationIdentity,
    ) -> Result<(Option<PathBuf>, Option<WorkspaceChange>), String> {
        if !config.multi_project {
            return Ok((Some(config.work_dir.clone()), None));
        }
        let root = canonical_access_root(config)?;
        let _lock = acquire_lock(&self.binding_path(&root, identity)).await?;
        Ok((
            self.selected_project_root(config, identity)?,
            self.pending_change_at(&root, identity)?,
        ))
    }

    pub async fn reuse_worktree(
        &self,
        config: &AppConfig,
        identity: &ConversationIdentity,
        project: &str,
        path: &Path,
    ) -> Result<ProjectRootSelection, String> {
        let (root, source) = resolve_project_root(config, project)?;
        let binding_path = self.binding_path(&root, identity);
        let _lock = acquire_lock(&binding_path).await?;
        self.clear_suspended_selection(&root, identity)?;
        let choice = crate::worktrees::existing_worktree_choice(config, &source, path).await?;
        if let Some(existing) = self.selected_project_root(config, identity)? {
            if existing == choice.path
                && let ProjectBindingState::Project(selection) =
                    self.binding_state(config, identity)?
            {
                return Ok(selection);
            }
            return Err("Use Switch to another project in the setup card before choosing a different worktree.".into());
        }
        let metadata = if choice.managed_worktree {
            Some(load_metadata(
                &metadata_path_for_worktree(&choice.git_root)
                    .ok_or("Missing managed-worktree metadata")?,
            )?)
        } else {
            None
        };
        let stored = StoredProjectBinding {
            version: BINDING_VERSION,
            state_root: None,
            access_root: root.to_string_lossy().into_owned(),
            source_project_root: Some(source.to_string_lossy().into_owned()),
            project_root: choice.path.to_string_lossy().into_owned(),
            repository_url: None,
            managed_worktree: choice.managed_worktree,
            worktree_git_root: (!choice.source_checkout)
                .then(|| choice.git_root.to_string_lossy().into_owned()),
            worktrees_root: metadata.map(|meta| meta.worktrees_root),
        };
        let parent = binding_path.parent().ok_or("Missing binding directory")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut temp =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut temp, &stored).map_err(|error| error.to_string())?;
        temp.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        let resolved = self
            .read_binding(temp.path(), &root)?
            .ok_or("Worktree binding disappeared")?;
        temp.persist(&binding_path)
            .map_err(|error| error.to_string())?;
        self.finish_workspace_selection(&root, identity)?;
        let _ = crate::worktrees::touch_workspace(config, &choice.path);
        Ok(selection_from_binding(root, resolved, config.worktrees.mode, true, false,
            ProjectBindingScope::ChatGptConversation,
            vec!["Reusing the selected worktree unchanged. Other conversations may still use it; avoid concurrent edits.".into()]))
    }

    fn change_path(&self, access_root: &Path, identity: &ConversationIdentity) -> PathBuf {
        self.binding_path(access_root, identity)
            .with_extension("workspace-change")
    }

    pub(super) fn pending_change_at(
        &self,
        access_root: &Path,
        identity: &ConversationIdentity,
    ) -> Result<Option<WorkspaceChange>, String> {
        let path = self.change_path(access_root, identity);
        match std::fs::read(&path) {
            Ok(bytes) if bytes.len() <= 16_384 => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|error| format!("Invalid workspace-change record: {error}")),
            Ok(_) => Err("Workspace-change record is oversized".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("Cannot read workspace-change record: {error}")),
        }
    }

    pub fn pending_workspace_change(
        &self,
        config: &AppConfig,
        identity: &ConversationIdentity,
    ) -> Result<Option<WorkspaceChange>, String> {
        if !config.multi_project {
            return Ok(None);
        }
        self.pending_change_at(&canonical_access_root(config)?, identity)
    }

    fn save_change(
        &self,
        access_root: &Path,
        identity: &ConversationIdentity,
        change: &WorkspaceChange,
    ) -> Result<(), String> {
        let path = self.change_path(access_root, identity);
        let parent = path.parent().ok_or("Missing workspace-change directory")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut temp =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut temp, change).map_err(|error| error.to_string())?;
        temp.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        temp.persist(path).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn active_record_paths(&self, root: &Path, identity: &ConversationIdentity) -> [PathBuf; 3] {
        [
            self.binding_path(root, identity),
            self.without_project_path(root, identity),
            self.legacy_binding_path(root, identity),
        ]
    }

    pub(super) fn clear_suspended_selection(
        &self,
        root: &Path,
        identity: &ConversationIdentity,
    ) -> Result<(), String> {
        if !self
            .pending_change_at(root, identity)?
            .is_some_and(|change| change.awaiting_selection)
        {
            return Ok(());
        }
        for path in self.active_record_paths(root, identity) {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("Cannot clear previous workspace binding: {error}"));
                }
            }
        }
        Ok(())
    }

    pub(super) fn finish_workspace_selection(
        &self,
        root: &Path,
        identity: &ConversationIdentity,
    ) -> Result<(), String> {
        if let Some(mut change) = self.pending_change_at(root, identity)? {
            change.awaiting_selection = false;
            self.save_change(root, identity, &change)?;
        }
        Ok(())
    }

    pub async fn switch_to_picker(
        &self,
        config: &AppConfig,
        identity: &ConversationIdentity,
        expected_path: &Path,
    ) -> Result<(), String> {
        if !config.multi_project {
            return Err("Workspace switching requires multi-project mode".into());
        }
        let root = canonical_access_root(config)?;
        let _lock = acquire_lock(&self.binding_path(&root, identity)).await?;
        if let Some(change) = self.pending_change_at(&root, identity)?
            && change.awaiting_selection
            && change.previous_root == expected_path
        {
            return self.clear_suspended_selection(&root, identity);
        }
        let current = self
            .selected_project_root(config, identity)?
            .ok_or("No workspace is selected")?;
        if current != expected_path {
            return Err(
                "Workspace changed since this card was displayed. Refresh it before switching."
                    .into(),
            );
        }
        let change = WorkspaceChange::new(current);
        let archive = self
            .access_root_dir(&root)
            .join("previous-workspaces")
            .join(&change.revision);
        std::fs::create_dir_all(&archive).map_err(|error| error.to_string())?;
        for path in self.active_record_paths(&root, identity) {
            if path.is_file() {
                std::fs::copy(
                    &path,
                    archive.join(path.file_name().ok_or("Invalid binding filename")?),
                )
                .map_err(|error| error.to_string())?;
            }
        }
        // Suspending first prevents a partially completed reset from dispatching into the old root.
        self.save_change(&root, identity, &change)?;
        self.clear_suspended_selection(&root, identity)
    }

    pub async fn acknowledge_workspace_change(
        &self,
        config: &AppConfig,
        identity: &ConversationIdentity,
        revision: &str,
        active_root: &Path,
    ) -> Result<(), String> {
        let root = canonical_access_root(config)?;
        let _lock = acquire_lock(&self.binding_path(&root, identity)).await?;
        if self
            .pending_change_at(&root, identity)?
            .is_some_and(|change| !change.awaiting_selection && change.revision == revision)
            && self.selected_project_root(config, identity)?.as_deref() == Some(active_root)
        {
            std::fs::remove_file(self.change_path(&root, identity))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub(super) fn previous_binding_files(&self, root: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(self.access_root_dir(root).join("previous-workspaces"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .flat_map(|entry| {
                std::fs::read_dir(entry.path())
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|entry| entry.path())
            })
            .collect()
    }

    pub(super) fn saved_binding_files(&self, root: &Path) -> Vec<PathBuf> {
        self.binding_files(root)
            .into_iter()
            .chain(
                self.previous_binding_files(root)
                    .into_iter()
                    .filter(|path| path.extension().is_some_and(|ext| ext == "json")),
            )
            .collect()
    }
}

#[cfg(test)]
mod owner_workspace_tests {
    use super::*;

    #[tokio::test]
    async fn editing_a_project_keeps_task_state_and_survives_reopening_the_binding() {
        let temp = tempfile::tempdir().unwrap();
        let access = temp.path().join("projects");
        let first = access.join("first");
        let second = access.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let mut config = crate::config::default_config(access.clone());
        config.multi_project = true;
        config.worktrees.mode = crate::types::WorktreeMode::Never;
        config.memory.dir = Some(temp.path().join("state").to_string_lossy().into_owned());
        config.markdown_chat.enabled = true;
        let base = temp.path().join("bindings");
        let bindings = ProjectBindingStore::new(base.clone());
        let task = ConversationIdentity::from_openai_session("owner-project-edit").unwrap();
        bindings
            .select_project_root(&config, &task, first.to_str().unwrap())
            .await
            .unwrap();
        let effective = bindings.effective_config(&config, &task).unwrap();
        let state_root = crate::memory::memory_dir(&effective);
        let chats = crate::markdown_chat::MarkdownChatStore::default();
        let session = crate::exec_sessions::SessionState::new();
        let chat = chats.chat(&effective, Some(&task), &session).unwrap();
        chat.append("Keep the current conversation".into())
            .await
            .unwrap();
        let store = crate::agent_automation::AgentAutomationStore::for_config(&effective).unwrap();
        store.set_goal(&task, "Keep the current goal", 100).unwrap();
        bindings
            .change_owner_workspace(&config, &task, &first, &second, &state_root)
            .await
            .unwrap();
        let reopened = ProjectBindingStore::new(base);
        let updated = reopened.effective_config(&config, &task).unwrap();
        assert_eq!(updated.work_dir, std::fs::canonicalize(&second).unwrap());
        assert_eq!(crate::memory::task_state_dir(&updated), state_root);
        assert_ne!(crate::memory::memory_dir(&updated), state_root);
        assert_eq!(
            chats.chat(&updated, Some(&task), &session).unwrap().path(),
            chat.path()
        );
        assert_eq!(
            crate::agent_automation::AgentAutomationStore::for_config(&updated)
                .unwrap()
                .load(&task)
                .unwrap()
                .goal
                .unwrap()
                .markdown,
            "Keep the current goal"
        );
        assert!(
            reopened
                .pending_workspace_change(&config, &task)
                .unwrap()
                .is_some()
        );
        assert!(
            reopened
                .change_owner_workspace(&config, &task, &first, &second, &state_root)
                .await
                .is_err()
        );
        assert!(
            reopened
                .change_owner_workspace(&config, &task, &second, temp.path(), &state_root)
                .await
                .is_err()
        );
        assert_eq!(
            reopened
                .selected_project_root(&config, &task)
                .unwrap()
                .unwrap(),
            updated.work_dir
        );
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&second)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "initial",
        ]);
        let worktree = temp.path().join("registered-worktree");
        git(&[
            "worktree",
            "add",
            "-q",
            "--detach",
            worktree.to_str().unwrap(),
        ]);
        reopened
            .change_owner_workspace(&config, &task, &second, &worktree, &state_root)
            .await
            .unwrap();
        let worktree_config = reopened.effective_config(&config, &task).unwrap();
        assert_eq!(
            worktree_config.work_dir,
            std::fs::canonicalize(worktree).unwrap()
        );
        assert_eq!(crate::memory::task_state_dir(&worktree_config), state_root);
    }
}
