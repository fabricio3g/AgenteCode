//! Application run loop and orchestration.
//!
//! Submodules own focused `impl App` blocks:
//! - `agent_events` — background agent event drain
//! - `keys` / `mouse` — input routing
//! - `commands` — slash / palette actions
//! - `chat_turn` — turn lifecycle
//! - `render` — layout / paint
//! - `util` — pure helpers

mod agent_events;
mod chat_turn;
mod commands;
mod health;
mod keys;
mod mouse;
mod persistence;
mod render;
mod session_titles;
mod util;

pub(crate) use health::{stuck_soft_warn_secs, stuck_timeout_secs, LoopHealth};

use session_titles::SessionTitleResult;

/// Full-frame paint, exposed to the crate's visual harness (`ui_harness`) and
/// web inspector so they can screenshot the *composed* app, not just individual widgets.
pub(crate) use render::render_app;

use std::collections::HashSet;
use std::io::{self, Write as _};
use std::sync::mpsc;
use std::time::Duration;

use crossterm::terminal::{enable_raw_mode, EnterAlternateScreen};
use crossterm::ExecutableCommand;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use agente_core::agent::{spawn_discovery_task, AgentTaskEvent};
use agente_core::config::AppConfig;
use agente_core::permissions::ApprovalBroker;
use std::sync::Arc;

use crate::state::AppState;

pub struct App {
    terminal: Terminal<CrosstermBackend<io::Stdout>>,
    pub(crate) state: AppState,
    runtime: tokio::runtime::Runtime,
    agent_rx: mpsc::Receiver<AgentTaskEvent>,
    /// Clone and send from tests / background tasks to inject agent events.
    pub(crate) agent_tx: mpsc::Sender<AgentTaskEvent>,
    session_title_rx: mpsc::Receiver<SessionTitleResult>,
    session_title_tx: mpsc::Sender<SessionTitleResult>,
    title_requests_started: HashSet<uuid::Uuid>,
    /// Routes approval requests/responses between the running agent(s) and the
    /// UI. Shared by the parent task and any subagents it spawns.
    approval_broker: ApprovalBroker,
    pub(crate) current_task_id: u64,
    /// Main-loop health (tick counters, slow-frame tracking, heartbeat).
    pub(crate) health: LoopHealth,
    /// Cached `format!("{:?}", agent.state)` label for health logging. The
    /// agent state only changes on events, so the label is recomputed just
    /// when it changes instead of allocating every tick.
    agent_state_label: String,
    agent_state_label_source: Option<agente_core::types::AgentState>,
    persistence: persistence::PersistenceWorker,
}

struct SynchronizedUpdateGuard;

impl SynchronizedUpdateGuard {
    fn begin() -> Self {
        let mut stdout = io::stdout();
        let _ = stdout.write_all(b"\x1b[?2026h");
        let _ = stdout.flush();
        Self
    }
}

impl Drop for SynchronizedUpdateGuard {
    fn drop(&mut self) {
        let mut stdout = io::stdout();
        let _ = stdout.write_all(b"\x1b[?2026l");
        let _ = stdout.flush();
    }
}

impl App {
    pub fn new(
        config: AppConfig,
        project_dir: String,
        runtime: tokio::runtime::Runtime,
    ) -> anyhow::Result<Self> {
        enable_raw_mode()?;
        io::stdout().execute(EnterAlternateScreen)?;
        crossterm::execute!(
            io::stdout(),
            crossterm::event::EnableMouseCapture,
            crossterm::event::EnableBracketedPaste
        )?;
        let backend = CrosstermBackend::new(io::stdout());
        let terminal = Terminal::new(backend)?;

        let mut state = AppState::new(config, project_dir);
        state.refresh_recent_sessions();
        if let Some(theme) = state.config.config.theme.as_deref() {
            crate::style::set_theme(match theme {
                "light" => crate::style::Theme::Light,
                _ => crate::style::Theme::Dark,
            });
        }
        let (agent_tx, agent_rx) = mpsc::channel();
        let (session_title_tx, session_title_rx) = mpsc::channel();
        let approval_broker = ApprovalBroker::new();
        let registry = state.config.provider_registry.clone();

        let _guard = runtime.enter();
        for provider in &state.config.connected_providers {
            spawn_discovery_task(agent_tx.clone(), provider.clone(), registry.clone());
        }
        // Spawn MCP background connection (inside runtime context)
        let mcp_manager = Arc::clone(&state.config.mcp_manager);
        tokio::spawn(async move {
            let mut manager = mcp_manager.lock().await;
            if let Err(e) = manager.connect_all().await {
                tracing::warn!("MCP background connect failed: {}", e);
            }
        });
        drop(_guard);

        let app = Self {
            terminal,
            state,
            runtime,
            agent_rx,
            agent_tx,
            session_title_rx,
            session_title_tx,
            title_requests_started: HashSet::new(),
            approval_broker,
            current_task_id: 0,
            health: LoopHealth::default(),
            agent_state_label: String::new(),
            agent_state_label_source: None,
            persistence: persistence::PersistenceWorker::start(),
        };
        // Don't show session picker by default - show welcome screen instead
        Ok(app)
    }

