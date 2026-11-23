//! Agent runtime: the chat-task loop (`channel`) and event stream (`events`).

pub mod channel;
pub mod events;

// Re-export commonly used agent channel types for convenience
pub use channel::{spawn_chat_task, spawn_discovery_task, TurnTools, UserInbox};
pub use events::{AgentEvent, AgentTaskEvent, ApprovalSource};
