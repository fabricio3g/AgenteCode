#[test]
fn saved_edits_recover_the_project_and_remain_undoable_after_restart() {
    let (config, root) = persistent_config("edits-recovery");
    let project = root.join("other-project");
    std::fs::create_dir_all(&project).unwrap();
    let session = agente_protocol::SessionId::new();
    let runtime = super::RuntimeSupervisor::start(config);
    runtime
        .open_session(session, project.to_str().unwrap())
        .unwrap();
    runtime.inner.lock_edits().begin_turn(session, 3, None);
    std::fs::write(project.join("a.txt"), "keep\nnew\n").unwrap();
    runtime.inner.lock_edits().end_turn(
        session,
        vec![super::edits::FileEdit {
            path: "a.txt".into(),
            before: Some("keep\nold\n".into()),
            after: Some("keep\nnew\n".into()),
        }],
    );
    runtime.inner.persist_edits(session);
    drop(runtime);
    let restored = super::RuntimeSupervisor::start(persistent_config_at(&root));
    let checkpoints = restored.checkpoints(session);
    assert_eq!(checkpoints[0]["additions"], 1);
    assert_eq!(checkpoints[0]["deletions"], 1);
    assert_eq!(restored.undo(session).unwrap(), vec!["a.txt"]);
    assert_eq!(
        std::fs::read_to_string(project.join("a.txt")).unwrap(),
        "keep\nold\n"
    );
    drop(restored);
    let restored = super::RuntimeSupervisor::start(persistent_config_at(&root));
    restored.redo(session).unwrap();
    assert_eq!(
        std::fs::read_to_string(project.join("a.txt")).unwrap(),
        "keep\nnew\n"
    );
    let _ = std::fs::remove_dir_all(root);
}
use super::*;
use std::path::{Path, PathBuf};

use agente_core::agent::{AgentEvent, AgentTaskEvent, UserInbox};
use agente_core::config::AppConfig;
use agente_core::subagent::{SubagentSnapshot, SubagentStatus};
use agente_core::types::AgentMode;
use agente_core::AbortController;
use agente_protocol::{
    Message, Role, StartTurn, Trust, TurnMode, TurnOutcome, TurnStatus, UserInput,
};
use agente_session::SessionStore;
use tokio::sync::{mpsc, oneshot};

fn test_config() -> RuntimeConfig {
    RuntimeConfig::from_app_config(&AppConfig::default(), "D:/proj")
}

#[test]
fn headless_turn_uses_the_selected_provider_model() {
    let config = AppConfig {
        default_provider: Some("openrouter".into()),
        default_model: Some("stealth/space-bunny-alpha".into()),
        executor_model: Some("openai/gpt-4o-mini".into()),
        ..AppConfig::default()
    };
    let runtime = RuntimeConfig::from_app_config(&config, "D:/proj");
    assert_eq!(runtime.default_provider, "openrouter");
    assert_eq!(runtime.default_model, "stealth/space-bunny-alpha");
}

#[test]
fn mode_parsing_fails_closed_to_plan() {
    let mut config = AppConfig {
        default_mode: Some("build".into()),
        ..AppConfig::default()
    };

    assert_eq!(
        RuntimeConfig::from_app_config(&config, "p").mode,
        AgentMode::Build
    );
    config.default_mode = Some("BUILD".into());
    assert_eq!(
        RuntimeConfig::from_app_config(&config, "p").mode,
        AgentMode::Build
    );

    for unknown in [Some("plan".to_string()), Some("garbage".to_string()), None] {
        config.default_mode = unknown.clone();
        assert_eq!(
            RuntimeConfig::from_app_config(&config, "p").mode,
            AgentMode::Plan,
            "unexpected mode for {unknown:?}"
        );
    }
}

#[test]
fn system_prompt_is_cached_across_calls() {
    let handle = RuntimeSupervisor::start(test_config());
    let first = handle.inner.cached_system_prompt("D:/proj");
    let second = handle.inner.cached_system_prompt("D:/proj");
    assert_eq!(first, second);
    assert!(first.contains("tool"), "prompt should list tools");
}

