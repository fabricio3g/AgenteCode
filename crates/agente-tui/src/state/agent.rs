//! Agent-related state management
//!
//! This module contains state related to the AI agent's operation:
//! - AgentMode (Plan/Build)
//! - AgentState (Idle, Planning, Executing, etc.)
//! - Streaming state (response text, reasoning)
//! - Approval state
//! - Permission engine

use std::collections::{HashMap, VecDeque};

use agente_core::agent::ApprovalSource;
use agente_core::context::estimate_message_tokens;
use agente_core::permissions::{shared_permission_engine, SharedPermissionEngine};
use agente_core::thinking::THINKING_OFF;
use agente_core::types::{AgentMode, AgentState, ApprovalRequest, Message};

/// One queued approval: the request plus the origin (parent vs subagent) so
/// concurrent parent/child approvals never collide in the UI.
#[derive(Debug, Clone)]
pub struct PendingApproval {
    pub source: ApprovalSource,
    pub request: ApprovalRequest,
}

/// FIFO queue of approvals awaiting a user response, in the order they were
/// published by the agent loop(s). Answering one pops only that entry and
/// immediately surfaces the next.
#[derive(Debug, Clone, Default)]
pub struct ApprovalQueue {
    entries: VecDeque<PendingApproval>,
}

impl ApprovalQueue {
    pub fn push(&mut self, entry: PendingApproval) {
        self.entries.push_back(entry);
    }

    /// The approval currently shown (the oldest unanswered request).
    pub fn current(&self) -> Option<&PendingApproval> {
        self.entries.front()
    }

    /// Pop the currently shown approval, revealing the next in line.
    pub fn pop_front(&mut self) -> Option<PendingApproval> {
        self.entries.pop_front()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Drop every queued approval that fails `keep` (e.g. a terminal event
    /// clearing requests from a specific origin).
    pub fn retain(&mut self, keep: impl FnMut(&PendingApproval) -> bool) {
        self.entries.retain(keep);
    }
}

/// One nested tool row inside a subagent card.
#[derive(Debug, Clone, Default)]
pub struct SubagentToolRow {
    pub call_id: String,
    pub name: String,
    pub args: String,
    /// Retained output, including chunks received before completion.
    pub result: Option<String>,
    pub is_error: bool,
    pub finished: bool,
}

/// The three Shift+Tab modes. `Auto` is Build with every tool call
/// auto-approved: no approval cards, the agent just works.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkMode {
    Plan,
    Build,
    Auto,
}

impl WorkMode {
    /// Parse a saved `default_mode`; anything unknown is Build.
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some(v) if v.eq_ignore_ascii_case("plan") => Self::Plan,
            Some(v) if v.eq_ignore_ascii_case("auto") => Self::Auto,
            _ => Self::Build,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Build => "build",
            Self::Auto => "auto",
        }
    }

    /// Shift+Tab order: plan → build → auto → plan.
    pub fn next(self) -> Self {
        match self {
            Self::Plan => Self::Build,
            Self::Build => Self::Auto,
            Self::Auto => Self::Plan,
        }
    }

    pub fn agent_mode(self) -> AgentMode {
        match self {
            Self::Plan => AgentMode::Plan,
            Self::Build | Self::Auto => AgentMode::Build,
        }
    }

    /// Accent: plan amber, build green, auto the brand accent.
    pub fn color(self) -> ratatui::style::Color {
        match self {
            Self::Plan => crate::style::WARNING(),
            Self::Build => crate::style::SUCCESS(),
            Self::Auto => crate::style::PRIMARY(),
        }
    }
}

/// A message waiting for the running turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedMessage {
    /// What the chat bubble shows (`/skill-name request`).
    pub display: String,
    /// What the model receives (the skill block + request).
    pub prompt: String,
    /// Media sent with it.
    pub attachments: Vec<agente_core::media::Attachment>,
    /// Handed to the running turn; shown as "sending…" until the loop
    /// takes it.
    pub sending: bool,
}

impl QueuedMessage {
    pub fn new(text: impl Into<String>) -> Self {
        let text = text.into();
        Self::with_prompt(text.clone(), text)
    }

    pub fn with_prompt(display: impl Into<String>, prompt: impl Into<String>) -> Self {
        Self {
            display: display.into(),
            prompt: prompt.into(),
            attachments: Vec::new(),
            sending: false,
        }
    }

    pub fn with_attachments(mut self, attachments: Vec<agente_core::media::Attachment>) -> Self {
        self.attachments = attachments;
        self
    }

    /// The conversation message the model receives.
    pub fn to_message(&self) -> Message {
        let mut message = Message::user(self.prompt.clone());
        message.attachments = self.attachments.clone();
        message
    }
}

