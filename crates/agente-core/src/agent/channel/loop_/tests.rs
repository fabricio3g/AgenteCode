use super::todo_review::should_review_todos;
use super::*;
use crate::agent::channel::approval::check_missing_args;
use crate::agent::channel::args::{normalize_tool_args, parse_tool_args};
use crate::catalog::{ModelCapabilities, ModelCost, ModelLimits, ModelStatus};
use crate::providers::ModelInfo;
use crate::thinking::apply_thinking_level;
use crate::types::{FunctionCall, ToolCall};

#[test]
fn todo_review_is_bounded_and_respects_stop_plan_and_terminal_statuses() {
    let todo = |status: &str| crate::todo::TodoInput {
        content: "Task".into(),
        status: status.into(),
        priority: "medium".into(),
    };
    let pending = vec![todo("pending")];
    assert!(should_review_todos(
        Some(&pending),
        false,
        false,
        false,
        true
    ));
    assert!(!should_review_todos(
        Some(&pending),
        true,
        false,
        false,
        true
    ));
    assert!(!should_review_todos(
        Some(&pending),
        false,
        true,
        false,
        true
    ));
    assert!(!should_review_todos(
        Some(&pending),
        false,
        false,
        true,
        true
    ));
    assert!(!should_review_todos(
        Some(&pending),
        false,
        false,
        false,
        false
    ));
    assert!(!should_review_todos(
        Some(&[todo("completed"), todo("cancelled")]),
        false,
        false,
        false,
        true
    ));
    assert!(!should_review_todos(None, false, false, false, true));
}

fn reasoning_model() -> ModelInfo {
    use crate::catalog::ReasoningOption;
    ModelInfo {
        api: Default::default(),
        id: "reasoning-model".to_string(),
        name: "Reasoning Model".to_string(),
        api_id: "reasoning-model".to_string(),
        provider_id: "test".to_string(),
        capabilities: ModelCapabilities {
            reasoning: true,
            ..Default::default()
        },
        cost: ModelCost::default(),
        limits: ModelLimits {
            context: 128_000,
            input: None,
            output: 16_384,
        },
        status: ModelStatus::Active,
        headers: std::collections::HashMap::new(),
        options: std::collections::HashMap::new(),
        reasoning_options: vec![
            ReasoningOption::Toggle,
            ReasoningOption::Effort {
                values: vec!["high".into(), "max".into()],
            },
        ],
        reasoning_stream_field: None,
        compat: crate::thinking::ThinkingFormat::Default,
    }
}

#[test]
fn applies_catalog_thinking_levels_verbatim() {
    use crate::providers::ApiFormat;
    use crate::thinking::THINKING_OFF;
    let mut openai = reasoning_model();
    apply_thinking_level(&mut openai, ApiFormat::OpenAI, "max");
    assert_eq!(
        openai.options.get("reasoning_effort"),
        Some(&serde_json::json!("max"))
    );

    let mut anthropic = reasoning_model();
    apply_thinking_level(&mut anthropic, ApiFormat::Anthropic, "high");
    assert_eq!(anthropic.options["thinking"]["type"], "enabled");
    assert_eq!(anthropic.options["output_config"]["effort"], "high");

    apply_thinking_level(&mut openai, ApiFormat::OpenAI, THINKING_OFF);
    assert!(!openai.options.contains_key("reasoning_effort"));
}

#[test]
fn normalizes_write_file_aliases() {
    let args = serde_json::json!({
        "filePath": "src/main.rs",
        "fileContent": "fn main() {}"
    });
    let normalized = normalize_tool_args("write_file", args);
    assert_eq!(
        normalized.get("path").and_then(|v| v.as_str()),
        Some("src/main.rs")
    );
    assert_eq!(
        normalized.get("content").and_then(|v| v.as_str()),
        Some("fn main() {}")
    );
    assert!(check_missing_args("call_1", "write_file", &normalized).is_none());
}

#[test]
fn normalizes_nested_tool_arguments() {
    let args = serde_json::json!({
        "input": {
            "filename": "hello.txt",
            "contents": "hello"
        }
    });
    let normalized = normalize_tool_args("write_file", args);
    assert_eq!(
        normalized.get("path").and_then(|v| v.as_str()),
        Some("hello.txt")
    );
    assert_eq!(
        normalized.get("content").and_then(|v| v.as_str()),
        Some("hello")
    );
    assert!(check_missing_args("call_1", "write_file", &normalized).is_none());
}

