//! ACP v1 (Agent Client Protocol) adapter: JSON-RPC 2.0 over stdio in front of
//! the in-process runtime.
//!
//! Wire rules (one JSON object per line):
//!
//! - **request** (`id` + `method`) — answered with a result or an error object
//!   carrying the original id (`initialize`, `session/new`, `session/prompt`, …).
//! - **notification** (no `id`) — never answered (`initialized`,
//!   `session/cancel`).
//! - **response** (`id`, no `method`) — the client's answer to an agent-issued
//!   request such as `session/request_permission`.
//!
//! Per-message failures never terminate the loop: malformed lines are answered
//! with a `-32700`/`-32600` error (`id: null`) and the connection continues.
//! Only a closed stdio ends [`serve_stdio`].
//!
//! Turn flow: `session/prompt` starts a runtime turn and its response —
//! `{"stopReason": "end_turn" | "cancelled"}` — is delivered once the turn's
//! terminal event arrives on the event stream, after the `session/update`
//! notifications it produced. Runtime approvals surface as
//! `session/request_permission` requests keyed by a generated JSON-RPC id whose
//! response is routed back to the runtime's approval broker.

pub use agente_protocol::rpc;
mod server;
mod updates;

use agente_runtime::RuntimeHandle;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AcpError {
    #[error("stdio failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("frame serialization failed: {0}")]
    Json(#[from] serde_json::Error),
}

/// Serve ACP v1 over stdio until stdin closes.
pub async fn serve_stdio(runtime: RuntimeHandle) -> Result<(), AcpError> {
    server::serve_over(runtime, tokio::io::stdin(), tokio::io::stdout()).await
}
