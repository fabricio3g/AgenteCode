//! Driver instance configuration, profile inheritance (`extends`), and atomic persistence.
//!
//! Configuration lives in `~/.agente/drivers.json` (or `$AGENTE_CONFIG_DIR/drivers.json`).
//! Users can override built-in instances (`claude`, `codex`) or define custom profiles
//! and ACP commands using `extends`.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use agente_protocol::{DriverInstanceConfig, DriverKind, DriverModel, TurnMode};
use serde::{Deserialize, Serialize};

use crate::{DriverError, BUILTIN_AGENTE_INSTANCE};

/// Persisted driver instance configuration file (`drivers.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriversConfig {
    #[serde(default)]
    pub instances: BTreeMap<String, DriverInstanceConfig>,
}

/// Fully resolved configuration for one driver instance after walking `extends`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedInstance {
    pub instance_id: String,
    pub driver_kind: DriverKind,
    pub label: String,
    pub command: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub strip_env: Vec<String>,
    pub models: Vec<DriverModel>,
    pub default_mode: Option<TurnMode>,
    pub use_for: Option<String>,
    pub enabled: bool,
    pub builtin: bool,
}

/// Path to `drivers.json` under `AGENTE_CONFIG_DIR` or `~/.agente`.
pub fn config_path() -> Option<PathBuf> {
    let dir = std::env::var_os("AGENTE_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".agente")))?;
    Some(dir.join("drivers.json"))
}

/// Validate a custom driver instance ID.
pub fn validate_instance_id(id: &str) -> Result<(), DriverError> {
    if id.is_empty() || id.len() > 64 {
        return Err(DriverError::InvalidConfig(
            "instance id must be 1..=64 characters".into(),
        ));
    }
    if id == BUILTIN_AGENTE_INSTANCE {
        return Err(DriverError::InvalidConfig(
            "cannot overwrite built-in 'agente' instance".into(),
        ));
    }
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return Err(DriverError::InvalidConfig("empty instance id".into()));
    };
    if !first.is_ascii_lowercase()
        || !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(DriverError::InvalidConfig(format!(
            "instance id '{id}' must start with a lowercase letter and contain only [a-z0-9-]"
        )));
    }
    Ok(())
}

impl DriversConfig {
    pub fn load() -> Self {
        let Some(path) = config_path() else {
            return Self::default();
        };
        Self::load_from(&path).unwrap_or_default()
    }

    pub fn load_from(path: &Path) -> Result<Self, DriverError> {
        match fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str(&raw).map_err(|error| {
                DriverError::InvalidConfig(format!("failed to parse {}: {error}", path.display()))
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(DriverError::Io(error)),
        }
    }

    pub fn save_to(&self, path: &Path) -> Result<(), DriverError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_string_pretty(self)
            .map_err(|error| DriverError::InvalidConfig(error.to_string()))?;
        let tmp = path.with_extension(format!("json.tmp.{}", uuid::Uuid::new_v4().simple()));
        fs::write(&tmp, body)?;
        if let Err(error) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp);
            return Err(DriverError::Io(error));
        }
        Ok(())
    }

    /// Resolve all built-in external instances and user-configured instances,
    /// walking `extends` chains with cycle detection.
    pub fn resolve_all(&self) -> Result<Vec<ResolvedInstance>, DriverError> {
        let defaults = builtin_external_defaults();
        let mut combined: BTreeMap<String, DriverInstanceConfig> = BTreeMap::new();
        for (id, cfg) in &defaults {
            combined.insert((*id).to_string(), cfg.clone());
        }
        for (id, cfg) in &self.instances {
            if let Some(base) = combined.get(id).cloned() {
                combined.insert(id.clone(), merge_override(&base, cfg));
            } else {
                combined.insert(id.clone(), cfg.clone());
            }
        }

        let mut resolved = Vec::with_capacity(combined.len());
        for id in combined.keys() {
            let mut visiting = HashSet::new();
            resolved.push(resolve_one(id, &combined, &defaults, &mut visiting)?);
        }
        Ok(resolved)
    }
}

