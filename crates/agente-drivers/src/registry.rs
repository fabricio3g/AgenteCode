//! Driver registry: resolves built-in + custom instances and caches probe results.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use agente_protocol::{DriverInfo, DriverInstanceConfig, DriverKind};

use crate::acp::AcpDriver;
use crate::claude::ClaudeDriver;
use crate::codex::CodexDriver;
use crate::config::{config_path, validate_instance_id, DriversConfig, ResolvedInstance};
use crate::pi::PiDriver;
use crate::{builtin_agente_info, AgentDriver, DriverError, BUILTIN_AGENTE_INSTANCE};

/// Registry of built-in and user-configured coding-CLI driver instances.
pub struct DriverRegistry {
    config_path: Option<PathBuf>,
    config: RwLock<DriversConfig>,
    drivers: RwLock<BTreeMap<String, Arc<dyn AgentDriver>>>,
    cached_probes: RwLock<HashMap<String, DriverInfo>>,
}

impl DriverRegistry {
    /// Load from `~/.agente/drivers.json` (or `$AGENTE_CONFIG_DIR/drivers.json`).
    pub fn load_default() -> Self {
        let path = config_path();
        let cfg = path
            .as_deref()
            .and_then(|p| DriversConfig::load_from(p).ok())
            .unwrap_or_default();
        Self::new(cfg, path)
    }

    pub fn new(config: DriversConfig, config_path: Option<PathBuf>) -> Self {
        let drivers = build_drivers(&config).unwrap_or_default();
        Self {
            config_path,
            config: RwLock::new(config),
            drivers: RwLock::new(drivers),
            cached_probes: RwLock::new(HashMap::new()),
        }
    }

    /// Inject a custom or mock driver instance (intended for tests and extensions).
    pub fn register_driver(&self, driver: Arc<dyn AgentDriver>) {
        let id = driver.instance_id().to_string();
        self.cached_probes
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        self.drivers
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, driver);
    }

    pub fn get(&self, instance_id: &str) -> Option<Arc<dyn AgentDriver>> {
        self.drivers
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(instance_id)
            .cloned()
    }

    fn attach_saved_config(&self, info: &mut DriverInfo) {
        let cfg = self
            .config
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .instances
            .get(&info.instance_id)
            .cloned();
        info.config = cfg;
    }

    /// Fast synchronous descriptors (built-in `agente` first, then configured instances),
    /// merging any previously cached probe metadata without spawning subprocesses.
    pub fn list_descriptors(&self) -> Vec<DriverInfo> {
        let mut out = vec![builtin_agente_info()];
        let map = self.drivers.read().unwrap_or_else(|p| p.into_inner());
        let cache = self.cached_probes.read().unwrap_or_else(|p| p.into_inner());
        for (id, driver) in map.iter() {
            let mut info = if let Some(cached) = cache.get(id) {
                cached.clone()
            } else {
                driver.descriptor()
            };
            self.attach_saved_config(&mut info);
            out.push(info);
        }
        out
    }

    /// Passively probe every registered driver concurrently and cache results.
    pub async fn probe_all(&self) -> Vec<DriverInfo> {
        let list: Vec<Arc<dyn AgentDriver>> = self
            .drivers
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect();
        let mut handles = Vec::with_capacity(list.len());
        for driver in list {
            handles.push(tokio::spawn(async move { driver.probe().await }));
        }
        let mut out = vec![builtin_agente_info()];
        let mut probed_entries = Vec::with_capacity(handles.len());
        for handle in handles {
            if let Ok(mut info) = handle.await {
                self.attach_saved_config(&mut info);
                probed_entries.push(info.clone());
                out.push(info);
            }
        }
        {
            let mut cache = self.cached_probes.write().unwrap_or_else(|p| p.into_inner());
            for info in probed_entries {
                cache.insert(info.instance_id.clone(), info);
            }
        }
        out
    }

    pub async fn probe(&self, instance_id: &str) -> Result<DriverInfo, DriverError> {
        if instance_id == BUILTIN_AGENTE_INSTANCE {
            return Ok(builtin_agente_info());
        }
        let driver = self
            .get(instance_id)
            .ok_or_else(|| DriverError::NotFound(instance_id.to_string()))?;
        let mut info = driver.probe().await;
        self.attach_saved_config(&mut info);
        self.cached_probes
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(info.instance_id.clone(), info.clone());
        Ok(info)
    }

    /// Validate, persist, and activate a new or updated driver instance profile.
    pub fn save_instance(
        &self,
        instance_id: String,
        cfg: DriverInstanceConfig,
    ) -> Result<DriverInfo, DriverError> {
        validate_instance_id(&instance_id)?;
        let mut next = self.config.read().unwrap_or_else(|p| p.into_inner()).clone();
        next.instances.insert(instance_id.clone(), cfg);
        let rebuilt = build_drivers(&next)?;
        if let Some(path) = &self.config_path {
            next.save_to(path)?;
        }
        let mut info = rebuilt
            .get(&instance_id)
            .map(|d| d.descriptor())
            .ok_or(DriverError::NotFound(instance_id))?;
        *self.config.write().unwrap_or_else(|p| p.into_inner()) = next;
        *self.drivers.write().unwrap_or_else(|p| p.into_inner()) = rebuilt;
        self.cached_probes
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        self.attach_saved_config(&mut info);
        Ok(info)
    }

    /// Delete a custom driver instance (or user override of a built-in external driver).
    pub fn delete_instance(&self, instance_id: &str) -> Result<bool, DriverError> {
        if instance_id == BUILTIN_AGENTE_INSTANCE {
            return Err(DriverError::InvalidConfig(
                "cannot delete built-in 'agente' instance".into(),
            ));
        }
        let mut next = self.config.read().unwrap_or_else(|p| p.into_inner()).clone();
        let removed = next.instances.remove(instance_id).is_some();
        if !removed {
            return Ok(false);
        }
        let rebuilt = build_drivers(&next)?;
        if let Some(path) = &self.config_path {
            next.save_to(path)?;
        }
        *self.config.write().unwrap_or_else(|p| p.into_inner()) = next;
        *self.drivers.write().unwrap_or_else(|p| p.into_inner()) = rebuilt;
        self.cached_probes
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        Ok(true)
    }
}

