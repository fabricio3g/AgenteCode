//! Subprocess spawning, executable resolution, passive probing, and shared
//! NDJSON / JSON-RPC line framing helpers for external CLI drivers.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agente_protocol::rpc::{self, Incoming};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use crate::DriverError;

const STDERR_RING_BYTES: usize = 8192;
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Result of passively probing a driver binary (no session opened).
#[derive(Debug, Clone)]
pub struct ProbeOutcome {
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Resolve an executable on `PATH` (handling Windows `PATHEXT` shims).
pub fn resolve_executable(program: &str) -> Option<PathBuf> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return None;
    }
    let direct = Path::new(trimmed);
    if direct.components().count() > 1 || direct.is_absolute() {
        return check_candidate(direct);
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        if let Some(found) = check_candidate(&dir.join(trimmed)) {
            return Some(found);
        }
    }
    None
}

fn check_candidate(base: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    if base.extension().is_none() {
        let pathext = std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        for ext in pathext.split(';').filter(|s| !s.is_empty()) {
            let ext = ext.trim_start_matches('.');
            let candidate = base.with_extension(ext);
            if is_usable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    if is_usable_file(base) {
        return Some(base.to_path_buf());
    }
    None
}

fn is_usable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

/// Canonicalize `cwd` so symlinked workspace roots match provider paths,
/// stripping Windows' verbatim `\\?\` prefix that breaks some external CLIs.
pub fn canonical_cwd(dir: &str) -> String {
    let path = Path::new(dir);
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(windows)]
    {
        let raw = canonical.to_string_lossy();
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
        raw.into_owned()
    }
    #[cfg(not(windows))]
    {
        canonical.to_string_lossy().into_owned()
    }
}

/// Configure direct execution (`shell: false` equivalents), stripped env vars,
/// custom env overlays, and Windows `CREATE_NO_WINDOW`.
pub fn prepare_command(
    program: &Path,
    args: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
    strip_env: &[String],
) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for var in strip_env {
        cmd.env_remove(var);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

/// Run a passive `--version` check without opening any agent session or auth flow.
pub async fn passive_probe(
    command: &[String],
    version_args: &[&str],
    env: &BTreeMap<String, String>,
    strip_env: &[String],
) -> ProbeOutcome {
    let Some(program) = command.first() else {
        return ProbeOutcome {
            binary_path: None,
            version: None,
            error: Some("no command configured".into()),
        };
    };
    let Some(resolved) = resolve_executable(program) else {
        return ProbeOutcome {
            binary_path: None,
            version: None,
            error: Some(format!("executable '{program}' was not found on PATH")),
        };
    };
    let binary_path = Some(resolved.to_string_lossy().into_owned());
    let args: Vec<String> = version_args.iter().map(|s| (*s).to_string()).collect();
    let mut cmd = prepare_command(&resolved, &args, None, env, strip_env);
    cmd.stdin(Stdio::null());
    match tokio::time::timeout(PROBE_TIMEOUT, cmd.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let version = if stdout.is_empty() {
                String::from_utf8_lossy(&output.stderr).trim().to_string()
            } else {
                stdout
            };
            ProbeOutcome {
                binary_path,
                version: (!version.is_empty())
                    .then(|| version.lines().next().unwrap_or(&version).trim().to_string()),
                error: None,
            }
        }
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            ProbeOutcome {
                binary_path,
                version: None,
                error: Some(if stderr.is_empty() {
                    format!("probe exited with {}", output.status)
                } else {
                    stderr
                }),
            }
        }
        Ok(Err(error)) => ProbeOutcome {
            binary_path,
            version: None,
            error: Some(error.to_string()),
        },
        Err(_) => ProbeOutcome {
            binary_path,
            version: None,
            error: Some("version probe timed out".into()),
        },
    }
}

/// Run a short-lived non-interactive CLI subcommand and capture its stdout.
pub async fn run_cli_output(
    program: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
    strip_env: &[String],
    timeout: Duration,
) -> Result<String, DriverError> {
    let resolved = resolve_executable(program).ok_or_else(|| {
        DriverError::Unavailable(program.to_string(), format!("executable '{program}' not found"))
    })?;
    let canon_cwd = cwd.map(canonical_cwd);
    let mut cmd = prepare_command(&resolved, args, canon_cwd.as_deref(), env, strip_env);
    cmd.stdin(Stdio::null());
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let detail = if stderr.is_empty() {
                format!("exited with {}", output.status)
            } else {
                stderr
            };
            Err(DriverError::Protocol(format!(
                "{program} {}: {detail}",
                args.join(" ")
            )))
        }
        Ok(Err(error)) => Err(DriverError::Io(error)),
        Err(_) => Err(DriverError::Protocol(format!(
            "{program} {} timed out",
            args.join(" ")
        ))),
    }
}

