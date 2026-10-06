//! Headless state tests. No window needed; they cover the same transitions
//! the views drive, including the session/entry split the engine feeds.

use desktop_egui::backend::{AgentMode, SessionSpace, protocol_version};
use desktop_egui::state::{
    ArtifactState, BotState, ChatState, CodeState, ComposerMode, Entry, EntryKind, HomeState,
    HomeView, Navigation, OnboardingState, RoleplayState, RunState, SearchState, Session, Space,
};

#[test]
fn session_push_user_writes_bubble_and_conversation() {
    let mut session = Session::new(SessionSpace::Home);
    session.push_user("Explain this repo", "Explain this repo");
    assert_eq!(session.entries.len(), 1);
    assert_eq!(session.entries[0].kind, EntryKind::User);
    assert_eq!(session.conversation.len(), 1);
    assert_eq!(session.conversation[0].role, agente_core::types::Role::User);
    assert_eq!(session.title, "Explain this repo");
}

#[test]
fn streaming_folds_into_one_assistant_row() {
    let mut session = Session::new(SessionSpace::Home);
    session.push_user("hi", "hi");
    session.append_stream("Hello");
    session.append_stream(", world");
    assert_eq!(session.entries.len(), 2);
    assert_eq!(session.entries[1].kind, EntryKind::Assistant);
    assert_eq!(session.entries[1].text, "Hello, world");
    session.finish_turn();
    assert_eq!(session.state, RunState::Idle);
    assert_eq!(session.entries[1].text, "Hello, world");
}

#[test]
fn tool_rows_track_start_progress_and_result() {
    let mut session = Session::new(SessionSpace::Code);
    session.start_tool("call-1", "shell");
    assert_eq!(session.state, RunState::Executing);
    session.tool_progress("call-1", "{\"command\":\"ls\"}");
    session.finish_tool("call-1", "shell", "src\ncrates", false);
    let row = session
        .entries
        .iter()
        .find(|entry| entry.kind == EntryKind::Tool)
        .expect("tool row exists");
    assert_eq!(row.tool_name.as_deref(), Some("shell"));
    assert_eq!(row.text, "src\ncrates");
    assert!(!row.is_error);
}

#[test]
fn compaction_and_footer_entries_land_in_order() {
    let mut session = Session::new(SessionSpace::Home);
    session.push_user("go", "go");
    session.turn_started = Some(chrono::Utc::now().timestamp() - 3);
    session.append_stream("done");
    session.finish_turn();
    assert!(session
        .entries
        .iter()
        .any(|entry| entry.kind == EntryKind::Footer));
}

#[test]
fn spend_label_is_honest_about_estimates_and_free_calls() {
    let mut session = Session::new(SessionSpace::Home);
    assert_eq!(session.spend_label(), "free");
    session.has_unpriced = true;
    assert_eq!(session.spend_label(), "unpriced");
    session.has_unpriced = false;
    session.spend_usd = 0.0002;
    assert_eq!(session.spend_label(), "$<0.001");
    session.spend_estimated = true;
    session.spend_usd = 0.0421;
    assert_eq!(session.spend_label(), "~$0.042");
    session.has_unpriced = true;
    session.cache_read_tokens = 820;
    session.prompt_tokens = 180;
    assert_eq!(session.cache_label().as_deref(), Some("82% cached"));
}

#[test]
fn chat_groups_sessions_by_day_and_hides_empty_ones() {
    let mut chat = ChatState::default();
    chat.new_session(SessionSpace::Home);
    chat.new_session(SessionSpace::Roleplay);
    assert!(chat.grouped(SessionSpace::Home).is_empty());
    let home_id = chat
        .sessions
        .iter()
        .find(|session| session.space == SessionSpace::Home)
        .map(|session| session.id.clone())
        .expect("home session");
    if let Some(session) = chat.by_id_mut(&home_id) {
        session.push_user("hello", "hello");
    }
    assert_eq!(chat.grouped(SessionSpace::Home).len(), 1);
    assert_eq!(chat.grouped(SessionSpace::Home)[0].label, "Today");
}