fn builtin_external_defaults() -> BTreeMap<&'static str, DriverInstanceConfig> {
    let mut map = BTreeMap::new();
    let entries: &[(&str, DriverKind, &str, &[&str], &str)] = &[
        (
            "claude",
            DriverKind::Claude,
            "Claude Code",
            &["claude"],
            "Complex codebases, deep refactors, and interactive tool-gated coding via Claude CLI.",
        ),
        (
            "codex",
            DriverKind::Codex,
            "Codex",
            &["codex"],
            "Sandboxed coding, multi-step edits, and fast turn steering via Codex CLI.",
        ),
        (
            "opencode",
            DriverKind::OpenCode,
            "OpenCode",
            &["opencode", "acp"],
            "Multi-provider terminal coding agent with ACP support and configured local/cloud models.",
        ),
        (
            "pi",
            DriverKind::Pi,
            "Pi",
            &["pi", "--mode", "rpc"],
            "Extensible minimal coding agent harness with RPC streaming, steering, and multi-provider models.",
        ),
        (
            "copilot",
            DriverKind::Acp,
            "GitHub Copilot",
            &["copilot", "--acp", "--stdio"],
            "GitHub Copilot CLI agent running natively over ACP.",
        ),
        (
            "gemini",
            DriverKind::Acp,
            "Gemini CLI",
            &["gemini", "--acp"],
            "Google Gemini CLI coding agent via native ACP.",
        ),
        (
            "qwen",
            DriverKind::Acp,
            "Qwen Code",
            &["qwen", "--acp"],
            "Qwen Code terminal agent via native ACP.",
        ),
        (
            "cursor",
            DriverKind::Acp,
            "Cursor Agent",
            &["cursor-agent", "acp"],
            "Cursor CLI coding agent via native ACP.",
        ),
        (
            "goose",
            DriverKind::Acp,
            "Goose",
            &["goose", "acp"],
            "Open-source extensible developer agent via native ACP.",
        ),
        (
            "cline",
            DriverKind::Acp,
            "Cline",
            &["cline", "--acp"],
            "Autonomous coding CLI agent via native ACP.",
        ),
        (
            "kilo",
            DriverKind::Acp,
            "Kilo Code",
            &["kilo", "acp"],
            "Kilo CLI coding agent via native ACP.",
        ),
        (
            "kimi",
            DriverKind::Acp,
            "Kimi Code",
            &["kimi", "acp"],
            "Moonshot Kimi Code CLI via native ACP.",
        ),
        (
            "auggie",
            DriverKind::Acp,
            "Auggie CLI",
            &["auggie", "--acp"],
            "Augment Auggie coding agent via native ACP.",
        ),
        (
            "kiro",
            DriverKind::Acp,
            "Kiro CLI",
            &["kiro-cli", "acp"],
            "AWS Kiro CLI coding agent via native ACP.",
        ),
        (
            "droid",
            DriverKind::Acp,
            "Factory Droid",
            &["droid", "exec", "--output-format", "acp-daemon"],
            "Factory Droid CLI coding agent via native ACP.",
        ),
        (
            "vibe",
            DriverKind::Acp,
            "Mistral Vibe",
            &["vibe-acp"],
            "Mistral Vibe coding agent via native ACP.",
        ),
        (
            "amp",
            DriverKind::Acp,
            "Amp",
            &["amp-acp"],
            "Sourcegraph Amp coding agent via ACP.",
        ),
        (
            "grok",
            DriverKind::Acp,
            "Grok Build",
            &["grok", "agent", "stdio"],
            "Grok Build CLI agent over ACP stdio.",
        ),
        (
            "junie",
            DriverKind::Acp,
            "Junie",
            &["junie", "--acp=true"],
            "JetBrains Junie CLI coding agent via ACP.",
        ),
        (
            "devin",
            DriverKind::Acp,
            "Devin",
            &["devin", "acp"],
            "Devin CLI coding agent via native ACP.",
        ),
        (
            "qoder",
            DriverKind::Acp,
            "Qoder CLI",
            &["qodercli", "--acp"],
            "Qoder CLI coding agent via native ACP.",
        ),
    ];

    for (id, kind, label, cmd, use_for) in entries {
        map.insert(
            *id,
            DriverInstanceConfig {
                driver_kind: Some(*kind),
                label: Some((*label).to_string()),
                command: cmd.iter().map(|s| (*s).to_string()).collect(),
                use_for: Some((*use_for).to_string()),
                ..DriverInstanceConfig::default()
            },
        );
    }
    map
}

