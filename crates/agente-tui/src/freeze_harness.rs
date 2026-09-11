//! Headless freeze harness — drives the **real** App event drain + stuck-guard
//! (and optionally composed paint via TestBackend) without a live TTY.
//!
//! Catch freezes in CI:
//! - F1 TextDelta flood: drain stays within tick budget
//! - F3 silent agent: stuck-guard force-resets when last_event is aged
//! - F4 cancel: Esc interrupt path clears working state

use std::time::{Duration, Instant};

use agente_core::agent::AgentEvent;
use agente_core::config::AppConfig;
use agente_core::types::{AgentState, Message, Role};
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;

use crate::app::render_app;
use crate::app::App;

/// Per-drain budget for a single `tick_drain_only` under flood (debug Windows
/// can be slow; keep generous but fail if we hang multi-second).
const MAX_DRAIN_MS: u128 = 500;
/// Total wall budget for pumping 5k deltas in batches.
const MAX_FLOOD_WALL_MS: u128 = 5_000;

fn test_app() -> App {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    App::new_for_test(AppConfig::default(), "/tmp/freeze-harness".into(), runtime).expect("app")
}

fn key(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
    KeyEvent {
        code,
        modifiers: mods,
        kind: KeyEventKind::Press,
        state: crossterm::event::KeyEventState::empty(),
    }
}

/// F1: thousands of stream deltas must not hang the UI drain loop.
#[test]
fn f1_text_delta_flood_stays_within_tick_budget() {
    let mut app = test_app();
    app.state.agent.state = AgentState::StreamingResponse;
    app.state.agent.mark_agent_event();
    app.state.ui.show_welcome_screen = false;

    let wall = Instant::now();
    const TOTAL: usize = 5_000;
    const BATCH: usize = 200; // > MAX_AGENT_EVENTS_PER_TICK (128) so multi-tick

    for i in 0..TOTAL {
        app.inject_agent_event(AgentEvent::TextDelta(format!("x{i}")));
        if (i + 1) % BATCH == 0 {
            let d = app.tick_drain_only();
            assert!(
                d.as_millis() < MAX_DRAIN_MS,
                "drain tick took {}ms (budget {}ms) at i={i}",
                d.as_millis(),
                MAX_DRAIN_MS
            );
        }
    }
    // Drain the remainder. `tick_drain_only` always advances `tick_count`, so
    // there is no "queue empty" signal to loop on — one final drain plus the
    // explicit empty drains below is what actually clears the backlog.
    let d = app.tick_drain_only();
    assert!(
        d.as_millis() < MAX_DRAIN_MS,
        "final drain {}ms",
        d.as_millis()
    );
    // Explicit empty drains
    for _ in 0..50 {
        let d = app.tick_drain_only();
        assert!(d.as_millis() < MAX_DRAIN_MS);
    }

    assert!(
        wall.elapsed().as_millis() < MAX_FLOOD_WALL_MS,
        "flood wall {}ms exceeds {}ms",
        wall.elapsed().as_millis(),
        MAX_FLOOD_WALL_MS
    );
    assert!(
        !app.state.agent.streaming_text.is_empty(),
        "deltas should have been applied"
    );
    assert!(
        app.state.agent.wants_stream_paint(),
        "live stream should still request paint"
    );
}

/// F3: aged last_agent_event_at triggers force-reset (short AGENTE_STUCK_SECS).
#[test]
fn f3_stuck_guard_force_resets_silent_agent() {
    // Safety: only override for this test process if not already set high.
    // Use 1 second so we don't need to sleep long.
    std::env::set_var("AGENTE_STUCK_SECS", "1");

    let mut app = test_app();
    app.state.ui.show_welcome_screen = false;
    app.state.agent.state = AgentState::Executing;
    app.state.agent.streaming_text = "partial".into();
    // Age the clock past the timeout.
    app.state.agent.last_agent_event_at = Some(Instant::now() - Duration::from_secs(5));

    app.tick_drain_only();

    assert!(
        app.state.agent.is_idle(),
        "stuck-guard should force Idle, got {:?}",
        app.state.agent.state
    );
    assert!(
        app.state.agent.streaming_text.is_empty(),
        "stream buffers must clear on force-reset"
    );
    assert!(
        !app.state.agent.wants_stream_paint(),
        "must not thrash-paint after reset"
    );

    std::env::remove_var("AGENTE_STUCK_SECS");
}

