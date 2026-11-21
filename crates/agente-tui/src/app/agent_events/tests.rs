use super::*;
use crate::app::App;
use agente_core::agent::{AgentEvent, AgentTaskEvent};
use agente_core::config::AppConfig;
use agente_core::types::{AgentState, Role};

#[test]
fn parallel_subagent_results_match_call_id_before_tool_name() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut app = App::new_for_test(
        AppConfig::default(),
        "/tmp/subagent-routing".into(),
        runtime,
    )
    .unwrap();
    let rows = ["first", "second"]
        .into_iter()
        .map(|id| crate::state::SubagentToolRow {
            call_id: id.into(),
            name: "shell".into(),
            args: "{}".into(),
            result: None,
            is_error: false,
            finished: false,
        })
        .collect();
    app.state.agent.subagents.insert(
        "child".into(),
        crate::state::SubagentUiState {
            tool_rows: rows,
            status: "running".into(),
            ..Default::default()
        },
    );
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::SubagentToolCallResult {
                id: "child".into(),
                call_id: "first".into(),
                name: "shell".into(),
                result: "first result".into(),
                is_error: false,
            },
        })
        .unwrap();
    app.process_agent_events();
    let rows = &app.state.agent.subagents["child"].tool_rows;
    assert_eq!(rows[0].result.as_deref(), Some("first result"));
    assert!(rows[1].result.is_none());
}

#[test]
fn subagent_updates_materialize_card_when_start_was_missed() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut app = App::new_for_test(
        AppConfig::default(),
        "/tmp/subagent-placeholder".to_string(),
        runtime,
    )
    .unwrap();

    // No SubagentStarted ever arrives (out-of-order delivery, /clear,
    // reload) — updates must still surface a card, not vanish.
    for event in [
        AgentEvent::SubagentText {
            id: "ghost".into(),
            text: "reading files".repeat(30000),
        },
        AgentEvent::SubagentToolCallStart {
            id: "ghost".into(),
            call_id: "c1".into(),
            name: "read_file".into(),
            args: "{}".into(),
        },
        AgentEvent::SubagentToolCallResult {
            id: "ghost".into(),
            call_id: "c1".into(),
            name: "read_file".into(),
            result: "contents".into(),
            is_error: false,
        },
        AgentEvent::SubagentDone {
            id: "ghost".into(),
            summary: "done exploring".into(),
            is_error: false,
        },
    ] {
        app.agent_tx
            .send(AgentTaskEvent { task_id: 0, event })
            .unwrap();
    }
    app.process_agent_events();

    let card = app
        .state
        .agent
        .subagents
        .get("ghost")
        .expect("card must materialize without SubagentStarted");
    assert!(card.streaming_text.contains("reading files"));
    assert_eq!(card.streaming_text, "reading files".repeat(30000));
    assert_eq!(card.tool_rows.len(), 1);
    assert_eq!(card.tool_rows[0].result.as_deref(), Some("contents"));
    assert_eq!(card.status, "completed");
    assert!(app
        .state
        .session
        .chat_history
        .iter()
        .any(|e| e.subagent_id.as_deref() == Some("ghost")));
}

#[test]
fn child_carried_events_survive_a_follow_up_turn_while_child_runs() {
    use agente_core::agent::ApprovalSource;
    use agente_core::todo::TodoInput;
    use agente_core::types::ApprovalRequest;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut app = App::new_for_test(
        AppConfig::default(),
        "/tmp/subagent-stale".to_string(),
        runtime,
    )
    .unwrap();

    // A background child spawned during turn 0 outlives it; the user
    // starts turn 2 while the child still runs.
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::SubagentStarted {
                id: "child".into(),
                subagent_type: "explore".into(),
                description: "research".into(),
                model: "test-model".into(),
                seat: None,
            },
        })
        .unwrap();
    app.process_agent_events();
    app.current_task_id = 2;

    // Everything the child emits still bears the spawning turn's id, but
    // its origin is tagged. A shared-root child's file edit counts as a
    // parent change; its todo list never replaces the parent plan.
    for event in [
        AgentEvent::FileChange {
            subagent_id: Some("child".into()),
            path: "src/a.rs".into(),
            diff_summary: "+1/-0".into(),
            before: Some("old".into()),
            after: Some("new".into()),
        },
        AgentEvent::TodoUpdate {
            subagent_id: Some("child".into()),
            todos: vec![TodoInput {
                content: "child task".into(),
                status: "in_progress".into(),
                priority: "high".into(),
            }],
        },
        AgentEvent::ApprovalRequested {
            source: ApprovalSource::Subagent { id: "child".into() },
            request: ApprovalRequest {
                request_id: "r1".into(),
                tool_name: "shell".into(),
                tool_args: "{}".into(),
                description: "child wants shell".into(),
                is_dangerous: false,
                old_content: None,
                new_content: None,
                file_path: None,
            },
        },
    ] {
        app.agent_tx
            .send(AgentTaskEvent { task_id: 1, event })
            .unwrap();
    }
    app.process_agent_events();

    assert!(
        app.state.session.file_originals.contains_key("src/a.rs"),
        "a shared-root child file edit must not be dropped as stale"
    );
    assert_eq!(
        app.state.todo.todos.get_all().len(),
        0,
        "a child todo list must never replace the parent plan"
    );
    assert!(
        !app.state.agent.approval_queue.is_empty(),
        "child approval must surface even on a newer turn"
    );
}

