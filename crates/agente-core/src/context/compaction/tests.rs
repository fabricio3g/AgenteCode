use super::normalize::carry_skills;
use super::semantic::summary_message;
use super::*;
use crate::context::budget::estimated_message_cost;
use crate::extensions::skills;
use crate::types::{FunctionCall, Role, ToolCall};
use async_trait::async_trait;

#[test]
fn summary_budget_fits_retained_context_and_never_underflows() {
    let strategy = CompactionStrategy::new(8_000, 8, 0.85);
    assert_eq!(strategy.summary_budget(3_000), 1_800);
    assert_eq!(strategy.summary_budget(4_800), 0);
    assert_eq!(strategy.summary_budget(usize::MAX), 0);
    assert_eq!(
        CompactionStrategy::new(128_000, 8, 0.85).summary_budget(20_000),
        16_384
    );
}

#[test]
fn a_small_window_leaves_room_for_the_tool_schemas() {
    let budget = ContextBudget::new(8_192, 4_500, 0, 0, 0);
    let strategy = CompactionStrategy::from_budget(&budget);
    assert_eq!(strategy.max_tokens, budget.room());
    assert!(strategy.should_compact(2_300));
    assert!(!strategy.should_compact(2_200));
    assert!(strategy.reserve_tokens <= budget.room() / 4);
    assert_eq!(
        CompactionStrategy::from_budget(&ContextBudget::new(8_000, 50_000, 0, 0, 0)).max_tokens,
        2_000
    );
}

#[test]
fn a_few_huge_messages_still_compact() {
    let big = "filler line with several words in it\n".repeat(400);
    let messages = vec![
        create_message(Role::System, "system"),
        create_message(Role::User, &format!("first {big}")),
        create_message(Role::Assistant, "noted first"),
        create_message(Role::User, &format!("second {big}")),
        create_message(Role::Assistant, "noted second"),
        create_message(Role::User, "latest question"),
    ];
    let compactor = ContextCompactor::new(CompactionStrategy::from_budget(&ContextBudget::new(
        8_192, 4_500, 0, 0, 0,
    )));
    let result = compactor.compact_forced(messages);
    assert!(
        result.summary.tokens_saved > 0,
        "{:?}",
        result.summary.content
    );
    assert_eq!(
        result.messages.first().map(|m| &m.role),
        Some(&Role::System)
    );
    assert_eq!(
        result.messages.last().map(|m| m.content.as_str()),
        Some("latest question")
    );
}

#[test]
fn manual_compact_shrinks_a_conversation_far_below_the_window() {
    let chunk = "a sentence that takes some room in the transcript\n".repeat(40);
    let mut messages = vec![create_message(Role::System, "system")];
    for turn in 0..10 {
        messages.push(create_message(
            Role::User,
            &format!("question {turn} {chunk}"),
        ));
        messages.push(create_message(
            Role::Assistant,
            &format!("answer {turn} {chunk}"),
        ));
    }
    let before = estimate_tokens_for_test(&messages);
    let result = ContextCompactor::new(CompactionStrategy::manual(1_000_000, before))
        .compact_forced(messages);
    assert!(result.summary.tokens_saved > 0);
    assert!(estimate_tokens_for_test(&result.messages) < before);
    assert!(result
        .messages
        .last()
        .unwrap()
        .content
        .starts_with("answer 9"));
}

fn estimate_tokens_for_test(messages: &[Message]) -> usize {
    crate::context::estimate_message_tokens(messages)
}

fn create_message(role: Role, content: &str) -> Message {
    Message {
        role,
        content: content.to_string(),
        tool_calls: None,
        tool_call_id: None,
        thinking: None,
        thinking_signature: None,
        continuation: None,
        attachments: Vec::new(),
    }
}

fn tool_exchange(ids: &[&str]) -> Vec<Message> {
    let calls = ids
        .iter()
        .map(|id| ToolCall {
            id: (*id).to_string(),
            call_type: "function".to_string(),
            function: FunctionCall {
                name: "read_file".to_string(),
                arguments: "{}".to_string(),
            },
        })
        .collect();
    let mut messages = vec![Message {
        role: Role::Assistant,
        content: String::new(),
        tool_calls: Some(calls),
        tool_call_id: None,
        thinking: None,
        thinking_signature: None,
        continuation: None,
        attachments: Vec::new(),
    }];
    messages.extend(ids.iter().map(|id| Message {
        role: Role::Tool,
        content: format!("result for {id}"),
        tool_calls: None,
        tool_call_id: Some((*id).to_string()),
        thinking: None,
        thinking_signature: None,
        continuation: None,
        attachments: Vec::new(),
    }));
    messages
}

