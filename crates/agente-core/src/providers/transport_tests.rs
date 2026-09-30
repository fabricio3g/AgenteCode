//! Exercise real HTTP serialization, SSE parsing and native tool continuation.
use super::*;
use crate::types::{FunctionCall, Role, ToolCall};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

fn server(events: Vec<Value>) -> (String, std::sync::mpsc::Receiver<(String, Value)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        let header_end = loop {
            let n = socket.read(&mut buffer).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buffer[..n]);
            if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
        let length: usize = headers
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().unwrap())
            })
            .unwrap();
        while bytes.len() < header_end + length {
            let n = socket.read(&mut buffer).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buffer[..n]);
        }
        let body = serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
        tx.send((headers, body)).unwrap();
        let sse = events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect::<String>();
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", sse.len(), sse).unwrap();
    });
    (url, rx)
}

fn info(url: String) -> ProviderInfo {
    ProviderInfo {
        id: "gateway".into(),
        name: "Fixture".into(),
        base_url: url,
        api_key: Some("test-key".into()),
        ..Default::default()
    }
}

#[test]
fn opencode_requests_have_stable_session_headers_only_on_opencode() {
    let session = uuid::Uuid::new_v4();
    for provider in [
        "opencode-go",
        "opencode",
        "opencode-zen",
        "desktop-opencode-go",
        "desktop-opencode",
        "desktop-opencode-zen",
        "openrouter",
        "desktop-openrouter",
        "openai",
    ] {
        let mut info = info(if super::canonical_provider_id(provider) == "opencode-go" {
            "https://opencode.ai/zen/go/v1".into()
        } else {
            "http://localhost/v1".into()
        });
        info.id = provider.into();
        let request = super::wire::completion_request(
            &info,
            &model(ApiFormat::OpenAI),
            "chat/completions",
            &json!({}),
            RequestContext::new(session),
        )
        .unwrap()
        .build()
        .unwrap();
        let header = request.headers().get("x-opencode-session");
        if super::canonical_provider_id(provider).starts_with("opencode") {
            assert_eq!(header.unwrap().to_str().unwrap(), session.to_string());
            let fallback = super::wire::session_header(provider, None).unwrap();
            assert!(!uuid::Uuid::parse_str(&fallback).unwrap().is_nil());
            assert_eq!(Some(fallback), super::wire::session_header(provider, None));
        } else {
            assert!(header.is_none());
        }
    }
}

#[test]
fn partial_provider_config_keeps_native_format_and_model_overrides_survive_cache() {
    let overrides: crate::config::AppConfig = serde_json::from_value(json!({
        "provider":{"minimax":{"options":{"timeout":30000}}}
    }))
    .unwrap();
    let config = crate::config::AppConfig::default().merge(overrides);
    assert_eq!(
        ProviderRegistry::from_config(&config)
            .get("minimax")
            .unwrap()
            .info()
            .api_format,
        ApiFormat::Anthropic
    );
    let catalog = ModelCatalog::parse_json(
        &json!({
            "openrouter":{"id":"openrouter","models":{
                "fixture":{"id":"fixture","name":"Fixture","reasoning":true,
                    "provider":{"npm":"@ai-sdk/openai","api":"http://model-override"},
                    "reasoning_options":[{"type":"effort","values":[null,"high"]}]}
            }}
        })
        .to_string(),
    )
    .unwrap();
    let cached = ModelCatalog::parse_json(&serde_json::to_string(&catalog).unwrap()).unwrap();
    let mut config = crate::config::AppConfig::default();
    config.refresh_catalog(&cached);
    config
        .provider
        .get_mut("openrouter")
        .unwrap()
        .models
        .get_mut("fixture")
        .unwrap()
        .options
        .insert("temperature".into(), json!(0.2));
    config.refresh_catalog(&cached);
    let registry = ProviderRegistry::from_config(&config);
    let model = resolve_model_info(&registry, config.catalog.as_ref(), "openrouter", "fixture");
    assert_eq!(model.api.format, Some(ApiFormat::Responses));
    assert_eq!(model.api.base_url.as_deref(), Some("http://model-override"));
    assert_eq!(model.options["temperature"], 0.2);
    assert_eq!(
        crate::thinking::supported_thinking_levels(&model),
        vec!["off", "high"]
    );
    assert!(cached.find_model("other-host", "fixture").is_none());
}

