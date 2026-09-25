//! One model-aware dispatch boundary for all configured providers.
use super::{ApiFormat, ModelInfo, Provider, ProviderInfo, RequestContext};
use crate::llm::{LlmError, StreamEvent, Usage};
use crate::types::{Message, ToolDefinition};
use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use tokio::sync::mpsc::Sender;

pub struct RoutedProvider {
    info: ProviderInfo,
    options: HashMap<String, Value>,
}

impl RoutedProvider {
    pub fn new(info: ProviderInfo, options: HashMap<String, Value>) -> Self {
        Self { info, options }
    }

    fn transport_info(&self, format: ApiFormat) -> ProviderInfo {
        ProviderInfo {
            id: self.info.id.clone(),
            name: self.info.name.clone(),
            api_format: format,
            capabilities: self.info.capabilities.clone(),
            base_url: self.info.base_url.clone(),
            env_keys: self.info.env_keys.clone(),
            headers: self.info.headers.clone(),
            api_key: self.info.api_key.clone(),
            models: Vec::new(),
        }
    }
}

#[async_trait]
impl Provider for RoutedProvider {
    fn info(&self) -> &ProviderInfo {
        &self.info
    }

    fn get_request_options(&self, model: &ModelInfo) -> HashMap<String, Value> {
        let mut options = super::model_options(&self.options);
        let selected = super::model_options(&model.options);
        // A selected variant replaces provider defaults as a unit, even when
        // different native formats use different reasoning parameter names.
        if selected
            .keys()
            .any(|key| crate::thinking::is_thinking_option(key))
        {
            options.retain(|key, _| !crate::thinking::is_thinking_option(key));
        }
        options.extend(selected);
        options
    }

    fn request_api_format(&self, model: &ModelInfo) -> ApiFormat {
        if matches!(
            self.info.id.as_str(),
            "deepseek" | "minimax" | "glm" | "opencode-go"
        ) {
            return self.info.api_format;
        }
        model.api.format.unwrap_or(self.info.api_format)
    }

    async fn stream_completion(
        &self,
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
        model: &ModelInfo,
        sender: Sender<StreamEvent>,
        context: RequestContext,
    ) -> Result<Usage, LlmError> {
        if self.info.id == "opencode-go" && self.info.id != model.provider_id {
            return Err(LlmError::HttpError(
                "OpenCode Go model belongs to a different provider".into(),
            ));
        }
        let format = if self.info.id == "opencode-go" {
            super::go::format(&model.api_id).ok_or_else(|| {
                LlmError::HttpError(format!(
                    "OpenCode Go model '{}' has no documented API route; refresh the supported model list",
                    model.api_id
                ))
            })?
        } else {
            self.request_api_format(model)
        };
        let mut model = model.clone();
        if crate::config::provider_is_supported(&self.info.id, &Default::default()) {
            model.api.format = Some(format);
        }
        model.options = self.get_request_options(&model);
        let info = self.transport_info(format);
        match format {
            ApiFormat::OpenAI => {
                super::openai::OpenAIProvider::from_info(info)
                    .stream_completion(messages, tools, &model, sender, context)
                    .await
            }
            ApiFormat::Anthropic => {
                super::messages::MessagesProvider::from_info(info)
                    .stream_completion(messages, tools, &model, sender, context)
                    .await
            }
            ApiFormat::Responses => {
                super::responses::ResponsesProvider::from_info(info)
                    .stream_completion(messages, tools, &model, sender, context)
                    .await
            }
            ApiFormat::Google => {
                super::google::GoogleProvider::from_info(info)
                    .stream_completion(messages, tools, &model, sender, context)
                    .await
            }
        }
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LlmError> {
        if self.info.id == "minimax" {
            return super::openai::OpenAIProvider::from_info(self.info.clone())
                .list_models()
                .await;
        }
        match self.info.api_format {
            ApiFormat::Anthropic | ApiFormat::Google if !self.info.models.is_empty() => {
                Ok(self.info.models.clone())
            }
            _ => {
                let models = super::openai::OpenAIProvider::from_info(self.info.clone())
                    .list_models()
                    .await?;
                if self.info.id == "opencode-go" {
                    Ok(models
                        .into_iter()
                        .filter(|model| super::go::format(&model.api_id).is_some())
                        .collect())
                } else {
                    Ok(models)
                }
            }
        }
    }
}
