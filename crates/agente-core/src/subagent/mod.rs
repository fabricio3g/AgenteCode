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

pub use context::{completion_summary, fork_subagent_context};
pub use definition::{
    builtin_subagent, custom_subagents, filter_tool_definitions, resolve_effective_config,
    tool_allowed_by_capability, BuiltinSubagent, CustomSubagent, EffectiveRuntimeConfig,
    SubagentParentDefaults, BUILTIN_SUBAGENTS, DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    DEFAULT_MAX_SUBAGENT_DEPTH, DEFAULT_SUBAGENT_SUMMARY_CAP, DEFAULT_SUBAGENT_TIMEOUT_MS,
    EXPLORE_PROMPT, EXPLORE_TOOLS, GENERAL_PURPOSE_PROMPT, GENERAL_PURPOSE_TOOLS, PLAN_PROMPT,
    PLAN_TOOLS,
};
pub use host::{SubagentHost, SubagentHostConfig, ToolPolicy};
pub use registry::{bound_conversation, QueuedSpawn, SubagentRegistry, MAX_RESUME_MESSAGES};
pub use types::{
    completion_notice_text, SubagentCapabilityMode, SubagentIsolation, SubagentResult,
    SubagentSnapshot, SubagentSpawnRequest, SubagentStatus, SubagentType,
};
pub use worktree::WorktreeInfo;
