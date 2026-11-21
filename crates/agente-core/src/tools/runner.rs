//! Tool execution context, shell environment, and shared cancellation/heartbeat runner.

use std::sync::Arc;

use super::ToolError;
use crate::cancellation::AbortSignal;

/// Liveness tick for every tool invocation. Tools that emit no progress
/// (grep over a huge tree, a slow web fetch, a big read) would otherwise look
/// dead to the TUI stuck-guard and get force-cancelled mid-work.
pub(crate) const TOOL_HEARTBEAT_MS: u64 = 15_000;

/// Which output stream produced a tool progress chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolOutputStream {
    Stdout,
    Stderr,
}

/// A bounded, incremental output update emitted by a context-aware tool.
#[derive(Debug, Clone)]
pub struct ToolProgress {
    pub stream: ToolOutputStream,
    pub content: String,
}

pub(super) type ToolProgressCallback = Arc<dyn Fn(ToolProgress) + Send + Sync>;

/// How a command a tool starts (`shell`, background processes) runs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ShellEnv {
    /// With everything the host process has: the coding agent's usual shell.
    #[default]
    Inherit,
    /// With only a short allowlist (path, locale, time zone, temp dir) and
    /// the home folder set to the project: no keys or tokens from the host
    /// (provider keys, `AGENTE_TOKEN`, cloud credentials). Bot turns where
    /// no sandbox exists.
    Clean,
    /// Clean, and inside the sandbox ([`crate::sandbox`]): writes only the
    /// project, reads nothing of the user's, network only if allowed.
    Boxed(crate::sandbox::SandboxPolicy),
}

/// What a clean environment keeps from the host.
const CLEAN_ENV_VARS: &[&str] = &[
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "TMPDIR",
    "TEMP",
    "TMP",
    "USER",
    "LOGNAME",
    "SHELL",
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
];

impl ShellEnv {
    /// The command that runs `command` through the shell (`sh -c`, or
    /// `cmd /C` on Windows) in `project_dir`, this way. A command that must be
    /// boxed but can't be is refused, never run unboxed.
    pub(crate) fn shell(
        &self,
        command: &str,
        project_dir: &str,
    ) -> Result<processkit::Command, ToolError> {
        let cmd = match self {
            ShellEnv::Boxed(policy) => crate::sandbox::command(command, project_dir, policy)
                .map_err(|reason| {
                    ToolError::ExecutionError(format!(
                        "This can't run here: the sandbox isn't available ({reason})."
                    ))
                })?,
            ShellEnv::Inherit | ShellEnv::Clean => plain_shell(command),
        };
        Ok(match self {
            ShellEnv::Inherit => cmd,
            ShellEnv::Clean | ShellEnv::Boxed(_) => cmd
                .inherit_env(CLEAN_ENV_VARS)
                .env("HOME", project_dir)
                .env("USERPROFILE", project_dir),
        })
    }
}

/// `sh -c <command>`, or on Windows `ComSpec` (falling back to `cmd.exe`,
/// extension included: a bare `cmd` can be shadowed by an unrelated tool on
/// PATH, nvm for Windows ships one).
fn plain_shell(command: &str) -> processkit::Command {
    if cfg!(target_os = "windows") {
        processkit::Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()))
            .args(["/D", "/C", command])
    } else {
        processkit::Command::new("sh").args(["-c", command])
    }
}

/// Runtime context supplied to a tool invocation.
///
/// The default context never cancels and emits no progress, so existing tools
/// and external implementations remain source-compatible. Tool implementations
/// that support cooperative progress can call [`ToolExecutionContext::report`].
#[derive(Clone)]
pub struct ToolExecutionContext {
    pub cancellation: AbortSignal,
    pub call_id: String,
    pub(super) progress: Option<ToolProgressCallback>,
    pub(super) heartbeat: Option<Arc<dyn Fn() + Send + Sync>>,
    pub(super) shell_env: ShellEnv,
}

impl ToolExecutionContext {
    pub fn new(cancellation: AbortSignal) -> Self {
        Self {
            cancellation,
            call_id: String::new(),
            progress: None,
            heartbeat: None,
            shell_env: ShellEnv::Inherit,
        }
    }

    /// How commands started by this call run.
    pub fn shell_env(&self) -> &ShellEnv {
        &self.shell_env
    }

    pub fn with_shell_env(mut self, shell_env: ShellEnv) -> Self {
        self.shell_env = shell_env;
        self
    }

    pub fn with_progress<F>(mut self, callback: F) -> Self
    where
        F: Fn(ToolProgress) + Send + Sync + 'static,
    {
        self.progress = Some(Arc::new(callback));
        self
    }

    /// Register a liveness callback. Long-running tools fire it periodically
    /// (even after their progress budget is exhausted) so the TUI's stuck
    /// guard can tell "working" from "dead".
    pub fn with_heartbeat<F>(mut self, callback: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.heartbeat = Some(Arc::new(callback));
        self
    }

    pub fn report(&self, progress: ToolProgress) {
        if let Some(callback) = &self.progress {
            callback(progress);
        }
    }

    pub fn heartbeat(&self) {
        if let Some(callback) = &self.heartbeat {
            callback();
        }
    }
}

impl Default for ToolExecutionContext {
    fn default() -> Self {
        Self::new(AbortSignal::never())
    }
}

/// Run a tool future with cooperative cancellation and periodic liveness
/// heartbeats. Shared across [`super::Tool`], [`super::TypedTool`], and
/// [`crate::mcp::tool_adapter::McpToolAdapter`].
pub(crate) async fn run_with_heartbeat<Fut>(
    context: &ToolExecutionContext,
    future: Fut,
) -> Result<String, ToolError>
where
    Fut: std::future::Future<Output = Result<String, ToolError>>,
{
    if context.cancellation.is_aborted() {
        return Err(ToolError::ExecutionError("Tool execution cancelled".into()));
    }
    tokio::pin!(future);
    // Schedule the first heartbeat in the future. Awaiting interval's
    // immediate first tick before polling the tool imposed a timer wakeup
    // (~1 ms) on every read/search, even when the tool completed instantly.
    let period = std::time::Duration::from_millis(TOOL_HEARTBEAT_MS);
    let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            result = &mut future => return result,
            _ = context.cancellation.wait_aborted() => {
                return Err(ToolError::ExecutionError("Tool execution cancelled".into()));
            }
            _ = heartbeat.tick() => context.heartbeat(),
        }
    }
}
