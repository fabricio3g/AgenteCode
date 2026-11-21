use super::providers::model_config_from_catalog;
use super::*;

#[test]
fn test_config_default() {
    let config = AppConfig::default();
    assert!(config.default_provider.is_some());
    assert!(config.default_model.is_some());
    assert!(!config.provider.is_empty());
}

#[test]
fn retired_providers_are_hidden_even_in_saved_config() {
    let mut config = AppConfig::default();
    for id in ["anthropic", "google", "gemini"] {
        assert!(!config.provider.contains_key(id));
        config.provider.insert(id.into(), ProviderConfig::default());
    }
    config.provider.insert(
        "legacy-google".into(),
        ProviderConfig {
            api_format: Some("gemini".into()),
            ..Default::default()
        },
    );
    let entries = config.provider_entries();
    for id in ["anthropic", "google", "gemini", "legacy-google"] {
        assert!(!entries.iter().any(|entry| entry.id == id));
    }
    assert!(entries.iter().any(|entry| entry.id == "minimax"));
    let registry = crate::providers::ProviderRegistry::from_config(&config);
    for id in ["anthropic", "google", "gemini", "legacy-google"] {
        assert!(registry.get(id).is_none());
    }
}

#[test]
fn test_provider_entries() {
    let config = AppConfig::default();
    let entries = config.provider_entries();
    assert!(!entries.is_empty());
    assert!(entries.iter().any(|e| e.id == "openrouter"));
}

#[test]
fn test_resolve_base_url() {
    let config = AppConfig::default();
    let url = config.resolve_base_url("openrouter");
    assert!(url.is_some());
    assert!(url.unwrap().starts_with("http"));
}

#[test]
fn test_get_provider_name() {
    let config = AppConfig::default();
    let name = config.get_provider_name("openrouter");
    assert_eq!(name, "OpenRouter");
}

#[test]
fn test_get_provider_name_unknown() {
    let config = AppConfig::default();
    let name = config.get_provider_name("unknown_provider");
    assert_eq!(name, "unknown_provider");
}

#[test]
fn test_auto_approve_default() {
    let config = AutoApproveConfig::default();
    assert!(config.read_operations);
    assert!(!config.write_new_files);
    assert!(!config.safe_commands.is_empty());
    assert_eq!(config.max_auto_edit_lines, 10);
}

#[test]
fn test_strip_secrets() {
    let mut config = AppConfig::default();
    config
        .provider
        .get_mut("openrouter")
        .unwrap()
        .options
        .api_key = Some("secret".into());
    let stripped = config.strip_secrets();
    assert!(stripped.provider["openrouter"].options.api_key.is_none());
}

#[test]
fn test_set_defaults_ignores_empty_values() {
    let mut config = AppConfig {
        default_provider: Some("openai".into()),
        default_model: Some("gpt-4o".into()),
        ..AppConfig::default()
    };
    config.set_defaults(Some(String::new()), Some(String::new()));
    assert_eq!(config.default_provider.as_deref(), Some("openai"));
    assert_eq!(config.default_model.as_deref(), Some("gpt-4o"));
    config.set_defaults(
        Some("anthropic".into()),
        Some("claude-sonnet-4-20250514".into()),
    );
    assert_eq!(config.default_provider.as_deref(), Some("anthropic"));
    assert_eq!(
        config.default_model.as_deref(),
        Some("claude-sonnet-4-20250514")
    );
}

#[test]
fn test_default_mode_round_trips_via_serde() {
    let mut config = AppConfig {
        default_mode: Some("Build".into()),
        ..AppConfig::default()
    };
    config
        .discovered_models
        .insert("openai".into(), vec!["gpt-4o".into(), "gpt-4o-mini".into()]);
    let json = serde_json::to_string(&config.strip_secrets()).unwrap();
    let parsed: AppConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.default_mode.as_deref(), Some("Build"));
    assert_eq!(
        parsed.discovered_models.get("openai").unwrap(),
        &vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()]
    );
}

