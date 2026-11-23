//! Background processes: commands that keep running after the tool call
//! returns (dev servers, watchers). `shell` with `background: true` starts
//! one; `process_list`, `process_output` and `process_stop` look after them.
//!
//! The registry is process-wide and each process belongs to the project
//! folder it runs in, so a session only ever sees and stops the processes of
//! its own project. Output keeps a bounded tail; a stop tears down the whole
//! process group, so what the command spawned goes with it.

use std::sync::{Arc, Mutex, OnceLock};

use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use super::exec::TerminalOutputSanitizer;
use super::{ToolCore, ToolError, ToolExecutionContext, ToolExecutionMode};

/// Output kept per process (the most recent part).
const MAX_TAIL_BYTES: usize = 256 * 1024;
/// How long `shell` waits for first output before returning.
const FIRST_OUTPUT_MS: u64 = 3_000;
const DEFAULT_READ_CHARS: usize = 4_000;
const MAX_READ_CHARS: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessStatus {
    Running,
    Exited(Option<i32>),
    Stopped,
}

#[derive(Debug, Clone)]
pub struct ProcessEvent {
    pub id: String,
    pub project_dir: String,
    pub kind: ProcessEventKind,
}

#[derive(Debug, Clone)]
pub enum ProcessEventKind {
    Started {
        command: String,
        started_at: u64,
    },
    Output {
        chunk: String,
        urls: Vec<String>,
    },
    StatusChanged {
        status: ProcessStatus,
        urls: Vec<String>,
    },
}

fn event_bus() -> &'static tokio::sync::broadcast::Sender<ProcessEvent> {
    static BUS: OnceLock<tokio::sync::broadcast::Sender<ProcessEvent>> = OnceLock::new();
    BUS.get_or_init(|| tokio::sync::broadcast::channel(256).0)
}

/// Subscribe to real-time background process lifecycle and output events.
pub fn subscribe() -> tokio::sync::broadcast::Receiver<ProcessEvent> {
    event_bus().subscribe()
}

pub struct BackgroundProcess {
    pub id: String,
    pub command: String,
    pub project_dir: String,
    /// Unix time in milliseconds.
    pub started_at: u64,
    tail: Mutex<String>,
    status: Mutex<ProcessStatus>,
    cancel: CancellationToken,
}

impl BackgroundProcess {
    pub fn status(&self) -> ProcessStatus {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The last `chars` characters of output.
    pub fn output(&self, chars: usize) -> String {
        let tail = self
            .tail
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let skip = tail.chars().count().saturating_sub(chars);
        tail.chars().skip(skip).collect()
    }

    /// Local addresses the process printed (a dev server's URL).
    pub fn urls(&self) -> Vec<String> {
        let tail = self
            .tail
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut urls: Vec<String> = Vec::new();
        for word in tail.split(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
            let local = [
                "http://localhost",
                "http://127.0.0.1",
                "http://0.0.0.0",
                "http://[::1]",
            ]
            .iter()
            .any(|prefix| word.starts_with(prefix));
            let word = word.trim_end_matches(['.', ',', ')', ']']).to_string();
            if local && !urls.contains(&word) {
                urls.push(word);
            }
        }
        urls
    }

    fn append(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        {
            let mut tail = self
                .tail
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            tail.push_str(text);
            if tail.len() > MAX_TAIL_BYTES {
                let mut cut = tail.len() - MAX_TAIL_BYTES;
                while !tail.is_char_boundary(cut) {
                    cut += 1;
                }
                tail.drain(..cut);
            }
        }
        if event_bus().receiver_count() > 0 {
            let _ = event_bus().send(ProcessEvent {
                id: self.id.clone(),
                project_dir: self.project_dir.clone(),
                kind: ProcessEventKind::Output {
                    chunk: text.to_string(),
                    urls: self.urls(),
                },
            });
        }
    }

    fn set_status(&self, status: ProcessStatus) {
        let changed = {
            let mut current = self
                .status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // A stop wins over the exit it causes.
            if *current != ProcessStatus::Stopped && *current != status {
                *current = status.clone();
                true
            } else {
                false
            }
        };
        if changed && event_bus().receiver_count() > 0 {
            let _ = event_bus().send(ProcessEvent {
                id: self.id.clone(),
                project_dir: self.project_dir.clone(),
                kind: ProcessEventKind::StatusChanged {
                    status,
                    urls: self.urls(),
                },
            });
        }
    }

    /// One line: id, state, command and any URLs.
    pub fn describe(&self) -> String {
        let state = match self.status() {
            ProcessStatus::Running => "running".to_string(),
            ProcessStatus::Exited(code) => format!(
                "exited ({})",
                code.map_or("signal".into(), |c| c.to_string())
            ),
            ProcessStatus::Stopped => "stopped".to_string(),
        };
        let urls = self.urls();
        let urls = if urls.is_empty() {
            String::new()
        } else {
            format!(" · {}", urls.join(", "))
        };
        format!("{} · {state} · {}{urls}", self.id, self.command)
    }
}

fn registry() -> &'static Mutex<Vec<Arc<BackgroundProcess>>> {
    static REGISTRY: OnceLock<Mutex<Vec<Arc<BackgroundProcess>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Vec::new()))
}

