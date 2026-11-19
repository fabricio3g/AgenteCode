//! Subagent types: spawn requests, snapshots, results, and streaming events.
//!
//! Field names mirror the `task` / `task_output` / `kill_task` tool inputs so
//! the JSON schema exposed to the model stays stable.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::types::Message;

/// Capability mode controlling which tool classes a child agent can use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SubagentCapabilityMode {
    /// read_file, list_dir, grep, find, web_search, web_fetch, todo_write,
    /// present_plan only. No mutations, no shell.
    ReadOnly,
    /// Read-only tools plus write_file / edit_file.
    ReadWrite,
    /// Read-write tools plus shell.
    Execute,
    /// Everything, including spawning nested subagents.
    All,
}

impl SubagentCapabilityMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::ReadWrite => "read-write",
            Self::Execute => "execute",
            Self::All => "all",
        }
    }
}

/// Where a child runs. `Worktree` gives every subagent its own checkout under
/// `<repo>/.agente/worktrees/`, seeded with the parent's uncommitted changes;
/// `None` pins the child to the parent root (escape hatch).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SubagentIsolation {
    #[default]
    Worktree,
    None,
}

impl SubagentIsolation {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Worktree => "worktree",
            Self::None => "none",
        }
    }
}

/// Input of the `task` tool (spawns a subagent).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentSpawnRequest {
    /// The full task prompt for the subagent to execute.
    pub prompt: String,
    /// Short description of the task (3-5 words).
    pub description: String,
    /// One of the user's own agents (`.agente/agents/*.md`) to launch by
    /// name. Usually empty: the parent creates the subagent from `role`.
    /// There are no predetermined subagents.
    #[serde(default, alias = "type", alias = "agent", alias = "agent_type")]
    pub subagent_type: String,
    /// Create the subagent for this task: who it is, in a few words
    /// ("Security reviewer"). Shown on its card. Read-only unless
    /// `capability_mode` says otherwise. With one of the user's agents it
    /// sharpens that agent instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// How the created subagent should work, beyond the task prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// When true, returns immediately with a `task_id`; the completion is
    /// pushed automatically when no poll is outstanding, or fetched with
    /// `task_output`. When false, blocks until the subagent finishes. Absent
    /// means "decide by type": explore/plan run inline, others in background.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_in_background: Option<bool>,
    /// Capability mode for the child's tool access. Default is determined by
    /// the subagent type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_mode: Option<SubagentCapabilityMode>,
    /// Explicit working directory for the subagent. Must exist and be a
    /// directory; validated at spawn time. Defaults to the parent's project
    /// directory. Ignored when `resume_from` is set or when isolation is
    /// `worktree` (the worktree path wins).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Where the child runs. Default `worktree`: a per-child checkout seeded
    /// with the parent's uncommitted changes. `none` pins it to the parent
    /// root. Ignored when `resume_from` is set (the source worktree is reused).
    #[serde(default, alias = "isolate")]
    pub isolation: SubagentIsolation,
    /// Optional iteration budget for the child loop. `None` (the default)
    /// means unbounded: the child runs until the model stops
    /// calling tools, bounded only by the wall-clock watchdog. The parent's
    /// budget is never inherited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
    /// Wall-clock budget in milliseconds. Positive values bound the run;
    /// absent or zero falls back to the default (10 minutes). On expiry the
    /// child is aborted and reported as a timeout failure with its partial
    /// transcript kept for `resume_from`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// Resume from a previously completed subagent's conversation. The new
    /// subagent continues the previous one's transcript with the new task
    /// prompt appended. The source must be completed and use the same
    /// subagent type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_from: Option<String>,
    /// A name from the user's subagent model list (or `main`). Only offered
    /// when the user lets the orchestrator pick; see `subagent::routing`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Server-injected before execution. Becomes the subagent's id.
    #[serde(skip)]
    pub task_id: Option<String>,
}

impl SubagentSpawnRequest {
    /// Settle what the parent left out: trimmed fields, empty strings as
    /// absent, and the task's description as the role when it named neither
    /// a role nor one of the user's agents. Run once, before anything reads
    /// the request.
    pub fn normalize(&mut self) {
        let clean = |value: &mut Option<String>| {
            *value = value
                .take()
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty());
        };
        clean(&mut self.role);
        clean(&mut self.instructions);
        self.subagent_type = self.subagent_type.trim().to_string();
        if self.subagent_type.is_empty() && self.role.is_none() {
            let description = self.description.trim();
            self.role = Some(if description.is_empty() {
                "Subagent".to_string()
            } else {
                description.to_string()
            });
        }
    }

    /// True when the parent creates the child (no user agent named).
    pub fn is_created(&self) -> bool {
        self.subagent_type.is_empty()
    }

    /// Resolve the effective background flag. An explicit choice always wins;
    /// otherwise a read-only child — research whose answer the parent needs
    /// to continue — runs inline, and one that may change things runs in the
    /// background. A user agent with no capability named runs in the
    /// background.
    pub fn resolved_run_in_background(&self) -> bool {
        self.run_in_background.unwrap_or_else(|| match self.capability_mode {
            Some(mode) => mode != SubagentCapabilityMode::ReadOnly,
            None => !self.is_created(),
        })
    }
}

