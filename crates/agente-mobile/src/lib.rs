//! A narrow native boundary: cloud completions only, with no project, shell,
//! MCP or tool registry exposed to the mobile host.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use agente_core::config::AppConfig;
use agente_core::llm::{StopReason, StreamEvent};
use agente_core::providers::{spec, ModelInfo, ProviderRegistry, RequestContext};
use agente_protocol::{Message, ProviderContinuation, Role};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use uuid::Uuid;

#[cfg(target_os = "android")]
mod android;

const MAX_REQUEST_BYTES: usize = 512 * 1024;
const MAX_REPLY_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompletionRequest {
    pub session_id: Uuid,
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub messages: Vec<Message>,
}

impl CompletionRequest {
    pub fn parse(raw: &str) -> Result<Self, String> {
        if raw.len() > MAX_REQUEST_BYTES {
            return Err("This conversation is too large. Start a new conversation.".into());
        }
        let request: Self = serde_json::from_str(raw).map_err(|_| "Invalid completion request")?;
        if request.session_id.is_nil()
            || request.api_key.trim().is_empty()
            || request.model.trim().is_empty()
            || request.messages.is_empty()
            || request.messages.len() > 512
        {
            return Err("Choose a model and save its API key before sending.".into());
        }
        cloud_spec(&request.provider)?;
        if request.messages.iter().any(|message| {
            message.role == Role::Tool
                || message.tool_calls.is_some()
                || message.tool_call_id.is_some()
                || !message.attachments.is_empty()
        }) {
            return Err("This mobile build supports text conversations only.".into());
        }
        Ok(request)
    }
}

fn cloud_spec(id: &str) -> Result<&'static spec::ProviderSpec, String> {
    spec::get(id)
        .filter(|provider| provider.offered && provider.group == spec::ProviderGroup::Cloud)
        .ok_or_else(|| "Choose a supported online provider.".into())
}

/// Directory comes from the same TOML specs as Desktop; no Android provider list.
pub fn providers_json() -> String {
    let mut providers: Vec<_> = spec::all()
        .iter()
        .filter(|provider| provider.offered && provider.group == spec::ProviderGroup::Cloud)
        .collect();
    providers.sort_by_key(|provider| (provider.order, provider.id.as_str()));
    json!(providers
        .iter()
        .map(|provider| json!({
            "id": provider.id,
            "name": provider.name,
            "key_url": provider.key_url,
            "models": provider.models_seed.keys().collect::<Vec<_>>(),
        }))
        .collect::<Vec<_>>())
    .to_string()
}

fn registry(id: &str, key: &str) -> Result<ProviderRegistry, String> {
    let mut provider = cloud_spec(id)?.provider_config();
    provider.env.clear();
    provider.options.api_key = Some(key.to_owned());
    let mut config = AppConfig::default();
    config.provider.clear();
    config.provider.insert(id.to_owned(), provider);
    Ok(ProviderRegistry::from_config(&config))
}

fn model_cache() -> &'static Mutex<HashMap<(String, String), ModelInfo>> {
    static CACHE: OnceLock<Mutex<HashMap<(String, String), ModelInfo>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

pub async fn discover_json(provider: &str, key: &str) -> Result<String, String> {
    if key.trim().is_empty() {
        return Err("Save your API key before loading models.".into());
    }
    let registry = registry(provider, key)?;
    let models = agente_core::models::discover(&registry, &registry, None, provider).await?;
    let mut cache = model_cache()
        .lock()
        .map_err(|_| "Model cache unavailable")?;
    cache.retain(|(known, _), _| known != provider);
    for model in &models {
        cache.insert((provider.to_owned(), model.id.clone()), model.clone());
    }
    Ok(json!(models
        .iter()
        .map(agente_core::models::model_json)
        .collect::<Vec<_>>())
    .to_string())
}

/// Bounded output provides backpressure while the native UI is suspended.
/// Cancellation drops the provider future, aborting its HTTP stream.
pub async fn complete(request: CompletionRequest, output: mpsc::Sender<Value>) {
    if let Err(error) = complete_inner(request, &output).await {
        let _ = output.send(json!({"type":"error", "message":error})).await;
    }
}

