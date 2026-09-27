//! Agent runtime: the chat-task loop (`channel`), event stream (`events`),
//! and the external (ACP-style) runtime facade (`external`).

pub mod change_tracker;
pub mod channel;
pub mod events;
pub mod external;

// Re-export commonly used agent channel types for convenience
pub use channel::{spawn_chat_task, spawn_discovery_task, UserInbox};
pub use events::{AgentEvent, AgentTaskEvent, ApprovalSource};
pub use external::{ExternalAgentRuntime, ExternalRuntimeConfig, ExternalToolResult};