fn model(format: ApiFormat) -> ModelInfo {
    let mut model = fallback_model_info("gateway", "reasoner");
    model.api.format = Some(format);
    model.capabilities.reasoning = true;
    model.reasoning_options = vec![ReasoningOption::Effort {
        values: vec!["low".into(), "high".into()],
    }];
    crate::thinking::apply_thinking_level(&mut model, format, "high");
    model
}

#[test]
fn google_on_uses_positive_budget_and_off_uses_zero() {
    let mut model = model(ApiFormat::Google);
    model.reasoning_options = vec![ReasoningOption::BudgetTokens {
        min: Some(0),
        max: Some(8192),
    }];
    crate::thinking::apply_thinking_level(&mut model, ApiFormat::Google, "on");
    assert_eq!(model.options["thinkingConfig"]["thinkingBudget"], 8192);
    crate::thinking::apply_thinking_level(&mut model, ApiFormat::Google, "off");
    assert_eq!(model.options["thinkingConfig"]["thinkingBudget"], 0);
}

async fn request(
    format: ApiFormat,
    events: Vec<Value>,
) -> (String, Value, Vec<StreamEvent>, Result<Usage, LlmError>) {
    request_for("gateway", format, events).await
}

async fn request_for(
    provider_id: &str,
    format: ApiFormat,
    events: Vec<Value>,
) -> (String, Value, Vec<StreamEvent>, Result<Usage, LlmError>) {
    let (url, request) = server(events);
    let mut provider_info = info(url);
    provider_info.id = provider_id.into();
    let provider = routed::RoutedProvider::new(provider_info, HashMap::new());
    let (tx, mut rx) = tokio::sync::mpsc::channel(128);
    let mut selected_model = model(format);
    selected_model.provider_id = provider_id.into();
    let result = provider
        .stream_completion(
            &[Message::user("inspect")],
            Some(&[ToolDefinition {
                name: "read".into(),
                description: "Read file".into(),
                parameters: json!({"type":"object","properties":{"path":{"type":"string"}}}),
            }]),
            &selected_model,
            tx,
            RequestContext::new(uuid::Uuid::new_v4()),
        )
        .await;
    let mut events = Vec::new();
    while let Some(event) = rx.recv().await {
        events.push(event);
    }
    let (headers, body) = request.recv_timeout(Duration::from_secs(10)).unwrap();
    (headers, body, events, result)
}

#[tokio::test]
async fn openrouter_preserves_model_specific_response_routing() {
    let (headers, body, _, result) = request_for(
        "openrouter",
        ApiFormat::Responses,
        vec![json!({"type":"response.completed","response":{"output":[],"usage":{"input_tokens":2,"output_tokens":1}}})],
    )
    .await;
    assert!(result.is_ok(), "{result:?}");
    assert!(headers.starts_with("POST /responses "));
    assert_eq!(body["model"], "reasoner");
}

fn transcript(events: &[StreamEvent]) -> Message {
    let mut message = Message::user("");
    message.role = Role::Assistant;
    let mut calls: Vec<ToolCall> = Vec::new();
    for event in events {
        match event {
            StreamEvent::TextDelta(text) => message.content.push_str(text),
            StreamEvent::ReasoningDelta(text) => {
                message.thinking.get_or_insert_default().push_str(text)
            }
            StreamEvent::ToolCallStart { id, name } => calls.push(ToolCall {
                id: id.clone(),
                call_type: "function".into(),
                function: FunctionCall {
                    name: name.clone(),
                    arguments: String::new(),
                },
            }),
            StreamEvent::ToolCallDelta { id, args_delta } => calls
                .iter_mut()
                .find(|c| &c.id == id)
                .unwrap()
                .function
                .arguments
                .push_str(args_delta),
            StreamEvent::Continuation(value) => message.continuation = Some(value.clone()),
            _ => {}
        }
    }
    if !calls.is_empty() {
        message.tool_calls = Some(calls);
    }
    message
}

