use super::*;
use crate::app::App;
use agente_core::config::AppConfig;
use agente_core::types::{self, AgentState, ChatEntry};

fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
    KeyEvent::new(code, modifiers)
}

fn test_app() -> App {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    App::new_for_test(AppConfig::default(), "/tmp/key-test".to_string(), runtime).unwrap()
}

#[test]
fn typed_skill_command_loads_the_skill_for_the_turn() {
    let project = tempfile::tempdir().unwrap();
    let dir = project.path().join(".agente/skills/zq-lint");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        "---\nname: zq-lint\ndescription: Lint things\n---\nRun the linter twice.",
    )
    .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut app = App::new_for_test(
        AppConfig::default(),
        project.path().to_string_lossy().into_owned(),
        runtime,
    )
    .unwrap();
    app.state.ui.show_welcome_screen = false;
    for c in "/zq-lint check src".chars() {
        app.handle_key(key(KeyCode::Char(c), KeyModifiers::NONE))
            .unwrap();
    }
    // The turn spawns its task on the ambient runtime.
    let ambient = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _guard = ambient.enter();
    let _ = app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE));

    let bubble = app
        .state
        .session
        .chat_history
        .iter()
        .rev()
        .find(|e| e.role == types::Role::User)
        .expect("user bubble");
    assert_eq!(
        bubble.content, "/zq-lint check src",
        "the bubble shows what was typed"
    );
    let sent = app
        .state
        .session
        .conversation
        .iter()
        .rev()
        .find(|m| m.role == types::Role::User)
        .expect("user turn");
    assert!(
        sent.content.starts_with("<skill_content name=\"zq-lint\">"),
        "{}",
        sent.content
    );
    assert!(sent.content.contains("Run the linter twice."));
    assert!(sent.content.ends_with("check src"));
}

#[test]
fn dropped_media_asks_attaches_and_travels_with_the_message() {
    let mut app = test_app();
    app.state.ui.show_welcome_screen = false;
    app.state.config.current_provider = "stub".into();
    app.state.config.current_model = "stub-text".into();
    let dir = tempfile::tempdir().unwrap();
    let shot = dir.path().join("my shot.png");
    std::fs::write(&shot, b"\x89PNG\r\n\x1a\n\0\0\0\0").unwrap();

    // A terminal drop pastes the (quoted) path.
    app.insert_paste(&format!("'{}'", shot.display()));
    let asked = app
        .state
        .ui
        .media_consent
        .clone()
        .expect("images ask first");
    assert_eq!(asked.name, "my shot.png");
    assert!(
        app.state.input.input_text.is_empty(),
        "the path is not typed in"
    );
    app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
        .unwrap();
    assert!(app.state.ui.media_consent.is_none());
    assert_eq!(app.state.input.attachments.len(), 1);
    assert!(std::path::Path::new(&app.state.input.attachments[0].path).exists());

    // A text-only model: nothing is sent, the attachment stays.
    for c in "what is this".chars() {
        app.handle_key(key(KeyCode::Char(c), KeyModifiers::NONE))
            .unwrap();
    }
    app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
        .unwrap();
    assert!(app.state.session.conversation.is_empty());
    assert_eq!(app.state.input.attachments.len(), 1);
    assert_eq!(app.state.input.input_text, "what is this");

    // A vision model takes it.
    app.state.config.current_model = "stub-vision".into();
    let ambient = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _guard = ambient.enter();
    let _ = app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE));
    assert!(app.state.input.attachments.is_empty());
    let sent = app
        .state
        .session
        .conversation
        .iter()
        .rev()
        .find(|m| m.role == types::Role::User)
        .expect("sent");
    assert_eq!(sent.content, "what is this");
    assert_eq!(sent.attachments.len(), 1);
    let bubble = app.state.session.chat_history.last().unwrap();
    assert_eq!(bubble.attachments.len(), 1, "the bubble shows it too");
}

#[test]
fn always_allow_skips_the_question_next_time() {
    let mut app = test_app();
    let dir = tempfile::tempdir().unwrap();
    let clip = dir.path().join("clip.mp4");
    std::fs::write(&clip, b"video").unwrap();
    app.insert_paste(&clip.to_string_lossy());
    app.handle_key(key(KeyCode::Char('a'), KeyModifiers::NONE))
        .unwrap();
    assert_eq!(
        app.state.config.config.allow_media,
        [agente_core::media::AttachmentKind::Video]
    );
    app.state.input.attachments.clear();
    app.insert_paste(&clip.to_string_lossy());
    assert!(app.state.ui.media_consent.is_none(), "no question now");
    assert_eq!(app.state.input.attachments.len(), 1);
    // Esc on a question declines.
    let png = dir.path().join("x.png");
    std::fs::write(&png, b"\x89PNG\r\n\x1a\n\0\0\0\0").unwrap();
    app.insert_paste(&png.to_string_lossy());
    app.handle_key(key(KeyCode::Esc, KeyModifiers::NONE))
        .unwrap();
    assert_eq!(app.state.input.attachments.len(), 1);

    // Blocked media in deny_media refuses immediately without asking.
    app.state
        .config
        .config
        .deny_media
        .push(agente_core::media::AttachmentKind::Image);
    app.insert_paste(&png.to_string_lossy());
    assert!(
        app.state.ui.media_consent.is_none(),
        "blocked media must not prompt"
    );
    assert_eq!(app.state.input.attachments.len(), 1);
    assert_eq!(app.state.input.attachments.len(), 1, "declined");
}

