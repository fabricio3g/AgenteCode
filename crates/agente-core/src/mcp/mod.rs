//! Model Context Protocol client support, built on the official `rmcp` SDK.
//!
//! Servers come from the `mcp` map in `agente.json` (user or project) and
//! from a project's `.mcp.json` (the cross-client `mcpServers` format, which
//! needs the user's approval before it runs — a cloned repository must not
//! start processes on its own). Each server connects independently in the
//! background; a slow or dead server never delays a turn, and tool calls on
//! different servers (or the same one) run concurrently.
//!
//! Tool annotations drive permissions: a tool marked `readOnlyHint` runs
//! without approval and is available in Plan mode; anything else asks first
//! unless the server is configured with `trust: true`.

pub mod client;
pub mod tool_adapter;

use std::collections::HashMap;
use std::path::Path;

pub use client::{McpManager, ServerSnapshot, ServerStatus};
pub use tool_adapter::McpToolAdapter;

use crate::types::ToolDefinition;

/// Longest tool name every provider accepts (OpenAI caps at 64).
pub const MAX_TOOL_NAME: usize = 64;

/// One MCP server. Accepts both Agente's shape and the `.mcp.json` shape:
///
/// ```json
/// { "type": "local", "command": ["npx", "-y", "server"], "env": {} }
/// { "command": "npx", "args": ["-y", "server"] }
/// { "type": "remote", "url": "https://…/mcp", "headers": { "Authorization": "Bearer …" } }
/// { "type": "http", "url": "https://…/mcp" }
/// ```
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct McpConfig {
    /// `local`/`stdio` (spawn `command`) or `remote`/`http`/`streamable-http`
    /// (connect to `url`). Empty = inferred from `url`.
    #[serde(rename = "type", default, skip_serializing_if = "String::is_empty")]
    pub transport_type: String,
    #[serde(default, deserialize_with = "string_or_list")]
    pub command: Vec<String>,
    /// Extra arguments appended to `command` (the `.mcp.json` style).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Per-call timeout in milliseconds (default 120 s).
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Whether this server's read-only tools are offered in Plan mode.
    #[serde(default = "default_true")]
    pub plan_mode: bool,
    /// Run every tool from this server without asking (default: only tools
    /// the server marks read-only skip approval).
    #[serde(default)]
    pub trust: bool,
}

fn default_true() -> bool {
    true
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            transport_type: String::new(),
            command: Vec::new(),
            args: Vec::new(),
            url: None,
            env: HashMap::new(),
            headers: HashMap::new(),
            timeout: None,
            enabled: true,
            plan_mode: true,
            trust: false,
        }
    }
}

impl McpConfig {
    /// Whether this server is reached over HTTP rather than spawned.
    pub fn is_remote(&self) -> bool {
        match self.transport_type.to_ascii_lowercase().as_str() {
            "remote" | "http" | "streamable-http" | "streamable_http" | "sse" => true,
            "local" | "stdio" => false,
            _ => self.url.is_some() && self.command.is_empty(),
        }
    }

    /// Full argv: `command` followed by `args`.
    pub fn argv(&self) -> Vec<String> {
        self.command
            .iter()
            .chain(self.args.iter())
            .cloned()
            .collect()
    }

    /// One-line description for the UI (`npx -y server` / the URL).
    pub fn target(&self) -> String {
        if self.is_remote() {
            self.url.clone().unwrap_or_default()
        } else {
            self.argv().join(" ")
        }
    }

    /// Per-call timeout.
    pub fn call_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.timeout.unwrap_or(120_000).max(1_000))
    }
}

fn string_or_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum Either {
        One(String),
        Many(Vec<String>),
    }
    Ok(
        match <Option<Either> as serde::Deserialize>::deserialize(deserializer)? {
            None => Vec::new(),
            Some(Either::One(s)) if s.trim().is_empty() => Vec::new(),
            Some(Either::One(s)) => vec![s],
            Some(Either::Many(v)) => v,
        },
    )
}

/// Deserialize the `mcp` map leniently: `_comment` keys and entries that are
/// not server objects are skipped instead of failing the whole config.
pub fn lenient_server_map<'de, D>(deserializer: D) -> Result<HashMap<String, McpConfig>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw =
        <HashMap<String, serde_json::Value> as serde::Deserialize>::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .filter(|(name, value)| !name.starts_with('_') && value.is_object())
        .filter_map(|(name, value)| match serde_json::from_value(value) {
            Ok(config) => Some((name, config)),
            Err(e) => {
                tracing::warn!(server = %name, error = %e, "ignoring malformed MCP server config");
                None
            }
        })
        .collect())
}

