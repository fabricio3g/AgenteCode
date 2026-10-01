//! Agent channel: the chat-task loop and its supporting modules.
//!
//! Split by responsibility:
//! - [`config`]    — shared types (`AgentRunConfig`, `ToolCallOutcome`) + event senders
//! - [`args`]      — tool-argument parsing, aliasing, malformed-arg salvage
//! - [`approval`]  — approval-request construction, missing-arg validation
//! - [`execute`]   — tool execution pipeline and batch strategies
//! - [`retry`]     — retryability classification + backoff wait
//! - [`errors`]    — error categorization for user-facing messages
//! - [`discovery`] — background model discovery task
//! - [`loop_`]     — `spawn_chat_task` + `run_agent_loop` (the turn itself)
//! - [`loop_detection`] — identical-tool-call ("action stationarity") detector

mod approval;
mod args;
mod config;
mod discovery;
mod errors;
mod execute;
mod loop_;
pub(crate) mod loop_detection;
mod progress;
mod retry;

pub use config::{TurnTools, UserInbox};
pub use discovery::spawn_discovery_task;
pub use loop_::spawn_chat_task;

pub(crate) use config::AgentRunConfig;
pub(crate) use config::ToolCallOutcome;
pub(crate) use loop_::run_agent_loop;