/// The context budget the loop last reported (`AgentEvent::ContextBudget`).
///
/// One source for the status meter: `used` over `room`, where `room` is the
/// window minus the tool schemas, the tokenizer gap and the reply reserve —
/// the same room the compaction gate compares against. The meter used to show
/// a provider prompt over the bare window, so its amber line and the
/// compaction line never met.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ContextState {
    pub used: u32,
    pub room: u32,
    pub window: u32,
    pub tool_tokens: u32,
    /// What the provider counted beyond our estimate last time. Carried into
    /// the next turn so its first request is gated on a calibrated number.
    pub gap: u32,
    /// `used` came from the provider, not our estimate.
    pub measured: bool,
}

impl ContextState {
    /// The loop reported a budget (a turn has run against this model).
    pub fn is_known(&self) -> bool {
        self.room > 0
    }
}

/// What the session's model calls cost, summed per call from
/// `AgentEvent::CallUsage` (parent and subagents alike).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Spend {
    /// USD over the calls that had a price.
    pub cost_usd: f64,
    /// Calls with a price (provider-reported or catalog).
    pub priced_calls: u32,
    /// Priced calls whose price is our catalog estimate, not the provider's
    /// own charge.
    pub estimated_calls: u32,
    /// Calls with no price at all (unknown model pricing).
    pub unpriced_calls: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

impl Spend {
    pub fn record(
        &mut self,
        input: u32,
        output: u32,
        cache_read: u32,
        cache_write: u32,
        cost_usd: Option<f64>,
    ) {
        self.input_tokens += u64::from(input);
        self.output_tokens += u64::from(output);
        self.cache_read_tokens += u64::from(cache_read);
        self.cache_write_tokens += u64::from(cache_write);
        match cost_usd {
            Some(cost) => {
                self.cost_usd += cost;
                self.priced_calls += 1;
            }
            None => self.unpriced_calls += 1,
        }
    }

    /// Share of prompt tokens served from the provider cache — only once
    /// the provider has reported any cache activity. A provider that never
    /// reports cache fields has an unknown rate, not a 0% one.
    pub fn cache_hit_rate(&self) -> Option<f64> {
        let cached = self.cache_read_tokens + self.cache_write_tokens;
        let prompt = self.input_tokens + cached;
        (prompt > 0 && cached > 0).then(|| self.cache_read_tokens as f64 / prompt as f64)
    }

    /// `$0.042` once any call had a price: `~` when part of it is our
    /// catalog estimate, `+` when some calls could not be priced, `free`
    /// when the provider charged nothing.
    pub fn cost_label(&self) -> Option<String> {
        if self.priced_calls == 0 {
            return None;
        }
        let mut label = if self.cost_usd <= 0.0 {
            "free".to_string()
        } else if self.estimated_calls > 0 {
            format!("~{}", format_usd(self.cost_usd))
        } else {
            format_usd(self.cost_usd)
        };
        if self.unpriced_calls > 0 {
            label.push('+');
        }
        Some(label)
    }

    /// Status label: `$0.042 · 82% cached`. `None` before the first call.
    /// The rate is floored, so `100%` means every prompt token was cached.
    pub fn label(&self) -> Option<String> {
        let cost = self.cost_label();
        let cache = self
            .cache_hit_rate()
            .map(|rate| format!("{:.0}% cached", (rate * 100.0).floor()));
        match (cost, cache) {
            (Some(cost), Some(cache)) => Some(format!("{cost} · {cache}")),
            (Some(one), None) | (None, Some(one)) => Some(one),
            (None, None) => None,
        }
    }
}

/// `$0.004` below a dollar, `$12.30` above, `<$0.001` under a tenth of a
/// cent. The same rule as the desktop's `spendCostLabel` — one number, one
/// rendering per surface, and the two surfaces agree.
pub fn format_usd(usd: f64) -> String {
    if usd > 0.0 && usd < 0.001 {
        "<$0.001".to_string()
    } else if usd < 1.0 {
        format!("${usd:.3}")
    } else {
        format!("${usd:.2}")
    }
}

/// Bounded live output for one in-flight tool call. Chat history currently
/// stores tool calls and results as separate persisted entries, so this keeps
/// transient progress keyed by the provider's stable call id until the result
/// arrives.
#[derive(Debug, Clone)]
pub struct LiveToolCall {
    pub name: String,
    pub args: String,
    /// The newest output (bounded; the oldest bytes drop first).
    pub output: String,
    pub direct: bool,
    /// When the call started, for the elapsed readout.
    pub started: std::time::Instant,
}

impl LiveToolCall {
    /// `6m03s` / `42s` since the call started.
    pub fn elapsed_label(&self) -> String {
        crate::widgets::format_elapsed_secs(self.started.elapsed().as_secs())
    }

    /// The shell command, when this is a shell call.
    pub fn command(&self) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(&self.args)
            .ok()?
            .get("command")?
            .as_str()
            .map(str::to_string)
    }
}

const MAX_LIVE_TOOL_OUTPUT_BYTES: usize = 32 * 1024;

/// A provider request that failed transiently and is being retried.
#[derive(Debug, Clone, Copy)]
pub struct RetryStatus {
    pub attempt: u32,
    pub max_attempts: u32,
}

