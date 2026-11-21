use std::sync::atomic::Ordering;

use super::forwarder::{forward_child_events, should_notify_completion, unsent_remainder};
use super::spawn::enforce_timeout;
use super::*;
use crate::cancellation::AbortController;
use crate::permissions::shared_permission_engine;
use crate::subagent::definition::{resolve_effective_config, SubagentParentDefaults};
use crate::subagent::types::{SubagentIsolation, SubagentSnapshot};
use crate::types::{Message, ToolDefinition};

fn def(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: String::new(),
        parameters: serde_json::json!({}),
    }
}

#[test]
fn a_streamed_message_is_not_forwarded_twice() {
    assert_eq!(unsent_remainder("hello world", "hello "), 6);
    assert_eq!(unsent_remainder("hello world", "hello world"), 11);
    assert_eq!(unsent_remainder("hello", ""), 0);
    assert_eq!(unsent_remainder("hello", "different"), 0);
    assert_eq!(unsent_remainder("", ""), 0);
}

#[test]
fn notify_decision_pushes_only_unobserved_background_without_waiters() {
    assert!(should_notify_completion(true, 0, false));
    assert!(!should_notify_completion(false, 1, false));
    assert!(!should_notify_completion(true, 1, false));
    assert!(!should_notify_completion(true, 0, true));
    assert!(!should_notify_completion(false, 0, true));
}

fn queue_test_host(
    registry: SubagentRegistry,
    max_concurrent: usize,
) -> (SubagentHost, std::sync::mpsc::Receiver<AgentTaskEvent>) {
    let (event_sender, event_rx) = std::sync::mpsc::channel();
    let host = SubagentHost::new(
        SubagentHostConfig {
            custom_agents: Vec::new(),
            subagents: Default::default(),
            shell_env: crate::tools::ShellEnv::Inherit,
            only_tools: None,
            event_sender,
            task_id: 1,
            provider_id: "test".into(),
            provider_registry: Arc::new(crate::providers::ProviderRegistry::new()),
            catalog: None,
            permission_engine: shared_permission_engine(crate::types::AgentMode::Build),
            approval_broker: ApprovalBroker::new(),
            mcp_manager: None,
            project_dir: ".".into(),
            model: "test-model".into(),
            thinking_level: "off".into(),
            registry,
        },
        2,
        max_concurrent,
    );
    (host, event_rx)
}

fn queue_test_request() -> SubagentSpawnRequest {
    SubagentSpawnRequest {
        prompt: "do it".into(),
        description: "explore".into(),
        subagent_type: String::new(),
        run_in_background: Some(true),
        capability_mode: None,
        cwd: None,
        isolation: Default::default(),
        max_iterations: None,
        timeout_ms: None,
        resume_from: None,
        role: None,
        instructions: None,
        model: None,
        task_id: None,
        owns: Vec::new(),
    }
}

fn test_snapshot(id: &str) -> SubagentSnapshot {
    SubagentSnapshot {
        id: id.into(),
        subagent_type: "explore".into(),
        description: "test".into(),
        prompt: "Explicit handoff".into(),
        status: SubagentStatus::Running,
        summary: None,
        conversation: vec![],
        model: "test-model".into(),
        seat: None,
        provider: String::new(),
        thinking: String::new(),
        depth: 1,
        background: true,
        started_at: chrono::Utc::now(),
        finished_at: None,
        cwd: None,
        worktree: None,
    }
}