async fn complete_inner(
    request: CompletionRequest,
    output: &mpsc::Sender<Value>,
) -> Result<(), String> {
    let registry = registry(&request.provider, &request.api_key)?;
    let provider = registry
        .get(&request.provider)
        .ok_or("Provider unavailable")?;
    let model = model_cache()
        .lock()
        .map_err(|_| "Model cache unavailable")?
        .get(&(request.provider.clone(), request.model.clone()))
        .cloned()
        .unwrap_or_else(|| {
            agente_core::providers::resolve_model_info(
                &registry,
                None,
                &request.provider,
                &request.model,
            )
        });
    provider
        .resolve_request_api_format(&model)
        .map_err(|e| e.to_string())?;
    let (sender, receiver) = mpsc::channel(64);
    let stream = provider.stream_completion(
        &request.messages,
        None,
        &model,
        sender,
        RequestContext::new(request.session_id),
    );
    forward_stream(stream, receiver, output, &request.api_key).await
}

async fn forward_stream(
    stream: impl std::future::Future<
        Output = Result<agente_core::llm::Usage, agente_core::llm::LlmError>,
    >,
    mut receiver: mpsc::Receiver<StreamEvent>,
    output: &mpsc::Sender<Value>,
    api_key: &str,
) -> Result<(), String> {
    tokio::pin!(stream);
    let mut completed = false;
    let mut drained = false;
    let mut stop = StopReason::Unknown;
    let mut continuation: Option<ProviderContinuation> = None;
    let mut signature = None;
    let mut reply_bytes = 0;
    let mut usage = None;
    loop {
        if completed && drained {
            break;
        }
        tokio::select! {
            result = &mut stream, if !completed => {
                let reported = result.map_err(|error| {
                    // Provider error bodies may reflect credentials; never display them.
                    let text = agente_core::util::redact_secrets(&error.to_string());
                    text.replace(api_key, "[redacted]")
                })?;
                usage = Some(reported);
                completed = true;
            }
            event = receiver.recv(), if !drained => {
                let Some(event) = event else { drained = true; continue; };
                let value = match event {
                    StreamEvent::TextDelta(text) => {
                        reply_bytes += text.len();
                        if reply_bytes > MAX_REPLY_BYTES { return Err("Reply exceeded the mobile size limit.".into()); }
                        json!({"type":"text", "text":text})
                    }
                    StreamEvent::ReasoningDelta(text) => {
                        reply_bytes += text.len();
                        if reply_bytes > MAX_REPLY_BYTES { return Err("Reply exceeded the mobile size limit.".into()); }
                        json!({"type":"reasoning", "text":text})
                    }
                    StreamEvent::Done { stop_reason, .. } => { stop = stop_reason; continue; }
                    StreamEvent::Continuation(value) => { continuation = Some(value); continue; }
                    StreamEvent::ThinkingSignature(value) => { signature = Some(value); continue; }
                    StreamEvent::Error(error) => return Err(agente_core::util::redact_secrets(&error).replace(api_key, "[redacted]")),
                    StreamEvent::ToolCallStart { .. } => return Err("This conversation requested a tool unavailable on Android.".into()),
                    _ => continue,
                };
                output.send(value).await.map_err(|_| "Conversation closed")?;
            }
        }
    }
    let usage = usage.ok_or("Provider disconnected before completing the reply")?;
    let done = matches!(stop, StopReason::Stop | StopReason::Length);
    output.send(json!({
        "type":"done", "complete":done,
        "stop_reason": format!("{stop:?}").to_lowercase(),
        "continuation":continuation, "thinking_signature":signature,
        "usage": {"prompt_tokens":usage.prompt_tokens, "completion_tokens":usage.completion_tokens,
            "cache_read_tokens":usage.cache_read_tokens, "cache_creation_tokens":usage.cache_creation_tokens,
            "cost_usd":usage.cost_usd}
    })).await.map_err(|_| "Conversation closed")?;
    Ok(())
}

pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("mobile runtime")
    })
}

struct Running {
    receiver: mpsc::Receiver<Value>,
    task: tokio::task::JoinHandle<()>,
}

fn runs() -> &'static Mutex<HashMap<Uuid, Running>> {
    static RUNS: OnceLock<Mutex<HashMap<Uuid, Running>>> = OnceLock::new();
    RUNS.get_or_init(Mutex::default)
}

pub fn start(raw: &str) -> Result<String, String> {
    let request = CompletionRequest::parse(raw)?;
    let mut runs = runs().lock().map_err(|_| "Runtime unavailable")?;
    if !runs.is_empty() {
        return Err("Finish or stop the current reply first.".into());
    }
    let id = Uuid::new_v4();
    let (output, receiver) = mpsc::channel(64);
    let task = runtime().spawn(complete(request, output));
    runs.insert(id, Running { receiver, task });
    Ok(id.to_string())
}

