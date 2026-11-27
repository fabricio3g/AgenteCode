//! Universal Streamable HTTP MCP & native orchestration server (`orchestrator_v1`).
//!
//! Any coding engine (`agente-core`, Claude Code, Codex, ACP agents, or CLI
//! clients) receives a scoped bearer-authenticated MCP endpoint (or equivalent
//! native `Tool` adapters) so any engine can inspect drivers, spawn peer turns
//! in isolated worktrees, steer or cancel tasks, and read/post Swarm findings.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use agente_core::swarm::{BoardStore, LEAD};
use agente_core::tools::{Tool, ToolError, ToolExecutionMode, ToolKind};
use agente_drivers::InjectedMcpServer;
use agente_protocol::{
    RuntimeEvent, SessionId, SessionWorktree, StartTurn, TurnId, TurnMode, TurnOutcome, TurnStatus,
    UserInput,
};
use agente_runtime::{OrchestratorContext, OrchestratorProvider, RuntimeHandle};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::task::AbortHandle;
use uuid::Uuid;

const PROTOCOL_VERSION: &str = "2025-06-18";
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_WAIT_TIMEOUT_SECS: u64 = 600;
const MAX_SUMMARY_CHARS: usize = 16_000;

/// Guardrail configuration for the daemon orchestrator.
#[derive(Debug, Clone)]
pub struct OrchestratorConfig {
    /// Maximum delegation nesting depth (`depth >= max_depth` cannot spawn).
    pub max_depth: u32,
    /// Maximum concurrently running orchestrated child turns across the daemon.
    pub max_concurrent: usize,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            max_depth: 2,
            max_concurrent: 4,
        }
    }
}

#[derive(Debug, Clone)]
struct TokenScope {
    token: String,
    parent_session_id: SessionId,
    project_dir: String,
    depth: u32,
    max_mode: TurnMode,
}

#[derive(Default)]
struct TokenRegistry {
    by_token: HashMap<String, TokenScope>,
    by_session: HashMap<SessionId, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum TaskStatus {
    Running,
    Completed,
    Cancelled,
    Failed,
}

impl TaskStatus {
    fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }
}

#[derive(Clone)]
struct TaskRecord {
    task_id: String,
    parent_session_id: SessionId,
    child_session_id: SessionId,
    turn_id: TurnId,
    instance_id: String,
    mode: TurnMode,
    depth: u32,
    worktree: Option<SessionWorktree>,
    status: TaskStatus,
    summary: Option<String>,
    error: Option<String>,
    tokens: u32,
    notify: Arc<Notify>,
}

#[derive(Default)]
struct TaskRegistry {
    tasks: HashMap<String, TaskRecord>,
    in_flight_spawns: usize,
}

impl TaskRegistry {
    fn active_count(&self) -> usize {
        self.tasks
            .values()
            .filter(|task| !task.status.is_terminal())
            .count()
            .saturating_add(self.in_flight_spawns)
    }
}

struct SpawnSlotGuard {
    state: Arc<OrchestratorInner>,
    armed: bool,
}

