//! Subagent admission, worktree/context preparation, launch, queueing, and watchdog.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::agent::channel::loop_detection::{DEFAULT_LOOP_NUDGE_AFTER, DEFAULT_LOOP_STOP_AFTER};
use crate::agent::channel::{run_agent_loop, AgentRunConfig};
use crate::agent::events::{AgentEvent, AgentTaskEvent};
use crate::cancellation::{AbortController, AbortSignal};
use crate::subagent::context::fork_subagent_context;
use crate::subagent::definition::{
    capability_for_parent_mode, resolve_effective_config, resolve_timeout_ms,
    EffectiveRuntimeConfig, SubagentParentDefaults,
};
use crate::subagent::registry::{QueuedSpawn, SpawnAdmission, SubagentRegistry};
use crate::subagent::types::{
    SubagentCapabilityMode, SubagentIsolation, SubagentResult, SubagentSnapshot,
    SubagentSpawnRequest, SubagentStatus,
};
use crate::subagent::worktree;
use crate::types::{Message, Role};

use super::forwarder::{forward_child_events, maybe_notify_completion, settle_worktree_blocking};
use super::{SubagentHost, ToolPolicy};

/// Child task ids are allocated from a high offset so they never collide with
/// the parent turn's monotonically increasing task id.
static CHILD_TASK_ID: AtomicU64 = AtomicU64::new(1);

fn next_child_task_id() -> u64 {
    1_000_000 + CHILD_TASK_ID.fetch_add(1, Ordering::Relaxed)
}

fn err_result(message: impl Into<String>) -> SubagentResult {
    SubagentResult {
        id: String::new(),
        status: SubagentStatus::Failed,
        summary: Some(message.into()),
        resume_from_hint: None,
        is_error: true,
    }
}

/// Watchdog for one child: abort it once its wall-clock budget expires, or
/// exit immediately as soon as the child reaches a terminal state.
/// Already-terminal children are left alone; the forwarder converts the
/// resulting cancellation into a timeout failure (see `take_timed_out`).
pub(super) async fn enforce_timeout(
    registry: SubagentRegistry,
    id: String,
    timeout_ms: u64,
    mut completion_rx: Option<tokio::sync::watch::Receiver<bool>>,
) {
    if completion_rx.as_ref().is_some_and(|rx| *rx.borrow()) {
        return;
    }
    tokio::select! {
        _ = tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)) => {}
        _ = async {
            match completion_rx.as_mut() {
                Some(rx) => {
                    let _ = rx.changed().await;
                }
                None => std::future::pending::<()>().await,
            }
        } => return,
    }
    let still_running = registry
        .get(&id)
        .is_some_and(|snap| !snap.status.is_terminal());
    if !still_running {
        return;
    }
    registry.mark_timed_out(&id, timeout_ms);
    registry.cancel(&id);
}

/// Owned inputs for launching one child thread. Built once at admission so
/// a queued spawn starts without re-resolving.
struct PreparedLaunch {
    id: String,
    request: SubagentSpawnRequest,
    cfg: EffectiveRuntimeConfig,
    messages: Vec<Message>,
    model: String,
    depth: u32,
    controller: AbortController,
    parent_cancel: AbortSignal,
    coerced_to_read_only: bool,
    timeout_ms: u64,
    max_iterations: Option<u32>,
    completion_rx: Option<tokio::sync::watch::Receiver<bool>>,
    announce_start: bool,
}

/// Worktree + conversation resolution shared by the immediate and queued
/// launch paths.
pub(super) struct ChildPrep {
    pub(super) cfg: EffectiveRuntimeConfig,
    pub(super) messages: Vec<Message>,
    pub(super) max_iterations: Option<u32>,
}

/// Read-only note carried on background spawn results when Plan mode
/// coerced the child. Built once so the admission and launch paths agree.
fn coercion_note(coerced: bool) -> Option<String> {
    coerced.then(|| {
        "started in background with read-only tools \
         (Plan mode coerces every child to read-only)"
            .to_string()
    })
}