/// Terminal sign-in guidance surfaced only when a built-in CLI reports `NeedsAuth`.
pub fn default_auth_hint(instance_id: &str) -> Option<&'static str> {
    match instance_id {
        "claude" => Some("Run `claude auth login` in your terminal to sign in."),
        "codex" => Some("Run `codex login` in your terminal to sign in."),
        "opencode" => Some("Run `opencode auth login` (or configure a provider) in your terminal."),
        "pi" => Some("Run `pi` and use `/login` (or configure an API key) to enable models."),
        "copilot" => Some("Run `copilot login` (or `gh auth login`) in your terminal to sign in."),
        "gemini" => Some("Run `gemini` in your terminal and complete Google/API-key sign-in."),
        "qwen" => Some("Run `qwen` in your terminal to sign in with Qwen OAuth or an API key."),
        "cursor" => Some("Run `cursor-agent login` (or set `CURSOR_API_KEY`) to sign in."),
        "goose" => Some("Run `goose configure` in your terminal to set up a provider."),
        "cline" => Some("Run `cline auth` in your terminal to configure your provider."),
        "kilo" => Some("Run `kilo auth` in your terminal to configure your provider."),
        "kimi" => Some("Run `kimi` and complete login in your terminal."),
        "auggie" => Some("Run `auggie login` in your terminal to sign in."),
        "kiro" => Some("Run `kiro-cli login` in your terminal to sign in."),
        "droid" => Some("Run `droid` in your terminal to sign in."),
        "vibe" => Some("Configure `MISTRAL_API_KEY` or sign in via `vibe`."),
        "amp" => Some("Run `amp login` in your terminal to sign in."),
        "grok" => Some("Configure your Grok credentials in the `grok` CLI."),
        "junie" => Some("Sign in via the `junie` CLI in your terminal."),
        "devin" => Some("Authenticate your `devin` CLI session in your terminal."),
        "qoder" => Some("Run `qodercli` in your terminal to sign in."),
        _ => None,
    }
}

fn merge_override(
    base: &DriverInstanceConfig,
    overlay: &DriverInstanceConfig,
) -> DriverInstanceConfig {
    let mut env = base.env.clone();
    for (k, v) in &overlay.env {
        env.insert(k.clone(), v.clone());
    }
    let mut strip_env = base.strip_env.clone();
    for var in &overlay.strip_env {
        if !strip_env.contains(var) {
            strip_env.push(var.clone());
        }
    }
    let mut command = if overlay.command.is_empty() {
        base.command.clone()
    } else {
        overlay.command.clone()
    };
    if !overlay.args.is_empty() {
        command.extend(overlay.args.iter().cloned());
    } else if overlay.command.is_empty() && !base.args.is_empty() {
        command.extend(base.args.iter().cloned());
    }
    DriverInstanceConfig {
        extends: overlay.extends.clone().or_else(|| base.extends.clone()),
        driver_kind: overlay.driver_kind.or(base.driver_kind),
        label: overlay.label.clone().or_else(|| base.label.clone()),
        command,
        args: Vec::new(),
        env,
        strip_env,
        models: if overlay.models.is_empty() {
            base.models.clone()
        } else {
            overlay.models.clone()
        },
        default_mode: overlay.default_mode.or(base.default_mode),
        use_for: overlay.use_for.clone().or_else(|| base.use_for.clone()),
        enabled: overlay.enabled,
    }
}

fn resolve_one(
    id: &str,
    all: &BTreeMap<String, DriverInstanceConfig>,
    defaults: &BTreeMap<&'static str, DriverInstanceConfig>,
    visiting: &mut HashSet<String>,
) -> Result<ResolvedInstance, DriverError> {
    if !visiting.insert(id.to_string()) {
        return Err(DriverError::InvalidConfig(format!(
            "cycle in driver extends chain involving '{id}'"
        )));
    }
    let cfg = all
        .get(id)
        .ok_or_else(|| DriverError::NotFound(id.to_string()))?;

    let resolved = if let Some(parent_id) = cfg.extends.as_deref() {
        if parent_id == "acp" {
            build_leaf(id, cfg, Some(DriverKind::Acp), defaults.contains_key(id))
        } else {
            let parent = resolve_one(parent_id, all, defaults, visiting)?;
            let mut env = parent.env;
            for (k, v) in &cfg.env {
                env.insert(k.clone(), v.clone());
            }
            let mut strip_env = parent.strip_env;
            for var in &cfg.strip_env {
                if !strip_env.contains(var) {
                    strip_env.push(var.clone());
                }
            }
            let mut command = if cfg.command.is_empty() {
                parent.command
            } else {
                cfg.command.clone()
            };
            command.extend(cfg.args.iter().cloned());
            ResolvedInstance {
                instance_id: id.to_string(),
                driver_kind: cfg.driver_kind.unwrap_or(parent.driver_kind),
                label: cfg.label.clone().unwrap_or_else(|| id.to_string()),
                command,
                env,
                strip_env,
                models: if cfg.models.is_empty() {
                    parent.models
                } else {
                    cfg.models.clone()
                },
                default_mode: cfg.default_mode.or(parent.default_mode),
                use_for: cfg.use_for.clone().or(parent.use_for),
                enabled: cfg.enabled,
                builtin: defaults.contains_key(id),
            }
        }
    } else {
        build_leaf(id, cfg, None, defaults.contains_key(id))
    };

    visiting.remove(id);
    if resolved.command.is_empty() {
        return Err(DriverError::InvalidConfig(format!(
            "driver instance '{id}' has no executable command"
        )));
    }
    Ok(resolved)
}

