//! Execution tools.
//!
//! Shell execution is deliberately kept here as the single path used by the
//! agent and the TUI's direct `!command` mode. The process and both output
//! pipes are drained concurrently so a chatty child cannot deadlock on a full
//! stdout or stderr pipe.

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::mpsc;

use super::{
    truncate_tool_output, ToolCore, ToolError, ToolExecutionContext, ToolExecutionMode,
    ToolOutputStream, ToolProgress, MAX_SHELL_LINES,
};

/// Arguments accepted by the `shell` tool.
#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct ShellArgs {
    /// The shell command to execute
    #[serde(default)]
    #[serde(alias = "cmd")]
    pub command: Option<String>,
    /// Timeout in milliseconds (default: 120000, max: 600000)
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Default)]
pub struct ShellTool;

/// Builds and test suites routinely exceed the old 30 s ceiling; 120 s matches
/// the common agent-harness default, and the model may extend up to 10 minutes
/// for a genuinely long build/test run.
const DEFAULT_SHELL_TIMEOUT_MS: u64 = 120_000;
const MIN_SHELL_TIMEOUT_MS: u64 = 1_000;
const MAX_SHELL_TIMEOUT_MS: u64 = 600_000;

const READ_CHUNK_BYTES: usize = 8 * 1024;
const MAX_CAPTURE_BYTES: usize = 128 * 1024;
const PROGRESS_BATCH_BYTES: usize = 4 * 1024;
const MAX_PROGRESS_BYTES: usize = 32 * 1024;
const MAX_PROGRESS_EVENTS: usize = 128;
const PROGRESS_FLUSH_MS: u64 = 50;
/// Liveness tick while a command runs. Past the progress caps the output
/// stream goes quiet — this keeps the TUI's stuck guard from force-killing a
/// healthy long build/test that is simply not emitting anything new.
const HEARTBEAT_MS: u64 = 15_000;
const POST_EXIT_DRAIN_MS: u64 = 2_000;

#[derive(Clone, Copy)]
enum OutputKind {
    Stdout,
    Stderr,
}

impl OutputKind {
    fn stream(self) -> ToolOutputStream {
        match self {
            Self::Stdout => ToolOutputStream::Stdout,
            Self::Stderr => ToolOutputStream::Stderr,
        }
    }
}

struct OutputChunk {
    kind: OutputKind,
    bytes: Vec<u8>,
}

#[derive(Clone, Copy)]
enum EscapeState {
    Ground,
    Escape,
    Csi,
    String,
    StringEscape,
}

/// Incrementally remove terminal control sequences without corrupting UTF-8
/// when either construct is split across pipe reads.
struct TerminalOutputSanitizer {
    state: EscapeState,
    pending_utf8: Vec<u8>,
    pending_cr: bool,
}

impl TerminalOutputSanitizer {
    fn new() -> Self {
        Self {
            state: EscapeState::Ground,
            pending_utf8: Vec::new(),
            pending_cr: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) -> String {
        let mut clean = Vec::with_capacity(bytes.len());
        for &byte in bytes {
            if self.pending_cr {
                clean.push(b'\n');
                self.pending_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }

            match self.state {
                EscapeState::Ground => match byte {
                    0x1b => self.state = EscapeState::Escape,
                    b'\r' => self.pending_cr = true,
                    b'\n' => clean.push(b'\n'),
                    b'\t' => clean.extend_from_slice(b"    "),
                    0x00..=0x1f | 0x7f => {}
                    _ => clean.push(byte),
                },
                EscapeState::Escape => {
                    self.state = match byte {
                        b'[' => EscapeState::Csi,
                        b']' | b'P' | b'X' | b'^' | b'_' => EscapeState::String,
                        _ => EscapeState::Ground,
                    };
                }
                EscapeState::Csi => {
                    if (0x40..=0x7e).contains(&byte) {
                        self.state = EscapeState::Ground;
                    }
                }
                EscapeState::String => match byte {
                    0x07 => self.state = EscapeState::Ground,
                    0x1b => self.state = EscapeState::StringEscape,
                    _ => {}
                },
                EscapeState::StringEscape => {
                    self.state = if byte == b'\\' {
                        EscapeState::Ground
                    } else {
                        EscapeState::String
                    };
                }
            }
        }
        self.decode(clean)
    }

    fn finish(&mut self) -> String {
        let mut clean = Vec::new();
        if self.pending_cr {
            clean.push(b'\n');
            self.pending_cr = false;
        }
        let mut output = self.decode(clean);
        if !self.pending_utf8.is_empty() {
            output.push_str(&String::from_utf8_lossy(&self.pending_utf8));
            self.pending_utf8.clear();
        }
        output
    }

    fn decode(&mut self, clean: Vec<u8>) -> String {
        self.pending_utf8.extend(clean);
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending_utf8) {
                Ok(valid) => {
                    output.push_str(valid);
                    self.pending_utf8.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        output.push_str(
                            std::str::from_utf8(&self.pending_utf8[..valid_up_to])
                                .expect("validated UTF-8 prefix"),
                        );
                        self.pending_utf8.drain(..valid_up_to);
                    }
                    let Some(error_len) = error.error_len() else {
                        break;
                    };
                    self.pending_utf8.drain(..error_len);
                    output.push('\u{fffd}');
                }
            }
        }
        output
    }
}

