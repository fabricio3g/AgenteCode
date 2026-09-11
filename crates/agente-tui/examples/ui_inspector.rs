//! Interactive TUI Web Inspector & Debugger Runner
//!
//! Run with:
//!   cargo run --example ui_inspector

use agente_tui::web_inspector::InspectorServer;
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let server = Arc::new(InspectorServer::new());
    server.run(4040).await
}