#[test]
fn enter_queues_and_enter_again_sends_now() {
    let mut app = test_app();
    app.state.ui.show_welcome_screen = false;
    app.state.config.current_provider = "stub".into();
    app.state.agent.state = AgentState::Executing;
    let enter = |app: &mut App| {
        app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap()
    };
    for c in "run the tests".chars() {
        app.handle_key(key(KeyCode::Char(c), KeyModifiers::NONE))
            .unwrap();
    }
    enter(&mut app);
    assert_eq!(app.state.agent.message_queue.len(), 1, "queued");
    assert!(
        app.state.session.chat_history.is_empty(),
        "no bubble before it is sent"
    );

    // Up on an empty composer edits it; Enter re-queues.
    app.handle_key(key(KeyCode::Up, KeyModifiers::NONE))
        .unwrap();
    assert_eq!(app.state.input.input_text, "run the tests");
    assert!(app.state.agent.message_queue.is_empty());
    enter(&mut app);

    // Enter again on the empty composer: hand it to the running turn.
    enter(&mut app);
    assert!(app.state.agent.message_queue[0].sending);
    let inbox: Vec<String> = app
        .state
        .agent
        .user_inbox
        .lock()
        .iter()
        .map(|m| m.content.clone())
        .collect();
    assert_eq!(inbox, ["run the tests"]);

    // The loop takes it: now it is a bubble.
    app.inject_agent_event(agente_core::agent::AgentEvent::UserMessagesInjected {
        messages: vec!["run the tests".into()],
    });
    app.process_agent_events();
    assert!(app.state.agent.message_queue.is_empty());
    assert_eq!(
        app.state.session.chat_history.last().unwrap().content,
        "run the tests"
    );
}

