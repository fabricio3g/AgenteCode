//! Subagent host: spawn orchestration wired into the agent loop.
//!
//! The host owns the shared subagent registry and knows how to translate a
//! `task` / `task_output` / `kill_task` tool call into a child agent run. The
//! child reuses the same `run_agent_loop` as the parent, but streams its
//! events through a private channel that a forwarder re-emits as
//! `AgentEvent::Subagent*` on the parent's channel, so the TUI renders nested
//! activity without confusing turn-level `Done` events.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc::Sender, Arc, OnceLock};

use crate::agent::channel::loop_detection::{DEFAULT_LOOP_NUDGE_AFTER, DEFAULT_LOOP_STOP_AFTER};
use crate::agent::channel::{run_agent_loop, AgentRunConfig, ToolCallOutcome};
use crate::agent::events::{AgentEvent, AgentTaskEvent};
use crate::cancellation::{AbortController, AbortSignal};
use crate::catalog::ModelCatalog;
use crate::permissions::{ApprovalBroker, SharedPermissionEngine};
use crate::providers::ProviderRegistry;
use crate::subagent::context::{completion_summary, fork_subagent_context};
use crate::subagent::definition::{
    capability_for_parent_mode, filter_tool_definitions, resolve_effective_config,
    resolve_timeout_ms, CustomSubagent, EffectiveRuntimeConfig, SubagentParentDefaults,
    DEFAULT_SUBAGENT_SUMMARY_CAP,
};
use crate::subagent::registry::{
    bound_conversation, QueuedSpawn, SpawnAdmission, SubagentRegistry,
};
use crate::subagent::types::{
    SubagentCapabilityMode, SubagentIsolation, SubagentResult, SubagentSnapshot,
    SubagentSpawnRequest, SubagentStatus,
};
use crate::subagent::worktree;
use crate::tools::ToolExecutionContext;
use crate::types::{AgentMode, Message, Role, ToolCall, ToolDefinition};

/// Bounded wait for `task_output` when the model omits `timeout_ms` (or passes
/// 0, which used to block forever in event silence).
const DEFAULT_TASK_OUTPUT_WAIT_MS: u64 = 120_000;
/// Liveness tick while `task_output` waits on a still-running child.
const TASK_OUTPUT_HEARTBEAT_MS: u64 = 15_000;

/// Tool gating policy applied to a child agent's registry (capability mode +
/// optional type allowlist).
#[derive(Debug, Clone)]
pub struct ToolPolicy {
    pub capability: SubagentCapabilityMode,
    pub allowlist: Option<Vec<String>>,
}

impl ToolPolicy {
    /// True when a tool name is allowed for this child.
    pub fn allows(&self, tool_name: &str) -> bool {
        let in_allowlist = self
            .allowlist
            .as_ref()
            .map(|list| list.iter().any(|t| t == tool_name))
            .unwrap_or(true);
        in_allowlist
            && crate::subagent::definition::tool_allowed_by_capability(tool_name, self.capability)
    }

    /// Filter tool definitions for the child's request.
    pub fn filter_definitions(&self, definitions: Vec<ToolDefinition>) -> Vec<ToolDefinition> {
        filter_tool_definitions(definitions, self.capability, self.allowlist.as_deref())
    }
}

/// Everything the host needs to spawn and observe children.
#[derive(Clone)]
pub struct SubagentHostConfig {
    pub event_sender: Sender<AgentTaskEvent>,
    pub task_id: u64,
    pub provider_id: String,
    pub provider_registry: Arc<ProviderRegistry>,
    pub catalog: Option<ModelCatalog>,
    pub permission_engine: SharedPermissionEngine,
    pub approval_broker: ApprovalBroker,
    pub mcp_manager: Option<Arc<crate::mcp::client::McpManager>>,
    pub project_dir: String,
    pub model: String,
    pub thinking_level: String,
    pub parent_mode: AgentMode,
    /// Shared subagent registry. The TUI holds the same handle so the status
    /// bar counter and `/subagents` popup observe the live set of children.
    pub registry: SubagentRegistry,
    /// Custom agents discovered once when the host is built (per turn) —
    /// spawning used to re-read `.agente/agents` from disk on every `task`
    /// call. Built-ins are always live.
    pub custom_agents: Vec<CustomSubagent>,
    /// User-configured per-type model overrides (`subagent_models` setting).
    pub subagent_models: crate::config::SubagentModels,
    /// The parent turn's command environment; children inherit it, so a
    /// bot's subagent never gets the host's keys either.
    pub shell_env: crate::tools::ShellEnv,
    /// The parent turn's tool allowlist (a bot's toolsets); children never
    /// get a tool their parent couldn't use.
    pub only_tools: Option<Vec<String>>,
}

/// Spawn orchestration + shared registry, shareable between parent and children.
#[derive(Clone)]
pub struct SubagentHost {
    inner: Arc<SubagentHostInner>,
}

struct SubagentHostInner {
    config: SubagentHostConfig,
    registry: SubagentRegistry,
    max_depth: u32,
    max_concurrent: usize,
    /// The parent runtime owns queued preparation; forwarders run on plain
    /// OS threads, and child runtimes disappear when their loops finish.
    scheduler: OnceLock<tokio::runtime::Handle>,
    mcp_session_id: OnceLock<uuid::Uuid>,
}

/// Child task ids are allocated from a high offset so they never collide with
/// the parent turn's monotonically increasing task id.
static CHILD_TASK_ID: AtomicU64 = AtomicU64::new(1);

fn next_child_task_id() -> u64 {
    1_000_000 + CHILD_TASK_ID.fetch_add(1, Ordering::Relaxed)
}

fn err_outcome(tool_call_id: &str, tool_name: &str, message: impl Into<String>) -> ToolCallOutcome {
    ToolCallOutcome {
        tool_call_id: tool_call_id.to_string(),
        tool_name: tool_name.to_string(),
        content: format!("Error: {}", message.into()),
        is_error: true,
        path_changed: None,
        changed_path: None,
        file_before: None,
        file_after: None,
        todos: None,
        attachments: Vec::new(),
    }
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

/// Decide whether a terminal child event deserves a push completion notice:
/// background spawn, nobody holding the completion signal, and the model
/// never received the terminal result through another path.
fn should_notify_completion(background: bool, receiver_count: usize, observed: bool) -> bool {
    background && receiver_count == 0 && !observed
}

/// Watchdog for one child: abort it once its wall-clock budget expires.
/// Already-terminal children are left alone; the forwarder converts the
/// resulting cancellation into a timeout failure (see `take_timed_out`).
async fn enforce_timeout(registry: SubagentRegistry, id: String, timeout_ms: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)).await;
    let still_running = registry
        .get(&id)
        .is_some_and(|snap| !snap.status.is_terminal());
    if !still_running {
        return;
    }
    registry.mark_timed_out(&id, timeout_ms);
    registry.cancel(&id);
}