#[test]
fn prune_finished_children_drops_only_terminal_entries() {
    let handle = RuntimeSupervisor::start(test_config());
    let inner = &handle.inner;

    inner.child_id("child-running");
    inner.child_id("child-done");
    inner.child_id("child-unknown");
    let snapshot = |id: &str| SubagentSnapshot {
        id: id.into(),
        subagent_type: "explore".into(),
        description: String::new(),
        prompt: String::new(),
        status: SubagentStatus::Running,
        summary: None,
        conversation: Vec::new(),
        model: String::new(),
        seat: None,
        provider: String::new(),
        thinking: String::new(),
        depth: 0,
        background: false,
        started_at: Utc::now(),
        finished_at: None,
        cwd: None,
        worktree: None,
    };
    inner
        .config
        .subagent_registry
        .insert(snapshot("child-running"));
    inner
        .config
        .subagent_registry
        .insert(snapshot("child-done"));
    inner.config.subagent_registry.finish(
        "child-done",
        SubagentStatus::Completed,
        String::new(),
        Vec::new(),
    );

    inner.prune_finished_children();

    let children = inner.lock_children();
    assert!(children.contains_key("child-running"));
    assert!(children.contains_key("child-unknown"));
    assert!(!children.contains_key("child-done"));
}

// ------------------------------------------------------------------
// Durable session persistence
// ------------------------------------------------------------------

fn temp_store_dir(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("agente-runtime-{tag}-{}", SessionId::new()))
}

fn persistent_config(tag: &str) -> (RuntimeConfig, PathBuf) {
    let root = temp_store_dir(tag);
    let config = test_config()
        .with_persistence_dir(root.clone())
        .expect("store opens in a fresh tempdir");
    (config, root)
}

fn persistent_config_at(root: &Path) -> RuntimeConfig {
    test_config()
        .with_persistence_dir(root.to_path_buf())
        .expect("store reopens")
}

fn core_assistant_message(content: &str) -> agente_core::types::Message {
    agente_core::types::Message {
        role: agente_core::types::Role::Assistant,
        content: content.to_string(),
        tool_calls: None,
        tool_call_id: None,
        thinking: None,
        thinking_signature: None,
        continuation: None,
        attachments: Vec::new(),
    }
}

fn contents_of(conversation: &[Message]) -> Vec<&str> {
    conversation
        .iter()
        .map(|message| message.content.as_str())
        .collect()
}

/// Drive one fake turn to `Done` through the bridge forwarder (the same
/// pattern the bridge tests use) and return the turn outcome.
async fn drive_done_turn(
    inner: &Arc<RuntimeInner>,
    session_id: SessionId,
    answer: &str,
    tokens: u32,
    steering: &[&str],
) -> TurnOutcome {
    let turn_id = TurnId::new();
    let (event_tx, mut event_rx) = mpsc::channel(EVENT_CAPACITY);
    let (outcome_tx, outcome_rx) = oneshot::channel();
    inner.lock_turns().insert(
        turn_id,
        TurnControl {
            trust: Trust::Owner,
            cancel: AbortController::new(),
            inbox: {
                let inbox = UserInbox::default();
                inbox
                    .lock()
                    .extend(steering.iter().map(|text| Message::user(*text)));
                inbox
            },
            events: event_tx.clone(),
            session_id,
        },
    );

    let (legacy_tx, legacy_rx) = std::sync::mpsc::channel();
    legacy_tx
        .send(AgentTaskEvent {
            task_id: 1,
            event: AgentEvent::Done {
                conversation: vec![core_assistant_message(answer)],
                tokens,
            },
        })
        .unwrap();
    drop(legacy_tx);

    let inner_for_bridge = Arc::clone(inner);
    tokio::task::spawn_blocking(move || {
        crate::bridge::forward_legacy_events(
            inner_for_bridge,
            session_id,
            turn_id,
            legacy_rx,
            event_tx,
            outcome_tx,
        );
    });

    let outcome = outcome_rx.await.unwrap();
    // Drain the event channel so the forwarder's sends never block.
    while event_rx.recv().await.is_some() {}
    outcome
}