    /// Redirect the config/auth/session stores into a per-process temp dir.
    ///
    /// Several key-routing tests reach `persist_config()`, which really wrote
    /// `~/.agente/config.json` and could have written the developer's key
    /// store. Idempotent and process-wide, so parallel tests all agree.
    #[cfg(test)]
    fn sandbox_user_state() {
        use std::sync::Once;
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            let root = std::env::temp_dir().join(format!("agente-test-{}", std::process::id()));
            let _ = std::fs::create_dir_all(root.join("sessions"));
            std::env::set_var("AGENTE_CONFIG_DIR", &root);
            std::env::set_var("AGENTE_SESSIONS_DIR", root.join("sessions"));
        });
    }

    /// Test-only constructor: same `App` (and therefore the same real key
    /// handler) without raw mode / alternate screen / discovery / MCP side
    /// effects, so key-routing tests can drive `handle_key` directly.
    #[cfg(test)]
    pub(crate) fn new_for_test(
        config: AppConfig,
        project_dir: String,
        runtime: tokio::runtime::Runtime,
    ) -> anyhow::Result<Self> {
        Self::sandbox_user_state();
        let backend = CrosstermBackend::new(io::stdout());
        let terminal = Terminal::new(backend)?;

        let state = AppState::new(config, project_dir);
        if let Some(theme) = state.config.config.theme.as_deref() {
            crate::style::set_theme(match theme {
                "light" => crate::style::Theme::Light,
                _ => crate::style::Theme::Dark,
            });
        }
        let (agent_tx, agent_rx) = mpsc::channel();
        let (session_title_tx, session_title_rx) = mpsc::channel();
        let approval_broker = ApprovalBroker::new();

        Ok(Self {
            terminal,
            state,
            runtime,
            agent_rx,
            agent_tx,
            session_title_rx,
            session_title_tx,
            title_requests_started: HashSet::new(),
            approval_broker,
            current_task_id: 0,
            health: LoopHealth::default(),
            agent_state_label: String::new(),
            agent_state_label_source: None,
            persistence: persistence::PersistenceWorker::disabled(),
        })
    }

    /// If the agent is working (not Idle, not WaitingApproval) and no event
    /// has arrived for `AGENTE_STUCK_SECS` (default 300), cancel and reset UI.
    pub(super) fn maybe_force_reset_stuck_agent(&mut self) {
        if self.state.agent.is_idle() || self.state.agent.is_waiting_approval() {
            return;
        }
        let Some(secs) = self.state.agent.secs_since_last_agent_event() else {
            return;
        };
        let timeout = stuck_timeout_secs();
        let soft = stuck_soft_warn_secs();
        if secs >= soft && secs < timeout {
            // Soft signal only — do not reset yet (user may still be waiting on a slow model).
            tracing::debug!(secs, soft, "Agent quiet; soft stuck threshold passed");
            return;
        }
        if secs < timeout {
            return;
        }
        tracing::warn!(
            secs,
            timeout,
            state = ?self.state.agent.state,
            "Agent stuck (no events); force-resetting to Idle"
        );
        self.state.add_system_message(
            "Operation timed out (no activity). The agent was reset — try again or /stop."
                .to_string(),
        );
        self.state.cancel_tx.abort();
        self.current_task_id = self.current_task_id.wrapping_add(1);
        self.state.agent.force_reset_to_idle();
        self.state.ui.needs_render = true;
    }

    /// Recompute the cached agent-state label only when the state changed.
    fn refresh_agent_state_label(&mut self) {
        if self.agent_state_label_source.as_ref() != Some(&self.state.agent.state) {
            self.agent_state_label = format!("{:?}", self.state.agent.state);
            self.agent_state_label_source = Some(self.state.agent.state.clone());
        }
    }

    /// Min gap between full-frame paints while streaming (ms). User input still
    /// forces a paint via `needs_render`. Keeps Esc/keys responsive under load.
    /// ~30 fps: smooth now that renders materialize only the visible viewport.
    const STREAM_PAINT_MIN_MS: u128 = 33;

    /// One main-loop iteration: drain → **input first** → optional paint.
    /// Input is polled before paint so a slow chat redraw cannot freeze the UI.
    pub(crate) fn tick_once(&mut self) -> anyhow::Result<()> {
        let drain_start = std::time::Instant::now();
        let agent_backlog = self.process_agent_events();
        let title_backlog = self.process_session_title_results();
        self.maybe_force_reset_stuck_agent();
        let drain_elapsed = drain_start.elapsed();

        let anim_active = self.state.has_active_animation();
        let is_streaming = self.state.agent.wants_stream_paint();
        // The approval ◆ pulse needs ticks even with empty stream buffers.
        let waiting_approval = matches!(
            self.state.agent.state,
            agente_core::types::AgentState::WaitingApproval
        );

        // Poll input BEFORE paint — critical for "UI freezes all" during stream.
        // Tick demand: streaming 8ms (Fast), approval/fade/toast 16ms,
        // otherwise a relaxed poll keeps the loop asleep.
        let poll_timeout = if agent_backlog || title_backlog || self.state.ui.needs_render {
            Duration::ZERO
        } else if is_streaming {
            Duration::from_millis(8)
        } else if anim_active || waiting_approval {
            Duration::from_millis(16)
        } else {
            Duration::from_millis(100)
        };
        // Wake at the next paint deadline, rather than overshooting it by a
        // whole input-poll interval. Rendering time counts toward the frame.
        let poll_timeout = if is_streaming || anim_active || waiting_approval {
            poll_timeout.min(Self::paint_delay(
                self.state.ui.last_stream_paint_at.map(|at| at.elapsed()),
                Self::STREAM_PAINT_MIN_MS as u64,
            ))
        } else {
            poll_timeout
        };
        self.handle_events_with_timeout(poll_timeout)?;

        // Re-check after input (Esc / scroll may have changed state).
        let anim_active = self.state.has_active_animation();
        let is_streaming = self.state.agent.wants_stream_paint();
        let waiting_approval = matches!(
            self.state.agent.state,
            agente_core::types::AgentState::WaitingApproval
        );
        let user_wants_paint = self.state.ui.needs_render;
        // Throttle stream/anim paints (~30fps) so Esc always gets a chance.
        let stream_paint_due = (is_streaming || anim_active || waiting_approval)
            && self
                .state
                .ui
                .last_stream_paint_at
                .map(|t| t.elapsed().as_millis() >= Self::STREAM_PAINT_MIN_MS)
                .unwrap_or(true);
        let should_render = user_wants_paint || stream_paint_due;

        let mut paint_elapsed = Duration::ZERO;
        if should_render {
            self.state.ui.needs_render = false;

            let paint_start = std::time::Instant::now();
            {
                let state = &mut self.state;
                state.tick_fps();
                let _synchronized_update = SynchronizedUpdateGuard::begin();
                render::render_app_safe(&mut self.terminal, state);
            }
            paint_elapsed = paint_start.elapsed();
            if is_streaming || anim_active || waiting_approval {
                self.state.ui.last_stream_paint_at = Some(paint_start);
            }
        }

        self.refresh_agent_state_label();
        self.health.on_tick(
            drain_elapsed,
            paint_elapsed,
            agent_backlog || title_backlog,
            &self.agent_state_label,
        );
        Ok(())
    }

    fn paint_delay(elapsed: Option<Duration>, interval_ms: u64) -> Duration {
        elapsed.map_or(Duration::ZERO, |elapsed| {
            Duration::from_millis(interval_ms).saturating_sub(elapsed)
        })
    }

    /// Inject an agent event (tests). Uses `task_id = 0` so the drain always
    /// accepts it (same as discovery events).
    #[cfg(test)]
    pub(crate) fn inject_agent_event(&self, event: agente_core::agent::AgentEvent) {
        let _ = self.agent_tx.send(AgentTaskEvent { task_id: 0, event });
    }

    /// Drain agent events + stuck-guard only (no terminal paint / input poll).
    /// Used by freeze_harness so CI does not depend on a real TTY.
    #[cfg(test)]
    pub(crate) fn tick_drain_only(&mut self) -> std::time::Duration {
        let drain_start = std::time::Instant::now();
        let agent_backlog = self.process_agent_events();
        let title_backlog = self.process_session_title_results();
        self.maybe_force_reset_stuck_agent();
        let drain_elapsed = drain_start.elapsed();
        self.refresh_agent_state_label();
        self.health.on_tick(
            drain_elapsed,
            Duration::ZERO,
            agent_backlog || title_backlog,
            &self.agent_state_label,
        );
        drain_elapsed
    }

    pub fn run(&mut self) -> anyhow::Result<()> {
        let _guard = self.runtime.enter();
        while !self.state.ui.should_quit {
            self.tick_once()?;
        }
        self.flush_state_to_disk();
        self.persistence.shutdown();
        self.restore_terminal()?;
        Ok(())
    }
}