#[test]
fn parses_double_encoded_tool_arguments() {
    let parsed = parse_tool_args(r#""{\"path\":\"a.txt\",\"content\":\"ok\"}""#);
    let normalized = normalize_tool_args("write_file", parsed);
    assert_eq!(
        normalized.get("path").and_then(|v| v.as_str()),
        Some("a.txt")
    );
    assert_eq!(
        normalized.get("content").and_then(|v| v.as_str()),
        Some("ok")
    );
    assert!(check_missing_args("call_1", "write_file", &normalized).is_none());
}

#[test]
fn reports_missing_write_file_fields() {
    let args = serde_json::json!({"content": "missing path"});
    let outcome = check_missing_args("call_1", "write_file", &args).unwrap();
    assert_eq!(outcome.tool_call_id, "call_1");
    assert!(outcome.content.contains("path"));
}

#[test]
fn recovers_write_file_with_literal_newlines() {
    let raw = "{\"path\": \"game.js\", \"content\": \"const a = 1;\nconst b = 2;\n\"}";
    let parsed = parse_tool_args(raw);
    let normalized = normalize_tool_args("write_file", parsed);
    assert_eq!(
        normalized.get("path").and_then(|v| v.as_str()),
        Some("game.js")
    );
    assert_eq!(
        normalized.get("content").and_then(|v| v.as_str()),
        Some("const a = 1;\nconst b = 2;\n")
    );
    assert!(check_missing_args("call_1", "write_file", &normalized).is_none());
}

#[test]
fn recovers_unterminated_large_write_content() {
    let raw = "{\"path\": \"game.js\", \"content\": \"const canvas = document.getElementById('game');\nfunction loop() { requestAnimationFrame(loop); }";
    let parsed = parse_tool_args(raw);
    let normalized = normalize_tool_args("write_file", parsed);
    assert_eq!(
        normalized.get("path").and_then(|v| v.as_str()),
        Some("game.js")
    );
    assert!(normalized
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .contains("requestAnimationFrame"));
    assert!(check_missing_args("call_1", "write_file", &normalized).is_none());
}

#[test]
fn send_event_tags_task_id() {
    let (tx, rx) = std::sync::mpsc::channel();
    send_event(&tx, 42, AgentEvent::Thinking);
    let msg = rx.recv().unwrap();
    assert_eq!(msg.task_id, 42);
    assert!(matches!(msg.event, AgentEvent::Thinking));
}

struct OverflowThenOkProvider {
    info: crate::providers::ProviderInfo,
    calls: std::sync::Mutex<u32>,
    first_error: &'static str,
    fail_calls: u32,
    partial_event: Option<crate::llm::StreamEvent>,
}

#[async_trait::async_trait]
impl crate::providers::Provider for OverflowThenOkProvider {
    fn info(&self) -> &crate::providers::ProviderInfo {
        &self.info
    }

    async fn stream_completion(
        &self,
        _messages: &[Message],
        _tools: Option<&[crate::types::ToolDefinition]>,
        _model: &crate::providers::ModelInfo,
        sender: tokio::sync::mpsc::Sender<crate::llm::StreamEvent>,
        _context: crate::providers::RequestContext,
    ) -> Result<crate::llm::Usage, crate::llm::LlmError> {
        let first_call = {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            *calls <= self.fail_calls
        };
        if first_call {
            if let Some(event) = &self.partial_event {
                sender.send(event.clone()).await.ok();
            }
            return Err(crate::llm::LlmError::StreamError(
                self.first_error.to_string(),
            ));
        }
        sender
            .send(crate::llm::StreamEvent::TextDelta("recovered".to_string()))
            .await
            .ok();
        sender
            .send(crate::llm::StreamEvent::Done {
                usage: crate::llm::Usage::default(),
                stop_reason: crate::llm::StopReason::Stop,
            })
            .await
            .ok();
        Ok(crate::llm::Usage::default())
    }

    async fn list_models(&self) -> Result<Vec<crate::providers::ModelInfo>, crate::llm::LlmError> {
        Ok(Vec::new())
    }
}

struct MidTurnProvider {
    info: crate::providers::ProviderInfo,
    inbox: super::super::config::UserInbox,
    seen: std::sync::Mutex<Vec<Vec<String>>>,
    interrupt_first: bool,
    live_settings: Option<crate::permissions::SharedPermissionEngine>,
    levels: std::sync::Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl crate::providers::Provider for MidTurnProvider {
    fn info(&self) -> &crate::providers::ProviderInfo {
        &self.info
    }

    async fn stream_completion(
        &self,
        messages: &[Message],
        _tools: Option<&[crate::types::ToolDefinition]>,
        _model: &crate::providers::ModelInfo,
        sender: tokio::sync::mpsc::Sender<crate::llm::StreamEvent>,
        _context: crate::providers::RequestContext,
    ) -> Result<crate::llm::Usage, crate::llm::LlmError> {
        self.levels.lock().unwrap().push(
            _model
                .options
                .get("reasoning_effort")
                .and_then(|v| v.as_str())
                .unwrap_or("none")
                .to_string(),
        );
        let call = {
            let mut seen = self.seen.lock().unwrap();
            seen.push(messages.iter().map(|m| m.content.clone()).collect());
            seen.len()
        };
        if call == 1 {
            if self.interrupt_first {
                sender
                    .send(crate::llm::StreamEvent::ReasoningDelta(
                        "unfinished reasoning".into(),
                    ))
                    .await
                    .ok();
                sender
                    .send(crate::llm::StreamEvent::TextDelta("partial answer".into()))
                    .await
                    .ok();
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            if let Some(engine) = &self.live_settings {
                engine
                    .write()
                    .unwrap()
                    .set_mode(crate::types::AgentMode::Plan);
                self.inbox.update_settings(Some("high".into()));
            } else {
                self.inbox
                    .lock()
                    .push(Message::user("also update the docs"));
            }
            if self.interrupt_first {
                self.inbox.interrupt_thinking();
                std::future::pending::<()>().await;
            }
        }
        if self.interrupt_first {
            assert!(
                messages
                    .iter()
                    .all(|message| message.thinking_signature.is_none()
                        && message.continuation.is_none()),
                "interrupted provider state must not be replayed"
            );
        }
        let text = if call == 1 {
            "first answer"
        } else {
            "docs updated"
        };
        sender
            .send(crate::llm::StreamEvent::TextDelta(text.to_string()))
            .await
            .ok();
        sender
            .send(crate::llm::StreamEvent::Done {
                usage: crate::llm::Usage::default(),
                stop_reason: crate::llm::StopReason::Stop,
            })
            .await
            .ok();
        Ok(crate::llm::Usage::default())
    }

    async fn list_models(&self) -> Result<Vec<crate::providers::ModelInfo>, crate::llm::LlmError> {
        Ok(Vec::new())
    }
}

#[tokio::test]
async fn send_now_interrupts_an_unfinished_completion_and_keeps_the_turn() {
    use crate::cancellation::AbortController;
    use crate::permissions::{shared_permission_engine, ApprovalBroker};

    let inbox = super::super::config::UserInbox::default();
    let registry = Arc::new(ProviderRegistry::new());
    let provider = Arc::new(MidTurnProvider {
        info: crate::providers::ProviderInfo {
            id: "test-overflow".into(),
            models: vec![overflow_test_model()],
            ..Default::default()
        },
        inbox: Arc::clone(&inbox),
        seen: std::sync::Mutex::new(Vec::new()),
        interrupt_first: true,
        live_settings: None,
        levels: Default::default(),
    });
    registry.register("test-overflow", provider.clone());
    let (tx, rx) = std::sync::mpsc::channel();
    let config = AgentRunConfig {
        session_id: uuid::Uuid::new_v4(),
        task_id: 1,
        sender: tx,
        messages: vec![Message::user("fix the parser")],
        provider_id: "test-overflow".into(),
        model: "stub-model".into(),
        thinking_level: "off".into(),
        project_dir: ".".into(),
        max_iterations: Some(5),
        registry,
        catalog: None,
        permission_engine: shared_permission_engine(AgentMode::Build),
        cancel_signal: AbortController::new().signal(),
        approval_broker: ApprovalBroker::new(),
        mcp_manager: None,
        subagent_host: None,
        custom_agents: Vec::new(),
        tool_policy: None,
        is_subagent: false,
        depth: 0,
        loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
        loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
        smart_compaction: false,
        compaction_model: None,
        user_inbox: Some(Arc::clone(&inbox)),
        extra_tools: Vec::new(),
        only_tools: None,
        shell_env: Default::default(),
        initial_gap: 0,
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), run_agent_loop(config))
        .await
        .expect("steering must not wait for the old completion")
        .expect("turn completes");

    let seen = provider.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "the turn went on instead of finishing");
    assert_eq!(
        seen[1][seen[1].len() - 2..],
        [
            "partial answer".to_string(),
            "also update the docs".to_string()
        ],
        "the message joins after the reply it arrived during"
    );
    assert!(inbox.lock().is_empty(), "taken from the inbox");
    let events: Vec<AgentTaskEvent> = rx.try_iter().collect();
    assert!(events.iter().any(|e| matches!(
        &e.event,
        AgentEvent::UserMessagesInjected { messages } if messages == &["also update the docs"]
    )));
    let done = events
        .iter()
        .find_map(|e| match &e.event {
            AgentEvent::Done { conversation, .. } => Some(conversation.clone()),
            _ => None,
        })
        .expect("Done");
    assert_eq!(done.last().unwrap().content, "docs updated");
}

#[tokio::test]
async fn active_thinking_and_plan_controls_restart_a_stalled_request() {
    use crate::cancellation::AbortController;
    use crate::permissions::{shared_permission_engine, ApprovalBroker};

    let inbox = super::super::config::UserInbox::default();
    let permissions = shared_permission_engine(AgentMode::Build);
    let registry = Arc::new(ProviderRegistry::new());
    let provider = Arc::new(MidTurnProvider {
        info: crate::providers::ProviderInfo {
            id: "test-overflow".into(),
            models: vec![overflow_test_model()],
            ..Default::default()
        },
        inbox: Arc::clone(&inbox),
        seen: std::sync::Mutex::new(Vec::new()),
        interrupt_first: true,
        live_settings: Some(permissions.clone()),
        levels: Default::default(),
    });
    registry.register("test-overflow", provider.clone());
    let (tx, rx) = std::sync::mpsc::channel();
    let config = AgentRunConfig {
        session_id: uuid::Uuid::new_v4(),
        task_id: 1,
        sender: tx,
        messages: vec![Message::user("fix the parser")],
        provider_id: "test-overflow".into(),
        model: "stub-model".into(),
        thinking_level: "off".into(),
        project_dir: ".".into(),
        max_iterations: Some(5),
        registry,
        catalog: None,
        permission_engine: permissions.clone(),
        cancel_signal: AbortController::new().signal(),
        approval_broker: ApprovalBroker::new(),
        mcp_manager: None,
        subagent_host: None,
        custom_agents: Vec::new(),
        tool_policy: None,
        is_subagent: false,
        depth: 0,
        loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
        loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
        smart_compaction: false,
        compaction_model: None,
        user_inbox: Some(Arc::clone(&inbox)),
        extra_tools: Vec::new(),
        only_tools: None,
        shell_env: Default::default(),
        initial_gap: 0,
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), run_agent_loop(config))
        .await
        .expect("steering must not wait for the old completion")
        .expect("turn completes");

    let seen = provider.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "the turn went on instead of finishing");
    assert_eq!(provider.levels.lock().unwrap()[1], "high");
    assert_eq!(permissions.read().unwrap().mode, AgentMode::Plan);
    assert!(
        seen[1].iter().any(|text| text.contains("PLAN mode")),
        "request must contain the new plan restriction"
    );
    assert!(
        rx.try_iter()
            .all(|event| !matches!(event.event, AgentEvent::UserMessagesInjected { .. })),
        "control changes do not invent user prompts"
    );
}