#[tokio::test]
async fn done_turn_persists_session_for_recovery() {
    let (config, root) = persistent_config("done-persist");
    let handle = RuntimeSupervisor::start(config);
    let session_id = SessionId::new();

    let outcome = drive_done_turn(
        &handle.inner,
        session_id,
        "answer",
        42,
        &["queued steering"],
    )
    .await;
    assert_eq!(outcome.status, TurnStatus::Completed);
    assert_eq!(outcome.tokens, 42);
    assert_eq!(outcome.revision, 1);

    // A fresh store instance over the same directory (i.e. another
    // process) lists the session and recovers the committed conversation.
    let store = SessionStore::open(&root).unwrap();
    assert!(store.list_sessions().unwrap().contains(&session_id));
    let recovered = store.recover(session_id).unwrap();
    assert_eq!(recovered.snapshot.revision, 1);
    assert_eq!(
        contents_of(&recovered.snapshot.conversation),
        vec!["answer", "queued steering"]
    );

    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn second_supervisor_recovers_session_and_continues_revisions() {
    let (config, root) = persistent_config("second-supervisor");
    let session_id = SessionId::new();
    {
        let first = RuntimeSupervisor::start(config);
        let outcome =
            drive_done_turn(&first.inner, session_id, "answer", 7, &["queued steering"]).await;
        assert_eq!(outcome.revision, 1);
    } // The first supervisor (and its in-memory sessions) is gone.

    let second = RuntimeSupervisor::start(
        test_config()
            .with_persistence_dir(root.clone())
            .expect("store reopens"),
    );

    // session/load across the restart: recovered from the store, with the
    // revision seeded from the durable snapshot.
    let snapshot = second.session_snapshot(session_id);
    assert_eq!(snapshot.revision, 1);
    assert_eq!(
        contents_of(&snapshot.conversation),
        vec!["answer", "queued steering"]
    );

    // fork_session recovers too; the fork itself starts at revision 0.
    let fork = second.fork_session(session_id);
    assert_ne!(fork.session_id, session_id);
    assert_eq!(fork.revision, 0);
    assert_eq!(fork.conversation.len(), 2);

    // Revision continuity: the next commit on the recovered session
    // increments past the recovered revision instead of restarting at 1.
    let outcome = drive_done_turn(&second.inner, session_id, "second answer", 3, &[]).await;
    assert_eq!(outcome.revision, 2);

    let store = SessionStore::open(&root).unwrap();
    let recovered = store.recover(session_id).unwrap();
    assert_eq!(recovered.snapshot.revision, 2);
    assert_eq!(
        contents_of(&recovered.snapshot.conversation),
        vec!["second answer"]
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn persistence_failure_does_not_break_turns() {
    let (config, root) = persistent_config("unwritable");
    let handle = RuntimeSupervisor::start(config);
    // The store directory vanishes after startup (e.g. the user deleted
    // `.agente` mid-run): every snapshot write now fails.
    std::fs::remove_dir_all(&root).unwrap();

    let session_id = SessionId::new();
    let outcome = drive_done_turn(&handle.inner, session_id, "answer", 9, &[]).await;
    assert_eq!(
        outcome.status,
        TurnStatus::Completed,
        "a persistence failure must not fail the turn"
    );
    assert_eq!(outcome.revision, 1);

    // The authoritative in-memory session is intact.
    let snapshot = handle.session_snapshot(session_id);
    assert_eq!(snapshot.revision, 1);
    assert_eq!(contents_of(&snapshot.conversation), vec!["answer"]);

    // A supervisor reopened over the missing directory recovers nothing
    // and degrades to an empty session instead of erroring.
    let reopened = RuntimeSupervisor::start(
        test_config()
            .with_persistence_dir(root.clone())
            .expect("store reopens"),
    );
    let missing = reopened.session_snapshot(session_id);
    assert_eq!(missing.revision, 0);
    assert!(missing.conversation.is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn start_turn_recovers_session_and_persists_initial_snapshot() {
    let (config, root) = persistent_config("start-turn");
    let store = SessionStore::open(&root).unwrap();
    let session_id = SessionId::new();
    // Seed the store the way a previous process would have left it.
    store
        .write_snapshot(
            &SessionSnapshot {
                session_id,
                revision: 3,
                conversation: vec![Message::user("resumed question")],
            },
            3,
        )
        .unwrap();

    let handle = RuntimeSupervisor::start(config);
    let start = StartTurn {
        session_id,
        conversation: Vec::new(),
        // Unknown providers fail fast in the agent loop before any network
        // access, keeping this test offline and deterministic.
        provider: Some("definitely-not-a-provider".to_string()),
        ..StartTurn::default()
    };
    let mut turn = handle.start_turn(start).expect("turn starts");

    // The initial insert is a commit point: the recovered conversation
    // (plus the runtime system prompt) is durable before any event fires.
    // No await point has run yet, so the background turn cannot have
    // committed its error and raced this read.
    let persisted = store.recover(session_id).unwrap();
    assert_eq!(persisted.snapshot.revision, 3);
    assert_eq!(persisted.snapshot.conversation.len(), 2);
    assert_eq!(persisted.snapshot.conversation[0].role, Role::System);
    assert_eq!(
        persisted.snapshot.conversation[1].content,
        "resumed question"
    );

    // The turn fails fast but still commits, continuing the recovered
    // revision.
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(30), turn.outcome())
        .await
        .expect("turn finishes")
        .expect("outcome delivered");
    assert_eq!(outcome.status, TurnStatus::Failed);
    assert_eq!(outcome.revision, 4, "revision continues after recovery");

    let recovered = store.recover(session_id).unwrap();
    assert_eq!(recovered.snapshot.revision, 4);
    assert_eq!(recovered.snapshot.conversation.len(), 2);
    // The in-memory snapshot matches the durable copy.
    assert_eq!(handle.session_snapshot(session_id).revision, 4);
    std::fs::remove_dir_all(root).unwrap();
}

/// Two overlapping turns on one session would each commit a full
/// conversation; the second start is rejected until the first settles.
#[tokio::test]
async fn start_turn_rejects_a_second_active_turn_for_the_same_session() {
    let handle = RuntimeSupervisor::start(test_config());
    let session_id = SessionId::new();
    let start = |session_id| StartTurn {
        session_id,
        conversation: Vec::new(),
        // Unknown provider fails fast before any network access.
        provider: Some("definitely-not-a-provider".to_string()),
        ..StartTurn::default()
    };

    let mut first = handle
        .start_turn(start(session_id))
        .expect("first turn starts");
    match handle.start_turn(start(session_id)) {
        Err(RuntimeError::SessionBusy(busy)) => assert_eq!(busy, session_id),
        other => panic!(
            "expected SessionBusy, got {:?}",
            other.map(|_| ()).map_err(|e| e.to_string())
        ),
    }

    // A different session is unaffected.
    let other_session = SessionId::new();
    let _other = handle
        .start_turn(start(other_session))
        .expect("another session can run concurrently");

    let _ = first.outcome().await;
    // The reservation is released when the turn settles.
    let _resumed = handle
        .start_turn(start(session_id))
        .expect("session starts a new turn after the first finishes");
}

#[test]
fn trust_below_owner_is_read_only() {
    use agente_protocol::{Trust, TurnMode};
    assert_eq!(
        effective_mode(Some(TurnMode::Build), AgentMode::Plan, Trust::Owner),
        (AgentMode::Build, Some(false))
    );
    assert_eq!(
        effective_mode(Some(TurnMode::Auto), AgentMode::Plan, Trust::Owner),
        (AgentMode::Build, Some(true))
    );
    assert_eq!(
        effective_mode(None, AgentMode::Build, Trust::Owner),
        (AgentMode::Build, None)
    );
    for trust in [Trust::Trusted, Trust::Public] {
        for requested in [Some(TurnMode::Build), Some(TurnMode::Auto), None] {
            assert_eq!(
                effective_mode(requested, AgentMode::Build, trust),
                (AgentMode::Plan, Some(false)),
                "{trust:?} must never build"
            );
        }
    }
}

#[test]
fn sessions_in_other_projects_get_their_own_permissions() {
    let handle = RuntimeSupervisor::start(test_config());
    let home = handle.inner.session_context(SessionId::new(), None);
    assert_eq!(home.project_dir, "D:/proj");
    let other_home = handle.inner.session_context(SessionId::new(), None);
    assert!(
        !Arc::ptr_eq(&home.engine, &other_home.engine),
        "sessions in one project still get their own engine"
    );

    let session = SessionId::new();
    let other = handle.inner.session_context(session, Some("D:/other"));
    assert_eq!(other.project_dir, "D:/other");
    assert!(!Arc::ptr_eq(&other.engine, &home.engine));
    // The same session keeps its context when a later turn names no project.
    let again = handle.inner.session_context(session, None);
    assert!(Arc::ptr_eq(&other.engine, &again.engine));
}

#[test]
fn active_controls_are_scoped_and_keep_untrusted_turns_read_only() {
    let handle = RuntimeSupervisor::start(test_config());
    let session_id = SessionId::new();
    let other = handle.inner.session_context(SessionId::new(), None);
    let context = handle.inner.session_context(session_id, None);
    let turn_id = TurnId::new();
    let cancel = AbortController::new();
    let inbox = UserInbox::default();
    handle.inner.lock_turns().insert(
        turn_id,
        TurnControl {
            trust: Trust::Owner,
            cancel: cancel.clone(),
            inbox: inbox.clone(),
            events: mpsc::channel(1).0,
            session_id,
        },
    );
    assert!(handle.update_turn(turn_id, Some("high".into()), Some(TurnMode::Auto)));
    assert_eq!(context.engine.read().unwrap().mode, AgentMode::Build);
    assert!(context.engine.read().unwrap().auto_approve());
    assert_eq!(other.engine.read().unwrap().mode, AgentMode::Build);
    assert!(!cancel.signal().is_aborted());
    assert!(handle.update_turn(turn_id, None, Some(TurnMode::Build)));
    assert!(!context.engine.read().unwrap().auto_approve());
    assert!(handle.update_turn(turn_id, None, Some(TurnMode::Plan)));
    assert_eq!(context.engine.read().unwrap().mode, AgentMode::Plan);
    handle.inner.lock_turns().get_mut(&turn_id).unwrap().trust = Trust::Public;
    assert!(handle.update_turn(turn_id, None, Some(TurnMode::Auto)));
    assert_eq!(context.engine.read().unwrap().mode, AgentMode::Plan);
    assert!(!context.engine.read().unwrap().auto_approve());
    inbox.close();
    assert!(!handle.update_turn(turn_id, None, Some(TurnMode::Auto)));
}

#[tokio::test]
async fn steering_joins_the_running_turn_without_cancelling_it() {
    let handle = RuntimeSupervisor::start(test_config());
    let mut attached = handle.subscribe();
    let session_id = SessionId::new();
    let turn_id = TurnId::new();
    let cancel = AbortController::new();
    let inbox = UserInbox::default();
    let (events, mut turn_events) = mpsc::channel(8);
    handle.inner.lock_turns().insert(
        turn_id,
        TurnControl {
            trust: Trust::Owner,
            cancel: cancel.clone(),
            inbox: Arc::clone(&inbox),
            events,
            session_id,
        },
    );

    assert!(handle.steer(
        turn_id,
        UserInput {
            content: "also check the tests".into()
        }
    ));

    assert!(!cancel.signal().is_aborted(), "steering must not cancel");
    assert_eq!(contents_of(&inbox.lock()), vec!["also check the tests"]);
    let own = turn_events.recv().await.expect("turn channel event");
    assert!(matches!(own.event, RuntimeEvent::SteeringQueued));
    let broadcast = attached.recv().await.expect("runtime-wide event");
    assert!(matches!(broadcast.event, RuntimeEvent::SteeringQueued));
    assert_eq!(broadcast.turn_id, turn_id);
    assert!(!handle.steer(
        TurnId::new(),
        UserInput {
            content: "x".into()
        }
    ));
}

#[test]
fn list_and_delete_cover_memory_and_disk() {
    let (config, dir) = persistent_config("list-delete");
    let handle = RuntimeSupervisor::start(config);
    let session_id = SessionId::new();
    let snapshot = SessionSnapshot {
        session_id,
        revision: 1,
        conversation: vec![Message::user("hello")],
    };
    handle
        .inner
        .write_sessions()
        .insert(session_id, snapshot.clone());
    handle.inner.persist_snapshot(&snapshot);

    let restarted = RuntimeSupervisor::start(persistent_config_at(&dir));
    assert_eq!(restarted.list_sessions(), vec![session_id]);

    // A running turn blocks deletion.
    restarted.inner.lock_turns().insert(
        TurnId::new(),
        TurnControl {
            trust: Trust::Owner,
            cancel: AbortController::new(),
            inbox: UserInbox::default(),
            events: mpsc::channel(1).0,
            session_id,
        },
    );
    assert!(matches!(
        restarted.delete_session(session_id),
        Err(RuntimeError::SessionBusy(_))
    ));
    restarted.inner.lock_turns().clear();

    assert!(restarted.delete_session(session_id).unwrap());
    assert!(restarted.list_sessions().is_empty());
    assert!(RuntimeSupervisor::start(persistent_config_at(&dir))
        .list_sessions()
        .is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn compact_shrinks_a_long_conversation_and_bumps_the_revision() {
    let handle = RuntimeSupervisor::start(test_config());
    let mut attached = handle.subscribe();
    let session_id = SessionId::new();
    let long = "lorem ipsum dolor sit amet ".repeat(400);
    let conversation = (0..40)
        .map(|i| {
            if i % 2 == 0 {
                Message::user(format!("{i} {long}"))
            } else {
                let mut reply = Message::user(format!("{i} {long}"));
                reply.role = Role::Assistant;
                reply
            }
        })
        .collect::<Vec<_>>();
    handle.inner.write_sessions().insert(
        session_id,
        SessionSnapshot {
            session_id,
            revision: 3,
            conversation,
        },
    );

    let compacted = handle.compact(session_id).unwrap();
    assert!(
        compacted.conversation.len() < 40,
        "{}",
        compacted.conversation.len()
    );
    assert_eq!(compacted.revision, 4);
    assert!(matches!(
        attached.try_recv().map(|e| e.event),
        Ok(RuntimeEvent::ContextCompacted { revision: 4, .. })
    ));
}

#[tokio::test]
async fn a_turn_saves_the_session_list_entry() {
    let (config, dir) = persistent_config("meta");
    let handle = RuntimeSupervisor::start(config);
    let session_id = SessionId::new();
    let mut turn = handle
        .start_turn(StartTurn {
            session_id,
            conversation: vec![Message::user("  summarize   the release notes  ")],
            // Unknown provider fails fast, before any network access.
            provider: Some("definitely-not-a-provider".into()),
            profile: Some("colina".into()),
            ..StartTurn::default()
        })
        .expect("turn starts");
    let _ = turn.outcome().await;

    let infos = handle.session_infos();
    assert_eq!(infos.len(), 1);
    let info = &infos[0];
    assert_eq!(info.session_id, session_id);
    assert_eq!(info.first_prompt, "summarize the release notes");
    assert_eq!(info.provider, "definitely-not-a-provider");
    assert_eq!(info.profile.as_deref(), Some("colina"));
    assert_eq!(info.project_dir, "D:/proj");

    handle
        .save_client_state(
            session_id,
            "tui",
            serde_json::json!({"x": 1}),
            Some("Release notes".into()),
        )
        .unwrap();
    let meta = handle.session_meta(session_id).unwrap();
    assert_eq!(meta.info.title, "Release notes");
    assert_eq!(meta.clients["tui"], serde_json::json!({"x": 1}));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn exec_tool_runs_a_direct_command_without_touching_the_conversation() {
    let dir = std::env::temp_dir().join(format!("agente-exec-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let handle = RuntimeSupervisor::start(RuntimeConfig::from_app_config(
        &AppConfig::default(),
        dir.to_string_lossy().to_string(),
    ));
    let session_id = SessionId::new();

    assert!(matches!(
        handle.exec_tool(
            session_id,
            "shell",
            serde_json::json!({"command": "echo hi"}),
            Trust::Public
        ),
        Err(RuntimeError::NotAllowed(_))
    ));

    let mut run = handle
        .exec_tool(
            session_id,
            "shell",
            serde_json::json!({"command": "echo hi"}),
            Trust::Owner,
        )
        .expect("owner can run a command");
    let mut result = None;
    while let Some(envelope) = run.recv().await {
        if let RuntimeEvent::ToolResult {
            content, is_error, ..
        } = &envelope.event
        {
            result = Some((content.clone(), *is_error));
        }
        if envelope.event.is_terminal() {
            break;
        }
    }
    let (content, is_error) = result.expect("a tool result");
    assert!(!is_error, "{content}");
    assert!(content.contains("hi"), "{content}");
    assert_eq!(run.outcome().await.unwrap().status, TurnStatus::Completed);
    assert!(handle.session_snapshot(session_id).conversation.is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn live_reads_share_an_immutable_snapshot_and_configure_keeps_old_turn_settings() {
    let handle = RuntimeSupervisor::start(test_config());
    let first = handle.inner.live();
    assert!(Arc::ptr_eq(&first, &handle.inner.live()));
    let old_limit = first.max_iterations;
    handle
        .configure(serde_json::json!({ "max_iterations": old_limit + 1 }))
        .unwrap();
    let next = handle.inner.live();
    assert!(!Arc::ptr_eq(&first, &next));
    assert_eq!(first.max_iterations, old_limit);
    assert_eq!(next.max_iterations, old_limit + 1);
}

#[test]
fn configure_adds_a_provider_and_changes_the_defaults() {
    let handle = RuntimeSupervisor::start(test_config());
    handle
        .configure(serde_json::json!({
            "provider": {
                "local-llama": {
                    "name": "Local llama.cpp",
                    "api_format": "openai",
                    "options": { "base_url": "http://127.0.0.1:11435/v1", "api_key": "k" },
                    "models": { "qwen3-8b": { "name": "Qwen3 8B" } }
                }
            },
            "default_provider": "local-llama",
            "default_model": "qwen3-8b",
            "smart_compaction": true
        }))
        .unwrap();
    let live = handle.inner.live();
    assert_eq!(live.default_provider, "local-llama");
    assert_eq!(live.default_model, "qwen3-8b");
    assert!(live.smart_compaction);
    let local = live
        .provider_registry
        .get("local-llama")
        .expect("registered");
    assert_eq!(local.info().base_url, "http://127.0.0.1:11435/v1");

    // A later patch adds to the providers instead of replacing them.
    handle
        .configure(serde_json::json!({ "provider": { "other": { "api_format": "openai" } } }))
        .unwrap();
    let live = handle.inner.live();
    assert!(live.app_config.provider.contains_key("local-llama"));
    assert!(live.app_config.provider.contains_key("other"));
    assert_eq!(live.default_provider, "local-llama", "untouched keys stay");

    assert!(matches!(
        handle.configure(serde_json::json!([1])),
        Err(RuntimeError::Config(_))
    ));
    assert!(matches!(
        handle.configure(serde_json::json!({ "smart_compaction": "yes" })),
        Err(RuntimeError::Config(_))
    ));
}

#[tokio::test]
async fn a_prompt_is_appended_and_a_session_can_bring_its_own_system_prompt() {
    let handle = RuntimeSupervisor::start(test_config());
    let session_id = SessionId::new();
    let start = |prompt: &str, system: Option<&str>| StartTurn {
        session_id,
        prompt: Some(Message::user(prompt)),
        system_prompt: system.map(str::to_string),
        // Unknown provider fails fast, before any network access.
        provider: Some("definitely-not-a-provider".into()),
        ..StartTurn::default()
    };
    let mut first = handle
        .start_turn(start("first", Some("You are the Code section.")))
        .unwrap();
    let _ = first.outcome().await;
    let mut second = handle.start_turn(start("second", None)).unwrap();
    let _ = second.outcome().await;

    let conversation = handle.session_snapshot(session_id).conversation;
    assert_eq!(conversation[0].role, Role::System);
    assert_eq!(conversation[0].content, "You are the Code section.");
    let users: Vec<_> = conversation
        .iter()
        .filter(|m| m.role == Role::User)
        .map(|m| m.content.as_str())
        .collect();
    assert_eq!(users, vec!["first", "second"]);
}

/// A bot's persona (and so its memory) is read afresh on every turn.
#[tokio::test]
async fn a_profile_turn_uses_the_current_persona() {
    struct Personas(std::sync::Mutex<String>);
    impl ProfileSource for Personas {
        fn persona(&self, profile: &str) -> Option<String> {
            (profile == "colina").then(|| self.0.lock().unwrap().clone())
        }
    }
    let personas = Arc::new(Personas(std::sync::Mutex::new(
        "You are Colina (@colina).\nMemory: likes tea.".into(),
    )));
    let handle = RuntimeSupervisor::start(test_config().with_profile_source(personas.clone()));
    let session_id = SessionId::new();
    let start = |prompt: &str, profile: &str| StartTurn {
        session_id,
        prompt: Some(Message::user(prompt)),
        profile: Some(profile.into()),
        // Unknown provider fails fast, before any network access.
        provider: Some("definitely-not-a-provider".into()),
        ..StartTurn::default()
    };
    let system = || {
        handle.session_snapshot(session_id).conversation[0]
            .content
            .clone()
    };

    let _ = handle
        .start_turn(start("hi", "colina"))
        .unwrap()
        .outcome()
        .await;
    assert!(system().starts_with("You are Colina (@colina).\nMemory: likes tea."));
    assert!(system().contains("Read before you act."));

    *personas.0.lock().unwrap() = "You are Colina (@colina).\nMemory: likes coffee.".into();
    let _ = handle
        .start_turn(start("again", "colina"))
        .unwrap()
        .outcome()
        .await;
    assert!(system().contains("likes coffee"));
    assert!(!system().contains("likes tea"));

    // An unknown profile keeps the prompt the session has.
    let _ = handle
        .start_turn(start("third", "nobody"))
        .unwrap()
        .outcome()
        .await;
    assert!(system().contains("likes coffee"));
}

#[tokio::test]
async fn configure_can_add_mcp_servers_a_client_serves() {
    let handle = RuntimeSupervisor::start(test_config());
    assert!(handle.inner.live().mcp_manager.is_none());
    // Nothing listens on port 9: connecting fails, configuring does not.
    handle
        .configure_and_connect(serde_json::json!({
            "mcp": { "desktop": { "type": "http", "url": "http://127.0.0.1:9/mcp" } }
        }))
        .await
        .unwrap();
    let manager = handle
        .inner
        .live()
        .mcp_manager
        .clone()
        .expect("manager built");
    assert!(manager.tools().is_empty());
    // Settings that do not name mcp keep the manager.
    handle
        .configure(serde_json::json!({ "smart_compaction": true }))
        .unwrap();
    assert!(Arc::ptr_eq(
        &manager,
        &handle.inner.live().mcp_manager.clone().unwrap()
    ));
}

#[test]
fn fork_session_preserves_source_provider_and_model_metadata() {
    let (config, dir) = persistent_config("fork-meta");
    let handle = RuntimeSupervisor::start(config);
    let source = SessionId::new();
    handle.inner.write_sessions().insert(
        source,
        SessionSnapshot {
            session_id: source,
            revision: 2,
            conversation: vec![Message::user("hello fork")],
        },
    );
    handle.inner.update_meta(source, "D:/proj", |info| {
        info.provider = "openrouter".into();
        info.model = "anthropic/claude-sonnet-4".into();
        info.thinking_level = "high".into();
        info.profile = Some("colina".into());
    });

    let forked = handle.fork_session(source);
    let meta = handle
        .session_meta(forked.session_id)
        .expect("fork metadata saved");
    assert_eq!(meta.info.provider, "openrouter");
    assert_eq!(meta.info.model, "anthropic/claude-sonnet-4");
    assert_eq!(meta.info.thinking_level, "high");
    assert_eq!(meta.info.profile.as_deref(), Some("colina"));
    assert_eq!(meta.info.first_prompt, "hello fork");
    assert_eq!(meta.info.message_count, 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn delete_session_cleans_commit_locks_context_gaps_and_board_file() {
    let (config, dir) = persistent_config("delete-cleanup");
    let handle = RuntimeSupervisor::start(config);
    let session_id = SessionId::new();
    let _ = handle.inner.commit_lock(session_id);
    handle.inner.remember_context_gap(session_id, 512);
    let boards_dir = dir.join("boards");
    std::fs::create_dir_all(&boards_dir).unwrap();
    let board_file = boards_dir.join(format!("{session_id}.json"));
    std::fs::write(&board_file, r#"{"enabled":true,"cards":[]}"#).unwrap();

    assert!(handle.delete_session(session_id).unwrap());
    assert!(!handle
        .inner
        .commit_locks
        .lock()
        .unwrap()
        .contains_key(&session_id));
    assert_eq!(handle.inner.context_gap(session_id), 0);
    assert!(!board_file.exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn commit_compaction_after_restart_restores_and_preserves_edit_history() {
    let (config, root) = persistent_config("compaction-edits-restart");
    let project = root.join("proj");
    std::fs::create_dir_all(&project).unwrap();
    let session = SessionId::new();
    {
        let runtime = RuntimeSupervisor::start(config);
        runtime
            .open_session(session, project.to_str().unwrap())
            .unwrap();
        runtime.inner.lock_edits().begin_turn(session, 1, None);
        runtime.inner.lock_edits().end_turn(
            session,
            vec![edits::FileEdit {
                path: "a.txt".into(),
                before: Some("old\n".into()),
                after: Some("new\n".into()),
            }],
        );
        runtime.inner.persist_edits(session);
    }

    // Fresh supervisor after restart: session_context has NOT been called yet.
    let restarted = RuntimeSupervisor::start(persistent_config_at(&root));
    restarted.commit_compaction(
        session,
        vec![Message::user("compacted")],
        "summary".into(),
        100,
        20,
        true,
    );
    let meta = restarted.session_meta(session).unwrap();
    assert!(
        !meta.clients["runtime_edits"].is_null(),
        "runtime_edits must be restored before persist_edits rather than overwritten with null"
    );
    let _ = std::fs::remove_dir_all(root);
}
