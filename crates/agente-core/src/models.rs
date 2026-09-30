//! Live model discovery shared by the TUI and the runtime (and so Agente
//! Desktop, through the daemon).
//!
//! A provider's own model list is authoritative for what it serves right now
//! and, for OpenRouter and llama.cpp, for each model's thinking controls;
//! models.dev and the provider spec fill what the list leaves out. Every
//! client goes through [`discover`] / [`enrich_discovered`], so they all see
//! the same models with the same levels.

use std::time::Duration;

use crate::catalog::ModelCatalog;
use crate::providers::{enrich_discovered_model, ModelInfo, ProviderRegistry};

/// Bound discovery so a hung models endpoint cannot leave a client
/// "discovering…" forever.
pub const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);

/// Merge a provider's raw list with the static registry and models.dev.
///
/// `baseline` must be a registry built from configuration only: enriching
/// against a previous live snapshot would let metadata a fresh response
/// omits inherit stale reasoning controls.
pub fn enrich_discovered(
    models: &[ModelInfo],
    baseline: &ProviderRegistry,
    catalog: Option<&ModelCatalog>,
) -> Vec<ModelInfo> {
    models
        .iter()
        .map(|model| enrich_discovered_model(model, baseline, catalog))
        .collect()
}

/// List a provider's models, enrich them, and publish them as the registry's
/// live snapshot for that provider. Returns the enriched list.
pub async fn discover(
    registry: &ProviderRegistry,
    baseline: &ProviderRegistry,
    catalog: Option<&ModelCatalog>,
    provider_id: &str,
) -> Result<Vec<ModelInfo>, String> {
    let provider = registry
        .get(provider_id)
        .ok_or_else(|| format!("Unknown provider '{provider_id}'"))?;
    let raw = match tokio::time::timeout(DISCOVERY_TIMEOUT, provider.list_models()).await {
        Ok(Ok(models)) => models,
        Ok(Err(error)) => {
            return Err(crate::util::redact_secrets(&format!(
                "{provider_id}: model list failed: {error}"
            )))
        }
        Err(_) => {
            return Err(format!(
                "{provider_id}: model list timed out; check the network or API key"
            ))
        }
    };
    let enriched = enrich_discovered(&raw, baseline, catalog);
    registry.replace_runtime_models(provider_id, enriched.clone());
    tracing::info!(provider = %provider_id, count = enriched.len(), "Models discovered");
    Ok(enriched)
}

/// A model as clients list it: identity, limits, input kinds and its
/// thinking profile.
pub fn model_json(model: &ModelInfo) -> serde_json::Value {
    serde_json::json!({
        "id": model.id,
        "name": model.name,
        "provider_id": model.provider_id,
        "context": model.limits.context,
        "output": model.limits.output,
        "input_modalities": model.capabilities.input_modalities,
        "vision": model.capabilities.vision,
        "tools": model.capabilities.toolcall,
        "reasoning": model.capabilities.reasoning,
        "cost": model.cost,
        "thinking": crate::thinking::profile(model),
    })
}