#[tokio::test]
async fn messages_sent_mid_turn_join_the_same_turn() {
    use crate::cancellation::AbortController;
    use crate::permissions::{shared_permission_engine, ApprovalBroker};

    let inbox = super::super::config::UserInbox::default();
    let registry = Arc::new(ProviderRegistry::new());
    let provider = Arc::new(MidTurnProvider {
        info: crate::providers::ProviderInfo {
            id: "test-overflow".into(),
            models: vec![overflow_test_model()],
            ..Default::default()
        },
        inbox: Arc::clone(&inbox),
        seen: std::sync::Mutex::new(Vec::new()),
        interrupt_first: false,
        live_settings: None,
        levels: Default::default(),
    });
    registry.register("test-overflow", provider.clone());
    let (tx, rx) = std::sync::mpsc::channel();
    let config = AgentRunConfig {
        session_id: uuid::Uuid::new_v4(),
        task_id: 1,
        sender: tx,
        messages: vec![Message::user("fix the parser")],
        provider_id: "test-overflow".into(),
        model: "stub-model".into(),
        thinking_level: "off".into(),
        project_dir: ".".into(),
        max_iterations: Some(5),
        registry,
        catalog: None,
        permission_engine: shared_permission_engine(AgentMode::Build),
        cancel_signal: AbortController::new().signal(),
        approval_broker: ApprovalBroker::new(),
        mcp_manager: None,
        subagent_host: None,
        custom_agents: Vec::new(),
        tool_policy: None,
        is_subagent: false,
        depth: 0,
        loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
        loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
        smart_compaction: false,
        compaction_model: None,
        user_inbox: Some(Arc::clone(&inbox)),
        extra_tools: Vec::new(),
        only_tools: None,
        shell_env: Default::default(),
        initial_gap: 0,
    };
    run_agent_loop(config).await.expect("turn completes");

    let seen = provider.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "the turn went on instead of finishing");
    assert_eq!(
        seen[1][seen[1].len() - 2..],
        [
            "first answer".to_string(),
            "also update the docs".to_string()
        ],
        "the message joins after the reply it arrived during"
    );
    assert!(inbox.lock().is_empty(), "taken from the inbox");
    let events: Vec<AgentTaskEvent> = rx.try_iter().collect();
    assert!(events.iter().any(|e| matches!(
        &e.event,
        AgentEvent::UserMessagesInjected { messages } if messages == &["also update the docs"]
    )));
    let done = events
        .iter()
        .find_map(|e| match &e.event {
            AgentEvent::Done { conversation, .. } => Some(conversation.clone()),
            _ => None,
        })
        .expect("Done");
    assert_eq!(done.last().unwrap().content, "docs updated");
}