impl SpawnSlotGuard {
    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for SpawnSlotGuard {
    fn drop(&mut self) {
        if self.armed {
            let mut reg = self.state.lock_tasks();
            reg.in_flight_spawns = reg.in_flight_spawns.saturating_sub(1);
        }
    }
}

struct OrchestratorInner {
    config: OrchestratorConfig,
    addr: SocketAddr,
    runtime: OnceLock<RuntimeHandle>,
    tokens: Mutex<TokenRegistry>,
    tasks: Mutex<TaskRegistry>,
}

impl OrchestratorInner {
    fn lock_tokens(&self) -> std::sync::MutexGuard<'_, TokenRegistry> {
        self.tokens
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_tasks(&self) -> std::sync::MutexGuard<'_, TaskRegistry> {
        self.tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Loopback Streamable HTTP MCP server & native tool provider enabling
/// peer-to-peer multi-engine orchestration across any driver.
pub struct OrchestratorServer {
    inner: Arc<OrchestratorInner>,
    accept_abort: AbortHandle,
}

impl Drop for OrchestratorServer {
    fn drop(&mut self) {
        self.accept_abort.abort();
    }
}

fn revoke_session_inner(inner: &OrchestratorInner, session_id: SessionId) {
    let mut tokens = inner.lock_tokens();
    if let Some(tok) = tokens.by_session.remove(&session_id) {
        tokens.by_token.remove(&tok);
    }
}

impl OrchestratorServer {
    /// Bind a loopback HTTP listener on `127.0.0.1:0` and start serving MCP requests.
    pub async fn start(config: OrchestratorConfig) -> std::io::Result<Arc<Self>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let inner = Arc::new(OrchestratorInner {
            config,
            addr,
            runtime: OnceLock::new(),
            tokens: Mutex::new(TokenRegistry::default()),
            tasks: Mutex::new(TaskRegistry::default()),
        });
        let loop_inner = Arc::clone(&inner);
        let accept_task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _peer)) => {
                        let conn_inner = Arc::clone(&loop_inner);
                        tokio::spawn(async move {
                            let _ = handle_http_connection(conn_inner, stream).await;
                        });
                    }
                    Err(error) => {
                        tracing::debug!(%error, "orchestrator HTTP accept stopped");
                        break;
                    }
                }
            }
        });
        Ok(Arc::new(Self {
            inner,
            accept_abort: accept_task.abort_handle(),
        }))
    }

    /// Late-bind the supervised [`RuntimeHandle`] after [`RuntimeSupervisor::start`].
    pub fn attach_runtime(&self, runtime: RuntimeHandle) {
        let _ = self.inner.runtime.set(runtime);
    }

    pub fn mcp_url(&self) -> String {
        format!("http://{}/mcp", self.inner.addr)
    }

    /// Revoke any issued token tied to `session_id`.
    pub fn revoke_session(&self, session_id: SessionId) {
        revoke_session_inner(&self.inner, session_id);
    }

    /// Summary state for `orchestrator.status` (never includes bearer tokens).
    pub fn status_json(&self) -> Value {
        let tasks = self.inner.lock_tasks();
        let active = tasks
            .tasks
            .values()
            .filter(|t| !t.status.is_terminal())
            .count();
        let total = tasks.tasks.len();
        let issued_tokens = self.inner.lock_tokens().by_session.len();
        json!({
            "mcp_url": self.mcp_url(),
            "max_depth": self.inner.config.max_depth,
            "max_concurrent": self.inner.config.max_concurrent,
            "active_tasks": active,
            "total_tasks": total,
            "scoped_sessions": issued_tokens,
        })
    }

    /// Task list for `orchestrator.tasks` (filtered optionally by parent session).
    pub fn list_tasks_json(&self, parent_session_id: Option<SessionId>) -> Value {
        let tasks = self.inner.lock_tasks();
        let items: Vec<Value> = tasks
            .tasks
            .values()
            .filter(|task| parent_session_id.is_none_or(|pid| task.parent_session_id == pid))
            .map(|task| task_summary_json(task, None))
            .collect();
        Value::Array(items)
    }

    fn scope_for_context(&self, ctx: &OrchestratorContext) -> TokenScope {
        let mut tokens = self.inner.lock_tokens();
        if let Some(existing_token) = tokens.by_session.get(&ctx.session_id).cloned() {
            if let Some(scope) = tokens.by_token.get_mut(&existing_token) {
                scope.project_dir = ctx.project_dir.clone();
                scope.depth = ctx.depth;
                scope.max_mode = ctx.mode;
                return scope.clone();
            }
        }
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let scope = TokenScope {
            token: token.clone(),
            parent_session_id: ctx.session_id,
            project_dir: ctx.project_dir.clone(),
            depth: ctx.depth,
            max_mode: ctx.mode,
        };
        tokens.by_session.insert(ctx.session_id, token.clone());
        tokens.by_token.insert(token, scope.clone());
        scope
    }
}

impl OrchestratorProvider for OrchestratorServer {
    fn mcp_for_session(&self, ctx: &OrchestratorContext) -> Option<InjectedMcpServer> {
        let scope = self.scope_for_context(ctx);
        Some(InjectedMcpServer {
            name: "agente-orchestrator".to_string(),
            url: self.mcp_url(),
            bearer_token: Some(scope.token),
        })
    }

    fn builtin_tools(&self, ctx: &OrchestratorContext) -> Vec<Box<dyn Tool>> {
        let scope = self.scope_for_context(ctx);
        ORCHESTRATOR_TOOLS
            .iter()
            .map(|spec| -> Box<dyn Tool> {
                Box::new(OrchestratorToolAdapter {
                    inner: Arc::clone(&self.inner),
                    scope: scope.clone(),
                    spec,
                })
            })
            .collect()
    }
}

struct ToolDescriptor {
    name: &'static str,
    description: &'static str,
    allowed_in_plan: bool,
    read_only: bool,
    schema: fn() -> Value,
}

const ORCHESTRATOR_TOOLS: &[ToolDescriptor] = &[
    ToolDescriptor {
        name: "orchestrator_list_drivers",
        description: "List available coding-CLI driver instances (`agente`, `claude`, `codex`, custom ACP profiles) and their declared capabilities.",
        allowed_in_plan: true,
        read_only: true,
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "probe": { "type": "boolean", "description": "Actively probe binary readiness when true (default false)." }
                }
            })
        },
    },
    ToolDescriptor {
        name: "orchestrator_spawn_task",
        description: "Delegate a task to a peer coding-CLI driver instance or another session, optionally inside an isolated Git worktree.",
        allowed_in_plan: true,
        read_only: false,
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "instance_id": { "type": "string", "description": "Driver instance id (default \"agente\"; e.g. \"claude\", \"codex\")." },
                    "prompt": { "type": "string", "description": "Self-contained instructions for the delegated worker." },
                    "mode": { "type": "string", "enum": ["plan", "build", "auto"], "description": "Requested permission mode (clamped to parent ceiling)." },
                    "model": { "type": "string", "description": "Optional model override for the target driver." },
                    "worktree": { "type": "boolean", "description": "Allocate an isolated Git worktree for parallel safe edits." },
                    "wait": { "type": "boolean", "description": "Wait for the child turn to finish before returning (default true)." },
                    "timeout_secs": { "type": "integer", "description": "Wait timeout in seconds when wait=true (default 600)." }
                },
                "required": ["prompt"]
            })
        },
    },
    ToolDescriptor {
        name: "orchestrator_get_task",
        description: "Inspect status, final summary, token usage, and worktree changed files of a previously spawned orchestration task.",
        allowed_in_plan: true,
        read_only: true,
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" }
                },
                "required": ["task_id"]
            })
        },
    },
    ToolDescriptor {
        name: "orchestrator_list_tasks",
        description: "List orchestration tasks spawned by this session.",
        allowed_in_plan: true,
        read_only: true,
        schema: || json!({ "type": "object", "properties": {} }),
    },
    ToolDescriptor {
        name: "orchestrator_cancel_task",
        description: "Cancel a running orchestration task belonging to this session.",
        allowed_in_plan: true,
        read_only: false,
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" }
                },
                "required": ["task_id"]
            })
        },
    },
    ToolDescriptor {
        name: "orchestrator_steer_task",
        description: "Send mid-turn guidance to a running orchestration task that supports steering.",
        allowed_in_plan: true,
        read_only: false,
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "message": { "type": "string" }
                },
                "required": ["task_id", "message"]
            })
        },
    },
    ToolDescriptor {
        name: "orchestrator_board_get",
        description: "Read the parent session's Swarm board (cards, statuses, and findings log).",
        allowed_in_plan: true,
        read_only: true,
        schema: || json!({ "type": "object", "properties": {} }),
    },
    ToolDescriptor {
        name: "orchestrator_board_post",
        description: "Post a finding onto the parent session's Swarm board.",
        allowed_in_plan: true,
        read_only: false,
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "from": { "type": "string", "description": "Card id or \"lead\" (default \"lead\")." },
                    "to": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["text"]
            })
        },
    },
];