async fn drain_pipe<R>(
    mut reader: R,
    kind: OutputKind,
    sender: mpsc::Sender<OutputChunk>,
    cancellation: crate::cancellation::AbortSignal,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut buffer = vec![0u8; READ_CHUNK_BYTES];
    loop {
        tokio::select! {
            _ = cancellation.wait_aborted() => break,
            result = reader.read(&mut buffer) => {
                match result {
                    Ok(0) => break,
                    Ok(size) => {
                        if sender.send(OutputChunk {
                            kind,
                            bytes: buffer[..size].to_vec(),
                        }).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }
}

struct BoundedCapture {
    bytes: Vec<u8>,
    truncated: bool,
}

impl BoundedCapture {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            truncated: false,
        }
    }

    fn append(&mut self, bytes: &[u8]) {
        if bytes.len() >= MAX_CAPTURE_BYTES {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&bytes[bytes.len() - MAX_CAPTURE_BYTES..]);
            self.truncated = true;
            return;
        }
        let overflow = self
            .bytes
            .len()
            .saturating_add(bytes.len())
            .saturating_sub(MAX_CAPTURE_BYTES);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.truncated = true;
        }
        self.bytes.extend_from_slice(bytes);
    }

    fn as_string(&self) -> String {
        let mut text = String::from_utf8_lossy(&self.bytes).into_owned();
        if self.truncated {
            text.push_str("\n... stream output truncated ...");
        }
        text
    }
}

struct ProgressBuffer {
    stdout: String,
    stderr: String,
    emitted_bytes: usize,
    emitted_events: usize,
}

impl ProgressBuffer {
    fn new() -> Self {
        Self {
            stdout: String::new(),
            stderr: String::new(),
            emitted_bytes: 0,
            emitted_events: 0,
        }
    }

    fn append(&mut self, kind: OutputKind, content: &str, context: &ToolExecutionContext) {
        let pending = match kind {
            OutputKind::Stdout => &mut self.stdout,
            OutputKind::Stderr => &mut self.stderr,
        };
        pending.push_str(content);
        // Keep pending data bounded even if the callback budget has already
        // been exhausted or a child writes a single enormous read chunk.
        if pending.len() > PROGRESS_BATCH_BYTES * 2 {
            let end = char_boundary_at_or_before(pending, PROGRESS_BATCH_BYTES * 2);
            pending.truncate(end);
        }

        while self.pending_len(kind) >= PROGRESS_BATCH_BYTES
            && self.emitted_bytes < MAX_PROGRESS_BYTES
            && self.emitted_events < MAX_PROGRESS_EVENTS
        {
            self.flush_one(kind, context, PROGRESS_BATCH_BYTES);
        }
    }

    fn flush_all(&mut self, context: &ToolExecutionContext) {
        self.flush_kind(OutputKind::Stdout, context);
        self.flush_kind(OutputKind::Stderr, context);
    }

    fn flush_kind(&mut self, kind: OutputKind, context: &ToolExecutionContext) {
        while self.pending_len(kind) > 0
            && self.emitted_bytes < MAX_PROGRESS_BYTES
            && self.emitted_events < MAX_PROGRESS_EVENTS
        {
            let size = self.pending_len(kind).min(PROGRESS_BATCH_BYTES);
            self.flush_one(kind, context, size);
        }
    }