#[test]
fn default_providers_include_separate_opencode_plans() {
    let config = AppConfig::default();
    let ids: Vec<String> = config
        .provider_entries()
        .into_iter()
        .map(|p| p.id)
        .collect();
    assert_eq!(ids.len(), 6);
    for id in [
        "deepseek",
        "minimax",
        "glm",
        "opencode-go",
        "opencode",
        "openrouter",
    ] {
        assert!(ids.iter().any(|p| p == id), "missing provider {id}");
    }
}

#[test]
fn catalog_replaces_placeholder_models() {
    use crate::catalog::{CatalogModel, ModelCapabilities, ModelCost, ModelLimits, ModelStatus};

    let mut config = AppConfig::default();
    let mut models = HashMap::new();
    models.insert(
        "gpt-4o".to_string(),
        CatalogModel {
            provider: None,
            id: "gpt-4o".to_string(),
            provider_id: "openrouter".to_string(),
            name: "GPT-4o Real".to_string(),
            family: None,
            capabilities: ModelCapabilities::default(),
            cost: ModelCost::default(),
            limit: ModelLimits::default(),
            status: ModelStatus::Active,
            api_id: "gpt-4o-real".to_string(),
            reasoning_options: Vec::new(),
            reasoning_stream_field: None,
            headers: HashMap::new(),
            options: HashMap::new(),
            variants: HashMap::new(),
        },
    );
    let mut catalog = crate::catalog::ModelCatalog::default();
    catalog.providers.insert(
        "openrouter".to_string(),
        crate::catalog::CatalogProvider {
            id: "openrouter".to_string(),
            name: "OpenAI".to_string(),
            env: vec!["OPENAI_API_KEY".to_string()],
            api: "https://api.openai.com/v1".to_string(),
            npm: "@ai-sdk/openai".to_string(),
            models,
            whitelist: Vec::new(),
            blacklist: Vec::new(),
        },
    );

    config.merge_catalog(&catalog);
    assert_eq!(
        config.provider["openrouter"].models["gpt-4o"]
            .name
            .as_deref(),
        Some("GPT-4o Real")
    );
}

fn entry(name: &str, provider: &str, model: &str) -> SubagentModelEntry {
    SubagentModelEntry {
        name: name.into(),
        provider: provider.into(),
        model: model.into(),
        thinking: None,
        use_for: String::new(),
    }
}

#[test]
fn legacy_pins_fold_into_the_model_list() {
    let pick = |provider: &str, model: &str| SubagentModel {
        provider: provider.into(),
        model: model.into(),
        thinking: None,
    };
    let legacy = SubagentModels::from([
        (ALL_SUBAGENTS.into(), pick("deepseek", "deepseek-flash")),
        ("explore".into(), pick("deepseek", "deepseek-flash")),
        ("plan".into(), pick("openrouter", "qwen/qwen3-coder:free")),
    ]);
    let settings = SubagentSettings::default().with_legacy(&legacy);
    let names: Vec<&str> = settings.models.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["deepseek-flash", "qwen3-coder-free"]);
    assert_eq!(settings.default_model.as_deref(), Some("deepseek-flash"));
    assert!(settings.validate().is_ok());

    let mine = SubagentSettings {
        default_model: Some(MAIN_MODEL.into()),
        ..SubagentSettings::default()
    }
    .with_legacy(&legacy);
    assert_eq!(mine.default_model.as_deref(), Some(MAIN_MODEL));

    let mut config = AppConfig {
        subagent_models: legacy,
        ..AppConfig::default()
    };
    let effective = config.subagent_settings();
    config.set_subagent_settings(effective.clone());
    assert!(config.subagent_models.is_empty());
    assert_eq!(config.subagent_settings(), effective);
}

#[test]
fn the_default_model_counts_only_while_it_is_on_the_list() {
    let mut settings = SubagentSettings {
        models: vec![entry("scout", "openrouter", "a/scout:free")],
        default_model: Some("scout".into()),
        ..SubagentSettings::default()
    };
    assert_eq!(settings.default_name(), Some("scout"));
    settings.default_model = Some("gone".into());
    assert_eq!(settings.default_name(), None);
    settings.default_model = Some(MAIN_MODEL.into());
    assert_eq!(settings.default_name(), Some(MAIN_MODEL));
    assert_eq!(SubagentSettings::default().default_name(), None);
}