#[test]
fn isolated_child_changes_never_touch_parent_tracking() {
    use agente_core::subagent::WorktreeInfo;
    use agente_core::todo::TodoInput;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut app = App::new_for_test(
        AppConfig::default(),
        "/tmp/subagent-worktree".to_string(),
        runtime,
    )
    .unwrap();
    app.state.agent.subagents.insert(
        "wt-child".into(),
        crate::state::SubagentUiState {
            status: "running".into(),
            worktree: Some(WorktreeInfo::synthetic(
                "/repo",
                "/repo/.agente/worktrees/explore-abc",
                "agente/explore-abc",
                "deadbeef",
                false,
            )),
            ..Default::default()
        },
    );
    app.current_task_id = 2;

    for event in [
        AgentEvent::FileChange {
            subagent_id: Some("wt-child".into()),
            path: "src/a.rs".into(),
            diff_summary: "+1/-0".into(),
            before: Some("old".into()),
            after: Some("new".into()),
        },
        AgentEvent::TodoUpdate {
            subagent_id: Some("wt-child".into()),
            todos: vec![TodoInput {
                content: "isolated task".into(),
                status: "in_progress".into(),
                priority: "high".into(),
            }],
        },
    ] {
        app.agent_tx
            .send(AgentTaskEvent { task_id: 1, event })
            .unwrap();
    }
    app.process_agent_events();

    assert!(
        app.state.session.file_originals.is_empty(),
        "an isolated checkout's edit is not a parent file change"
    );
    assert_eq!(app.state.todo.todos.get_all().len(), 0);
}

#[test]
fn unrelated_stale_events_are_still_dropped_without_live_children() {
    use agente_core::todo::TodoInput;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut app = App::new_for_test(
        AppConfig::default(),
        "/tmp/subagent-stale-control".to_string(),
        runtime,
    )
    .unwrap();
    app.current_task_id = 2;

    for event in [
        AgentEvent::FileChange {
            subagent_id: None,
            path: "src/a.rs".into(),
            diff_summary: "+1/-0".into(),
            before: Some("old".into()),
            after: Some("new".into()),
        },
        AgentEvent::TodoUpdate {
            subagent_id: None,
            todos: vec![TodoInput {
                content: "stale task".into(),
                status: "pending".into(),
                priority: "low".into(),
            }],
        },
    ] {
        app.agent_tx
            .send(AgentTaskEvent { task_id: 1, event })
            .unwrap();
    }
    app.process_agent_events();

    assert!(app.state.session.file_originals.is_empty());
    assert_eq!(app.state.todo.todos.get_all().len(), 0);
}

#[test]
fn event_drain_yields_when_a_producer_fills_the_queue() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut app = App::new_for_test(
        AppConfig::default(),
        "/tmp/event-drain".to_string(),
        runtime,
    )
    .unwrap();

    for _ in 0..=MAX_AGENT_EVENTS_PER_TICK {
        app.agent_tx
            .send(AgentTaskEvent {
                task_id: 0,
                event: AgentEvent::Thinking,
            })
            .unwrap();
    }

    assert!(app.process_agent_events(), "the first batch must yield");
    assert!(
        !app.process_agent_events(),
        "the remaining event must drain without claiming more backlog"
    );
}