#[tokio::test]
async fn responses_routes_effort_and_replays_encrypted_reasoning_with_call_id() {
    let reasoning = json!({"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"Inspect first"}],"encrypted_content":"opaque"});
    let call = json!({"type":"function_call","id":"fc_item","call_id":"call_real","name":"read","arguments":"{\"path\":\"src\"}"});
    let (headers, body, events, result) = request(ApiFormat::Responses, vec![
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_item","call_id":"call_real","name":"read","arguments":""}}),
        json!({"type":"response.function_call_arguments.delta","item_id":"fc_item","delta":"{\"path\":\"src\"}"}),
        json!({"type":"response.output_item.done","output_index":1,"item":call}),
        json!({"type":"response.completed","response":{"output":[reasoning,call],"usage":{"input_tokens":12,"output_tokens":7,"input_tokens_details":{"cached_tokens":3}}}}),
    ]).await;
    assert!(result.is_ok(), "{result:?}");
    assert!(headers.starts_with("POST /responses "));
    assert!(headers
        .to_lowercase()
        .contains("authorization: bearer test-key"));
    assert_eq!(body["reasoning"]["effort"], "high");
    assert_eq!(body["reasoning"]["summary"], "auto");
    assert_eq!(body["store"], false);
    assert_eq!(body["tools"][0]["name"], "read");
    let message = transcript(&events);
    assert_eq!(message.thinking.as_deref(), Some("Inspect first"));
    assert_eq!(message.tool_calls.as_ref().unwrap()[0].id, "call_real");
    assert_eq!(
        message.tool_calls.as_ref().unwrap()[0].function.arguments,
        "{\"path\":\"src\"}"
    );
    let provider = responses::ResponsesProvider::from_info(info("http://unused".into()));
    let replay = provider.request_body(
        std::slice::from_ref(&message),
        None,
        &model(ApiFormat::Responses),
    );
    assert_eq!(replay["input"][0]["encrypted_content"], "opaque");
    assert_eq!(replay["input"][1]["call_id"], "call_real");
    assert!(replay["input"][1].get("id").is_none());
    let mut compacted = message;
    compacted.tool_calls = None;
    let replay = provider.request_body(&[compacted], None, &model(ApiFormat::Responses));
    assert!(!replay.to_string().contains("opaque"));
}

#[tokio::test]
async fn messages_preserves_each_signature_and_tool_input() {
    let (headers, body, events, result) = request(ApiFormat::Anthropic, vec![
        json!({"type":"message_start","message":{"usage":{"input_tokens":10}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Inspect first"}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-a"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque"}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_real","name":"read","input":{}}}),
        json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"src\"}"}}),
        json!({"type":"content_block_stop","index":2}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}),
        json!({"type":"message_stop"}),
    ]).await;
    assert!(result.is_ok(), "{result:?}");
    assert!(headers.starts_with("POST /messages "));
    assert!(headers.to_lowercase().contains("x-api-key: test-key"));
    assert_eq!(body["thinking"]["type"], "enabled");
    assert_eq!(body["tools"][0]["name"], "read");
    let message = transcript(&events);
    assert_eq!(message.thinking.as_deref(), Some("Inspect first"));
    let replay = messages::MessagesProvider::from_info(info("http://unused".into())).request_body(
        &[message],
        None,
        &model(ApiFormat::Anthropic),
    );
    assert_eq!(replay["messages"][0]["content"][0]["signature"], "sig-a");
    assert_eq!(replay["messages"][0]["content"][1]["data"], "opaque");
    assert_eq!(replay["messages"][0]["content"][2]["input"]["path"], "src");
}

