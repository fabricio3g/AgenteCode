//! Full-app visual harness.
//!
//! The per-widget snapshots in `widgets::chat::snapshot_tests` render one
//! widget into a bare rect. That misses everything that only goes wrong once
//! the widgets are *composed*: header + chat + composer +
//! activity strip + hint bar + overlays fighting over the same rows.
//!
//! This module renders the real [`crate::app::render_app_for_test`] frame for a
//! catalogue of realistic app states across a matrix of terminal sizes, writes
//! human-readable screenshots to `<crate>/target/ui-shots/`, and asserts the
//! layout invariants that catch visual bugs mechanically:
//!
//! * nothing panics at any size (down to 40x12),
//! * no control characters reach the screen,
//! * no cell is left with a `Reset` background — a hole where the user's
//!   terminal background bleeds through a themed panel,
//! * text never overflows the frame.
//!
//! Read the shots with `cargo test -p agente-tui ui_gallery` then open
//! `crates/agente-tui/target/ui-shots/`.

use chrono::TimeZone;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::style::Color;
use ratatui::Terminal;

use agente_core::config::AppConfig;
use agente_core::types::{
    AgentMode, AgentState, ApprovalRequest, ChatEntry, FileChangeStatus, ModifiedFile, Role, Todo,
    TodoPriority, TodoStatus,
};

use crate::state::{AppState, Fold};
use crate::state::{
    template_ask_questions, AskQuestion, ConnectScreen, PendingPlan, PlanAskState,
    PlanReviewPhase, RetryStatus, SubagentToolRow, SubagentUiState,
};

/// Terminal sizes every scenario must survive. `40x12` is deliberately hostile:
/// it is smaller than any panel the app wants to draw.
pub(crate) const SIZES: &[(u16, u16)] = &[(120, 40), (100, 30), (80, 24), (60, 18), (40, 12)];

/// Sizes written to disk for eyeballing (the full matrix).
const GALLERY_SIZES: &[(u16, u16)] = &[(120, 40), (100, 30), (80, 24), (60, 18), (40, 12)];

const PROJECT_DIR: &str = "/home/dev/agente";

fn ts() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc
        .with_ymd_and_hms(2024, 1, 1, 12, 0, 0)
        .single()
        .expect("fixed timestamp")
}

#[test]
fn transcript_uses_full_width_with_plan_and_changes() {
    for width in [60, 80, 120] {
        let mut state = base_state();
        seed_conversation(&mut state);
        seed_files(&mut state);
        state.show_changes_in_chat();
        state.show_plan_in_chat();
        let mut terminal = Terminal::new(TestBackend::new(width, 30)).unwrap();
        terminal
            .draw(|frame| crate::app::render_app(frame, &mut state))
            .unwrap();
        assert_eq!(state.ui.chat_area_x, 0);
        assert_eq!(
            state.ui.chat_frame_snapshot.as_ref().unwrap().width,
            usize::from(width - 1)
        );
    }
}

#[test]
fn repeated_resize_rewraps_the_existing_transcript_and_preserves_draft() {
    let mut state = base_state();
    seed_conversation(&mut state);
    state.input.input_text = "unfinished draft".into();
    let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
    for (w, h) in [(120, 40), (60, 18), (100, 30), (40, 12), (120, 40)] {
        terminal.backend_mut().resize(w, h);
        state.ui.clear_chat_render_cache();
        terminal
            .draw(|frame| crate::app::render_app(frame, &mut state))
            .unwrap();
        assert_eq!(terminal.backend().buffer().area.width, w);
        assert_eq!(
            state.ui.chat_frame_snapshot.as_ref().unwrap().width,
            usize::from(w - 1)
        );
        assert_eq!(state.input.input_text, "unfinished draft");
    }
}

/// Chat entry builder — every scenario needs one and the struct has 13 fields.
fn entry(role: Role, content: &str) -> ChatEntry {
    ChatEntry {
        id: uuid::Uuid::new_v4(),
        role,
        content: content.to_string(),
        tool_name: None,
        tool_args: None,
        is_error: false,
        timestamp: ts(),
        response_duration: None,
        mode: "Build".to_string(),
        interrupted: false,
        reasoning: None,
        subagent_id: None,
        subagent_type: None,
        diff_stats: None,
        attachments: Vec::new(),
    }
}

fn tool_entry(name: &str, args: &str, content: &str) -> ChatEntry {
    ChatEntry {
        tool_name: Some(name.to_string()),
        tool_args: Some(args.to_string()),
        response_duration: Some(412.0),
        ..entry(Role::Tool, content)
    }
}

/// Deterministic app state: fixed project dir, connected provider, pinned
/// animation clock, no filesystem-derived data.
fn base_state() -> AppState {
    let mut state = AppState::new(AppConfig::default(), PROJECT_DIR.to_string());
    // Explicit theme runs use a separate process and --test-threads=1.
    let requested_theme = match std::env::var("AGENTE_UI_THEME").as_deref() {
        Ok("light") => Some(crate::style::Theme::Light),
        Ok("dark") => Some(crate::style::Theme::Dark),
        _ => None,
    };
    if let Some(theme) = requested_theme {
        if crate::style::current_theme() != theme {
            crate::style::set_theme(theme);
        }
    }

    state.config.current_provider = "deepseek".to_string();
    state.config.current_model = "deepseek-v4-flash".to_string();
    state.config.connected_providers = vec!["deepseek".to_string()];
    state.ui.show_welcome_screen = false;
    // Screenshots capture one frame: show settled UI, not a mid-fade dialog.
    state.ui.reduce_motion = true;
    state
}

/// A conversation with the markdown and tool cards the chat widget has to
/// handle: headings, bold, list, fenced code, table, task list, tool cards.
fn seed_conversation(state: &mut AppState) {
    state.session.chat_history.push(entry(
        Role::User,
        "Add a retry guard to the provider client",
    ));
    state.session.chat_history.push(ChatEntry {
        response_duration: Some(2_140.0),
        ..entry(
            Role::Assistant,
            "## Plan\n\nI'll add a **bounded** retry with backoff.\n\n\
             - read the client\n- wrap the request\n- add a test\n\n\
             ```rust\nfn retry(max: u32) -> bool {\n    max > 0\n}\n```\n\n\
             | step | status |\n|------|--------|\n| read | done |\n| wrap | todo |\n\n\
             - [x] locate call site\n- [ ] add backoff\n",
        )
    });
    state.session.chat_history.push(tool_entry(
        "read_file",
        r#"{"path":"crates/agente-core/src/providers/openai.rs"}"#,
        "1  use reqwest::Client;\n2  pub struct OpenAiProvider;\n",
    ));
    state.session.chat_history.push(tool_entry(
        "shell",
        r#"{"command":"cargo check --workspace"}"#,
        "STDOUT:\n    Checking agente-core v0.0.1\n    Finished in 3.2s\nEXIT CODE: 0",
    ));
}