/// Live UI state for a spawned subagent, fed by `AgentEvent::Subagent*`.
#[derive(Debug, Clone, Default)]
pub struct SubagentUiState {
    pub subagent_type: String,
    pub description: String,
    /// "pending" | "running" | "completed" | "failed" | "cancelled"
    pub status: String,
    /// Live streamed text from the child (kept out of the persisted entry).
    pub streaming_text: String,
    pub tool_rows: Vec<SubagentToolRow>,
    pub preparing_tool: Option<String>,
    pub summary: Option<String>,
    /// Child model label (`scout · qwen3-coder:free`, or the bare model),
    /// for the card and detail header.
    pub model: String,
    /// Wall-clock start (`SubagentStarted`), for the live elapsed readout.
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Set when the child reaches a terminal status.
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Isolated checkout when the child runs in a worktree.
    pub worktree: Option<agente_core::subagent::WorktreeInfo>,
    /// What this child's model calls cost (its own nested children included).
    pub spend: Spend,
    /// The swarm card this child works, when a board started it.
    pub swarm: Option<SwarmLane>,
}

/// A subagent's place in a swarm, read from the board: its card, whom its
/// result feeds, and the newest finding it posted or was sent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SwarmLane {
    pub card_id: String,
    pub title: String,
    pub role: String,
    /// Cards that wait on this one.
    pub feeds: Vec<String>,
    /// `c1 → c2  text` — the newest finding touching this card.
    pub latest: Option<String>,
}

impl SwarmLane {
    /// The lane for `child_id` on `board`, if a card of it is that child's.
    pub fn of(board: &agente_core::swarm::Board, child_id: &str) -> Option<Self> {
        let card = board
            .cards
            .iter()
            .find(|card| card.child_id.as_deref() == Some(child_id))?;
        let feeds = board
            .cards
            .iter()
            .filter(|other| other.depends_on.iter().any(|dep| dep == &card.id))
            .map(|other| other.id.clone())
            .collect();
        let latest = board
            .findings
            .iter()
            .rev()
            .find(|finding| finding.touches(&card.id))
            .map(|finding| format!("{}  {}", finding.route(), finding.text));
        Some(Self {
            card_id: card.id.clone(),
            title: card.title.clone(),
            role: card.role.clone(),
            feeds,
            latest,
        })
    }
}

impl SubagentUiState {
    /// True while the child is queued or running. Queued children used to fall
    /// into the finished branch, so their card read "Finished" before starting.
    pub fn is_running(&self) -> bool {
        crate::widgets::SubagentStatusKind::from_status(&self.status).is_live()
    }

    pub fn status_kind(&self) -> crate::widgets::SubagentStatusKind {
        crate::widgets::SubagentStatusKind::from_status(&self.status)
    }

    /// Elapsed wall clock for the card/detail header, live while running.
    pub fn elapsed_ms(&self) -> Option<f64> {
        let start = self.started_at?;
        let end = self.finished_at.unwrap_or_else(chrono::Utc::now);
        Some((end - start).num_milliseconds().max(0) as f64)
    }
}