/// Lifecycle state of a spawned subagent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl SubagentStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Immutable-ish view of a subagent stored in the [`crate::subagent::registry::SubagentRegistry`].
#[derive(Debug, Clone)]
pub struct SubagentSnapshot {
    pub id: String,
    pub subagent_type: String,
    pub description: String,
    /// Exact task/context supplied by the delegating agent, not an inferred
    /// summary or a copy of its conversation. Displayed in the handoff view.
    pub prompt: String,
    pub status: SubagentStatus,
    /// Latest writeup: the live tail of what the child has produced while it
    /// runs, replaced by the final answer (or error text) when it finishes.
    pub summary: Option<String>,
    /// Transcript kept for `resume_from` (bounded).
    pub conversation: Vec<Message>,
    pub model: String,
    /// The subagent model list name the child runs on (`None`: the parent's
    /// model, or an agent file's `provider/model`).
    pub seat: Option<String>,
    /// Provider and thinking level it runs at, kept so a resume continues
    /// on the same route.
    pub provider: String,
    pub thinking: String,
    /// Nesting depth (parent = 0).
    pub depth: u32,
    /// True when spawned with `run_in_background`: the parent does not block
    /// on this child, so terminal states push a completion notice instead of
    /// relying on `task_output` polling.
    pub background: bool,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    /// Effective working root (the worktree path when isolated).
    pub cwd: Option<String>,
    /// Isolation checkout when the child ran in a worktree. `dirty` flips once
    /// the child changed anything past the seeded parent state.
    pub worktree: Option<crate::subagent::worktree::WorktreeInfo>,
}

impl SubagentSnapshot {
    /// What a card names the model by: `scout · qwen3-coder:free` when it
    /// came from the user's list, the bare model otherwise.
    pub fn model_label(&self) -> String {
        model_label(self.seat.as_deref(), &self.model)
    }
}

/// `seat · model`, or `model` alone without a list name.
pub fn model_label(seat: Option<&str>, model: &str) -> String {
    match seat.filter(|s| !s.is_empty()) {
        Some(seat) if !model.is_empty() => format!("{seat} \u{b7} {model}"),
        Some(seat) => seat.to_string(),
        None => model.to_string(),
    }
}

/// Render the push completion notice for a background child no waiter
/// observed: compact status line for the parent conversation plus a resume
/// pointer. Single source of truth shared by the forwarder payload and the
/// TUI injection row.
pub fn completion_notice_text(
    id: &str,
    subagent_type: &str,
    status: &str,
    summary: &str,
) -> String {
    format!(
        "Subagent {id} ({subagent_type}) {status}.\n{summary}\nResume with resume_from:{id} if follow-up work is needed."
    )
}

/// What the `task` tool returns to the model.
#[derive(Debug, Clone)]
pub struct SubagentResult {
    pub id: String,
    pub status: SubagentStatus,
    pub summary: Option<String>,
    /// Pass this as `resume_from` in a later `task` call to continue this
    /// subagent's conversation.
    pub resume_from_hint: Option<String>,
    pub is_error: bool,
}