struct OrchestratorToolAdapter {
    inner: Arc<OrchestratorInner>,
    scope: TokenScope,
    spec: &'static ToolDescriptor,
}

#[async_trait::async_trait]
impl Tool for OrchestratorToolAdapter {
    fn name(&self) -> &str {
        self.spec.name
    }

    fn description(&self) -> &str {
        self.spec.description
    }

    fn parameters(&self) -> Value {
        (self.spec.schema)()
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        if self.spec.read_only {
            ToolExecutionMode::Parallel
        } else {
            ToolExecutionMode::Sequential
        }
    }

    fn allowed_in_plan(&self) -> bool {
        self.spec.allowed_in_plan
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Task
    }

    async fn execute(&self, args: Value, _project_dir: &str) -> Result<String, ToolError> {
        let value = dispatch_tool(&self.inner, &self.scope, self.spec.name, args)
            .await
            .map_err(ToolError::ExecutionError)?;
        serde_json::to_string_pretty(&value)
            .map_err(|err| ToolError::ExecutionError(err.to_string()))
    }
}

#[derive(Deserialize)]
struct ListDriversArgs {
    #[serde(default)]
    probe: bool,
}

#[derive(Deserialize)]
struct SpawnTaskArgs {
    #[serde(default)]
    instance_id: Option<String>,
    prompt: String,
    #[serde(default)]
    mode: Option<TurnMode>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    worktree: bool,
    #[serde(default = "default_true")]
    wait: bool,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
struct TaskIdArgs {
    task_id: String,
}

#[derive(Deserialize)]
struct SteerTaskArgs {
    task_id: String,
    message: String,
}

#[derive(Deserialize)]
struct BoardPostArgs {
    text: String,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Vec<String>,
}

async fn dispatch_tool(
    inner: &Arc<OrchestratorInner>,
    scope: &TokenScope,
    name: &str,
    args: Value,
) -> Result<Value, String> {
    let runtime = inner
        .runtime
        .get()
        .cloned()
        .ok_or_else(|| "orchestrator runtime is not attached yet".to_string())?;

    match name {
        "orchestrator_list_drivers" => {
            let ListDriversArgs { probe } =
                serde_json::from_value(if args.is_null() { json!({}) } else { args })
                    .map_err(|e| format!("invalid arguments: {e}"))?;
            let drivers = if probe {
                runtime.probe_drivers().await
            } else {
                runtime.list_drivers()
            };
            Ok(json!({ "drivers": drivers }))
        }
        "orchestrator_spawn_task" => spawn_task(inner, &runtime, scope, args).await,
        "orchestrator_get_task" => {
            let TaskIdArgs { task_id } =
                serde_json::from_value(args).map_err(|e| format!("invalid arguments: {e}"))?;
            let record = {
                let tasks = inner.lock_tasks();
                let record = tasks
                    .tasks
                    .get(&task_id)
                    .ok_or_else(|| format!("unknown task '{task_id}'"))?;
                if record.parent_session_id != scope.parent_session_id {
                    return Err(format!("task '{task_id}' belongs to another session"));
                }
                record.clone()
            };
            let changed = worktree_changed_files(record.worktree.as_ref()).await;
            Ok(task_summary_json(&record, changed))
        }
        "orchestrator_list_tasks" => {
            let tasks = inner.lock_tasks();
            let list: Vec<Value> = tasks
                .tasks
                .values()
                .filter(|t| t.parent_session_id == scope.parent_session_id)
                .map(|t| task_summary_json(t, None))
                .collect();
            Ok(json!({ "tasks": list }))
        }
        "orchestrator_cancel_task" => {
            let TaskIdArgs { task_id } =
                serde_json::from_value(args).map_err(|e| format!("invalid arguments: {e}"))?;
            let turn_id = {
                let tasks = inner.lock_tasks();
                let record = tasks
                    .tasks
                    .get(&task_id)
                    .ok_or_else(|| format!("unknown task '{task_id}'"))?;
                if record.parent_session_id != scope.parent_session_id {
                    return Err(format!("task '{task_id}' belongs to another session"));
                }
                record.turn_id
            };
            let cancelled = runtime.cancel(turn_id);
            Ok(json!({ "task_id": task_id, "cancelled": cancelled }))
        }
        "orchestrator_steer_task" => {
            let SteerTaskArgs { task_id, message } =
                serde_json::from_value(args).map_err(|e| format!("invalid arguments: {e}"))?;
            let turn_id = {
                let tasks = inner.lock_tasks();
                let record = tasks
                    .tasks
                    .get(&task_id)
                    .ok_or_else(|| format!("unknown task '{task_id}'"))?;
                if record.parent_session_id != scope.parent_session_id {
                    return Err(format!("task '{task_id}' belongs to another session"));
                }
                record.turn_id
            };
            let steered = runtime.steer(turn_id, UserInput { content: message });
            Ok(json!({ "task_id": task_id, "steered": steered }))
        }
        "orchestrator_board_get" => {
            let board = BoardStore::user()
                .get(scope.parent_session_id.as_uuid())
                .map_err(|e| format!("failed to read board: {e}"))?;
            serde_json::to_value(board).map_err(|e| e.to_string())
        }
        "orchestrator_board_post" => {
            let BoardPostArgs { text, from, to } =
                serde_json::from_value(args).map_err(|e| format!("invalid arguments: {e}"))?;
            let from = from.as_deref().unwrap_or(LEAD).to_string();
            let (finding, _board) = BoardStore::user()
                .update(scope.parent_session_id.as_uuid(), |board| {
                    board.post(&from, &text, &to)
                })?;
            serde_json::to_value(finding).map_err(|e| e.to_string())
        }
        other => Err(format!("unknown orchestrator tool: {other}")),
    }
}

async fn spawn_task(
    inner: &Arc<OrchestratorInner>,
    runtime: &RuntimeHandle,
    scope: &TokenScope,
    args: Value,
) -> Result<Value, String> {
    let SpawnTaskArgs {
        instance_id,
        prompt,
        mode,
        model,
        worktree,
        wait,
        timeout_secs,
    } = serde_json::from_value(args).map_err(|e| format!("invalid arguments: {e}"))?;

    if prompt.trim().is_empty() {
        return Err("prompt must not be empty".to_string());
    }
    if scope.depth >= inner.config.max_depth {
        return Err(format!(
            "orchestration depth limit reached ({}/{})",
            scope.depth, inner.config.max_depth
        ));
    }

    let slot_guard = {
        let mut tasks = inner.lock_tasks();
        if tasks.active_count() >= inner.config.max_concurrent {
            return Err(format!(
                "concurrent orchestrated task limit reached ({})",
                inner.config.max_concurrent
            ));
        }
        tasks.in_flight_spawns += 1;
        SpawnSlotGuard {
            state: Arc::clone(inner),
            armed: true,
        }
    };

    let task_id = format!("orch-{}", &Uuid::new_v4().simple().to_string()[..10]);
    let child_session_id = SessionId::new();
    let effective_mode = clamp_mode(mode, scope.max_mode);
    let instance_id = instance_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(agente_drivers::BUILTIN_AGENTE_INSTANCE)
        .to_string();

    let created_worktree = if worktree {
        Some(
            crate::worktree::create_worktree(
                runtime,
                &scope.project_dir,
                Some(&task_id),
                Some(child_session_id),
            )
            .await
            .map_err(|(_, msg)| msg)?,
        )
    } else {
        None
    };

    let child_depth = scope.depth.saturating_add(1);
    runtime.set_session_depth(child_session_id, child_depth);

    if let Err(err) =
        runtime.open_session_with_driver(child_session_id, &scope.project_dir, Some(&instance_id))
    {
        if let Some(wt) = &created_worktree {
            let _ = crate::worktree::remove_worktree(
                Some(runtime),
                &wt.repo_root,
                &wt.path,
                Some(&wt.branch),
                Some(&wt.base_commit),
                Some(child_session_id),
            )
            .await;
        }
        return Err(err.to_string());
    }

    let mut turn_handle = match runtime.start_turn(StartTurn {
        session_id: child_session_id,
        project_dir: Some(scope.project_dir.clone()),
        instance_id: Some(instance_id.clone()),
        mode: Some(effective_mode),
        model,
        worktree: created_worktree.clone(),
        prompt: Some(agente_protocol::Message::user(prompt.clone())),
        ..StartTurn::default()
    }) {
        Ok(handle) => handle,
        Err(err) => {
            if let Some(wt) = &created_worktree {
                let _ = crate::worktree::remove_worktree(
                    Some(runtime),
                    &wt.repo_root,
                    &wt.path,
                    Some(&wt.branch),
                    Some(&wt.base_commit),
                    Some(child_session_id),
                )
                .await;
            }
            return Err(err.to_string());
        }
    };

    let turn_id = turn_handle.turn_id();
    let notify = Arc::new(Notify::new());
    let record = TaskRecord {
        task_id: task_id.clone(),
        parent_session_id: scope.parent_session_id,
        child_session_id,
        turn_id,
        instance_id,
        mode: effective_mode,
        depth: child_depth,
        worktree: created_worktree,
        status: TaskStatus::Running,
        summary: None,
        error: None,
        tokens: 0,
        notify: Arc::clone(&notify),
    };

    {
        let mut reg = inner.lock_tasks();
        reg.in_flight_spawns = reg.in_flight_spawns.saturating_sub(1);
        reg.tasks.insert(task_id.clone(), record.clone());
    }
    slot_guard.disarm();

    let watch_inner = Arc::clone(inner);
    let watch_runtime = runtime.clone();
    let watch_task_id = task_id.clone();
    tokio::spawn(async move {
        let mut assistant_text = String::new();
        while let Some(env) = turn_handle.recv().await {
            match env.event {
                RuntimeEvent::AssistantDelta { text } => assistant_text.push_str(&text),
                RuntimeEvent::AssistantMessage { text } if !text.is_empty() => {
                    assistant_text = text;
                }
                _ => {}
            }
        }
        let outcome = turn_handle.outcome().await;
        if assistant_text.trim().is_empty() {
            let snap = watch_runtime.session_snapshot(child_session_id);
            if let Some(last) = snap
                .conversation
                .iter()
                .rev()
                .find(|m| m.role == agente_protocol::Role::Assistant)
            {
                assistant_text = last.content.clone();
            }
        }
        let trimmed = truncate_chars(&assistant_text, MAX_SUMMARY_CHARS);
        let (status, error, tokens) = match outcome {
            Some(TurnOutcome {
                status: TurnStatus::Completed,
                tokens,
                ..
            }) => (TaskStatus::Completed, None, tokens),
            Some(TurnOutcome {
                status: TurnStatus::Cancelled,
                tokens,
                error,
                ..
            }) => (TaskStatus::Cancelled, error, tokens),
            Some(TurnOutcome {
                status: TurnStatus::Failed,
                tokens,
                error,
                ..
            }) => (TaskStatus::Failed, error, tokens),
            None => (
                TaskStatus::Failed,
                Some("child turn exited without outcome".to_string()),
                0,
            ),
        };
        {
            let mut tasks = watch_inner.lock_tasks();
            if let Some(entry) = tasks.tasks.get_mut(&watch_task_id) {
                entry.status = status;
                if !trimmed.is_empty() {
                    entry.summary = Some(trimmed);
                }
                entry.error = error;
                entry.tokens = tokens;
                entry.notify.notify_waiters();
            }
        }
        revoke_session_inner(&watch_inner, child_session_id);
    });

    if wait {
        let deadline = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_WAIT_TIMEOUT_SECS));
        let _ = tokio::time::timeout(deadline, async {
            loop {
                let notified = notify.notified();
                let done = inner
                    .lock_tasks()
                    .tasks
                    .get(&task_id)
                    .is_some_and(|t| t.status.is_terminal());
                if done {
                    break;
                }
                notified.await;
            }
        })
        .await;
    }

    let snapshot_record = inner
        .lock_tasks()
        .tasks
        .get(&task_id)
        .cloned()
        .ok_or_else(|| format!("task '{task_id}' disappeared"))?;
    let changed = worktree_changed_files(snapshot_record.worktree.as_ref()).await;
    Ok(task_summary_json(&snapshot_record, changed))
}