/// F4: double-Esc interrupt while "streaming" cancels and idles the UI path
/// that does not wait for a real agent thread (cancel flag + local reset).
#[test]
fn f4_escape_interrupt_while_streaming() {
    let mut app = test_app();
    app.state.ui.show_welcome_screen = false;
    app.state.agent.state = AgentState::StreamingResponse;
    app.state.agent.streaming_text = "hello".into();
    app.state.agent.mark_agent_event();
    app.current_task_id = 1;

    // A single Esc stops the turn; a second covers the no-live-task path.
    app.handle_key(key(KeyCode::Esc, KeyModifiers::NONE))
        .expect("esc1");
    if !app.state.agent.is_idle() {
        app.handle_key(key(KeyCode::Esc, KeyModifiers::NONE))
            .expect("esc2");
    }

    // Drain any Cancelled injected by a background task (none in headless).
    app.tick_drain_only();

    // At minimum cancel was requested or the agent idled.
    let cancel_flag = app.state.cancel_tx.is_aborted();
    let cancelled_or_idle = app.state.agent.is_idle() || cancel_flag;
    assert!(
        cancelled_or_idle,
        "Esc should request cancel or idle the agent (state={:?})",
        app.state.agent.state
    );
}

/// Paint budget: long history + stream paint via TestBackend must complete.
#[test]
fn f2_long_history_stream_paint_budget() {
    let mut app = test_app();
    app.state.ui.show_welcome_screen = false;
    app.state.agent.state = AgentState::StreamingResponse;
    app.state.agent.streaming_text = "streaming…".repeat(20);
    app.state.agent.mark_agent_event();

    for i in 0..800 {
        app.state
            .session
            .chat_history
            .push(agente_core::types::ChatEntry {
                id: uuid::Uuid::new_v4(),
                role: if i % 2 == 0 {
                    Role::User
                } else {
                    Role::Assistant
                },
                content: format!("message {i} with some body text for wrap"),
                tool_name: None,
                tool_args: None,
                is_error: false,
                timestamp: chrono::Utc::now(),
                response_duration: Some(100.0),
                mode: "Build".into(),
                interrupted: false,
                reasoning: None,
                subagent_id: None,
                subagent_type: None,
                diff_stats: None,
            });
    }

    let backend = TestBackend::new(100, 30);
    let mut terminal = Terminal::new(backend).unwrap();
    let t0 = Instant::now();
    terminal.draw(|f| render_app(f, &mut app.state)).unwrap();
    let ms = t0.elapsed().as_millis();
    // Debug Windows: allow up to 2s; hang would be tens of seconds.
    assert!(
        ms < 2_000,
        "composed paint took {ms}ms for long history+stream"
    );

    // Measure warm frames as new text arrives in a long conversation. Report
    // percentiles instead of asserting a hardware-specific FPS in debug CI.
    let mut samples = Vec::with_capacity(120);
    for _ in 0..120 {
        app.state.agent.streaming_text.push_str(" next");
        let start = Instant::now();
        terminal.draw(|f| render_app(f, &mut app.state)).unwrap();
        samples.push(start.elapsed());
    }
    samples.sort_unstable();
    eprintln!(
        "render profile: 800 messages, 100x30, 120 streaming frames; cold={ms}ms p50={:?} p95={:?} max={:?}",
        samples[60], samples[114], samples[119]
    );
    assert!(samples[119] < Duration::from_secs(2), "warm render stalled");
}

/// After Done, stream paint thrash must stop.
#[test]
fn done_clears_stream_paint_thrash() {
    let mut app = test_app();
    app.state.agent.state = AgentState::StreamingResponse;
    app.state.agent.streaming_text = "partial answer".into();
    app.state.agent.mark_agent_event();
    app.inject_agent_event(AgentEvent::Done {
        conversation: vec![Message {
            role: Role::User,
            content: "hi".into(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
        }],
        tokens: 10,
    });
    app.tick_drain_only();
    assert!(app.state.agent.is_idle());
    assert!(!app.state.agent.wants_stream_paint());
}