impl SubagentHost {
    /// Resolve and launch a child agent. See module docs for the full flow.
    pub(super) async fn spawn(
        &self,
        mut request: SubagentSpawnRequest,
        parent_cancel: AbortSignal,
        depth: u32,
    ) -> SubagentResult {
        request.normalize();
        self.inner
            .scheduler
            .get_or_init(tokio::runtime::Handle::current);
        if parent_cancel.is_aborted() {
            return err_result("Subagent spawn cancelled before admission");
        }
        // Depth guard (parent = depth 0).
        if depth >= self.inner.max_depth {
            return err_result(format!(
                "Subagent depth limit reached (max {}). Nested subagents cannot spawn deeper.",
                self.inner.max_depth
            ));
        }

        let custom = &self.inner.config.custom_agents;
        let parent_defaults = SubagentParentDefaults {
            model: self.inner.config.model.clone(),
            project_dir: self.inner.config.project_dir.clone(),
        };
        let mut cfg = match resolve_effective_config(&request, &parent_defaults, custom) {
            Ok(cfg) => cfg,
            Err(e) => return err_result(e),
        };
        if request.is_created() {
            request.subagent_type = cfg.subagent_type.clone();
        }
        if request.resume_from.is_some() && request.model.is_some() {
            return err_result(
                "resume_from continues on the model the subagent ran on; omit `model` when resuming",
            );
        }
        let registry = &self.inner.config.provider_registry;
        let routed = match crate::subagent::routing::resolve_model(
            &self.inner.config.subagents,
            request.model.as_deref(),
            cfg.agent_model.as_deref(),
            |provider| registry.get(provider).is_some(),
        ) {
            Ok(routed) => routed,
            Err(e) => return err_result(e),
        };
        tracing::info!(
            subagent_type = %request.subagent_type,
            seat = ?routed.seat,
            source = ?routed.source,
            "Subagent model routed"
        );
        let mut seat = routed.seat;
        if routed.model.is_some() {
            cfg.model = routed.model;
            cfg.provider = routed.provider;
            cfg.thinking_level = routed.thinking;
        }

        let (effective_capability, coerced_to_read_only) = capability_for_parent_mode(
            self.inner
                .config
                .permission_engine
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .mode,
            cfg.capability,
        );
        if coerced_to_read_only {
            tracing::info!(
                subagent_type = %request.subagent_type,
                "Plan mode coerces child to read-only tools"
            );
            cfg.capability = effective_capability;
        }

        let mut model = cfg
            .model
            .clone()
            .unwrap_or_else(|| parent_defaults.model.clone());
        if let Some(resume_id) = &request.resume_from {
            let source = match self.inner.registry.get(resume_id) {
                Some(s) => s,
                None => {
                    return err_result(format!("resume_from: unknown subagent id '{resume_id}'"));
                }
            };
            if !source.status.is_terminal() {
                return err_result(format!(
                    "resume_from: subagent '{resume_id}' is still running; wait for it to finish first"
                ));
            }
            if source.subagent_type != request.subagent_type {
                return err_result(format!(
                    "resume_from: subagent '{}' has type '{}' but the task requested '{}'. \
                     Resume requires the same subagent_type.",
                    resume_id, source.subagent_type, request.subagent_type
                ));
            }
            model = source.model.clone();
            seat = source.seat.clone();
            cfg.provider = Some(source.provider.clone()).filter(|p| !p.is_empty());
            cfg.thinking_level = Some(source.thinking.clone()).filter(|t| !t.is_empty());
        }

        let id = request
            .task_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let background = request.resolved_run_in_background();

        let snapshot = SubagentSnapshot {
            id: id.clone(),
            subagent_type: request.subagent_type.clone(),
            description: request.description.clone(),
            prompt: request.prompt.clone(),
            status: SubagentStatus::Running,
            summary: None,
            conversation: Vec::new(),
            model: model.clone(),
            seat: seat.clone(),
            provider: cfg
                .provider
                .clone()
                .unwrap_or_else(|| self.inner.config.provider_id.clone()),
            thinking: cfg
                .thinking_level
                .clone()
                .unwrap_or_else(|| self.inner.config.thinking_level.clone()),
            depth: depth + 1,
            background,
            started_at: chrono::Utc::now(),
            finished_at: None,
            cwd: None,
            worktree: None,
        };
        let child_controller = parent_cancel.child_controller();
        let admission = self.inner.registry.admit(
            snapshot,
            QueuedSpawn {
                id: id.clone(),
                request: request.clone(),
                cfg: cfg.clone(),
                controller: child_controller.clone(),
                depth,
                coerced_to_read_only,
            },
            self.inner.max_concurrent,
        );
        let completion_rx = match admission {
            Err(error) => return err_result(error),
            Ok(SpawnAdmission::Running(rx)) => (!background).then_some(rx),
            Ok(SpawnAdmission::Queued { position, running }) => {
                let _ = self.inner.config.event_sender.send(AgentTaskEvent {
                    task_id: self.inner.config.task_id,
                    event: AgentEvent::SubagentStarted {
                        id: id.clone(),
                        subagent_type: request.subagent_type.clone(),
                        description: request.description.clone(),
                        model: model.clone(),
                        seat: seat.clone(),
                    },
                });
                self.try_start_queued();
                return SubagentResult {
                    id: id.clone(),
                    status: SubagentStatus::Pending,
                    summary: Some(format!("queued at position {position} ({running} running)")),
                    resume_from_hint: Some(id),
                    is_error: false,
                };
            }
        };

        let timeout_ms = resolve_timeout_ms(request.timeout_ms);
        let prep = match self.prepare_child(&id, &request, cfg).await {
            Ok(prep) => prep,
            Err(e) => {
                self.fail_child(&id, &e);
                return err_result(e);
            }
        };
        self.launch_prepared(PreparedLaunch {
            id,
            request,
            cfg: prep.cfg,
            messages: prep.messages,
            model,
            depth,
            controller: child_controller,
            parent_cancel,
            coerced_to_read_only,
            timeout_ms,
            max_iterations: prep.max_iterations,
            completion_rx,
            announce_start: true,
        })
        .await
    }