fn clamp_mode(requested: Option<TurnMode>, ceiling: TurnMode) -> TurnMode {
    let rank = |m: TurnMode| match m {
        TurnMode::Plan => 0u8,
        TurnMode::Build => 1u8,
        TurnMode::Auto => 2u8,
    };
    match requested {
        Some(req) if rank(req) <= rank(ceiling) => req,
        _ => ceiling,
    }
}

async fn worktree_changed_files(worktree: Option<&SessionWorktree>) -> Option<Vec<String>> {
    let wt = worktree?;
    let info = agente_core::subagent::worktree::WorktreeInfo::synthetic(
        &wt.repo_root,
        &wt.path,
        &wt.branch,
        &wt.base_commit,
        false,
    );
    Some(agente_core::subagent::worktree::changed_files(&info).await)
}

fn task_summary_json(task: &TaskRecord, changed_files: Option<Vec<String>>) -> Value {
    let mut obj = json!({
        "task_id": task.task_id,
        "parent_session_id": task.parent_session_id,
        "child_session_id": task.child_session_id,
        "turn_id": task.turn_id,
        "instance_id": task.instance_id,
        "mode": task.mode,
        "depth": task.depth,
        "status": task.status,
        "tokens": task.tokens,
    });
    if let Some(summary) = &task.summary {
        obj["summary"] = json!(summary);
    }
    if let Some(error) = &task.error {
        obj["error"] = json!(error);
    }
    if let Some(wt) = &task.worktree {
        let mut wt_json = serde_json::to_value(wt).unwrap_or(Value::Null);
        if let Some(files) = changed_files {
            wt_json["changed_files"] = json!(files);
        }
        obj["worktree"] = wt_json;
    }
    obj
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if let Some((idx, _)) = text.char_indices().nth(max_chars) {
        let mut out = text[..idx].to_string();
        out.push_str("\n… truncated …");
        return out;
    }
    text.to_string()
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn authorize_bearer(inner: &OrchestratorInner, header_val: Option<&str>) -> Option<TokenScope> {
    let provided = header_val?
        .strip_prefix("Bearer ")
        .or_else(|| header_val?.strip_prefix("bearer "))?
        .trim();
    if provided.is_empty() {
        return None;
    }
    let tokens = inner.lock_tokens();
    tokens
        .by_token
        .values()
        .find(|scope| constant_time_eq(&scope.token, provided))
        .cloned()
}

async fn handle_http_connection(
    inner: Arc<OrchestratorInner>,
    stream: TcpStream,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream);
    loop {
        let Some((method, target, headers, body)) = read_http_request(&mut reader).await? else {
            break;
        };
        let keep_alive = !headers
            .get("connection")
            .is_some_and(|v| v.eq_ignore_ascii_case("close"));

        let path = target.split('?').next().unwrap_or(&target);
        if path != "/mcp" {
            write_http_response(reader.get_mut(), 404, "Not Found", b"Not Found", keep_alive)
                .await?;
            if !keep_alive {
                break;
            }
            continue;
        }

        if method != "POST" {
            write_http_response(
                reader.get_mut(),
                405,
                "Method Not Allowed",
                b"Method Not Allowed",
                keep_alive,
            )
            .await?;
            if !keep_alive {
                break;
            }
            continue;
        }

        let Some(scope) =
            authorize_bearer(&inner, headers.get("authorization").map(String::as_str))
        else {
            write_http_response(
                reader.get_mut(),
                401,
                "Unauthorized",
                b"Unauthorized",
                keep_alive,
            )
            .await?;
            if !keep_alive {
                break;
            }
            continue;
        };

        let request: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => {
                let err_payload = serde_json::to_vec(&json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": "Parse error" }
                }))
                .unwrap_or_default();
                write_http_json(reader.get_mut(), 400, &err_payload, keep_alive).await?;
                if !keep_alive {
                    break;
                }
                continue;
            }
        };

        match handle_mcp_request(&inner, &scope, request).await {
            Some(reply) => {
                let bytes = serde_json::to_vec(&reply).unwrap_or_default();
                write_http_json(reader.get_mut(), 200, &bytes, keep_alive).await?;
            }
            None => {
                write_http_response(reader.get_mut(), 202, "Accepted", b"", keep_alive).await?;
            }
        }
        if !keep_alive {
            break;
        }
    }
    let _ = reader.get_mut().shutdown().await;
    Ok(())
}

