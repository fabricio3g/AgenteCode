//! Subagent system: spawn, run, track, and resume child agents.
//!
//! - `types` — `task` tool input schema, snapshots, results, events
//! - `definition` — subagents the parent creates from a role, the user's own
//!   `.agente/agents/*.md`, capability modes, tool filtering
//! - `routing` — which model a child runs on (the parent's pick from the
//!   user's model list, an agent file's preference, the default model)
//! - `context` — child context forking + completion summaries
//! - `registry` — running/completed subagent tracking + resume transcripts
//! - `host` — spawn orchestration wired into the agent loop (see `agent::channel`)

pub mod context;
pub mod definition;
pub mod host;
pub mod registry;
pub mod routing;
pub mod types;
pub mod worktree;

pub use definition::{
    custom_subagents, find_agent, AgentDefinition, DEFAULT_MAX_SUBAGENT_DEPTH,
};
pub use host::{SubagentHost, SubagentHostConfig, ToolPolicy};
pub use registry::SubagentRegistry;
pub use types::{
    completion_notice_text, SubagentCapabilityMode, SubagentIsolation, SubagentResult,
    SubagentSnapshot, SubagentSpawnRequest, SubagentStatus,
};
pub use worktree::WorktreeInfo;