impl SubagentResult {
    /// Render the tool result as a compact text block for the chat transcript.
    pub fn render(&self) -> String {
        let status = self.status.as_str();
        let summary = self.summary.as_deref().unwrap_or("");
        let resume = self
            .resume_from_hint
            .as_deref()
            .map(|h| format!("\nresume_from: {h}\n"))
            .unwrap_or_default();
        if matches!(
            self.status,
            SubagentStatus::Pending | SubagentStatus::Running
        ) {
            let text = self
                .summary
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if self.status == SubagentStatus::Pending {
                // A queued child has a queue position to report, not output.
                let note = text.map(|s| format!("\n{s}")).unwrap_or_default();
                return format!(
                    "Subagent {} (pending) queued.\nstatus: pending{}\nUse task_output to collect the result once it starts, or kill_task to cancel it.\n{}",
                    self.id, note, resume
                );
            }
            // A running child reports what it has found so far. Without this a
            // poll returned a bare status line, so the model polled again and
            // blocked on another bounded wait — slow and empty at once.
            let progress = text
                .map(|s| format!("\nOutput so far:\n{s}"))
                .unwrap_or_default();
            format!(
                "Subagent {} ({}) started.\nstatus: {}{}\nUse task_output to retrieve the result, or kill_task to cancel it.\n{}",
                self.id, status, status, progress, resume
            )
        } else if self.is_error {
            format!(
                "Subagent {} ({}) failed.\nstatus: {}\n{}\n{}",
                self.id, status, status, summary, resume
            )
        } else {
            format!(
                "Subagent {} ({}) finished.\nstatus: {}\n{}\n{}",
                self.id, status, status, summary, resume
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(status: SubagentStatus, summary: Option<&str>, is_error: bool) -> SubagentResult {
        SubagentResult {
            id: "s-1".into(),
            status,
            summary: summary.map(str::to_string),
            resume_from_hint: Some("s-1".into()),
            is_error,
        }
    }

    #[test]
    fn status_lifecycle_is_terminal_and_labels() {
        assert!(!SubagentStatus::Pending.is_terminal());
        assert!(!SubagentStatus::Running.is_terminal());
        assert!(SubagentStatus::Completed.is_terminal());
        assert!(SubagentStatus::Failed.is_terminal());
        assert!(SubagentStatus::Cancelled.is_terminal());
        assert_eq!(SubagentStatus::Completed.as_str(), "completed");
        assert_eq!(SubagentStatus::Cancelled.as_str(), "cancelled");
    }

    #[test]
    fn render_running_tells_the_model_to_poll() {
        let r = result(
            SubagentStatus::Running,
            Some("started in background"),
            false,
        );
        let out = r.render();
        assert!(out.contains("started"), "{out}");
        assert!(out.contains("status: running"), "{out}");
        assert!(
            out.contains("task_output"),
            "running render must name task_output: {out}"
        );
        assert!(out.contains("resume_from: s-1"), "{out}");
    }

    #[test]
    fn render_running_reports_output_so_far() {
        let r = result(
            SubagentStatus::Running,
            Some("found three call sites"),
            false,
        );
        let out = r.render();
        assert!(out.contains("Output so far:"), "{out}");
        assert!(out.contains("found three call sites"), "{out}");
        // A queue position is not output, and must not be labelled as it.
        let pending = result(SubagentStatus::Pending, Some("queued at position 2"), false);
        let out = pending.render();
        assert!(!out.contains("Output so far:"), "{out}");
        assert!(out.contains("queued at position 2"), "{out}");
    }

    #[test]
    fn render_running_with_coercion_note_surfaces_read_only() {
        let r = result(
            SubagentStatus::Running,
            Some("started in background with read-only tools (Plan mode coerces every child to read-only)"),
            false,
        );
        let out = r.render();
        assert!(out.contains("status: running"), "{out}");
        assert!(out.contains("read-only"), "{out}");
        assert!(out.contains("task_output"), "{out}");
    }

    #[test]
    fn render_completed_includes_summary_and_resume_hint() {
        let r = result(SubagentStatus::Completed, Some("found the bug"), false);
        let out = r.render();
        assert!(out.contains("finished"), "{out}");
        assert!(out.contains("found the bug"), "{out}");
        assert!(out.contains("resume_from: s-1"), "{out}");
    }

    #[test]
    fn render_pending_shows_queue_position() {
        let r = result(
            SubagentStatus::Pending,
            Some("queued at position 2 (4 running)"),
            false,
        );
        let out = r.render();
        assert!(out.contains("pending"), "{out}");
        assert!(out.contains("queued at position 2"), "{out}");
        assert!(!out.contains("started"), "{out}");
    }

    #[test]
    fn render_failed_flags_error() {
        let r = result(SubagentStatus::Failed, Some("depth limit reached"), true);
        let out = r.render();
        assert!(out.contains("failed"), "{out}");
        assert!(out.contains("depth limit reached"), "{out}");
    }

    #[test]
    fn completion_notice_carries_status_summary_and_resume_pointer() {
        let out = completion_notice_text("s-9", "explore", "completed", "found the bug");
        assert!(out.contains("s-9"), "{out}");
        assert!(out.contains("explore"), "{out}");
        assert!(out.contains("completed"), "{out}");
        assert!(out.contains("found the bug"), "{out}");
        assert!(out.contains("resume_from:s-9"), "{out}");
    }
}