async fn handle_mcp_request(
    inner: &Arc<OrchestratorInner>,
    scope: &TokenScope,
    request: Value,
) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    let id = id?;

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "agente-orchestrator", "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => {
            let tools: Vec<Value> = ORCHESTRATOR_TOOLS
                .iter()
                .map(|spec| {
                    json!({
                        "name": spec.name,
                        "description": spec.description,
                        "inputSchema": (spec.schema)(),
                        "annotations": { "readOnlyHint": spec.read_only },
                    })
                })
                .collect();
            Ok(json!({ "tools": tools }))
        }
        "tools/call" => {
            let tool_name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let res = match dispatch_tool(inner, scope, tool_name, args).await {
                Ok(val) => json!({
                    "content": [{ "type": "text", "text": serde_json::to_string_pretty(&val).unwrap_or_default() }],
                    "isError": false,
                }),
                Err(msg) => json!({
                    "content": [{ "type": "text", "text": msg }],
                    "isError": true,
                }),
            };
            Ok(res)
        }
        _ => Err((-32601i32, format!("Method not found: {method}"))),
    };

    Some(match result {
        Ok(res) => json!({ "jsonrpc": "2.0", "id": id, "result": res }),
        Err((code, message)) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        }),
    })
}

async fn read_http_request(
    reader: &mut BufReader<TcpStream>,
) -> std::io::Result<Option<(String, String, HashMap<String, String>, Vec<u8>)>> {
    let mut request_line = String::new();
    let n = reader.read_line(&mut request_line).await?;
    if n == 0 {
        return Ok(None);
    }
    let trimmed = request_line.trim_end_matches(&['\r', '\n'][..]);
    let mut parts = trimmed.split_whitespace();
    let method = parts.next().unwrap_or("").to_uppercase();
    let target = parts.next().unwrap_or("/").to_string();

    let mut headers = HashMap::new();
    let mut header_bytes = 0usize;
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            break;
        }
        header_bytes += read;
        if header_bytes > 64 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "HTTP headers too large",
            ));
        }
        let clean = line.trim_end_matches(&['\r', '\n'][..]);
        if clean.is_empty() {
            break;
        }
        if let Some((k, v)) = clean.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let is_chunked = headers
        .get("transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let body = if is_chunked {
        read_chunked_body(reader).await?
    } else if let Some(len) = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
    {
        if len > MAX_BODY_BYTES {
            write_http_response(reader.get_mut(), 413, "Payload Too Large", b"", false).await?;
            return Ok(None);
        }
        let mut buf = vec![0u8; len];
        reader.read_exact(&mut buf).await?;
        buf
    } else {
        Vec::new()
    };

    Ok(Some((method, target, headers, body)))
}

