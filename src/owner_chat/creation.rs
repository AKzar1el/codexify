use super::*;
use crate::project_bindings::WorkspaceSelection;
use crate::tools::set_project_root::selection_config;

#[derive(Deserialize)]
pub(super) struct ProjectQuery {
    q: Option<String>,
}

pub(super) async fn projects(
    State(state): State<OwnerState>,
    Query(query): Query<ProjectQuery>,
) -> ApiResult {
    let config = state.config.clone();
    let catalog = tokio::task::spawn_blocking(move || {
        crate::project_catalog::discover_project_catalog(&config)
    })
    .await
    .map_err(internal_error)?
    .map_err(internal_error)?;
    let listing = catalog.list(query.q.as_deref(), 50);
    Ok(Json(
        json!({"catalog":listing,"createWorktree":state.config.worktrees.mode != crate::types::WorktreeMode::Never}),
    ))
}

#[derive(Deserialize)]
pub(super) struct WorktreeQuery {
    path: String,
}

pub(super) async fn worktrees(
    State(state): State<OwnerState>,
    Query(query): Query<WorktreeQuery>,
) -> ApiResult {
    let (_, root) = crate::project_bindings::resolve_project_root(&state.config, &query.path)
        .map_err(internal_error)?;
    let rows = crate::worktrees::list_existing_worktrees(&state.config, &root)
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({"sourcePath":root,"worktrees":rows})))
}

pub(super) async fn login(
    State(state): State<OwnerState>,
    Json(_body): Json<serde_json::Map<String, Value>>,
) -> ApiResult {
    let companion = crate::agent_automation::BrowserCompanionManager::from_config(
        &state.config.markdown_chat.automation,
    )
    .map_err(internal_error)?
    .login()
    .await
    .map_err(internal_error)?;
    state.global.lock().await.reset_plan();
    Ok(Json(json!({"authenticated":companion.authenticated})))
}

pub(super) async fn prepare_chat(
    State(state): State<OwnerState>,
    Json(_body): Json<serde_json::Map<String, Value>>,
) -> ApiResult {
    require_connector_name(&state.config)?;
    if !state.config.markdown_chat.automation.enabled {
        return Err(internal_error(
            "Enable agentChat.automation to create ChatGPT conversations",
        ));
    }
    let supervisor = state
        .automation
        .as_ref()
        .ok_or_else(|| internal_error("Browser automation supervisor is unavailable"))?;
    let catalog = supervisor
        .prepare_new_chat(
            state
                .config
                .markdown_chat
                .automation
                .chatgpt_project_url
                .as_deref(),
        )
        .await
        .map_err(internal_error)?;
    let health = companion_client(&state)?
        .health(&CancellationToken::new())
        .await
        .map_err(internal_error)?;
    if !health.authenticated
        || health.account_fingerprint.as_deref() != Some(catalog.account_fingerprint.as_str())
    {
        return Err(internal_error(
            "ChatGPT account changed while preparing the new chat",
        ));
    }
    let entry = OwnerCatalogCache {
        key: catalog_context(&health),
        catalog: catalog.clone(),
    };
    write_catalog_cache(&state, &entry).map_err(internal_error)?;
    *state.catalog_cache.lock().await = Some(entry);
    Ok(Json(
        json!({"models":catalog.models,"catalogRevision":catalog.catalog_revision,"chatgptProjectUrl":state.config.markdown_chat.automation.chatgpt_project_url,"workspaceName":state.config.work_dir.file_name().map(|name|name.to_string_lossy()),"createWorktree":state.config.worktrees.mode != crate::types::WorktreeMode::Never}),
    ))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreateBody {
    request_id: String,
    path: Option<String>,
    without_project: Option<bool>,
    create_worktree: Option<bool>,
    resume_path: Option<String>,
    worktree_path: Option<String>,
    model: String,
    effort: String,
    catalog_revision: String,
}

fn creation_identity(
    config: &AppConfig,
    request_id: &str,
) -> Result<ConversationIdentity, (StatusCode, String)> {
    if request_id.is_empty()
        || request_id.len() > 80
        || !request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid new chat request ID".into(),
        ));
    }
    ConversationIdentity::from_openai_session(&format!(
        "standalone-new-chat:{}:{}:{request_id}",
        config.work_dir.display(),
        config.port
    ))
    .ok_or_else(|| internal_error("Invalid new chat identity"))
}