fn overflow_test_model() -> crate::providers::ModelInfo {
    let mut model = reasoning_model();
    model.id = "stub-model".to_string();
    model.api_id = "stub-model".to_string();
    model.name = "Stub Model".to_string();
    model.provider_id = "test-overflow".to_string();
    model.limits.context = 8_000;
    model
}

fn tool_result_message(id: &str, lines: usize) -> Vec<Message> {
    let body: String = (0..lines)
        .map(|i| format!("src/file{i}.rs:1:match some_identifier_{id}_{i}\n"))
        .collect();
    vec![
        Message {
            role: Role::Assistant,
            content: String::new(),
            tool_calls: Some(vec![ToolCall {
                id: id.to_string(),
                call_type: "function".to_string(),
                function: FunctionCall {
                    name: "grep".to_string(),
                    arguments: "{}".to_string(),
                },
            }]),
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        },
        Message {
            role: Role::Tool,
            content: body,
            tool_calls: None,
            tool_call_id: Some(id.to_string()),
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        },
    ]
}

#[tokio::test]
async fn provider_overflow_compacts_and_retries_the_turn() {
    use crate::cancellation::AbortController;
    use crate::permissions::{shared_permission_engine, ApprovalBroker};

    let dir = std::env::temp_dir().join(format!("agente-overflow-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();

    let mut messages = vec![Message {
        role: Role::System,
        content: "system prompt".to_string(),
        tool_calls: None,
        tool_call_id: None,
        thinking: None,
        thinking_signature: None,
        continuation: None,
        attachments: Vec::new(),
    }];
    for i in 0..5 {
        messages.extend(tool_result_message(&format!("c{i}"), 100));
    }
    messages.push(Message {
        role: Role::User,
        content: "go".to_string(),
        tool_calls: None,
        tool_call_id: None,
        thinking: None,
        thinking_signature: None,
        continuation: None,
        attachments: Vec::new(),
    });
    let estimate = crate::context::estimate_message_tokens(&messages);
    let mut model = overflow_test_model();
    model.limits.context = (estimate * 16 / 10) as u32;
    model.limits.output = 0;
    let registry = Arc::new(ProviderRegistry::new());
    let provider = Arc::new(OverflowThenOkProvider {
        info: crate::providers::ProviderInfo {
            id: "test-overflow".to_string(),
            name: "Test Overflow".to_string(),
            models: vec![model],
            ..Default::default()
        },
        calls: std::sync::Mutex::new(0),
        first_error: "The request is 265713 tokens long and exceeds this model's context length of 262144 tokens (context_length_exceeded)",
        fail_calls: 1,
        partial_event: None,
    });
    registry.register("test-overflow", provider.clone());
    let original_chars: usize = messages.iter().map(|m| m.content.len()).sum();

    let (tx, rx) = std::sync::mpsc::channel();
    let config = AgentRunConfig {
        session_id: uuid::Uuid::new_v4(),
        task_id: 1,
        sender: tx,
        messages,
        provider_id: "test-overflow".to_string(),
        model: "stub-model".to_string(),
        thinking_level: "off".to_string(),
        project_dir: dir.to_string_lossy().to_string(),
        max_iterations: Some(5),
        registry,
        catalog: None,
        permission_engine: shared_permission_engine(AgentMode::Build),
        cancel_signal: AbortController::new().signal(),
        approval_broker: ApprovalBroker::new(),
        mcp_manager: None,
        subagent_host: None,
        custom_agents: Vec::new(),
        tool_policy: None,
        is_subagent: false,
        depth: 0,
        loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
        loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
        smart_compaction: false,
        compaction_model: None,
        user_inbox: None,
        extra_tools: Vec::new(),
        only_tools: Some(Vec::new()),
        shell_env: Default::default(),
        initial_gap: 0,
    };
    run_agent_loop(config).await.expect("turn recovers");

    assert_eq!(
        *provider.calls.lock().unwrap(),
        2,
        "one overflow, one retry"
    );
    let events: Vec<AgentTaskEvent> = rx.try_iter().collect();
    assert!(
        events.iter().any(|e| matches!(
            &e.event,
            AgentEvent::ContextCompacted { summary, .. }
                if summary.contains("Provider reported context overflow")
        )),
        "recovery must emit ContextCompacted"
    );
    let done = events.iter().find_map(|e| match &e.event {
        AgentEvent::Done { conversation, .. } => Some(conversation),
        _ => None,
    });
    let conversation = done.expect("turn ends Done after recovery");
    let compacted_chars: usize = conversation.iter().map(|m| m.content.len()).sum();
    assert!(
        compacted_chars < original_chars,
        "Done transcript must be the compacted one"
    );
    assert!(
        conversation.iter().any(|m| m.content.contains("recovered")),
        "model answer must be present"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn interrupted_chat_stream_retries_and_delivers_the_answer() {
    let (calls, result, events) =
        failure_turn("Chat stream ended before completion", 1, None).await;
    result.expect("transient stream recovers");
    assert_eq!(calls, 2);
    assert!(events
        .iter()
        .any(|event| matches!(event, AgentEvent::Retry { .. })));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::Done { conversation, .. } if conversation.last().is_some_and(|message| message.content == "recovered"))));
}

#[tokio::test]
async fn transient_retries_are_bounded_and_stop_after_any_output() {
    let error = r#"openrouter: {"code":502,"message":"Provider returned an empty response"}"#;
    let (calls, result, events) = failure_turn(error, 10, None).await;
    assert!(result.is_err());
    assert_eq!(calls, 3, "initial request plus two retries");
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, AgentEvent::Retry { .. }))
            .count(),
        2
    );
    for event in [
        crate::llm::StreamEvent::TextDelta("partial".into()),
        crate::llm::StreamEvent::ReasoningDelta("thinking".into()),
        crate::llm::StreamEvent::ToolCallStart {
            name: "read".into(),
            id: "call".into(),
        },
    ] {
        let (calls, result, events) = failure_turn(error, 1, Some(event)).await;
        assert!(result.is_err());
        assert_eq!(calls, 1, "partial output must never be replayed");
        assert!(!events
            .iter()
            .any(|event| matches!(event, AgentEvent::Retry { .. })));
    }
}

