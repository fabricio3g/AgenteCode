//! Exercise real HTTP serialization, SSE parsing and native tool continuation.
use super::*;
use crate::types::{FunctionCall, Role, ToolCall};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

fn read_request(socket: &mut std::net::TcpStream) -> (String, Value) {
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
        .unwrap_or(0);
    while bytes.len() < header_end + length {
        let n = socket.read(&mut buffer).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&buffer[..n]);
    }
    let body = if length == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
    };
    (headers, body)
}

fn sse_response(events: &[Value]) -> String {
    let sse = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", sse.len(), sse)
}

fn server(events: Vec<Value>) -> (String, std::sync::mpsc::Receiver<(String, Value)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let (headers, body) = read_request(&mut socket);
        tx.send((headers, body)).unwrap();
        write!(socket, "{}", sse_response(&events)).unwrap();
    });
    (url, rx)
}

/// Bounded server that fails if the transport sends fewer or more requests.
fn scripted_server(
    responses: Vec<String>,
) -> (
    String,
    std::sync::mpsc::Receiver<(String, Value)>,
    std::thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        for response in responses {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    result => panic!("expected request: {result:?}"),
                }
            };
            let request = read_request(&mut socket);
            tx.send(request).unwrap();
            write!(socket, "{response}").unwrap();
        }
        let deadline = std::time::Instant::now() + Duration::from_millis(40);
        while std::time::Instant::now() < deadline {
            assert!(
                matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
                "unexpected extra request"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    });
    (url, rx, handle)
}