fn build_leaf(
    id: &str,
    cfg: &DriverInstanceConfig,
    fallback_kind: Option<DriverKind>,
    builtin: bool,
) -> ResolvedInstance {
    let mut command = cfg.command.clone();
    command.extend(cfg.args.iter().cloned());
    let driver_kind = cfg.driver_kind.or(fallback_kind).unwrap_or(DriverKind::Acp);
    ResolvedInstance {
        instance_id: id.to_string(),
        driver_kind,
        label: cfg.label.clone().unwrap_or_else(|| id.to_string()),
        command,
        env: cfg.env.clone(),
        strip_env: cfg.strip_env.clone(),
        models: cfg.models.clone(),
        default_mode: cfg.default_mode,
        use_for: cfg.use_for.clone(),
        enabled: cfg.enabled,
        builtin,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extends_inherits_command_env_and_strips_credentials() {
        let mut cfg = DriversConfig::default();
        cfg.instances.insert(
            "claude-work".into(),
            DriverInstanceConfig {
                extends: Some("claude".into()),
                label: Some("Claude (Work)".into()),
                env: BTreeMap::from([("CLAUDE_CONFIG_DIR".into(), "/tmp/claude-work".into())]),
                strip_env: vec!["ANTHROPIC_API_KEY".into()],
                use_for: Some("Work repository changes".into()),
                ..DriverInstanceConfig::default()
            },
        );
        let list = cfg.resolve_all().unwrap();
        let work = list
            .iter()
            .find(|i| i.instance_id == "claude-work")
            .unwrap();
        assert_eq!(work.driver_kind, DriverKind::Claude);
        assert_eq!(work.command, vec!["claude"]);
        assert_eq!(
            work.env.get("CLAUDE_CONFIG_DIR").unwrap(),
            "/tmp/claude-work"
        );
        assert_eq!(work.strip_env, vec!["ANTHROPIC_API_KEY"]);
        assert!(!work.builtin);
    }

    #[test]
    fn extends_acp_creates_custom_acp_instance() {
        let mut cfg = DriversConfig::default();
        cfg.instances.insert(
            "gemini".into(),
            DriverInstanceConfig {
                extends: Some("acp".into()),
                label: Some("Gemini CLI".into()),
                command: vec!["gemini".into()],
                args: vec!["--acp".into()],
                ..DriverInstanceConfig::default()
            },
        );
        let list = cfg.resolve_all().unwrap();
        let gemini = list.iter().find(|i| i.instance_id == "gemini").unwrap();
        assert_eq!(gemini.driver_kind, DriverKind::Acp);
        assert_eq!(gemini.command, vec!["gemini", "--acp"]);
    }

    #[test]
    fn cycle_in_extends_is_rejected() {
        let mut cfg = DriversConfig::default();
        cfg.instances.insert(
            "a".into(),
            DriverInstanceConfig {
                extends: Some("b".into()),
                command: vec!["a".into()],
                ..DriverInstanceConfig::default()
            },
        );
        cfg.instances.insert(
            "b".into(),
            DriverInstanceConfig {
                extends: Some("a".into()),
                command: vec!["b".into()],
                ..DriverInstanceConfig::default()
            },
        );
        let err = cfg.resolve_all().unwrap_err();
        assert!(err.to_string().contains("cycle"));
    }

    #[test]
    fn instance_id_validation_guards_builtin_and_format() {
        assert!(validate_instance_id("agente").is_err());
        assert!(validate_instance_id("BadName").is_err());
        assert!(validate_instance_id("1bad").is_err());
        assert!(validate_instance_id("claude-work-2").is_ok());
    }
}