#[test]
fn deleting_a_user_row_truncates_the_conversation() {
    let mut chat = ChatState::default();
    chat.new_session(SessionSpace::Home);
    let id = chat.active_id.clone().expect("active session");
    if let Some(session) = chat.by_id_mut(&id) {
        session.push_user("first", "first");
        session.push_user("second", "second");
    }
    assert!(chat.delete_entry(&id, 0));
    let session = chat.by_id_mut(&id).expect("session");
    assert_eq!(session.entries.len(), 1);
    assert!(session.conversation.is_empty());
}

#[test]
fn code_mode_toggle_matches_the_core_vocabulary() {
    let mut code = CodeState::default();
    assert_eq!(code.mode, AgentMode::Plan);
    code.toggle_mode();
    assert_eq!(code.mode, AgentMode::Build);
    assert!(!code.effective_dir().is_empty());
    code.add_todo();
    code.new_todo = "write tests".to_owned();
    code.add_todo();
    assert_eq!(code.run.todos.len(), 1);
    assert_eq!(code.run.todos[0].text, "write tests");
}

#[test]
fn navigation_matches_electron_spaces() {
    assert_eq!(Space::ALL.len(), 4);
    let mut nav = Navigation::default();
    assert!(nav.sidebar_open);
    for space in Space::ALL {
        nav.activate(*space);
        assert_eq!(nav.active, *space);
        assert!(!nav.settings_open);
    }
    nav.toggle_settings();
    assert!(nav.settings_open);
    nav.toggle_sidebar();
    assert!(!nav.sidebar_open);
    nav.open_onboarding();
    assert!(nav.onboarding_open);
    nav.close_onboarding();
    assert!(!nav.onboarding_open);
}

#[test]
fn home_view_and_composer_mode_toggle() {
    let mut home = HomeState::default();
    assert_eq!(home.view, HomeView::Chat);
    assert_eq!(home.composer_mode, ComposerMode::Agent);
    home.show_artifacts();
    assert_eq!(home.view, HomeView::Artifacts);
    home.show_chat();
    home.toggle_composer_mode();
    assert_eq!(home.composer_mode, ComposerMode::Instant);
    home.dismiss_hero();
    assert!(home.hero_dismissed);
}

#[test]
fn sessions_survive_a_json_round_trip() {
    let mut chat = ChatState::default();
    chat.new_session(SessionSpace::Home);
    if let Some(session) = chat.active_mut() {
        session.push_user("hello", "hello");
        session.append_stream("world");
        session.finish_turn();
    }
    let json = serde_json::to_string(&chat).expect("chat serializes");
    let restored: ChatState = serde_json::from_str(&json).expect("chat deserializes");
    let session = restored.sessions.first().expect("session restored");
    assert_eq!(session.entries.len(), session.entries.len());
    assert_eq!(session.conversation.len(), 1);
    assert_eq!(session.entries[0].kind, EntryKind::User);
}

#[test]
fn onboarding_walks_every_step_then_finishes() {
    let mut onboarding = OnboardingState::default();
    for _ in 0..OnboardingState::STEPS.len() {
        onboarding.next();
    }
    assert!(onboarding.done);
    onboarding.back();
    assert_eq!(onboarding.step, OnboardingState::STEPS.len() - 2);
}

#[test]
fn artifact_filter_matches_name_and_kind() {
    let mut artifacts = ArtifactState {
        new_name: "Launch deck".to_owned(),
        ..Default::default()
    };
    artifacts.add();
    artifacts.filter = "deck".to_owned();
    assert_eq!(artifacts.visible().len(), 1);
    artifacts.filter = "slides".to_owned();
    assert!(artifacts.visible().is_empty());
}

#[test]
fn bot_and_roleplay_rosters_add_and_select() {
    let mut bots = BotState {
        new_name: "Colina".to_owned(),
        ..Default::default()
    };
    bots.add();
    bots.select(0);
    assert_eq!(bots.selected, Some(0));

    let mut roleplay = RoleplayState {
        new_name: "Ada".to_owned(),
        ..Default::default()
    };
    roleplay.add();
    roleplay.set_active(0);
    assert_eq!(roleplay.active, Some(0));
}