pub fn poll(id: &str) -> Result<String, String> {
    let id = Uuid::parse_str(id).map_err(|_| "Invalid turn")?;
    let mut runs = runs().lock().map_err(|_| "Runtime unavailable")?;
    let run = runs.get_mut(&id).ok_or("Turn already closed")?;
    let mut events = VecDeque::new();
    while let Ok(event) = run.receiver.try_recv() {
        events.push_back(event);
    }
    if events.is_empty() && run.task.is_finished() {
        // A panic/aborted task must not leave a spinner running forever.
        events.push_back(
            json!({"type":"error", "message":"Reply interrupted. You can send another message."}),
        );
    }
    Ok(json!(events).to_string())
}

pub fn cancel(id: &str) {
    if let Ok(id) = Uuid::parse_str(id) {
        if let Ok(mut runs) = runs().lock() {
            if let Some(run) = runs.remove(&id) {
                run.task.abort();
            }
        }
    }
}

/// Validate/import causal metadata using the same reducer on each host.
pub fn merge_sync_json(local: &str, incoming: &str) -> Result<String, String> {
    let parse = |raw: &str| -> Result<Vec<agente_sync::Revision>, String> {
        if raw.len() > 4 * 1024 * 1024 {
            return Err("Sync batch exceeds the size limit".into());
        }
        serde_json::from_str(raw).map_err(|_| "Invalid sync batch".into())
    };
    let mut replica = agente_sync::Replica::default();
    replica
        .apply_batch(parse(local)?)
        .map_err(|e| e.to_string())?;
    replica
        .apply_batch(parse(incoming)?)
        .map_err(|e| e.to_string())?;
    Ok(json!(replica.revisions().collect::<Vec<_>>()).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_directory_never_offers_local_process_services_or_credentials() {
        let directory: Value = serde_json::from_str(&providers_json()).unwrap();
        assert!(!directory.as_array().unwrap().is_empty());
        for entry in directory.as_array().unwrap() {
            assert!(cloud_spec(entry["id"].as_str().unwrap()).is_ok());
            assert!(entry.get("api_key").is_none());
        }
        assert!(cloud_spec("llamacpp").is_err());
    }

    #[test]
    fn native_boundary_rejects_project_tool_history_and_missing_credentials() {
        let mut request = json!({"session_id":Uuid::new_v4(), "provider":"deepseek",
            "model":"deepseek-flash", "api_key":"test", "messages":[{"role":"user","content":"hi"}]});
        assert!(CompletionRequest::parse(&request.to_string()).is_ok());
        request["messages"][0]["role"] = json!("tool");
        assert!(CompletionRequest::parse(&request.to_string()).is_err());
        request["messages"][0]["role"] = json!("user");
        request["api_key"] = json!("");
        assert!(CompletionRequest::parse(&request.to_string()).is_err());
    }

    #[tokio::test]
    async fn streamed_reasoning_is_separate_and_terminal_events_are_drained() {
        let (sender, receiver) = mpsc::channel(8);
        let (output, mut events) = mpsc::channel(8);
        let stream = async move {
            sender
                .send(StreamEvent::ReasoningDelta("private thought".into()))
                .await
                .unwrap();
            sender
                .send(StreamEvent::TextDelta("answer".into()))
                .await
                .unwrap();
            sender
                .send(StreamEvent::ThinkingSignature("signature".into()))
                .await
                .unwrap();
            sender
                .send(StreamEvent::Done {
                    usage: Default::default(),
                    stop_reason: StopReason::Stop,
                })
                .await
                .unwrap();
            Ok(Default::default())
        };
        forward_stream(stream, receiver, &output, "secret")
            .await
            .unwrap();
        assert_eq!(events.try_recv().unwrap()["type"], "reasoning");
        assert_eq!(events.try_recv().unwrap()["text"], "answer");
        let done = events.try_recv().unwrap();
        assert_eq!(done["type"], "done");
        assert_eq!(done["complete"], true);
        assert_eq!(done["thinking_signature"], "signature");
    }

    #[tokio::test]
    async fn unannounced_stream_end_is_incomplete_and_provider_errors_redact_keys() {
        let (sender, receiver) = mpsc::channel(8);
        let (output, mut events) = mpsc::channel(8);
        let stream = async move {
            drop(sender);
            Ok(Default::default())
        };
        forward_stream(stream, receiver, &output, "credential-value")
            .await
            .unwrap();
        assert_eq!(events.try_recv().unwrap()["complete"], false);

        let (sender, receiver) = mpsc::channel(8);
        let stream = async move {
            sender
                .send(StreamEvent::Error("echo credential-value".into()))
                .await
                .unwrap();
            Ok(Default::default())
        };
        let error = forward_stream(stream, receiver, &output, "credential-value")
            .await
            .unwrap_err();
        assert!(!error.contains("credential-value"));
    }
}