#[test]
fn typed_names_are_settled_not_refused() {
    let settings = SubagentSettings {
        models: vec![
            entry("scout", "openrouter", "a/scout"),
            entry("other", "glm", "z-ai/glm-5"),
        ],
        ..SubagentSettings::default()
    };
    assert_eq!(
        settings.settled_name("Revisor Rápido!", 1),
        "revisor-rapido"
    );
    assert_eq!(settings.settled_name("scout", 1), "scout-2");
    assert_eq!(settings.settled_name("scout", 0), "scout");
    assert_eq!(settings.settled_name("main", 1), "main-model");
    assert_eq!(settings.settled_name("  ", 1), "glm-5");
    let mut renamed = settings.clone();
    renamed.models[1].name = renamed.settled_name("Fast  Reader", 1);
    assert_eq!(renamed.models[1].name, "fast-reader");
    assert!(renamed.validate().is_ok());
}

#[test]
fn model_names_are_checked_and_generated() {
    let mut settings = SubagentSettings {
        models: vec![entry("scout", "openrouter", "a/b")],
        ..SubagentSettings::default()
    };
    assert!(settings.validate().is_ok());
    assert_eq!(settings.unique_name("x/Scout"), "scout-2");
    assert_eq!(settings.unique_name("GLM 5.1"), "glm-5.1");
    assert_eq!(settings.unique_name("main"), "model");
    settings.models.push(entry("scout", "glm", "glm-5"));
    assert!(settings.validate().unwrap_err().contains("Two"));
    settings.models[1].name = "Has Space".into();
    assert!(settings.validate().is_err());
    settings.models[1].name = MAIN_MODEL.into();
    assert!(settings.validate().unwrap_err().contains("reserved"));
    settings.models[1] = entry("builder", "", "glm-5");
    assert!(settings.validate().is_err());
}

#[test]
fn subagent_settings_round_trip_and_merge() {
    assert!(!serde_json::to_string(&AppConfig::default())
        .unwrap()
        .contains("\"subagents\""));
    let base = AppConfig {
        subagents: SubagentSettings {
            orchestrator_picks: Some(false),
            models: vec![
                entry("scout", "openrouter", "a/scout:free"),
                entry("builder", "glm", "glm-5"),
            ],
            default_model: Some("scout".into()),
        },
        ..AppConfig::default()
    };
    let json = serde_json::to_string(&base).unwrap();
    let loaded: AppConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(loaded.subagents, base.subagents);
    assert!(!loaded.subagents.picks());
    assert!(loaded.subagents.pickable().is_empty());

    let workspace = AppConfig {
        subagents: SubagentSettings {
            models: vec![
                entry("builder", "deepseek", "deepseek-pro"),
                entry("checker", "deepseek", "deepseek-flash"),
            ],
            default_model: Some("checker".into()),
            ..SubagentSettings::default()
        },
        ..AppConfig::default()
    };
    let merged = base.merge(workspace).subagents;
    let names: Vec<&str> = merged.models.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["scout", "builder", "checker"]);
    assert_eq!(merged.entry("builder").unwrap().model, "deepseek-pro");
    assert_eq!(merged.default_model.as_deref(), Some("checker"));
    assert_eq!(merged.orchestrator_picks, Some(false));
}