fn located_chat(chat: &crate::markdown_chat::ChatFile) -> LocatedChat {
    let path = chat.path().to_owned();
    let owner = path
        .parent()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    LocatedChat {
        id: format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes())),
        state_root: path
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned(),
        owner,
        path,
        work_dir: None,
        workspace: String::new(),
        is_scratch: false,
    }
}

fn selected_root(selection: WorkspaceSelection) -> PathBuf {
    match selection {
        WorkspaceSelection::Project(project) => project.project_root,
        WorkspaceSelection::WithoutProject(scratch) => scratch.scratch_root,
    }
}

pub(super) async fn create_chat(
    State(state): State<OwnerState>,
    Json(body): Json<CreateBody>,
) -> ApiResult {
    require_connector_name(&state.config)?;
    if !state.config.markdown_chat.automation.enabled || state.automation.is_none() {
        return Err(internal_error(
            "Enable browser automation to create a new chat",
        ));
    }
    let task = creation_identity(&state.config, &body.request_id)?;
    let _guard = state.creation_lock.lock().await;
    // Model discovery for New chat must be performed on its actual ChatGPT destination.
    let client = companion_client(&state)?;
    let health = client
        .health(&CancellationToken::new())
        .await
        .map_err(internal_error)?;
    let catalog = cached_owner_catalog(&state, &catalog_context(&health))
        .await
        .ok_or_else(|| internal_error("Prepare the new chat to discover available models first"))?;
    if catalog.catalog_revision != body.catalog_revision
        || !catalog.models.iter().any(|model| {
            model.id == body.model
                && model
                    .efforts
                    .iter()
                    .any(|effort| effort.id == body.effort && effort.available)
        })
    {
        return Err(internal_error(
            "The selected model or effort is no longer available; refresh new chat options",
        ));
    }
    let bindings = state.project_bindings.clone();
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&body).map_err(internal_error)?)
    );
    if let Some(previous_root) = bindings
        .selected_project_root(&state.config, &task)
        .map_err(internal_error)?
    {
        let mut previous_config = state.config.as_ref().clone();
        previous_config.work_dir = previous_root;
        AgentAutomationStore::for_config(&previous_config)
            .map_err(internal_error)?
            .record_creation_request(&task, &digest)
            .map_err(internal_error)?;
    }
    let config = selection_config(&state.config, body.create_worktree);
    let root = if let Some(worktree) = &body.worktree_path {
        if body.without_project.is_some() || body.resume_path.is_some() {
            return Err(internal_error(
                "Worktree reuse cannot be combined with another workspace choice",
            ));
        }
        let project = body
            .path
            .as_deref()
            .ok_or_else(|| internal_error("Choose the worktree source project"))?;
        if body.create_worktree == Some(true) {
            bindings
                .select_project_root_from_worktree(&config, &task, project, FilePath::new(worktree))
                .await
                .map_err(internal_error)?
                .project_root
        } else {
            bindings
                .reuse_worktree(&state.config, &task, project, FilePath::new(worktree))
                .await
                .map_err(internal_error)?
                .project_root
        }
    } else {
        match (&body.path, body.without_project, &body.resume_path) {
            (Some(path), None, None) if !path.trim().is_empty() => {
                bindings
                    .select_project_root(&config, &task, path)
                    .await
                    .map_err(internal_error)?
                    .project_root
            }
            (None, Some(true), None) if body.create_worktree.is_none() => {
                bindings
                    .select_without_project(&state.config, &task)
                    .await
                    .map_err(internal_error)?
                    .scratch_root
            }
            (None, None, Some(path)) if body.create_worktree.is_none() => selected_root(
                bindings
                    .resume_workspace(&state.config, &task, path)
                    .await
                    .map_err(internal_error)?,
            ),
            _ => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "Choose one project, Git URL, saved workspace, or chat without a project"
                        .into(),
                ));
            }
        }
    };
    let mut effective = state.config.as_ref().clone();
    effective.work_dir = root.clone();
    let chat = state
        .chats
        .chat(
            &effective,
            Some(&task),
            &crate::exec_sessions::SessionState::new(),
        )
        .map_err(internal_error)?;
    chat.ensure().await.map_err(internal_error)?;
    let store = Arc::new(AgentAutomationStore::for_config(&effective).map_err(internal_error)?);
    store
        .record_creation_request(&task, &digest)
        .map_err(internal_error)?;
    let previous = store.load(&task).map_err(internal_error)?;
    if previous.action.id.is_none() {
        queue_creation(
            &state,
            &task,
            &root,
            &store,
            &chat,
            Some((&body.model, &body.effort, &catalog)),
        )
        .await?;
    }
    Ok(Json(json!({"id":located_chat(&chat).id,"queued":true})))
}