    fn pending_len(&self, kind: OutputKind) -> usize {
        match kind {
            OutputKind::Stdout => self.stdout.len(),
            OutputKind::Stderr => self.stderr.len(),
        }
    }

    fn flush_one(&mut self, kind: OutputKind, context: &ToolExecutionContext, max: usize) {
        let pending = match kind {
            OutputKind::Stdout => &mut self.stdout,
            OutputKind::Stderr => &mut self.stderr,
        };
        let room = MAX_PROGRESS_BYTES.saturating_sub(self.emitted_bytes);
        let end = char_boundary_at_or_before(pending, max.min(room));
        if end == 0 {
            pending.clear();
            return;
        }
        let content: String = pending.drain(..end).collect();
        self.emitted_bytes += content.len();
        self.emitted_events += 1;
        context.report(ToolProgress {
            stream: kind.stream(),
            content,
        });
    }
}

fn char_boundary_at_or_before(text: &str, requested: usize) -> usize {
    let mut end = requested.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

async fn run_shell(
    args: ShellArgs,
    project_dir: &str,
    context: &ToolExecutionContext,
) -> Result<String, ToolError> {
    let command = args
        .command
        .ok_or_else(|| ToolError::InvalidArguments("Missing 'command' parameter".to_string()))?;
    let timeout_ms = args
        .timeout_ms
        .unwrap_or(DEFAULT_SHELL_TIMEOUT_MS)
        .clamp(MIN_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS);

    if context.cancellation.is_aborted() {
        return Err(ToolError::ExecutionError("Command cancelled".into()));
    }

    let (sender, mut receiver) = mpsc::channel::<OutputChunk>(64);
    // Raw byte tees feed duplex pipes; the duplex read ends are drained by the
    // same reader tasks as before, so the sanitizer still sees raw bytes (ANSI
    // sequences, CR, partial UTF-8) rather than decoded lines.
    let (stdout_writer, stdout_reader) = tokio::io::duplex(READ_CHUNK_BYTES * 8);
    let (stderr_writer, stderr_reader) = tokio::io::duplex(READ_CHUNK_BYTES * 8);
    let readers = vec![
        tokio::spawn(drain_pipe(
            stdout_reader,
            OutputKind::Stdout,
            sender.clone(),
            context.cancellation.clone(),
        )),
        tokio::spawn(drain_pipe(
            stderr_reader,
            OutputKind::Stderr,
            sender.clone(),
            context.cancellation.clone(),
        )),
    ];
    drop(sender);

    // Bridge the abort signal onto processkit's cancellation token: the token
    // tears down the whole job object (Windows) / process group (Unix), so
    // grandchildren cannot outlive a cancel. `stdin(Stdin::empty())` closes
    // the child's stdin at spawn so it can never read the TUI's keystrokes.
    let cancel_token = tokio_util::sync::CancellationToken::new();
    let watcher = {
        let token = cancel_token.clone();
        let signal = context.cancellation.clone();
        tokio::spawn(async move {
            signal.wait_aborted().await;
            token.cancel();
        })
    };

    // `ComSpec` (falling back to `cmd.exe`, extension included) — a bare
    // `cmd` can be shadowed by an unrelated tool on PATH (nvm for Windows
    // ships one), which CreateProcess-style `.exe` resolution hid before.
    #[cfg(target_os = "windows")]
    let cmd = processkit::Command::new(
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()),
    )
    .args(["/D", "/C", command.as_str()]);

    #[cfg(not(target_os = "windows"))]
    let cmd = processkit::Command::new("sh").args(["-c", command.as_str()]);
    let launched = cmd
        .current_dir(project_dir)
        .stdin(processkit::Stdin::empty())
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .cancel_on(cancel_token)
        .stdout_raw_tee(stdout_writer)
        .stderr_raw_tee(stderr_writer)
        .start()
        .await;

    let run = match launched {
        Ok(run) => run,
        Err(err) => {
            watcher.abort();
            for reader in readers {
                reader.abort();
            }
            return Err(ToolError::ExecutionError(format!(
                "Failed to spawn command: {err}"
            )));
        }
    };

    let mut wait_future = Box::pin(run.wait());
    let mut outcome: Option<Result<processkit::Outcome, processkit::Error>> = None;
    let mut readers_finished = false;
    let mut stdout = BoundedCapture::new();
    let mut stderr = BoundedCapture::new();
    let mut stdout_sanitizer = TerminalOutputSanitizer::new();
    let mut stderr_sanitizer = TerminalOutputSanitizer::new();
    let mut progress = ProgressBuffer::new();
    let post_exit = tokio::time::sleep(std::time::Duration::from_millis(POST_EXIT_DRAIN_MS));
    tokio::pin!(post_exit);
    let mut post_exit_armed = false;
    let mut progress_tick =
        tokio::time::interval(std::time::Duration::from_millis(PROGRESS_FLUSH_MS));
    progress_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut heartbeat_tick = tokio::time::interval(std::time::Duration::from_millis(HEARTBEAT_MS));
    heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Consume the interval's immediate first tick — the spawn itself is the
    // first sign of life; the first heartbeat is due HEARTBEAT_MS later.
    heartbeat_tick.tick().await;

    loop {
        if outcome.is_some() && readers_finished {
            break;
        }

        tokio::select! {
            result = &mut wait_future, if outcome.is_none() => {
                outcome = Some(result);
                post_exit.as_mut().reset(
                    tokio::time::Instant::now()
                        + std::time::Duration::from_millis(POST_EXIT_DRAIN_MS),
                );
                post_exit_armed = true;
            }
            chunk = receiver.recv(), if !readers_finished => {
                match chunk {
                    Some(chunk) => {
                        let content = match chunk.kind {
                            OutputKind::Stdout => stdout_sanitizer.push(&chunk.bytes),
                            OutputKind::Stderr => stderr_sanitizer.push(&chunk.bytes),
                        };
                        match chunk.kind {
                            OutputKind::Stdout => stdout.append(content.as_bytes()),
                            OutputKind::Stderr => stderr.append(content.as_bytes()),
                        }
                        progress.append(chunk.kind, &content, context);
                    }
                    None => readers_finished = true,
                }
            }
            _ = progress_tick.tick() => {
                progress.flush_all(context);
            }
            _ = heartbeat_tick.tick(), if outcome.is_none() => {
                context.heartbeat();
            }
            _ = &mut post_exit, if post_exit_armed && !readers_finished => {
                // Descendants can inherit stdout/stderr after the direct shell
                // exits. The run's tree is reaped with the handle, but never
                // let a lingering pipe hold the agent past the drain window.
                for reader in &readers {
                    reader.abort();
                }
                readers_finished = true;
                stdout.truncated = true;
                stderr.truncated = true;
            }
        }
    }

    watcher.abort();
    for reader in readers {
        let _ = reader.await;
    }
    let stdout_tail = stdout_sanitizer.finish();
    let stderr_tail = stderr_sanitizer.finish();
    stdout.append(stdout_tail.as_bytes());
    stderr.append(stderr_tail.as_bytes());
    progress.append(OutputKind::Stdout, &stdout_tail, context);
    progress.append(OutputKind::Stderr, &stderr_tail, context);
    progress.flush_all(context);

    let outcome = match outcome.expect("process outcome must be available after the wait loop") {
        Ok(outcome) => outcome,
        Err(err) if err.is_cancelled() => {
            return Err(ToolError::ExecutionError("Command cancelled".into()));
        }
        Err(err) => {
            return Err(ToolError::ExecutionError(format!("Command failed: {err}")));
        }
    };
    if outcome.timed_out() {
        return Err(ToolError::ExecutionError(format!(
            "Command timed out after {timeout_ms}ms"
        )));
    }

    let stdout = stdout.as_string();
    let stderr = stderr.as_string();
    let mut result = String::new();
    if !stdout.is_empty() {
        result.push_str(&format!("STDOUT:\n{stdout}\n"));
    }
    if !stderr.is_empty() {
        result.push_str(&format!("STDERR:\n{stderr}\n"));
    }
    result.push_str(&format!("EXIT CODE: {}", outcome.code().unwrap_or(-1)));

    Ok(truncate_tool_output(&result, MAX_SHELL_LINES, "tail"))
}

