//! Tool system for agent operations
//!
//! This module provides a modular tool system organized by category:
//! - File operations: read, write, edit, list
//! - Search operations: grep, glob
//! - Execution: shell commands
//! - Task management: todo list

use async_trait::async_trait;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex as AsyncMutex;

use crate::cancellation::AbortSignal;
use crate::types::ToolDefinition;

// Re-export individual tool modules
pub mod atomic_fs;
pub mod exec;
pub mod file;
pub mod outline;
pub mod patch;
pub mod search;
pub mod subagent;
pub mod task;
pub mod web;

// Re-export tool implementations
pub use exec::ShellTool;
pub use file::{EditFileTool, ListDirTool, ReadFileTool, WriteFileTool};
pub use outline::FileOutlineTool;
pub use patch::ApplyPatchTool;
pub use search::{FindTool, GrepTool};
pub use subagent::{KillTaskTool, TaskOutputTool, TaskTool};
pub use task::{parse_plan_ready_output, PresentPlanTool, TodoWriteTool, PLAN_FILE_REL};
pub use web::{WebFetchTool, WebSearchTool};

const MAX_OUTPUT_LINES: usize = 2000;
const MAX_OUTPUT_BYTES: usize = 50 * 1024;
// MAX_SHELL_LINES, MAX_DIR_ENTRIES, MAX_GREP_LINE_LEN are used in submodules
pub(crate) const MAX_SHELL_LINES: usize = 500;
pub(crate) const MAX_FILE_LINES: usize = 2000;
pub(crate) const MAX_DIR_ENTRIES: usize = 500;
pub(crate) const MAX_GREP_LINE_LEN: usize = 200;
/// A full `read_file` above this size is refused with a pagination hint
/// instead of being buffered whole (a multi-GB log would OOM the agent).
pub(crate) const MAX_READ_FILE_BYTES: u64 = 1024 * 1024;
/// Per-line cap so a single minified/JSONL line cannot blow the result.
pub(crate) const MAX_LINE_BYTES: usize = 2000;
/// Wholesale rewrites above this size must go through shell/split edits.
pub(crate) const MAX_EDIT_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// Liveness tick for every tool invocation. Tools that emit no progress
/// (grep over a huge tree, a slow web fetch, a big read) would otherwise look
/// dead to the TUI stuck-guard and get force-cancelled mid-work.
const TOOL_HEARTBEAT_MS: u64 = 15_000;

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

type ToolProgressCallback = Arc<dyn Fn(ToolProgress) + Send + Sync>;

/// Runtime context supplied to a tool invocation.
///
/// The default context never cancels and emits no progress, so existing tools
/// and external implementations remain source-compatible. Tool implementations
/// that support cooperative progress can call [`ToolExecutionContext::report`].
#[derive(Clone)]
pub struct ToolExecutionContext {
    pub cancellation: AbortSignal,
    progress: Option<ToolProgressCallback>,
    heartbeat: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl ToolExecutionContext {
    pub fn new(cancellation: AbortSignal) -> Self {
        Self {
            cancellation,
            progress: None,
            heartbeat: None,
        }
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

/// Canonical form of the project directory, cached per process: every tool
/// preparation used to re-canonicalize the same root (two syscalls per call).
fn canonical_base_cached(project_dir: &str) -> std::path::PathBuf {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, std::path::PathBuf>>,
    > = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut guard = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = guard.get(project_dir) {
        return cached.clone();
    }
    let base = std::path::Path::new(project_dir);
    let canonical = std::fs::canonicalize(base).unwrap_or_else(|_| base.to_path_buf());
    guard.insert(project_dir.to_string(), canonical.clone());
    canonical
}

/// Resolve a path relative to the project directory and ensure it doesn't escape.
/// Returns the canonicalized path or an error if path traversal is detected.
pub fn resolve_project_path(
    path: &str,
    project_dir: &str,
) -> Result<std::path::PathBuf, ToolError> {
    let base = std::path::Path::new(project_dir);
    let target = base.join(path);

    let canonical_base = canonical_base_cached(project_dir);

    let canonical_target = match std::fs::canonicalize(&target) {
        Ok(canonical) => canonical,
        // `canonicalize` fails for not-yet-existing paths (every new-file
        // write) and for dangling symlinks. Resolving only the nearest
        // existing ancestor keeps symlinked parents (or a symlinked leaf)
        // from slipping past the check on a purely lexical fallback.
        Err(_) => canonicalize_closest_ancestor(&resolve_leaf_symlink(&target))?,
    };

    // Containment is compared on verbatim-prefix-stripped forms: canonicalize
    // yields `\\?\C:\...` while the fallback normalization of a not-yet-
    // existing target does not, and a raw prefix compare would deny every
    // NEW file (write_file) under a plain project root.
    if !comparable_path(&canonical_target).starts_with(comparable_path(&canonical_base)) {
        return Err(ToolError::ExecutionError(format!(
            "Access denied: '{path}' is outside the project directory"
        )));
    }

    Ok(canonical_target)
}

/// Strip Windows verbatim prefixes so canonicalized and normalized paths can
/// be compared; identity on other platforms.
fn comparable_path(path: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        const VERBATIM: &str = r"\\?\";
        const VERBATIM_UNC: &str = r"\\?\UNC\";
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(VERBATIM_UNC) {
            return std::path::PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(VERBATIM) {
            return std::path::PathBuf::from(rest);
        }
        path.to_path_buf()
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

/// If the leaf itself is a symlink (including a dangling one, which
/// `canonicalize` refuses to resolve), follow it one hop so the containment
/// check below sees the real destination instead of the link's location.
fn resolve_leaf_symlink(target: &std::path::Path) -> std::path::PathBuf {
    let is_link = std::fs::symlink_metadata(target)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if !is_link {
        return target.to_path_buf();
    }
    match std::fs::read_link(target) {
        Ok(link) if link.is_absolute() => link,
        Ok(link) => target.parent().map(|p| p.join(&link)).unwrap_or(link),
        Err(_) => target.to_path_buf(),
    }
}

/// Canonicalize the nearest existing ancestor of `target` and re-attach the
/// missing remainder. Unlike a purely lexical normalization this resolves
/// symlinked parent directories, so a new file under `link -> /outside`
/// no longer passes the project-containment check.
fn canonicalize_closest_ancestor(
    target: &std::path::Path,
) -> Result<std::path::PathBuf, ToolError> {
    let mut ancestor = target;
    let mut remainder: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(canonical) = std::fs::canonicalize(ancestor) {
            let mut out = canonical;
            for component in remainder.iter().rev() {
                out.push(component);
            }
            return Ok(normalize_path(&out));
        }
        match ancestor.parent() {
            Some(parent) => {
                // `file_name` is `None` for `..`/root; those resolve against
                // the canonical ancestor instead of being re-attached.
                if let Some(name) = ancestor.file_name() {
                    remainder.push(name.to_os_string());
                }
                ancestor = parent;
            }
            None => {
                return Err(ToolError::ExecutionError(format!(
                    "Access denied: '{}' is outside the project directory",
                    target.display()
                )));
            }
        }
    }
}

/// Normalize a path by resolving . and .. components without requiring the path to exist.
fn normalize_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut result = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(p) => result.push(p.as_os_str()),
            std::path::Component::RootDir => result.push(std::path::MAIN_SEPARATOR_STR),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::Normal(p) => result.push(p),
        }
    }
    result
}

#[derive(Error, Debug)]
pub enum ToolError {
    #[error("Tool execution failed: {0}")]
    ExecutionError(String),
    #[error("Invalid arguments: {0}")]
    InvalidArguments(String),
    #[error("Tool not found: {0}")]
    NotFound(String),
}

#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub content: String,
    pub truncated: bool,
}

