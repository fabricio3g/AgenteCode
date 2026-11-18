//! Subagent system: spawn, run, track, and resume child agents.
//!
//! - `types` — `task` tool input schema, snapshots, results, events
//! - `definition` — built-in (general-purpose / explore / plan) + custom
//!   `.agente/agents/*.md` definitions, capability modes, tool filtering
//! - `context` — child context forking + completion summaries
//! - `registry` — running/completed subagent tracking + resume transcripts
//! - `host` — spawn orchestration wired into the agent loop (see `agent::channel`)

pub mod context;
pub mod definition;
pub mod host;
pub mod registry;
pub mod types;
pub mod worktree;

pub use definition::{
    custom_subagents, CustomSubagent, BUILTIN_SUBAGENTS, DEFAULT_MAX_SUBAGENT_DEPTH,
};
pub use host::{SubagentHost, SubagentHostConfig, ToolPolicy};
pub use registry::SubagentRegistry;
pub use types::{
    completion_notice_text, SubagentCapabilityMode, SubagentIsolation, SubagentResult,
    SubagentSnapshot, SubagentSpawnRequest, SubagentStatus,
};
pub use worktree::WorktreeInfo;
