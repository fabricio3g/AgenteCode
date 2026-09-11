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
            "opencode":{"id":"opencode","models":{
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
        .get_mut("opencode")
        .unwrap()
        .models
        .get_mut("fixture")
        .unwrap()
        .options
        .insert("temperature".into(), json!(0.2));
    config.refresh_catalog(&cached);
    let registry = ProviderRegistry::from_config(&config);
    let model = resolve_model_info(&registry, config.catalog.as_ref(), "opencode", "fixture");
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
    let (url, request) = server(events);
    let provider = routed::RoutedProvider::new(info(url), HashMap::new());
    let (tx, mut rx) = tokio::sync::mpsc::channel(128);
    let result = provider
        .stream_completion(
            &[Message::user("inspect")],
            Some(&[ToolDefinition {
                name: "read".into(),
                description: "Read file".into(),
                parameters: json!({"type":"object","properties":{"path":{"type":"string"}}}),
            }]),
            &model(format),
            tx,
        )
        .await;
    let mut events = Vec::new();
    while let Some(event) = rx.recv().await {
        events.push(event);
    }
    let (headers, body) = request.recv_timeout(Duration::from_secs(10)).unwrap();
    (headers, body, events, result)
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
    let replay = provider.request_body(&[message.clone()], None, &model(ApiFormat::Responses));
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