fn error_response(status: u16, error: Value) -> String {
    let payload = error.to_string();
    format!("HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len())
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
fn google_budget_ladder_is_positive_and_off_uses_zero() {
    let mut model = model(ApiFormat::Google);
    model.reasoning_options = vec![ReasoningOption::BudgetTokens {
        min: Some(0),
        max: Some(8192),
    }];
    let profile = crate::thinking::profile_for(&model, ApiFormat::Google);
    assert_eq!(profile.levels[0].id, "off");
    let top = profile.levels.last().unwrap();
    assert!(top.budget_tokens.is_some_and(|b| b > 0 && b <= 8192));
    crate::thinking::apply_thinking_level(&mut model, ApiFormat::Google, &top.id);
    assert_eq!(
        model.options["thinkingConfig"]["thinkingBudget"],
        top.budget_tokens.unwrap()
    );
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

fn completion_events(format: ApiFormat) -> Vec<Value> {
    match format {
        ApiFormat::Anthropic => vec![
            json!({"type":"message_start","message":{"usage":{"input_tokens":10}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
            json!({"type":"message_stop"}),
        ],
        _ => vec![
            json!({"choices":[{"delta":{"content":"ok"}}]}),
            json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}),
        ],
    }
}

#[tokio::test]
async fn fallback_preserves_the_original_request_on_both_transports() {
    for format in [ApiFormat::OpenAI, ApiFormat::Anthropic] {
        let (url, requests, server) = scripted_server(vec![
            error_response(
                400,
                json!({"error":{"message":"The parameter cache_control is not supported for the requested model"}}),
            ),
            sse_response(&completion_events(format)),
        ]);
        let mut provider_info = info(url);
        provider_info.transport.cache.prompt_cache_key = Some(true);
        let provider = routed::RoutedProvider::new(provider_info, HashMap::new());
        let mut selected = model(format);
        selected.capabilities.toolcall = true;
        selected.options.insert("cache_control".into(), json!(true));
        selected.options.insert(
            "metadata".into(),
            json!({"cache_control":"keep", "nested":{"cache_control":{"type":"ephemeral"}}}),
        );
        let tools = [ToolDefinition {
            name: "inspect_header".into(),
            description: "Inspect caching".into(),
            parameters: json!({"type":"object","properties":{"cache_control":{"type":"string"}},"required":["cache_control"]}),
        }];
        let mut previous = Message::user("");
        previous.role = Role::Assistant;
        previous.tool_calls = Some(vec![ToolCall {
            id: "old-call".into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: "inspect_header".into(),
                arguments: json!({"cache_control":"retain-input"}).to_string(),
            },
        }]);
        previous.continuation = Some(crate::types::ProviderContinuation {
            provider_id: selected.provider_id.clone(),
            model_id: selected.api_id.clone(),
            blocks: if format == ApiFormat::Anthropic {
                vec![
                    json!({"type":"thinking","thinking":"inspect","signature":"signed","cache_control":"retain-continuation"}),
                    json!({"type":"tool_use","id":"old-call","name":"inspect_header","input":{"cache_control":"retain-input"}}),
                ]
            } else {
                vec![
                    json!({"type":"chat_completion","message":{"role":"assistant","content":"","tool_calls":previous.tool_calls,"reasoning_details":[{"cache_control":"retain-continuation"}]}}),
                ]
            },
        });
        let mut system = Message::user("instructions");
        system.role = Role::System;
        let messages = [system, previous, Message::user("inspect")];
        let session = uuid::Uuid::new_v4();
        let (tx, mut rx) = tokio::sync::mpsc::channel(128);
        let result = provider
            .stream_completion(
                &messages,
                Some(&tools),
                &selected,
                tx,
                RequestContext::new(session),
            )
            .await;
        while rx.recv().await.is_some() {}
        assert!(result.is_ok(), "{format:?}: {result:?}");
        server.join().unwrap();
        let (first_headers, first) = requests.recv().unwrap();
        let (second_headers, second) = requests.recv().unwrap();
        let stable_headers = |headers: &str| {
            headers
                .lines()
                .filter(|line| !line.starts_with("content-length:"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_eq!(
            stable_headers(&first_headers),
            stable_headers(&second_headers),
            "route/authentication must remain identical"
        );
        assert_eq!(first["tools"], second["tools"]);
        assert_eq!(first["metadata"], second["metadata"]);
        assert_eq!(first["prompt_cache_key"], session.to_string());
        assert_eq!(first["prompt_cache_key"], second["prompt_cache_key"]);
        assert_eq!(first["model"], second["model"]);
        let schema = if format == ApiFormat::Anthropic {
            &second["tools"][0]["input_schema"]
        } else {
            &second["tools"][0]["function"]["parameters"]
        };
        assert_eq!(schema["properties"]["cache_control"]["type"], "string");
        assert_eq!(schema["required"][0], "cache_control");
        if format == ApiFormat::Anthropic {
            assert_eq!(first["system"][0]["cache_control"]["type"], "ephemeral");
            assert_eq!(second["system"], "instructions");
            assert_eq!(
                second["messages"][0]["content"][1]["input"]["cache_control"],
                "retain-input"
            );
            assert_eq!(
                second["messages"][0]["content"][0]["cache_control"],
                "retain-continuation"
            );
        } else {
            assert_eq!(
                first["messages"][0]["content"][0]["cache_control"]["type"],
                "ephemeral"
            );
            assert_eq!(second["messages"][0]["content"], "instructions");
            assert_eq!(
                second["messages"][1]["tool_calls"][0]["function"]["arguments"],
                json!({"cache_control":"retain-input"}).to_string()
            );
            assert_eq!(
                second["messages"][1]["reasoning_details"][0]["cache_control"],
                "retain-continuation"
            );
        }
        assert!(requests.try_recv().is_err());
    }
}

#[tokio::test]
async fn retry_requires_an_explicit_unsupported_parameter_and_stops_after_one_attempt() {
    let unsupported = json!({"error":{"param":"cache_control","code":"unsupported_parameter"}});
    let cases = [
        (400, unsupported.clone(), true),
        (422, unsupported.clone(), true),
        (
            400,
            json!({"error":{"message":"Unsupported parameter: 'cache_control'."}}),
            true,
        ),
        (
            422,
            json!({"error":{"message":"The cache_control parameter is not supported"}}),
            true,
        ),
        (
            400,
            json!({"error":{"message":"cache_control has an invalid TTL"}}),
            false,
        ),
        (
            422,
            json!({"error":{"param":"other", "code":"unsupported_parameter", "message":"inspect cache_control"}}),
            false,
        ),
        (
            400,
            json!({"error":{"message":"Parameter cache_controlled is not supported"}}),
            false,
        ),
        (
            400,
            json!({"error":{"message":"Unsupported parameter: cache_controlled"}}),
            false,
        ),
        (401, unsupported.clone(), false),
        (403, unsupported.clone(), false),
        (429, unsupported.clone(), false),
        (500, unsupported.clone(), false),
        (503, unsupported, false),
    ];
    for format in [ApiFormat::OpenAI, ApiFormat::Anthropic] {
        for (status, error, retry) in &cases {
            let mut responses = vec![error_response(*status, error.clone())];
            if *retry {
                responses.push(error_response(*status, error.clone()));
            }
            let (url, requests, server) = scripted_server(responses);
            let provider = routed::RoutedProvider::new(info(url), HashMap::new());
            let mut selected = model(format);
            selected.options.insert("cache_control".into(), json!(true));
            let (tx, _rx) = tokio::sync::mpsc::channel(128);
            let result = provider
                .stream_completion(
                    &[Message::user("inspect")],
                    None,
                    &selected,
                    tx,
                    RequestContext::new(uuid::Uuid::new_v4()),
                )
                .await;
            assert!(result.is_err());
            assert!(result
                .unwrap_err()
                .to_string()
                .contains(&format!("HTTP {status}")));
            server.join().unwrap();
            assert_eq!(requests.try_iter().count(), if *retry { 2 } else { 1 });
        }
    }
}

#[tokio::test]
async fn schemas_and_user_annotations_alone_do_not_enable_a_retry() {
    for format in [ApiFormat::OpenAI, ApiFormat::Anthropic] {
        let (url, requests, server) = scripted_server(vec![error_response(
            400,
            json!({"error":{"param":"cache_control", "code":"unsupported_parameter"}}),
        )]);
        let provider = routed::RoutedProvider::new(info(url), HashMap::new());
        let mut selected = model(format);
        selected
            .options
            .insert("cache_control".into(), json!(false));
        selected.options.insert(
            "metadata".into(),
            json!({"cache_control":{"type":"ephemeral"}}),
        );
        selected.capabilities.toolcall = true;
        let tools = [ToolDefinition {
            name: "test".into(),
            description: "test".into(),
            parameters: json!({"type":"object", "properties":{"cache_control":{"type":"string"}}}),
        }];
        let (tx, _rx) = tokio::sync::mpsc::channel(128);
        assert!(provider
            .stream_completion(
                &[Message::user("inspect")],
                Some(&tools),
                &selected,
                tx,
                RequestContext::new(uuid::Uuid::new_v4())
            )
            .await
            .is_err());
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 1);
    }
}

#[tokio::test]
async fn network_and_stream_errors_are_not_retried() {
    for format in [ApiFormat::OpenAI, ApiFormat::Anthropic] {
        let (url, requests, server) = scripted_server(vec![sse_response(&[
            json!({"error":{"param":"cache_control", "code":"unsupported_parameter", "message":"The parameter cache_control is not supported"}}),
        ])]);
        let provider = routed::RoutedProvider::new(info(url), HashMap::new());
        let mut selected = model(format);
        selected.options.insert("cache_control".into(), json!(true));
        let (tx, _rx) = tokio::sync::mpsc::channel(128);
        assert!(provider
            .stream_completion(
                &[Message::user("inspect")],
                None,
                &selected,
                tx,
                RequestContext::new(uuid::Uuid::new_v4())
            )
            .await
            .is_err());
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 1);
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let mut selected = model(ApiFormat::OpenAI);
    selected.options.insert("cache_control".into(), json!(true));
    let request = super::cache::PreparedRequest::new(
        json!({"messages":[{"role":"user","content":"inspect"}]}),
        ApiFormat::OpenAI,
        &info(url.clone()),
        &selected,
    );
    assert!(super::send_with_cache_fallback(
        &info(url),
        &selected,
        "chat/completions",
        &request,
        RequestContext::new(uuid::Uuid::new_v4())
    )
    .await
    .is_err());
}

#[test]
fn declared_go_routes_and_aliases_use_the_shared_resolver_and_request_policy() {
    let config = crate::config::AppConfig::default();
    let registry = ProviderRegistry::from_config(&config);
    let provider = registry.get("opencode-go").unwrap();
    let declared = provider.info().transport_policy();
    assert!(!declared.model_routes.is_empty());
    for (id, expected) in &declared.model_routes {
        let selected = fallback_model_info("opencode-go", id);
        assert_eq!(
            provider.resolve_request_api_format(&selected).unwrap(),
            *expected
        );
        for provider_id in ["opencode-go", "desktop-opencode-go"] {
            let mut descriptor = provider.info().clone();
            descriptor.id = provider_id.into();
            let format = descriptor.resolve_format(&selected).unwrap();
            let prepared = super::cache::PreparedRequest::new(
                json!({"system":"instructions", "messages":[{"role":"user", "content":"inspect"}]}),
                format,
                &descriptor,
                &selected,
            );
            assert_eq!(
                prepared.uncached.is_some(),
                format == ApiFormat::Anthropic,
                "{provider_id}/{id}"
            );
            let session = uuid::Uuid::new_v4();
            assert_eq!(
                super::cache::prompt_cache_key(&descriptor, &selected, session),
                Some(session.to_string())
            );
        }
    }
    assert_eq!(
        declared.model_routes["longcat-2.5-preview-free"],
        ApiFormat::OpenAI
    );
    let unknown = resolve_model_info(&registry, None, "opencode-go", "future-model");
    assert!(unknown
        .api
        .route_error
        .unwrap()
        .contains("provider.opencode-go.models.future-model.provider.api_format"));
    assert_eq!(unknown.api.resolved_format, None);
}

#[test]
fn configured_routes_cache_and_refresh_override_live_catalog_and_defaults() {
    let catalog = ModelCatalog::parse_json(&json!({"opencode-go":{"id":"opencode-go", "models":{"future-model":{"name":"Future", "provider":{"api_format":"responses"}, "options":{"cache_control":false}}}}}).to_string()).unwrap();
    let mut config = crate::config::AppConfig::default();
    config.refresh_catalog(&catalog);
    let registry = ProviderRegistry::from_config(&config);
    let catalog_only = resolve_model_info(&registry, Some(&catalog), "opencode-go", "future-model");
    assert_eq!(catalog_only.api.resolved_format, Some(ApiFormat::Responses));
    assert_eq!(catalog_only.api.resolved_cache_control, Some(false));
    let mut live = fallback_model_info("opencode-go", "future-model");
    live.api.format = Some(ApiFormat::Anthropic);
    live.api.format_source = policy::MetadataSource::Live;
    live.api.cache_source = policy::MetadataSource::Live;
    live.options.insert("cache_control".into(), json!(true));
    let enriched = enrich_discovered_model(&live, &registry, Some(&catalog));
    assert_eq!(enriched.api.resolved_format, Some(ApiFormat::Anthropic));
    assert_eq!(enriched.options["cache_control"], true);
    config = config.merge(serde_json::from_value(json!({"provider":{"opencode-go":{"models":{"future-model":{"provider":{"api_format":"openai"},"options":{"cache_control":false}}}}}})).unwrap());
    config.refresh_catalog(&catalog);
    let rebuilt = ProviderRegistry::from_config(&config);
    let enriched = enrich_discovered_model(&live, &rebuilt, Some(&catalog));
    assert_eq!(enriched.api.resolved_format, Some(ApiFormat::OpenAI));
    assert_eq!(
        super::model_options(&enriched.options)["cache_control"],
        false
    );
    rebuilt.replace_runtime_models("opencode-go", vec![enriched]);
    let resolved = resolve_model_info(&rebuilt, Some(&catalog), "opencode-go", "future-model");
    assert_eq!(resolved.api.resolved_format, Some(ApiFormat::OpenAI));
    let loaded: crate::config::AppConfig =
        serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
    let from_disk = ProviderRegistry::from_config(&loaded);
    assert_eq!(
        resolve_model_info(&from_disk, None, "opencode-go", "future-model")
            .api
            .resolved_format,
        Some(ApiFormat::OpenAI)
    );
    let descriptor = from_disk.get("opencode-go").unwrap().info().clone();
    let mut alias = descriptor;
    alias.id = "desktop-opencode-go".into();
    assert_eq!(alias.resolve_format(&resolved).unwrap(), ApiFormat::OpenAI);
}

#[tokio::test]
async fn unseen_configured_model_uses_its_route_in_real_request_builders() {
    for format in [ApiFormat::OpenAI, ApiFormat::Anthropic] {
        let (url, request) = server(completion_events(format));
        let config: crate::config::AppConfig = serde_json::from_value(json!({"provider":{"gateway":{"api_format":"openai", "options":{"base_url":url, "api_key":"test-key"}, "transport":{"require_model_route":true,"cache":{"breakpoints":false}}, "models":{"future-model":{"provider":{"api_format":format},"options":{"cache_control":true}}}}}})).unwrap();
        let registry = ProviderRegistry::from_config(&config);
        registry.register_client_provider("gateway", &config.provider["gateway"], &config);
        let selected = resolve_model_info(&registry, None, "gateway", "future-model");
        assert_eq!(selected.api.resolved_format, Some(format));
        assert_eq!(
            crate::models::model_json(&selected)["transport"]["ready"],
            true
        );
        let (tx, mut rx) = tokio::sync::mpsc::channel(128);
        assert!(registry
            .get("gateway")
            .unwrap()
            .stream_completion(
                &[Message::user("inspect")],
                None,
                &selected,
                tx,
                RequestContext::new(uuid::Uuid::new_v4())
            )
            .await
            .is_ok());
        while rx.recv().await.is_some() {}
        let (headers, body) = request.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(headers.starts_with(if format == ApiFormat::Anthropic {
            "POST /messages "
        } else {
            "POST /chat/completions "
        }));
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
    }
}

#[tokio::test]
async fn unresolved_model_fails_before_any_http_request() {
    let (url, requests, handle) = scripted_server(vec![]);
    let mut descriptor = info(url);
    descriptor.transport.require_model_route = Some(true);
    let provider = routed::RoutedProvider::new(descriptor, HashMap::new());
    let selected = fallback_model_info("gateway", "future-model");
    let (tx, _rx) = tokio::sync::mpsc::channel(128);
    let error = provider
        .stream_completion(
            &[Message::user("inspect")],
            None,
            &selected,
            tx,
            RequestContext::new(uuid::Uuid::new_v4()),
        )
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("provider.gateway.models.future-model.provider.api_format"));
    handle.join().unwrap();
    assert_eq!(requests.try_iter().count(), 0);
}

#[tokio::test]
async fn discovery_keeps_unrouted_models_and_preserves_live_metadata() {
    let (url, requests, handle) = scripted_server(vec![error_response(
        200,
        json!({"data":[
            {"id":"future-model","api_format":"anthropic","cache_control":false},
            {"id":"unrouted-model"}
        ]}),
    )]);
    let mut descriptor = info(url);
    descriptor.transport.require_model_route = Some(true);
    let registry = ProviderRegistry::new();
    registry.register(
        "gateway",
        Arc::new(routed::RoutedProvider::new(descriptor, HashMap::new())),
    );
    let discovered = crate::models::discover(&registry, &registry, None, "gateway")
        .await
        .unwrap();
    handle.join().unwrap();
    assert_eq!(discovered.len(), 2);
    let live = discovered
        .iter()
        .find(|model| model.id == "future-model")
        .unwrap();
    assert_eq!(live.api.resolved_format, Some(ApiFormat::Anthropic));
    assert_eq!(live.api.resolved_cache_control, Some(false));
    let unresolved = discovered
        .iter()
        .find(|model| model.id == "unrouted-model")
        .unwrap();
    assert_eq!(
        crate::models::model_json(unresolved)["transport"]["ready"],
        false
    );
    assert!(unresolved.api.route_error.is_some());
    assert_eq!(
        resolve_model_info(&registry, None, "gateway", "future-model")
            .api
            .resolved_format,
        Some(ApiFormat::Anthropic)
    );
    let headers = requests.recv().unwrap().0;
    let mut request_line = headers.lines().next().unwrap().split_whitespace();
    assert_eq!(request_line.next(), Some("GET"));
    let target = request_line.next().unwrap().split('?').next().unwrap();
    assert!(target.ends_with("/models"), "{headers}");
    assert_eq!(request_line.next(), Some("HTTP/1.1"));
}

#[test]
fn registry_rebuild_discards_removed_overrides_but_keeps_live_routes() {
    let configured: crate::config::AppConfig = serde_json::from_value(json!({"provider":{"opencode-go":{"models":{"future-model":{"provider":{"api_format":"responses"},"options":{"cache_control":false}}}}}})).unwrap();
    let configured = crate::config::AppConfig::default().merge(configured);
    let registry = ProviderRegistry::from_config(&configured);
    let mut live = fallback_model_info("opencode-go", "future-model");
    live.api.format = Some(ApiFormat::Anthropic);
    live.api.format_source = policy::MetadataSource::Live;
    live.api.cache_source = policy::MetadataSource::Live;
    live.options.insert("cache_control".into(), json!(true));
    let resolved = enrich_discovered_model(&live, &registry, None);
    assert_eq!(resolved.api.resolved_format, Some(ApiFormat::Responses));
    let rebuilt = ProviderRegistry::from_config(&crate::config::AppConfig::default());
    rebuilt.replace_runtime_models("opencode-go", vec![resolved]);
    let restored = resolve_model_info(&rebuilt, None, "opencode-go", "future-model");
    assert_eq!(restored.api.resolved_format, Some(ApiFormat::Anthropic));
    assert_eq!(restored.api.resolved_cache_control, Some(true));
}

#[test]
fn provider_policy_overrides_are_partial_and_persist_without_losing_defaults() {
    let overrides: crate::config::AppConfig = serde_json::from_value(json!({"provider":{"openrouter":{"transport":{"cache":{"breakpoints":false}}},"opencode-go":{"transport":{"model_routes":{"future-model":"responses"},"cache":{"prompt_cache_key":false}}}}})).unwrap();
    let mut config = crate::config::AppConfig::default().merge(overrides);
    let catalog = ModelCatalog::parse_json(
        &json!({"opencode-go":{"id":"opencode-go","models":{"future-model":{"name":"Future"}}}})
            .to_string(),
    )
    .unwrap();
    config.refresh_catalog(&catalog);
    let saved = serde_json::to_string(&config).unwrap();
    let loaded = serde_json::from_str(&saved).unwrap();
    let registry = ProviderRegistry::from_config(&loaded);
    let go = registry.get("opencode-go").unwrap();
    let selected = resolve_model_info(&registry, None, "opencode-go", "future-model");
    assert_eq!(selected.api.resolved_format, Some(ApiFormat::Responses));
    assert_eq!(
        go.info().transport_policy().model_routes["minimax-m3"],
        ApiFormat::Anthropic
    );
    assert!(super::cache::prompt_cache_key(go.info(), &selected, uuid::Uuid::new_v4()).is_none());
    let metadata = crate::models::transport_json(&selected);
    let alias_config = serde_json::from_value(json!({
        "transport": metadata["policy"],
        "models": {"future-model": {"provider": {"api_format": metadata["api_format"]}}},
    }))
    .unwrap();
    let mut aliases = ProviderRegistry::new();
    aliases.register_client_provider(
        "desktop-opencode-go",
        &alias_config,
        &crate::config::AppConfig::default(),
    );
    let alias = aliases.get("desktop-opencode-go").unwrap();
    let selected = resolve_model_info(&aliases, None, "desktop-opencode-go", "future-model");
    assert_eq!(selected.api.resolved_format, Some(ApiFormat::Responses));
    assert!(
        super::cache::prompt_cache_key(alias.info(), &selected, uuid::Uuid::new_v4()).is_none()
    );
    let router = registry.get("openrouter").unwrap();
    let selected = fallback_model_info("openrouter", "anthropic/future");
    assert!(!router
        .info()
        .transport_policy()
        .breakpoints(ApiFormat::OpenAI, &selected));
}

#[tokio::test]
async fn cancellation_does_not_start_a_fallback_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (accepted, acceptance) = tokio::sync::oneshot::channel();
    let (release, ready) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        read_request(&mut socket);
        accepted.send(()).unwrap();
        ready.recv_timeout(Duration::from_secs(3)).unwrap();
        let _ = write!(
            socket,
            "{}",
            error_response(
                400,
                json!({"error":{"param":"cache_control", "code":"unsupported_parameter"}})
            )
        );
        listener.set_nonblocking(true).unwrap();
        std::thread::sleep(Duration::from_millis(40));
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
    });
    let mut selected = model(ApiFormat::OpenAI);
    selected.options.insert("cache_control".into(), json!(true));
    let task = tokio::spawn(async move {
        let provider = routed::RoutedProvider::new(info(url), HashMap::new());
        let (tx, _rx) = tokio::sync::mpsc::channel(128);
        provider
            .stream_completion(
                &[Message::user("inspect")],
                None,
                &selected,
                tx,
                RequestContext::new(uuid::Uuid::new_v4()),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), acceptance)
        .await
        .unwrap()
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    handle.join().unwrap();
}

#[tokio::test]
async fn session_cache_keys_follow_policy_on_every_transport() {
    for format in [
        ApiFormat::OpenAI,
        ApiFormat::Anthropic,
        ApiFormat::Responses,
        ApiFormat::Google,
    ] {
        for override_key in [None, Some("user-selected-cache")] {
            let (url, requests, server) = scripted_server(vec![sse_response(&[])]);
            let mut descriptor = info(url);
            descriptor.transport.cache.prompt_cache_key = Some(true);
            let provider = routed::RoutedProvider::new(descriptor, HashMap::new());
            let mut selected = model(format);
            if let Some(key) = override_key {
                selected
                    .options
                    .insert("prompt_cache_key".into(), json!(key));
            }
            let session = uuid::Uuid::new_v4();
            let (tx, _rx) = tokio::sync::mpsc::channel(128);
            let _ = provider
                .stream_completion(
                    &[Message::user("inspect")],
                    None,
                    &selected,
                    tx,
                    RequestContext::new(session),
                )
                .await;
            server.join().unwrap();
            let (_, request) = requests.recv().unwrap();
            assert_eq!(
                request["prompt_cache_key"],
                override_key.map_or_else(|| session.to_string(), str::to_owned)
            );
        }
    }
}

#[tokio::test]
async fn preexisting_annotations_do_not_enable_a_fallback_retry() {
    for format in [ApiFormat::OpenAI, ApiFormat::Anthropic] {
        let (url, requests, server) = scripted_server(vec![error_response(
            422,
            json!({"error":{"param":"cache_control","code":"unsupported_parameter"}}),
        )]);
        let descriptor = info(url);
        let mut selected = model(format);
        selected.options.insert("cache_control".into(), json!(true));
        let original = json!({
            "model": selected.api_id,
            "messages": [{"role":"user","content":[{"type":"text","text":"inspect","cache_control":{"type":"ephemeral","ttl":"1h"}}]}],
        });
        let request =
            super::cache::PreparedRequest::new(original.clone(), format, &descriptor, &selected);
        assert_eq!(request.body, original);
        assert!(request.uncached.is_none());
        assert!(super::send_with_cache_fallback(
            &descriptor,
            &selected,
            if format == ApiFormat::Anthropic {
                "messages"
            } else {
                "chat/completions"
            },
            &request,
            RequestContext::new(uuid::Uuid::new_v4()),
        )
        .await
        .is_err());
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 1);
    }
}

#[test]
fn refreshed_catalog_replaces_derived_transport_in_live_snapshots() {
    let old = ModelCatalog::parse_json(
        &json!({"opencode-go":{"id":"opencode-go","models":{"future-model":{"name":"Future","provider":{"api_format":"responses"},"options":{"cache_control":true}}}}})
            .to_string(),
    )
    .unwrap();
    let mut config = crate::config::AppConfig::default();
    config.refresh_catalog(&old);
    let registry = ProviderRegistry::from_config(&config);
    let snapshot = resolve_model_info(&registry, Some(&old), "opencode-go", "future-model");
    assert_eq!(snapshot.api.resolved_format, Some(ApiFormat::Responses));
    let fresh = ModelCatalog::parse_json(
        &json!({"opencode-go":{"id":"opencode-go","models":{"future-model":{"name":"Future"}}}})
            .to_string(),
    )
    .unwrap();
    config.refresh_catalog(&fresh);
    let rebuilt = ProviderRegistry::from_config(&config);
    rebuilt.replace_runtime_models("opencode-go", vec![snapshot]);
    let selected = resolve_model_info(&rebuilt, Some(&fresh), "opencode-go", "future-model");
    assert!(selected.api.route_error.is_some());
    assert!(selected.api.resolved_cache_control.is_none());
}