#[test]
fn plan_review_opens_only_after_terminal_event() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut app = App::new_for_test(
        AppConfig::default(),
        "/tmp/plan-handoff".to_string(),
        runtime,
    )
    .unwrap();
    let result = "Plan ready\n\n__PLAN_READY__\n.agente/plan.md\n__PLAN_TITLE__\nMy Plan\n__PLAN_BODY__\n# My Plan\n\nsteps\n";
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::ToolCallResult {
                id: "plan".into(),
                name: "present_plan".into(),
                result: result.into(),
                is_error: false,
            },
        })
        .unwrap();
    app.process_agent_events();
    assert!(app.state.plan_review.pending.is_some());
    assert_eq!(
        app.state.plan_review.phase,
        crate::state::PlanReviewPhase::Idle
    );

    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::Done {
                conversation: Vec::new(),
                tokens: 0,
            },
        })
        .unwrap();
    app.process_agent_events();
    assert_eq!(
        app.state.plan_review.phase,
        crate::state::PlanReviewPhase::Review
    );
}

#[test]
fn streaming_deltas_do_not_bypass_frame_throttle() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut app =
        App::new_for_test(AppConfig::default(), "/tmp/frame-throttle".into(), runtime).unwrap();
    app.state.agent.state = AgentState::StreamingResponse;
    app.state.ui.needs_render = false;
    app.inject_agent_event(AgentEvent::TextDelta("hello".into()));
    app.inject_agent_event(AgentEvent::ReasoningDelta("thinking".into()));
    app.process_agent_events();
    assert!(!app.state.ui.needs_render);
    assert_eq!(app.state.agent.streaming_text, "hello");
    assert_eq!(app.state.agent.reasoning_text, "thinking");

    // An already-pending keyboard paint must never be suppressed.
    app.state.ui.needs_render = true;
    app.inject_agent_event(AgentEvent::TextDelta(" world".into()));
    app.process_agent_events();
    assert!(app.state.ui.needs_render);

    app.state.ui.needs_render = false;
    app.inject_agent_event(AgentEvent::Error {
        message: "failed".into(),
        conversation: Vec::new(),
    });
    app.process_agent_events();
    assert!(app.state.ui.needs_render);
}

#[test]
fn error_preserves_partial_output_and_clears_owned_task() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut app = App::new_for_test(
        AppConfig::default(),
        "/tmp/error-terminal".to_string(),
        runtime,
    )
    .unwrap();
    app.state.agent.state = AgentState::StreamingResponse;
    app.state.agent.streaming_text = "partial answer".into();
    app.state.agent.task_handle = Some(app.runtime.spawn(std::future::pending()));
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::Error {
                message: "provider failed".into(),
                conversation: Vec::new(),
            },
        })
        .unwrap();

    app.process_agent_events();

    assert!(matches!(app.state.agent.state, AgentState::Idle));
    assert!(app.state.agent.task_handle.is_none());
    assert!(app.state.agent.streaming_text.is_empty());
    let entry = app.state.session.chat_history.last().unwrap();
    assert!(entry.content.contains("partial answer"));
    assert!(entry.content.contains("provider failed"));
    assert!(entry.is_error && entry.interrupted);
}

/// A failure after executed tool work must adopt the loop's transcript so
/// the next turn resumes with the call and result, not the pre-turn
/// snapshot.
#[test]
fn error_adopts_the_loop_transcript() {
    let mut app = notice_test_app("/tmp/error-transcript");
    app.state.agent.state = AgentState::StreamingResponse;
    app.state.agent.task_handle = Some(app.runtime.spawn(std::future::pending()));
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::Error {
                message: "provider failed".into(),
                conversation: vec![agente_core::types::Message {
                    role: Role::User,
                    content: "executed tool work".into(),
                    tool_calls: None,
                    tool_call_id: None,
                    thinking: None,
                    thinking_signature: None,
                    continuation: None,
                    attachments: Vec::new(),
                }],
            },
        })
        .unwrap();

    app.process_agent_events();

    assert_eq!(app.state.session.conversation.len(), 1);
    assert_eq!(
        app.state.session.conversation[0].content,
        "executed tool work"
    );
    assert!(matches!(app.state.agent.state, AgentState::Idle));
}

