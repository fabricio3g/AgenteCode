// ── Pairing ───────────────────────────────────────────────────────────
// Where the bridge keeps its state, and the one secret the browser needs.
//
// `bridge-token.json` holds the loopback port and a token; the extension
// pastes `port.token` once (the pairing code) and reuses it. Native
// messaging in a later phase replaces the paste, not the file.
//
// The MCP entry lives in the global `~/.agente/config.json` so every Agente
// surface — TUI, Desktop, daemon — picks the tools up without either side
// knowing about the other.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Loopback port the browser extension connects to.
pub const DEFAULT_PORT: u16 = 7391;

/// MCP server name: Agente prefixes tool names with it, so `browser_open`
/// reaches the model as `web_browser_open`.
pub const SERVER_NAME: &str = "web";

/// Everything the browser needs to reach this machine's bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pairing {
    pub port: u16,
    pub token: String,
}

impl Pairing {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            token: new_token(),
        }
    }

    /// `7391.4f9c…` — what the extension's connect box asks for.
    pub fn code(&self) -> String {
        format!("{}.{}", self.port, self.token)
    }

    /// Parse a pairing code pasted from the extension (or typed by a person).
    pub fn parse_code(code: &str) -> Option<Self> {
        let (port, token) = code.trim().split_once('.')?;
        let port: u16 = port.parse().ok()?;
        let token = token.trim();
        if token.len() < 16 || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
            return None;
        }
        Some(Self {
            port,
            token: token.to_string(),
        })
    }

    pub fn load() -> Option<Self> {
        Self::load_from(&token_path())
    }

    pub fn load_from(path: &Path) -> Option<Self> {
        let text = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Read the pairing, or create one and write it down.
    pub fn load_or_create() -> Result<Self> {
        Self::load_or_create_at(&token_path())
    }

    pub fn load_or_create_at(path: &Path) -> Result<Self> {
        if let Some(pairing) = Self::load_from(path) {
            return Ok(pairing);
        }
        let pairing = Self::new(DEFAULT_PORT);
        pairing.save_to(path)?;
        Ok(pairing)
    }

    pub fn save(&self) -> Result<()> {
        self.save_to(&token_path())
    }

    pub fn save_to(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(path, text).with_context(|| format!("writing {}", path.display()))?;
        restrict(path)?;
        Ok(())
    }
}

fn new_token() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("{a}{b}")
}

#[cfg(unix)]
fn restrict(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict(_path: &Path) -> Result<()> {
    Ok(())
}

/// `AGENTE_BRIDGE_DIR` redirects the whole bridge home so a test run never
/// touches the developer's real pairing (mirrors `AGENTE_CONFIG_DIR`).
pub fn state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("AGENTE_BRIDGE_DIR") {
        return PathBuf::from(dir);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".agente")
}

pub fn token_path() -> PathBuf {
    state_dir().join("bridge-token.json")
}

/// Files pulled out of Drive land here, content-addressed.
pub fn files_dir() -> PathBuf {
    state_dir().join("bridge").join("files")
}

/// Google OAuth client credentials, when the user brought their own.
pub fn settings_path() -> PathBuf {
    state_dir().join("bridge.json")
}

/// The user's own Google OAuth client (see `docs/GOOGLE_WORKSPACE.md`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub google_client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub google_client_secret: Option<String>,
}

impl Settings {
    pub fn load() -> Self {
        Self::load_from(&settings_path())
    }