#[test]
fn a_strategy_is_sized_from_the_budget() {
    let budget = crate::context::ContextBudget::new(128_000, 20_000, 0, 0, 8_192);
    let strategy = CompactionStrategy::from_budget(&budget);
    assert_eq!(strategy.max_tokens, budget.room());
    assert_eq!(strategy.keep_recent, 8);
    assert!(strategy.should_compact((budget.room() as f32 * 0.86) as usize));
    assert!(!strategy.should_compact((budget.room() as f32 * 0.80) as usize));
}

#[test]
fn test_compaction_no_compaction_needed() {
    let compactor = ContextCompactor::new(CompactionStrategy::new(128_000, 8, 0.85));
    let messages = vec![
        create_message(Role::User, "Hello"),
        create_message(Role::Assistant, "Hi there!"),
    ];

    let result = compactor.compact(messages);
    assert_eq!(result.messages.len(), 2);
    assert_eq!(result.summary.tokens_saved, 0);
}

#[test]
fn test_compaction_keeps_recent_messages() {
    let compactor = ContextCompactor::new(CompactionStrategy {
        max_tokens: 1000,
        keep_recent: 2,
        summarize_threshold: 0.5,
        target_reduction: 0.6,
        reserve_tokens: 256,
    });

    let mut messages = vec![];
    for i in 0..10 {
        messages.push(create_message(
            Role::User,
            &format!("This is message {i} with some content that uses tokens"),
        ));
        messages.push(create_message(
            Role::Assistant,
            &format!("Response to message {i} with details and information"),
        ));
    }

    let original_count = messages.len();
    let result = compactor.compact(messages);

    assert!(result.messages.len() >= 2);
    assert_eq!(
        result.summary.metadata.original_message_count,
        original_count
    );
}

#[test]
fn test_estimate_message_tokens() {
    let message = create_message(Role::User, "Hello world, this is a test message.");

    let tokens = estimated_message_cost(&message);
    assert!(tokens > 0);
    assert!(tokens < 100);
}