async fn queue_creation(
    state: &OwnerState,
    task: &ConversationIdentity,
    root: &FilePath,
    store: &Arc<AgentAutomationStore>,
    chat: &Arc<crate::markdown_chat::ChatFile>,
    selection: Option<(&str, &str, &crate::agent_automation::CapabilityCatalog)>,
) -> Result<(), (StatusCode, String)> {
    let owner = state
        .continuations
        .owner_generation_for_task_key(task.stable_key())
        .map_err(internal_error)?;
    if owner != 0 {
        return Err(internal_error(
            "This chat was already created; replace its pairing instead of creating it again",
        ));
    }
    let token = state
        .continuations
        .issue_token(task, task, root)
        .map_err(internal_error)?;
    let now = crate::markdown_chat::now_ms();
    if let Some((model, effort, catalog)) = selection {
        store
            .set_selection(
                task,
                model,
                effort,
                &catalog.catalog_revision,
                &catalog.account_fingerprint,
                now,
            )
            .map_err(internal_error)?;
    }
    let destination = state
        .config
        .markdown_chat
        .automation
        .chatgpt_project_url
        .as_deref()
        .unwrap_or("https://chatgpt.com/new");
    let issue = store
        .issue_pairing(task, destination, 1, now)
        .map_err(internal_error)?;
    store.mark_creating_chat(task).map_err(internal_error)?;
    let supervisor = state
        .automation
        .as_ref()
        .ok_or_else(|| internal_error("Browser automation supervisor is unavailable"))?;
    supervisor
        .register_task(AutomationTaskHandle::new(
            task.clone(),
            1,
            store.clone(),
            chat.clone(),
        ))
        .await
        .map_err(internal_error)?;
    if let Err(error) = supervisor
        .queue_new_chat(
            task,
            &issue.reference,
            issue.generation,
            now,
            token,
            state
                .config
                .conversation_auth_token
                .as_deref()
                .map(str::to_owned),
        )
        .await
    {
        let _ = store.invalidate_pairing(task, issue.generation, now);
        return Err(internal_error(error));
    }
    supervisor.notify();
    Ok(())
}