#[test]
fn merge_catalog_does_not_add_unknown_providers() {
    use crate::catalog::{CatalogModel, ModelCapabilities, ModelCost, ModelLimits, ModelStatus};

    let mut config = AppConfig::default();
    let before = config.provider.len();
    let mut models = HashMap::new();
    models.insert(
        "obscure-model".to_string(),
        CatalogModel {
            provider: None,
            id: "obscure-model".to_string(),
            provider_id: "some-random-gateway".to_string(),
            name: "Obscure".to_string(),
            family: None,
            capabilities: ModelCapabilities::default(),
            cost: ModelCost::default(),
            limit: ModelLimits {
                context: 99_000,
                input: None,
                output: 4096,
            },
            status: ModelStatus::Active,
            api_id: "obscure-model".to_string(),
            reasoning_options: Vec::new(),
            reasoning_stream_field: None,
            headers: HashMap::new(),
            options: HashMap::new(),
            variants: HashMap::new(),
        },
    );
    let mut catalog = crate::catalog::ModelCatalog::default();
    catalog.providers.insert(
        "some-random-gateway".to_string(),
        crate::catalog::CatalogProvider {
            id: "some-random-gateway".to_string(),
            name: "Random Gateway".to_string(),
            env: vec!["RANDOM_API_KEY".to_string()],
            api: "https://example.com/v1".to_string(),
            npm: "@ai-sdk/openai".to_string(),
            models,
            whitelist: Vec::new(),
            blacklist: Vec::new(),
        },
    );

    config.merge_catalog(&catalog);
    assert_eq!(config.provider.len(), before);
    assert!(!config.provider.contains_key("some-random-gateway"));
    assert!(config.catalog.is_some());
    assert!(config
        .catalog
        .as_ref()
        .unwrap()
        .find_model("some-random-gateway", "obscure-model")
        .is_some());
}

#[test]
fn saved_config_does_not_carry_the_merged_catalog() {
    use crate::catalog::{
        CatalogModel, CatalogProvider, ModelCapabilities, ModelCatalog, ModelCost, ModelLimits,
        ModelStatus,
    };

    let catalog_model = |id: &str| CatalogModel {
        provider: None,
        id: id.to_string(),
        provider_id: "openrouter".to_string(),
        name: format!("Model {id}"),
        family: None,
        capabilities: ModelCapabilities::default(),
        cost: ModelCost::default(),
        limit: ModelLimits::default(),
        status: ModelStatus::Active,
        api_id: id.to_string(),
        reasoning_options: Vec::new(),
        reasoning_stream_field: None,
        headers: HashMap::new(),
        options: HashMap::new(),
        variants: HashMap::new(),
    };

    let models: HashMap<String, CatalogModel> = (0..2_000)
        .map(|i| {
            let id = format!("model-{i}");
            (id.clone(), catalog_model(&id))
        })
        .collect();

    let mut catalog = ModelCatalog::default();
    catalog.providers.insert(
        "openrouter".to_string(),
        CatalogProvider {
            id: "openrouter".to_string(),
            name: "OpenAI".to_string(),
            env: vec!["OPENAI_API_KEY".to_string()],
            api: "https://api.openai.com/v1".to_string(),
            npm: "@ai-sdk/openai".to_string(),
            models,
            whitelist: Vec::new(),
            blacklist: Vec::new(),
        },
    );

    let mut config = AppConfig::default();
    config.merge_catalog(&catalog);
    let merged = serde_json::to_string(&config.strip_secrets()).unwrap();
    assert!(
        merged.len() > 200_000,
        "fixture should reproduce the blow-up, got {} bytes",
        merged.len()
    );

    let mut persisted = config.strip_secrets();
    persisted.strip_catalog_derived(config.catalog.as_ref());
    let written = serde_json::to_string(&persisted).unwrap();
    assert!(
        written.len() < 64 * 1024,
        "persisted config must stay small, got {} bytes",
        written.len()
    );
    let leaked: Vec<_> = persisted.provider["openrouter"]
        .models
        .keys()
        .filter(|id| id.starts_with("model-"))
        .collect();
    assert!(
        leaked.is_empty(),
        "catalog-derived models must not be persisted, leaked {}",
        leaked.len()
    );
}