    /// Finish a child that failed before its loop started (prep errors) so the
    /// registry never strands a `Running` entry with no forwarder.
    pub(super) fn fail_child(&self, id: &str, message: &str) {
        settle_worktree_blocking(self, id);
        self.inner
            .registry
            .finish(id, SubagentStatus::Failed, message.to_string(), Vec::new());
        let _ = self.inner.config.event_sender.send(AgentTaskEvent {
            task_id: self.inner.config.task_id,
            event: AgentEvent::SubagentDone {
                id: id.to_string(),
                summary: message.to_string(),
                is_error: true,
            },
        });
        maybe_notify_completion(self, id, SubagentStatus::Failed, message);
        self.board_child_finished(id);
        self.try_start_queued();
    }

    /// Resolve the child's checkout (or reuse the resumed child's), then build
    /// the system prompt and forked conversation. Runs after admission so a
    /// queued child does not hold a worktree while it waits.
    pub(super) async fn prepare_child(
        &self,
        id: &str,
        request: &SubagentSpawnRequest,
        mut cfg: EffectiveRuntimeConfig,
    ) -> Result<ChildPrep, String> {
        let resume_source = request
            .resume_from
            .as_deref()
            .and_then(|resume_id| self.inner.registry.get(resume_id));
        let mut worktree_info = None;
        if let Some(source) = resume_source.as_ref() {
            if let Some(info) = source.worktree.clone() {
                if !worktree::claim_for_resume(Path::new(&info.path)) {
                    return Err(format!(
                        "resume_from: checkout for '{}' is already in use by another resume",
                        request.resume_from.as_deref().unwrap_or(id)
                    ));
                }
                cfg.cwd = Some(info.path.clone());
                worktree_info = Some(info);
            }
        } else if request.isolation == SubagentIsolation::Worktree
            && request.cwd.is_none()
            && cfg.capability != SubagentCapabilityMode::ReadOnly
        {
            if let Some(root) = worktree::find_repo_root(Path::new(&self.inner.config.project_dir))
            {
                let label = format!("{}-{}", slug(&request.subagent_type), short_id(id));
                match worktree::acquire_for(&root, &label).await {
                    Some(info) => {
                        cfg.cwd = Some(info.path.clone());
                        worktree_info = Some(info);
                    }
                    None => tracing::warn!(
                        subagent_type = %request.subagent_type,
                        "worktree isolation failed; child runs in the parent root"
                    ),
                }
            } else {
                tracing::warn!(
                    project_dir = %self.inner.config.project_dir,
                    "worktree isolation requested outside a git repository; child runs in the parent root"
                );
            }
        }
        if worktree_info.is_some() {
            let cwd = cfg.cwd.clone();
            let info = worktree_info.clone();
            self.inner.registry.update(id, move |snap| {
                snap.cwd = cwd;
                snap.worktree = info;
            });
        }

        let child_system_prompt = format!(
            "{}\n\nWORKSPACE: {}\nYou are a subagent (type: {}). Report back to the parent agent when done.",
            cfg.system_prompt,
            cfg.cwd.as_deref().unwrap_or(&self.inner.config.project_dir),
            cfg.subagent_type
        );
        let messages = match resume_source {
            Some(source) => {
                let mut conv: Vec<Message> = source
                    .conversation
                    .iter()
                    .filter(|m| m.role != Role::System)
                    .cloned()
                    .collect();
                conv.insert(
                    0,
                    Message {
                        role: Role::System,
                        content: child_system_prompt,
                        tool_calls: None,
                        tool_call_id: None,
                        thinking: None,
                        thinking_signature: None,
                        continuation: None,
                        attachments: Vec::new(),
                    },
                );
                conv.push(Message {
                    role: Role::User,
                    content: request.prompt.clone(),
                    tool_calls: None,
                    tool_call_id: None,
                    thinking: None,
                    thinking_signature: None,
                    continuation: None,
                    attachments: Vec::new(),
                });
                conv
            }
            None => fork_subagent_context(&child_system_prompt, &request.prompt),
        };
        let max_iterations = request.max_iterations;
        Ok(ChildPrep {
            cfg,
            messages,
            max_iterations,
        })
    }

