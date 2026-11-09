//! MCP services owned by one Desktop connection, separate from project tools.

use std::collections::HashMap;
use std::sync::Arc;

use agente_core::mcp::{McpConfig, McpManager, McpTool, ServerStatus};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::task::JoinHandle;

pub(crate) const TOOL_PREFIX: &str = "complement_";

#[derive(Default)]
pub(crate) struct Complements(HashMap<String, Server>);

struct Server {
    config: ComplementConfig,
    manager: Arc<McpManager>,
    connecting: JoinHandle<()>,
}

#[derive(Deserialize, PartialEq)]
pub(crate) struct ComplementConfig {
    pub name: String,
    pub mcp: McpConfig,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.connecting.abort();
        self.manager.disconnect_all();
    }
}

impl Complements {
    pub(crate) fn sync(&mut self, configs: HashMap<String, ComplementConfig>, retry: Option<&str>) {
        self.0.retain(|id, server| {
            Some(&server.config) == configs.get(id) && retry != Some(id.as_str())
        });
        for (id, config) in configs {
            self.0.entry(id.clone()).or_insert_with(|| {
                let mut manager = McpManager::new();
                manager.add_client(format!("{TOOL_PREFIX}{id}"), config.mcp.clone());
                let manager = Arc::new(manager);
                let connecting = tokio::spawn({
                    let manager = manager.clone();
                    async move { manager.connect_all().await }
                });
                Server {
                    config,
                    manager,
                    connecting,
                }
            });
        }
    }

    pub(crate) fn status(&self) -> Value {
        Value::Object(
            self.0
                .iter()
                .filter_map(|(id, server)| {
                    let snapshot = server.manager.snapshots().pop()?;
                    let status = match snapshot.status {
                        ServerStatus::Ready => "connected",
                        ServerStatus::Connecting => "connecting",
                        ServerStatus::Disabled => "disabled",
                        _ => "failed",
                    };
                    let tool_names: Vec<_> = server.manager.tools().into_iter().map(|tool| tool.name).collect();
                    Some((id.clone(), json!({ "status": status, "tools": tool_names.len(), "toolNames": tool_names })))
                })
                .collect(),
        )
    }

    pub(crate) fn managers(&self) -> Vec<Arc<McpManager>> {
        self.0
            .values()
            .map(|server| server.manager.clone())
            .collect()
    }

    pub(crate) fn waiting_for_first_connection(&self) -> bool {
        let statuses: Vec<_> = self
            .0
            .values()
            .flat_map(|server| server.manager.snapshots())
            .map(|snapshot| snapshot.status)
            .collect();
        statuses.contains(&ServerStatus::Connecting) && !statuses.contains(&ServerStatus::Ready)
    }

    pub(crate) fn tools(&self) -> Vec<(McpTool, Arc<McpManager>)> {
        let mut tools: Vec<_> = self
            .0
            .values()
            .flat_map(|server| {
                server.manager.tools().into_iter().map(|mut tool| {
                    tool.description = format!("{} — {}", server.config.name, tool.description);
                    (tool, server.manager.clone())
                })
            })
            .collect();
        tools.sort_by(|(a, _), (b, _)| a.full_name.cmp(&b.full_name));
        tools
    }
}