fn build_drivers(
    config: &DriversConfig,
) -> Result<BTreeMap<String, Arc<dyn AgentDriver>>, DriverError> {
    let instances = config.resolve_all()?;
    let mut map: BTreeMap<String, Arc<dyn AgentDriver>> = BTreeMap::new();
    for resolved in instances {
        let id = resolved.instance_id.clone();
        if let Some(driver) = instantiate_driver(resolved)? {
            map.insert(id, driver);
        }
    }
    Ok(map)
}

fn instantiate_driver(
    instance: ResolvedInstance,
) -> Result<Option<Arc<dyn AgentDriver>>, DriverError> {
    match instance.driver_kind {
        DriverKind::Agente => Ok(None),
        DriverKind::Claude => Ok(Some(Arc::new(ClaudeDriver::new(instance)))),
        DriverKind::Codex => Ok(Some(Arc::new(CodexDriver::new(instance)))),
        DriverKind::Acp | DriverKind::OpenCode => Ok(Some(Arc::new(AcpDriver::new(instance)))),
        DriverKind::Pi => Ok(Some(Arc::new(PiDriver::new(instance)))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ApprovalRouter, DriverSession, DriverSessionOpen};
    use agente_protocol::{DriverCapabilities, DriverModel, DriverStatus};
    use async_trait::async_trait;
    use std::collections::BTreeMap;

    struct MockDriver {
        id: String,
        kind: DriverKind,
        probed_version: String,
    }

    #[async_trait]
    impl AgentDriver for MockDriver {
        fn instance_id(&self) -> &str {
            &self.id
        }

        fn driver_kind(&self) -> DriverKind {
            self.kind
        }

        fn descriptor(&self) -> DriverInfo {
            DriverInfo {
                instance_id: self.id.clone(),
                driver_kind: self.kind,
                label: "Mock Driver".into(),
                status: DriverStatus::Ready,
                version: None,
                binary_path: Some("/usr/bin/mock".into()),
                error: None,
                auth_hint: None,
                builtin: false,
                enabled: true,
                use_for: None,
                capabilities: DriverCapabilities::default(),
                models: Vec::new(),
                config: None,
            }
        }

        async fn probe(&self) -> DriverInfo {
            let mut info = self.descriptor();
            info.version = Some(self.probed_version.clone());
            info.models = vec![DriverModel {
                id: "mock-1".into(),
                label: "Mock 1".into(),
                is_default: true,
                thinking_levels: vec!["low".into(), "high".into()],
            }];
            info
        }

        async fn open_session(
            &self,
            _spec: DriverSessionOpen,
            _approvals: ApprovalRouter,
        ) -> Result<Arc<dyn DriverSession>, DriverError> {
            Err(DriverError::Unavailable(self.id.clone(), "mock".into()))
        }
    }

    #[test]
    fn registry_saves_persists_and_deletes_custom_acp_instance() {
        let dir = std::env::temp_dir().join(format!(
            "agente-drv-reg-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let path = dir.join("drivers.json");
        let registry = DriverRegistry::new(DriversConfig::default(), Some(path.clone()));

        let info = registry
            .save_instance(
                "custom-acp".into(),
                DriverInstanceConfig {
                    extends: Some("acp".into()),
                    label: Some("Custom ACP".into()),
                    command: vec!["my-agent".into()],
                    args: vec!["--acp".into()],
                    env: BTreeMap::new(),
                    ..DriverInstanceConfig::default()
                },
            )
            .unwrap();
        assert_eq!(info.instance_id, "custom-acp");
        assert_eq!(info.driver_kind, DriverKind::Acp);
        assert!(registry.get("custom-acp").is_some());

        let reloaded = DriverRegistry::new(DriversConfig::load_from(&path).unwrap(), Some(path));
        assert!(reloaded.get("custom-acp").is_some());
        assert!(reloaded.delete_instance("custom-acp").unwrap());
        assert!(reloaded.get("custom-acp").is_none());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn registry_lists_all_builtin_external_drivers_without_spawning() {
        let registry = DriverRegistry::new(DriversConfig::default(), None);
        let listed = registry.list_descriptors();
        assert_eq!(listed[0].instance_id, BUILTIN_AGENTE_INSTANCE);
        for expected in [
            "claude", "codex", "opencode", "pi", "copilot", "gemini", "qwen", "goose", "cursor",
            "cline", "kimi", "auggie", "kiro",
        ] {
            assert!(
                listed.iter().any(|d| d.instance_id == expected),
                "missing builtin driver '{expected}'"
            );
        }
    }

    #[tokio::test]
    async fn registry_caches_probed_models_and_invalidates_on_save_and_delete() {
        let dir = std::env::temp_dir().join(format!(
            "agente-drv-cache-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let path = dir.join("drivers.json");
        let registry = DriverRegistry::new(DriversConfig::default(), Some(path));
        registry.register_driver(Arc::new(MockDriver {
            id: "mock-cli".into(),
            kind: DriverKind::Acp,
            probed_version: "9.9.9".into(),
        }));

        let before = registry.list_descriptors();
        let before_mock = before.iter().find(|d| d.instance_id == "mock-cli").unwrap();
        assert!(before_mock.models.is_empty());

        let probed = registry.probe("mock-cli").await.unwrap();
        assert_eq!(probed.version.as_deref(), Some("9.9.9"));
        assert_eq!(probed.models.len(), 1);

        let after = registry.list_descriptors();
        let after_mock = after.iter().find(|d| d.instance_id == "mock-cli").unwrap();
        assert_eq!(after_mock.version.as_deref(), Some("9.9.9"));
        assert_eq!(after_mock.models[0].id, "mock-1");

        let mut saved_env = BTreeMap::new();
        saved_env.insert("CLAUDE_CONFIG_DIR".into(), "/tmp/work".into());
        let saved = registry
            .save_instance(
                "custom-extra".into(),
                DriverInstanceConfig {
                    extends: Some("claude".into()),
                    command: vec!["extra".into()],
                    args: vec!["--flag".into()],
                    env: saved_env,
                    strip_env: vec!["ANTHROPIC_API_KEY".into()],
                    use_for: Some("Work tasks".into()),
                    ..DriverInstanceConfig::default()
                },
            )
            .unwrap();
        assert_eq!(saved.config.as_ref().and_then(|c| c.extends.as_deref()), Some("claude"));
        let post_save = registry.list_descriptors();
        let extra = post_save.iter().find(|d| d.instance_id == "custom-extra").unwrap();
        let cfg = extra.config.as_ref().unwrap();
        assert_eq!(cfg.args, vec!["--flag"]);
        assert_eq!(cfg.strip_env, vec!["ANTHROPIC_API_KEY"]);
        assert_eq!(cfg.env.get("CLAUDE_CONFIG_DIR").map(String::as_str), Some("/tmp/work"));
        assert_eq!(cfg.use_for.as_deref(), Some("Work tasks"));
        // save_instance cleared cached_probes
        assert!(post_save.iter().all(|d| d.instance_id != "mock-cli"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    #[ignore = "spawns locally installed external coding CLIs for live model verification"]
    async fn live_probe_installed_clis() {
        let registry = DriverRegistry::new(DriversConfig::default(), None);
        let probed = registry.probe_all().await;
        for info in probed {
            if info.instance_id == BUILTIN_AGENTE_INSTANCE
                || info.status == DriverStatus::Missing
            {
                continue;
            }
            let sample: Vec<&str> = info.models.iter().take(5).map(|m| m.id.as_str()).collect();
            println!(
                "{} | kind={:?} | status={:?} | version={:?} | models={} ({:?}) | auth_hint={:?} | error={:?}",
                info.instance_id,
                info.driver_kind,
                info.status,
                info.version,
                info.models.len(),
                sample,
                info.auth_hint,
                info.error
            );
        }
    }
}