struct ParallelChildProvider {
    info: crate::providers::ProviderInfo,
    active: std::sync::atomic::AtomicUsize,
    peak: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl crate::providers::Provider for ParallelChildProvider {
    fn info(&self) -> &crate::providers::ProviderInfo {
        &self.info
    }
    async fn list_models(&self) -> Result<Vec<crate::providers::ModelInfo>, crate::llm::LlmError> {
        Ok(vec![])
    }
    async fn stream_completion(
        &self,
        _messages: &[Message],
        _tools: Option<&[ToolDefinition]>,
        _model: &crate::providers::ModelInfo,
        sender: tokio::sync::mpsc::Sender<crate::llm::StreamEvent>,
        _context: crate::providers::RequestContext,
    ) -> Result<crate::llm::Usage, crate::llm::LlmError> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(active, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let answer = format!("{}\nFINAL EVIDENCE PRESERVED", "日".repeat(150000));
        sender
            .send(crate::llm::StreamEvent::TextDelta(answer))
            .await
            .unwrap();
        sender
            .send(crate::llm::StreamEvent::Done {
                usage: Default::default(),
                stop_reason: crate::llm::StopReason::Stop,
            })
            .await
            .unwrap();
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(Default::default())
    }
}

#[tokio::test]
async fn foreground_children_overlap_and_return_complete_results() {
    let registry = SubagentRegistry::new();
    let (host, events) = queue_test_host(registry.clone(), 2);
    host.inner
        .config
        .permission_engine
        .write()
        .unwrap()
        .set_auto_approve(true);
    let provider = Arc::new(ParallelChildProvider {
        info: crate::providers::ProviderInfo {
            id: "test".into(),
            ..Default::default()
        },
        active: Default::default(),
        peak: Default::default(),
    });
    host.inner
        .config
        .provider_registry
        .register("test", provider.clone());
    let tools = Arc::new(crate::tools::ToolRegistry::new("."));
    let calls: Vec<ToolCall> = (0..2)
        .map(|index| ToolCall {
            id: format!("call-{index}"),
            call_type: "function".into(),
            function: crate::types::FunctionCall {
                name: "task".into(),
                arguments: serde_json::json!({
                    "prompt": "Return findings", "description": "Read-only findings",
                    "role": "explore", "run_in_background": false,
                })
                .to_string(),
            },
        })
        .collect();
    let cancel = AbortController::new();
    let started = std::time::Instant::now();
    let results = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        crate::agent::channel::execute_tool_calls_batched(
            &calls,
            tools,
            host.inner.config.event_sender.clone(),
            1,
            &host.inner.config.permission_engine,
            &host.inner.config.approval_broker,
            &cancel.signal(),
            ".",
            0,
            Some(&host),
        ),
    )
    .await;
    if results.is_err() {
        cancel.abort();
    }
    let results = results.expect("children finish promptly");
    eprintln!(
        "two foreground children: {:?}; peak concurrent completions: {}",
        started.elapsed(),
        provider.peak.load(Ordering::SeqCst)
    );
    assert_eq!(
        provider.peak.load(Ordering::SeqCst),
        2,
        "foreground tasks were serialized"
    );
    assert_eq!(results.len(), 2);
    for result in results {
        assert!(!result.is_error, "{}", result.content);
        assert!(result.content.contains("FINAL EVIDENCE PRESERVED"));
        assert!(result.content.len() > 450000);
        assert!(!result.content.contains("output truncated"));
    }
    let mut displayed = std::collections::HashMap::<String, String>::new();
    for event in events.try_iter() {
        if let AgentEvent::SubagentText { id, text } = event.event {
            displayed.entry(id).or_default().push_str(&text);
        }
    }
    assert_eq!(displayed.len(), 2);
    for text in displayed.values() {
        assert_eq!(
            text,
            &format!("{}\nFINAL EVIDENCE PRESERVED", "日".repeat(150000))
        );
    }
    for snapshot in registry.list() {
        assert!(
            snapshot.worktree.is_none(),
            "read-only children need no checkout"
        );
        let outcome = host
            .task_output(
                "poll".into(),
                serde_json::json!({"task_id": snapshot.id}),
                &crate::tools::ToolExecutionContext::default(),
            )
            .await;
        assert!(outcome.content.contains("FINAL EVIDENCE PRESERVED"));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn forwarder_drains_queue_even_after_preparation_failure() {
    let root = tempfile::tempdir().unwrap();
    let registry = SubagentRegistry::new();
    registry.insert(test_snapshot("blocker"));
    let mut source = test_snapshot("source");
    source.status = SubagentStatus::Completed;
    source.worktree = Some(worktree::WorktreeInfo::synthetic(
        root.path().to_string_lossy(),
        root.path().to_string_lossy(),
        "branch",
        "base",
        true,
    ));
    registry.insert(source);
    assert!(worktree::claim_for_resume(root.path()));
    let (host, events) = queue_test_host(registry.clone(), 1);
    let mut request = queue_test_request();
    request.resume_from = Some("source".into());
    request.isolation = SubagentIsolation::None;
    request.run_in_background = Some(false);
    let failed_prep = host.spawn(request.clone(), AbortSignal::never(), 0).await;
    assert_eq!(failed_prep.status, SubagentStatus::Pending);
    request.resume_from = None;
    request.cwd = Some(root.path().to_string_lossy().into_owned());
    let next = host.spawn(request, AbortSignal::never(), 0).await;
    assert_eq!(next.status, SubagentStatus::Pending);
    assert!(registry.get(&next.id).unwrap().background);

    let (tx, rx) = std::sync::mpsc::channel();
    tx.send(AgentTaskEvent {
        task_id: 7,
        event: AgentEvent::Done {
            conversation: vec![],
            tokens: 0,
        },
    })
    .unwrap();
    drop(tx);
    std::thread::spawn(move || forward_child_events(rx, host, "blocker".into()))
        .join()
        .expect("forwarder must not panic outside Tokio");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !registry.get(&next.id).unwrap().status.is_terminal() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("a prep failure must free its slot and start the next child");
    worktree::release_resume_claim(root.path());
    assert_eq!(registry.started_count(), 0);
    assert_eq!(registry.queued_count(), 0);
    assert!(registry
        .get(&failed_prep.id)
        .unwrap()
        .summary
        .unwrap()
        .contains("already in use"));
    assert!(registry
        .get(&next.id)
        .unwrap()
        .summary
        .unwrap()
        .contains("Unknown provider"));
    assert!(events.try_iter().any(|event| matches!(event.event,
        AgentEvent::SubagentCompletedNotice { ref id, .. } if id == &failed_prep.id)));
}

#[test]
fn worktree_completion_on_plain_thread_does_not_release_twice() {
    let root = tempfile::tempdir().unwrap();
    for args in [
        vec!["init", "--quiet"],
        vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-qm",
            "initial",
        ],
    ] {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(root.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    std::fs::write(root.path().join("child.txt"), "keep this work").unwrap();
    let registry = SubagentRegistry::new();
    let mut snapshot = test_snapshot("child");
    snapshot.worktree = Some(worktree::WorktreeInfo::synthetic(
        root.path().to_string_lossy(),
        root.path().to_string_lossy(),
        "branch",
        "HEAD",
        false,
    ));
    registry.insert(snapshot);
    let (host, _events) = queue_test_host(registry.clone(), 1);
    let (tx, rx) = std::sync::mpsc::channel();
    tx.send(AgentTaskEvent {
        task_id: 7,
        event: AgentEvent::Done {
            conversation: vec![],
            tokens: 0,
        },
    })
    .unwrap();
    drop(tx);
    std::thread::spawn(move || forward_child_events(rx, host, "child".into()))
        .join()
        .expect("worktree completion must not try tokio::spawn on the forwarder thread");
    let snapshot = registry.get("child").unwrap();
    assert_eq!(snapshot.status, SubagentStatus::Completed);
    assert!(snapshot.worktree.unwrap().dirty);
    assert_eq!(
        std::fs::read_to_string(root.path().join("child.txt")).unwrap(),
        "keep this work"
    );
}

#[tokio::test]
async fn cancelled_spawn_is_rejected_before_admission() {
    let registry = SubagentRegistry::new();
    let (host, _events) = queue_test_host(registry.clone(), 0);
    let controller = AbortController::new();
    controller.abort();
    let result = host
        .spawn(queue_test_request(), controller.signal(), 0)
        .await;
    assert!(result.is_error);
    assert!(registry.list().is_empty());
    assert_eq!(registry.queued_count(), 0);
}

#[tokio::test]
async fn prepare_child_passes_the_iteration_budget_through() {
    let (host, _event_rx) = queue_test_host(SubagentRegistry::new(), 2);
    let parent_defaults = SubagentParentDefaults {
        model: "test-model".into(),
        project_dir: ".".into(),
    };

    let mut request = queue_test_request();
    request.isolation = SubagentIsolation::None;
    request.max_iterations = None;
    let cfg = resolve_effective_config(&request, &parent_defaults, &[]).expect("explore resolves");
    let prep = host
        .prepare_child("child-unbounded", &request, cfg)
        .await
        .expect("prep succeeds");
    assert_eq!(
        prep.max_iterations, None,
        "omitted budget must stay unbounded"
    );

    let mut request = queue_test_request();
    request.isolation = SubagentIsolation::None;
    request.max_iterations = Some(7);
    let cfg = resolve_effective_config(&request, &parent_defaults, &[]).expect("explore resolves");
    let prep = host
        .prepare_child("child-capped", &request, cfg)
        .await
        .expect("prep succeeds");
    assert_eq!(prep.max_iterations, Some(7), "explicit cap passes through");
}

#[test]
fn forwarded_child_effects_carry_the_child_identity() {
    let (tx, rx) = std::sync::mpsc::channel::<AgentTaskEvent>();
    let registry = SubagentRegistry::new();
    let (host, event_rx) = queue_test_host(registry, 2);
    let id = "child-x".to_string();
    let forwarder = {
        let host = host.clone();
        let id = id.clone();
        std::thread::spawn(move || forward_child_events(rx, host, id))
    };

    tx.send(AgentTaskEvent {
        task_id: 7,
        event: AgentEvent::FileChange {
            subagent_id: None,
            path: "src/a.rs".into(),
            diff_summary: "M src/a.rs".into(),
            before: Some("old".into()),
            after: Some("new".into()),
        },
    })
    .unwrap();
    tx.send(AgentTaskEvent {
        task_id: 7,
        event: AgentEvent::TodoUpdate {
            subagent_id: None,
            todos: Vec::new(),
        },
    })
    .unwrap();
    drop(tx);
    forwarder.join().unwrap();

    let mut saw_file = false;
    let mut saw_todo = false;
    while let Ok(event) = event_rx.try_recv() {
        match event.event {
            AgentEvent::FileChange { subagent_id, .. } => {
                assert_eq!(subagent_id.as_deref(), Some("child-x"));
                saw_file = true;
            }
            AgentEvent::TodoUpdate { subagent_id, .. } => {
                assert_eq!(subagent_id.as_deref(), Some("child-x"));
                saw_todo = true;
            }
            _ => {}
        }
    }
    assert!(saw_file, "child file change was not forwarded");
    assert!(saw_todo, "child todo update was not forwarded");
}

#[tokio::test(flavor = "current_thread")]
async fn quiet_child_forwarder_does_not_block_the_runtime() {
    let (tx, rx) = std::sync::mpsc::channel::<AgentTaskEvent>();
    let registry = SubagentRegistry::new();
    let (host, _event_rx) = queue_test_host(registry, 4);
    let id = "quiet-child".to_string();
    host.inner.registry.insert(SubagentSnapshot {
        id: id.clone(),
        subagent_type: "explore".into(),
        description: "quiet".into(),
        prompt: String::new(),
        status: SubagentStatus::Running,
        summary: None,
        conversation: Vec::new(),
        model: "test-model".into(),
        seat: None,
        provider: String::new(),
        thinking: String::new(),
        depth: 1,
        background: true,
        started_at: chrono::Utc::now(),
        finished_at: None,
        cwd: None,
        worktree: None,
    });
    let forwarder = std::thread::spawn({
        let host = host.clone();
        let id = id.clone();
        move || forward_child_events(rx, host, id)
    });

    tokio::time::timeout(
        std::time::Duration::from_millis(500),
        tokio::time::sleep(std::time::Duration::from_millis(50)),
    )
    .await
    .expect("runtime must stay responsive while a child is silent");

    drop(tx);
    forwarder.join().unwrap();
    let snapshot = host.inner.registry.get(&id).expect("snapshot");
    assert!(
        snapshot.status.is_terminal(),
        "a closed child channel must finalize the child"
    );
}

#[tokio::test]
async fn enforce_timeout_aborts_only_running_children() {
    let registry = SubagentRegistry::new();
    let mut snap = SubagentSnapshot {
        id: "slow".into(),
        subagent_type: "explore".into(),
        description: "d".into(),
        prompt: String::new(),
        status: SubagentStatus::Running,
        summary: None,
        conversation: Vec::new(),
        model: "m".into(),
        seat: None,
        provider: String::new(),
        thinking: String::new(),
        depth: 1,
        background: true,
        started_at: chrono::Utc::now(),
        finished_at: None,
        cwd: None,
        worktree: None,
    };
    registry.insert(snap.clone());
    snap.id = "fast".to_string();
    registry.insert(snap);
    registry.finish("fast", SubagentStatus::Completed, "done".into(), vec![]);

    let slow_rx = registry.watchdog_receiver("slow");
    let fast_rx = registry.watchdog_receiver("fast");
    enforce_timeout(registry.clone(), "slow".into(), 20, slow_rx).await;
    enforce_timeout(registry.clone(), "fast".into(), 20, fast_rx).await;

    assert_eq!(registry.take_timed_out("slow"), Some(20));
    assert_eq!(registry.take_timed_out("fast"), None);
    assert_eq!(
        registry.get("slow").map(|s| s.status),
        Some(SubagentStatus::Running)
    );
}

#[tokio::test]
async fn spawn_queues_when_full_and_kill_cancels_queued() {
    use crate::cancellation::AbortSignal;

    let registry = SubagentRegistry::new();
    let (host, _events) = queue_test_host(registry.clone(), 0);
    let result = host
        .spawn(queue_test_request(), AbortSignal::never(), 0)
        .await;
    assert_eq!(result.status, SubagentStatus::Pending);
    assert!(
        result
            .summary
            .as_deref()
            .unwrap_or("")
            .contains("queued at position 1"),
        "{:?}",
        result.summary
    );
    let id = result.id.clone();
    assert_eq!(registry.queued_count(), 1);
    assert_eq!(
        registry.get(&id).map(|s| s.status),
        Some(SubagentStatus::Pending)
    );

    let outcome = host
        .task_output(
            "call-1".into(),
            serde_json::json!({"task_id": id, "timeout_ms": 1}),
            &crate::tools::ToolExecutionContext::default(),
        )
        .await;
    assert!(!outcome.is_error);

    let kill = host.kill_task("call-2".into(), serde_json::json!({"task_id": id}));
    assert!(!kill.is_error);
    assert_eq!(registry.queued_count(), 0);
    assert_eq!(
        registry.get(&id).map(|s| s.status),
        Some(SubagentStatus::Cancelled)
    );
    assert!(registry.was_observed(&id));
}

#[test]
fn tool_policy_allows_by_capability_and_allowlist() {
    use SubagentCapabilityMode::*;

    let read_only = ToolPolicy {
        capability: ReadOnly,
        allowlist: None,
        owns: Vec::new(),
    };
    assert!(read_only.allows("read_file"));
    assert!(read_only.allows("grep"));
    assert!(!read_only.allows("write_file"));
    assert!(!read_only.allows("shell"));
    assert!(!read_only.allows("task"));

    let rw = ToolPolicy {
        capability: ReadWrite,
        allowlist: None,
        owns: Vec::new(),
    };
    assert!(rw.allows("edit_file"));
    assert!(!rw.allows("shell"));

    let exec = ToolPolicy {
        capability: Execute,
        allowlist: None,
        owns: Vec::new(),
    };
    assert!(exec.allows("shell"));
    assert!(!exec.allows("task"));

    let all = ToolPolicy {
        capability: All,
        allowlist: None,
        owns: Vec::new(),
    };
    assert!(all.allows("task"));
    assert!(all.allows("task_output"));
    assert!(all.allows("kill_task"));
    assert!(all.allows("shell"));

    let narrowed = ToolPolicy {
        capability: All,
        allowlist: Some(vec!["read_file".to_string(), "grep".to_string()]),
        owns: Vec::new(),
    };
    assert!(narrowed.allows("read_file"));
    assert!(!narrowed.allows("shell"));
    assert!(!narrowed.allows("task"));
}

#[test]
fn tool_policy_filter_definitions_applies_both_gates() {
    let policy = ToolPolicy {
        capability: SubagentCapabilityMode::ReadOnly,
        allowlist: Some(vec!["read_file".to_string(), "write_file".to_string()]),
        owns: Vec::new(),
    };
    let defs = vec![
        def("read_file"),
        def("list_dir"),
        def("write_file"),
        def("shell"),
        def("task"),
    ];
    let names: Vec<String> = policy
        .filter_definitions(defs)
        .into_iter()
        .map(|d| d.name)
        .collect();
    assert_eq!(names, vec!["read_file"]);
}

#[test]
fn tool_policy_enforces_card_owns_on_mutating_file_tools() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let policy = ToolPolicy {
        capability: SubagentCapabilityMode::ReadWrite,
        allowlist: None,
        owns: vec!["src/parser/**".into(), "docs/readme.md".into()],
    };

    assert!(policy
        .check_tool_call(
            "write_file",
            &serde_json::json!({"path": "src/parser/lexer.rs", "content": "ok"}),
            root
        )
        .is_ok());
    assert!(policy
        .check_tool_call(
            "edit_file",
            &serde_json::json!({"path": "./docs/readme.md", "search": "a", "replace": "b"}),
            root
        )
        .is_ok());
    assert!(policy
        .check_tool_call(
            "apply_patch",
            &serde_json::json!({"patch": "--- a/src/parser/mod.rs\n+++ b/src/parser/mod.rs\n@@ -1 +1 @@\n-old\n+new\n"}),
            root
        )
        .is_ok());

    let denied_write = policy
        .check_tool_call(
            "write_file",
            &serde_json::json!({"path": "src/other.rs", "content": "bad"}),
            root,
        )
        .unwrap_err();
    assert!(
        denied_write.contains("outside this card's owned paths"),
        "{denied_write}"
    );

    let denied_traversal = policy
        .check_tool_call(
            "edit_file",
            &serde_json::json!({"path": "src/parser/../other.rs", "search": "a", "replace": "b"}),
            root,
        )
        .unwrap_err();
    assert!(
        denied_traversal.contains("outside this card's owned paths"),
        "{denied_traversal}"
    );

    let denied_patch = policy
        .check_tool_call(
            "apply_patch",
            &serde_json::json!({"patch": "--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1 +1 @@\n-old\n+new\n"}),
            root,
        )
        .unwrap_err();
    assert!(
        denied_patch.contains("outside this card's owned paths"),
        "{denied_patch}"
    );
}

#[tokio::test]
async fn enforce_timeout_exits_early_when_completion_signals() {
    let registry = SubagentRegistry::new();
    registry.insert(test_snapshot("early"));
    let rx = registry.watchdog_receiver("early");
    let reg_clone = registry.clone();
    let started = std::time::Instant::now();
    let handle = tokio::spawn(async move {
        enforce_timeout(reg_clone, "early".into(), 60_000, rx).await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    registry.finish("early", SubagentStatus::Completed, "done".into(), vec![]);
    tokio::time::timeout(std::time::Duration::from_secs(1), handle)
        .await
        .expect("watchdog must exit promptly on finish")
        .unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert_eq!(registry.take_timed_out("early"), None);
}

#[tokio::test]
async fn task_output_positive_timeout_returns_current_status() {
    let registry = SubagentRegistry::new();
    registry.insert(SubagentSnapshot {
        id: "slow-child".into(),
        subagent_type: "explore".into(),
        description: "slow test".into(),
        prompt: String::new(),
        status: SubagentStatus::Running,
        summary: None,
        conversation: Vec::new(),
        model: "test-model".into(),
        seat: None,
        provider: String::new(),
        thinking: String::new(),
        depth: 1,
        background: true,
        started_at: chrono::Utc::now(),
        finished_at: None,
        cwd: None,
        worktree: None,
    });
    let (event_sender, _event_receiver) = std::sync::mpsc::channel();
    let host = SubagentHost::new(
        SubagentHostConfig {
            custom_agents: Vec::new(),
            subagents: Default::default(),
            shell_env: crate::tools::ShellEnv::Inherit,
            only_tools: None,
            event_sender,
            task_id: 1,
            provider_id: "test".into(),
            provider_registry: Arc::new(crate::providers::ProviderRegistry::new()),
            catalog: None,
            permission_engine: shared_permission_engine(crate::types::AgentMode::Build),
            approval_broker: ApprovalBroker::new(),
            mcp_manager: None,
            project_dir: ".".into(),
            model: "test-model".into(),
            thinking_level: "off".into(),
            registry,
        },
        2,
        2,
    );

    let started = std::time::Instant::now();
    let outcome = host
        .task_output(
            "call-1".into(),
            serde_json::json!({"task_id": "slow-child", "timeout_ms": 10}),
            &ToolExecutionContext::new(AbortSignal::never()),
        )
        .await;
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert!(!outcome.is_error);
    assert!(outcome.content.contains("status: running"));
}