#[test]
fn generation_progress_keeps_parent_and_child_tool_activity_separate() {
    let mut app = notice_test_app("/tmp/generation-progress");
    app.inject_agent_event(AgentEvent::GenerationProgress {
        subagent_id: None,
        output_bytes: 100,
        tool_name: Some("shell".into()),
    });
    app.inject_agent_event(AgentEvent::GenerationProgress {
        subagent_id: Some("child".into()),
        output_bytes: 200,
        tool_name: Some("read".into()),
    });
    app.process_agent_events();

    assert_eq!(app.state.agent.preparing_tool.as_deref(), Some("shell"));
    assert_eq!(
        app.state.agent.subagents["child"].preparing_tool.as_deref(),
        Some("read")
    );

    app.inject_agent_event(AgentEvent::GenerationProgress {
        subagent_id: None,
        output_bytes: 300,
        tool_name: None,
    });
    app.process_agent_events();
    assert!(app.state.agent.preparing_tool.is_none());
    assert_eq!(
        app.state.agent.subagents["child"].preparing_tool.as_deref(),
        Some("read")
    );
}

/// The provider's per-request prompt count is the true context size: each
/// TurnUsage must move the header readout, not just feed cost accounting.
#[test]
fn turn_usage_moves_the_live_context_readout() {
    let mut app = notice_test_app("/tmp/turn-usage-live");
    app.state.agent.total_tokens = 1_000;
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::TurnUsage {
                prompt_tokens: 48_000,
                completion_tokens: 200,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                context_tokens: 48_000,
            },
        })
        .unwrap();
    app.process_agent_events();
    assert_eq!(app.state.agent.total_tokens, 48_000);
    assert_eq!(app.state.agent.last_turn_prompt_tokens, 48_000);

    // Providers that report no usage must not zero the estimate.
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::TurnUsage {
                prompt_tokens: 0,
                completion_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                context_tokens: 0,
            },
        })
        .unwrap();
    app.process_agent_events();
    assert_eq!(app.state.agent.total_tokens, 48_000);

    // A mostly cached request: the meter shows the whole prompt, not
    // just its uncached tail (the old readout said "342 / 1M").
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::TurnUsage {
                prompt_tokens: 342,
                completion_tokens: 90,
                cache_read_tokens: 89_000,
                cache_creation_tokens: 0,
                context_tokens: 89_342,
            },
        })
        .unwrap();
    app.process_agent_events();
    assert_eq!(app.state.agent.total_tokens, 89_342);
}

/// A cancellation terminal must settle the phase even with a real task
/// handle installed: removing approvals once recomputed `Executing` from
/// the dead handle and left further input queued forever.
#[test]
fn cancelled_turn_with_real_handle_settles_to_idle() {
    let mut app = notice_test_app("/tmp/cancel-terminal");
    app.state.agent.state = AgentState::StreamingResponse;
    app.state.agent.streaming_text = "half".into();
    app.state.agent.task_handle = Some(app.runtime.spawn(std::future::pending()));
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::Cancelled {
                conversation: Vec::new(),
                tokens: 0,
                partial_text: "half".into(),
            },
        })
        .unwrap();
    app.process_agent_events();

    assert!(
        matches!(app.state.agent.state, AgentState::Idle),
        "{:?}",
        app.state.agent.state
    );
    assert!(app.state.agent.task_handle.is_none());
}

/// A direct shell command ends the turn itself; that path must also abort
/// the stored handle before settling the phase.
#[test]
fn direct_shell_completion_with_real_handle_settles_to_idle() {
    let mut app = notice_test_app("/tmp/direct-terminal");
    app.state.agent.state = AgentState::Executing;
    app.state.agent.task_handle = Some(app.runtime.spawn(std::future::pending()));
    app.state.agent.start_live_tool(
        "direct-1".into(),
        "shell".into(),
        "{\"command\":\"echo hi\"}".into(),
        true,
    );
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::ToolCallResult {
                id: "direct-1".into(),
                name: "shell".into(),
                result: "hi".into(),
                is_error: false,
            },
        })
        .unwrap();
    app.process_agent_events();

    assert!(
        matches!(app.state.agent.state, AgentState::Idle),
        "{:?}",
        app.state.agent.state
    );
    assert!(app.state.agent.task_handle.is_none());
}

