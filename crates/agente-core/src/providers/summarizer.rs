//! Provider-backed LLM summarizer for context compaction.
//!
//! This mirrors pi's summarization path: pi's compaction functions receive a
//! `Models` collection plus the active `Model`, then call `completeSimple` to
//! generate a structured summary. Here the runtime equivalent is the
//! `Provider` trait, so `ProviderSummarizer` drives a provider's streaming
//! interface and collects the text of a summarization completion.

use std::sync::Arc;

use crate::context::compaction::{build_summarization_messages, SummarizeError, Summarizer};
use crate::llm::{LlmError, StreamEvent};
use crate::providers::{ModelInfo, Provider, RequestContext};
use crate::types::Message;

/// A summarizer that uses a provider's streaming completion for summarization.
pub struct ProviderSummarizer {
    provider: Arc<dyn Provider>,
    model: ModelInfo,
    context: RequestContext,
    usage: Arc<parking_lot::Mutex<Option<crate::llm::Usage>>>,
    attempted: std::sync::atomic::AtomicBool,
}

impl ProviderSummarizer {
    pub fn attempted(&self) -> bool {
        self.attempted.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn usage(&self) -> Option<crate::llm::Usage> {
        self.usage.lock().clone().filter(|usage| {
            usage.total_tokens > 0
                || usage.prompt_tokens > 0
                || usage.completion_tokens > 0
                || usage.cache_read_tokens > 0
                || usage.cache_creation_tokens > 0
        })
    }

    /// Create a summarizer using the selected model, including live metadata.
    pub fn new(provider: Arc<dyn Provider>, model: ModelInfo, context: RequestContext) -> Self {
        Self {
            provider,
            model,
            context,
            usage: Arc::default(),
            attempted: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

/// Hard ceiling for one background completion (compaction, session titles).
/// Streaming providers handle idle stalls per-chunk; this bounds the whole
/// call so a pathological endpoint cannot stall compaction forever.
const COMPLETE_TEXT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

struct AbortBackground(tokio::task::AbortHandle);

impl Drop for AbortBackground {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Run a small, non-tool completion through any provider and collect its text.
/// Context compaction and session-title generation share this path so provider
/// streaming behavior stays consistent and there is only one collector to
/// harden.
pub async fn complete_text(
    provider: Arc<dyn Provider>,
    model: ModelInfo,
    messages: &[Message],
    context: RequestContext,
) -> Result<String, LlmError> {
    complete_text_with_budget(provider, model, messages, None, context, None).await
}

async fn complete_text_with_budget(
    provider: Arc<dyn Provider>,
    mut model: ModelInfo,
    messages: &[Message],
    budget_tokens: Option<usize>,
    context: RequestContext,
    usage: Option<Arc<parking_lot::Mutex<Option<crate::llm::Usage>>>>,
) -> Result<String, LlmError> {
    if let Some(budget) = budget_tokens {
        model.limits.output = model
            .limits
            .output
            .min(budget.max(1).try_into().unwrap_or(model.limits.output));
        // Provider-specific options are applied after the standard fields.
        // They must not silently override a background task's budget.
        model.options.remove("max_tokens");
        model.options.remove("max_completion_tokens");
    }

    // Background completions are one-shot: a compaction checkpoint serializes
    // the whole transcript under a summarization system prompt, and a title
    // sends one short exchange. Neither prompt ever recurs, so a cache write
    // is a 25% surcharge on tokens nothing will ever read (Anthropic prices a
    // 5-minute write at 1.25x base input). `breakpoints()` honours a forced
    // model option first, so this turns markers off for this call only and
    // leaves the provider's transport policy alone.
    model
        .options
        .insert("cache_control".into(), serde_json::json!(false));

    let (tx, mut rx) = tokio::sync::mpsc::channel(1024);
    let messages = messages.to_vec();
    let handle = tokio::spawn(async move {
        provider
            .stream_completion(&messages, None, &model, tx, context)
            .await
    });
    // Cancelling compaction or timing out a title must also stop its provider
    // request; dropping a JoinHandle alone would leave that request running.
    let _abort_on_drop = AbortBackground(handle.abort_handle());

    let mut text = String::new();
    let deadline = tokio::time::Instant::now() + COMPLETE_TEXT_TIMEOUT;
    let outcome = loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Err(_elapsed) => {
                handle.abort();
                break Err(LlmError::StreamError(
                    "background completion timed out after 180s".to_string(),
                ));
            }
            Ok(None) => break Ok(()),
            Ok(Some(StreamEvent::TextDelta(t))) => text.push_str(&t),
            Ok(Some(StreamEvent::Done { usage: value, .. })) => {
                if let Some(usage) = &usage {
                    *usage.lock() = Some(value);
                }
            }
            Ok(Some(StreamEvent::Error(e))) => {
                handle.abort();
                break Err(LlmError::StreamError(e));
            }
            Ok(Some(_)) => {}
        }
    };

    if outcome.is_err() {
        return outcome.map(|_| text);
    }

    let returned_usage = handle
        .await
        .map_err(|e| LlmError::StreamError(e.to_string()))??;
    if let Some(usage) = &usage {
        let mut recorded = usage.lock();
        if recorded.is_none() {
            *recorded = Some(returned_usage);
        }
    }
    Ok(text)
}

#[async_trait::async_trait]
impl Summarizer for ProviderSummarizer {
    async fn summarize(
        &self,
        messages: &[Message],
        budget_tokens: usize,
        previous_summary: Option<&str>,
    ) -> Result<String, SummarizeError> {
        self.attempted
            .store(true, std::sync::atomic::Ordering::Release);
        let llm_messages = build_summarization_messages(messages, previous_summary);
        complete_text_with_budget(
            self.provider.clone(),
            self.model.clone(),
            &llm_messages,
            Some(budget_tokens),
            self.context,
            Some(Arc::clone(&self.usage)),
        )
        .await
        .map_err(|e| SummarizeError::Llm(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::Usage;
    use crate::providers::{ModelInfo, ProviderInfo};
    use crate::types::ToolDefinition;
    use tokio::sync::{mpsc::Sender, Notify};

    struct Probe {
        info: ProviderInfo,
        started: Arc<Notify>,
        stopped: Arc<Notify>,
        stall: bool,
    }

    struct StopSignal(Arc<Notify>);
    impl Drop for StopSignal {
        fn drop(&mut self) {
            self.0.notify_one();
        }
    }

    #[async_trait::async_trait]
    impl Provider for Probe {
        fn info(&self) -> &ProviderInfo {
            &self.info
        }
        async fn list_models(&self) -> Result<Vec<ModelInfo>, LlmError> {
            Ok(self.info.models.clone())
        }
        async fn stream_completion(
            &self,
            _: &[Message],
            _: Option<&[ToolDefinition]>,
            model: &ModelInfo,
            sender: Sender<StreamEvent>,
            _context: RequestContext,
        ) -> Result<Usage, LlmError> {
            let _stop = StopSignal(self.stopped.clone());
            self.started.notify_one();
            if self.stall {
                std::future::pending::<()>().await;
            }
            assert_eq!(model.limits.output, 1800);
            assert!(!model.options.contains_key("max_tokens"));
            assert!(!model.options.contains_key("max_completion_tokens"));
            let _ = sender.send(StreamEvent::TextDelta("summary".into())).await;
            let usage = Usage {
                prompt_tokens: 80,
                completion_tokens: 20,
                total_tokens: 100,
                ..Default::default()
            };
            let _ = sender
                .send(StreamEvent::Done {
                    usage: usage.clone(),
                    stop_reason: crate::llm::StopReason::Stop,
                })
                .await;
            Ok(usage)
        }
    }

    fn probe(stall: bool) -> Arc<Probe> {
        Arc::new(Probe {
            info: ProviderInfo {
                models: vec![ModelInfo {
                    api: Default::default(),
                    id: "probe".into(),
                    name: "probe".into(),
                    api_id: "probe".into(),
                    provider_id: "probe".into(),
                    capabilities: Default::default(),
                    cost: Default::default(),
                    limits: crate::catalog::ModelLimits {
                        context: 8000,
                        output: 4096,
                        ..Default::default()
                    },
                    status: Default::default(),
                    headers: Default::default(),
                    options: [
                        ("max_tokens".into(), serde_json::json!(9999)),
                        ("max_completion_tokens".into(), serde_json::json!(9999)),
                    ]
                    .into(),
                    reasoning_options: vec![],
                    reasoning_stream_field: None,
                    compat: Default::default(),
                }],
                ..Default::default()
            },
            started: Arc::new(Notify::new()),
            stopped: Arc::new(Notify::new()),
            stall,
        })
    }

    #[tokio::test]
    async fn summary_budget_reaches_provider_without_mutating_catalog() {
        let provider = probe(false);
        let summarizer = ProviderSummarizer::new(
            provider.clone(),
            provider.info.models[0].clone(),
            RequestContext::new(uuid::Uuid::new_v4()),
        );
        let text = summarizer.summarize(&[], 1800, None).await.unwrap();
        assert_eq!(text, "summary");
        assert_eq!(summarizer.usage().unwrap().total_tokens, 100);
        assert_eq!(provider.info.models[0].limits.output, 4096);
    }

    #[tokio::test]
    async fn cancelling_collector_aborts_provider_request() {
        let provider = probe(true);
        let copy = provider.clone();
        let model = provider.info.models[0].clone();
        let task = tokio::spawn(async move {
            complete_text(copy, model, &[], RequestContext::new(uuid::Uuid::new_v4())).await
        });
        provider.started.notified().await;
        task.abort();
        let _ = task.await;
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            provider.stopped.notified(),
        )
        .await
        .expect("provider request leaked after cancellation");
    }
}