/// Long-lived child process with piped stdio and a bounded stderr ring buffer.
pub struct SpawnedStdio {
    child: Mutex<Option<Child>>,
    stderr_tail: Arc<Mutex<VecDeque<u8>>>,
}

impl SpawnedStdio {
    pub fn spawn(
        command: &[String],
        extra_args: &[String],
        cwd: &str,
        env: &BTreeMap<String, String>,
        strip_env: &[String],
    ) -> Result<(Self, tokio::process::ChildStdout, tokio::process::ChildStdin), DriverError> {
        let Some(program) = command.first() else {
            return Err(DriverError::InvalidConfig("no command configured".into()));
        };
        let resolved = resolve_executable(program).ok_or_else(|| {
            DriverError::Unavailable(program.clone(), format!("executable '{program}' not found"))
        })?;
        let mut args: Vec<String> = command.iter().skip(1).cloned().collect();
        args.extend(extra_args.iter().cloned());
        let cwd = canonical_cwd(cwd);
        let mut cmd = prepare_command(&resolved, &args, Some(&cwd), env, strip_env);
        let mut child = cmd
            .spawn()
            .map_err(|error| DriverError::Spawn(format!("{}: {error}", resolved.display())))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| DriverError::Spawn("missing child stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| DriverError::Spawn("missing child stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| DriverError::Spawn("missing child stderr".into()))?;

        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_RING_BYTES)));
        let tail_ref = Arc::clone(&stderr_tail);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            while let Ok(read) = reader.read_line(&mut line).await {
                if read == 0 {
                    break;
                }
                tracing::debug!(stderr = %line.trim_end(), "external driver stderr");
                let mut ring = tail_ref
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                for byte in line.as_bytes() {
                    if ring.len() >= STDERR_RING_BYTES {
                        ring.pop_front();
                    }
                    ring.push_back(*byte);
                }
                line.clear();
            }
        });

        Ok((
            Self {
                child: Mutex::new(Some(child)),
                stderr_tail,
            },
            stdout,
            stdin,
        ))
    }

    pub fn stderr_summary(&self) -> String {
        let ring = self
            .stderr_tail
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let bytes: Vec<u8> = ring.iter().copied().collect();
        String::from_utf8_lossy(&bytes).trim().to_string()
    }

    pub async fn kill(&self) {
        let child = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }

    /// Wait briefly for natural exit after stdin EOF before forcefully killing.
    pub async fn shutdown_gracefully(&self, grace: Duration) {
        let child = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(mut child) = child {
            if tokio::time::timeout(grace, child.wait()).await.is_err() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
    }
}

/// Asynchronous NDJSON line sender backed by a single writer task.
#[derive(Clone)]
pub struct JsonLineWriter {
    tx: Arc<Mutex<Option<mpsc::UnboundedSender<Value>>>>,
}

impl JsonLineWriter {
    pub fn spawn<W>(writer: W) -> Self
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            let mut writer = writer;
            while let Some(frame) = rx.recv().await {
                let Ok(mut bytes) = serde_json::to_vec(&frame) else {
                    continue;
                };
                bytes.push(b'\n');
                if writer.write_all(&bytes).await.is_err() || writer.flush().await.is_err() {
                    break;
                }
            }
        });
        Self {
            tx: Arc::new(Mutex::new(Some(tx))),
        }
    }

    pub fn send(&self, frame: Value) -> Result<(), DriverError> {
        let guard = self.tx.lock().unwrap_or_else(|p| p.into_inner());
        let Some(tx) = guard.as_ref() else {
            return Err(DriverError::Protocol("driver stdin closed".into()));
        };
        tx.send(frame)
            .map_err(|_| DriverError::Protocol("driver stdin closed".into()))
    }

    pub fn close(&self) {
        self.tx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
    }
}

/// Structured JSON-RPC 2.0 error returned by a remote driver method.
#[derive(Debug, Clone)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

/// Shared bidirectional JSON-RPC 2.0 client transport over any line stream.
pub struct JsonRpcTransport {
    writer: JsonLineWriter,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, JsonRpcError>>>>,
    reader_task: Mutex<Option<tokio::task::AbortHandle>>,
}

/// Handler callbacks supplied by a JSON-RPC 2.0 protocol adapter (`acp` / `codex`).
pub trait JsonRpcHandler: Send + Sync + 'static {
    fn on_notification(&self, method: String, params: Value);
    fn on_request(&self, id: Value, method: String, params: Value);
    fn on_closed(&self, reason: Option<String>);
}

