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
            transport: self.info.transport.clone(),
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

    async fn stream_completion(
        &self,
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
        model: &ModelInfo,
        sender: Sender<StreamEvent>,
        context: RequestContext,
    ) -> Result<Usage, LlmError> {
        if super::canonical_provider_id(&self.info.id)
            != super::canonical_provider_id(&model.provider_id)
        {
            return Err(LlmError::HttpError(
                "Model belongs to a different provider".into(),
            ));
        }
        let format = self.resolve_request_api_format(model)?;
        let mut model = model.clone();
        model.api.format = Some(format);
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
                Ok(models)
            }
        }
    }
}