/// Agent runtime state
#[derive(Debug)]
pub struct AgentRuntimeState {
    /// Current agent mode (Plan or Build)
    pub mode: AgentMode,
    /// Build with every tool call auto-approved (`WorkMode::Auto`). The
    /// permission engine only knows Plan/Build; this rides on top.
    pub auto_mode: bool,
    /// Mode that was active when the current turn started (preserved for the whole turn)
    pub current_turn_mode: AgentMode,
    /// Current agent state (Idle, Planning, Executing, etc.)
    pub state: AgentState,
    /// Currently streaming response text
    pub streaming_text: String,
    /// Agent reasoning/thinking text
    pub reasoning_text: String,
    /// Tool whose arguments are currently being generated.
    pub preparing_tool: Option<String>,
    pub turn_started_at: Option<std::time::Instant>,
    /// Current thinking level string from catalog (`off`, `high`, `max`, …).
    pub thinking_level: String,
    /// Queued tool-approval requests in publish order. The front entry is the
    /// one currently shown; answering it pops only that entry and surfaces the
    /// next. Entries carry the origin (parent vs subagent) so concurrent
    /// requests never overwrite each other.
    pub approval_queue: ApprovalQueue,
    /// User's persistent preference (saved to disk).
    pub auto_approve_persistent: bool,
    /// Turn-scoped override set by the approval popup's "Approve all".
    /// Reset to `auto_approve_persistent` at the start of every turn.
    pub auto_approve_runtime: bool,
    /// What the loop last reported about the context: the same numbers the
    /// compaction gate uses. The status meter draws this and nothing else.
    pub context: ContextState,
    /// Current context size in tokens (estimated via `estimate_message_tokens`
    /// against `state.session.conversation`). Updated on `Done`/`Cancelled`/
    /// `ContextCompacted` events and after `/compact` so the status bar always
    /// reflects the *real* context, not the historical cumulative sum.
    pub total_tokens: u32,
    /// `total_tokens` came from the provider (the last request's whole
    /// prompt) rather than the local characters÷4 estimate, which misses the
    /// tool schemas. The meter marks estimates with `~`.
    pub context_measured: bool,
    /// Most recent turn's prompt tokens (used for cost). May include cached
    /// tokens reported by the provider.
    pub last_turn_prompt_tokens: u32,
    /// Most recent turn's completion tokens.
    pub last_turn_completion_tokens: u32,
    /// Tokens read from the provider's prompt cache on the most recent turn.
    pub last_turn_cache_read_tokens: u32,
    /// Tokens written to the provider's prompt cache on the most recent turn.
    pub last_turn_cache_creation_tokens: u32,
    /// Session spend summed over every model call (subagents included).
    pub spend: Spend,
    /// Compaction in flight: `Some(true)` while an LLM summary is written,
    /// `Some(false)` while trimming. Cleared by the next loop event.
    pub compacting: Option<bool>,
    /// Set while the agent loop backs off and retries a transient provider
    /// error (surfaced on the status bar). Cleared on the next stream event.
    pub retry_status: Option<RetryStatus>,
    /// Thinking/reasoning expanded in UI
    pub thinking_expanded: bool,
    /// When thinking started
    pub thinking_start_time: Option<chrono::DateTime<chrono::Utc>>,
    /// Last time we received *any* agent-task event for the live turn.
    /// Used by the stuck-guard (independent of thinking_start_time) so a
    /// silent Executing/StreamingResponse cannot hang the UI forever.
    pub last_agent_event_at: Option<std::time::Instant>,
    /// When the current tool call started (for result timing)
    pub current_tool_start: Option<std::time::Instant>,
    /// Last response duration in milliseconds
    pub last_response_duration: Option<f64>,
    /// Shared permission engine handle. The TUI keeps this live so mid-turn
    /// toggles propagate to the running chat task.
    pub shared_permission_engine: SharedPermissionEngine,
    /// Messages queued while the agent is working. They run after the turn,
    /// or sooner when the user sends them now (`send_queue_now`).
    pub message_queue: Vec<QueuedMessage>,
    /// Shared with the running turn: messages sent now wait here until the
    /// loop takes them at its next step.
    pub user_inbox: agente_core::agent::UserInbox,
    /// Steering commands that should take effect as soon as possible
    /// (e.g. /stop, /cancel, !bash commands)
    pub steering_queue: Vec<String>,
    /// Live UI state of spawned subagents, keyed by subagent id.
    pub subagents: HashMap<String, SubagentUiState>,
    /// The session's swarm board (`/board`), kept current by
    /// `AgentEvent::BoardChanged` and read from the store on `/swarm`.
    pub board: Option<agente_core::swarm::Board>,
    /// Transient output for in-flight parent/direct tool calls, keyed by call id.
    pub live_tool_calls: HashMap<String, LiveToolCall>,
    /// Bumped whenever the live-tool-call set gains/loses a member. The chat
    /// frame snapshot keys on it: a tool call becoming live/finished changes
    /// whether its history entry is skipped, without necessarily growing the
    /// history (e.g. a cancel with no partial text).
    pub live_tools_epoch: u64,
    /// The current chat/direct-command task is owned by the TUI state. It is
    /// aborted on a force interrupt or once a terminal event is processed.
    pub task_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Default for AgentRuntimeState {
    fn default() -> Self {
        Self {
            mode: AgentMode::Build,
            current_turn_mode: AgentMode::Build,
            state: AgentState::Idle,
            streaming_text: String::new(),
            reasoning_text: String::new(),
            preparing_tool: None,
            turn_started_at: None,
            thinking_level: agente_core::thinking::THINKING_AUTO.to_string(),
            approval_queue: ApprovalQueue::default(),
            auto_approve_persistent: false,
            auto_approve_runtime: false,
            auto_mode: false,
            context: ContextState::default(),
            total_tokens: 0,
            context_measured: false,
            last_turn_prompt_tokens: 0,
            last_turn_completion_tokens: 0,
            last_turn_cache_read_tokens: 0,
            spend: Spend::default(),
            compacting: None,
            last_turn_cache_creation_tokens: 0,
            retry_status: None,
            thinking_expanded: false,
            thinking_start_time: None,
            last_agent_event_at: None,
            current_tool_start: None,
            last_response_duration: None,
            shared_permission_engine: shared_permission_engine(AgentMode::Build),
            message_queue: Vec::new(),
            user_inbox: agente_core::agent::UserInbox::default(),
            steering_queue: Vec::new(),
            subagents: HashMap::new(),
            board: None,
            live_tool_calls: HashMap::new(),
            live_tools_epoch: 0,
            task_handle: None,
        }
    }
}

impl AgentRuntimeState {
    pub fn begin_turn_progress(&mut self) {
        self.preparing_tool = None;
        self.turn_started_at = Some(std::time::Instant::now());
    }