/// Push a completion notice for a terminal child when no waiter can receive
/// the result inline (background spawn nobody polled). Fire-and-forget
/// spawns would otherwise finish silently and the model would never learn
/// the outcome without polling.
fn maybe_notify_completion(host: &SubagentHost, id: &str, status: SubagentStatus, summary: &str) {
    let (background, subagent_type) = match host.inner.registry.get(id) {
        Some(snap) => (snap.background, snap.subagent_type),
        None => return,
    };
    if !should_notify_completion(
        background,
        host.inner.registry.receiver_count(id),
        host.inner.registry.was_observed(id),
    ) {
        return;
    }
    let _ = host.inner.config.event_sender.send(AgentTaskEvent {
        task_id: host.inner.config.task_id,
        event: AgentEvent::SubagentCompletedNotice {
            id: id.to_string(),
            subagent_type,
            status: status.as_str().to_string(),
            summary: summary.to_string(),
        },
    });
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
    /// Resolved wall-clock budget driving the watchdog.
    timeout_ms: u64,
    /// Child iteration budget: the request override when set, otherwise
    /// unbounded — the child runs until the model stops
    /// calling tools; the watchdog is the backstop. The parent's budget is
    /// never inherited.
    max_iterations: Option<u32>,
    /// Foreground waiter for inline spawns; `None` always runs detached
    /// (background spawns and dequeued launches).
    completion_rx: Option<tokio::sync::watch::Receiver<bool>>,
}

/// Worktree + conversation resolution shared by the immediate and queued
/// launch paths.
struct ChildPrep {
    cfg: EffectiveRuntimeConfig,
    messages: Vec<Message>,
    max_iterations: Option<u32>,
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
    pub fn new(config: SubagentHostConfig, max_depth: u32, max_concurrent: usize) -> Self {
        let registry = config.registry.clone();
        Self {
            inner: Arc::new(SubagentHostInner {
                config,
                registry,
                max_depth,
                max_concurrent,
                scheduler: OnceLock::new(),
                mcp_session_id: OnceLock::new(),
            }),
        }
    }

    /// Children share the root conversation's Desktop tool ownership.
    pub fn with_mcp_session_id(self, session: uuid::Uuid) -> Self {
        let _ = self.inner.mcp_session_id.set(session);
        self
    }

    pub fn mcp_session_id(&self) -> Option<uuid::Uuid> {
        self.inner.mcp_session_id.get().copied()
    }

    pub fn registry(&self) -> &SubagentRegistry {
        &self.inner.registry
    }

    pub fn project_dir(&self) -> &str {
        &self.inner.config.project_dir
    }

    /// Execute a hosted subagent tool call (`task`, `task_output`, `kill_task`).
    pub(crate) async fn execute_hosted_tool_call(
        &self,
        tool_call: &ToolCall,
        args: serde_json::Value,
        context: ToolExecutionContext,
        depth: u32,
    ) -> ToolCallOutcome {
        let tool_call_id = tool_call.id.clone();
        let parent_cancel = context.cancellation.clone();
        match tool_call.function.name.as_str() {
            "task" => {
                let request: SubagentSpawnRequest = match serde_json::from_value(args) {
                    Ok(req) => req,
                    Err(e) => {
                        return err_outcome(
                            &tool_call_id,
                            "task",
                            format!("Invalid task arguments: {e}"),
                        );
                    }
                };
                if request.prompt.trim().is_empty() {
                    return err_outcome(
                        &tool_call_id,
                        "task",
                        "Missing required 'prompt' parameter",
                    );
                }
                if request.description.trim().is_empty() {
                    return err_outcome(
                        &tool_call_id,
                        "task",
                        "Missing required 'description' parameter",
                    );
                }
                let result = self.spawn(request, parent_cancel, depth).await;
                ToolCallOutcome {
                    tool_call_id,
                    tool_name: "task".to_string(),
                    content: result.render(),
                    is_error: result.is_error,
                    path_changed: None,
                    changed_path: None,
                    file_before: None,
                    file_after: None,
                    todos: None,
                    attachments: Vec::new(),
                }
            }
            "task_output" => self.task_output(tool_call_id, args, &context).await,
            "kill_task" => self.kill_task(tool_call_id, args),
            other => err_outcome(
                &tool_call_id,
                other,
                format!("Unknown hosted tool: {other}"),
            ),
        }
    }

    async fn task_output(
        &self,
        tool_call_id: String,
        args: serde_json::Value,
        context: &ToolExecutionContext,
    ) -> ToolCallOutcome {
        let parent_cancel = context.cancellation.clone();
        let Some(task_id) = args.get("task_id").and_then(|v| v.as_str()) else {
            return err_outcome(
                &tool_call_id,
                "task_output",
                "Missing required 'task_id' parameter",
            );
        };
        // A missing or zero timeout used to wait unboundedly, blocking the
        // parent turn in event silence until the TUI's stuck guard killed it.
        // Zero now means the bounded default.
        let timeout_ms = match args.get("timeout_ms").and_then(|v| v.as_u64()) {
            Some(ms) if ms > 0 => ms,
            _ => DEFAULT_TASK_OUTPUT_WAIT_MS,
        };

        let Some(snapshot) = self.inner.registry.get(task_id) else {
            return err_outcome(
                &tool_call_id,
                "task_output",
                format!("Unknown task id '{task_id}'. It may belong to another session or have been cleaned up."),
            );
        };

        let result = if snapshot.status.is_terminal() {
            SubagentResult {
                id: task_id.to_string(),
                status: snapshot.status,
                summary: snapshot.summary.clone(),
                resume_from_hint: Some(task_id.to_string()),
                is_error: matches!(
                    snapshot.status,
                    SubagentStatus::Failed | SubagentStatus::Cancelled
                ),
            }
        } else {
            // Still running: wait up to the deadline (heartbeating so the
            // parent's stuck guard sees life), otherwise report status.
            if let Some(rx) = self.inner.registry.completion_receiver(task_id) {
                let mut rx = rx;
                let deadline =
                    tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
                let heartbeat = std::time::Duration::from_millis(TASK_OUTPUT_HEARTBEAT_MS);
                loop {
                    if *rx.borrow() {
                        break;
                    }
                    let now = tokio::time::Instant::now();
                    if now >= deadline {
                        break;
                    }
                    tokio::select! {
                        _ = tokio::time::sleep_until((now + heartbeat).min(deadline)) => {
                            context.heartbeat();
                        }
                        _ = rx.changed() => break,
                        _ = parent_cancel.wait_aborted() => break,
                    }
                }
            }
            let snap = self.inner.registry.get(task_id).unwrap_or(snapshot);
            SubagentResult {
                id: task_id.to_string(),
                status: snap.status,
                summary: snap.summary.clone(),
                resume_from_hint: Some(task_id.to_string()),
                is_error: matches!(
                    snap.status,
                    SubagentStatus::Failed | SubagentStatus::Cancelled
                ),
            }
        };

        // A terminal delivery means the model holds the result: suppress the
        // push completion notice so it is never announced twice.
        if result.status.is_terminal() {
            self.inner.registry.mark_observed(task_id);
        }

        ToolCallOutcome {
            tool_call_id,
            tool_name: "task_output".to_string(),
            content: result.render(),
            is_error: result.is_error,
            path_changed: None,
            changed_path: None,
            file_before: None,
            file_after: None,
            todos: None,
            attachments: Vec::new(),
        }
    }