async fn failure_turn(
    first_error: &'static str,
    fail_calls: u32,
    partial_event: Option<crate::llm::StreamEvent>,
) -> (u32, Result<(), AgentLoopFailure>, Vec<AgentEvent>) {
    use crate::cancellation::AbortController;
    use crate::permissions::{shared_permission_engine, ApprovalBroker};

    let registry = Arc::new(ProviderRegistry::new());
    let provider = Arc::new(OverflowThenOkProvider {
        info: crate::providers::ProviderInfo {
            id: "test-overflow".into(),
            models: vec![overflow_test_model()],
            ..Default::default()
        },
        calls: std::sync::Mutex::new(0),
        first_error,
        fail_calls,
        partial_event,
    });
    registry.register("test-overflow", provider.clone());
    let (tx, rx) = std::sync::mpsc::channel();
    let config = AgentRunConfig {
        session_id: uuid::Uuid::new_v4(),
        task_id: 1,
        sender: tx,
        messages: vec![Message::user("Say recovered")],
        provider_id: "test-overflow".into(),
        model: "stub-model".into(),
        thinking_level: "off".into(),
        project_dir: ".".into(),
        max_iterations: Some(5),
        registry,
        catalog: None,
        permission_engine: shared_permission_engine(AgentMode::Plan),
        cancel_signal: AbortController::new().signal(),
        approval_broker: ApprovalBroker::new(),
        mcp_manager: None,
        subagent_host: None,
        custom_agents: Vec::new(),
        tool_policy: None,
        is_subagent: false,
        depth: 0,
        loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
        loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
        smart_compaction: false,
        compaction_model: None,
        user_inbox: None,
        extra_tools: Vec::new(),
        only_tools: None,
        shell_env: Default::default(),
        initial_gap: 0,
    };
    let result = run_agent_loop(config).await;
    let calls = *provider.calls.lock().unwrap();
    let events: Vec<_> = rx.try_iter().map(|e| e.event).collect();
    (calls, result, events)
}