#[tokio::test]
async fn google_preserves_thought_signatures_and_function_results() {
    let (headers, body, events, result) = request(ApiFormat::Google, vec![
        json!({"candidates":[{"content":{"parts":[{"thought":true,"text":"Inspect first"},{"functionCall":{"name":"read","args":{"path":"src"}},"thoughtSignature":"opaque"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"thoughtsTokenCount":4}}),
    ]).await;
    assert!(result.is_ok(), "{result:?}");
    assert!(headers.starts_with("POST /models/reasoner:streamGenerateContent?alt=sse "));
    assert!(headers.to_lowercase().contains("x-goog-api-key: test-key"));
    assert_eq!(
        body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
        "HIGH"
    );
    let message = transcript(&events);
    assert_eq!(message.thinking.as_deref(), Some("Inspect first"));
    let mut output = Message::user("file contents");
    output.role = Role::Tool;
    output.tool_call_id = Some(message.tool_calls.as_ref().unwrap()[0].id.clone());
    let replay = google::GoogleProvider::from_info(info("http://unused".into()))
        .request_body(&[message, output], None, &model(ApiFormat::Google))
        .unwrap();
    assert_eq!(
        replay["contents"][0]["parts"][1]["thoughtSignature"],
        "opaque"
    );
    assert_eq!(
        replay["contents"][1]["parts"][0]["functionResponse"]["name"],
        "read"
    );
}

#[tokio::test]
async fn chat_preserves_structured_reasoning_and_arguments_before_tool_name() {
    let (headers, body, events, result) = request(ApiFormat::OpenAI, vec![
        json!({"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","index":0,"text":"Inspect ","id":"r1"}],"tool_calls":[{"index":0,"id":"call_real","function":{"arguments":"{\"path\":"}}]}}]}),
        json!({"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","index":0,"text":"first"}],"tool_calls":[{"index":0,"function":{"name":"read","arguments":"\"src\"}"}}]}}]}),
        json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":7}}),
    ]).await;
    assert!(result.is_ok(), "{result:?}");
    assert!(headers.starts_with("POST /chat/completions "));
    assert_eq!(body["reasoning_effort"], "high");
    let message = transcript(&events);
    assert_eq!(message.thinking.as_deref(), Some("Inspect first"));
    assert_eq!(
        message.tool_calls.as_ref().unwrap()[0].function.arguments,
        "{\"path\":\"src\"}"
    );
    let blocks = replay_blocks(
        &message,
        &info("http://unused".into()),
        &model(ApiFormat::OpenAI),
        "chat",
    )
    .unwrap();
    assert_eq!(
        blocks[0]["message"]["reasoning_details"][0]["text"],
        "Inspect first"
    );
}

#[tokio::test]
async fn every_transport_rejects_stream_errors_and_early_eof() {
    for format in [
        ApiFormat::OpenAI,
        ApiFormat::Responses,
        ApiFormat::Anthropic,
        ApiFormat::Google,
    ] {
        for events in [vec![json!({"error":{"message":"upstream failed"}})], vec![]] {
            let (_, _, events, result) = request(format, events).await;
            assert!(result.is_err(), "{format:?} accepted incomplete stream");
            assert!(!events.iter().any(|e| matches!(e, StreamEvent::Done { .. })));
        }
    }
}