    fn kill_task(&self, tool_call_id: String, args: serde_json::Value) -> ToolCallOutcome {
        let Some(task_id) = args.get("task_id").and_then(|v| v.as_str()) else {
            return err_outcome(
                &tool_call_id,
                "kill_task",
                "Missing required 'task_id' parameter",
            );
        };
        if !self.inner.registry.contains(task_id) {
            return err_outcome(
                &tool_call_id,
                "kill_task",
                format!("Unknown task id '{task_id}'"),
            );
        }
        // Killed before it ever started: no thread, no forwarder — finish
        // here and announce the card state directly. The kill confirmation
        // is self-announcing, so the completion notice is suppressed.
        if let Some(queued) = self.inner.registry.take_queued(task_id) {
            queued.controller.abort();
            self.inner.registry.finish(
                task_id,
                SubagentStatus::Cancelled,
                "cancelled while queued".to_string(),
                Vec::new(),
            );
            self.inner.registry.mark_observed(task_id);
            let _ = self.inner.config.event_sender.send(AgentTaskEvent {
                task_id: self.inner.config.task_id,
                event: AgentEvent::SubagentDone {
                    id: task_id.to_string(),
                    summary: "cancelled while queued".to_string(),
                    is_error: true,
                },
            });
            return ToolCallOutcome {
                tool_call_id,
                tool_name: "kill_task".to_string(),
                content: format!("Subagent {task_id} cancelled while queued"),
                is_error: false,
                path_changed: None,
                changed_path: None,
                file_before: None,
                file_after: None,
                todos: None,
                attachments: Vec::new(),
            };
        }
        self.inner.registry.cancel(task_id);
        // A kill that actually cancels a live child is self-announcing (the
        // confirmation above); suppress the completion notice. A kill on an
        // already-finished child leaves the notice path alone — the terminal
        // result was never delivered.
        let still_running = self
            .inner
            .registry
            .get(task_id)
            .is_some_and(|snap| !snap.status.is_terminal());
        if still_running {
            self.inner.registry.mark_observed(task_id);
        }
        ToolCallOutcome {
            tool_call_id,
            tool_name: "kill_task".to_string(),
            content: format!("Subagent {task_id} cancelled"),
            is_error: false,
            path_changed: None,
            changed_path: None,
            file_before: None,
            file_after: None,
            todos: None,
            attachments: Vec::new(),
        }
    }

    /// Resolve and launch a child agent. See module docs for the full flow.
    async fn spawn(
        &self,
        request: SubagentSpawnRequest,
        parent_cancel: AbortSignal,
        depth: u32,
    ) -> SubagentResult {
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

        // Concurrency is enforced at admission below (started children only;
        // over-capacity spawns queue FIFO instead of failing).

        // Resolve type / capability / model / cwd (explicit > type > parent).
        let custom = &self.inner.config.custom_agents;
        let parent_defaults = SubagentParentDefaults {
            model: self.inner.config.model.clone(),
            project_dir: self.inner.config.project_dir.clone(),
            depth,
        };
        let mut cfg = match resolve_effective_config(&request, &parent_defaults, custom) {
            Ok(cfg) => cfg,
            Err(e) => return err_result(e),
        };
        if let Some(chosen) = crate::config::subagent_model_for(
            &self.inner.config.subagent_models,
            &request.subagent_type,
        ) {
            cfg.model = Some(chosen.model.clone());
            cfg.provider = Some(chosen.provider.clone());
        }

        // Plan-mode parent: every child runs read-only. Coerce instead of
        // rejecting — the `task` default is `general-purpose` (capability
        // `All`), so a hard error fails every default spawn and `task`
        // looks unavailable in Plan mode. The child-registry prune plus the
        // Plan-mode permission checks keep the no-mutation invariant
        // regardless of the requested type.
        let (effective_capability, coerced_to_read_only) =
            capability_for_parent_mode(self.inner.config.parent_mode, cfg.capability);
        if coerced_to_read_only {
            tracing::info!(
                subagent_type = %request.subagent_type,
                "Plan mode coerces child to read-only tools"
            );
            cfg.capability = effective_capability;
        }

        // Resume validation happens before admission so a bad `resume_from`
        // fails the `task` call instead of queueing a doomed child.
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
        }

        let id = request
            .task_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        // explore/plan wait inline by default: the parent asked for the answer
        // and rarely has useful parallel work for the same slot.
        let background = request.resolved_run_in_background();