/// A still-pending child approval keeps the phase at `WaitingApproval`
/// once the parent turn ends; it must not be cleared with the parent's.
#[test]
fn child_approval_keeps_waiting_approval_after_parent_turn_ends() {
    use agente_core::agent::ApprovalSource;
    use agente_core::types::ApprovalRequest;

    let mut app = notice_test_app("/tmp/child-approval-terminal");
    app.state.agent.state = AgentState::Executing;
    app.state.agent.task_handle = Some(app.runtime.spawn(std::future::pending()));
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::ApprovalRequested {
                source: ApprovalSource::Subagent { id: "child".into() },
                request: ApprovalRequest {
                    request_id: "r1".into(),
                    tool_name: "shell".into(),
                    tool_args: "{}".into(),
                    description: "child wants shell".into(),
                    is_dangerous: false,
                    old_content: None,
                    new_content: None,
                    file_path: None,
                },
            },
        })
        .unwrap();
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::Done {
                conversation: Vec::new(),
                tokens: 0,
            },
        })
        .unwrap();
    app.process_agent_events();

    assert!(
        matches!(app.state.agent.state, AgentState::WaitingApproval),
        "{:?}",
        app.state.agent.state
    );
    assert!(app.state.agent.task_handle.is_none());
    assert!(!app.state.agent.approval_queue.is_empty());
}

fn completed_notice(id: &str, subagent_type: &str, status: &str, summary: &str) -> AgentEvent {
    AgentEvent::SubagentCompletedNotice {
        id: id.into(),
        subagent_type: subagent_type.into(),
        status: status.into(),
        summary: summary.into(),
    }
}

fn notice_test_app(dir: &str) -> App {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut app = App::new_for_test(AppConfig::default(), dir.to_string(), runtime).unwrap();
    // No model, so an idle notice is recorded without resuming a turn
    // (tests that want the resume set one and drive it in a runtime).
    app.state.config.current_provider.clear();
    app.state.config.current_model.clear();
    app
}

/// A re-sent Started (dequeue launch) refreshes the card status without
/// duplicating its chat entry; a queued spawn reads pending from the
/// registry snapshot instead of the default running.
#[test]
fn subagent_started_upsert_tracks_queue_then_launch() {
    use agente_core::subagent::{SubagentSnapshot, SubagentStatus};

    let mut app = notice_test_app("/tmp/started-upsert");
    app.state.subagent_registry.insert(SubagentSnapshot {
        id: "q-1".into(),
        subagent_type: "explore".into(),
        description: "queued work".into(),
        prompt: "Inspect retry logic. Return file paths and findings.".into(),
        status: SubagentStatus::Pending,
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
    });
    let started = || AgentEvent::SubagentStarted {
        id: "q-1".into(),
        subagent_type: "explore".into(),
        description: "queued work".into(),
        model: "test-model".into(),
        seat: None,
    };
    app.inject_agent_event(started());
    app.process_agent_events();
    assert_eq!(app.state.agent.subagents["q-1"].status, "pending");

    // Launch flips the snapshot and re-announces: card follows, entry stays single.
    app.state
        .subagent_registry
        .update("q-1", |snap| snap.status = SubagentStatus::Running);
    app.inject_agent_event(started());
    app.process_agent_events();
    assert_eq!(app.state.agent.subagents["q-1"].status, "running");
    assert_eq!(
        app.state
            .session
            .chat_history
            .iter()
            .filter(|e| e.subagent_id.as_deref() == Some("q-1"))
            .count(),
        1
    );
}
/// A background completion with nobody waiting must reach the model
/// without polling: idle agent → direct conversation injection plus a
/// visible done-row.
#[test]
fn completed_notice_injects_conversation_message_when_idle() {
    let mut app = notice_test_app("/tmp/notice-idle");
    app.state.agent.state = AgentState::Idle;
    app.inject_agent_event(completed_notice(
        "s-1",
        "explore",
        "completed",
        "found the bug",
    ));
    app.process_agent_events();

    let last = app
        .state
        .session
        .conversation
        .last()
        .expect("notice must join the conversation");
    assert!(matches!(last.role, Role::User), "notice is model-facing");
    assert!(last.content.contains("s-1"), "{}", last.content);
    assert!(last.content.contains("found the bug"), "{}", last.content);
    assert!(
        app.state.session.pending_notices.is_empty(),
        "idle injection needs no queue"
    );
    assert!(
        app.state
            .session
            .chat_history
            .iter()
            .any(|e| e.content.contains("resume_from:s-1")),
        "a visible done-row must render"
    );
}