struct ToolGrinderProvider {
    info: crate::providers::ProviderInfo,
    calls: std::sync::Mutex<u32>,
    tool_rounds: u32,
    file_name: String,
}

#[async_trait::async_trait]
impl crate::providers::Provider for ToolGrinderProvider {
    fn info(&self) -> &crate::providers::ProviderInfo {
        &self.info
    }

    async fn stream_completion(
        &self,
        _messages: &[Message],
        _tools: Option<&[crate::types::ToolDefinition]>,
        _model: &crate::providers::ModelInfo,
        sender: tokio::sync::mpsc::Sender<crate::llm::StreamEvent>,
        _context: crate::providers::RequestContext,
    ) -> Result<crate::llm::Usage, crate::llm::LlmError> {
        use crate::llm::StreamEvent;
        let call = {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            *calls
        };
        if call <= self.tool_rounds {
            let id = format!("grind-{call}");
            let args = format!(
                "{{\"path\": \"{}\", \"start_line\": {call}, \"end_line\": {call}}}",
                self.file_name
            );
            sender
                .send(StreamEvent::ToolCallStart {
                    name: "read_file".to_string(),
                    id: id.clone(),
                })
                .await
                .ok();
            sender
                .send(StreamEvent::ToolCallDelta {
                    id: id.clone(),
                    args_delta: args,
                })
                .await
                .ok();
            sender.send(StreamEvent::ToolCallEnd { id }).await.ok();
            sender
                .send(StreamEvent::Done {
                    usage: crate::llm::Usage::default(),
                    stop_reason: crate::llm::StopReason::ToolUse,
                })
                .await
                .ok();
        } else {
            sender
                .send(StreamEvent::TextDelta("grind complete".to_string()))
                .await
                .ok();
            sender
                .send(StreamEvent::Done {
                    usage: crate::llm::Usage::default(),
                    stop_reason: crate::llm::StopReason::Stop,
                })
                .await
                .ok();
        }
        Ok(crate::llm::Usage::default())
    }