// ── Scenario catalogue ───────────────────────────────────────────────────────

type Build = fn(&mut AppState);

/// Every distinct surface the app can show. Non-capturing fns so the table is
/// a plain `const`-ish list.
pub(crate) fn scenarios() -> Vec<(&'static str, Build)> {
    vec![
        ("welcome_first_run", |s| {
            s.ui.show_welcome_screen = true;
            s.config.current_provider.clear();
            s.config.current_model.clear();
            s.config.connected_providers.clear();
        }),
        ("chat_markdown_and_tools", seed_conversation),
        ("chat_capability_table", |s| {
            let mut user = entry(Role::User, "What can you do?");
            user.timestamp = ts() - chrono::Duration::seconds(12);
            s.session.chat_history.push(user);
            let mut reply = entry(Role::Assistant,
                "| Area | Capabilities |\n|---|---|\n| **Code exploration** | • List files and directories (`list_dir`)<br>• Show symbols (`file_outline`)<br>• Search code (`grep`) |\n| **Planning & reasoning** | • Write a todo list (`todo_write`)<br>• Produce an implementation plan (`present_plan`) |\n| **Subagent orchestration** | • Spawn focused agents (`task`)<br>• Retrieve results (`task_output`) |\n\n**What I *can* do**\n\n- Inspect files in `~/.config`.\n- Explain findings and verify changes."
            );
            reply.timestamp = ts();
            s.session.chat_history.push(reply);
            s.ui.chat_auto_scroll = false;
            s.ui.chat_scroll = 0;
        }),
        ("chat_error_entry", |s| {
            seed_conversation(s);
            s.session.chat_history.push(ChatEntry {
                is_error: true,
                ..entry(
                    Role::Assistant,
                    "Request failed: 429 rate limited. Try /model to switch, or wait 30s.",
                )
            });
        }),
        ("chat_interrupted", |s| {
            seed_conversation(s);
            s.session.chat_history.push(ChatEntry {
                interrupted: true,
                ..entry(Role::Assistant, "Writing the backoff hel")
            });
        }),
        ("chat_streaming", |s| {
            seed_conversation(s);
            s.agent.state = AgentState::StreamingResponse;
            s.agent.streaming_text =
                "Now wiring the backoff into `send_request` so transient 5xx".to_string();
            s.agent.reasoning_text =
                "The client retries on 429 and 5xx only; 4xx must fail fast.".to_string();
        }),
        ("chat_live_shell", |s| {
            seed_conversation(s);
            s.agent.state = AgentState::Executing;
            s.agent.start_live_tool(
                "shell-live".into(),
                "shell".into(),
                r#"{"command":"cargo test --workspace"}"#.into(),
                false,
            );
            s.agent.append_live_tool_output(
                "shell-live",
                "Compiling agente-core\nCompiling agente-tui\nrunning test 47/129",
            );
        }),
        ("tool_card_expanded", |s| {
            seed_conversation(s);
            let mut out = String::new();
            for i in 0..30 {
                out.push_str(&format!("line {i:02} of build output\n"));
            }
            let expanded = tool_entry(
                "shell",
                r#"{"command":"cargo build --release"}"#,
                out.trim_end(),
            );
            let id = expanded.id;
            s.session.chat_history.push(expanded);
            s.ui.tool_fold.insert(id, Fold::Expanded);
        }),
        ("tool_truncated_fold", |s| {
            seed_conversation(s);
            let mut out = String::new();
            for i in 0..12 {
                out.push_str(&format!("line {i:02} of build output\n"));
            }
            let truncated = tool_entry(
                "shell",
                r#"{"command":"cargo build --release"}"#,
                &format!("STDOUT:\n{}\nEXIT CODE: 0", out.trim_end()),
            );
            let id = truncated.id;
            s.session.chat_history.push(truncated);
            // Shell defaults to Truncated; pin it so the scenario stays
            // readable even if the default ever changes.
            s.ui.tool_fold.insert(id, Fold::Truncated);
        }),
        ("tool_verb_group", |s| {
            seed_conversation(s);
            // A run of consecutive collapsed read_file cards folds into one
            // `◈ Read 3 files` summary header.
            let paths = [
                "crates/agente-core/src/providers/openai.rs",
                "crates/agente-core/src/providers/anthropic.rs",
                "crates/agente-core/src/retry.rs",
            ];
            let mut ids = Vec::new();
            for path in paths {
                let grouped = tool_entry(
                    "read_file",
                    &format!(r#"{{"path":"{path}"}}"#),
                    "1  use reqwest::Client;\n2  pub struct Provider;\n",
                );
                ids.push(grouped.id);
                s.session.chat_history.push(grouped);
            }
            // Explicit collapsed overrides keep this fixture independent of defaults.
            for id in ids {
                s.ui.tool_fold.insert(id, Fold::Collapsed);
            }
        }),
        ("tool_tree_expanded", |s| {
            seed_conversation(s);
            let mut ids = Vec::new();
            for path in ["src/main.rs", "src/config.rs", "src/tools.rs"] {
                let entry = tool_entry(
                    "read_file",
                    &format!(r#"{{"path":"{path}"}}"#),
                    "1  use std::sync::Arc;\n2  pub struct Config;\n",
                );
                ids.push(entry.id);
                s.session.chat_history.push(entry);
            }
            s.ui.expanded_groups.insert(ids[0]);
            s.ui.tool_fold.insert(ids[1], Fold::Truncated);
        }),
        ("overlay_help_scrolled", |s| {
            seed_conversation(s);
            s.ui.show_help = true;
            s.ui.help_scroll = 12;
            s.ui.help_visible = 14;
        }),
        ("chat_long_unbreakable_token", |s| {
            s.session.chat_history.push(entry(
                Role::User,
                "why does crates/agente-core/src/providers/a_very_long_module_path_that_never_wraps_nicely.rs fail",
            ));
            s.session.chat_history.push(entry(
                Role::Assistant,
                "See https://example.com/a/really/long/url/that/has/no/spaces/in/it/at/all/and/keeps/going/for/ages",
            ));
        }),
        ("chat_plan", |s| {
            seed_conversation(s);
            s.todo.update(vec![
                todo(
                    "Read the provider client",
                    TodoStatus::Completed,
                    TodoPriority::High,
                ),
                todo(
                    "Add bounded backoff",
                    TodoStatus::InProgress,
                    TodoPriority::High,
                ),
                todo(
                    "Cover it with a unit test",
                    TodoStatus::Pending,
                    TodoPriority::Medium,
                ),
                todo("Update AGENTS.md", TodoStatus::Pending, TodoPriority::Low),
            ]);
            s.show_plan_in_chat();
        }),
        ("chat_changes", |s| {
            seed_conversation(s);
            seed_files(s);
            s.show_changes_in_chat();
        }),
        ("chat_plan_and_changes", |s| {
            seed_conversation(s);
            seed_files(s);
            s.todo.update(vec![
                todo(
                    "Add bounded backoff",
                    TodoStatus::InProgress,
                    TodoPriority::High,
                ),
                todo(
                    "Cover it with a unit test",
                    TodoStatus::Pending,
                    TodoPriority::Medium,
                ),
            ]);
            s.show_changes_in_chat();
            s.show_plan_in_chat();
        }),
        ("diff_peek", |s| {
            seed_conversation(s);
            seed_files(s);
            s.session.file_originals.insert(
                "crates/agente-core/src/providers/openai.rs".into(),
                Some("fn send() {\n    client.get(url).send()\n}\n".into()),
            );
            s.session.file_versions.insert(
                "crates/agente-core/src/providers/openai.rs".into(),
                "fn send() {\n    retry(3, || client.get(url).send())\n}\n".into(),
            );
            s.ui.diff_peek = Some("crates/agente-core/src/providers/openai.rs".into());
        }),
        ("composer_long_text", |s| {
            seed_conversation(s);
            s.input.input_text =
                "please refactor the retry helper so the backoff is exponential with jitter and \
                 make sure the unit tests still pass afterwards"
                    .to_string();
            s.input.input_cursor = s.input.input_text.chars().count();
        }),
        ("composer_slash_picker", |s| {
            s.input.input_text = "/co".to_string();
            s.input.input_cursor = 3;
            s.input.show_slash_picker = true;
        }),
        ("composer_at_picker", |s| {
            s.input.input_text = "look at @prov".to_string();
            s.input.input_cursor = 13;
            s.input.show_at_picker = true;
            s.input.at_picker_anchor = 8;
            s.input.at_picker_query = "prov".to_string();
            s.input.at_file_cache = vec![
                "crates/agente-core/src/providers/mod.rs".into(),
                "crates/agente-core/src/providers/openai.rs".into(),
                "crates/agente-core/src/providers/anthropic.rs".into(),
            ];
        }),
        ("composer_queued", |s| {
            seed_conversation(s);
            s.agent.state = AgentState::Executing;
            s.agent.message_queue = vec![
                crate::state::QueuedMessage::new("then run the tests"),
                crate::state::QueuedMessage::new("and update the changelog"),
            ];
        }),
        ("approval_shell", |s| {
            seed_conversation(s);
            s.agent.state = AgentState::WaitingApproval;
            s.agent.enqueue_approval(
                agente_core::agent::ApprovalSource::Parent,
                ApprovalRequest {
                    request_id: "req-1".into(),
                    tool_name: "shell".into(),
                    tool_args: r#"{"command":"cargo test --workspace"}"#.into(),
                    description: "Run command: cargo test --workspace".into(),
                    is_dangerous: false,
                    old_content: None,
                    new_content: None,
                    file_path: None,
                },
            );
        }),
        ("approval_edit_diff", |s| {
            seed_conversation(s);
            s.agent.state = AgentState::WaitingApproval;
            s.agent.enqueue_approval(
                agente_core::agent::ApprovalSource::Parent,
                ApprovalRequest {
                    request_id: "req-2".into(),
                    tool_name: "edit_file".into(),
                    tool_args: r#"{"path":"src/providers/openai.rs"}"#.into(),
                    description: "Edit crates/agente-core/src/providers/openai.rs".into(),
                    is_dangerous: true,
                    old_content: Some("fn send() {\n    client.get(url).send()\n}\n".into()),
                    new_content: Some(
                        "fn send() {\n    retry(3, || client.get(url).send())\n}\n".into(),
                    ),
                    file_path: Some("crates/agente-core/src/providers/openai.rs".into()),
                },
            );
        }),
        ("overlay_help", |s| {
            seed_conversation(s);
            s.ui.show_help = true;
        }),
        ("overlay_command_palette", |s| {
            seed_conversation(s);
            s.input.show_command_palette = true;
            s.input.command_palette_query = "mo".to_string();
        }),
        ("overlay_model_selector", |s| {
            seed_conversation(s);
            s.input.show_model_selector = true;
        }),
        ("overlay_connect_select", |s| {
            s.config.connect_screen = ConnectScreen::SelectProvider {
                query: String::new(),
                selected: 0,
            };
        }),
        ("overlay_connect_key_error", |s| {
            s.config.connect_screen = ConnectScreen::EnterKey {
                provider: "anthropic".into(),
                error: "API key looks too short — paste the full key".into(),
                query: String::new(),
                replace: false,
            };
            s.config.connect_key_input = "sk-ant".to_string();
        }),
        ("overlay_session_picker", |s| {
            seed_conversation(s);
            s.picker.show_session_picker = true;
        }),
        ("overlay_thinking_selector", |s| {
            seed_conversation(s);
            s.input.open_thinking_selector(
                &["auto".into(), "off".into(), "high".into(), "max".into()],
                "high",
            );
            s.input.thinking_selector_budgets = vec![None, None, None, None];
        }),
        ("composer_paste_chip", |s| {
            seed_conversation(s);
            let payload: String = (0..142)
                .map(|i| format!("line {i} of a pasted stack trace\n"))
                .collect();
            let placeholder = s.input.stash_paste(&payload);
            s.input.input_text = format!("explain this failure {placeholder} please");
            s.input.input_cursor = s.input.input_text.chars().count();
        }),
        ("overlay_subagents", |s| {
            seed_conversation(s);
            seed_subagent(s);
            s.input.show_subagents = true;
        }),
        ("overlay_subagent_detail", |s| {
            seed_conversation(s);
            seed_subagent(s);
            s.ui.subagent_detail_id = Some("sub-1".to_string());
            s.ui.subagent_detail_scroll = 0;
        }),
        ("plan_review_card", |s| {
            seed_conversation(s);
            s.agent.set_mode(AgentMode::Plan);
            s.plan_review.phase = PlanReviewPhase::Review;
            s.plan_review.pending = Some(PendingPlan {
                path: ".agente/plans/retry-guard.md".into(),
                title: "Bounded retry for the provider client".into(),
                body_markdown: "## Goal\n\nStop transient 5xx from killing a turn.\n\n\
                                1. Wrap `send_request` in a bounded retry\n\
                                2. Exponential backoff with jitter\n\
                                3. Never retry 4xx\n\n\
                                ### Risk\n\nA retry storm if the cap is wrong."
                    .into(),
                version: 1,
            });
        }),
        ("plan_ask_questions", |s| {
            seed_conversation(s);
            s.agent.set_mode(AgentMode::Plan);
            s.plan_review.phase = PlanReviewPhase::Asking;
            s.plan_review.ask = Some(PlanAskState {
                original_comment: "make it better".into(),
                questions: vec![AskQuestion {
                    prompt: "What should change about the retry plan?".into(),
                    options: vec![
                        "Fewer retries".into(),
                        "Longer backoff".into(),
                        "Retry 4xx too".into(),
                    ],
                    selected: Some(1),
                    free_text: String::new(),
                }],
                question_index: 0,
                reask_count: 0,
            });
        }),
        ("plan_ask_multi", |s| {
            seed_conversation(s);
            s.agent.set_mode(AgentMode::Plan);
            s.plan_review.phase = PlanReviewPhase::Asking;
            // The real vague-feedback flow: four steps, two of them chips,
            // two free text. Step 2 is open, step 1 already answered.
            let mut questions = template_ask_questions("make it better");
            if let Some(q0) = questions.get_mut(0) {
                q0.selected = Some(1);
            }
            s.plan_review.ask = Some(PlanAskState {
                original_comment: "make it better".into(),
                questions,
                question_index: 1,
                reask_count: 0,
            });
        }),
        ("agent_subagent_card", |s| {
            seed_conversation(s);
            seed_subagent(s);
            s.agent.state = AgentState::Executing;
        }),
        ("agent_subagent_failed", |s| {
            seed_conversation(s);
            seed_subagent_status(s, "failed", "tool failed: ENOENT providers/openai.rs");
        }),
        ("agent_subagent_queued", |s| {
            seed_conversation(s);
            seed_subagent_status(s, "pending", "queued at position 2 (4 running)");
        }),
        ("overlay_subagent_detail_scrolled", |s| {
            seed_conversation(s);
            seed_subagent(s);
            s.ui.subagent_detail_id = Some("sub-1".to_string());
            s.ui.subagent_detail_scroll = 4;
        }),
        ("agent_retry_backoff", |s| {
            seed_conversation(s);
            s.agent.state = AgentState::StreamingResponse;
            s.agent.retry_status = Some(RetryStatus {
                attempt: 2,
                max_attempts: 3,
            });
        }),
        ("agent_context_warning", |s| {
            seed_conversation(s);
            // Above the 70% threshold that reveals the usage readout.
            s.agent.total_tokens = 58_000;
        }),
    ]
}

fn todo(content: &str, status: TodoStatus, priority: TodoPriority) -> Todo {
    Todo {
        id: content.to_string(),
        content: content.to_string(),
        status,
        priority,
    }
}

fn seed_files(state: &mut AppState) {
    state.session.modified_files = vec![
        ModifiedFile {
            path: "crates/agente-core/src/providers/openai.rs".into(),
            additions: 24,
            deletions: 3,
            status: FileChangeStatus::Modified,
        },
        ModifiedFile {
            path: "crates/agente-core/src/retry.rs".into(),
            additions: 61,
            deletions: 0,
            status: FileChangeStatus::Created,
        },
    ];
}

fn seed_subagent(state: &mut AppState) {
    let id = "sub-1".to_string();
    state.session.chat_history.push(ChatEntry {
        subagent_id: Some(id.clone()),
        subagent_type: Some("explore".into()),
        tool_name: Some("task".into()),
        content: "Find every provider retry call site".into(),
        ..entry(Role::Tool, "")
    });
    let worktree = agente_core::subagent::WorktreeInfo::synthetic(
        "/home/dev/agente",
        "/home/dev/agente/.agente/worktrees/explore-ab12cd34",
        "agente/explore-ab12cd34",
        "deadbeef",
        false,
    );
    // The popup reads the core registry, so the fixture must seed it too.
    state
        .subagent_registry
        .insert(agente_core::subagent::SubagentSnapshot {
            id: id.clone(),
            subagent_type: "explore".into(),
            description: "Find every provider retry call site".into(),
            prompt: "Inspect crates/agente-core/src/providers and agent/channel/retry.rs.\n\nFind every retry call site. Do not change files. Return exact paths, retry limits, and any missing cancellation checks.".into(),
            status: agente_core::subagent::SubagentStatus::Running,
            summary: None,
            conversation: Vec::new(),
            model: "DeepSeek V4 Flash".into(),
            depth: 1,
            background: false,
            started_at: chrono::Utc::now() - chrono::Duration::seconds(12),
            finished_at: None,
            cwd: Some(worktree.path.clone()),
            worktree: Some(worktree.clone()),
        });
    state.agent.subagents.insert(
        id,
        SubagentUiState {
            subagent_type: "explore".into(),
            description: "Find every provider retry call site".into(),
            status: "running".into(),
            streaming_text: "Checking anthropic.rs next".into(),
            tool_rows: vec![
                SubagentToolRow {
                    call_id: "grep-1".into(),
                    name: "grep".into(),
                    args: r#"{"pattern":"retry"}"#.into(),
                    result: Some("7 matches".into()),
                    is_error: false,
                    finished: true,
                },
                SubagentToolRow {
                    call_id: "read-1".into(),
                    name: "read_file".into(),
                    args: r#"{"path":"providers/openai.rs"}"#.into(),
                    result: None,
                    is_error: false,
                    finished: false,
                },
            ],
            summary: None,
            preparing_tool: None,
            model: "DeepSeek V4 Flash".into(),
            started_at: Some(chrono::Utc::now() - chrono::Duration::seconds(12)),
            finished_at: None,
            worktree: Some(worktree),
            spend: Default::default(),
        },
    );
}

fn seed_subagent_status(state: &mut AppState, status: &str, summary: &str) {
    seed_subagent(state);
    if let Some(ui) = state.agent.subagents.get_mut("sub-1") {
        ui.status = status.to_string();
        ui.summary = Some(summary.to_string());
        ui.finished_at = Some(chrono::Utc::now());
    }
    let core_status = match status {
        "failed" => agente_core::subagent::SubagentStatus::Failed,
        "pending" => agente_core::subagent::SubagentStatus::Pending,
        "cancelled" => agente_core::subagent::SubagentStatus::Cancelled,
        "completed" => agente_core::subagent::SubagentStatus::Completed,
        _ => agente_core::subagent::SubagentStatus::Running,
    };
    state.subagent_registry.update("sub-1", |snap| {
        snap.status = core_status;
        snap.summary = Some(summary.to_string());
        snap.finished_at = Some(chrono::Utc::now());
    });
    if let Some(entry) = state
        .session
        .chat_history
        .iter_mut()
        .find(|e| e.subagent_id.as_deref() == Some("sub-1"))
    {
        entry.is_error = status == "failed";
        entry.content = summary.to_string();
    }
}

// ── Rendering ────────────────────────────────────────────────────────────────

pub(crate) fn render_at(width: u16, height: u16, build: Build) -> Buffer {
    let mut state = base_state();
    build(&mut state);
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("test terminal");
    terminal
        .draw(|frame| crate::app::render_app(frame, &mut state))
        .expect("draw");
    terminal.backend().buffer().clone()
}

/// Human-readable dump: column ruler plus `|` row terminators so trailing
/// space, off-by-one and overflow are visible when the file is read back.
pub(crate) fn shot_text(buf: &Buffer) -> String {
    let w = buf.area.width;
    let mut out = String::new();
    out.push_str("    ");
    for x in 0..w {
        out.push(char::from_digit((x / 10 % 10) as u32, 10).unwrap_or('?'));
    }
    out.push('\n');
    out.push_str("    ");
    for x in 0..w {
        out.push(char::from_digit((x % 10) as u32, 10).unwrap_or('?'));
    }
    out.push('\n');
    for y in 0..buf.area.height {
        out.push_str(&format!("{y:3} |"));
        for x in 0..w {
            out.push_str(buf[(x, y)].symbol());
        }
        out.push_str("|\n");
    }
    out
}

/// A dark-theme surface (canvas or panel) left behind on a light frame.
fn is_dark_surface(color: Color) -> bool {
    matches!(color, Color::Black | Color::Rgb(0, 0, 0))
        || color == crate::style::dark::BG
        || color == crate::style::dark::BG_PANEL
}

fn write_shot(name: &str, buf: &Buffer) {
    // Anchored to the crate, not the test process cwd, so shots always land in
    // one place.
    let dir = gallery_dir();
    std::fs::create_dir_all(&dir).expect("create ui-shots dir");
    std::fs::write(dir.join(format!("{name}.txt")), shot_text(buf)).expect("write shot");
}

// ── Invariants ───────────────────────────────────────────────────────────────

/// One rule violation, with enough context to find it in the shot.
#[derive(Debug)]
struct Violation {
    scenario: String,
    size: (u16, u16),
    detail: String,
}

impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} @ {}x{}: {}",
            self.scenario, self.size.0, self.size.1, self.detail
        )
    }
}