impl ToolOutput {
    pub fn new(content: String) -> Self {
        Self {
            content,
            truncated: false,
        }
    }

    pub fn truncated(content: String) -> Self {
        Self {
            content,
            truncated: true,
        }
    }
}

impl From<String> for ToolOutput {
    fn from(content: String) -> Self {
        Self::new(content)
    }
}

pub fn truncate_output(content: &str) -> ToolOutput {
    let byte_len = content.len();
    let line_count = content.lines().count();

    if byte_len <= MAX_OUTPUT_BYTES && line_count <= MAX_OUTPUT_LINES {
        return ToolOutput::new(content.to_string());
    }

    let all_lines: Vec<&str> = content.lines().collect();
    let mut truncated = false;

    let truncated_content = if all_lines.len() > MAX_OUTPUT_LINES {
        let head = MAX_OUTPUT_LINES / 2;
        let tail = MAX_OUTPUT_LINES / 2;
        let omitted = all_lines.len() - head - tail;
        let head_part = all_lines[..head].join("\n");
        let tail_part = all_lines[all_lines.len() - tail..].join("\n");
        truncated = true;
        format!("{head_part}\n\n... {omitted} lines omitted ...\n\n{tail_part}")
    } else {
        content.to_string()
    };

    let final_result = if truncated_content.len() > MAX_OUTPUT_BYTES {
        truncated = true;
        format!(
            "{}\n\n... output truncated ...",
            crate::util::truncate_at_char_boundary(&truncated_content, MAX_OUTPUT_BYTES)
        )
    } else {
        truncated_content
    };

    if truncated {
        ToolOutput::truncated(final_result)
    } else {
        ToolOutput::new(final_result)
    }
}

pub fn truncate_tool_output(output: &str, max_lines: usize, mode: &str) -> String {
    let lines: Vec<&str> = output.lines().collect();
    if lines.len() <= max_lines {
        return output.to_string();
    }
    let total = lines.len();
    match mode {
        "tail" => {
            let kept: Vec<&str> = lines.iter().rev().take(max_lines).rev().copied().collect();
            format!(
                "[Output truncated: showing last {} of {} lines]\n{}",
                max_lines,
                total,
                kept.join("\n")
            )
        }
        _ => {
            let kept: Vec<&str> = lines.iter().take(max_lines).copied().collect();
            format!(
                "[Output truncated: showing first {} of {} lines. Use start_line/end_line parameters to read specific sections.]\n{}",
                max_lines, total, kept.join("\n")
            )
        }
    }
}

type FileMutationQueues = Arc<AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>>;
static FILE_MUTATION_QUEUES: std::sync::LazyLock<FileMutationQueues> =
    std::sync::LazyLock::new(|| Arc::new(AsyncMutex::new(HashMap::new())));