        // Admission: start now when a concurrency slot is free, otherwise
        // queue FIFO and return a Pending result immediately — never block
        // the parent turn waiting for a slot.
        let snapshot = SubagentSnapshot {
            id: id.clone(),
            subagent_type: request.subagent_type.clone(),
            description: request.description.clone(),
            prompt: request.prompt.clone(),
            status: SubagentStatus::Running,
            summary: None,
            conversation: Vec::new(),
            model: model.clone(),
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
                    },
                });
                // Also covers a slot freed just before admission.
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
        })
        .await
    }

    /// Finish a child that failed before its loop started (prep errors) so the
    /// registry never strands a `Running` entry with no forwarder.
    fn fail_child(&self, id: &str, message: &str) {
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
        self.try_start_queued();
    }

    /// Resolve the child's checkout (or reuse the resumed child's), then build
    /// the system prompt and forked conversation. Runs after admission so a
    /// queued child does not hold a worktree while it waits.
    async fn prepare_child(
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
            // A resumed child continues in its own checkout. Claim it first:
            // two concurrent resumes of one source must not share a directory.
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
            // A read-only child (explore, plan, anything under a Plan-mode
            // parent) cannot change files, so it reads the parent root
            // directly: no checkout to create, seed, or clean up.
            && cfg.capability != SubagentCapabilityMode::ReadOnly
        {
            if let Some(root) = worktree::find_repo_root(Path::new(&self.inner.config.project_dir))
            {
                let label = format!("{}-{}", request.subagent_type, short_id(id));
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

    /// Launch one prepared child: register cancellation, announce the card,
    /// forward its events, run its loop on a dedicated thread, and either
    /// return the inline result (foreground with a waiter) or a Running
    /// handle (background spawns and dequeued launches, whose outcome flows
    /// through `task_output`, the completion notice, or a later poll).
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
        } = prepared;
        // A child token is linked to the parent without a relay task. The
        // registry keeps the controller so kill_task can cancel just this
        // child as well.
        let child_signal = controller.signal();
        self.inner.registry.register_cancel(&id, controller);
        // explore/plan wait inline by default; everything else detaches.
        let background = request.resolved_run_in_background();

        // Tell the UI a subagent card exists (the forwarder streams the rest).
        let _ = self.inner.config.event_sender.send(AgentTaskEvent {
            task_id: self.inner.config.task_id,
            event: AgentEvent::SubagentStarted {
                id: id.clone(),
                subagent_type: request.subagent_type.clone(),
                description: request.description.clone(),
            },
        });

        // Child events flow through a private channel; the forwarder re-emits
        // them as Subagent* events on the parent's channel.
        let (child_tx, child_rx) = std::sync::mpsc::channel::<AgentTaskEvent>();
        let child_task_id = next_child_task_id();
        tracing::info!(child_id = %id, parent_task_id = self.inner.config.task_id, child_task_id, model = %model, max_iterations = ?max_iterations, "Subagent run admitted");

        let host = self.clone();
        let child_id = id.clone();

        // Translate child events for the UI (main runtime). The child's loop
        // writes plain events to the private channel; a dedicated forwarder
        // thread re-emits them as Subagent* events on the parent's channel. A
        // blocking receive must never occupy an async executor worker.
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
                    // A panicked forwarder must not strand the child as Running.
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

        // The child agent loop runs on its own current-thread runtime inside a
        // dedicated OS thread. A dedicated runtime (rather than `tokio::spawn`)
        // breaks the mutually-recursive hosted-tool future tree: a child can
        // spawn grandchildren without the parent's future having to prove Send
        // recursively. Communication (approvals, cancel watch, completion) is
        // cross-runtime-safe.
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
            thinking_level: host.inner.config.thinking_level.clone(),
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
            }),
            is_subagent: true,
            depth: depth + 1,
            loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
            loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
            // Children always trim: they are short-lived and cheap.
            smart_compaction: false,
            user_inbox: None,
            extra_tools: Vec::new(),
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

        // Wall-clock watchdog: abort a still-running child once its budget
        // expires. Finished children are left alone.
        {
            let watchdog_registry = self.inner.registry.clone();
            let watchdog_id = id.clone();
            tokio::spawn(async move {
                enforce_timeout(watchdog_registry, watchdog_id, timeout_ms).await;
            });
        }

        let foreground = if background { None } else { completion_rx };
        if let Some(mut completion) = foreground {
            // Foreground: wait for the child to finish (or parent cancel).
            loop {
                tokio::select! {
                    _ = completion.changed() => {
                        if *completion.borrow() { break; }
                    }
                    _ = parent_cancel.wait_aborted() => {
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
                    depth: depth + 1,
                    background,
                    started_at: chrono::Utc::now(),
                    finished_at: None,
                    cwd: None,
                    worktree: None,
                });
            SubagentResult {
                id: id.clone(),
                status: snap.status,
                summary: snap.summary,
                resume_from_hint: Some(id),
                is_error: matches!(
                    snap.status,
                    SubagentStatus::Failed | SubagentStatus::Cancelled
                ),
            }
        } else {
            // Background spawns and dequeued launches run detached: the
            // outcome flows through `task_output`, the completion notice,
            // or a later poll — never through this return value.
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
    /// Queued launches always run detached — even a foreground request that
    /// waited in line reports through `task_output`/notice, since its `task`
    /// call already returned the Pending handle.
    pub(crate) fn try_start_queued(&self) {
        let Some(scheduler) = self.inner.scheduler.get() else {
            return; // No spawn has been admitted by this host yet.
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
                })
                .await;
            });
        }
    }
}