async fn read_chunked_body(reader: &mut BufReader<TcpStream>) -> std::io::Result<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let mut size_line = String::new();
        if reader.read_line(&mut size_line).await? == 0 {
            break;
        }
        let hex_part = size_line.split(';').next().unwrap_or("").trim();
        let chunk_len = usize::from_str_radix(hex_part, 16).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid chunk size")
        })?;
        if chunk_len == 0 {
            let mut crlf = [0u8; 2];
            let _ = reader.read_exact(&mut crlf).await;
            break;
        }
        if body.len().saturating_add(chunk_len) > MAX_BODY_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "chunked body too large",
            ));
        }
        let mut chunk = vec![0u8; chunk_len];
        reader.read_exact(&mut chunk).await?;
        body.extend_from_slice(&chunk);
        let mut crlf = [0u8; 2];
        reader.read_exact(&mut crlf).await?;
    }
    Ok(body)
}

async fn write_http_json(
    stream: &mut TcpStream,
    status: u16,
    body: &[u8],
    keep_alive: bool,
) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let conn = if keep_alive { "keep-alive" } else { "close" };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: {conn}\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

async fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &[u8],
    keep_alive: bool,
) -> std::io::Result<()> {
    let conn = if keep_alive { "keep-alive" } else { "close" };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: {conn}\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use agente_drivers::{DriverEvent, DriverSessionOpen, DriverTurnRequest};
    use agente_protocol::{DriverCapabilities, DriverInfo, DriverKind, DriverStatus, Message};
    use agente_runtime::{
        AgentDriver, ApprovalRouter, DriverError, DriverRegistry, DriverSession, DriversConfig,
        RuntimeConfig, RuntimeSupervisor,
    };
    use tokio::sync::mpsc;

    struct PeerDriver {
        instance_id: String,
        seen_modes: Arc<Mutex<Vec<TurnMode>>>,
        hang_until_cancel: bool,
    }

    struct PeerSession {
        seen_modes: Arc<Mutex<Vec<TurnMode>>>,
        hang_until_cancel: bool,
        cancelled: Arc<Notify>,
    }

    #[async_trait::async_trait]
    impl AgentDriver for PeerDriver {
        fn instance_id(&self) -> &str {
            &self.instance_id
        }
        fn driver_kind(&self) -> DriverKind {
            DriverKind::Claude
        }
        fn descriptor(&self) -> DriverInfo {
            DriverInfo {
                instance_id: self.instance_id.clone(),
                driver_kind: DriverKind::Claude,
                label: "Peer Mock".into(),
                status: DriverStatus::Ready,
                version: None,
                binary_path: None,
                error: None,
                auth_hint: None,
                builtin: false,
                enabled: true,
                use_for: None,
                capabilities: DriverCapabilities {
                    steer: true,
                    approvals: true,
                    ..Default::default()
                },
                models: Vec::new(),
                config: None,
            }
        }
        async fn probe(&self) -> DriverInfo {
            self.descriptor()
        }
        async fn open_session(
            &self,
            _spec: DriverSessionOpen,
            _approvals: ApprovalRouter,
        ) -> Result<Arc<dyn DriverSession>, DriverError> {
            Ok(Arc::new(PeerSession {
                seen_modes: Arc::clone(&self.seen_modes),
                hang_until_cancel: self.hang_until_cancel,
                cancelled: Arc::new(Notify::new()),
            }))
        }
    }

    #[async_trait::async_trait]
    impl DriverSession for PeerSession {
        async fn start_turn(
            &self,
            request: DriverTurnRequest,
            sink: mpsc::Sender<DriverEvent>,
        ) -> Result<(), DriverError> {
            self.seen_modes.lock().unwrap().push(request.mode);
            if self.hang_until_cancel {
                self.cancelled.notified().await;
                let _ = sink
                    .send(DriverEvent::TurnComplete {
                        status: TurnStatus::Cancelled,
                        assistant_text: String::new(),
                        tokens: 0,
                        error: None,
                    })
                    .await;
                return Ok(());
            }
            let reply = format!("peer-reply:{}", request.prompt.content);
            let _ = sink
                .send(DriverEvent::Runtime(RuntimeEvent::AssistantDelta {
                    text: reply.clone(),
                }))
                .await;
            let _ = sink
                .send(DriverEvent::TurnComplete {
                    status: TurnStatus::Completed,
                    assistant_text: reply,
                    tokens: 21,
                    error: None,
                })
                .await;
            Ok(())
        }
        async fn steer(&self, _message: Message) -> bool {
            true
        }
        async fn cancel(&self, _turn_id: TurnId) -> bool {
            self.cancelled.notify_waiters();
            true
        }
        fn external_session_id(&self) -> Option<String> {
            None
        }
        async fn close(&self) {}
    }

    async fn http_post_json(url: &str, token: Option<&str>, body: &Value) -> (u16, Value) {
        let addr_part = url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let mut stream = TcpStream::connect(addr_part).await.unwrap();
        let bytes = serde_json::to_vec(body).unwrap();
        let mut req = format!(
            "POST /mcp HTTP/1.1\r\nHost: {addr_part}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
            bytes.len()
        );
        if let Some(tok) = token {
            req.push_str(&format!("Authorization: Bearer {tok}\r\n"));
        }
        req.push_str("\r\n");
        stream.write_all(req.as_bytes()).await.unwrap();
        stream.write_all(&bytes).await.unwrap();
        stream.flush().await.unwrap();

        let mut resp = Vec::new();
        stream.read_to_end(&mut resp).await.unwrap();
        let raw = String::from_utf8_lossy(&resp);
        let (head, body_str) = raw.split_once("\r\n\r\n").unwrap();
        let status: u16 = head
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let parsed = serde_json::from_str(body_str).unwrap_or(Value::String(body_str.to_string()));
        (status, parsed)
    }

    #[tokio::test]
    async fn orchestrator_mcp_enforces_auth_mode_ceiling_depth_and_cancel() {
        let root =
            std::env::temp_dir().join(format!("agente-orchestrator-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();

        let orchestrator = OrchestratorServer::start(OrchestratorConfig {
            max_depth: 2,
            max_concurrent: 1,
        })
        .await
        .unwrap();

        let fast_modes = Arc::new(Mutex::new(Vec::new()));
        let registry = Arc::new(DriverRegistry::new(DriversConfig::default(), None));
        registry.register_driver(Arc::new(PeerDriver {
            instance_id: "peer-fast".into(),
            seen_modes: Arc::clone(&fast_modes),
            hang_until_cancel: false,
        }));
        registry.register_driver(Arc::new(PeerDriver {
            instance_id: "peer-slow".into(),
            seen_modes: Arc::new(Mutex::new(Vec::new())),
            hang_until_cancel: true,
        }));

        let cfg = RuntimeConfig::from_app_config(&AppConfig::default(), root.to_string_lossy())
            .with_driver_registry(registry)
            .with_orchestrator(Arc::clone(&orchestrator) as Arc<dyn OrchestratorProvider>);
        let runtime = RuntimeSupervisor::start(cfg);
        orchestrator.attach_runtime(runtime.clone());

        let parent_sid = SessionId::new();
        let injected = orchestrator
            .mcp_for_session(&OrchestratorContext {
                session_id: parent_sid,
                project_dir: root.to_string_lossy().into_owned(),
                mode: TurnMode::Plan,
                depth: 0,
            })
            .unwrap();
        let token = injected.bearer_token.as_deref().unwrap();

        // 1. Unauthorized HTTP request is rejected with 401.
        let (bad_status, _) = http_post_json(
            &injected.url,
            Some("wrong-token"),
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }),
        )
        .await;
        assert_eq!(bad_status, 401);

        // 2. Authorized tools/list returns orchestrator tools.
        let (list_status, list_body) = http_post_json(
            &injected.url,
            Some(token),
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
        )
        .await;
        assert_eq!(list_status, 200);
        let tool_names: Vec<&str> = list_body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(tool_names.contains(&"orchestrator_spawn_task"));
        assert!(tool_names.contains(&"orchestrator_list_drivers"));

        // 3. Mode ceiling: Plan parent asking for Auto child gets clamped to Plan!
        let (spawn_status, spawn_body) = http_post_json(
            &injected.url,
            Some(token),
            &json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "orchestrator_spawn_task",
                    "arguments": {
                        "instance_id": "peer-fast",
                        "prompt": "inspect code",
                        "mode": "auto",
                        "wait": true
                    }
                }
            }),
        )
        .await;
        assert_eq!(spawn_status, 200);
        assert_eq!(spawn_body["result"]["isError"], false, "{spawn_body}");
        let spawned_text = spawn_body["result"]["content"][0]["text"].as_str().unwrap();
        let spawned: Value = serde_json::from_str(spawned_text).unwrap();
        assert_eq!(spawned["status"], "completed");
        assert_eq!(spawned["mode"], "plan");
        assert_eq!(spawned["summary"], "peer-reply:inspect code");
        assert_eq!(*fast_modes.lock().unwrap(), vec![TurnMode::Plan]);

        // 4. Concurrency cap & cancellation: start a hanging background task, confirm 2nd spawn refuses, then cancel.
        let (_, slow_body) = http_post_json(
            &injected.url,
            Some(token),
            &json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "orchestrator_spawn_task",
                    "arguments": {
                        "instance_id": "peer-slow",
                        "prompt": "wait forever",
                        "wait": false
                    }
                }
            }),
        )
        .await;
        let slow: Value =
            serde_json::from_str(slow_body["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        let slow_id = slow["task_id"].as_str().unwrap();

        let (_, cap_body) = http_post_json(
            &injected.url,
            Some(token),
            &json!({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "orchestrator_spawn_task",
                    "arguments": {
                        "instance_id": "peer-fast",
                        "prompt": "exceeds concurrency",
                        "wait": true
                    }
                }
            }),
        )
        .await;
        assert_eq!(cap_body["result"]["isError"], true);
        assert!(cap_body["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("concurrent orchestrated task limit reached"));

        let (_, cancel_body) = http_post_json(
            &injected.url,
            Some(token),
            &json!({
                "jsonrpc": "2.0",
                "id": 6,
                "method": "tools/call",
                "params": {
                    "name": "orchestrator_cancel_task",
                    "arguments": { "task_id": slow_id }
                }
            }),
        )
        .await;
        assert_eq!(cancel_body["result"]["isError"], false);

        // 5. Depth limit: depth 2 token cannot spawn when max_depth == 2.
        let deep_sid = SessionId::new();
        let deep_mcp = orchestrator
            .mcp_for_session(&OrchestratorContext {
                session_id: deep_sid,
                project_dir: root.to_string_lossy().into_owned(),
                mode: TurnMode::Build,
                depth: 2,
            })
            .unwrap();
        let (_, depth_body) = http_post_json(
            &deep_mcp.url,
            deep_mcp.bearer_token.as_deref(),
            &json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {
                    "name": "orchestrator_spawn_task",
                    "arguments": {
                        "instance_id": "peer-fast",
                        "prompt": "too deep",
                        "wait": true
                    }
                }
            }),
        )
        .await;
        assert_eq!(depth_body["result"]["isError"], true);
        assert!(depth_body["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("depth limit reached"));

        // 6. Rapid Connection: close requests succeed without WSAECONNRESET, and
        // completed child tokens are revoked automatically.
        for _ in 0..8 {
            let (status, _) = http_post_json(
                &injected.url,
                Some("wrong-token"),
                &json!({ "jsonrpc": "2.0", "id": 99, "method": "ping", "params": {} }),
            )
            .await;
            assert_eq!(status, 401);
        }
        let child_sid = spawned["child_session_id"]
            .as_str()
            .unwrap()
            .parse::<SessionId>()
            .unwrap();
        // Give the watcher a brief moment to revoke after Notify wakes the parent.
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(
            !orchestrator
                .inner
                .lock_tokens()
                .by_session
                .contains_key(&child_sid),
            "completed child session token must be revoked"
        );

        let _ = std::fs::remove_dir_all(root);
    }
}