    async fn list_models(&self) -> Result<Vec<crate::providers::ModelInfo>, crate::llm::LlmError> {
        Ok(Vec::new())
    }
}

fn grind_test_setup(
    tool_rounds: u32,
    max_iterations: Option<u32>,
) -> (
    std::path::PathBuf,
    std::sync::mpsc::Receiver<AgentTaskEvent>,
    Arc<ToolGrinderProvider>,
    AgentRunConfig,
) {
    use crate::cancellation::AbortController;
    use crate::permissions::{shared_permission_engine, ApprovalBroker};

    let dir = std::env::temp_dir().join(format!("agente-grind-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let body: String = (1..=40)
        .map(|i| format!("grind target line {i}\n"))
        .collect();
    std::fs::write(dir.join("notes.txt"), body).unwrap();

    let mut model = reasoning_model();
    model.id = "stub-model".to_string();
    model.api_id = "stub-model".to_string();
    model.name = "Stub Model".to_string();
    model.provider_id = "test-grind".to_string();
    model.limits.context = 1_000_000;
    let registry = Arc::new(ProviderRegistry::new());
    let provider = Arc::new(ToolGrinderProvider {
        info: crate::providers::ProviderInfo {
            id: "test-grind".to_string(),
            name: "Test Grind".to_string(),
            models: vec![model],
            ..Default::default()
        },
        calls: std::sync::Mutex::new(0),
        tool_rounds,
        file_name: "notes.txt".to_string(),
    });
    registry.register("test-grind", provider.clone());

    let (tx, rx) = std::sync::mpsc::channel();
    let config = AgentRunConfig {
        session_id: uuid::Uuid::new_v4(),
        task_id: 1,
        sender: tx,
        messages: vec![Message {
            role: Role::User,
            content: "grind".to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        }],
        provider_id: "test-grind".to_string(),
        model: "stub-model".to_string(),
        thinking_level: "off".to_string(),
        project_dir: dir.to_string_lossy().to_string(),
        max_iterations,
        registry,
        catalog: None,
        permission_engine: shared_permission_engine(AgentMode::Build),
        cancel_signal: AbortController::new().signal(),
        approval_broker: ApprovalBroker::new(),
        mcp_manager: None,
        subagent_host: None,
        custom_agents: Vec::new(),
        tool_policy: None,
        is_subagent: true,
        depth: 1,
        loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
        loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
        smart_compaction: false,
        compaction_model: None,
        user_inbox: None,
        extra_tools: Vec::new(),
        only_tools: None,
        shell_env: Default::default(),
        initial_gap: 0,
    };
    (dir, rx, provider, config)
}

#[tokio::test]
async fn unbounded_loop_runs_past_the_old_child_cap() {
    let (dir, rx, provider, config) = grind_test_setup(30, None);
    run_agent_loop(config)
        .await
        .expect("unbounded turn completes");
    assert_eq!(
        *provider.calls.lock().unwrap(),
        31,
        "all 30 tool rounds plus the final answer"
    );
    let events: Vec<AgentTaskEvent> = rx.try_iter().collect();
    assert!(
        !events.iter().any(|e| matches!(
            &e.event,
            AgentEvent::AssistantText(text) if text.contains("iteration limit")
        )),
        "unbounded run must never hit the pause notice"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.event, AgentEvent::Done { .. })),
        "turn ends Done"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn explicit_cap_still_stops_the_loop() {
    let (dir, rx, provider, config) = grind_test_setup(1_000, Some(3));
    run_agent_loop(config).await.expect("capped turn ends");
    assert_eq!(
        *provider.calls.lock().unwrap(),
        3,
        "loop stops after exactly the capped budget"
    );
    let events: Vec<AgentTaskEvent> = rx.try_iter().collect();
    assert!(
        events.iter().any(|e| matches!(
            &e.event,
            AgentEvent::AssistantText(text) if text.contains("iteration limit (3)")
        )),
        "capped run must emit the pause notice"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Answers in parts: every reply but the last stops at the output limit.
struct LengthLimitedProvider {
    info: crate::providers::ProviderInfo,
    parts: Vec<&'static str>,
    seen: std::sync::Mutex<Vec<Vec<Message>>>,
}

#[async_trait::async_trait]
impl crate::providers::Provider for LengthLimitedProvider {
    fn info(&self) -> &crate::providers::ProviderInfo {
        &self.info
    }

    async fn stream_completion(
        &self,
        messages: &[Message],
        _tools: Option<&[crate::types::ToolDefinition]>,
        _model: &crate::providers::ModelInfo,
        sender: tokio::sync::mpsc::Sender<crate::llm::StreamEvent>,
        _context: crate::providers::RequestContext,
    ) -> Result<crate::llm::Usage, crate::llm::LlmError> {
        let call = {
            let mut seen = self.seen.lock().unwrap();
            seen.push(messages.to_vec());
            seen.len() - 1
        };
        let last = call + 1 >= self.parts.len();
        let text = self.parts[call.min(self.parts.len() - 1)];
        sender
            .send(crate::llm::StreamEvent::TextDelta(text.to_string()))
            .await
            .ok();
        sender
            .send(crate::llm::StreamEvent::Done {
                usage: crate::llm::Usage::default(),
                stop_reason: if last {
                    crate::llm::StopReason::Stop
                } else {
                    crate::llm::StopReason::Length
                },
            })
            .await
            .ok();
        Ok(crate::llm::Usage::default())
    }

    async fn list_models(&self) -> Result<Vec<crate::providers::ModelInfo>, crate::llm::LlmError> {
        Ok(Vec::new())
    }
}

#[tokio::test]
async fn a_reply_cut_by_the_output_limit_is_continued() {
    use crate::cancellation::AbortController;
    use crate::permissions::{shared_permission_engine, ApprovalBroker};

    let registry = Arc::new(ProviderRegistry::new());
    let provider = Arc::new(LengthLimitedProvider {
        info: crate::providers::ProviderInfo {
            id: "test-length".into(),
            models: vec![overflow_test_model()],
            ..Default::default()
        },
        parts: vec!["first half", "second half"],
        seen: std::sync::Mutex::new(Vec::new()),
    });
    registry.register("test-length", provider.clone());
    let (tx, rx) = std::sync::mpsc::channel();
    let config = AgentRunConfig {
        session_id: uuid::Uuid::new_v4(),
        task_id: 1,
        sender: tx,
        messages: vec![Message::user("write the essay")],
        provider_id: "test-length".into(),
        model: "stub-model".into(),
        thinking_level: "off".into(),
        project_dir: ".".into(),
        max_iterations: Some(5),
        registry,
        catalog: None,
        permission_engine: shared_permission_engine(AgentMode::Build),
        cancel_signal: AbortController::new().signal(),
        approval_broker: ApprovalBroker::new(),
        mcp_manager: None,
        subagent_host: None,
        custom_agents: Vec::new(),
        tool_policy: None,
        is_subagent: false,
        depth: 0,
        loop_nudge_after: DEFAULT_LOOP_NUDGE_AFTER,
        loop_stop_after: DEFAULT_LOOP_STOP_AFTER,
        smart_compaction: false,
        compaction_model: None,
        user_inbox: None,
        extra_tools: Vec::new(),
        only_tools: None,
        shell_env: Default::default(),
        initial_gap: 0,
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), run_agent_loop(config))
        .await
        .expect("turn finishes")
        .expect("turn completes");

    let seen = provider.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "the cut reply was continued once");
    let second = &seen[1];
    assert_eq!(second[second.len() - 2].content, "first half");
    assert!(second
        .last()
        .is_some_and(|m| m.role == Role::User && m.content.contains("cut off")));
    let done = rx
        .try_iter()
        .find_map(|e| match e.event {
            AgentEvent::Done { conversation, .. } => Some(conversation),
            _ => None,
        })
        .expect("Done");
    assert_eq!(done.last().unwrap().content, "second half");
    assert!(!done
        .iter()
        .any(|m| m.content.contains("response truncated by the model's output limit")));
}