impl ToolCore for ShellTool {
    type Args = ShellArgs;

    fn name(&self) -> &str {
        "shell"
    }
    fn kind(&self) -> super::ToolKind {
        super::ToolKind::Execute
    }

    fn icon(&self) -> &'static str {
        "▸"
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }

    fn description(&self) -> &str {
        "Execute a shell command in the project directory. Returns stdout, stderr, and exit code."
    }

    async fn run(
        &self,
        args: ShellArgs,
        project_dir: &str,
        context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        run_shell(args, project_dir, context).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cancellation::AbortController;
    use crate::tools::Tool;
    use crate::tools::TypedTool;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn long_output_command() -> &'static str {
        // ~90 KB of output on Windows: past the 64 KiB pipe buffer so the drain
        // path is exercised, but fast enough (≈1 s in cmd.exe) that the 5 s
        // timeout has headroom on a loaded machine.
        if cfg!(target_os = "windows") {
            "for /L %i in (1,1,30000) do @echo x"
        } else {
            "yes x | head -c 90000"
        }
    }

    #[test]
    fn terminal_output_sanitizer_handles_split_sequences_and_utf8() {
        let mut sanitizer = TerminalOutputSanitizer::new();
        assert_eq!(sanitizer.push(b"plain\x1b[3"), "plain");
        assert_eq!(sanitizer.push(b"1mred\x1b[0m \x1b]0;ti"), "red ");
        assert_eq!(sanitizer.push(b"tle\x07 \xe7\x95"), " ");
        assert_eq!(sanitizer.push(b"\x8c\r\nnext\trow"), "界\nnext    row");
        assert_eq!(sanitizer.finish(), "");
    }

    #[tokio::test]
    async fn shell_drains_output_larger_than_pipe_capacity() {
        let result = TypedTool::new(ShellTool)
            .execute(
                json!({"command": long_output_command(), "timeout_ms": 5_000}),
                std::env::temp_dir().to_str().unwrap(),
            )
            .await
            .expect("large output command should complete");
        assert!(result.contains("EXIT CODE:"));
    }

    #[tokio::test]
    async fn shell_progress_is_bounded_and_coalesced() {
        let events = Arc::new(Mutex::new(Vec::<ToolProgress>::new()));
        let captured = Arc::clone(&events);
        let context = ToolExecutionContext::new(AbortController::new().signal())
            .with_progress(move |progress| captured.lock().unwrap().push(progress));
        TypedTool::new(ShellTool)
            .execute_with_context(
                json!({"command": long_output_command(), "timeout_ms": 5_000}),
                std::env::temp_dir().to_str().unwrap(),
                context,
            )
            .await
            .expect("large output command should complete");

        let events = events.lock().unwrap();
        assert!(events.len() <= MAX_PROGRESS_EVENTS);
        assert!(
            events
                .iter()
                .map(|event| event.content.len())
                .sum::<usize>()
                <= MAX_PROGRESS_BYTES
        );
    }

    #[tokio::test]
    async fn shell_cancellation_terminates_promptly() {
        let command = if cfg!(target_os = "windows") {
            "ping -n 20 127.0.0.1"
        } else {
            "sleep 20"
        };
        let controller = AbortController::new();
        let signal = controller.signal();
        let task = tokio::spawn(async move {
            TypedTool::new(ShellTool)
                .execute_with_context(
                    json!({"command": command, "timeout_ms": 30_000}),
                    std::env::temp_dir().to_str().unwrap(),
                    ToolExecutionContext::new(signal),
                )
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        controller.abort();
        let result = tokio::time::timeout(std::time::Duration::from_secs(3), task)
            .await
            .expect("cancellation should not wait for the command")
            .expect("shell task should not panic");
        assert!(result.unwrap_err().to_string().contains("cancelled"));
    }

    #[tokio::test]
    async fn shell_timeout_kills_child() {
        let tool = TypedTool::new(ShellTool);
        let command = if cfg!(target_os = "windows") {
            "ping -n 5 127.0.0.1"
        } else {
            "sleep 5"
        };
        let result = tool
            .execute(
                json!({"command": command, "timeout_ms": 100}),
                std::env::temp_dir().to_str().unwrap(),
            )
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("timed out"));
    }

    #[test]
    fn shell_schema_documents_args() {
        let schema = TypedTool::new(ShellTool).parameters();
        assert_eq!(
            schema["properties"]["command"]["description"],
            "The shell command to execute"
        );
        assert_eq!(
            schema["properties"]["timeout_ms"]["description"],
            "Timeout in milliseconds (default: 120000, max: 600000)"
        );
    }
}
