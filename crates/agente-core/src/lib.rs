#[cfg(feature = "execution")]
pub mod agent;
pub mod auth;
pub mod cancellation;
pub mod catalog;
pub mod config;
pub mod context;
pub mod extensions;
#[cfg(feature = "execution")]
pub mod goal;
pub mod llm;
#[cfg(feature = "execution")]
pub mod lsp;
pub mod mcp;
pub mod media;
pub mod models;
#[cfg(feature = "execution")]
pub mod permissions;
pub mod providers;
#[cfg(feature = "execution")]
pub mod sandbox;
#[cfg(feature = "execution")]
pub mod session;
#[cfg(feature = "execution")]
pub mod subagent;
pub mod thinking;
#[cfg(feature = "execution")]
pub mod todo;
#[cfg(feature = "execution")]
pub mod tools;
pub mod types;
pub mod util;

// Re-export commonly used types
pub use cancellation::{AbortController, AbortGuard, AbortSignal, CancellableScope};
pub use config::AppConfig;
pub use providers::{ModelInfo, Provider, ProviderRegistry};
pub use types::*;