fn lock_registry() -> std::sync::MutexGuard<'static, Vec<Arc<BackgroundProcess>>> {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The background processes of one project, oldest first.
pub fn list(project_dir: &str) -> Vec<Arc<BackgroundProcess>> {
    lock_registry()
        .iter()
        .filter(|process| process.project_dir == project_dir)
        .cloned()
        .collect()
}

pub fn find(project_dir: &str, id: &str) -> Option<Arc<BackgroundProcess>> {
    list(project_dir)
        .into_iter()
        .find(|process| process.id == id)
}

/// Stop a process (and what it spawned). False when it had already ended.
pub fn stop(process: &BackgroundProcess) -> bool {
    let running = process.status() == ProcessStatus::Running;
    process.set_status(ProcessStatus::Stopped);
    process.cancel.cancel();
    running
}

/// Remove finished (exited or stopped) processes for `project_dir` from the
/// registry, keeping running ones untouched. Returns the number removed.
pub fn prune(project_dir: &str) -> usize {
    let mut reg = lock_registry();
    let before = reg.len();
    reg.retain(|process| {
        process.project_dir != project_dir || process.status() == ProcessStatus::Running
    });
    before - reg.len()
}

/// Stop every background process (on shutdown).
pub fn stop_all() {
    for process in lock_registry().iter() {
        stop(process);
    }
}

/// Start `command` in `project_dir` and keep it running.
pub async fn start(
    command: &str,
    project_dir: &str,
    shell_env: &super::ShellEnv,
) -> Result<Arc<BackgroundProcess>, ToolError> {
    // First, so a command that can't run (no sandbox) leaves nothing behind.
    let cmd = shell_env.shell(command, project_dir)?;
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = format!(
        "p{}",
        NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let process = Arc::new(BackgroundProcess {
        id,
        command: command.to_string(),
        project_dir: project_dir.to_string(),
        started_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as u64),
        tail: Mutex::new(String::new()),
        status: Mutex::new(ProcessStatus::Running),
        cancel: CancellationToken::new(),
    });

    let (stdout_writer, stdout_reader) = tokio::io::duplex(64 * 1024);
    let (stderr_writer, stderr_reader) = tokio::io::duplex(64 * 1024);

    let run = cmd
        .current_dir(project_dir)
        // Nobody reads this output live: ask tools not to buffer it or
        // colour it, so a server's "listening on …" shows up right away.
        .env("PYTHONUNBUFFERED", "1")
        .env("NO_COLOR", "1")
        .stdin(processkit::Stdin::empty())
        .cancel_on(process.cancel.clone())
        .stdout_raw_tee(stdout_writer)
        .stderr_raw_tee(stderr_writer)
        .start()
        .await
        .map_err(|error| ToolError::ExecutionError(format!("Failed to start: {error}")))?;

    for reader in [stdout_reader, stderr_reader] {
        tokio::spawn(collect(Arc::clone(&process), reader));
    }
    let waiter = Arc::clone(&process);
    tokio::spawn(async move {
        let code = run.wait().await.ok().and_then(|outcome| outcome.code());
        waiter.set_status(ProcessStatus::Exited(code));
    });

    lock_registry().push(Arc::clone(&process));
    if event_bus().receiver_count() > 0 {
        let _ = event_bus().send(ProcessEvent {
            id: process.id.clone(),
            project_dir: process.project_dir.clone(),
            kind: ProcessEventKind::Started {
                command: process.command.clone(),
                started_at: process.started_at,
            },
        });
    }
    Ok(process)
}