    /// Set the agent mode and update the permission engine.
    pub fn set_mode(&mut self, mode: AgentMode) {
        self.mode = mode;
        if let Ok(mut engine) = self.shared_permission_engine.write() {
            engine.set_mode(mode);
        }
    }

    /// True while the chat transcript is drawing its own live thinking block.
    ///
    /// The activity strip and the chat block both used to render the word
    /// "Thinking…" at the same time, one directly above the other. This lets
    /// the strip defer to the richer chat block instead of echoing it.
    pub fn chat_shows_thinking(&self, thinking_off: bool) -> bool {
        let running = matches!(
            self.state,
            agente_core::types::AgentState::Planning
                | agente_core::types::AgentState::StreamingResponse
                | agente_core::types::AgentState::Executing
        );
        !self.reasoning_text.is_empty()
            || (running
                && self.thinking_start_time.is_some()
                && !thinking_off
                && self.streaming_text.is_empty())
    }

    /// Check if agent is idle.
    pub fn is_idle(&self) -> bool {
        matches!(self.state, AgentState::Idle)
    }

    /// Check if agent is waiting for approval
    pub fn is_waiting_approval(&self) -> bool {
        matches!(self.state, AgentState::WaitingApproval)
    }

    /// Queue an approval request with its origin. Keeps the UI state in
    /// `WaitingApproval` as long as at least one request is outstanding.
    pub fn enqueue_approval(&mut self, source: ApprovalSource, request: ApprovalRequest) {
        self.approval_queue
            .push(PendingApproval { source, request });
        self.state = AgentState::WaitingApproval;
    }

    /// The approval currently shown, if any.
    pub fn current_approval(&self) -> Option<&ApprovalRequest> {
        self.approval_queue.current().map(|e| &e.request)
    }

    /// Origin of the currently shown approval.
    pub fn current_approval_source(&self) -> Option<&ApprovalSource> {
        self.approval_queue.current().map(|e| &e.source)
    }

    /// Pop the currently shown approval (the user answered or it was resolved
    /// out-of-band). The next queued request becomes visible immediately.
    pub fn pop_approval(&mut self) -> Option<PendingApproval> {
        let popped = self.approval_queue.pop_front();
        self.refresh_approval_state();
        popped
    }

    /// Remove every queued approval whose origin is `source` (used when that
    /// agent terminates). If the shown request is removed, the next one takes
    /// its place. Returns the removed request IDs so the caller can cancel
    /// only those entries in the shared broker.
    pub fn remove_approvals_from(&mut self, source: &ApprovalSource) -> Vec<String> {
        let mut removed = Vec::new();
        self.approval_queue.retain(|entry| {
            if &entry.source == source {
                removed.push(entry.request.request_id.clone());
                false
            } else {
                true
            }
        });
        self.refresh_approval_state();
        removed
    }

    pub fn has_pending_approval(&self) -> bool {
        !self.approval_queue.is_empty()
    }

    pub fn clear_approvals(&mut self) {
        self.approval_queue.clear();
        self.refresh_approval_state();
    }

    fn refresh_approval_state(&mut self) {
        self.state = if self.approval_queue.is_empty() {
            if self.task_handle.is_some() {
                AgentState::Executing
            } else {
                AgentState::Idle
            }
        } else {
            AgentState::WaitingApproval
        };
    }

    /// Settle the phase after a terminal event: release the task resource,
    /// then recompute. Aborting *before* the recompute keeps the invariant
    /// "no parent task + no approvals => Idle" true; removing approvals while
    /// a dead handle was still installed left the turn reading Executing.
    /// Approvals left by children keep the phase at WaitingApproval.
    pub fn end_parent_turn(&mut self) {
        self.abort_task();
        self.refresh_approval_state();
    }

    /// Stamp the last-event clock (call on every inbound AgentTaskEvent and at
    /// turn start). Keeps the stuck-guard from firing while the agent is live.
    pub fn mark_agent_event(&mut self) {
        self.last_agent_event_at = Some(std::time::Instant::now());
    }

    /// True when the run loop should paint at stream framerate (~60fps).
    /// Centralized so Done/Cancelled/Error paths that clear buffers actually
    /// stop the thrash paint loop.
    pub fn wants_stream_paint(&self) -> bool {
        let thinking_anim = self.thinking_start_time.is_some()
            && matches!(
                self.state,
                AgentState::StreamingResponse | AgentState::Planning | AgentState::Executing
            )
            && self.thinking_level != THINKING_OFF;
        matches!(self.state, AgentState::StreamingResponse)
            || !self.streaming_text.is_empty()
            || !self.reasoning_text.is_empty()
            || !self.live_tool_calls.is_empty()
            || thinking_anim
    }