#[tokio::test]
async fn anthropic_requests_carry_rolling_cache_breakpoints() {
    let (_, body, _, result) = request(ApiFormat::Anthropic, vec![
        json!({"type":"message_start","message":{"usage":{"input_tokens":4,"cache_read_input_tokens":90,"cache_creation_input_tokens":6}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
        json!({"type":"message_stop"}),
    ])
    .await;
    let usage = result.expect("stream completes");
    assert_eq!(
        body["messages"][0]["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
    assert_eq!(usage.cache_read_tokens, 90);
    assert_eq!(usage.cache_creation_tokens, 6);
}

#[tokio::test]
async fn deepseek_cache_hits_are_counted_and_auto_caching_needs_no_markers() {
    let (_, body, _, result) = request_for("deepseek", ApiFormat::OpenAI, vec![
        json!({"choices":[{"delta":{"content":"ok"}}]}),
        json!({"choices":[{"delta":{},"finish_reason":"stop"}],
               "usage":{"prompt_tokens":100,"completion_tokens":2,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}),
    ])
    .await;
    let usage = result.expect("stream completes");
    assert_eq!(usage.cache_read_tokens, 80, "DeepSeek hits were read as 0");
    assert_eq!(usage.prompt_tokens, 20, "uncached remainder only");
    assert!(
        body["messages"][0]["content"].is_string(),
        "no cache_control for auto-caching APIs"
    );
}

#[tokio::test]
async fn openrouter_claude_routes_get_explicit_breakpoints() {
    let (url, request) = server(vec![
        json!({"choices":[{"delta":{"content":"ok"}}]}),
        json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}),
    ]);
    let mut provider_info = info(url);
    provider_info.id = "openrouter".into();
    let provider = routed::RoutedProvider::new(provider_info, HashMap::new());
    let (tx, mut rx) = tokio::sync::mpsc::channel(128);
    let mut selected = model(ApiFormat::OpenAI);
    selected.provider_id = "openrouter".into();
    selected.api_id = "anthropic/claude-sonnet-4".into();
    let system = Message {
        role: crate::types::Role::System,
        content: "You are Agente".into(),
        ..Message::user("")
    };
    let result = provider
        .stream_completion(
            &[system, Message::user("inspect")],
            None,
            &selected,
            tx,
            RequestContext::new(uuid::Uuid::new_v4()),
        )
        .await;
    while rx.recv().await.is_some() {}
    assert!(result.is_ok(), "{result:?}");
    let (_, body) = request.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(
        body["messages"][0]["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
    assert_eq!(body["messages"][1]["content"][0]["text"], "inspect");
    assert_eq!(
        body["messages"][1]["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
    assert!(
        body.get("cache_control").is_none(),
        "control knob never hits the wire"
    );
}

/// BYOK: `cost` is OpenRouter's fee; the provider bills the rest, reported
/// as `cost_details.upstream_inference_cost`. The spend is their sum.
#[tokio::test]
async fn openrouter_byok_cost_adds_the_upstream_charge() {
    let (_, _, _, result) = request_for(
        "openrouter",
        ApiFormat::OpenAI,
        vec![
            json!({"choices":[{"delta":{"content":"ok"}}]}),
            json!({"choices":[{"delta":{},"finish_reason":"stop"}],
               "usage":{"prompt_tokens":1200,"completion_tokens":40,"cost":0.0001,
                        "cost_details":{"upstream_inference_cost":0.0019}}}),
        ],
    )
    .await;
    let usage = result.expect("stream completes");
    let cost = usage.cost_usd.expect("reported");
    assert!((cost - 0.002).abs() < 1e-12, "{cost}");
}

#[tokio::test]
async fn openrouter_reported_cost_reaches_usage() {
    let (_, body, _, result) = request_for(
        "openrouter",
        ApiFormat::OpenAI,
        vec![
            json!({"choices":[{"delta":{"content":"ok"}}]}),
            json!({"choices":[{"delta":{},"finish_reason":"stop"}],
               "usage":{"prompt_tokens":1200,"completion_tokens":40,"cost":0.00217,
                        "prompt_tokens_details":{"cached_tokens":1000}}}),
        ],
    )
    .await;
    let usage = result.expect("stream completes");
    assert_eq!(usage.cost_usd, Some(0.00217), "provider's own charge");
    assert_eq!(usage.cache_read_tokens, 1000);
    assert!(
        body.get("usage").is_none(),
        "deprecated usage.include is not sent"
    );
}

#[test]
fn opencode_go_gets_a_session_cache_key_and_breakpoints() {
    // The Go endpoint itself is pinned (keys never leave opencode.ai), so
    // this checks the request decisions rather than a mock round-trip.
    let mut go = model(ApiFormat::OpenAI);
    go.provider_id = "opencode-go".into();
    let session = uuid::Uuid::new_v4();
    assert_eq!(
        super::cache::prompt_cache_key("opencode-go", &go, session),
        Some(session.to_string())
    );
    assert!(super::cache::wants_breakpoints(false, "opencode-go", &go));
    assert_eq!(
        super::cache::prompt_cache_key("desktop-opencode-go", &go, session),
        Some(session.to_string())
    );
    assert!(super::cache::wants_breakpoints(
        false,
        "desktop-opencode-go",
        &go
    ));
    assert_eq!(
        super::cache::prompt_cache_key("deepseek", &go, session),
        None
    );
    assert!(!super::cache::wants_breakpoints(false, "deepseek", &go));
}