async fn collect(process: Arc<BackgroundProcess>, mut reader: tokio::io::DuplexStream) {
    let mut sanitizer = TerminalOutputSanitizer::new();
    let mut buffer = vec![0u8; 8 * 1024];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                let text = sanitizer.push(&buffer[..size]);
                if !text.is_empty() {
                    process.append(&text);
                }
            }
        }
    }
    process.append(&sanitizer.finish());
}

/// Start in the background, wait briefly for first output, and report.
pub(crate) async fn start_and_report(
    command: &str,
    project_dir: &str,
    shell_env: &super::ShellEnv,
) -> Result<String, ToolError> {
    let process = start(command, project_dir, shell_env).await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(FIRST_OUTPUT_MS);
    while tokio::time::Instant::now() < deadline
        && process.status() == ProcessStatus::Running
        && process.urls().is_empty()
    {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let first = process.output(DEFAULT_READ_CHARS);
    let state = match process.status() {
        ProcessStatus::Running => format!(
            "Running in the background as {}. Read more with process_output, stop it with process_stop.",
            process.id
        ),
        _ => format!("{} (it did not keep running).", process.describe()),
    };
    let urls = process.urls();
    let urls = if urls.is_empty() {
        String::new()
    } else {
        format!("\nListening on {}", urls.join(", "))
    };
    let first = if first.trim().is_empty() {
        "(no output yet)".to_string()
    } else {
        first
    };
    Ok(format!("{state}{urls}\n\n{first}"))
}

/// `process_list`: this project's background processes.
#[derive(Default)]
pub struct ProcessListTool;

#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct NoArgs {}

impl ToolCore for ProcessListTool {
    type Args = NoArgs;

    fn name(&self) -> &str {
        "process_list"
    }
    fn kind(&self) -> super::ToolKind {
        super::ToolKind::Read
    }
    fn description(&self) -> &str {
        "List the background processes started in this project (shell with background: true), with their status and URLs."
    }
    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Parallel
    }
    fn allowed_in_plan(&self) -> bool {
        true
    }

    async fn run(
        &self,
        _args: NoArgs,
        project_dir: &str,
        _context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let lines: Vec<String> = list(project_dir)
            .iter()
            .map(|process| process.describe())
            .collect();
        Ok(if lines.is_empty() {
            "No background processes.".into()
        } else {
            lines.join("\n")
        })
    }
}

/// `process_output`: the recent output of one background process.
#[derive(Default)]
pub struct ProcessOutputTool;

#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct ProcessOutputArgs {
    /// Process id from shell background or process_list (e.g. "p1")
    #[serde(default)]
    pub id: Option<String>,
    /// How many characters from the end to read (default 4000, max 20000)
    #[serde(default)]
    pub tail_chars: Option<usize>,
}

impl ToolCore for ProcessOutputTool {
    type Args = ProcessOutputArgs;

    fn name(&self) -> &str {
        "process_output"
    }
    fn kind(&self) -> super::ToolKind {
        super::ToolKind::Read
    }
    fn description(&self) -> &str {
        "Read the recent output of a background process (server logs, build errors)."
    }
    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Parallel
    }
    fn allowed_in_plan(&self) -> bool {
        true
    }

    async fn run(
        &self,
        args: ProcessOutputArgs,
        project_dir: &str,
        _context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let id = args
            .id
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'id'".into()))?;
        let process = find(project_dir, &id).ok_or_else(|| {
            ToolError::ExecutionError(format!("No background process {id} in this project."))
        })?;
        let chars = args
            .tail_chars
            .unwrap_or(DEFAULT_READ_CHARS)
            .clamp(200, MAX_READ_CHARS);
        let output = process.output(chars);
        let output = if output.trim().is_empty() {
            "(no output yet)".to_string()
        } else {
            output
        };
        Ok(format!("{}\n\n{output}", process.describe()))
    }
}