#[test]
fn user_overrides_survive_catalog_stripping() {
    use crate::catalog::{
        CatalogModel, CatalogProvider, ModelCapabilities, ModelCatalog, ModelCost, ModelLimits,
        ModelStatus,
    };

    let mut models = HashMap::new();
    models.insert(
        "gpt-4o".to_string(),
        CatalogModel {
            provider: None,
            id: "gpt-4o".to_string(),
            provider_id: "openrouter".to_string(),
            name: "GPT-4o".to_string(),
            family: None,
            capabilities: ModelCapabilities::default(),
            cost: ModelCost::default(),
            limit: ModelLimits::default(),
            status: ModelStatus::Active,
            api_id: "gpt-4o".to_string(),
            reasoning_options: Vec::new(),
            reasoning_stream_field: None,
            headers: HashMap::new(),
            options: HashMap::new(),
            variants: HashMap::new(),
        },
    );
    let mut catalog = ModelCatalog::default();
    catalog.providers.insert(
        "openrouter".to_string(),
        CatalogProvider {
            id: "openrouter".to_string(),
            name: "OpenAI".to_string(),
            env: vec!["OPENAI_API_KEY".to_string()],
            api: "https://api.openai.com/v1".to_string(),
            npm: "@ai-sdk/openai".to_string(),
            models,
            whitelist: Vec::new(),
            blacklist: Vec::new(),
        },
    );

    let mut config = AppConfig::default();
    config.merge_catalog(&catalog);
    config
        .provider
        .get_mut("openrouter")
        .unwrap()
        .models
        .get_mut("gpt-4o")
        .unwrap()
        .name = Some("My GPT".to_string());

    let mut persisted = config.strip_secrets();
    persisted.strip_catalog_derived(config.catalog.as_ref());
    assert_eq!(
        persisted.provider["openrouter"].models["gpt-4o"]
            .name
            .as_deref(),
        Some("My GPT"),
        "a user-edited model entry must not be stripped"
    );
}

#[test]
fn stale_provider_shells_are_stripped_connected_ones_survive() {
    use crate::catalog::{
        CatalogModel, CatalogProvider, ModelCapabilities, ModelCatalog, ModelCost, ModelLimits,
        ModelStatus,
    };

    let catalog_model = CatalogModel {
        provider: None,
        id: "some-model".to_string(),
        provider_id: "venice".to_string(),
        name: "Some Model".to_string(),
        family: None,
        capabilities: ModelCapabilities::default(),
        cost: ModelCost::default(),
        limit: ModelLimits::default(),
        status: ModelStatus::Active,
        api_id: "some-model".to_string(),
        reasoning_options: Vec::new(),
        reasoning_stream_field: None,
        headers: HashMap::new(),
        options: HashMap::new(),
        variants: HashMap::new(),
    };
    let mut catalog = ModelCatalog::default();
    catalog.providers.insert(
        "venice".to_string(),
        CatalogProvider {
            id: "venice".to_string(),
            name: "Venice".to_string(),
            env: vec!["VENICE_API_KEY".to_string()],
            api: String::new(),
            npm: String::new(),
            models: [("some-model".to_string(), catalog_model.clone())]
                .into_iter()
                .collect(),
            whitelist: Vec::new(),
            blacklist: Vec::new(),
        },
    );

    let mut config = AppConfig::default();
    for id in ["venice", "my-local", "custom"] {
        assert!(
            !config.provider.contains_key(id),
            "{id} must not be a built-in (else this test proves nothing)"
        );
    }
    config.merge_catalog(&catalog);
    config.provider.insert(
        "venice".into(),
        ProviderConfig {
            api: Some(String::new()),
            name: Some("Venice AI".to_string()),
            env: vec!["VENICE_API_KEY".to_string()],
            npm: Some("venice-ai-sdk-provider".to_string()),
            api_format: Some("openai".to_string()),
            models: [(
                "some-model".to_string(),
                model_config_from_catalog(&catalog_model),
            )]
            .into_iter()
            .collect(),
            ..Default::default()
        },
    );
    config.provider.insert(
        "my-local".into(),
        ProviderConfig {
            options: ProviderOptions {
                base_url: Some("http://localhost:11434/v1".to_string()),
                ..Default::default()
            },
            ..Default::default()
        },
    );
    config.provider.insert(
        "custom".into(),
        ProviderConfig {
            models: [(
                "my-llama".to_string(),
                ModelConfig {
                    name: Some("My Llama".to_string()),
                    ..Default::default()
                },
            )]
            .into_iter()
            .collect(),
            ..Default::default()
        },
    );

    let mut persisted = config.strip_secrets();
    persisted.strip_catalog_derived(config.catalog.as_ref());
    assert!(
        !persisted.provider.contains_key("venice"),
        "stale shell with no authorship signal must be dropped"
    );
    assert!(
        persisted.provider.contains_key("my-local"),
        "connected custom endpoint must survive"
    );
    assert!(
        persisted.provider["custom"].models.contains_key("my-llama"),
        "hand-added model must survive"
    );
    assert!(persisted.provider.contains_key("openrouter"));
    let written = serde_json::to_string(&persisted).unwrap();
    assert!(
        written.len() < 256 * 1024,
        "persisted config must stay small, got {} bytes",
        written.len()
    );
}