/// Minimal no-op JSON-RPC handler used during short-lived metadata probes.
pub struct NoopJsonRpcHandler;

impl JsonRpcHandler for NoopJsonRpcHandler {
    fn on_notification(&self, _method: String, _params: Value) {}
    fn on_request(&self, _id: Value, _method: String, _params: Value) {}
    fn on_closed(&self, _reason: Option<String>) {}
}

impl JsonRpcTransport {
    pub fn start<R, W, H>(
        reader: R,
        writer: W,
        max_line_bytes: usize,
        handler: Arc<H>,
    ) -> Arc<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
        H: JsonRpcHandler,
    {
        let writer = JsonLineWriter::spawn(writer);
        let transport = Arc::new(Self {
            writer,
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            reader_task: Mutex::new(None),
        });
        let reader_transport = Arc::clone(&transport);
        let task = tokio::spawn(async move {
            let mut lines = BufReader::new(reader);
            let close_reason = loop {
                let line = match rpc::read_bounded_line(&mut lines, max_line_bytes).await {
                    Ok(Some(line)) => line,
                    Ok(None) => break None,
                    Err(error) => break Some(error.to_string()),
                };
                if line.trim().is_empty() {
                    continue;
                }
                match rpc::classify(&line) {
                    Ok(Incoming::Request { id, method, params }) => {
                        handler.on_request(id, method, params);
                    }
                    Ok(Incoming::Notification { method, params }) => {
                        handler.on_notification(method, params);
                    }
                    Ok(Incoming::Response { id, result, error }) => {
                        if let Some(num) = id.as_u64() {
                            let waiter = reader_transport
                                .pending
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .remove(&num);
                            if let Some(waiter) = waiter {
                                let outcome = match error {
                                    Some(err) => Err(JsonRpcError {
                                        code: err
                                            .get("code")
                                            .and_then(Value::as_i64)
                                            .unwrap_or(-32603),
                                        message: err
                                            .get("message")
                                            .and_then(Value::as_str)
                                            .unwrap_or("JSON-RPC error")
                                            .to_string(),
                                        data: err.get("data").cloned(),
                                    }),
                                    None => Ok(result.unwrap_or(Value::Null)),
                                };
                                let _ = waiter.send(outcome);
                            }
                        }
                    }
                    Err(error) => {
                        tracing::debug!(?error, line = %line, "ignoring non-JSON-RPC line from driver");
                    }
                }
            };
            reader_transport.fail_pending("driver connection closed");
            handler.on_closed(close_reason);
        });
        *transport
            .reader_task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(task.abort_handle());
        transport
    }

    pub async fn request_detailed(&self, method: &str, params: Value) -> Result<Value, JsonRpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, tx);
        if let Err(error) = self.writer.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })) {
            self.pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&id);
            return Err(JsonRpcError {
                code: -32001,
                message: error.to_string(),
                data: None,
            });
        }
        rx.await.unwrap_or_else(|_| {
            Err(JsonRpcError {
                code: -32001,
                message: format!("{method}: driver connection closed"),
                data: None,
            })
        })
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, DriverError> {
        self.request_detailed(method, params)
            .await
            .map_err(|err| DriverError::Protocol(format!("{method}: {}", err.message)))
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), DriverError> {
        self.writer.send(rpc::notification(method, params))
    }

    pub fn reply_result(&self, id: Value, result: Value) -> Result<(), DriverError> {
        self.writer.send(rpc::result_reply(id, result))
    }

    pub fn reply_error(&self, id: Value, code: i32, message: &str) -> Result<(), DriverError> {
        self.writer.send(rpc::error_reply(id, code, message))
    }

    pub fn close(&self) {
        self.fail_pending("driver session closed");
        self.writer.close();
        if let Some(handle) = self
            .reader_task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            handle.abort();
        }
    }

    fn fail_pending(&self, reason: &str) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (_, waiter) in pending.drain() {
            let _ = waiter.send(Err(JsonRpcError {
                code: -32001,
                message: reason.to_string(),
                data: None,
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_check_candidate_prefers_pathext_over_extensionless_posix_shim() {
        let dir = std::env::temp_dir().join(format!(
            "agente-proc-pathexts-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("sample-cli");
        std::fs::write(&shim, "#!/bin/sh\necho hi\n").unwrap();
        std::fs::write(dir.join("sample-cli.cmd"), "@echo off\r\necho hi\r\n").unwrap();

        let resolved = check_candidate(&shim);
        let _ = std::fs::remove_dir_all(&dir);
        let ext = resolved
            .as_ref()
            .and_then(|p| p.extension())
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase());
        assert_eq!(ext.as_deref(), Some("cmd"));
    }
}
