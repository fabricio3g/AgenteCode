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
    let started = std::time::Instant::now();
    let raw = match tokio::time::timeout(DISCOVERY_TIMEOUT, provider.list_models()).await {
        Ok(Ok(models)) => models,
        Ok(Err(error)) => {
            tracing::warn!(provider = %provider_id, elapsed_ms = started.elapsed().as_millis(), "Model discovery failed");
            return Err(crate::util::redact_secrets(&format!(
                "{provider_id}: model list failed: {error}"
            )));
        }
        Err(_) => {
            tracing::warn!(provider = %provider_id, elapsed_ms = started.elapsed().as_millis(), "Model discovery timed out");
            return Err(format!(
                "{provider_id}: model list timed out; check the network or API key"
            ));
        }
    };
    let mut enriched = enrich_discovered(&raw, baseline, catalog);
    for model in &mut enriched {
        if let Some(configured) = provider
            .info()
            .models
            .iter()
            .find(|known| known.id == model.id || known.api_id == model.api_id)
        {
            crate::providers::overlay_transport(model, configured);
        }
        crate::providers::resolve_registered_transport(model, provider.as_ref());
    }
    registry.replace_runtime_models(provider_id, enriched.clone());
    tracing::info!(provider = %provider_id, count = enriched.len(), elapsed_ms = started.elapsed().as_millis(), "Models discovered");
    Ok(enriched)
}

/// A model as clients list it: identity, limits, input kinds and its
/// thinking profile.
pub fn model_json(model: &ModelInfo) -> serde_json::Value {
    serde_json::json!({
        "transport": transport_json(model),
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

/// Additive readiness metadata; clients never need to reproduce route policy.
pub fn transport_json(model: &ModelInfo) -> serde_json::Value {
    serde_json::json!({
        "ready": model.api.resolved_format.is_some(),
        "api_format": model.api.resolved_format,
        "base_url": model.api.resolved_base_url,
        "cache_control": model.api.resolved_cache_control,
        "policy": model.api.resolved_policy,
        "error": model.api.route_error,
    })
}