fn check(scenario: &str, size: (u16, u16), buf: &Buffer, out: &mut Vec<Violation>) {
    let mut push = |detail: String| {
        out.push(Violation {
            scenario: scenario.to_string(),
            size,
            detail,
        })
    };

    let mut reset_bg: Option<(u16, u16)> = None;
    let mut reset_bg_count = 0usize;
    let mut dark_hole: Option<(u16, u16)> = None;
    let mut dark_hole_count = 0usize;
    // Under an explicit light run, dark fills are the light-theme version of
    // Reset bleed: a stale dark cache (or a missing fill) reads as black bars
    // on the white canvas. Read-only, so dark parallel runs are unaffected.
    let light_audit = crate::style::current_theme() == crate::style::Theme::Light;

    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            let cell = &buf[(x, y)];
            let sym = cell.symbol();

            if sym.chars().any(|c| c.is_control()) {
                push(format!("control char at ({x},{y}): {sym:?}"));
            }
            if sym.is_empty() {
                // ratatui uses "" for the trailing half of a wide glyph; a lone
                // empty cell with no wide neighbour is a paint bug.
                let prev_wide = x > 0 && unicode_width(buf[(x - 1, y)].symbol()) > 1;
                if !prev_wide {
                    push(format!("empty (non-continuation) cell at ({x},{y})"));
                }
            }
            if cell.bg == Color::Reset {
                reset_bg_count += 1;
                reset_bg.get_or_insert((x, y));
            }
            if light_audit && is_dark_surface(cell.bg) {
                dark_hole_count += 1;
                dark_hole.get_or_insert((x, y));
            }
        }
    }

    if let Some((x, y)) = reset_bg {
        push(format!(
            "{reset_bg_count} cell(s) with Reset background (theme hole), first at ({x},{y})"
        ));
    }
    if let Some((x, y)) = dark_hole {
        push(format!(
            "{dark_hole_count} cell(s) with a dark background under the light theme, first at ({x},{y})"
        ));
    }
}