    /// Clear live stream buffers and turn timers after a terminal event or
    /// force-reset. Does **not** change `state` — callers set Idle themselves.
    pub fn clear_stream_buffers(&mut self) {
        self.abort_task();
        self.preparing_tool = None;
        self.turn_started_at = None;
        self.streaming_text.clear();
        self.reasoning_text.clear();
        self.thinking_start_time = None;
        self.thinking_expanded = false;
        self.retry_status = None;
        self.current_tool_start = None;
        self.last_agent_event_at = None;
        if !self.live_tool_calls.is_empty() {
            self.live_tools_epoch = self.live_tools_epoch.wrapping_add(1);
        }
        self.live_tool_calls.clear();
    }

    /// Take ownership of the current task handle and abort it. This is used by
    /// force reset and by the next turn before replacing a stale handle.
    pub fn abort_task(&mut self) {
        if let Some(handle) = self.task_handle.take() {
            handle.abort();
        }
    }

    pub fn start_live_tool(&mut self, id: String, name: String, args: String, direct: bool) {
        self.live_tool_calls.insert(
            id,
            LiveToolCall {
                name,
                args,
                output: String::new(),
                direct,
                started: std::time::Instant::now(),
            },
        );
        self.live_tools_epoch = self.live_tools_epoch.wrapping_add(1);
    }

    pub fn append_live_tool_output(&mut self, id: &str, chunk: &str) {
        let Some(call) = self.live_tool_calls.get_mut(id) else {
            return;
        };
        // Keep the tail: a long install's latest lines matter, its first
        // 32 KB do not. Drop from the front on a char boundary.
        call.output.push_str(chunk);
        if call.output.len() > MAX_LIVE_TOOL_OUTPUT_BYTES {
            let mut cut = call.output.len() - MAX_LIVE_TOOL_OUTPUT_BYTES;
            while !call.output.is_char_boundary(cut) {
                cut += 1;
            }
            call.output.drain(..cut);
        }
    }

    pub fn finish_live_tool(&mut self, id: &str) -> Option<LiveToolCall> {
        let finished = self.live_tool_calls.remove(id);
        if finished.is_some() {
            self.live_tools_epoch = self.live_tools_epoch.wrapping_add(1);
        }
        finished
    }

    /// Force the agent UI into Idle after a stuck timeout: drop buffers and
    /// pending approval chrome.
    pub fn force_reset_to_idle(&mut self) {
        self.state = AgentState::Idle;
        self.approval_queue.clear();
        self.reclaim_inbox();
        self.steering_queue.clear();
        self.clear_stream_buffers();
    }

    /// Seconds since the last agent event, if any stamp exists.
    pub fn secs_since_last_agent_event(&self) -> Option<u64> {
        self.last_agent_event_at.map(|t| t.elapsed().as_secs())
    }

    /// Recompute `total_tokens` from the current LLM transcript.
    ///
    /// Call this whenever the conversation is rewritten (auto-compact, manual
    /// `/compact`, `Done`/`Cancelled`/`ContextCompacted` events) so the status
    /// bar's `used` and `context_pct` reflect the *real* conversation size —
    /// not a stale cumulative sum.
    pub fn recompute_total_from_conversation(&mut self, conversation: &[Message]) {
        self.total_tokens = estimate_message_tokens(conversation) as u32;
        self.context_measured = false;
    }

    /// Adopt the budget the loop sent before a request: the transcript size,
    /// the room it is measured against, and whether the number is measured.
    pub fn record_budget(
        &mut self,
        used: u32,
        room: u32,
        window: u32,
        tool_tokens: u32,
        gap: u32,
        measured: bool,
    ) {
        self.context = ContextState {
            used,
            room,
            window,
            tool_tokens,
            gap,
            measured,
        };
        self.total_tokens = used;
        self.context_measured = measured;
    }

    /// Adopt the provider's size of the last request's whole prompt.
    pub fn record_context(&mut self, context_tokens: u32) {
        if context_tokens > 0 {
            self.total_tokens = context_tokens;
            self.context_measured = true;
        }
    }

    /// Context once a turn ends: the last request's measured prompt plus the
    /// reply it produced (both are in the next request); the estimate only
    /// when the provider reported nothing.
    pub fn settle_context_after_turn(&mut self, conversation: &[Message]) {
        if self.context_measured {
            self.total_tokens = self
                .total_tokens
                .saturating_add(self.last_turn_completion_tokens);
        } else {
            self.recompute_total_from_conversation(conversation);
        }
    }

    /// Queue a message for after the running turn (no chat bubble yet —
    /// it appears when it is actually sent).
    pub fn queue_message(&mut self, message: QueuedMessage) {
        self.message_queue.push(message);
    }

    /// Hand every waiting queued message to the running turn, which takes
    /// them at its next step. Returns how many were sent.
    pub fn send_queue_now(&mut self) -> usize {
        let mut inbox = self.user_inbox.lock();
        let mut sent = 0;
        for message in self.message_queue.iter_mut().filter(|m| !m.sending) {
            message.sending = true;
            inbox.push(message.to_message());
            sent += 1;
        }
        drop(inbox);
        if sent > 0 {
            self.user_inbox.interrupt_thinking();
        }
        sent
    }