/// Refuse a mutation that has not started its commit yet.
pub fn ensure_not_cancelled(signal: &AbortSignal) -> Result<(), ToolError> {
    if signal.is_aborted() {
        return Err(ToolError::ExecutionError("Tool execution cancelled".into()));
    }
    Ok(())
}

/// Serialize mutations of one path and keep the path lock owned until the
/// mutation finishes, even when its caller is cancelled.
///
/// The mutation runs in its own task. Dropping the caller's await (turn
/// cancellation, aborted handle) never drops a half-issued atomic write: the
/// detached task holds the same lock until commit and read-state recording
/// complete, so a second writer cannot interleave. `signal` is checked before
/// the mutation starts; call [`ensure_not_cancelled`] inside `f` to honor
/// cancellation before the actual commit.
pub async fn with_file_mutation_queue<F, Fut, T>(
    path: &str,
    signal: AbortSignal,
    f: F,
) -> Result<T, ToolError>
where
    F: FnOnce(AbortSignal) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T, ToolError>> + Send + 'static,
    T: Send + 'static,
{
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| Path::new(path).to_path_buf());
    let key = canonical.to_string_lossy().to_string();

    let mutex = {
        let mut queues = FILE_MUTATION_QUEUES.lock().await;
        queues
            .entry(key.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _guard = mutex.lock().await;
        let result = if signal.is_aborted() {
            Err(ToolError::ExecutionError("Tool execution cancelled".into()))
        } else {
            f(signal).await
        };
        let _ = tx.send(result);
    });

    match rx.await {
        Ok(result) => result,
        Err(_) => Err(ToolError::ExecutionError("Tool execution cancelled".into())),
    }
}

fn normalize_with_mapping(text: &str) -> (String, Vec<usize>) {
    let mut normalized = String::new();
    let mut mapping = Vec::new();
    let mut offset = 0usize;

    for line in text.lines() {
        let trimmed = line.trim_end();
        for (byte_idx, c) in trimmed.char_indices() {
            let norm_c = match c {
                '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
                '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
                '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
                '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
                _ => c,
            };
            normalized.push(norm_c);
            mapping.push(offset + byte_idx);
        }
        offset += line.len();
        if let Some(rest) = text.get(offset..) {
            if rest.starts_with("\r\n") {
                offset += 2;
                normalized.push('\n');
                mapping.push(offset - 2);
            } else if rest.starts_with('\n') {
                offset += 1;
                normalized.push('\n');
                mapping.push(offset - 1);
            }
        }
    }

    (normalized, mapping)
}

pub fn normalize_for_fuzzy_match(text: &str) -> String {
    normalize_with_mapping(text).0
}

#[derive(Debug)]
pub struct FuzzyMatchResult {
    pub found: bool,
    pub index: usize,
    pub end_index: usize,
    pub used_fuzzy: bool,
}

pub fn fuzzy_find_text(content: &str, search: &str) -> FuzzyMatchResult {
    if let Some(idx) = content.find(search) {
        return FuzzyMatchResult {
            found: true,
            index: idx,
            end_index: idx + search.len(),
            used_fuzzy: false,
        };
    }

    let (norm_content, content_mapping) = normalize_with_mapping(content);
    let (norm_search, _) = normalize_with_mapping(search);

    if let Some(idx) = norm_content.find(&norm_search) {
        let start_char_pos = norm_content[..idx].chars().count();
        let search_char_len = norm_search.chars().count();
        let start_byte = content_mapping[start_char_pos];
        let end_byte = if start_char_pos + search_char_len < content_mapping.len() {
            content_mapping[start_char_pos + search_char_len]
        } else {
            content.len()
        };
        return FuzzyMatchResult {
            found: true,
            index: start_byte,
            end_index: end_byte,
            used_fuzzy: true,
        };
    }

    FuzzyMatchResult {
        found: false,
        index: 0,
        end_index: 0,
        used_fuzzy: false,
    }
}

/// Metadata for rendering a tool call or result in the UI.
#[derive(Debug, Clone)]
pub struct ToolRenderInfo {
    pub icon: &'static str,
    pub label: String,
    pub detail: Option<String>,
}

/// Behavioral class of a tool. ONE source of truth for everything that used
/// to be name-based match lists: Plan-mode gating, subagent capability
/// filtering, permission rules and the TUI presentation tables all derive
/// from this, so a new tool of an existing kind needs no extra wiring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    /// Reads file contents (`read_file`).
    Read,
    /// Creates files (`write_file`).
    Write,
    /// Modifies existing files (`edit_file`).
    Edit,
    /// Runs commands (`shell`).
    Execute,
    /// Content search (`grep`, `find`).
    Search,
    /// Directory listings (`list_dir`).
    List,
    /// Network fetch/search (`web_fetch`, `web_search`).
    Web,
    /// Session todo list (`todo_write`).
    Todo,
    /// Plan submission (`present_plan`).
    Plan,
    /// Hosted subagent control (`task`, `task_output`, `kill_task`).
    Task,
    /// Anything else (MCP adapters, unknown names).
    Other,
}

impl ToolKind {
    /// Tools that modify project files or run commands. Blocked in Plan mode
    /// and gated by subagent capability modes. Unknown kinds (MCP) are NOT
    /// treated as mutating — matches the historical behavior where only the
    /// three known write tools were gated.
    pub fn mutates_project(self) -> bool {
        matches!(self, Self::Write | Self::Edit | Self::Execute)
    }
}