pub(super) async fn retry_creation(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Json(_body): Json<OwnerMutationBody>,
) -> ApiResult {
    let _guard = state.creation_lock.lock().await;
    let located = selected(&state, &id)?;
    let context = automation_context(&state, &located).await?;
    let saved = context.store.load(&context.task).map_err(internal_error)?;
    if !saved.pairing.creating_chat || saved.action.send_accepted != Some(false) {
        return Err(internal_error(
            "Creation can only be retried after a confirmed failure before Send",
        ));
    }
    let root = state
        .project_bindings
        .clone()
        .selected_project_root(&state.config, &context.task)
        .map_err(internal_error)?
        .ok_or_else(|| internal_error("The new chat workspace is unavailable"))?;
    queue_creation(
        &state,
        &context.task,
        &root,
        &context.store,
        &context.chat,
        None,
    )
    .await?;
    Ok(Json(json!({"queued":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_automation::{
        ActionPrompt, AutomationExecution, AutomationExecutionError, AutomationExecutor,
        CapabilityCatalog, CompanionActionSnapshot, CompanionActionState, CompanionEvent,
        CompanionSelection,
    };
    use async_trait::async_trait;
    use std::sync::Mutex;
    use tokio::sync::mpsc;

    struct CreationExecutor {
        catalog: CapabilityCatalog,
        executions: Mutex<Vec<AutomationExecution>>,
    }
    #[async_trait]
    impl AutomationExecutor for CreationExecutor {
        async fn prepare_new_chat(
            &self,
            _: Option<&str>,
            _: CancellationToken,
        ) -> Result<CapabilityCatalog, String> {
            Ok(self.catalog.clone())
        }
        async fn execute(
            &self,
            execution: AutomationExecution,
            _: mpsc::UnboundedSender<CompanionEvent>,
            _: CancellationToken,
        ) -> Result<CompanionActionSnapshot, AutomationExecutionError> {
            self.executions.lock().unwrap().push(execution.clone());
            Ok(CompanionActionSnapshot {
                protocol_version: 1,
                build: self.catalog.build.clone(),
                action_id: execution.request.action_id,
                state: CompanionActionState::Idle,
                send_accepted: true,
                canonical_url: Some("https://chatgpt.com/c/created-chat".into()),
                selected: Some(CompanionSelection {
                    model: execution.request.model.unwrap(),
                    effort: execution.request.effort.unwrap(),
                }),
                last_event_sequence: 0,
                cooldown_until_ms: None,
                attention: None,
            })
        }
    }

    async fn fixture() -> (
        tempfile::TempDir,
        OwnerState,
        Arc<CreationExecutor>,
        tokio::task::JoinHandle<()>,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let project = root.join("projects");
        std::fs::create_dir_all(project.join("repo")).unwrap();
        let mut config = crate::config::default_config(project);

        config.markdown_chat.enabled = true;
        config.markdown_chat.automation.enabled = true;
        config.markdown_chat.automation.connector_name = "Codexify".into();
        config.memory.dir = Some(root.join("metadata").display().to_string());
        config.markdown_chat.automation.descriptor_path =
            root.join("descriptor.json").display().to_string();
        config.markdown_chat.automation.chatgpt_project_url =
            Some("https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project".into());
        let build = format!("fixture{}", crate::agent_automation::PROTOCOL_BUILD_SUFFIX);
        let catalog:CapabilityCatalog=serde_json::from_value(json!({"protocolVersion":1,"build":build,"accountFingerprint":"creation-account","catalogRevision":"creation-catalog","models":[{"id":"discovered-model","label":"Discovered model","efforts":[{"id":"adaptive-choice","label":"Adaptive choice","available":true,"reason":null}]}]})).unwrap();
        let health = json!({"protocolVersion":1,"kind":"codexify-browser-companion","build":build,"status":"idle","authenticated":true,"accountFingerprint":"creation-account","activeActionId":null});
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route(
            "/v1/health",
            get(move || {
                let health = health.clone();
                async move { Json(health) }
            }),
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        std::fs::write(&config.markdown_chat.automation.descriptor_path,serde_json::to_vec(&json!({"version":1,"kind":"codexify-browser-companion","pid":std::process::id(),"endpoint":format!("http://127.0.0.1:{port}"),"token":"A".repeat(43),"build":build,"createdAt":"2026-10-12T00:00:00Z"})).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                &config.markdown_chat.automation.descriptor_path,
                std::fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
        let executor = Arc::new(CreationExecutor {
            catalog,
            executions: Mutex::new(Vec::new()),
        });
        let supervisor = AgentAutomationSupervisor::new(
            config.markdown_chat.automation.clone(),
            executor.clone(),
        );
        let state = OwnerState {
            config: Arc::new(config.clone()),
            chats: Arc::default(),
            project_bindings: Arc::new(crate::project_bindings::ProjectBindingStore::new(
                root.join("bindings"),
            )),
            creation_lock: Arc::default(),
            artifacts: Arc::new(ArtifactEgressStore::new_at(
                config.artifact_egress.clone(),
                root.join("artifacts"),
            )),
            continuations: Arc::new(
                ConversationContinuationStore::new(root.join("continuations.json")).unwrap(),
            ),
            automation: Some(supervisor),
            open_browser: Arc::new(|_| Ok(())),
            catalog_cache: Arc::default(),
            global: Arc::default(),
            token: "owner-test".into(),
        };
        (temp, state, executor, task)
    }

    fn body(id: &str, scratch: bool) -> CreateBody {
        CreateBody {
            request_id: id.into(),
            path: (!scratch).then(|| "repo".into()),
            without_project: scratch.then_some(true),
            create_worktree: (!scratch).then_some(false),
            resume_path: None,
            worktree_path: None,
            model: "discovered-model".into(),
            effort: "adaptive-choice".into(),
            catalog_revision: "creation-catalog".into(),
        }
    }

    #[tokio::test]
    async fn a_missing_connector_rejects_preparation_and_creation_before_workspace_changes() {
        let (_temp, mut state, executor, server) = fixture().await;
        Arc::make_mut(&mut state.config)
            .markdown_chat
            .automation
            .connector_name
            .clear();
        let error = prepare_chat(State(state.clone()), Json(Default::default()))
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::PRECONDITION_REQUIRED);
        let error = create_chat(State(state.clone()), Json(body("missing-connector", true)))
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::PRECONDITION_REQUIRED);
        let identity = creation_identity(&state.config, "missing-connector").unwrap();
        assert!(
            state
                .project_bindings
                .selected_project_root(&state.config, &identity)
                .unwrap()
                .is_none()
        );
        assert_eq!(state.automation.as_ref().unwrap().queued_count().await, 0);
        assert!(executor.executions.lock().unwrap().is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn new_chat_selects_workspace_and_model_then_hands_off_and_verifies_once() {
        for scratch in [false, true] {
            let (_temp, state, executor, server) = fixture().await;
            let prepared = prepare_chat(State(state.clone()), Json(Default::default()))
                .await
                .unwrap()
                .0;
            assert_eq!(
                prepared["models"][0]["efforts"][0]["label"],
                "Adaptive choice"
            );
            let created = create_chat(State(state.clone()), Json(body("new-request", scratch)))
                .await
                .unwrap()
                .0;
            let repeated = create_chat(State(state.clone()), Json(body("new-request", scratch)))
                .await
                .unwrap()
                .0;
            assert_eq!(created["id"], repeated["id"]);
            assert_eq!(state.automation.as_ref().unwrap().queued_count().await, 1);
            let identity = creation_identity(&state.config, "new-request").unwrap();
            let workspace = state
                .project_bindings
                .selected_project_root(&state.config, &identity)
                .unwrap()
                .unwrap();
            if !scratch {
                assert_eq!(
                    workspace,
                    std::fs::canonicalize(state.config.work_dir.join("repo")).unwrap()
                );
            }
            let located = selected(&state, created["id"].as_str().unwrap()).unwrap();
            let context = automation_context(&state, &located).await.unwrap();
            assert_eq!(
                context.owner_generation, 1,
                "owner polling must not invalidate the queued creation"
            );
            state
                .automation
                .as_ref()
                .unwrap()
                .run_next(crate::markdown_chat::now_ms())
                .await
                .unwrap()
                .unwrap();
            let execution = executor.executions.lock().unwrap()[0].clone();
            assert_eq!(execution.request.model.as_deref(), Some("discovered-model"));
            assert_eq!(execution.request.effort.as_deref(), Some("adaptive-choice"));
            assert_eq!(
                execution.request.url,
                state
                    .config
                    .markdown_chat
                    .automation
                    .chatgpt_project_url
                    .clone()
                    .unwrap()
            );
            let ActionPrompt::CreateChat {
                continuation_token,
                reference,
                ..
            } = execution.request.prompt
            else {
                panic!("wrong creation prompt")
            };
            let physical =
                ConversationIdentity::from_openai_session("actual-created-chat").unwrap();
            let claimed = state
                .continuations
                .claim(&physical, &continuation_token, |task, root| {
                    assert_eq!(task.stable_key(), identity.stable_key());
                    assert_eq!(root, workspace);
                    Ok(())
                })
                .unwrap();
            assert_eq!(claimed.task.stable_key(), identity.stable_key());
            let verified = context
                .store
                .verify_pairing_reference(
                    &claimed.task,
                    1,
                    &reference,
                    crate::markdown_chat::now_ms(),
                )
                .unwrap();
            assert_eq!(
                verified.canonical_url.as_deref(),
                Some("https://chatgpt.com/c/created-chat")
            );
            assert_eq!(verified.verified_owner_generation, Some(1));
            assert!(!verified.creating_chat);
            assert_eq!(
                state
                    .continuations
                    .owner_snapshot(&physical)
                    .unwrap()
                    .generation,
                1
            );
            assert!(
                context
                    .store
                    .verify_pairing_reference(
                        &claimed.task,
                        1,
                        &reference,
                        crate::markdown_chat::now_ms()
                    )
                    .is_err()
            );
            server.abort();
        }
    }

    #[tokio::test]
    async fn creation_accepts_pasted_and_explicit_worktree_bases_without_reusing_or_replaying_them()
    {
        fn git(root: &FilePath, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .current_dir(root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_string()
        }
        for pasted in [false, true] {
            let (temp, mut state, _executor, server) = fixture().await;
            let config = Arc::make_mut(&mut state.config);
            config.worktrees.root = temp.path().join("managed");
            config.worktrees.auto_cleanup_enabled = false;
            let source = config.work_dir.join("repo");
            git(&source, &["init", "-qb", "main"]);
            git(
                &source,
                &[
                    "-c",
                    "user.name=Tests",
                    "-c",
                    "user.email=tests@example.invalid",
                    "commit",
                    "-qm",
                    "initial",
                    "--allow-empty",
                ],
            );
            let base = temp.path().join("base");
            git(
                &source,
                &["worktree", "add", "-b", "base", base.to_str().unwrap()],
            );
            std::fs::write(base.join("base.txt"), "committed base content").unwrap();
            git(&base, &["add", "base.txt"]);
            git(
                &base,
                &[
                    "-c",
                    "user.name=Tests",
                    "-c",
                    "user.email=tests@example.invalid",
                    "commit",
                    "-qm",
                    "base commit",
                ],
            );
            let head = git(&base, &["rev-parse", "HEAD"]);
            std::fs::write(base.join("base.txt"), "uncommitted base content").unwrap();
            let _ = prepare_chat(State(state.clone()), Json(Default::default()))
                .await
                .unwrap();
            let request = || {
                let mut request = body("from-base", false);
                request.create_worktree = Some(true);
                if pasted {
                    request.path = Some(base.to_string_lossy().into_owned());
                } else {
                    request.worktree_path = Some(base.to_string_lossy().into_owned());
                }
                request
            };
            let created = create_chat(State(state.clone()), Json(request()))
                .await
                .unwrap()
                .0;
            let repeated = create_chat(State(state.clone()), Json(request()))
                .await
                .unwrap()
                .0;
            assert_eq!(created["id"], repeated["id"]);
            assert_eq!(state.automation.as_ref().unwrap().queued_count().await, 1);
            let task = creation_identity(&state.config, "from-base").unwrap();
            let workspace = state
                .project_bindings
                .selected_project_root(&state.config, &task)
                .unwrap()
                .unwrap();
            assert_ne!(workspace, base);
            assert_eq!(git(&workspace, &["rev-parse", "HEAD"]), head);
            assert_eq!(
                std::fs::read_to_string(workspace.join("base.txt")).unwrap(),
                "committed base content"
            );
            assert_eq!(
                std::fs::read_to_string(base.join("base.txt")).unwrap(),
                "uncommitted base content"
            );
            // The existing reuse API still selects the base without creating another checkout.
            let before = git(&source, &["worktree", "list", "--porcelain"]);
            let mut reuse = body("reuse-base", false);
            reuse.create_worktree = None;
            reuse.worktree_path = Some(base.to_string_lossy().into_owned());
            let _ = create_chat(State(state.clone()), Json(reuse))
                .await
                .unwrap();
            let task = creation_identity(&state.config, "reuse-base").unwrap();
            assert_eq!(
                state
                    .project_bindings
                    .selected_project_root(&state.config, &task)
                    .unwrap()
                    .unwrap(),
                std::fs::canonicalize(&base).unwrap()
            );
            assert_eq!(git(&source, &["worktree", "list", "--porcelain"]), before);
            server.abort();
        }
    }

    #[tokio::test]
    async fn new_chat_rejects_unavailable_options_without_creating_a_workspace() {
        let (_temp, state, _, server) = fixture().await;
        let _ = prepare_chat(State(state.clone()), Json(Default::default()))
            .await
            .unwrap();
        let mut request = body("bad-model", false);
        request.effort = "not-discovered".into();
        assert!(
            create_chat(State(state.clone()), Json(request))
                .await
                .is_err()
        );
        let identity = creation_identity(&state.config, "bad-model").unwrap();
        assert!(
            state
                .project_bindings
                .selected_project_root(&state.config, &identity)
                .unwrap()
                .is_none()
        );
        server.abort();
    }
}