#[test]
fn mcp_dialog_enables_and_turns_off_servers() {
    let mut config = AppConfig::default();
    config.mcp.insert(
        "docs".into(),
        agente_core::mcp::McpConfig {
            command: vec!["true".into()],
            enabled: false,
            ..Default::default()
        },
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut app = App::new_for_test(config, "/tmp/mcp-key-test".into(), runtime).unwrap();
    app.execute_command(crate::command_palette::Command::Mcp)
        .unwrap();
    assert_eq!(
        crate::state::modal_owner(&app.state),
        crate::state::ModalOwner::Mcp
    );
    app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
        .unwrap();
    assert!(app.state.config.config.mcp["docs"].enabled, "Enter enables");
    app.handle_key(key(KeyCode::Char('d'), KeyModifiers::NONE))
        .unwrap();
    assert!(
        !app.state.config.config.mcp["docs"].enabled,
        "d turns it off"
    );
    assert_eq!(
        app.state.config.mcp_manager.snapshots()[0].status,
        agente_core::mcp::ServerStatus::Disabled
    );
    app.handle_key(key(KeyCode::Esc, KeyModifiers::NONE))
        .unwrap();
    assert!(!app.state.input.show_mcp);
}

#[test]
fn skills_dialog_enter_puts_the_command_in_the_composer() {
    let mut app = test_app();
    app.state.input.show_skills = true;
    app.state.input.skills = vec![agente_core::extensions::Skill {
        name: "pdf".into(),
        description: "PDFs".into(),
        source: "/s/pdf/SKILL.md".into(),
        dir: "/s/pdf".into(),
        scope: agente_core::extensions::SkillScope::User,
        model_invocable: true,
        compatibility: None,
    }];
    app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
        .unwrap();
    assert!(!app.state.input.show_skills);
    assert_eq!(app.state.input.input_text, "/pdf ");
    assert_eq!(app.state.input.input_cursor, 5);
}

fn chat_entry(content: &str) -> ChatEntry {
    ChatEntry {
        id: uuid::Uuid::new_v4(),
        role: types::Role::User,
        content: content.to_string(),
        tool_name: None,
        tool_args: None,
        is_error: false,
        timestamp: chrono::Utc::now(),
        response_duration: None,
        mode: "Build".into(),
        interrupted: false,
        reasoning: None,
        subagent_id: None,
        subagent_type: None,
        diff_stats: None,
        attachments: Vec::new(),
    }
}

#[test]
fn ctrl_n_starts_a_fresh_session_in_place() {
    let mut app = test_app();
    let old_id = app.state.session.session_id;
    app.state
        .session
        .chat_history
        .push(chat_entry("hello from session one"));
    app.state.input.input_text = "draft one".to_string();
    app.state.input.input_cursor = 9;

    app.handle_key(key(KeyCode::Char('n'), KeyModifiers::CONTROL))
        .unwrap();

    // Fresh identity, empty conversation, cleared composer.
    assert_ne!(app.state.session.session_id, old_id);
    assert!(app.state.session.chat_history.is_empty());
    assert!(app.state.input.input_text.is_empty());
    // The hero steps aside: the empty chat owns the screen, keys go to
    // the composer.
    assert!(!app.state.ui.show_welcome_screen);
    // The toast confirms — no system message pollutes the new transcript.
    assert!(app.state.ui.toast.is_some());
}

#[test]
fn hero_new_session_dismisses_the_hero_and_focuses_the_composer() {
    let mut app = test_app();
    app.state.ui.show_welcome_screen = true;
    app.state.ui.welcome_selected = 0; // "New session"
    app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
        .unwrap();
    assert!(!app.state.ui.show_welcome_screen, "hero is gone");
    // Keys now type into the composer instead of driving the menu.
    app.handle_key(key(KeyCode::Char('h'), KeyModifiers::NONE))
        .unwrap();
    app.handle_key(key(KeyCode::Down, KeyModifiers::NONE))
        .unwrap();
    assert_eq!(app.state.input.input_text, "h");
    assert_eq!(app.state.ui.welcome_selected, 0);
}

#[test]
fn alt_digits_type_instead_of_switching_sessions() {
    let mut app = test_app();
    let old_id = app.state.session.session_id;
    // Alt is a text modifier (Alt+Q yields `@` on Latin layouts), so the
    // freed tab bindings fall through to the composer as plain text.
    for digit in ['1', '2', '9'] {
        app.handle_key(key(KeyCode::Char(digit), KeyModifiers::ALT))
            .unwrap();
    }
    assert_eq!(app.state.session.session_id, old_id);
    assert_eq!(app.state.input.input_text, "129");

    // Plain typing still inserts text (catch-all unaffected).
    app.handle_key(key(KeyCode::Char('x'), KeyModifiers::NONE))
        .unwrap();
    assert_eq!(app.state.input.input_text, "129x");
}

#[test]
fn alt_w_types_instead_of_closing() {
    let mut app = test_app();
    let old_id = app.state.session.session_id;
    app.handle_key(key(KeyCode::Char('w'), KeyModifiers::ALT))
        .unwrap();
    assert_eq!(app.state.session.session_id, old_id);
    assert_eq!(app.state.input.input_text, "w");
}

#[test]
fn ctrl_tab_toggles_mode() {
    let mut app = test_app();
    let before = app.state.agent.work_mode();
    app.handle_key(key(KeyCode::Tab, KeyModifiers::CONTROL))
        .unwrap();
    assert_ne!(
        app.state.agent.work_mode(),
        before,
        "Ctrl+Tab must toggle plan/build mode"
    );
    // Plan → build → auto: the third press returns to the start.
    for _ in 0..2 {
        app.handle_key(key(KeyCode::Tab, KeyModifiers::CONTROL))
            .unwrap();
    }
    assert_eq!(app.state.agent.work_mode(), before);
}

#[test]
fn settings_toggles_smart_compaction_which_defaults_off() {
    let mut app = test_app();
    assert!(!app.state.config.config.smart_compaction, "off by default");
    app.execute_command(crate::command_palette::Command::Settings)
        .unwrap();
    app.state.input.settings_selected = 0; // Smart compaction
    app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
        .unwrap();
    assert!(app.state.config.config.smart_compaction);
    app.handle_key(key(KeyCode::Esc, KeyModifiers::NONE))
        .unwrap();
    assert!(!app.state.input.show_settings);
}

#[test]
fn exit_hint_names_the_session_to_resume() {
    let mut app = test_app();
    assert_eq!(
        app.resume_hint(),
        None,
        "nothing to resume in an empty session"
    );
    app.state.add_user_message("Fix the retry loop".into());
    let hint = app.resume_hint().expect("hint");
    let id = app.state.session.session_id.to_string();
    assert!(hint.contains(&format!("agente --resume {id}")), "{hint}");
    assert!(hint.contains("Fix the retry loop"), "labelled: {hint}");
}

#[test]
fn fork_from_a_sent_message_starts_a_branch_session() {
    let mut app = test_app();
    let user = |content: &str| types::Message {
        role: types::Role::User,
        content: content.into(),
        tool_calls: None,
        tool_call_id: None,
        thinking: None,
        thinking_signature: None,
        continuation: None,
        attachments: Vec::new(),
    };
    app.state.add_user_message("first".into());
    app.state.session.conversation.push(user("first"));
    app.state.add_user_message("second".into());
    app.state.session.conversation.push(user("second"));
    let old_session = app.state.session.session_id;
    let second = app.state.session.chat_history[1].id;

    app.state.ui.message_actions = Some(second);
    app.handle_key(key(KeyCode::Char('f'), KeyModifiers::NONE))
        .unwrap();

    assert_ne!(app.state.session.session_id, old_session, "new session");
    assert!(app.state.ui.message_actions.is_none(), "dialog closed");
    assert_eq!(
        app.state.session.chat_history.len(),
        1,
        "chat up to the message"
    );
    assert_eq!(app.state.session.conversation.len(), 1);
    assert_eq!(
        app.state.input.input_text, "second",
        "message back in the input"
    );
}

#[test]
fn subagent_calls_count_for_the_child_and_the_session() {
    use agente_core::agent::AgentEvent;
    let mut app = test_app();
    app.inject_agent_event(AgentEvent::SubagentStarted {
        id: "child".into(),
        subagent_type: "explore".into(),
        description: "look around".into(),
        model: "test-model".into(),
        seat: None,
    });
    let call = |cost, subagent_id: Option<&str>| AgentEvent::CallUsage {
        prompt_tokens: 100,
        completion_tokens: 10,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: Some(cost),
        cost_estimated: false,
        subagent_id: subagent_id.map(str::to_string),
    };
    app.inject_agent_event(call(0.004, Some("child")));
    app.inject_agent_event(call(0.010, None));
    app.process_agent_events();
    let child = &app.state.agent.subagents["child"].spend;
    assert_eq!(child.cost_label().as_deref(), Some("$0.004"));
    assert_eq!(
        app.state.agent.spend.cost_label().as_deref(),
        Some("$0.014")
    );
}

#[test]
fn compaction_shows_progress_then_a_transcript_divider() {
    use agente_core::agent::AgentEvent;
    let mut app = test_app();
    app.state.agent.state = types::AgentState::StreamingResponse;
    app.inject_agent_event(AgentEvent::CompactionStarted {
        smart: true,
        model: Some("test-model".into()),
    });
    app.process_agent_events();
    assert_eq!(app.state.agent.compacting, Some(true));
    // A heartbeat during a slow summary keeps the indicator up.
    app.inject_agent_event(AgentEvent::ToolHeartbeat { id: String::new() });
    app.process_agent_events();
    assert_eq!(app.state.agent.compacting, Some(true));

    app.inject_agent_event(AgentEvent::ContextCompacted {
        summary: "checkpoint".into(),
        tokens_before: 182_000,
        tokens_after: 64_000,
        smart: true,
        compacted_conversation: Vec::new(),
    });
    app.process_agent_events();
    assert_eq!(app.state.agent.compacting, None);
    let last = app.state.session.chat_history.last().unwrap();
    assert_eq!(
        last.content,
        "⟲ Context compacted · ~182k → ~64k · summarized"
    );
}

#[test]
fn auto_mode_is_build_with_every_call_approved() {
    let mut app = test_app();
    app.state
        .agent
        .select_work_mode(crate::state::WorkMode::Plan, true);
    let cycle: Vec<_> = (0..3)
        .map(|_| {
            app.handle_key(key(KeyCode::Tab, KeyModifiers::CONTROL))
                .unwrap();
            app.state.agent.work_mode()
        })
        .collect();
    use crate::state::WorkMode::*;
    assert_eq!(cycle, [Build, Auto, Plan]);

    app.state.agent.select_work_mode(Auto, true);
    assert_eq!(app.state.agent.mode, types::AgentMode::Build);
    assert!(app.state.agent.auto_approve_all(), "auto approves");
    assert_eq!(app.state.config.config.default_mode, Some("plan".into()));
    app.handle_key(key(KeyCode::Tab, KeyModifiers::CONTROL))
        .unwrap();
    assert_eq!(app.state.agent.work_mode(), Plan);
    assert!(
        !app.state.agent.auto_approve_all(),
        "leaving auto stops approving"
    );
    assert_eq!(app.state.config.config.default_mode, Some("plan".into()));
}

#[test]
fn ctrl_tab_terminal_spellings_all_toggle_mode() {
    for (code, modifiers) in [
        (KeyCode::Tab, KeyModifiers::CONTROL | KeyModifiers::SHIFT),
        (KeyCode::BackTab, KeyModifiers::CONTROL),
        (
            KeyCode::BackTab,
            KeyModifiers::CONTROL | KeyModifiers::SHIFT,
        ),
    ] {
        let mut app = test_app();
        let before = app.state.agent.work_mode();
        app.handle_key(key(code, modifiers)).unwrap();
        assert_ne!(app.state.agent.work_mode(), before);
    }
}

#[test]
fn ctrl_tab_bypasses_welcome_button_navigation() {
    let mut single = test_app();
    single.state.ui.show_welcome_screen = true;
    single.state.ui.welcome_selected = 1;
    let mode = single.state.agent.work_mode();

    single
        .handle_key(key(KeyCode::Tab, KeyModifiers::CONTROL))
        .unwrap();

    assert_eq!(single.state.ui.welcome_selected, 1);
    assert_ne!(single.state.agent.work_mode(), mode);
}

#[test]
fn ctrl_tab_selects_next_mode_while_agent_runs() {
    let mut app = test_app();
    let before = app.state.agent.work_mode();
    app.state.agent.current_turn_mode = before.agent_mode();
    let permission_mode = app
        .state
        .agent
        .shared_permission_engine
        .read()
        .unwrap()
        .mode;
    app.state.agent.state = types::AgentState::Executing;
    app.handle_key(key(KeyCode::Tab, KeyModifiers::CONTROL))
        .unwrap();
    assert_ne!(
        app.state.agent.work_mode(),
        before,
        "next-turn mode changed"
    );
    assert_eq!(
        app.state.agent.current_turn_mode,
        before.agent_mode(),
        "the running turn keeps its original mode"
    );
    assert_eq!(
        app.state
            .agent
            .shared_permission_engine
            .read()
            .unwrap()
            .mode,
        permission_mode,
        "the running turn keeps its original permissions"
    );
    assert!(app
        .state
        .session
        .chat_history
        .iter()
        .any(|e| e.content.contains("Next turn")));
}

#[test]
fn ctrl_n_is_refused_while_agent_runs() {
    let mut app = test_app();
    app.state
        .session
        .chat_history
        .push(chat_entry("in-progress work"));
    let before = app.state.session.session_id;
    app.state.agent.state = types::AgentState::Executing;

    app.handle_key(key(KeyCode::Char('n'), KeyModifiers::CONTROL))
        .unwrap();

    assert_eq!(app.state.session.session_id, before);
    assert!(app
        .state
        .session
        .chat_history
        .iter()
        .any(|entry| entry.content.contains("Stop the agent")));
}

/// `r` is text, not a shortcut.
///
/// It was bound bare to "refresh models" ahead of the text arm, so no
/// model whose name contains an r -- turbo, nemotron, mistral,
/// claude -- could be searched for at all.
#[test]
fn model_selector_typing_r_searches_instead_of_refreshing() {
    let mut app = test_app();
    app.state
        .config
        .connected_providers
        .push("openrouter".into());
    app.state.config.current_provider = "openrouter".into();
    app.state.input.show_model_selector = true;

    for ch in "turbo".chars() {
        app.handle_key(key(KeyCode::Char(ch), KeyModifiers::NONE))
            .unwrap();
    }

    assert_eq!(app.state.input.model_selector_query, "turbo");
    assert!(
        app.state.config.discovery_status.is_empty(),
        "typing must not kick off a model fetch"
    );
}

/// Refresh moved to Ctrl+R (and F5), which cannot collide with typing.
#[test]
fn model_selector_ctrl_r_refreshes_the_browsed_provider() {
    let mut app = test_app();
    app.state
        .config
        .connected_providers
        .push("openrouter".into());
    app.state.config.current_provider = "openrouter".into();
    app.state.input.show_model_selector = true;

    // Discovery spawns onto the ambient tokio runtime; enter one for the
    // duration of the key handling.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _guard = rt.enter();
    app.handle_key(key(KeyCode::Char('r'), KeyModifiers::CONTROL))
        .unwrap();

    assert!(matches!(
        app.state.config.discovery_status.get("openrouter"),
        Some(crate::state::DiscoveryStatus::InProgress)
    ));
}

#[test]
fn resize_wakes_idle_ui_without_changing_draft_or_scroll_mode() {
    let mut app = test_app();
    app.state.ui.needs_render = false;
    app.state.ui.chat_auto_scroll = false;
    app.state.input.input_text = "unfinished draft".into();
    app.state.input.show_model_selector = true;
    app.handle_terminal_event(Event::Resize(60, 18)).unwrap();
    assert!(app.state.ui.needs_render);
    assert!(!app.state.ui.chat_auto_scroll);
    assert_eq!(app.state.input.input_text, "unfinished draft");
    assert!(app.state.input.show_model_selector);
}

#[test]
fn refresh_all_providers_preserves_search_without_ambient_runtime() {
    let mut app = test_app();
    app.state.config.connected_providers = vec!["openrouter".into(), "openai".into()];
    app.state.input.show_model_selector = true;
    app.state.input.model_selector_provider = None;
    app.state.input.model_selector_query = "coding".into();
    app.handle_key(key(KeyCode::F(5), KeyModifiers::NONE))
        .unwrap();
    for provider in ["openrouter", "openai"] {
        assert_eq!(
            app.state.config.discovery_status.get(provider),
            Some(&crate::state::DiscoveryStatus::InProgress)
        );
    }
    assert_eq!(app.state.input.model_selector_query, "coding");
}

/// The provider scope and the search query are separate state: cycling one
/// must not clear the other. They shared a single string before, so typing
/// erased the provider and pressing an arrow erased the search.
#[test]
fn model_selector_provider_cycle_preserves_the_query() {
    let mut app = test_app();
    app.state.config.connected_providers = vec!["openrouter".into(), "openai".into()];
    app.state.config.current_provider = "openrouter".into();
    app.state.input.show_model_selector = true;

    for ch in "turbo".chars() {
        app.handle_key(key(KeyCode::Char(ch), KeyModifiers::NONE))
            .unwrap();
    }
    assert_eq!(app.state.input.model_selector_query, "turbo");
    assert_eq!(app.state.input.model_selector_provider, None);

    // Slot order is All -> openrouter -> openai -> All.
    app.handle_key(key(KeyCode::Tab, KeyModifiers::NONE))
        .unwrap();
    assert_eq!(
        app.state.input.model_selector_provider.as_deref(),
        Some("openrouter")
    );
    assert_eq!(
        app.state.input.model_selector_query, "turbo",
        "cycling the provider must not touch the query"
    );

    app.handle_key(key(KeyCode::Tab, KeyModifiers::NONE))
        .unwrap();
    assert_eq!(
        app.state.input.model_selector_provider.as_deref(),
        Some("openai")
    );
    app.handle_key(key(KeyCode::Tab, KeyModifiers::NONE))
        .unwrap();
    assert_eq!(
        app.state.input.model_selector_provider, None,
        "the cycle returns to searching every provider"
    );
    assert_eq!(app.state.input.model_selector_query, "turbo");
}

#[test]
fn provider_key_paste_strips_clipboard_whitespace_and_clears_error() {
    let mut app = test_app();
    app.state
        .config
        .open_enter_key("openai", String::new(), false, "old error".into());

    app.insert_owned_paste("  sk-test-key-123  \r\n");

    assert_eq!(app.state.config.connect_key_input, "sk-test-key-123");
    assert!(matches!(
        &app.state.config.connect_screen,
        crate::state::ConnectScreen::EnterKey { error, .. } if error.is_empty()
    ));
}

#[test]
fn provider_search_keeps_text_input_available_for_all_letters() {
    let mut app = test_app();
    app.state.open_connect_screen();

    for ch in "mistral".chars() {
        app.handle_key(key(KeyCode::Char(ch), KeyModifiers::NONE))
            .unwrap();
    }

    assert!(matches!(
        &app.state.config.connect_screen,
        crate::state::ConnectScreen::SelectProvider { query, selected }
            if query == "mistral" && *selected == 0
    ));
}

/// Ctrl+T opens the same model-aware picker as /thinking without writing
/// a diagnostic into the transcript or touching disk.
#[test]
fn ctrl_t_opens_thinking_picker_without_transcript_noise() {
    let mut app = test_app();
    app.handle_key(key(KeyCode::Char('t'), KeyModifiers::CONTROL))
        .unwrap();
    assert!(app.state.input.show_thinking_selector);
    assert!(app.state.session.chat_history.is_empty());
}

#[test]
fn thinking_picker_enter_applies_level_and_only_sets_a_toast() {
    let mut app = test_app();
    app.state.input.open_thinking_selector(
        &["off".to_string(), "high".to_string(), "xhigh".to_string()],
        "off",
    );
    app.state.input.thinking_selector_selected = 2;
    app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
        .unwrap();

    assert_eq!(app.state.agent.thinking_level, "xhigh");
    assert!(!app.state.input.show_thinking_selector);
    assert!(app.state.session.chat_history.is_empty());
    assert!(app.state.ui.toast.is_some());
}

/// Opening parks the cursor on whichever level is currently active, so
/// Enter without moving is a no-op rather than a surprise change.
#[test]
fn thinking_selector_opens_on_the_active_level() {
    let mut app = test_app();
    let levels = vec!["off".to_string(), "high".to_string(), "max".to_string()];

    app.state.input.open_thinking_selector(&levels, "max");
    assert_eq!(app.state.input.thinking_selector_selected, 2);

    app.state.input.open_thinking_selector(&levels, "high");
    assert_eq!(app.state.input.thinking_selector_selected, 1);

    // An unknown level falls back to the first row instead of panicking.
    app.state.input.open_thinking_selector(&levels, "bogus");
    assert_eq!(app.state.input.thinking_selector_selected, 0);
}

/// The picker owns the modal slot, so it inherits the opaque backdrop and
/// suppresses the chat scrollbar like every other floating card.
#[test]
fn thinking_selector_is_a_floating_modal() {
    let mut app = test_app();
    app.state.input.show_thinking_selector = true;
    let owner = crate::state::modal_owner(&app.state);
    assert_eq!(owner, crate::state::ModalOwner::ThinkingSelector);
    assert!(owner.floats_over_chat(), "must get the backdrop");
    assert!(owner.is_modal(), "must suppress the chat scrollbar");
}

#[test]
fn palette_receives_every_typed_character() {
    let mut app = test_app();
    // Open via the real binding.
    app.handle_key(key(KeyCode::Char('p'), KeyModifiers::CONTROL))
        .unwrap();
    assert!(app.state.input.show_command_palette);

    let alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 -_";
    for ch in alphabet.chars() {
        app.handle_key(key(KeyCode::Char(ch), KeyModifiers::NONE))
            .unwrap();
    }
    let query = app.state.input.command_palette_query.clone();
    for ch in alphabet.chars() {
        assert!(
            query.contains(ch),
            "character {ch:?} missing from palette query (query: {query:?})"
        );
    }

    // Shifted letters must also land.
    app.handle_key(key(KeyCode::Char('z'), KeyModifiers::SHIFT))
        .unwrap();
    let ends_ok = app.state.input.command_palette_query.ends_with('z')
        || app.state.input.command_palette_query.ends_with('Z');
    assert!(ends_ok, "shifted letter not registered");
}

#[test]
fn palette_accepts_altgr_and_ignores_ctrl_shortcuts() {
    let mut app = test_app();
    app.handle_key(key(KeyCode::Char('p'), KeyModifiers::CONTROL))
        .unwrap();

    // AltGr (CONTROL|ALT on international layouts) is text input: the
    // restrictive NONE|SHIFT pattern used to drop it.
    app.handle_key(key(
        KeyCode::Char('['),
        KeyModifiers::CONTROL | KeyModifiers::ALT,
    ))
    .unwrap();
    assert_eq!(app.state.input.command_palette_query, "[");

    // Plain Ctrl chords stay shortcuts, never text.
    app.handle_key(key(KeyCode::Char('x'), KeyModifiers::CONTROL))
        .unwrap();
    assert_eq!(app.state.input.command_palette_query, "[");
}

#[test]
fn ctrl_w_handles_multibyte_unicode_whitespace_without_panicking() {
    let mut app = test_app();
    app.state.ui.show_welcome_screen = false;

    // NBSP (\u{00A0}, 2 bytes)
    app.state.input.input_text = "hello\u{00A0}world".into();
    app.state.input.input_cursor = app.state.input.input_text.chars().count();
    app.handle_key(key(KeyCode::Char('w'), KeyModifiers::CONTROL))
        .unwrap();
    assert_eq!(app.state.input.input_text, "hello\u{00A0}");
    assert_eq!(app.state.input.input_cursor, 6);

    // Ideographic space (\u{3000}, 3 bytes)
    app.state.input.input_text = "alpha\u{3000}beta".into();
    app.state.input.input_cursor = app.state.input.input_text.chars().count();
    app.handle_key(key(KeyCode::Char('w'), KeyModifiers::CONTROL))
        .unwrap();
    assert_eq!(app.state.input.input_text, "alpha\u{3000}");
    assert_eq!(app.state.input.input_cursor, 6);
}

#[test]
fn up_on_empty_composer_restores_queued_attachments() {
    use agente_core::media::{Attachment, AttachmentKind};

    let mut app = test_app();
    app.state.ui.show_welcome_screen = false;
    let att = Attachment {
        kind: AttachmentKind::Image,
        name: "diagram.png".into(),
        mime: "image/png".into(),
        path: "/tmp/diagram.png".into(),
        bytes: 256,
    };
    app.state.agent.queue_message(
        crate::state::QueuedMessage::new("inspect this").with_attachments(vec![att.clone()]),
    );

    app.handle_key(key(KeyCode::Up, KeyModifiers::NONE))
        .unwrap();
    assert_eq!(app.state.input.input_text, "inspect this");
    assert_eq!(app.state.input.attachments, vec![att]);
    assert!(app.state.agent.message_queue.is_empty());
}

#[test]
fn subagent_models_edit_accepts_paste_and_altgr_and_clears_provider_filter() {
    use crate::subagent_models::{Edit, EditField};
    use agente_core::config::SubagentModelEntry;

    let mut app = test_app();
    app.state.config.connected_providers = vec!["openai".into(), "anthropic".into()];
    app.state
        .config
        .config
        .subagents
        .models
        .push(SubagentModelEntry {
            name: "scout".into(),
            provider: "openai".into(),
            model: "gpt-4o".into(),
            thinking: None,
            use_for: String::new(),
        });
    app.state.input.show_subagent_models = true;
    app.state.input.subagent_model_edit = Some(Edit {
        index: 0,
        field: EditField::Note,
        text: String::new(),
    });

    app.insert_owned_paste("fast code\nsearch");
    app.handle_key(key(
        KeyCode::Char('@'),
        KeyModifiers::CONTROL | KeyModifiers::ALT,
    ))
    .unwrap();
    let edit = app.state.input.subagent_model_edit.as_ref().unwrap();
    assert_eq!(edit.text, "fast code search@");

    // Commit edit, then open the model picker from SubagentModels: any
    // stale provider scope must be cleared.
    app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
        .unwrap();
    app.state.input.model_selector_provider = Some("anthropic".into());
    app.handle_key(key(KeyCode::Enter, KeyModifiers::NONE))
        .unwrap();
    assert!(app.state.input.show_model_selector);
    assert_eq!(app.state.input.model_selector_provider, None);
}

#[test]
fn plan_ask_free_text_accepts_altgr() {
    use crate::state::{AskQuestion, PlanAskState, PlanReviewPhase};

    let mut app = test_app();
    app.state.plan_review.phase = PlanReviewPhase::Asking;
    app.state.plan_review.ask = Some(PlanAskState {
        original_comment: "fix".into(),
        questions: vec![AskQuestion {
            prompt: "What?".into(),
            options: vec![],
            selected: None,
            free_text: String::new(),
        }],
        question_index: 0,
        reask_count: 0,
    });

    app.handle_key(key(
        KeyCode::Char('@'),
        KeyModifiers::CONTROL | KeyModifiers::ALT,
    ))
    .unwrap();
    assert_eq!(
        app.state.plan_review.ask.as_ref().unwrap().questions[0].free_text,
        "@"
    );
}

#[test]
fn session_picker_matches_title_and_deletes_from_shared_snapshot() {
    let mut app = test_app();
    let mut s1 = agente_core::session::create_session_meta("/tmp/proj-a");
    s1.title = "Refactor Auth Flow".into();
    let mut s2 = agente_core::session::create_session_meta("/tmp/proj-a");
    s2.title = "Database Migration".into();
    app.state.picker.show_session_picker = true;
    app.state.picker.session_picker_folder_input = "/tmp/proj-a".into();
    app.state.picker.sessions = vec![s1.clone(), s2.clone()];

    // Filter by title ("migration") — matches s2 only.
    for ch in "migration".chars() {
        app.handle_key(key(KeyCode::Char(ch), KeyModifiers::NONE))
            .unwrap();
    }
    // Move down to row 1 (s2) and delete twice (confirm).
    app.handle_key(key(KeyCode::Down, KeyModifiers::NONE))
        .unwrap();
    assert_eq!(app.state.picker.session_picker_selected, 1);
    app.handle_key(key(KeyCode::Delete, KeyModifiers::NONE))
        .unwrap();
    assert_eq!(
        app.state.picker.session_picker_confirm_delete,
        Some(s2.session_id)
    );
    app.handle_key(key(KeyCode::Delete, KeyModifiers::NONE))
        .unwrap();
    assert_eq!(app.state.picker.sessions.len(), 1);
    assert_eq!(app.state.picker.sessions[0].session_id, s1.session_id);
}

#[test]
fn a_moved_selection_rearms_delete_instead_of_deleting_another_session() {
    let mut app = test_app();
    let mut s1 = agente_core::session::create_session_meta("/tmp/proj-a");
    s1.title = "First".into();
    let mut s2 = agente_core::session::create_session_meta("/tmp/proj-a");
    s2.title = "Second".into();
    app.state.picker.show_session_picker = true;
    app.state.picker.session_picker_folder_input = "/tmp/proj-a".into();
    app.state.picker.sessions = vec![s1.clone(), s2.clone()];

    app.state.picker.session_picker_selected = 1;
    app.handle_key(key(KeyCode::Delete, KeyModifiers::NONE))
        .unwrap();
    // The pointer moves to the other row (hover-to-select) before the
    // second press.
    app.state.picker.session_picker_selected = 2;
    app.handle_key(key(KeyCode::Delete, KeyModifiers::NONE))
        .unwrap();
    assert_eq!(app.state.picker.sessions.len(), 2, "nothing deleted");
    assert_eq!(
        app.state.picker.session_picker_confirm_delete,
        Some(s2.session_id)
    );
}