/// The kind of a tool by NAME, for call sites that only have the string
/// (permission engine, subagent policy filtering, TUI rendering). Tools
/// registered under a known name get their kind here; everything else —
/// notably MCP adapters — falls back to `None` and callers apply their own
/// conservative default.
pub fn known_kind(name: &str) -> Option<ToolKind> {
    Some(match name {
        "read_file" => ToolKind::Read,
        "file_outline" => ToolKind::Read,
        "write_file" => ToolKind::Write,
        "edit_file" | "apply_patch" => ToolKind::Edit,
        "shell" => ToolKind::Execute,
        "grep" | "find" => ToolKind::Search,
        "list_dir" => ToolKind::List,
        "web_search" | "web_fetch" => ToolKind::Web,
        "todo_write" => ToolKind::Todo,
        "present_plan" => ToolKind::Plan,
        "task" | "task_output" | "kill_task" => ToolKind::Task,
        _ => return None,
    })
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> serde_json::Value;
    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Parallel
    }

    fn allowed_in_plan(&self) -> bool {
        true
    }

    /// Behavioral class driving mode gating, capability filtering and UI
    /// presentation. Defaults to the conservative catch-all.
    fn kind(&self) -> ToolKind {
        ToolKind::Other
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        project_dir: &str,
    ) -> Result<String, ToolError>;

    /// Context-aware execution path. Existing tools only need to implement
    /// [`Tool::execute`]; this default wrapper drops an ordinary tool future as
    /// soon as its invocation is cancelled.
    async fn execute_with_context(
        &self,
        args: serde_json::Value,
        project_dir: &str,
        context: ToolExecutionContext,
    ) -> Result<String, ToolError> {
        if context.cancellation.is_aborted() {
            return Err(ToolError::ExecutionError("Tool execution cancelled".into()));
        }
        let run = self.execute(args, project_dir);
        tokio::pin!(run);
        let mut heartbeat =
            tokio::time::interval(std::time::Duration::from_millis(TOOL_HEARTBEAT_MS));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        heartbeat.tick().await;
        loop {
            tokio::select! {
                result = &mut run => return result,
                _ = context.cancellation.wait_aborted() => {
                    return Err(ToolError::ExecutionError("Tool execution cancelled".into()));
                }
                _ = heartbeat.tick() => context.heartbeat(),
            }
        }
    }

    /// Icon displayed next to the tool name in the UI.
    fn icon(&self) -> &'static str {
        "→"
    }

    /// Render a short summary of the tool call for the UI.
    /// Default implementation shows the tool name and first argument.
    fn render_call(&self, args: &serde_json::Value) -> ToolRenderInfo {
        let detail = args
            .as_object()
            .and_then(|m| m.values().next())
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        ToolRenderInfo {
            icon: self.icon(),
            label: self.name().to_string(),
            detail,
        }
    }
}

/// Args type bound for the typed tool path: deserialization from the
/// model-provided JSON plus a schema generated free from the struct
/// (schemars, doc comments become field descriptions).
pub trait ToolArgs: serde::de::DeserializeOwned + schemars::JsonSchema + Send {}
impl<T> ToolArgs for T where T: serde::de::DeserializeOwned + schemars::JsonSchema + Send {}

/// The typed authoring path. Implement this — with an
/// args struct whose doc comments document the schema — and `register_typed`
/// handles schema generation, argument parsing, cancellation and truncation.
pub trait ToolCore: Send + Sync + 'static {
    type Args: ToolArgs;
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn icon(&self) -> &'static str {
        "→"
    }
    fn kind(&self) -> ToolKind {
        ToolKind::Other
    }
    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Parallel
    }
    fn allowed_in_plan(&self) -> bool {
        true
    }
    /// Card-header summary for the UI. Defaults to the generic first-string
    /// treatment; override to surface a specific arg (e.g. a plan title).
    fn render_call(&self, args: &serde_json::Value) -> ToolRenderInfo {
        let detail = args
            .as_object()
            .and_then(|m| m.values().next())
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        ToolRenderInfo {
            icon: self.icon(),
            label: self.name().to_string(),
            detail,
        }
    }
    // Declared RPITIT-style with an explicit Send bound (implementers write
    // a plain `async fn run`) so the adapter's futures stay Send.
    fn run(
        &self,
        args: Self::Args,
        project_dir: &str,
        context: &ToolExecutionContext,
    ) -> impl std::future::Future<Output = Result<String, ToolError>> + Send;
}

/// Bridges a [`ToolCore`] into the object-safe [`Tool`] trait: schema from
/// the args type, JSON args parsed into it once, then typed `run`.
pub struct TypedTool<C: ToolCore>(C);

impl<C: ToolCore> TypedTool<C> {
    /// Wrap a typed tool core. The field is private, so this is the only way
    /// for other modules (notably their test blocks) to build one.
    pub fn new(core: C) -> Self {
        TypedTool(core)
    }

    pub fn boxed() -> Box<dyn Tool>
    where
        C: Default,
    {
        Box::new(TypedTool(C::default()))
    }
}

#[async_trait]
impl<C: ToolCore> Tool for TypedTool<C> {
    fn name(&self) -> &str {
        self.0.name()
    }