#[test]
fn forced_compaction_shrinks_tool_results_below_the_gate() {
    let compactor = ContextCompactor::new(CompactionStrategy {
        max_tokens: 4_000,
        keep_recent: 2,
        summarize_threshold: 0.9,
        target_reduction: 0.5,
        reserve_tokens: 256,
    });
    let big_output: String = (0..400)
        .map(|i| format!("src/file{i}.rs:1:match {i}\n"))
        .collect();
    let messages = vec![
        Message {
            role: Role::Assistant,
            content: String::new(),
            tool_calls: Some(vec![ToolCall {
                id: "c1".to_string(),
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
            content: big_output,
            tool_calls: None,
            tool_call_id: Some("c1".to_string()),
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        },
        create_message(Role::User, "latest question"),
        create_message(Role::Assistant, "latest answer"),
    ];

    let plain = compactor.compact(messages.clone());
    assert_eq!(plain.summary.tokens_saved, 0);
    assert_eq!(plain.messages.len(), messages.len());

    let forced = compactor.compact_forced(messages);
    assert!(
        forced.summary.tokens_saved > 0,
        "forced compaction must save tokens"
    );
    let tail = &forced.messages[forced.messages.len() - 2..];
    assert_eq!(tail[0].content, "latest question");
    assert_eq!(tail[1].content, "latest answer");
    assert!(
        forced
            .messages
            .iter()
            .any(|m| m.content.contains("Tool output truncated")),
        "old tool output must be truncated"
    );
}

fn call(id: &str, tool: &str) -> Message {
    Message {
        role: Role::Assistant,
        content: String::new(),
        tool_calls: Some(vec![ToolCall {
            id: id.to_string(),
            call_type: "function".to_string(),
            function: FunctionCall {
                name: tool.to_string(),
                arguments: "{}".to_string(),
            },
        }]),
        tool_call_id: None,
        thinking: None,
        thinking_signature: None,
        continuation: None,
        attachments: Vec::new(),
    }
}

fn result(id: &str, content: String) -> Message {
    Message {
        role: Role::Tool,
        content,
        tool_calls: None,
        tool_call_id: Some(id.to_string()),
        thinking: None,
        thinking_signature: None,
        continuation: None,
        attachments: Vec::new(),
    }
}

fn skill_block(name: &str, lines: usize) -> String {
    let body: String = (0..lines).map(|i| format!("step {i}\n")).collect();
    format!(
        "{}{name}\">\n{body}{}",
        skills::SKILL_OPEN,
        skills::SKILL_CLOSE
    )
}

#[test]
fn forced_compaction_never_truncates_a_loaded_skill() {
    let compactor = ContextCompactor::new(CompactionStrategy {
        max_tokens: 4_000,
        keep_recent: 2,
        summarize_threshold: 0.9,
        target_reduction: 0.5,
        reserve_tokens: 256,
    });
    let skill = skill_block("review", 300);
    let grep: String = (0..400).map(|i| format!("src/f{i}.rs:1:x\n")).collect();
    let messages = vec![
        call("s1", "skill"),
        result("s1", skill.clone()),
        call("g1", "grep"),
        result("g1", grep),
        create_message(Role::User, "latest question"),
        create_message(Role::Assistant, "latest answer"),
    ];
    let forced = compactor.compact_forced(messages);
    assert!(
        forced.messages.iter().any(|m| m.content == skill),
        "the skill result survives whole"
    );
    assert!(
        forced
            .messages
            .iter()
            .any(|m| m.content.contains("Tool output truncated")),
        "other tool output still shrinks"
    );
}

#[test]
fn skills_dropped_by_compaction_are_carried_forward() {
    let skill = skill_block("pdf", 3);
    let before = vec![
        create_message(Role::System, "system"),
        create_message(Role::User, &format!("{skill}\n\nfix the form")),
        create_message(Role::Assistant, "done"),
        create_message(Role::User, "next"),
    ];
    let after = vec![
        create_message(Role::System, "system"),
        summary_message("earlier work"),
        create_message(Role::User, "next"),
    ];
    let carried = carry_skills(&before, after);
    assert_eq!(carried.len(), 4);
    assert!(carried[1].content.starts_with("[Conversation summary]"));
    assert!(carried[2].content.starts_with(CARRIED_SKILLS_HEADING));
    assert!(carried[2].content.contains(&skill));
    let again = carry_skills(&carried, carried.clone());
    assert_eq!(again.len(), carried.len());
}

#[test]
fn forced_compaction_on_a_small_transcript_is_harmless() {
    let compactor = ContextCompactor::new(CompactionStrategy {
        max_tokens: 100_000,
        keep_recent: 8,
        summarize_threshold: 0.9,
        target_reduction: 0.5,
        reserve_tokens: 256,
    });
    let messages = vec![
        create_message(Role::System, "You are a helpful agent."),
        create_message(Role::User, "hi"),
        create_message(Role::Assistant, "hello"),
    ];
    let forced = compactor.compact_forced(messages.clone());
    assert_eq!(forced.summary.tokens_saved, 0);
    assert_eq!(forced.messages.len(), messages.len());
    assert_eq!(
        forced.messages.first().map(|m| m.role.clone()),
        Some(Role::System)
    );
}

#[test]
fn normalize_tool_messages_removes_orphans_and_pads_incomplete_exchanges() {
    let orphan = Message {
        role: Role::Tool,
        content: "orphan".to_string(),
        tool_calls: None,
        tool_call_id: Some("missing".to_string()),
        thinking: None,
        thinking_signature: None,
        continuation: None,
        attachments: Vec::new(),
    };
    let mut messages = vec![orphan];
    messages.extend(tool_exchange(&["complete"]));
    let mut incomplete = tool_exchange(&["first", "second"]);
    incomplete.pop();
    messages.extend(incomplete);

    let normalized = normalize_tool_messages(messages);

    assert_eq!(normalized.len(), 5);
    assert!(normalized[0].tool_calls.is_some());
    assert_eq!(normalized[1].tool_call_id.as_deref(), Some("complete"));
    assert!(normalized[1].content.contains("complete"));
    let assistant = &normalized[2];
    assert_eq!(
        assistant
            .tool_calls
            .as_ref()
            .map(|calls| calls.iter().map(|c| c.id.clone()).collect::<Vec<_>>()),
        Some(vec!["first".to_string(), "second".to_string()]),
    );
    assert_eq!(normalized[3].tool_call_id.as_deref(), Some("first"));
    assert!(normalized[3].content.contains("result for first"));
    assert_eq!(normalized[4].tool_call_id.as_deref(), Some("second"));
    assert!(
        normalized[4].content.contains("no result was recorded"),
        "padded result: {:?}",
        normalized[4].content
    );
}

#[test]
fn compaction_keeps_system_message() {
    let compactor = ContextCompactor::new(CompactionStrategy {
        max_tokens: 1000,
        keep_recent: 2,
        summarize_threshold: 0.5,
        target_reduction: 0.6,
        reserve_tokens: 256,
    });
    let mut messages = vec![create_message(Role::System, "You are a helpful agent.")];
    for i in 0..20 {
        messages.push(create_message(
            Role::User,
            &format!(
                "This is a long user message number {i} with enough content to consume tokens"
            ),
        ));
    }

    let result = compactor.compact(messages);
    assert_eq!(
        result.messages.first().map(|m| m.role.clone()),
        Some(Role::System)
    );
}

struct FakeSummarizer {
    summary: String,
    fail: bool,
}

#[async_trait]
impl Summarizer for FakeSummarizer {
    async fn summarize(
        &self,
        _messages: &[Message],
        _budget_tokens: usize,
        _previous_summary: Option<&str>,
    ) -> Result<String, SummarizeError> {
        if self.fail {
            Err(SummarizeError::Llm("boom".to_string()))
        } else {
            Ok(self.summary.clone())
        }
    }
}

#[tokio::test]
async fn manual_smart_compaction_runs_below_the_automatic_threshold() {
    let messages = vec![
        create_message(Role::System, "System"),
        create_message(Role::User, &"old context ".repeat(1000)),
        create_message(Role::Assistant, "old response"),
        create_message(Role::User, "latest question"),
        create_message(Role::Assistant, "latest answer"),
    ];
    let strategy = CompactionStrategy {
        max_tokens: 100_000,
        keep_recent: 2,
        ..CompactionStrategy::new(100_000, 2, 0.9)
    };
    assert!(!strategy.should_compact(crate::context::estimate_message_tokens(&messages)));
    let compactor = ContextCompactor::new(strategy).with_summarizer(Arc::new(FakeSummarizer {
        summary: "Manual summary".into(),
        fail: false,
    }));
    let result = compactor.compact_async_forced(messages).await;
    assert_eq!(result.summary.content, "Manual summary");
    assert_eq!(result.summary.metadata.summary_type, SummaryType::Semantic);
    assert!(result
        .messages
        .iter()
        .any(|message| message.content.contains("Manual summary")));
    assert_eq!(result.messages.last().unwrap().content, "latest answer");
}

#[tokio::test]
async fn semantic_compaction_uses_summarizer_and_keeps_recent() {
    let compactor = ContextCompactor::new(CompactionStrategy {
        max_tokens: 200,
        keep_recent: 2,
        summarize_threshold: 0.5,
        target_reduction: 0.6,
        reserve_tokens: 256,
    })
    .with_summarizer(Arc::new(FakeSummarizer {
        summary: "STRUCTURED SUMMARY".to_string(),
        fail: false,
    }));

    let mut messages = vec![create_message(Role::System, "You are a helpful agent.")];
    for i in 0..10 {
        messages.push(create_message(
            Role::User,
            &format!("User message {i} with plenty of content"),
        ));
        messages.push(create_message(
            Role::Assistant,
            &format!("Assistant response {i} with detail"),
        ));
    }

    let result = compactor.compact_async(messages).await;

    assert_eq!(result.summary.metadata.summary_type, SummaryType::Semantic);
    assert!(result.summary.tokens_saved > 0);
    assert_eq!(
        result.messages.first().map(|m| m.role.clone()),
        Some(Role::System)
    );

    let has_summary = result.messages.iter().any(|m| {
        m.content.contains("[Conversation summary]") && m.content.contains("STRUCTURED SUMMARY")
    });
    assert!(has_summary, "expected a summary message in the result");

    let last = result.messages.last().unwrap();
    assert!(last.content.contains("Assistant response 9"));
}

#[tokio::test]
async fn semantic_compaction_keeps_tool_exchange_intact_at_boundary() {
    let compactor = ContextCompactor::new(CompactionStrategy {
        max_tokens: 100,
        keep_recent: 2,
        summarize_threshold: 0.5,
        target_reduction: 0.6,
        reserve_tokens: 256,
    })
    .with_summarizer(Arc::new(FakeSummarizer {
        summary: "SUMMARY".to_string(),
        fail: false,
    }));
    let mut messages = vec![
        create_message(Role::System, "system"),
        create_message(Role::User, &"old context ".repeat(100)),
    ];
    messages.extend(tool_exchange(&["call_1", "call_2"]));

    let result = compactor.compact_async(messages).await;
    let assistant_index = result
        .messages
        .iter()
        .position(|message| message.tool_calls.is_some())
        .expect("assistant tool call retained");

    assert_eq!(result.messages[assistant_index + 1].role, Role::Tool);
    assert_eq!(result.messages[assistant_index + 2].role, Role::Tool);
}

#[tokio::test]
async fn semantic_compaction_falls_back_when_summarizer_fails() {
    let compactor = ContextCompactor::new(CompactionStrategy {
        max_tokens: 200,
        keep_recent: 2,
        summarize_threshold: 0.5,
        target_reduction: 0.6,
        reserve_tokens: 256,
    })
    .with_summarizer(Arc::new(FakeSummarizer {
        summary: String::new(),
        fail: true,
    }));

    let mut messages = vec![];
    for i in 0..10 {
        messages.push(create_message(
            Role::User,
            &format!("This is user message {i} with a lot of content that uses tokens"),
        ));
        messages.push(create_message(
            Role::Assistant,
            &format!("This is assistant response {i} with details"),
        ));
    }

    let result = compactor.compact_async(messages).await;

    assert_ne!(result.summary.metadata.summary_type, SummaryType::Semantic);
    assert!(!result.messages.is_empty());
}

#[tokio::test]
async fn empty_semantic_summary_falls_back_without_discarding_recent_context() {
    let compactor = ContextCompactor::new(CompactionStrategy::from_budget(&ContextBudget::new(
        2_000, 0, 0, 0, 0,
    )))
    .with_summarizer(Arc::new(FakeSummarizer {
        summary: " \n ".into(),
        fail: false,
    }));
    let mut messages = vec![create_message(
        Role::User,
        &"Earlier evidence. ".repeat(500),
    )];
    messages.push(create_message(
        Role::User,
        "Keep this latest request intact",
    ));
    let result = compactor.compact_async_forced(messages).await;
    assert_ne!(result.summary.metadata.summary_type, SummaryType::Semantic);
    assert!(result
        .messages
        .iter()
        .any(|message| message.content == "Keep this latest request intact"));
}

#[test]
fn compact_messages_grouped_does_not_underflow_when_compression_grows() {
    let compactor = ContextCompactor::new(CompactionStrategy {
        max_tokens: 10,
        keep_recent: 1,
        summarize_threshold: 0.5,
        target_reduction: 0.5,
        reserve_tokens: 1,
    });
    let tiny_many_lines = "a\n".repeat(16);
    let messages = vec![
        create_message(Role::User, &tiny_many_lines),
        create_message(Role::User, "latest"),
    ];
    let (compacted, saved) = compactor.compact_messages(messages, 1);
    assert!(compacted.len() <= 2);
    let _ = saved;
}

#[test]
fn serialize_conversation_includes_roles_and_tool_calls() {
    let mut msg = create_message(Role::Assistant, "Let me read that file");
    msg.tool_calls = Some(vec![crate::types::ToolCall {
        id: "call_1".to_string(),
        call_type: "function".to_string(),
        function: crate::types::FunctionCall {
            name: "read_file".to_string(),
            arguments: r#"{"path":"a.rs"}"#.to_string(),
        },
    }]);
    let text = serialize_conversation(&[msg]);
    assert!(text.contains("<assistant>"));
    assert!(text.contains("read_file"));
    assert!(text.contains("a.rs"));
}