/// Translate a child's private event stream into `AgentEvent::Subagent*`
/// events on the parent's channel, and record the final transcript. Runs on a
/// dedicated OS thread: the receive and the sends are blocking, and must not
/// occupy an async executor worker.
fn forward_child_events(
    child_rx: std::sync::mpsc::Receiver<AgentTaskEvent>,
    host: SubagentHost,
    subagent_id: String,
) {
    let parent_sender = host.inner.config.event_sender.clone();
    let parent_task_id = host.inner.config.task_id;
    let mut full_text = String::new();
    // A chatty child must not grow the parent's memory without bound; the
    // summary keeps its own cap, so dropping the tail only affects display.
    const MAX_SUBAGENT_STREAM_BYTES: usize = 256 * 1024;
    let mut streamed_bytes = 0usize;

    let send = |event: AgentEvent| {
        let _ = parent_sender.send(AgentTaskEvent {
            task_id: parent_task_id,
            event,
        });
    };

    while let Ok(task_event) = child_rx.recv() {
        match task_event.event {
            AgentEvent::TextDelta(delta) => {
                if streamed_bytes < MAX_SUBAGENT_STREAM_BYTES {
                    streamed_bytes = streamed_bytes.saturating_add(delta.len());
                    send(AgentEvent::SubagentText {
                        id: subagent_id.clone(),
                        text: delta.clone(),
                    });
                    if streamed_bytes >= MAX_SUBAGENT_STREAM_BYTES {
                        send(AgentEvent::SubagentText {
                            id: subagent_id.clone(),
                            text: "\n… child output truncated …\n".to_string(),
                        });
                    }
                }
                if full_text.len() < MAX_SUBAGENT_STREAM_BYTES {
                    full_text.push_str(&delta);
                }
            }
            AgentEvent::AssistantText(text) => {
                full_text = text.clone();
                let mut text = text;
                if text.len() > MAX_SUBAGENT_STREAM_BYTES {
                    let end =
                        crate::util::truncate_at_char_boundary(&text, MAX_SUBAGENT_STREAM_BYTES)
                            .len();
                    text.truncate(end);
                    text.push_str("\n… child output truncated …\n");
                }
                send(AgentEvent::SubagentText {
                    id: subagent_id.clone(),
                    text,
                });
            }
            AgentEvent::ToolCallStart { id, name, args } => {
                send(AgentEvent::SubagentToolCallStart {
                    id: subagent_id.clone(),
                    call_id: id,
                    name,
                    args,
                });
            }
            AgentEvent::ToolCallProgress { id, chunk } => {
                send(AgentEvent::SubagentToolCallProgress {
                    id: subagent_id.clone(),
                    call_id: id,
                    chunk,
                });
            }
            AgentEvent::ToolHeartbeat { id } => {
                // Liveness only — forward as-is so the parent's stuck guard
                // also sees the child's quiet-but-alive tools.
                send(AgentEvent::ToolHeartbeat { id });
            }
            AgentEvent::ToolCallResult {
                id,
                name,
                result,
                is_error,
            } => {
                send(AgentEvent::SubagentToolCallResult {
                    id: subagent_id.clone(),
                    call_id: id,
                    name,
                    result,
                    is_error,
                });
            }
            AgentEvent::TodoUpdate { todos, .. } => {
                send(AgentEvent::TodoUpdate {
                    subagent_id: Some(subagent_id.clone()),
                    todos,
                });
            }
            AgentEvent::FileChange {
                path,
                diff_summary,
                before,
                after,
                ..
            } => {
                send(AgentEvent::FileChange {
                    subagent_id: Some(subagent_id.clone()),
                    path,
                    diff_summary,
                    before,
                    after,
                });
            }
            AgentEvent::ApprovalRequested { source: _, request } => {
                // The child waits on the shared broker; surface the popup but
                // tag it as coming from this subagent so the TUI keeps it
                // distinct from the parent's own concurrent approvals.
                send(AgentEvent::ApprovalRequested {
                    source: crate::agent::ApprovalSource::Subagent {
                        id: subagent_id.clone(),
                    },
                    request,
                });
            }
            AgentEvent::CompactionStarted { .. } => {}
            AgentEvent::ContextCompacted { summary, .. } => {
                send(AgentEvent::SubagentText {
                    id: subagent_id.clone(),
                    text: format!("[context compacted] {summary}"),
                });
            }
            AgentEvent::GenerationProgress {
                output_bytes,
                tool_name,
                ..
            } => {
                // Re-tag with this child's id so the parent attributes the
                // bytes to the subagent instead of its own turn.
                send(AgentEvent::GenerationProgress {
                    subagent_id: Some(subagent_id.clone()),
                    output_bytes,
                    tool_name,
                });
            }
            AgentEvent::Done { conversation, .. } => {
                let summary = completion_summary(&full_text, DEFAULT_SUBAGENT_SUMMARY_CAP);
                // Settle the checkout before publishing completion: a resume
                // that observes the terminal status must not race a release
                // resetting the same directory.
                settle_worktree_blocking(&host, &subagent_id);
                host.inner.registry.finish(
                    &subagent_id,
                    SubagentStatus::Completed,
                    summary.clone(),
                    bound_conversation(conversation),
                );
                send(AgentEvent::SubagentDone {
                    id: subagent_id.clone(),
                    summary: summary.clone(),
                    is_error: false,
                });
                maybe_notify_completion(&host, &subagent_id, SubagentStatus::Completed, &summary);
                break;
            }
            AgentEvent::Cancelled {
                conversation,
                partial_text,
                ..
            } => {
                // A watchdog abort lands here too: convert recorded timeouts
                // into Failed outcomes (transcript kept for resume_from)
                // instead of plain cancellations.
                let timed_out = host.inner.registry.take_timed_out(&subagent_id);
                let (status, summary) = match timed_out {
                    Some(ms) => {
                        let note = format!(
                            "Subagent timed out after {}s of wall-clock time.",
                            ms / 1_000
                        );
                        let summary = if partial_text.trim().is_empty() {
                            format!(
                                "{note} Resume with resume_from:{subagent_id} if follow-up work is needed."
                            )
                        } else {
                            completion_summary(
                                &format!(
                                    "{note}\nPartial output:\n{partial_text}\nResume with resume_from:{subagent_id}."
                                ),
                                DEFAULT_SUBAGENT_SUMMARY_CAP,
                            )
                        };
                        (SubagentStatus::Failed, summary)
                    }
                    None => {
                        let summary = if partial_text.trim().is_empty() {
                            "cancelled".to_string()
                        } else {
                            completion_summary(&partial_text, DEFAULT_SUBAGENT_SUMMARY_CAP)
                        };
                        (SubagentStatus::Cancelled, summary)
                    }
                };
                settle_worktree_blocking(&host, &subagent_id);
                host.inner.registry.finish(
                    &subagent_id,
                    status,
                    summary.clone(),
                    bound_conversation(conversation),
                );
                let is_error = status != SubagentStatus::Completed;
                send(AgentEvent::SubagentDone {
                    id: subagent_id.clone(),
                    summary: summary.clone(),
                    is_error,
                });
                maybe_notify_completion(&host, &subagent_id, status, &summary);
                break;
            }
            AgentEvent::Error {
                message: msg,
                conversation,
            } => {
                let summary = completion_summary(&msg, DEFAULT_SUBAGENT_SUMMARY_CAP);
                settle_worktree_blocking(&host, &subagent_id);
                host.inner.registry.finish(
                    &subagent_id,
                    SubagentStatus::Failed,
                    summary.clone(),
                    bound_conversation(conversation),
                );
                send(AgentEvent::SubagentDone {
                    id: subagent_id.clone(),
                    summary: summary.clone(),
                    is_error: true,
                });
                maybe_notify_completion(&host, &subagent_id, SubagentStatus::Failed, &summary);
                break;
            }
            // A child's spend is the session's spend: pass it up unchanged
            // (grandchildren arrive here already forwarded by their parent).
            AgentEvent::CallUsage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                cost_usd,
                cost_estimated,
                subagent_id: nested,
            } => send(AgentEvent::CallUsage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                cost_usd,
                cost_estimated,
                subagent_id: nested.or_else(|| Some(subagent_id.clone())),
            }),
            // Not relevant from a child loop.
            AgentEvent::Thinking
            | AgentEvent::ReasoningDelta(_)
            | AgentEvent::TurnUsage { .. }
            | AgentEvent::UserMessagesInjected { .. }
            | AgentEvent::Retry { .. }
            | AgentEvent::ModelsDiscovered { .. }
            | AgentEvent::ModelDiscoveryFailed { .. }
            | AgentEvent::ModelCatalogUpdated { .. }
            | AgentEvent::SubagentStarted { .. }
            | AgentEvent::SubagentText { .. }
            | AgentEvent::SubagentToolCallStart { .. }
            | AgentEvent::SubagentToolCallProgress { .. }
            | AgentEvent::SubagentToolCallResult { .. }
            | AgentEvent::SubagentDone { .. }
            | AgentEvent::SubagentCompletedNotice { .. } => {}
        }
    }

    // The child's channel closed without a terminal event (e.g. the child
    // thread panicked). Never leave the registry entry stuck in "running" —
    // task_output would otherwise wait on it forever.
    if let Some(snapshot) = host.inner.registry.get(&subagent_id) {
        if !snapshot.status.is_terminal() {
            settle_worktree_blocking(&host, &subagent_id);
            host.inner.registry.finish(
                &subagent_id,
                SubagentStatus::Failed,
                "Subagent ended without a result (child process error).".to_string(),
                Vec::new(),
            );
            send(AgentEvent::SubagentDone {
                id: subagent_id.clone(),
                summary: "Subagent ended without a result (child process error).".to_string(),
                is_error: true,
            });
            maybe_notify_completion(
                &host,
                &subagent_id,
                SubagentStatus::Failed,
                "Subagent ended without a result (child process error).",
            );
        }
    }
    // The checkout was settled BEFORE the terminal status was published.
    // Never release it again here: a resume may already own it.
    // A slot freed (or a queued entry died): start waiting spawns FIFO.
    host.try_start_queued();
}