#[test]
fn merge_keeps_global_auto_approve_merges_max_iterations_and_strips_catalog_aliases() {
    use crate::catalog::{
        CatalogModel, CatalogProvider, ModelCapabilities, ModelCatalog, ModelCost, ModelLimits,
        ModelStatus,
    };

    let mut global = AppConfig::default();
    global.auto_approve.write_new_files = true;
    global.auto_approve.max_auto_edit_lines = 42;
    global.max_iterations = Some(25);

    let project_without_auto: AppConfig =
        serde_json::from_str(r#"{"max_iterations": 60}"#).unwrap();
    let merged = global.clone().merge(project_without_auto);
    assert_eq!(merged.max_iterations, Some(60));
    assert!(merged.auto_approve.write_new_files);
    assert_eq!(merged.auto_approve.max_auto_edit_lines, 42);

    let project_with_auto: AppConfig = serde_json::from_str(
        r#"{"auto_approve": {"write_new_files": false, "max_auto_edit_lines": 5}}"#,
    )
    .unwrap();
    let merged = global.merge(project_with_auto);
    assert!(!merged.auto_approve.write_new_files);
    assert_eq!(merged.auto_approve.max_auto_edit_lines, 5);

    let cat_model = CatalogModel {
        provider: None,
        id: "glm-test".to_string(),
        provider_id: "zai".to_string(),
        name: "GLM Test".to_string(),
        family: None,
        capabilities: ModelCapabilities::default(),
        cost: ModelCost::default(),
        limit: ModelLimits::default(),
        status: ModelStatus::Active,
        api_id: "glm-test".to_string(),
        reasoning_options: Vec::new(),
        reasoning_stream_field: None,
        headers: HashMap::new(),
        options: HashMap::new(),
        variants: HashMap::new(),
    };
    let mut catalog = ModelCatalog::default();
    catalog.providers.insert(
        "zai".to_string(),
        CatalogProvider {
            id: "zai".to_string(),
            name: "Z.AI".to_string(),
            env: vec!["ZAI_API_KEY".to_string()],
            api: String::new(),
            npm: String::new(),
            models: [("glm-test".to_string(), cat_model)].into_iter().collect(),
            whitelist: Vec::new(),
            blacklist: Vec::new(),
        },
    );
    let mut cfg = AppConfig::default();
    cfg.merge_catalog(&catalog);
    assert!(cfg.provider["glm"].models.contains_key("glm-test"));
    let mut persisted = cfg.strip_secrets();
    persisted.strip_catalog_derived(cfg.catalog.as_ref());
    assert!(!persisted.provider["glm"].models.contains_key("glm-test"));

    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().to_string_lossy().to_string();
    cfg.save_to(Some(&project)).unwrap();
    let saved_json = std::fs::read_to_string(dir.path().join("agente.json")).unwrap();
    let loaded: AppConfig = serde_json::from_str(&saved_json).unwrap();
    assert_eq!(loaded.default_provider, cfg.default_provider);
}