/// An idle completion notice must not only join the conversation: the
/// model has to be resumed so it actually consumes the result instead of
/// leaving it unread until the next user message.
#[test]
fn idle_completion_notice_resumes_the_model() {
    let mut app = notice_test_app("/tmp/notice-resume");
    app.state.agent.state = AgentState::Idle;
    app.state.config.current_provider = "test-provider".into();
    app.state.config.current_model = "test-model".into();

    let before = app.current_task_id;
    // Starting a turn calls `tokio::spawn`, which needs a runtime context;
    // drive the notice through the app's own runtime.
    let runtime = std::mem::replace(
        &mut app.runtime,
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap(),
    );
    runtime.block_on(async {
        app.inject_agent_event(completed_notice(
            "s-3",
            "general-purpose",
            "completed",
            "background work done",
        ));
        app.process_agent_events();
    });
    app.runtime = runtime;

    assert_eq!(app.current_task_id, before + 1, "a resume turn must start");
    assert!(
        app.state.agent.task_handle.is_some(),
        "the resume turn task must be spawned"
    );
    assert!(matches!(
        app.state.agent.state,
        AgentState::StreamingResponse
    ));
}

/// A notice arriving mid-turn must survive the terminal `Done`, which
/// replaces the conversation wholesale: queue now, drain at the boundary.
#[test]
fn completed_notice_queues_while_turn_runs_and_drains_on_done() {
    let mut app = notice_test_app("/tmp/notice-queued");
    app.state.agent.state = AgentState::StreamingResponse;
    app.inject_agent_event(completed_notice("s-2", "plan", "completed", "plan ready"));
    app.process_agent_events();

    assert!(
        app.state.session.conversation.is_empty(),
        "mid-turn notice must not push directly (Done would clobber it)"
    );
    assert_eq!(app.state.session.pending_notices.len(), 1);

    app.agent_tx
        .send(AgentTaskEvent {
            task_id: 0,
            event: AgentEvent::Done {
                conversation: Vec::new(),
                tokens: 0,
            },
        })
        .unwrap();
    app.process_agent_events();

    assert_eq!(app.state.session.conversation.len(), 1);
    assert!(
        app.state.session.conversation[0]
            .content
            .contains("plan ready"),
        "{:?}",
        app.state.session.conversation[0].content
    );
    assert!(app.state.session.pending_notices.is_empty());
}

#[test]
fn board_changed_accepted_for_earlier_turn_in_same_tab_and_rejected_for_closed_tab() {
    let mut app = notice_test_app("/tmp/board-routing");
    let t1 = app.next_task_id();
    app.current_task_id = t1;
    // Start turn 2 in the same tab.
    let t2 = app.next_task_id();
    app.current_task_id = t2;

    let mut board1 = agente_core::swarm::Board::default();
    board1.enabled = true;
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: t1,
            event: AgentEvent::BoardChanged {
                board: board1.clone(),
            },
        })
        .unwrap();
    app.process_agent_events();
    assert!(
        app.state.agent.board.as_ref().is_some_and(|b| b.enabled),
        "earlier turn's BoardChanged in same tab must be accepted"
    );

    // Open tab 2 and close tab 1; stale BoardChanged from closed tab 1 must be ignored.
    app.open_new_tab();
    app.close_tab(0);
    let mut stale_board = agente_core::swarm::Board::default();
    stale_board.enabled = true;
    app.agent_tx
        .send(AgentTaskEvent {
            task_id: t1,
            event: AgentEvent::BoardChanged { board: stale_board },
        })
        .unwrap();
    app.process_agent_events();
    assert!(
        app.state.agent.board.is_none(),
        "closed tab's BoardChanged must not contaminate the active tab"
    );
}

