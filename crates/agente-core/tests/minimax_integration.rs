//! Integration test for MiniMax provider connection.
//! Run with: MINIMAX_API_KEY=... cargo test --package agente-core --test minimax_integration -- --nocapture

use agente_core::providers::ProviderRegistry;

#[tokio::test]
async fn test_minimax_connection() {
    let api_key = std::env::var("MINIMAX_API_KEY").unwrap_or_default();
    if api_key.is_empty() {
        eprintln!("Skipping MiniMax integration test: no API key set");
        return;
    }

    std::env::set_var("MINIMAX_API_KEY", &api_key);

    let registry = ProviderRegistry::default();
    let provider = registry.get("minimax-coding-plan");
    assert!(provider.is_some(), "MiniMax provider not found in registry");

    let provider = provider.unwrap();
    let info = provider.info();
    eprintln!("Provider: {} ({})", info.name, info.id);
    eprintln!("Base URL: {}", info.base_url);
    eprintln!("Env keys: {:?}", info.env_keys);

    let resolved_key = info.resolve_api_key();
    assert!(resolved_key.is_some(), "API key not resolved");
    eprintln!("API key resolved: {}...", &resolved_key.unwrap()[..8]);

    // List models
    match provider.list_models().await {
        Ok(models) => {
            eprintln!("Listed {} models:", models.len());
            for m in models.iter().take(5) {
                eprintln!("  - {} ({})", m.id, m.name);
            }
            assert!(!models.is_empty(), "No models found");
        }
        Err(e) => {
            panic!("Model listing failed: {e}");
        }
    }
}

#[tokio::test]
async fn test_minimax_streaming() {
    let api_key = std::env::var("MINIMAX_API_KEY").unwrap_or_default();
    if api_key.is_empty() {
        eprintln!("Skipping MiniMax streaming test: no API key set");
        return;
    }

    std::env::set_var("MINIMAX_API_KEY", &api_key);

    let registry = ProviderRegistry::default();
    let provider = registry.get("minimax-coding-plan").unwrap();

    let models = provider.list_models().await.expect("list_models failed");
    // Try different models — some API keys don't have access to all models
    let model = models
        .iter()
        .find(|m| m.id == "MiniMax-M2")
        .or_else(|| models.iter().find(|m| m.id == "MiniMax-M2.5"))
        .or_else(|| models.iter().find(|m| m.id == "MiniMax-Text-01"))
        .or_else(|| models.first())
        .expect("no models")
        .clone();
    eprintln!("Using model: {} ({})", model.id, model.name);

    let messages = vec![
        agente_core::types::Message {
            role: agente_core::types::Role::System,
            content: "You are a helpful assistant. Reply with exactly one word.".to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
        },
        agente_core::types::Message {
            role: agente_core::types::Role::User,
            content: "Say hello".to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
        },
    ];

    let tools: Vec<agente_core::types::ToolDefinition> = vec![];
    let (tx, mut rx) = tokio::sync::mpsc::channel::<agente_core::llm::StreamEvent>(64);

    let stream_handle = tokio::spawn(async move {
        let mut received_text = String::new();
        let mut done = false;
        while let Some(event) = rx.recv().await {
            match event {
                agente_core::llm::StreamEvent::TextDelta(text) => {
                    received_text.push_str(&text);
                    eprint!("{text}");
                }
                agente_core::llm::StreamEvent::Done { .. } => {
                    done = true;
                    break;
                }
                agente_core::llm::StreamEvent::Error(msg) => {
                    panic!("Stream error: {msg}");
                }
                _ => {}
            }
        }
        (received_text, done)
    });

    let result = provider
        .stream_completion(&messages, Some(&tools), &model, tx)
        .await;
    if let Err(e) = result {
        let err_str = format!("{e:?}");
        if err_str.contains("overloaded") || err_str.contains("529") {
            eprintln!("MiniMax API is overloaded — skipping streaming test");
            return;
        }
        if err_str.contains("not support model") || err_str.contains("plan not support") {
            eprintln!(
                "API key does not have access to model {} — skipping streaming test",
                model.id
            );
            return;
        }
        panic!("Stream setup failed: {e:?}");
    }

    let (received_text, done) = stream_handle.await.expect("stream task panicked");
    eprintln!("\nReceived: '{}'", received_text.trim());
    assert!(!received_text.is_empty(), "No text received from stream");
    assert!(done, "Stream did not send Done event");
}