/// `process_stop`: stop one background process and what it started.
#[derive(Default)]
pub struct ProcessStopTool;

#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct ProcessStopArgs {
    /// Process id (e.g. "p1")
    #[serde(default)]
    pub id: Option<String>,
}

impl ToolCore for ProcessStopTool {
    type Args = ProcessStopArgs;

    fn name(&self) -> &str {
        "process_stop"
    }
    fn kind(&self) -> super::ToolKind {
        super::ToolKind::Execute
    }
    fn description(&self) -> &str {
        "Stop a background process and everything it started."
    }
    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }

    async fn run(
        &self,
        args: ProcessStopArgs,
        project_dir: &str,
        _context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let id = args
            .id
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'id'".into()))?;
        let process = find(project_dir, &id).ok_or_else(|| {
            ToolError::ExecutionError(format!("No background process {id} in this project."))
        })?;
        Ok(if stop(&process) {
            format!("Stopped {id}.")
        } else {
            format!("{id} had already ended.")
        })
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::tools::{Tool, TypedTool};
    use serde_json::json;

    fn project(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("agente-proc-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    async fn wait_until(what: impl Fn() -> bool) {
        for _ in 0..100 {
            if what() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn a_server_keeps_running_is_listed_per_project_and_stops() {
        let dir = project("server");
        let report = start_and_report(
            "echo listening on http://localhost:4321/; sleep 30",
            &dir,
            &crate::tools::ShellEnv::Inherit,
        )
        .await
        .unwrap();
        assert!(
            report.contains("Running in the background as p"),
            "{report}"
        );
        assert!(
            report.contains("Listening on http://localhost:4321/"),
            "{report}"
        );

        let running = list(&dir);
        assert_eq!(running.len(), 1);
        let process = &running[0];
        assert_eq!(process.status(), ProcessStatus::Running);
        assert!(
            list(&project("elsewhere")).is_empty(),
            "other projects never see it"
        );

        let output = TypedTool::new(ProcessOutputTool)
            .execute(json!({ "id": process.id }), &dir)
            .await
            .unwrap();
        assert!(output.contains("listening on"), "{output}");

        let stop = TypedTool::new(ProcessStopTool);
        let stopped = stop
            .execute(json!({ "id": process.id }), &dir)
            .await
            .unwrap();
        assert!(stopped.starts_with("Stopped"), "{stopped}");
        assert_eq!(process.status(), ProcessStatus::Stopped);
        let again = stop
            .execute(json!({ "id": process.id }), &dir)
            .await
            .unwrap();
        assert!(again.contains("already ended"), "{again}");
    }

    #[tokio::test]
    async fn python_output_is_not_held_back_by_buffering() {
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let dir = project("python");
        let process = start(
            "python3 -c \"import time; print('ready'); time.sleep(30)\"",
            &dir,
            &crate::tools::ShellEnv::Inherit,
        )
        .await
        .unwrap();
        wait_until(|| process.output(100).contains("ready")).await;
        assert!(
            process.output(100).contains("ready"),
            "{:?}",
            process.output(100)
        );
        stop(&process);
    }

    #[tokio::test]
    async fn a_command_that_ends_is_reported_as_exited() {
        let dir = project("quick");
        let process = start("echo done; exit 3", &dir, &crate::tools::ShellEnv::Inherit)
            .await
            .unwrap();
        wait_until(|| process.status() != ProcessStatus::Running).await;
        assert_eq!(process.status(), ProcessStatus::Exited(Some(3)));
        wait_until(|| process.output(100).contains("done")).await;
        assert!(
            process.describe().contains("exited (3)"),
            "{}",
            process.describe()
        );
    }
}