#[test]
fn direct_shell_result_drains_queued_notices() {
    let mut app = notice_test_app("/tmp/direct-notice");
    app.state.agent.state = AgentState::Executing;
    app.state
        .session
        .queue_notice("child finished while !cmd ran".into());
    app.state.agent.start_live_tool(
        "direct-1".into(),
        "shell".into(),
        "{\"command\":\"echo ok\"}".into(),
        true,
    );
    app.inject_agent_event(AgentEvent::ToolCallResult {
        id: "direct-1".into(),
        name: "shell".into(),
        result: "ok".into(),
        is_error: false,
    });
    app.process_agent_events();
    assert!(app.state.session.pending_notices.is_empty());
    assert!(app
        .state
        .session
        .conversation
        .iter()
        .any(|m| m.content.contains("child finished while !cmd ran")));
}

#[test]
fn done_with_bang_steering_and_notice_does_not_abort_started_shell() {
    let mut app = notice_test_app("/tmp/done-bang");
    app.state.config.current_provider = "test-provider".into();
    app.state.config.current_model = "test-model".into();
    app.state.agent.state = AgentState::Executing;
    app.state.session.queue_notice("subagent done".into());
    app.state.agent.steering_queue.push("!echo steered".into());

    app.inject_agent_event(AgentEvent::Done {
        conversation: Vec::new(),
        tokens: 0,
    });
    app.process_agent_events();

    // `!echo steered` should still be running (`Executing`), not replaced by
    // `start_chat_turn()` (`StreamingResponse`).
    assert_eq!(app.state.agent.state, AgentState::Executing);
    assert_eq!(
        app.state.session.pending_notices.len(),
        1,
        "notice stays queued until the steering shell finishes"
    );
    app.state.agent.abort_task();
}

#[test]
fn idle_completion_notice_does_not_abort_active_board_subagent_signal() {
    let mut app = notice_test_app("/tmp/notice-no-abort");
    app.state.agent.state = AgentState::Idle;
    app.state.config.current_provider = "test-provider".into();
    app.state.config.current_model = "test-model".into();

    // Simulate a background/board subagent holding a signal from turn 1's cancel_tx.
    let active_board_signal = app.state.cancel_tx.signal();
    let runtime = std::mem::replace(
        &mut app.runtime,
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap(),
    );
    runtime.block_on(async {
        app.inject_agent_event(completed_notice("s-board", "worker", "completed", "done"));
        app.process_agent_events();
    });
    app.runtime = runtime;

    assert!(
        !active_board_signal.is_aborted(),
        "follow-up turn must not abort active board subagents from the previous turn"
    );
    app.state.agent.abort_task();
}

#[test]
fn parallel_tool_calls_keep_independent_durations() {
    let mut app = notice_test_app("/tmp/parallel-duration");
    app.inject_agent_event(AgentEvent::ToolCallStart {
        id: "c1".into(),
        name: "read_file".into(),
        args: "{\"path\":\"a.rs\"}".into(),
    });
    app.inject_agent_event(AgentEvent::ToolCallStart {
        id: "c2".into(),
        name: "read_file".into(),
        args: "{\"path\":\"b.rs\"}".into(),
    });
    app.inject_agent_event(AgentEvent::ToolCallResult {
        id: "c1".into(),
        name: "read_file".into(),
        result: "a".into(),
        is_error: false,
    });
    app.inject_agent_event(AgentEvent::ToolCallResult {
        id: "c2".into(),
        name: "read_file".into(),
        result: "b".into(),
        is_error: false,
    });
    app.process_agent_events();

    let durations: Vec<Option<f64>> = app
        .state
        .session
        .chat_history
        .iter()
        .filter(|e| e.role == Role::Tool && e.response_duration.is_some())
        .map(|e| e.response_duration)
        .collect();
    assert_eq!(
        durations.len(),
        2,
        "both parallel tool results must retain their own duration"
    );
}

#[test]
fn discovery_scopes_model_selector_provider_and_clears_query() {
    let mut app = notice_test_app("/tmp/discovery-scope");
    app.state.config.connected_providers = vec!["openai".into()];
    app.state.config.set_discovered_models(
        "openai",
        vec![
            agente_core::providers::fallback_model_info("openai", "gpt-4o"),
            agente_core::providers::fallback_model_info("openai", "gpt-4o-mini"),
        ],
    );
    app.state.input.model_selector_query = "stale-query".into();
    app.refresh_model_selection_after_discovery("openai");
    assert!(app.state.input.show_model_selector);
    assert_eq!(
        app.state.input.model_selector_provider.as_deref(),
        Some("openai")
    );
    assert!(app.state.input.model_selector_query.is_empty());
}