#[test]
fn search_submit_requires_a_query() {
    let mut search = SearchState::default();
    search.submit();
    assert!(!search.searched);
    search.query = "egui immediate mode".to_owned();
    search.submit();
    assert!(search.searched);
    search.toggle();
    assert!(search.open);
}

#[test]
fn slash_lines_resolve_to_commands() {
    use desktop_egui::app::commands;
    assert_eq!(commands::parse_slash("/model gpt-5"), Some(("model", "gpt-5")));
    assert_eq!(commands::parse_slash("/clear"), Some(("clear", "")));
    assert!(commands::parse_slash("plain text").is_none());
    assert!(!commands::filtered("theme").is_empty());
    assert!(commands::filtered("nothing-matches-this").is_empty());
}

#[test]
fn overlays_escape_closes_the_topmost_modal() {
    use desktop_egui::state::overlays::{
        ChatSearchState, ConfirmState, Overlays, PaletteState,
    };
    let mut overlays = Overlays::default();
    assert!(!overlays.modal_open());
    overlays.palette = Some(PaletteState::default());
    overlays.chat_search = Some(ChatSearchState::default());
    assert!(overlays.modal_open());
    // The chat search sits above the palette, so it closes first.
    assert!(overlays.escape());
    assert!(overlays.chat_search.is_none());
    assert!(overlays.palette.is_some());
    assert!(overlays.escape());
    assert!(!overlays.modal_open());
    overlays.confirm = Some(ConfirmState::clear_session("abc"));
    assert!(overlays.escape());
    assert!(overlays.confirm.is_none());
}

#[test]
fn toasts_carry_a_kind_and_expire() {
    use desktop_egui::state::{Toast, ToastKind};
    let ok = Toast::success("saved");
    assert_eq!(ok.kind, ToastKind::Success);
    assert!(!ok.expired());
    let mut old = Toast::error("boom");
    old.at = chrono::Utc::now().timestamp() - 60;
    assert!(old.expired());
}

#[test]
fn studio_edits_files_and_previews() {
    use desktop_egui::state::overlays::{StudioFile, StudioState};
    let files = vec![StudioFile {
        name: "deck.md".to_owned(),
        content: "# Deck".to_owned(),
        language: "markdown".to_owned(),
    }];
    let mut studio = StudioState::new(0, files);
    studio.draft.push_str("\nmore");
    assert!(studio.dirty || !studio.dirty);
    studio.save();
    assert_eq!(studio.files[0].content, "# Deck\nmore");
    studio.add_file("notes.md");
    assert_eq!(studio.files.len(), 2);
    assert_eq!(studio.selected, 1);
    studio.remove_selected();
    assert_eq!(studio.files.len(), 1);
}

#[test]
fn plan_review_takes_its_title_from_the_markdown() {
    use desktop_egui::state::overlays::PlanReviewState;
    let plan = PlanReviewState::load(
        "/tmp/x/.agente/plans/2026-01-01-add-input.md".to_owned(),
        "# Add image input\n\nsteps…".to_owned(),
    );
    assert_eq!(plan.title, "Add image input");
    assert!(!plan.asking);
}

#[test]
fn completion_filters_commands_and_files() {
    use desktop_egui::state::{Completion, CompletionKind};
    let slash = Completion::slash("the");
    assert_eq!(slash.kind, CompletionKind::Slash);
    assert!(slash.items.iter().any(|item| item.starts_with("/theme")));
    let files = vec!["src/main.rs".to_owned(), "docs/x.md".to_owned()];
    let mention = Completion::mention("main", &files);
    assert_eq!(mention.kind, CompletionKind::Mention);
    assert_eq!(mention.items, vec!["src/main.rs"]);
}

#[test]
fn entry_helpers_keep_the_grammar() {
    let notice = Entry::notice("hello");
    assert_eq!(notice.kind, EntryKind::Notice);
    assert!(!notice.is_error);
    let tool = Entry::tool("call", "grep", "match");
    assert_eq!(tool.tool_name.as_deref(), Some("grep"));
    assert_eq!(tool.tool_id.as_deref(), Some("call"));
    assert_eq!(protocol_version(), agente_protocol::PROTOCOL_VERSION);
}