impl Drop for App {
    fn drop(&mut self) {
        // Best-effort flush before terminal teardown so config survives a panic.
        self.flush_state_to_disk();
        self.persistence.shutdown();
        let _ = self.restore_terminal();
    }
}

#[cfg(test)]
mod stuck_guard_tests {
    use agente_core::types::AgentState;

    #[test]
    fn paint_deadlines_include_render_time_without_catch_up_bursts() {
        use std::time::Duration;
        for render_ms in [0, 4, 12, 25, 33, 80] {
            let elapsed = Duration::from_millis(render_ms);
            let wait = super::App::paint_delay(Some(elapsed), 33);
            assert_eq!(elapsed + wait, Duration::from_millis(render_ms.max(33)));
        }
        assert_eq!(super::App::paint_delay(None, 33), Duration::ZERO);
    }

    #[test]
    fn force_reset_clears_stream_buffers_and_idles() {
        let mut agent = crate::state::AgentRuntimeState {
            state: AgentState::Executing,
            streaming_text: "partial".into(),
            reasoning_text: "think".into(),
            ..Default::default()
        };
        agent.thinking_start_time = Some(chrono::Utc::now());
        agent.mark_agent_event();
        agent.force_reset_to_idle();
        assert!(agent.is_idle());
        assert!(agent.streaming_text.is_empty());
        assert!(agent.reasoning_text.is_empty());
        assert!(agent.thinking_start_time.is_none());
        assert!(agent.last_agent_event_at.is_none());
        assert!(!agent.wants_stream_paint());
    }

    #[test]
    fn wants_stream_paint_false_when_idle_with_empty_buffers() {
        let agent = crate::state::AgentRuntimeState::default();
        assert!(agent.is_idle());
        assert!(!agent.wants_stream_paint());
    }

    #[test]
    fn wants_stream_paint_true_with_leftover_streaming_text() {
        // Idle state but uncleared buffer — this is the thrash bug.
        let mut agent = crate::state::AgentRuntimeState {
            streaming_text: "still here".into(),
            ..Default::default()
        };
        assert!(agent.wants_stream_paint());
        agent.clear_stream_buffers();
        assert!(!agent.wants_stream_paint());
    }

    #[test]
    fn mark_agent_event_sets_clock() {
        let mut agent = crate::state::AgentRuntimeState::default();
        assert!(agent.secs_since_last_agent_event().is_none());
        agent.mark_agent_event();
        assert_eq!(agent.secs_since_last_agent_event(), Some(0));
    }
}