    pub fn load_from(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<()> {
        self.save_to(&settings_path())
    }

    pub fn save_to(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        restrict(path)?;
        Ok(())
    }
}

/// Add the bridge as the `web` MCP server in a config file, keeping every
/// other key exactly as it was. Returns the path written.
pub fn install_mcp_entry(config_path: &Path, exe: &Path, tools: &str) -> Result<PathBuf> {
    let mut root = read_json_object(config_path)?;
    let mcp = root
        .as_object_mut()
        .expect("object")
        .entry("mcp")
        .or_insert_with(|| json!({}));
    if !mcp.is_object() {
        anyhow::bail!(
            "{} has a non-object \"mcp\" key — fix it by hand first",
            config_path.display()
        );
    }
    mcp.as_object_mut().expect("object").insert(
        SERVER_NAME.to_string(),
        json!({
            "type": "local",
            "command": exe.to_string_lossy(),
            "args": ["bridge"],
            "env": { "AGENTE_BRIDGE_TOOLS": tools },
        }),
    );
    write_json_object(config_path, &root)?;
    Ok(config_path.to_path_buf())
}

/// Remove the `web` MCP server again. `false` when it was not there.
pub fn remove_mcp_entry(config_path: &Path) -> Result<bool> {
    let mut root = read_json_object(config_path)?;
    let removed = root
        .get_mut("mcp")
        .and_then(Value::as_object_mut)
        .map(|mcp| mcp.remove(SERVER_NAME).is_some())
        .unwrap_or(false);
    if removed {
        write_json_object(config_path, &root)?;
    }
    Ok(removed)
}

fn read_json_object(path: &Path) -> Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => serde_json::from_str(&text)
            .with_context(|| format!("{} is not valid JSON", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

fn write_json_object(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// Which tool groups the bridge registers: `all` (default), `browser`,
/// `docs`. Set through the MCP entry's `env`, so a session that only wants
/// the tabs keeps its request prefix small.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolSet {
    pub browser: bool,
    pub documents: bool,
}

impl ToolSet {
    pub const ALL: Self = Self {
        browser: true,
        documents: true,
    };

    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "browser" => Self {
                browser: true,
                documents: false,
            },
            "docs" | "documents" => Self {
                browser: false,
                documents: true,
            },
            _ => Self::ALL,
        }
    }

    pub fn from_env() -> Self {
        std::env::var("AGENTE_BRIDGE_TOOLS")
            .map(|value| Self::parse(&value))
            .unwrap_or(Self::ALL)
    }

    pub fn label(self) -> &'static str {
        match (self.browser, self.documents) {
            (true, true) => "all",
            (true, false) => "browser",
            (false, true) => "docs",
            (false, false) => "none",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pairing_code_survives_a_round_trip() {
        let pairing = Pairing::new(7391);
        let code = pairing.code();
        assert!(code.starts_with("7391."));
        assert_eq!(Pairing::parse_code(&code).as_ref(), Some(&pairing));
        assert_eq!(
            Pairing::parse_code(&format!(" {code} ")).as_ref(),
            Some(&pairing)
        );
    }

    #[test]
    fn nonsense_codes_are_refused_instead_of_half_parsed() {
        assert!(Pairing::parse_code("").is_none());
        assert!(Pairing::parse_code("7391").is_none());
        assert!(Pairing::parse_code("nope.deadbeefdeadbeef").is_none());
        assert!(Pairing::parse_code("7391.short").is_none());
        assert!(Pairing::parse_code("7391.not a token at all!!").is_none());
        assert!(Pairing::parse_code("70000.deadbeefdeadbeefdead").is_none());
    }

    #[test]
    fn the_pairing_file_is_created_once_and_reused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bridge-token.json");
        let created = Pairing::load_or_create_at(&path).expect("create");
        let again = Pairing::load_or_create_at(&path).expect("reload");
        assert_eq!(created, again);
        assert!(path.exists());
    }

    #[test]
    fn installing_the_mcp_entry_keeps_the_rest_of_the_config() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"model":"x","mcp":{"other":{"command":"npx"}}}"#).expect("seed");
        install_mcp_entry(&path, Path::new("/usr/local/bin/agente"), "all").expect("install");
        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).expect("json");
        assert_eq!(value["model"], "x");
        assert_eq!(value["mcp"]["other"]["command"], "npx");
        assert_eq!(value["mcp"]["web"]["type"], "local");
        assert_eq!(value["mcp"]["web"]["command"], "/usr/local/bin/agente");
        assert_eq!(value["mcp"]["web"]["args"][0], "bridge");
        assert_eq!(value["mcp"]["web"]["env"]["AGENTE_BRIDGE_TOOLS"], "all");

        assert!(remove_mcp_entry(&path).expect("remove"));
        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).expect("json");
        assert!(value["mcp"].get("web").is_none());
        assert_eq!(value["mcp"]["other"]["command"], "npx");
        assert!(!remove_mcp_entry(&path).expect("second remove"));
    }

    #[test]
    fn installing_into_a_missing_file_writes_a_fresh_config() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("config.json");
        install_mcp_entry(&path, Path::new("agente"), "browser").expect("install");
        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).expect("json");
        assert_eq!(value["mcp"]["web"]["env"]["AGENTE_BRIDGE_TOOLS"], "browser");
    }

    #[test]
    fn a_broken_config_is_reported_not_overwritten() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{ not json").expect("seed");
        let error = install_mcp_entry(&path, Path::new("agente"), "all").unwrap_err();
        assert!(error.to_string().contains("not valid JSON"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn tool_sets_parse_from_the_environment_value() {
        assert_eq!(
            ToolSet::parse("browser"),
            ToolSet {
                browser: true,
                documents: false
            }
        );
        assert_eq!(
            ToolSet::parse(" DOCS "),
            ToolSet {
                browser: false,
                documents: true
            }
        );
        assert_eq!(ToolSet::parse("anything-else"), ToolSet::ALL);
        assert_eq!(ToolSet::ALL.label(), "all");
    }
}