    async fn launch_prepared(&self, prepared: PreparedLaunch) -> SubagentResult {
        let PreparedLaunch {
            id,
            request,
            cfg,
            messages,
            model,
            depth,
            controller,
            parent_cancel,
            coerced_to_read_only,
            timeout_ms,
            max_iterations,
            completion_rx,
            announce_start,
        } = prepared;
        let child_signal = controller.signal();
        self.inner.registry.register_cancel(&id, controller);
        let background = request.resolved_run_in_background();

        if announce_start {
            let seat = self.inner.registry.get(&id).and_then(|snap| snap.seat);
            let _ = self.inner.config.event_sender.send(AgentTaskEvent {
                task_id: self.inner.config.task_id,
                event: AgentEvent::SubagentStarted {
                    id: id.clone(),
                    subagent_type: request.subagent_type.clone(),
                    description: request.description.clone(),
                    model: model.clone(),
                    seat,
                },
            });
        }

        let (child_tx, child_rx) = std::sync::mpsc::channel::<AgentTaskEvent>();
        let child_task_id = next_child_task_id();
        tracing::info!(child_id = %id, parent_task_id = self.inner.config.task_id, child_task_id, model = %model, max_iterations = ?max_iterations, "Subagent run admitted");

        let host = self.clone();
        let child_id = id.clone();

        {
            let forwarder_host = host.clone();
            let forwarder_id = child_id.clone();
            let spawned = std::thread::Builder::new()
                .name(format!("agente-subagent-fwd-{child_id}"))
                .spawn(move || {
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        forward_child_events(
                            child_rx,
                            forwarder_host.clone(),
                            forwarder_id.clone(),
                        );
                    }));
                    if outcome.is_err()
                        && forwarder_host
                            .inner
                            .registry
                            .get(&forwarder_id)
                            .is_some_and(|snap| !snap.status.is_terminal())
                    {
                        forwarder_host.fail_child(
                            &forwarder_id,
                            "Subagent event forwarder stopped unexpectedly.",
                        );
                    }
                });
            if spawned.is_err() {
                self.fail_child(&id, "Failed to start subagent event forwarder");
                return SubagentResult {
                    id,
                    status: SubagentStatus::Failed,
                    summary: Some("Failed to start subagent event forwarder".into()),
                    resume_from_hint: None,
                    is_error: true,
                };
            }
        }

        // A swarm card's child talks to the other members: the `swarm` tool
        // to post and read findings, an inbox where theirs arrive.
        let (swarm_inbox, swarm_tools) = match self.swarm_member_tools(&id) {
            Some((inbox, tool)) => (Some(inbox), vec![tool]),
            None => (None, Vec::new()),
        };
        let run_config = AgentRunConfig {
            session_id: uuid::Uuid::new_v4(),
            sender: child_tx.clone(),
            task_id: child_task_id,
            messages,
            provider_id: cfg
                .provider
                .clone()
                .unwrap_or_else(|| host.inner.config.provider_id.clone()),
            model: model.clone(),
            thinking_level: cfg
                .thinking_level
                .clone()
                .unwrap_or_else(|| host.inner.config.thinking_level.clone()),
            project_dir: cfg
                .cwd
                .clone()
                .unwrap_or_else(|| host.inner.config.project_dir.clone()),
            max_iterations,
            registry: Arc::clone(&host.inner.config.provider_registry),
            catalog: host.inner.config.catalog.clone(),
            permission_engine: host.inner.config.permission_engine.clone(),
            cancel_signal: child_signal,
            approval_broker: host.inner.config.approval_broker.clone(),
            mcp_manager: host.inner.config.mcp_manager.clone(),
            subagent_host: Some(host.clone()),
            custom_agents: host.inner.config.custom_agents.clone(),
            tool_policy: Some(ToolPolicy {
                capability: cfg.capability,
                allowlist: cfg.tools.clone(),
                owns: request.owns.clone(),
            }),
            is_subagent: true,
            depth: depth + 1,
            loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
            loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
            smart_compaction: false,
            compaction_model: None,
            initial_gap: 0,
            user_inbox: swarm_inbox,
            extra_tools: swarm_tools,
            only_tools: host.inner.config.only_tools.clone(),
            shell_env: host.inner.config.shell_env.clone(),
        };
        let thread_name = format!("agente-subagent-{child_id}");
        let error_sender = child_tx;
        std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(_) => return,
                };
                if let Err(e) = rt.block_on(run_agent_loop(run_config)) {
                    let _ = error_sender.send(AgentTaskEvent {
                        task_id: child_task_id,
                        event: AgentEvent::Error {
                            message: e.message,
                            conversation: e.conversation,
                        },
                    });
                }
            })
            .ok();

        {
            let watchdog_registry = self.inner.registry.clone();
            let watchdog_id = id.clone();
            let watchdog_rx = self.inner.registry.watchdog_receiver(&id);
            tokio::spawn(async move {
                enforce_timeout(watchdog_registry, watchdog_id, timeout_ms, watchdog_rx).await;
            });
        }

        let foreground = if background { None } else { completion_rx };
        if let Some(mut completion) = foreground {
            let mut parent_aborted = false;
            loop {
                tokio::select! {
                    changed = completion.changed() => {
                        if changed.is_err() || *completion.borrow() { break; }
                    }
                    _ = parent_cancel.wait_aborted() => {
                        parent_aborted = true;
                        self.inner.registry.cancel(&id);
                        break;
                    }
                }
            }
            let snap = self
                .inner
                .registry
                .get(&id)
                .unwrap_or_else(|| SubagentSnapshot {
                    id: id.clone(),
                    subagent_type: request.subagent_type,
                    description: String::new(),
                    prompt: request.prompt.clone(),
                    status: SubagentStatus::Failed,
                    summary: Some("subagent state lost".into()),
                    conversation: Vec::new(),
                    model,
                    seat: None,
                    provider: String::new(),
                    thinking: String::new(),
                    depth: depth + 1,
                    background,
                    started_at: chrono::Utc::now(),
                    finished_at: None,
                    cwd: None,
                    worktree: None,
                });
            let (status, summary) = if parent_aborted && !snap.status.is_terminal() {
                (
                    SubagentStatus::Cancelled,
                    snap.summary.or_else(|| Some("cancelled".to_string())),
                )
            } else {
                (snap.status, snap.summary)
            };
            SubagentResult {
                id: id.clone(),
                status,
                summary,
                resume_from_hint: Some(id),
                is_error: matches!(status, SubagentStatus::Failed | SubagentStatus::Cancelled),
            }
        } else {
            SubagentResult {
                id: id.clone(),
                status: SubagentStatus::Running,
                summary: coercion_note(coerced_to_read_only),
                resume_from_hint: Some(id),
                is_error: false,
            }
        }
    }

    /// Start queued spawns while concurrency slots are free. Called after
    /// every terminal child event (and therefore after kills): FIFO order,
    /// skipping entries that stopped being Pending (killed while queued).
    pub(crate) fn try_start_queued(&self) {
        let Some(scheduler) = self.inner.scheduler.get() else {
            return;
        };
        while let Some((item, model)) = self
            .inner
            .registry
            .start_next_queued(self.inner.max_concurrent)
        {
            let host = self.clone();
            scheduler.spawn(async move {
                let prep = match host
                    .prepare_child(&item.id, &item.request, item.cfg.clone())
                    .await
                {
                    Ok(prep) => prep,
                    Err(e) => {
                        host.fail_child(&item.id, &e);
                        return;
                    }
                };
                host.launch_prepared(PreparedLaunch {
                    id: item.id.clone(),
                    request: item.request.clone(),
                    cfg: prep.cfg,
                    messages: prep.messages,
                    model,
                    depth: item.depth,
                    controller: item.controller.clone(),
                    parent_cancel: item.controller.signal(),
                    coerced_to_read_only: item.coerced_to_read_only,
                    timeout_ms: resolve_timeout_ms(item.request.timeout_ms),
                    max_iterations: prep.max_iterations,
                    completion_rx: None,
                    announce_start: false,
                })
                .await;
            });
        }
    }
}

/// A path-safe label for a worktree: a role like "Security reviewer"
/// becomes `security-reviewer`.
fn slug(text: &str) -> String {
    let folded: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let joined = folded
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if joined.is_empty() {
        "subagent".into()
    } else {
        joined.chars().take(40).collect()
    }
}

fn short_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if cleaned.is_empty() {
        "child".to_string()
    } else {
        cleaned
    }
}