    /// The loop took `count` sent messages: drop them from the queue and
    /// return them for the chat, in order.
    pub fn take_injected(&mut self, count: usize) -> Vec<QueuedMessage> {
        let mut taken = Vec::new();
        self.message_queue.retain(|message| {
            if message.sending && taken.len() < count {
                taken.push(message.clone());
                false
            } else {
                true
            }
        });
        taken
    }

    /// The turn ended: anything still waiting in the inbox goes back to
    /// being an ordinary queued message (it runs as the next turn).
    pub fn reclaim_inbox(&mut self) {
        self.user_inbox.lock().clear();
        for message in &mut self.message_queue {
            message.sending = false;
        }
    }

    /// Up on an empty composer: the last not-yet-sent message comes back
    /// for editing.
    pub fn pop_unsent(&mut self) -> Option<QueuedMessage> {
        let index = self.message_queue.iter().rposition(|m| !m.sending)?;
        Some(self.message_queue.remove(index))
    }

    /// Whether Enter on an empty composer would send something now.
    pub fn has_unsent_queue(&self) -> bool {
        self.message_queue.iter().any(|m| !m.sending)
    }

    /// Record the per-turn usage from the provider's `StreamEvent::Done`.
    /// The TUI uses this for cost (prompt × input price + completion × output
    /// price) on the status bar.
    pub fn record_turn_usage(
        &mut self,
        prompt_tokens: u32,
        completion_tokens: u32,
        cache_read_tokens: u32,
        cache_creation_tokens: u32,
    ) {
        self.last_turn_prompt_tokens = prompt_tokens;
        self.last_turn_completion_tokens = completion_tokens;
        self.last_turn_cache_read_tokens = cache_read_tokens;
        self.last_turn_cache_creation_tokens = cache_creation_tokens;
    }

    /// Effective auto-approve value (persistent OR runtime).
    pub fn auto_approve_all(&self) -> bool {
        self.auto_approve_persistent
            || self.auto_approve_runtime
            || (self.auto_mode && self.mode == AgentMode::Build)
    }

    /// The Shift+Tab mode as the user sees it.
    pub fn work_mode(&self) -> WorkMode {
        match (self.mode, self.auto_mode) {
            (AgentMode::Plan, _) => WorkMode::Plan,
            (AgentMode::Build, false) => WorkMode::Build,
            (AgentMode::Build, true) => WorkMode::Auto,
        }
    }

    /// Select `mode` for the next turn; `apply_now` also re-arms the live
    /// permission engine (idle only — a running turn keeps its mode).
    pub fn select_work_mode(&mut self, mode: WorkMode, apply_now: bool) {
        self.auto_mode = mode == WorkMode::Auto;
        if apply_now {
            self.set_mode(mode.agent_mode());
            self.sync_engine_auto_approve();
        } else {
            self.mode = mode.agent_mode();
        }
    }

    /// Set the user's persistent auto-approve preference and sync the engine.
    pub fn set_auto_approve(&mut self, auto_approve: bool) {
        self.auto_approve_persistent = auto_approve;
        self.sync_engine_auto_approve();
    }

    /// Set the turn-scoped auto-approve override (used by the approval popup's
    /// "Approve all" button). Resets automatically at the start of each turn.
    pub fn set_auto_approve_runtime(&mut self, auto_approve: bool) {
        self.auto_approve_runtime = auto_approve;
        self.sync_engine_auto_approve();
    }

    /// Reset the runtime override to the persistent value. Call this at the
    /// beginning of every chat turn.
    pub fn reset_auto_approve_runtime(&mut self) {
        self.auto_approve_runtime = self.auto_approve_persistent;
        self.sync_engine_auto_approve();
    }

    fn sync_engine_auto_approve(&self) {
        if let Ok(mut engine) = self.shared_permission_engine.write() {
            engine.set_auto_approve(self.auto_approve_all());
        }
    }