/// Rough display width — enough to spot wide-glyph continuation cells.
fn unicode_width(s: &str) -> usize {
    s.chars()
        .map(|c| {
            let cp = c as u32;
            // CJK / emoji ranges that terminals render double-wide.
            if (0x1100..=0x115F).contains(&cp)
                || (0x2E80..=0xA4CF).contains(&cp)
                || (0xAC00..=0xD7A3).contains(&cp)
                || (0xF900..=0xFAFF).contains(&cp)
                || (0xFF00..=0xFF60).contains(&cp)
                || (0x1F300..=0x1FAFF).contains(&cp)
            {
                2
            } else {
                1
            }
        })
        .sum()
}

fn scenario_meta(name: &str) -> (&'static str, &'static str) {
    match name {
        "welcome_first_run" => (
            "Welcome & Onboarding",
            "First-time setup with supernova braille logo and connect nudge",
        ),
        "chat_markdown_and_tools" => (
            "Chat & Markdown",
            "Rich chat history with headings, code blocks, tables, task lists, and tool cards",
        ),
        "chat_error_entry" => (
            "Chat & Markdown",
            "Actionable error bubble for 429 rate limits and provider failures",
        ),
        "chat_interrupted" => (
            "Chat & Markdown",
            "User cancellation/interrupt tag on incomplete assistant response",
        ),
        "chat_streaming" => (
            "Chat & Markdown",
            "Live token streaming with reasoning thought drawer and spinner",
        ),
        "chat_live_shell" => (
            "Tools & Execution",
            "Live stdout/stderr stream from a running bash command",
        ),
        "tool_card_expanded" => (
            "Tools & Execution",
            "Expanded multi-line tool output with scrollable lines",
        ),
        "tool_truncated_fold" => (
            "Tools & Execution",
            "Shell card in truncated fold: three preview lines with a +N lines hint",
        ),
        "tool_verb_group" => (
            "Tools & Execution",
            "Run of collapsed tool cards folded into one verb-group summary header",
        ),
        "chat_long_unbreakable_token" => (
            "Layout & Wrapping",
            "Long URLs and module paths testing boundary wrapping without overflow",
        ),
        "chat_plan" => (
            "Chat Summaries & Diffs",
            "Inline plan checklist with textual statuses",
        ),
        "chat_changes" => (
            "Chat Summaries & Diffs",
            "Session file changes in the transcript",
        ),
        "chat_plan_and_changes" => (
            "Chat Summaries & Diffs",
            "Full-width chat showing file changes and plan steps",
        ),
        "diff_peek" => (
            "Chat Summaries & Diffs",
            "Full-screen diff view modal showing additions and deletions",
        ),
        "composer_long_text" => (
            "Composer & Inputs",
            "Multi-line composer input with cursor positioning and line wrapping",
        ),
        "composer_slash_picker" => (
            "Composer & Inputs",
            "Autocomplete dropdown popup for slash commands (/model, /compact)",
        ),
        "composer_at_picker" => (
            "Composer & Inputs",
            "@ mention file picker filtered by query and .gitignore",
        ),
        "composer_queued" => (
            "Composer & Inputs",
            "Follow-up message queue badge and preview chips",
        ),
        "approval_shell" => (
            "Approvals & Safety",
            "Approval prompt for shell command execution",
        ),
        "approval_edit_diff" => (
            "Approvals & Safety",
            "Dangerous file edit approval with diff summary",
        ),
        "overlay_help" => (
            "Overlays & Dialogs",
            "Keyboard shortcut cheat sheet and command guide",
        ),
        "overlay_help_scrolled" => (
            "Overlays & Dialogs",
            "Scrolled help overlay testing footer clamping and overflow",
        ),
        "overlay_command_palette" => (
            "Overlays & Dialogs",
            "Fuzzy command palette for instant navigation and commands",
        ),
        "overlay_model_selector" => (
            "Overlays & Dialogs",
            "Model picker grouped by connected provider with search",
        ),
        "overlay_connect_select" => (
            "Overlays & Dialogs",
            "Provider connection modal with 3 categories (Popular/Local/Other)",
        ),
        "overlay_connect_key_error" => (
            "Overlays & Dialogs",
            "API key validation error display with inline correction prompt",
        ),
        "overlay_session_picker" => (
            "Overlays & Dialogs",
            "Resume past session dialog with search filter",
        ),
        "overlay_thinking_selector" => (
            "Overlays & Dialogs",
            "Thinking-effort scale: Auto plus the model's levels, low to high, with the current budget",
        ),
        "composer_paste_chip" => (
            "Composer & Inputs",
            "Large paste collapsed to a one-line chip instead of flooding the composer",
        ),
        "overlay_subagents" => (
            "Subagents & Teams",
            "Active subagent manager popup with kill shortcuts",
        ),
        "overlay_subagent_detail" => (
            "Subagents & Teams",
            "Focused subagent card modal with live tools and streaming output",
        ),
        "plan_review_card" => (
            "Planning Mode",
            "Plan review takeover card showing goals, steps, and risks",
        ),
        "plan_ask_questions" => (
            "Planning Mode",
            "Interactive clarification questionnaire with selectable options",
        ),
        "plan_ask_multi" => (
            "Planning Mode",
            "Four-step clarify flow: answered step marked, chips on the open step, free-text steps below",
        ),
        "agent_subagent_card" => (
            "Subagents & Teams",
            "Nested subagent execution card with nested tool calls",
        ),
        "agent_subagent_failed" => (
            "Subagents & Teams",
            "Failed subagent card with the error rail and dimmed result",
        ),
        "agent_subagent_queued" => (
            "Subagents & Teams",
            "Queued subagent card waiting for a concurrency slot",
        ),
        "overlay_subagent_detail_scrolled" => (
            "Subagents & Teams",
            "Subagent detail modal scrolled past the first tool rows",
        ),
        "agent_retry_backoff" => (
            "Agent State & Status",
            "Transient error retry countdown indicator",
        ),
        "agent_context_warning" => (
            "Agent State & Status",
            "Token context bar warning displayed when above 70% threshold",
        ),
        _ => ("General", "Agente TUI application state"),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn ui_gallery_writes_screenshots() {
    let mut gallery_data = Vec::new();

    for (name, build) in scenarios() {
        let (category, desc) = scenario_meta(name);
        for &(w, h) in GALLERY_SIZES {
            let buf = render_at(w, h, build);
            write_shot(&format!("{name}_{w}x{h}"), &buf);

            let serialized = crate::web_export::serialize_buffer(&buf);
            gallery_data.push((name, (w, h), serialized, category, desc));
        }
    }

    // Write interactive browser visual gallery HTML
    let html = crate::web_export::generate_visual_gallery_html(&gallery_data);
    let dir = gallery_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("gallery.html"), &html);
}

fn gallery_dir() -> std::path::PathBuf {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ui-shots");
    if std::env::var("AGENTE_UI_THEME").as_deref() == Ok("light") {
        dir.join("light")
    } else {
        dir
    }
}

#[test]
fn ui_invariants_hold_at_every_size() {
    let mut violations = Vec::new();
    for (name, build) in scenarios() {
        for &size in SIZES {
            let buf = render_at(size.0, size.1, build);
            check(name, size, &buf, &mut violations);
        }
    }
    assert!(
        violations.is_empty(),
        "{} layout violation(s):\n{}",
        violations.len(),
        violations
            .iter()
            .map(|v| format!("  - {v}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// A floating dialog dims the transcript behind it but stays opaque itself.
///
/// Ctrl+P-style modals paint a transparent-gray veil over chat: glyphs stay
/// visible, recolored toward dim gray, while the card (`BG_PANEL` + `Clear`)
/// covers whatever sits directly beneath it. This plants a marker throughout
/// the transcript and requires both halves: (a) marker text is still visible
/// somewhere (the backdrop is transparent, not wiped) and (b) no marker run
/// overlaps a `BG_PANEL` cell run on its row (the card is opaque, not
/// leaking — the old fault was transcript text chopped mid-word straight
/// through the card's row band).
#[test]
fn floating_modals_dim_the_backdrop_but_hide_the_card_area() {
    const MARKER: &str = "ZZMARKERZZ";

    let floating: &[(&str, Build)] = &[
        ("overlay_model_selector", |s| {
            s.input.show_model_selector = true;
        }),
        ("overlay_command_palette", |s| {
            s.input.show_command_palette = true;
            s.input.command_palette_query = "mo".to_string();
        }),
        ("overlay_subagents", |s| {
            seed_subagent(s);
            s.input.show_subagents = true;
        }),
        ("overlay_subagent_detail", |s| {
            seed_subagent(s);
            s.ui.subagent_detail_id = Some("sub-1".to_string());
            s.ui.subagent_detail_scroll = 0;
        }),
        ("approval_shell", |s| {
            s.agent.state = AgentState::WaitingApproval;
            s.agent.enqueue_approval(
                agente_core::agent::ApprovalSource::Parent,
                ApprovalRequest {
                    request_id: "req-1".into(),
                    tool_name: "shell".into(),
                    tool_args: r#"{"command":"cargo test --workspace"}"#.into(),
                    description: "Run command: cargo test --workspace".into(),
                    is_dangerous: false,
                    old_content: None,
                    new_content: None,
                    file_path: None,
                },
            );
        }),
    ];

    let panel_bg = crate::style::BG_PANEL();
    let mut failures = Vec::new();
    for (name, build) in floating {
        // (a) is per modal across sizes: a small card at 120x40 always leaves
        // dimmed transcript visible, while at 60x18 a tall card may legitimately
        // cover the whole content area.
        let mut seen_any = false;
        for &(w, h) in &[(120u16, 40u16), (100, 30), (80, 24), (60, 18)] {
            let mut state = base_state();
            // Plant the marker throughout the transcript so any visible chat
            // row reveals it.
            for _ in 0..40 {
                state.session.chat_history.push(entry(
                    Role::Assistant,
                    &format!("{MARKER} {MARKER} {MARKER}"),
                ));
            }
            build(&mut state);

            let backend = TestBackend::new(w, h);
            let mut terminal = Terminal::new(backend).expect("test terminal");
            terminal
                .draw(|frame| crate::app::render_app(frame, &mut state))
                .expect("draw");
            let buf = terminal.backend().buffer().clone();

            for y in 0..h {
                let row: String = (0..w).map(|x| buf[(x, y)].symbol()).collect();
                // Maximal contiguous runs of opaque card cells on this row.
                let mut runs = Vec::new();
                let mut x = 0u16;
                while x < w {
                    if buf[(x, y)].bg == panel_bg {
                        let start = x;
                        while x < w && buf[(x, y)].bg == panel_bg {
                            x += 1;
                        }
                        runs.push((start as usize, x as usize));
                    } else {
                        x += 1;
                    }
                }
                for (start, _) in row.match_indices(MARKER) {
                    seen_any = true;
                    let end = start + MARKER.len();
                    if runs.iter().any(|&(rs, re)| start < re && end > rs) {
                        failures.push(format!(
                            "{name} @ {w}x{h} row {y}: transcript leaks through the card"
                        ));
                    }
                }
            }
        }
        if !seen_any {
            failures.push(format!(
                "{name}: backdrop wiped the transcript instead of dimming it"
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} failure(s):\n{}",
        failures.len(),
        failures
            .iter()
            .map(|f| format!("  - {f}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// A mid-session `/theme` toggle must not leave stale dark rows behind
/// (black timestamp bars on the white canvas).
///
/// The per-entry render cache key has no theme component, so the toggle used
/// to rely on the frame snapshot alone — cached rows with baked dark
/// backgrounds survived amid fresh light ones. Every switch path now routes
/// through `AppState::apply_theme`, which also drops the caches; this drives
/// that exact helper on one live buffer (dark paint → toggle → light paint)
/// and requires zero dark holes, with a timestamp row present as a witness.
///
/// Explicit-theme runs use a separate single-threaded process
/// (`AGENTE_UI_THEME=light cargo test -p agente-tui -- --test-threads=1
/// theme_toggle`); without the env var this returns early so parallel dark
/// runs never see a theme flip.
#[test]
fn theme_toggle_leaves_no_dark_holes() {
    if std::env::var("AGENTE_UI_THEME").as_deref() != Ok("light") {
        return;
    }
    let mut state = base_state();
    state.session.chat_history.push(ChatEntry {
        response_duration: Some(71_700.0),
        reasoning: Some("checking the workspace layout first".to_string()),
        ..entry(Role::Assistant, "Done.")
    });

    // Dark session: populate the render cache with dark-styled rows.
    state.apply_theme(crate::style::Theme::Dark);
    let backend = TestBackend::new(100, 30);
    let mut terminal = Terminal::new(backend).expect("test terminal");
    terminal
        .draw(|frame| crate::app::render_app(frame, &mut state))
        .expect("dark draw");

    // The `/theme` switch through the production helper, then keep painting
    // into the same live buffer.
    state.apply_theme(crate::style::Theme::Light);
    terminal
        .draw(|frame| crate::app::render_app(frame, &mut state))
        .expect("light draw");
    let buf = terminal.backend().buffer().clone();

    let mut dark_holes = 0usize;
    let mut seen_timestamp = false;
    for y in 0..buf.area.height {
        let row: String = (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect();
        if (row.contains("AM") || row.contains("PM")) && !row.contains("Thought for") {
            // Timestamp rows carry the witness text; the thought header sits
            // on the row below (checked implicitly by the full scan).
            seen_timestamp = true;
        }
        for x in 0..buf.area.width {
            if buf[(x, y)].bg == Color::Reset || is_dark_surface(buf[(x, y)].bg) {
                dark_holes += 1;
            }
        }
    }
    assert!(seen_timestamp, "expected a timestamp row in the shot");
    assert_eq!(dark_holes, 0, "stale dark rows survived the theme toggle");
}

/// Sweep hostile geometry. A resize drag delivers every intermediate size, and
/// a panic here kills the app for real (`render_app_safe` writes a crash log and
/// re-panics). Widths/heights are spread thin-to-wide rather than exhaustive so
/// the sweep stays under a second.
#[test]
fn ui_survives_degenerate_sizes() {
    const WIDTHS: &[u16] = &[1, 2, 3, 5, 8, 13, 20, 21, 34, 55, 76, 89, 200];
    const HEIGHTS: &[u16] = &[1, 2, 3, 5, 6, 8, 13, 21];

    for (name, build) in scenarios() {
        for &w in WIDTHS {
            for &h in HEIGHTS {
                let buf = render_at(w, h, build);
                assert_eq!(
                    (buf.area.width, buf.area.height),
                    (w, h),
                    "{name} painted outside the frame at {w}x{h}"
                );
            }
        }
    }
}

#[test]
fn hovered_subagent_card_gets_a_band_and_rail() {
    let mut state = base_state();
    seed_subagent(&mut state);
    let draw = |state: &mut AppState| {
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).expect("test terminal");
        terminal
            .draw(|frame| crate::app::render_app(frame, state))
            .expect("draw");
        terminal.backend().buffer().clone()
    };
    let buf = draw(&mut state);
    let row = (0..24)
        .find(|&y| {
            let text: String = (0..80).map(|x| buf[(x, y)].symbol()).collect();
            text.contains("Explore  Find every provider")
        })
        .expect("subagent card painted");
    let id = state
        .session
        .chat_history
        .iter()
        .find(|e| e.subagent_id.is_some())
        .unwrap()
        .id;
    state.ui.hovered_entry_id = Some(id);
    let buf = draw(&mut state);
    assert_eq!(buf[(0, row)].symbol(), "▎", "accent rail on hover");
    assert_eq!(
        buf[(40, row)].bg,
        crate::style::BG_HOVER(),
        "full hover band"
    );
    assert_eq!(
        buf[(0, row + 1)].symbol(),
        "▎",
        "rail spans the activity row"
    );
    assert_ne!(
        buf[(40, row + 2)].bg,
        crate::style::BG_HOVER(),
        "spacer stays bare"
    );
}

#[test]
fn sent_prompt_glides_into_place_and_repins() {
    let draw = |state: &mut AppState| {
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).expect("test terminal");
        terminal
            .draw(|frame| crate::app::render_app(frame, state))
            .expect("draw");
    };
    for reduce_motion in [false, true] {
        let mut state = base_state();
        state.ui.reduce_motion = reduce_motion;
        seed_conversation(&mut state);
        draw(&mut state);
        assert!(state.ui.chat_auto_scroll);

        state.add_user_message("hola, agente".into());
        draw(&mut state);
        if reduce_motion {
            assert!(state.ui.message_fade.is_none());
            assert_eq!(state.ui.chat_scroll, state.max_scroll(), "snaps");
            continue;
        }
        assert!(state.ui.message_fade.is_some_and(|t| t.running()));
        assert!(state.ui.chat_scroll < state.max_scroll(), "still gliding");
        let mut frames = 1;
        while state.ui.scroll_target.is_some() {
            draw(&mut state);
            frames += 1;
            assert!(frames < 20, "glide must settle");
        }
        assert_eq!(state.ui.chat_scroll, state.max_scroll());
        assert!(state.ui.chat_auto_scroll, "re-pinned to follow the reply");
    }
}

#[test]
fn status_row_shows_session_spend_and_cache_rate() {
    let mut state = base_state();
    state.agent.spend.record(1_000, 200, 4_000, 0, Some(0.042));
    let mut terminal = Terminal::new(TestBackend::new(100, 20)).expect("test terminal");
    terminal
        .draw(|frame| crate::app::render_app(frame, &mut state))
        .expect("draw");
    let buf = terminal.backend().buffer();
    // The status row sits under the composer: the last row of the frame.
    let status: String = (0..100).map(|x| buf[(x, 19)].symbol()).collect();
    assert!(status.contains("$0.042 · 80% cached"), "status: {status}");
    let header: String = (0..100).map(|x| buf[(x, 0)].symbol()).collect();
    assert!(
        !header.contains('$'),
        "header no longer carries spend: {header}"
    );
}

#[test]
fn hovered_prompt_lifts_and_offers_its_actions() {
    let mut state = base_state();
    state.add_user_message("Implement the plan".into());
    state.ui.message_fade = None;
    state.ui.scroll_target = None;
    state.ui.chat_auto_scroll = true;
    let draw = |state: &mut AppState| {
        let mut terminal = Terminal::new(TestBackend::new(80, 20)).expect("test terminal");
        terminal
            .draw(|frame| crate::app::render_app(frame, state))
            .expect("draw");
        terminal.backend().buffer().clone()
    };
    let text = |buf: &Buffer, y: u16| -> String { (0..80).map(|x| buf[(x, y)].symbol()).collect() };
    let buf = draw(&mut state);
    let row = (0..20)
        .find(|&y| text(&buf, y).contains("Implement the plan"))
        .expect("bubble painted");
    assert!(text(&buf, row).contains('▎'), "rail");
    assert!(
        text(&buf, row - 1).contains('▎'),
        "padded card, not a thin band"
    );
    state.ui.hovered_entry_id = Some(state.session.chat_history[0].id);
    let buf = draw(&mut state);
    let hovered = text(&buf, row);
    assert!(hovered.contains("revert · fork · copy"), "{hovered}");
    assert!(hovered.contains("Implement the plan"), "text never covered");
}

#[test]
fn hovered_tool_card_has_no_hole_at_a_blank_output_line() {
    let mut state = base_state();
    state.session.chat_history.push(tool_entry(
        "shell",
        r#"{"command":"sed -n 1,5p src/track.c"}"#,
        "b->tz = tz / l;\n\n}",
    ));
    let id = state.session.chat_history.last().unwrap().id;
    state.ui.tool_fold.insert(id, Fold::Expanded);
    state.ui.hovered_entry_id = Some(id);
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).expect("test terminal");
    terminal
        .draw(|frame| crate::app::render_app(frame, &mut state))
        .expect("draw");
    let buf = terminal.backend().buffer().clone();
    let row_of = |needle: &str| {
        (0..24)
            .find(|&y| {
                let text: String = (0..80).map(|x| buf[(x, y)].symbol()).collect();
                text.contains(needle)
            })
            .unwrap_or_else(|| panic!("{needle} painted"))
    };
    let first = row_of("b->tz = tz / l;");
    let collapse = row_of("collapse");
    let hover = crate::style::BG_HOVER();
    for y in first..=collapse {
        assert_eq!(buf[(40, y)].bg, hover, "row {y} of the card is tinted");
    }
    assert_ne!(
        buf[(40, collapse + 1)].bg,
        hover,
        "the gap after the card stays bare"
    );
}