/// Servers declared in `<project>/.mcp.json` (`{"mcpServers": {…}}`).
pub fn load_project_mcp_json(project_dir: &str) -> HashMap<String, McpConfig> {
    let path = Path::new(project_dir).join(".mcp.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    #[derive(serde::Deserialize)]
    struct File {
        #[serde(
            rename = "mcpServers",
            default,
            deserialize_with = "lenient_server_map"
        )]
        servers: HashMap<String, McpConfig>,
    }
    match serde_json::from_str::<File>(&text) {
        Ok(file) => file.servers,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "ignoring unreadable .mcp.json");
            HashMap::new()
        }
    }
}

/// Where a server was declared, which decides whether it needs approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerSource {
    /// `agente.json` (user or project): written by the user, runs directly.
    Config,
    /// The project's `.mcp.json`: runs once the user approves it.
    ProjectFile,
}

/// Approval key stored in `approved_mcp_servers` for a `.mcp.json` server.
pub fn approval_key(project_dir: &str, server: &str) -> String {
    let canonical = std::fs::canonicalize(project_dir)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| project_dir.to_string());
    format!("{canonical}::{server}")
}

/// A tool offered by a connected server.
#[derive(Debug, Clone)]
pub struct McpTool {
    /// Name on the server.
    pub name: String,
    pub server_name: String,
    /// Name the model sees: `server_tool`, sanitized and capped.
    pub full_name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    /// The server allows this tool in Plan mode (config `plan_mode`).
    pub plan_mode: bool,
    /// `readOnlyHint`: the tool does not modify its environment.
    pub read_only: bool,
    /// Every call is pre-approved (config `trust`).
    pub trusted: bool,
}

impl McpTool {
    pub fn to_tool_definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.full_name.clone(),
            description: self.description.clone(),
            parameters: self.input_schema.clone(),
        }
    }
}

/// `server_tool` with every character outside `[A-Za-z0-9_-]` replaced, cut
/// to [`MAX_TOOL_NAME`] (a short hash keeps cut names unique).
pub fn full_tool_name(server: &str, tool: &str) -> String {
    let sanitize = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    let name = format!("{}_{}", sanitize(server), sanitize(tool));
    if name.len() <= MAX_TOOL_NAME {
        return name;
    }
    use sha2::Digest;
    let digest = sha2::Sha256::digest(name.as_bytes());
    let suffix: String = digest.iter().take(3).map(|b| format!("{b:02x}")).collect();
    format!("{}_{suffix}", &name[..MAX_TOOL_NAME - suffix.len() - 1])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_config_shapes_parse() {
        let ours: McpConfig = serde_json::from_value(serde_json::json!({
            "type": "local", "command": ["npx", "-y", "srv"], "plan_mode": false
        }))
        .unwrap();
        assert_eq!(ours.argv(), ["npx", "-y", "srv"]);
        assert!(!ours.is_remote() && !ours.plan_mode && ours.enabled);

        let claude: McpConfig = serde_json::from_value(serde_json::json!({
            "command": "npx", "args": ["-y", "srv"], "env": {"K": "v"}
        }))
        .unwrap();
        assert_eq!(claude.argv(), ["npx", "-y", "srv"]);

        let http: McpConfig =
            serde_json::from_value(serde_json::json!({"type": "http", "url": "https://x/mcp"}))
                .unwrap();
        assert!(http.is_remote());
        let bare_url: McpConfig =
            serde_json::from_value(serde_json::json!({"url": "https://x/mcp"})).unwrap();
        assert!(bare_url.is_remote(), "a url alone means remote");
    }

    #[test]
    fn comment_keys_in_the_server_map_are_skipped() {
        #[derive(serde::Deserialize)]
        struct Holder {
            #[serde(deserialize_with = "lenient_server_map")]
            mcp: HashMap<String, McpConfig>,
        }
        let holder: Holder = serde_json::from_value(serde_json::json!({"mcp": {
            "_comment": "MCP servers extend the agent",
            "git": {"command": ["uvx", "mcp-server-git"]},
            "broken": {"command": 42}
        }}))
        .unwrap();
        assert_eq!(holder.mcp.keys().collect::<Vec<_>>(), ["git"]);
    }

    #[test]
    fn project_mcp_json_is_read() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers": {"fs": {"command": "npx", "args": ["srv", "."]}}}"#,
        )
        .unwrap();
        let servers = load_project_mcp_json(&dir.path().to_string_lossy());
        assert_eq!(servers["fs"].argv(), ["npx", "srv", "."]);
    }

    #[test]
    fn tool_names_are_sanitized_and_capped() {
        assert_eq!(
            full_tool_name("my.server", "read file"),
            "my_server_read_file"
        );
        let long = full_tool_name(&"s".repeat(40), &"t".repeat(40));
        assert_eq!(long.len(), MAX_TOOL_NAME);
        assert_ne!(long, full_tool_name(&"s".repeat(40), &"u".repeat(40)));
    }
}