    fn description(&self) -> &str {
        self.0.description()
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::to_value(schemars::schema_for!(C::Args)).unwrap_or(serde_json::json!({
            "type": "object"
        }))
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        self.0.execution_mode()
    }

    fn allowed_in_plan(&self) -> bool {
        self.0.allowed_in_plan()
    }

    fn kind(&self) -> ToolKind {
        self.0.kind()
    }

    fn icon(&self) -> &'static str {
        self.0.icon()
    }

    fn render_call(&self, args: &serde_json::Value) -> ToolRenderInfo {
        self.0.render_call(args)
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        project_dir: &str,
    ) -> Result<String, ToolError> {
        let parsed: C::Args = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArguments(format!("Invalid arguments: {e}")))?;
        self.0
            .run(parsed, project_dir, &ToolExecutionContext::default())
            .await
    }

    async fn execute_with_context(
        &self,
        args: serde_json::Value,
        project_dir: &str,
        context: ToolExecutionContext,
    ) -> Result<String, ToolError> {
        if context.cancellation.is_aborted() {
            return Err(ToolError::ExecutionError("Tool execution cancelled".into()));
        }
        let parsed: C::Args = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArguments(format!("Invalid arguments: {e}")))?;
        let run = self.0.run(parsed, project_dir, &context);
        tokio::pin!(run);
        let mut heartbeat =
            tokio::time::interval(std::time::Duration::from_millis(TOOL_HEARTBEAT_MS));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        heartbeat.tick().await;
        loop {
            tokio::select! {
                result = &mut run => return result,
                _ = context.cancellation.wait_aborted() => {
                    return Err(ToolError::ExecutionError("Tool execution cancelled".into()));
                }
                _ = heartbeat.tick() => context.heartbeat(),
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ToolExecutionMode {
    Parallel,
    Sequential,
}

pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn Tool>>,
    project_dir: String,
}

impl ToolRegistry {
    pub fn new(project_dir: impl Into<String>) -> Self {
        let project_dir = project_dir.into();
        let agents = crate::subagent::definition::custom_subagents(&project_dir);
        Self::with_agents(project_dir, &agents)
    }

    /// Build a registry from an already-loaded roster. Children use this so a
    /// fresh worktree checkout does not re-scan `.agente/agents` on disk.
    pub fn with_agents(
        project_dir: impl Into<String>,
        agents: &[crate::subagent::CustomSubagent],
    ) -> Self {
        let mut registry = Self {
            tools: HashMap::new(),
            project_dir: project_dir.into(),
        };
        registry.register_typed::<ShellTool>();
        registry.register_typed::<ReadFileTool>();
        registry.register_typed::<WriteFileTool>();
        registry.register_typed::<EditFileTool>();
        registry.register_typed::<ApplyPatchTool>();
        registry.register_typed::<ListDirTool>();
        registry.register_typed::<FileOutlineTool>();
        registry.register_typed::<GrepTool>();
        registry.register_typed::<FindTool>();
        registry.register_typed::<TodoWriteTool>();
        registry.register_typed::<PresentPlanTool>();
        registry.register_typed::<WebFetchTool>();
        registry.register_typed::<WebSearchTool>();
        registry.register(Box::new(TaskTool::with_roster(
            crate::subagent::definition::agent_roster_with(&registry.project_dir, agents),
        )));
        registry.register(Box::new(TaskOutputTool));
        registry.register(Box::new(KillTaskTool));
        registry
    }

    /// Register pre-built MCP tool adapters.
    /// Register a typed tool: schema comes from the
    /// args struct, arguments are parsed into it before `run`.
    pub fn register_typed<C>(&mut self)
    where
        C: ToolCore + Default,
    {
        self.register(TypedTool::<C>::boxed());
    }

    pub fn register_mcp_adapters(&mut self, adapters: Vec<Box<dyn Tool>>) {
        for adapter in adapters {
            self.register(adapter);
        }
    }

    pub fn register(&mut self, tool: Box<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub fn project_dir(&self) -> &str {
        &self.project_dir
    }

    pub fn get(&self, name: &str) -> Option<&dyn Tool> {
        self.tools.get(name).map(|t| t.as_ref())
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .values()
            .map(|t| ToolDefinition {
                name: t.name().to_string(),
                description: t.description().to_string(),
                parameters: t.parameters(),
            })
            .collect()
    }

    /// Get tool definitions filtered by agent mode.
    /// Plan mode only allows non-mutating tools (kind-derived, see
    /// [`ToolKind::mutates_project`]).
    pub fn definitions_for_mode(&self, mode: crate::types::AgentMode) -> Vec<ToolDefinition> {
        self.tools
            .values()
            .filter(|t| {
                match mode {
                    crate::types::AgentMode::Plan => {
                        // Plan mode: read-only tools only
                        !t.kind().mutates_project() && t.allowed_in_plan()
                    }
                    crate::types::AgentMode::Build => true,
                }
            })
            .map(|t| ToolDefinition {
                name: t.name().to_string(),
                description: t.description().to_string(),
                parameters: t.parameters(),
            })
            .collect()
    }

    /// Check if a tool is allowed in the given mode
    pub fn is_allowed_in_mode(&self, name: &str, mode: crate::types::AgentMode) -> bool {
        match mode {
            crate::types::AgentMode::Plan => self
                .tools
                .get(name)
                .map(|t| !t.kind().mutates_project() && t.allowed_in_plan())
                .unwrap_or(false),
            crate::types::AgentMode::Build => self.tools.contains_key(name),
        }
    }

    pub async fn execute(&self, name: &str, args: serde_json::Value) -> Result<String, ToolError> {
        self.execute_with_context(name, args, ToolExecutionContext::default())
            .await
    }

    pub async fn execute_with_context(
        &self,
        name: &str,
        args: serde_json::Value,
        context: ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let tool = self
            .tools
            .get(name)
            .ok_or_else(|| ToolError::NotFound(name.to_string()))?;
        let result = tool
            .execute_with_context(args, &self.project_dir, context)
            .await?;
        let output = truncate_output(&result);
        if output.truncated {
            Ok(format!(
                "{}\n[Output truncated to {} lines / {}KB]",
                output.content,
                MAX_OUTPUT_LINES,
                MAX_OUTPUT_BYTES / 1024
            ))
        } else {
            Ok(output.content)
        }
    }

    pub fn is_sequential(&self, name: &str) -> bool {
        self.tools
            .get(name)
            .map(|t| t.execution_mode() == ToolExecutionMode::Sequential)
            .unwrap_or(false)
    }

    /// Drop every tool whose name is not in `names`. Used by the subagent host
    /// to enforce capability/allowlist gating at the registry level, so a child
    /// can never call an out-of-scope tool even if the model hallucinates one.
    pub fn retain_named(&mut self, names: &[&str]) {
        self.tools.retain(|name, _| names.contains(&name.as_str()));
    }
}

#[cfg(test)]
mod typed_path_tests {
    use super::*;

    #[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
    struct EchoArgs {
        /// Text to echo back.
        text: String,
        /// How many times to repeat it.
        #[serde(default)]
        times: u32,
    }

    #[derive(Debug, Default)]
    struct EchoTool;

    impl ToolCore for EchoTool {
        type Args = EchoArgs;

        fn name(&self) -> &str {
            "echo_test"
        }

        fn description(&self) -> &str {
            "Echo the given text."
        }

        fn kind(&self) -> ToolKind {
            ToolKind::Other
        }

        async fn run(
            &self,
            args: EchoArgs,
            _project_dir: &str,
            _context: &ToolExecutionContext,
        ) -> Result<String, ToolError> {
            Ok(args.text.repeat(args.times.max(1) as usize))
        }
    }

    #[tokio::test]
    async fn typed_tool_schema_comes_from_the_args_struct() {
        let adapter = TypedTool::new(EchoTool);
        let schema = Tool::parameters(&adapter);
        let text = schema["properties"]["text"]["description"]
            .as_str()
            .expect("doc comment became description");
        assert_eq!(text, "Text to echo back.");
        assert_eq!(schema["properties"]["times"]["type"], "integer");
    }

    #[tokio::test]
    async fn typed_tool_parses_and_runs() {
        let adapter = TypedTool::new(EchoTool);
        let out = adapter
            .execute(serde_json::json!({"text": "hi", "times": 3}), "/tmp")
            .await
            .unwrap();
        assert_eq!(out, "hihihi");
        let err = adapter
            .execute(serde_json::json!({"nope": true}), "/tmp")
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidArguments(_)));
    }

    #[tokio::test]
    async fn register_typed_places_a_working_tool() {
        let mut registry = ToolRegistry::new("/tmp");
        registry.register_typed::<EchoTool>();
        assert!(registry.is_allowed_in_mode("echo_test", crate::types::AgentMode::Build));
        let out = registry
            .execute("echo_test", serde_json::json!({"text": "ok"}))
            .await
            .unwrap();
        assert_eq!(out, "ok");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dropping the caller's future must not release the path lock while an
    /// already-started mutation is still committing. The second mutation has
    /// to observe the first one's result.
    #[tokio::test(flavor = "multi_thread")]
    async fn cancelled_mutation_keeps_its_path_lock_until_it_finishes() {
        let dir = std::env::temp_dir().join(format!("agente-mut-queue-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f.txt");
        let path = file.to_string_lossy().to_string();

        let controller = crate::cancellation::AbortController::new();
        let signal = controller.signal();
        let first_path = file.clone();
        let first = tokio::spawn(async move {
            with_file_mutation_queue(&path, signal, move |_| async move {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                std::fs::write(&first_path, "A").unwrap();
                Ok(())
            })
            .await
        });
        // Let the first mutation start, then abort its caller.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        controller.abort();
        first.abort();

        let second_path = file.clone();
        let observed = with_file_mutation_queue(
            &file.to_string_lossy(),
            crate::cancellation::AbortSignal::never(),
            move |_| async move {
                let seen = std::fs::read_to_string(&second_path).unwrap_or_default();
                std::fs::write(&second_path, "B").unwrap();
                Ok(seen)
            },
        )
        .await
        .expect("second mutation");

        assert_eq!(
            observed, "A",
            "the cancelled commit must finish under its lock before the next writer"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "B");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A mutation that has not started yet must refuse to run once its signal
    /// is aborted.
    #[tokio::test(flavor = "multi_thread")]
    async fn aborted_mutation_never_writes() {
        let dir = std::env::temp_dir().join(format!("agente-mut-abort-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f.txt");
        let controller = crate::cancellation::AbortController::new();
        controller.abort();

        let target = file.clone();
        let result = with_file_mutation_queue(
            &file.to_string_lossy(),
            controller.signal(),
            move |_| async move {
                std::fs::write(&target, "nope").unwrap();
                Ok(())
            },
        )
        .await;
        assert!(result.is_err(), "aborted mutation must not report success");
        assert!(!file.exists(), "aborted mutation must not write");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_tool_output_new() {
        let output = ToolOutput::new("test content".to_string());
        assert_eq!(output.content, "test content");
        assert!(!output.truncated);
    }

    #[test]
    fn test_tool_output_truncated() {
        let output = ToolOutput::truncated("test content".to_string());
        assert_eq!(output.content, "test content");
        assert!(output.truncated);
    }

    #[test]
    fn truncate_output_preserves_utf8_at_byte_limit() {
        let prefix = "a".repeat(MAX_OUTPUT_BYTES - 1);
        let result = truncate_output(&format!("{prefix}🎉tail"));
        assert!(result.truncated);
        assert_eq!(
            result.content,
            format!("{prefix}\n\n... output truncated ...")
        );
    }

    #[test]
    fn test_truncate_output_empty() {
        let result = truncate_output("");
        assert_eq!(result.content, "");
        assert!(!result.truncated);
    }

    #[test]
    fn test_truncate_output_small() {
        let content = "small content";
        let result = truncate_output(content);
        assert_eq!(result.content, content);
        assert!(!result.truncated);
    }

    #[test]
    fn test_tool_error_display() {
        let err = ToolError::NotFound("test_tool".to_string());
        assert!(err.to_string().contains("test_tool"));
    }

    #[test]
    fn test_max_output_constants() {
        const {
            assert!(MAX_OUTPUT_LINES > 0);
            assert!(MAX_OUTPUT_BYTES > 0);
        }
        assert_eq!(MAX_OUTPUT_BYTES, 50 * 1024);
    }

    struct BuildOnlyTool;

    #[async_trait::async_trait]
    impl Tool for BuildOnlyTool {
        fn name(&self) -> &str {
            "build_only"
        }

        fn description(&self) -> &str {
            "Build-only test tool"
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({"type":"object"})
        }

        fn allowed_in_plan(&self) -> bool {
            false
        }

        async fn execute(
            &self,
            _args: serde_json::Value,
            _project_dir: &str,
        ) -> Result<String, ToolError> {
            Ok("ok".to_string())
        }
    }

    #[test]
    fn test_mode_filtered_tool_access() {
        let mut registry = ToolRegistry::new(".");
        registry.register(Box::new(BuildOnlyTool));

        assert!(!registry.is_allowed_in_mode("write_file", crate::types::AgentMode::Plan));
        assert!(!registry.is_allowed_in_mode("build_only", crate::types::AgentMode::Plan));
        assert!(registry.is_allowed_in_mode("build_only", crate::types::AgentMode::Build));
        assert!(!registry.is_allowed_in_mode("missing_tool", crate::types::AgentMode::Build));
    }

    struct SlowTool;

    #[async_trait::async_trait]
    impl Tool for SlowTool {
        fn name(&self) -> &str {
            "slow"
        }

        fn description(&self) -> &str {
            "Slow test tool"
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({"type":"object"})
        }

        async fn execute(
            &self,
            _args: serde_json::Value,
            _project_dir: &str,
        ) -> Result<String, ToolError> {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            Ok("finished".into())
        }
    }

    #[tokio::test]
    async fn context_cancels_ordinary_tool_futures() {
        let mut registry = ToolRegistry::new(".");
        registry.register(Box::new(SlowTool));
        let controller = crate::cancellation::AbortController::new();
        let signal = controller.signal();
        let task = tokio::spawn(async move {
            registry
                .execute_with_context(
                    "slow",
                    serde_json::json!({}),
                    ToolExecutionContext::new(signal),
                )
                .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        controller.abort();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .expect("cancelled tool should return promptly")
            .expect("tool task should not panic");
        assert!(result.unwrap_err().to_string().contains("cancelled"));
    }

    #[test]
    fn test_fuzzy_match() {
        let result = fuzzy_find_text("hello world", "world");
        assert!(result.found);
        assert_eq!(result.index, 6);
        assert_eq!(result.end_index, 11);
        assert!(!result.used_fuzzy);
    }

    #[test]
    fn test_fuzzy_match_smart_quotes() {
        let content = "say \u{201C}hello\u{201D} world";
        let result = fuzzy_find_text(content, "say \"hello\"");
        assert!(result.found);
        assert!(result.used_fuzzy);
        // Should replace the exact smart-quoted text, not guess byte length
        assert_eq!(result.index, 0);
        assert_eq!(result.end_index, 15); // byte length of "say " + 3-byte curly quotes + "hello" + 3-byte curly quote
        let new_content = format!(
            "{}{}{}",
            &content[..result.index],
            "say \"goodbye\"",
            &content[result.end_index..]
        );
        assert_eq!(new_content, "say \"goodbye\" world");
    }

    #[tokio::test]
    async fn file_outline_registered_and_allowed_in_plan() {
        let registry = ToolRegistry::new(".");
        assert!(registry.is_allowed_in_mode("file_outline", crate::types::AgentMode::Plan));
        assert!(registry.is_allowed_in_mode("file_outline", crate::types::AgentMode::Build));

        let temp_dir = std::env::temp_dir().join(format!("outline-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir).await.unwrap();
        let test_file = temp_dir.join("sample.rs");
        tokio::fs::write(
            &test_file,
            "pub struct Model;\nimpl Model {\n    pub fn run() {}\n}\n",
        )
        .await
        .unwrap();

        let reg = ToolRegistry::new(&*temp_dir.to_string_lossy());
        let res = reg
            .execute("file_outline", serde_json::json!({"path": "sample.rs"}))
            .await
            .unwrap();

        assert!(res.contains("pub struct Model"));
        assert!(res.contains("impl Model"));
        assert!(res.contains("pub fn run()"));

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn apply_patch_registered_and_modifies_file() {
        let registry = ToolRegistry::new(".");
        assert!(!registry.is_allowed_in_mode("apply_patch", crate::types::AgentMode::Plan));
        assert!(registry.is_allowed_in_mode("apply_patch", crate::types::AgentMode::Build));

        let temp_dir = std::env::temp_dir().join(format!("patch-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir).await.unwrap();
        let target_file = temp_dir.join("lib.rs");
        tokio::fs::write(&target_file, "fn start() {\n    init();\n}\n")
            .await
            .unwrap();

        let patch_content = "--- a/lib.rs\n+++ b/lib.rs\n@@ -1,3 +1,4 @@\n fn start() {\n+    setup();\n     init();\n }\n";

        let reg = ToolRegistry::new(&*temp_dir.to_string_lossy());
        let _ = reg
            .execute("read_file", serde_json::json!({"path": "lib.rs"}))
            .await
            .unwrap();
        let res = reg
            .execute("apply_patch", serde_json::json!({"patch": patch_content}))
            .await
            .unwrap();

        assert!(res.contains("Successfully applied patch"));
        let updated = tokio::fs::read_to_string(&target_file).await.unwrap();
        assert!(updated.contains("setup();"));
        assert!(updated.contains("init();"));

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn tool_arg_aliases_deserialized_properly() {
        let temp_dir = std::env::temp_dir().join(format!("alias-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir).await.unwrap();
        let reg = ToolRegistry::new(&*temp_dir.to_string_lossy());

        // write_file with file_path and contents aliases
        reg.execute(
            "write_file",
            serde_json::json!({"file_path": "alias.txt", "contents": "hello from alias"}),
        )
        .await
        .unwrap();

        // read_file with file alias
        let content = reg
            .execute("read_file", serde_json::json!({"file": "alias.txt"}))
            .await
            .unwrap();
        assert!(content.contains("hello from alias"));

        // edit_file with filepath, query, and replacement aliases
        reg.execute(
            "edit_file",
            serde_json::json!({
                "filepath": "alias.txt",
                "query": "hello",
                "replacement": "world"
            }),
        )
        .await
        .unwrap();

        let updated = reg
            .execute("read_file", serde_json::json!({"path": "alias.txt"}))
            .await
            .unwrap();
        assert!(updated.contains("world from alias"));

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    /// Best-effort symlink creation: Windows machines without Developer Mode
    /// cannot create symlinks, so those environments skip instead of failing.
    #[cfg(test)]
    fn try_symlink_dir(original: &std::path::Path, link: &std::path::Path) -> bool {
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(original, link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(original, link).is_ok();
        if !made {
            eprintln!("skipping symlink test: cannot create symlinks on this machine");
        }
        made
    }

    #[test]
    fn resolve_project_path_rejects_new_file_through_symlinked_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        if !try_symlink_dir(&outside, &project.join("link")) {
            return;
        }

        let err = resolve_project_path("link/new.txt", &project.to_string_lossy())
            .expect_err("new file through a symlinked parent must be rejected");
        assert!(err.to_string().contains("outside the project directory"));
    }

    #[test]
    fn resolve_project_path_rejects_dangling_symlink_pointing_outside() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // Dangling on purpose: outside/target.txt is never created.
        if !try_symlink_dir(&outside.join("target.txt"), &project.join("evil")) {
            return;
        }

        let err = resolve_project_path("evil", &project.to_string_lossy())
            .expect_err("dangling symlink pointing outside must be rejected");
        assert!(err.to_string().contains("outside the project directory"));
    }

    #[test]
    fn resolve_project_path_allows_new_file_and_in_project_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("real.txt"), "x").unwrap();

        // Plain new file inside the project still resolves. New files now
        // come back canonical (verbatim `\\?\` on Windows), exactly like
        // existing files already did — compare against the canonical root.
        let canon_project = std::fs::canonicalize(&project).unwrap();
        let resolved = resolve_project_path("new.txt", &project.to_string_lossy()).unwrap();
        assert!(resolved.starts_with(&canon_project));

        // Existing file reached through a symlink that stays inside the
        // project keeps working (no over-blocking).
        if !try_symlink_dir(&project, &project.join("self")) {
            return;
        }
        let resolved = resolve_project_path("self/real.txt", &project.to_string_lossy()).unwrap();
        // `canonicalize` returns a verbatim (`\\?\`) path on Windows, so
        // compare against the canonical project root, not the plain join.
        assert!(resolved.starts_with(&canon_project));
        // Fully resolved to the real file, not left pointing at the link.
        assert_eq!(std::fs::read_to_string(&resolved).unwrap(), "x");
    }
}