/// Release a finished child's checkout before its terminal status is
/// published. A clean checkout returns to the warm pool; a dirty one stays on
/// disk for review with its flag flipped. Settling before `finish` means a
/// resume that sees the terminal status cannot race the release.
fn settle_worktree_blocking(host: &SubagentHost, id: &str) -> bool {
    let Some(info) = host
        .inner
        .registry
        .get(id)
        .and_then(|snap| snap.worktree.clone())
    else {
        return true;
    };
    let clean = worktree::release_sync(&info);
    if !clean {
        host.inner.registry.update(id, |snap| {
            if let Some(wt) = snap.worktree.as_mut() {
                wt.dirty = true;
            }
        });
    }
    clean
}

/// Compact id label for a worktree branch/dir name.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::shared_permission_engine;
    use crate::types::ToolDefinition;

    fn def(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: String::new(),
            parameters: serde_json::json!({}),
        }
    }

    #[test]
    fn notify_decision_pushes_only_unobserved_background_without_waiters() {
        // Background, nobody waiting, never delivered: notify.
        assert!(should_notify_completion(true, 0, false));
        // Foreground spawn holds its watcher: inline delivery, no notice.
        assert!(!should_notify_completion(false, 1, false));
        // Background with an active task_output poll: the poll delivers.
        assert!(!should_notify_completion(true, 1, false));
        // Terminal result already delivered (or kill acknowledged): no dup.
        assert!(!should_notify_completion(true, 0, true));
        assert!(!should_notify_completion(false, 0, true));
    }

    fn queue_test_host(
        registry: SubagentRegistry,
        max_concurrent: usize,
    ) -> (SubagentHost, std::sync::mpsc::Receiver<AgentTaskEvent>) {
        let (event_sender, event_rx) = std::sync::mpsc::channel();
        let host = SubagentHost::new(
            SubagentHostConfig {
                custom_agents: Vec::new(),
                subagent_models: Default::default(),
                shell_env: crate::tools::ShellEnv::Inherit,
                only_tools: None,
                event_sender,
                task_id: 1,
                provider_id: "test".into(),
                provider_registry: Arc::new(crate::providers::ProviderRegistry::new()),
                catalog: None,
                permission_engine: shared_permission_engine(crate::types::AgentMode::Build),
                approval_broker: ApprovalBroker::new(),
                mcp_manager: None,
                project_dir: ".".into(),
                model: "test-model".into(),
                thinking_level: "off".into(),
                parent_mode: crate::types::AgentMode::Build,
                registry,
            },
            2,
            max_concurrent,
        );
        (host, event_rx)
    }

    fn queue_test_request() -> SubagentSpawnRequest {
        SubagentSpawnRequest {
            prompt: "do it".into(),
            description: "d".into(),
            subagent_type: "explore".into(),
            run_in_background: Some(true),
            capability_mode: None,
            cwd: None,
            isolation: Default::default(),
            max_iterations: None,
            timeout_ms: None,
            resume_from: None,
            task_id: None,
        }
    }

    fn test_snapshot(id: &str) -> SubagentSnapshot {
        SubagentSnapshot {
            id: id.into(),
            subagent_type: "explore".into(),
            description: "test".into(),
            prompt: "Explicit handoff".into(),
            status: SubagentStatus::Running,
            summary: None,
            conversation: vec![],
            model: "test-model".into(),
            depth: 1,
            background: true,
            started_at: chrono::Utc::now(),
            finished_at: None,
            cwd: None,
            worktree: None,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forwarder_drains_queue_even_after_preparation_failure() {
        let root = tempfile::tempdir().unwrap();
        let registry = SubagentRegistry::new();
        registry.insert(test_snapshot("blocker"));
        let mut source = test_snapshot("source");
        source.status = SubagentStatus::Completed;
        source.worktree = Some(worktree::WorktreeInfo::synthetic(
            root.path().to_string_lossy(),
            root.path().to_string_lossy(),
            "branch",
            "base",
            true,
        ));
        registry.insert(source);
        // Simulate an earlier resume already owning the source's checkout.
        assert!(worktree::claim_for_resume(root.path()));
        let (host, events) = queue_test_host(registry.clone(), 1);
        let mut request = queue_test_request();
        request.resume_from = Some("source".into());
        request.isolation = SubagentIsolation::None;
        request.run_in_background = Some(false);
        let failed_prep = host.spawn(request.clone(), AbortSignal::never(), 0).await;
        assert_eq!(failed_prep.status, SubagentStatus::Pending);
        request.resume_from = None;
        request.cwd = Some(root.path().to_string_lossy().into_owned());
        let next = host.spawn(request, AbortSignal::never(), 0).await;
        assert_eq!(next.status, SubagentStatus::Pending);
        assert!(registry.get(&next.id).unwrap().background);

        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(AgentTaskEvent {
            task_id: 7,
            event: AgentEvent::Done {
                conversation: vec![],
                tokens: 0,
            },
        })
        .unwrap();
        drop(tx);
        // No runtime entered on this thread: dispatch must use the host handle.
        std::thread::spawn(move || forward_child_events(rx, host, "blocker".into()))
            .join()
            .expect("forwarder must not panic outside Tokio");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !registry.get(&next.id).unwrap().status.is_terminal() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("a prep failure must free its slot and start the next child");
        worktree::release_resume_claim(root.path());
        assert_eq!(registry.started_count(), 0);
        assert_eq!(registry.queued_count(), 0);
        assert!(registry
            .get(&failed_prep.id)
            .unwrap()
            .summary
            .unwrap()
            .contains("already in use"));
        // The second child reaches its loop; an unconfigured test provider
        // fails locally without any network request.
        assert!(registry
            .get(&next.id)
            .unwrap()
            .summary
            .unwrap()
            .contains("Unknown provider"));
        assert!(events.try_iter().any(|event| matches!(event.event,
            AgentEvent::SubagentCompletedNotice { ref id, .. } if id == &failed_prep.id)));
    }

    #[test]
    fn worktree_completion_on_plain_thread_does_not_release_twice() {
        let root = tempfile::tempdir().unwrap();
        for args in [
            vec!["init", "--quiet"],
            vec![
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ],
        ] {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(root.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::fs::write(root.path().join("child.txt"), "keep this work").unwrap();
        let registry = SubagentRegistry::new();
        let mut snapshot = test_snapshot("child");
        snapshot.worktree = Some(worktree::WorktreeInfo::synthetic(
            root.path().to_string_lossy(),
            root.path().to_string_lossy(),
            "branch",
            "HEAD",
            false,
        ));
        registry.insert(snapshot);
        let (host, _events) = queue_test_host(registry.clone(), 1);
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(AgentTaskEvent {
            task_id: 7,
            event: AgentEvent::Done {
                conversation: vec![],
                tokens: 0,
            },
        })
        .unwrap();
        drop(tx);
        std::thread::spawn(move || forward_child_events(rx, host, "child".into()))
            .join()
            .expect("worktree completion must not try tokio::spawn on the forwarder thread");
        let snapshot = registry.get("child").unwrap();
        assert_eq!(snapshot.status, SubagentStatus::Completed);
        assert!(snapshot.worktree.unwrap().dirty);
        assert_eq!(
            std::fs::read_to_string(root.path().join("child.txt")).unwrap(),
            "keep this work"
        );
    }

    #[tokio::test]
    async fn cancelled_spawn_is_rejected_before_admission() {
        let registry = SubagentRegistry::new();
        let (host, _events) = queue_test_host(registry.clone(), 0);
        let controller = AbortController::new();
        controller.abort();
        let result = host
            .spawn(queue_test_request(), controller.signal(), 0)
            .await;
        assert!(result.is_error);
        assert!(registry.list().is_empty());
        assert_eq!(registry.queued_count(), 0);
    }

    /// Unbounded is the child default: an omitted
    /// `max_iterations` reaches the loop as `None`, an explicit value passes
    /// through untouched. The parent's budget is never inherited.
    #[tokio::test]
    async fn prepare_child_passes_the_iteration_budget_through() {
        let (host, _event_rx) = queue_test_host(SubagentRegistry::new(), 2);
        let parent_defaults = SubagentParentDefaults {
            model: "test-model".into(),
            project_dir: ".".into(),
            depth: 0,
        };

        let mut request = queue_test_request();
        request.isolation = SubagentIsolation::None;
        request.max_iterations = None;
        let cfg =
            resolve_effective_config(&request, &parent_defaults, &[]).expect("explore resolves");
        let prep = host
            .prepare_child("child-unbounded", &request, cfg)
            .await
            .expect("prep succeeds");
        assert_eq!(
            prep.max_iterations, None,
            "omitted budget must stay unbounded"
        );

        let mut request = queue_test_request();
        request.isolation = SubagentIsolation::None;
        request.max_iterations = Some(7);
        let cfg =
            resolve_effective_config(&request, &parent_defaults, &[]).expect("explore resolves");
        let prep = host
            .prepare_child("child-capped", &request, cfg)
            .await
            .expect("prep succeeds");
        assert_eq!(prep.max_iterations, Some(7), "explicit cap passes through");
    }

    /// A child's file/todo effects must carry the child's identity so a
    /// consumer can never attribute them to the parent workspace.
    #[test]
    fn forwarded_child_effects_carry_the_child_identity() {
        let (tx, rx) = std::sync::mpsc::channel::<AgentTaskEvent>();
        let registry = SubagentRegistry::new();
        let (host, event_rx) = queue_test_host(registry, 2);
        let id = "child-x".to_string();
        let forwarder = {
            let host = host.clone();
            let id = id.clone();
            std::thread::spawn(move || forward_child_events(rx, host, id))
        };

        tx.send(AgentTaskEvent {
            task_id: 7,
            event: AgentEvent::FileChange {
                subagent_id: None,
                path: "src/a.rs".into(),
                diff_summary: "M src/a.rs".into(),
                before: Some("old".into()),
                after: Some("new".into()),
            },
        })
        .unwrap();
        tx.send(AgentTaskEvent {
            task_id: 7,
            event: AgentEvent::TodoUpdate {
                subagent_id: None,
                todos: Vec::new(),
            },
        })
        .unwrap();
        drop(tx);
        forwarder.join().unwrap();

        let mut saw_file = false;
        let mut saw_todo = false;
        while let Ok(event) = event_rx.try_recv() {
            match event.event {
                AgentEvent::FileChange { subagent_id, .. } => {
                    assert_eq!(subagent_id.as_deref(), Some("child-x"));
                    saw_file = true;
                }
                AgentEvent::TodoUpdate { subagent_id, .. } => {
                    assert_eq!(subagent_id.as_deref(), Some("child-x"));
                    saw_todo = true;
                }
                _ => {}
            }
        }
        assert!(saw_file, "child file change was not forwarded");
        assert!(saw_todo, "child todo update was not forwarded");
    }

    /// A silent child must not occupy the runtime: the forwarder lives on its
    /// own thread, so timers keep firing while it blocks on the receive.
    #[tokio::test(flavor = "current_thread")]
    async fn quiet_child_forwarder_does_not_block_the_runtime() {
        let (tx, rx) = std::sync::mpsc::channel::<AgentTaskEvent>();
        let registry = SubagentRegistry::new();
        let (host, _event_rx) = queue_test_host(registry, 4);
        let id = "quiet-child".to_string();
        host.inner.registry.insert(SubagentSnapshot {
            id: id.clone(),
            subagent_type: "explore".into(),
            description: "quiet".into(),
            prompt: String::new(),
            status: SubagentStatus::Running,
            summary: None,
            conversation: Vec::new(),
            model: "test-model".into(),
            depth: 1,
            background: true,
            started_at: chrono::Utc::now(),
            finished_at: None,
            cwd: None,
            worktree: None,
        });
        let forwarder = std::thread::spawn({
            let host = host.clone();
            let id = id.clone();
            move || forward_child_events(rx, host, id)
        });

        // On a single-threaded runtime this timer only fires if the blocking
        // receive is off the executor.
        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            tokio::time::sleep(std::time::Duration::from_millis(50)),
        )
        .await
        .expect("runtime must stay responsive while a child is silent");

        drop(tx);
        forwarder.join().unwrap();
        let snapshot = host.inner.registry.get(&id).expect("snapshot");
        assert!(
            snapshot.status.is_terminal(),
            "a closed child channel must finalize the child"
        );
    }

    /// The watchdog aborts still-running children and records the timeout;
    /// finished children are left alone.
    #[tokio::test]
    async fn enforce_timeout_aborts_only_running_children() {
        let registry = SubagentRegistry::new();
        let mut snap = SubagentSnapshot {
            id: "slow".into(),
            subagent_type: "explore".into(),
            description: "d".into(),
            prompt: String::new(),
            status: SubagentStatus::Running,
            summary: None,
            conversation: Vec::new(),
            model: "m".into(),
            depth: 1,
            background: true,
            started_at: chrono::Utc::now(),
            finished_at: None,
            cwd: None,
            worktree: None,
        };
        registry.insert(snap.clone());
        snap.id = "fast".to_string();
        registry.insert(snap);
        registry.finish("fast", SubagentStatus::Completed, "done".into(), vec![]);

        enforce_timeout(registry.clone(), "slow".into(), 20).await;
        enforce_timeout(registry.clone(), "fast".into(), 20).await;

        assert_eq!(registry.take_timed_out("slow"), Some(20));
        assert_eq!(registry.take_timed_out("fast"), None);
        // Watchdog never finishes: status transitions stay with the forwarder.
        assert_eq!(
            registry.get("slow").map(|s| s.status),
            Some(SubagentStatus::Running)
        );
    }

    /// Full slots queue instead of failing: Pending result, registry-visible,
    /// pollable via task_output, cancellable before start (no thread runs).
    #[tokio::test]
    async fn spawn_queues_when_full_and_kill_cancels_queued() {
        use crate::cancellation::AbortSignal;

        let registry = SubagentRegistry::new();
        // Zero slots forces every spawn onto the queue.
        let (host, _events) = queue_test_host(registry.clone(), 0);
        let result = host
            .spawn(queue_test_request(), AbortSignal::never(), 0)
            .await;
        assert_eq!(result.status, SubagentStatus::Pending);
        assert!(
            result
                .summary
                .as_deref()
                .unwrap_or("")
                .contains("queued at position 1"),
            "{:?}",
            result.summary
        );
        let id = result.id.clone();
        assert_eq!(registry.queued_count(), 1);
        assert_eq!(
            registry.get(&id).map(|s| s.status),
            Some(SubagentStatus::Pending)
        );

        // A queued child is pollable (short wait: still pending, no error).
        let outcome = host
            .task_output(
                "call-1".into(),
                serde_json::json!({"task_id": id, "timeout_ms": 1}),
                &crate::tools::ToolExecutionContext::default(),
            )
            .await;
        assert!(!outcome.is_error);

        // Kill before start: dequeued, terminal, observed (no notice later).
        let kill = host.kill_task("call-2".into(), serde_json::json!({"task_id": id}));
        assert!(!kill.is_error);
        assert_eq!(registry.queued_count(), 0);
        assert_eq!(
            registry.get(&id).map(|s| s.status),
            Some(SubagentStatus::Cancelled)
        );
        assert!(registry.was_observed(&id));
    }

    #[test]
    fn tool_policy_allows_by_capability_and_allowlist() {
        use SubagentCapabilityMode::*;

        // Read-only child: reads allowed, mutations and hosted tools denied.
        let read_only = ToolPolicy {
            capability: ReadOnly,
            allowlist: None,
        };
        assert!(read_only.allows("read_file"));
        assert!(read_only.allows("grep"));
        assert!(!read_only.allows("write_file"));
        assert!(!read_only.allows("shell"));
        assert!(!read_only.allows("task"));

        // Read-write child: writes allowed, shell still denied.
        let rw = ToolPolicy {
            capability: ReadWrite,
            allowlist: None,
        };
        assert!(rw.allows("edit_file"));
        assert!(!rw.allows("shell"));

        // Execute child: shell allowed, nested spawns still denied.
        let exec = ToolPolicy {
            capability: Execute,
            allowlist: None,
        };
        assert!(exec.allows("shell"));
        assert!(!exec.allows("task"));

        // All capability: hosted tools allowed.
        let all = ToolPolicy {
            capability: All,
            allowlist: None,
        };
        assert!(all.allows("task"));
        assert!(all.allows("task_output"));
        assert!(all.allows("kill_task"));
        assert!(all.allows("shell"));

        // A type allowlist narrows everything, even for All capability.
        let narrowed = ToolPolicy {
            capability: All,
            allowlist: Some(vec!["read_file".to_string(), "grep".to_string()]),
        };
        assert!(narrowed.allows("read_file"));
        assert!(!narrowed.allows("shell"));
        assert!(!narrowed.allows("task"));
    }

    #[test]
    fn tool_policy_filter_definitions_applies_both_gates() {
        let policy = ToolPolicy {
            capability: SubagentCapabilityMode::ReadOnly,
            allowlist: Some(vec!["read_file".to_string(), "write_file".to_string()]),
        };
        let defs = vec![
            def("read_file"),
            def("list_dir"),
            def("write_file"),
            def("shell"),
            def("task"),
        ];
        let names: Vec<String> = policy
            .filter_definitions(defs)
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert_eq!(names, vec!["read_file"]);
    }

    #[tokio::test]
    async fn task_output_positive_timeout_returns_current_status() {
        let registry = SubagentRegistry::new();
        registry.insert(SubagentSnapshot {
            id: "slow-child".into(),
            subagent_type: "explore".into(),
            description: "slow test".into(),
            prompt: String::new(),
            status: SubagentStatus::Running,
            summary: None,
            conversation: Vec::new(),
            model: "test-model".into(),
            depth: 1,
            background: true,
            started_at: chrono::Utc::now(),
            finished_at: None,
            cwd: None,
            worktree: None,
        });
        let (event_sender, _event_receiver) = std::sync::mpsc::channel();
        let host = SubagentHost::new(
            SubagentHostConfig {
                custom_agents: Vec::new(),
                subagent_models: Default::default(),
                shell_env: crate::tools::ShellEnv::Inherit,
                only_tools: None,
                event_sender,
                task_id: 1,
                provider_id: "test".into(),
                provider_registry: Arc::new(crate::providers::ProviderRegistry::new()),
                catalog: None,
                permission_engine: shared_permission_engine(crate::types::AgentMode::Build),
                approval_broker: ApprovalBroker::new(),
                mcp_manager: None,
                project_dir: ".".into(),
                model: "test-model".into(),
                thinking_level: "off".into(),
                parent_mode: crate::types::AgentMode::Build,
                registry,
            },
            2,
            2,
        );

        let started = std::time::Instant::now();
        let outcome = host
            .task_output(
                "call-1".into(),
                serde_json::json!({"task_id": "slow-child", "timeout_ms": 10}),
                &ToolExecutionContext::new(AbortSignal::never()),
            )
            .await;
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert!(!outcome.is_error);
        assert!(outcome.content.contains("status: running"));
    }
}
