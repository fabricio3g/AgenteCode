//! Declarative transport contracts shared by discovery, clients and requests.
use super::{ApiFormat, ModelInfo, ProviderInfo};
use crate::llm::LlmError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TransportPolicy {
    pub require_model_route: Option<bool>,
    pub model_routes: BTreeMap<String, ApiFormat>,
    pub cache: CachePolicy,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CachePolicy {
    /// Unset uses the protocol default: markers on Messages, otherwise off.
    pub breakpoints: Option<bool>,
    pub rules: Vec<CacheRule>,
    pub prompt_cache_key: Option<bool>,
    /// Stable conversation routing header; empty explicitly disables it.
    pub session_header: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CacheRule {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub model_prefix: Option<String>,
    #[serde(default)]
    pub format: Option<ApiFormat>,
    pub breakpoints: bool,
}

impl TransportPolicy {
    /// What this policy says beyond `defaults`, or `None` when it adds
    /// nothing. Saved configs keep only this, so a spec's new or corrected
    /// routes reach installs that saved an older copy.
    pub fn beyond(&self, defaults: &Self) -> Option<Self> {
        let mut own = self.clone();
        own.model_routes
            .retain(|id, format| defaults.model_routes.get(id) != Some(format));
        if own.require_model_route == defaults.require_model_route {
            own.require_model_route = None;
        }
        if own.cache == defaults.cache {
            own.cache = CachePolicy::default();
        }
        (own != Self::default()).then_some(own)
    }

    /// Partial configuration overrides defaults without erasing unrelated fields.
    pub fn overlay(&mut self, other: &Self) {
        if other.require_model_route.is_some() {
            self.require_model_route = other.require_model_route;
        }
        self.model_routes.extend(other.model_routes.clone());
        if other.cache.breakpoints.is_some() {
            self.cache.breakpoints = other.cache.breakpoints;
            // A provider-wide override also replaces inherited model exceptions.
            self.cache.rules.clear();
        }
        if !other.cache.rules.is_empty() {
            self.cache.rules = other.cache.rules.clone();
        }
        if other.cache.session_header.is_some() {
            self.cache.session_header = other.cache.session_header.clone();
        }
        if other.cache.prompt_cache_key.is_some() {
            self.cache.prompt_cache_key = other.cache.prompt_cache_key;
        }
    }

    pub fn resolve_format(
        &self,
        info: &ProviderInfo,
        model: &ModelInfo,
    ) -> Result<ApiFormat, LlmError> {
        if let Some(format) = model.api.format {
            return Ok(format);
        }
        if let Some(format) = self
            .model_routes
            .get(&model.api_id)
            .or_else(|| self.model_routes.get(&model.id))
        {
            return Ok(*format);
        }
        if self.require_model_route == Some(true) {
            return Err(LlmError::HttpError(format!(
                "{}: no API route for '{}'; set provider.{}.models.{}.provider.api_format to openai, anthropic, responses, or google in agente.json",
                info.name, model.id, super::canonical_provider_id(&info.id), model.id
            )));
        }
        Ok(info.api_format)
    }

    pub fn breakpoints(&self, format: ApiFormat, model: &ModelInfo) -> bool {
        if let Some(forced) = super::model_options(&model.options)
            .get("cache_control")
            .and_then(serde_json::Value::as_bool)
        {
            return forced;
        }
        self.cache
            .rules
            .iter()
            .find(|rule| {
                rule.format.is_none_or(|expected| expected == format)
                    && rule.model.as_ref().is_none_or(|id| id == &model.api_id)
                    && rule
                        .model_prefix
                        .as_ref()
                        .is_none_or(|prefix| model.api_id.starts_with(prefix))
            })
            .map_or_else(
                || {
                    self.cache
                        .breakpoints
                        .unwrap_or(format == ApiFormat::Anthropic)
                },
                |rule| rule.breakpoints,
            )
    }
}

impl ProviderInfo {
    pub fn transport_policy(&self) -> TransportPolicy {
        let mut policy = super::spec::get(super::canonical_provider_id(&self.id))
            .and_then(|spec| spec.transport.clone())
            .unwrap_or_default();
        policy.overlay(&self.transport);
        policy
    }

    pub fn resolve_format(&self, model: &ModelInfo) -> Result<ApiFormat, LlmError> {
        self.transport_policy().resolve_format(self, model)
    }
}

/// Tracks precedence without persisting derived metadata as user configuration.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum MetadataSource {
    #[default]
    Fallback,
    Catalog,
    Live,
    Configured,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_policy_keeps_only_what_differs_from_the_spec() {
        let mut defaults = TransportPolicy {
            require_model_route: Some(true),
            ..Default::default()
        };
        defaults.model_routes.insert("a".into(), ApiFormat::OpenAI);
        assert_eq!(defaults.beyond(&defaults), None);

        let mut saved = defaults.clone();
        saved.model_routes.insert("a".into(), ApiFormat::Anthropic);
        saved
            .model_routes
            .insert("mine".into(), ApiFormat::Responses);
        let own = saved.beyond(&defaults).unwrap();
        assert_eq!(own.require_model_route, None);
        assert_eq!(own.model_routes.len(), 2);
        assert_eq!(own.cache, CachePolicy::default());
    }
}