    /// Get shared permission engine handle for use in agent tasks
    pub fn shared_permission_engine(&self) -> SharedPermissionEngine {
        self.shared_permission_engine.clone()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn spend_sums_calls_and_reports_cache_rate() {
        let mut spend = super::Spend::default();
        assert_eq!(spend.label(), None, "nothing before the first call");
        spend.record(200, 50, 800, 0, Some(0.0042));
        spend.record(100, 20, 900, 0, Some(0.003));
        assert_eq!(spend.label().as_deref(), Some("$0.007 · 85% cached"));
        spend.record(0, 0, 0, 0, None);
        assert_eq!(spend.unpriced_calls, 1);
        assert_eq!(
            spend.label().as_deref(),
            Some("$0.007+ · 85% cached"),
            "+ = some calls had no price"
        );
        assert_eq!(super::format_usd(12.3), "$12.30");
        assert_eq!(super::format_usd(0.0004), "<$0.001", "never a fake $0.000");
        // The same table the desktop asserts in `accounting.spec.ts`: three
        // decimals below a dollar, two above, so `$0.042` reads the same on
        // both surfaces.
        assert_eq!(super::format_usd(0.042), "$0.042");
        assert_eq!(super::format_usd(0.004), "$0.004");
        assert_eq!(super::format_usd(1.0), "$1.00");
    }

    #[test]
    fn spend_labels_only_claim_what_was_reported() {
        // No price and no cache fields: nothing to claim at all.
        let mut unknown = super::Spend::default();
        unknown.record(100, 10, 0, 0, None);
        assert_eq!(unknown.label(), None, "no fake $0.00 or 0% cached");

        // The provider charged nothing: that is a real price.
        let mut free = super::Spend::default();
        free.record(342, 90, 89_000, 0, Some(0.0));
        assert_eq!(free.label().as_deref(), Some("free · 99% cached"));

        // Catalog estimate instead of the provider's charge.
        let mut estimated = super::Spend::default();
        estimated.record(1_000, 100, 0, 0, Some(0.02));
        estimated.estimated_calls = 1;
        assert_eq!(estimated.label().as_deref(), Some("~$0.020"));

        // 100% only when every prompt token really came from the cache.
        let mut all = super::Spend::default();
        all.record(0, 5, 1_000, 0, Some(0.001));
        assert_eq!(all.label().as_deref(), Some("$0.001 · 100% cached"));
    }

    use super::*;
    use agente_core::types::Role;

    fn message(content: &str) -> Message {
        Message {
            role: Role::User,
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
            thinking: None,
            thinking_signature: None,
            continuation: None,
            attachments: Vec::new(),
        }
    }

    fn approval(id: &str) -> ApprovalRequest {
        ApprovalRequest {
            request_id: id.to_string(),
            tool_name: "shell".to_string(),
            tool_args: "{}".to_string(),
            description: id.to_string(),
            is_dangerous: false,
            old_content: None,
            new_content: None,
            file_path: None,
        }
    }

    #[test]
    fn live_tool_output_keeps_the_newest_bytes_on_char_boundaries() {
        let mut agent = AgentRuntimeState::default();
        agent.start_live_tool("call".into(), "shell".into(), "{}".into(), false);
        agent.append_live_tool_output("call", &"a".repeat(MAX_LIVE_TOOL_OUTPUT_BYTES - 1));
        agent.append_live_tool_output("call", "🎉tail");
        let output = &agent.live_tool_calls["call"].output;
        assert!(output.len() <= MAX_LIVE_TOOL_OUTPUT_BYTES);
        assert!(output.ends_with("🎉tail"), "newest output survives");

        // A cut landing inside a multi-byte char moves forward, never splits.
        agent.append_live_tool_output("call", &"é".repeat(MAX_LIVE_TOOL_OUTPUT_BYTES));
        let output = &agent.live_tool_calls["call"].output;
        assert!(output.len() <= MAX_LIVE_TOOL_OUTPUT_BYTES);
        assert!(output.chars().all(|c| c == 'é'));
    }

    #[test]
    fn approvals_are_fifo_and_removable_by_origin() {
        let mut agent = AgentRuntimeState::default();
        let child = ApprovalSource::Subagent { id: "child".into() };
        agent.enqueue_approval(ApprovalSource::Parent, approval("parent-1"));
        agent.enqueue_approval(child.clone(), approval("child-1"));
        agent.enqueue_approval(ApprovalSource::Parent, approval("parent-2"));

        assert_eq!(agent.current_approval().unwrap().request_id, "parent-1");
        assert_eq!(agent.pop_approval().unwrap().request.request_id, "parent-1");
        assert_eq!(agent.current_approval().unwrap().request_id, "child-1");

        agent.remove_approvals_from(&child);
        assert_eq!(agent.current_approval().unwrap().request_id, "parent-2");
        assert!(matches!(agent.state, AgentState::WaitingApproval));
        agent.pop_approval();
        assert!(agent.approval_queue.is_empty());
        assert!(matches!(agent.state, AgentState::Idle));
    }

    #[test]
    fn recompute_total_reflects_conversation_not_cumulative_history() {
        // Stale cumulative value (e.g. from a pre-compact session).
        let mut agent = AgentRuntimeState {
            total_tokens: 999_999,
            ..AgentRuntimeState::default()
        };

        let conversation = vec![message("hello world"), message(&"a".repeat(1_000))];

        agent.recompute_total_from_conversation(&conversation);

        let expected = estimate_message_tokens(&conversation) as u32;
        assert_eq!(agent.total_tokens, expected);
        assert!(agent.total_tokens < 999_999);
    }

    #[test]
    fn record_turn_usage_stores_cache_fields() {
        let mut agent = AgentRuntimeState::default();
        agent.record_turn_usage(1_000, 200, 4_000, 2_000);

        assert_eq!(agent.last_turn_prompt_tokens, 1_000);
        assert_eq!(agent.last_turn_completion_tokens, 200);
        assert_eq!(agent.last_turn_cache_read_tokens, 4_000);
        assert_eq!(agent.last_turn_cache_creation_tokens, 2_000);
    }
}
