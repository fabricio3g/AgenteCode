//! Subagent registry: tracks spawned children, their status, transcripts
//! (for `resume_from`), and per-child completion signals for `task_output`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, RwLock};

use crate::cancellation::AbortController;
use crate::types::Message;

use super::definition::EffectiveRuntimeConfig;
use super::types::{SubagentSnapshot, SubagentSpawnRequest, SubagentStatus};

/// Maximum transcript kept per subagent for `resume_from`.
pub const MAX_RESUME_MESSAGES: usize = 40;

#[derive(Clone, Default)]
pub struct SubagentRegistry {
    inner: Arc<RwLock<RegistryInner>>,
}

#[derive(Default)]
struct RegistryInner {
    subagents: HashMap<String, SubagentSnapshot>,
    /// Per-subagent completion signal: `false` while running, `true` once the
    /// child reaches a terminal state.
    completions: HashMap<String, tokio::sync::watch::Sender<bool>>,
    /// Per-subagent controller so `kill_task` (and the `/subagents` UI) can
    /// stop a specific running child without cancelling the whole turn.
    cancels: HashMap<String, AbortController>,
    /// FIFO of admitted-but-unstarted spawns (see `QueuedSpawn`). The
    /// concurrency gate counts started children only, so queued entries never
    /// occupy a slot; the host launches them as running children finish.
    queue: VecDeque<QueuedSpawn>,
    /// Ids whose terminal result was already delivered to the model (inline
    /// foreground return, `task_output` terminal delivery, or acknowledged
    /// `kill_task`). Suppresses the push completion notice so a result the
    /// model already holds is never announced twice.
    observed: std::collections::HashSet<String>,
    /// Wall-clock timeouts (ms) recorded by the watchdog when it aborts a
    /// still-running child. The forwarder's `Cancelled` arm converts these
    /// into `Failed: timed out` outcomes instead of plain cancellations.
    timed_out: HashMap<String, u64>,
}

impl SubagentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new pending/running subagent. Returns a completion watcher.
    pub fn insert(&self, snapshot: SubagentSnapshot) -> tokio::sync::watch::Receiver<bool> {
        let id = snapshot.id.clone();
        let (tx, rx) = tokio::sync::watch::channel(false);
        let mut inner = self.inner.write().unwrap();
        inner.subagents.insert(id.clone(), snapshot);
        inner.completions.insert(id, tx);
        rx
    }

    pub fn get(&self, id: &str) -> Option<SubagentSnapshot> {
        self.inner.read().unwrap().subagents.get(id).cloned()
    }

    pub fn list(&self) -> Vec<SubagentSnapshot> {
        let mut out: Vec<SubagentSnapshot> = self
            .inner
            .read()
            .unwrap()
            .subagents
            .values()
            .cloned()
            .collect();
        out.sort_by_key(|a| a.started_at);
        out
    }

    pub fn list_running(&self) -> Vec<SubagentSnapshot> {
        self.list()
            .into_iter()
            .filter(|s| !s.status.is_terminal())
            .collect()
    }

    pub fn running_count(&self) -> usize {
        self.inner
            .read()
            .unwrap()
            .subagents
            .values()
            .filter(|snapshot| !snapshot.status.is_terminal())
            .count()
    }

    /// Children that actually hold a concurrency slot (started, unfinished).
    /// Queued (`Pending`) entries are live work but occupy no slot.
    pub fn started_count(&self) -> usize {
        self.inner
            .read()
            .unwrap()
            .subagents
            .values()
            .filter(|s| s.status == SubagentStatus::Running)
            .count()
    }

    /// Reserve a running slot or enqueue under one lock. Independent hosts
    /// sharing this registry cannot over-admit or lose a queued wakeup.
    pub(crate) fn admit(
        &self,
        mut snapshot: SubagentSnapshot,
        item: QueuedSpawn,
        max_concurrent: usize,
    ) -> Result<SpawnAdmission, String> {
        let mut inner = self.inner.write().unwrap();
        let id = snapshot.id.clone();
        if inner.subagents.contains_key(&id) {
            return Err(format!("Subagent id '{id}' already exists"));
        }
        let running = inner
            .subagents
            .values()
            .filter(|s| s.status == SubagentStatus::Running)
            .count();
        let queued = running >= max_concurrent || !inner.queue.is_empty();
        snapshot.status = if queued {
            SubagentStatus::Pending
        } else {
            SubagentStatus::Running
        };
        // A queued task already returns its handle, even if originally inline.
        snapshot.background |= queued;
        let (tx, rx) = tokio::sync::watch::channel(false);
        inner.subagents.insert(id.clone(), snapshot);
        inner.completions.insert(id.clone(), tx);
        inner.cancels.insert(id, item.controller.clone());
        if queued {
            inner.queue.push_back(item);
            Ok(SpawnAdmission::Queued {
                position: inner.queue.len(),
                running,
            })
        } else {
            Ok(SpawnAdmission::Running(rx))
        }
    }

    /// Claim the next eligible queued child and its slot atomically.
    pub(crate) fn start_next_queued(&self, max_concurrent: usize) -> Option<(QueuedSpawn, String)> {
        let mut inner = self.inner.write().unwrap();
        let running = inner
            .subagents
            .values()
            .filter(|s| s.status == SubagentStatus::Running)
            .count();
        if running >= max_concurrent {
            return None;
        }
        while let Some(item) = inner.queue.pop_front() {
            let Some(snapshot) = inner.subagents.get_mut(&item.id) else {
                continue;
            };
            if snapshot.status != SubagentStatus::Pending {
                continue;
            }
            snapshot.status = SubagentStatus::Running;
            snapshot.background = true;
            return Some((item, snapshot.model.clone()));
        }
        None
    }

    /// Take a queued spawn by id (kill-before-start). Returns the payload so
    /// the caller can abort its controller; `None` when not queued.
    pub fn take_queued(&self, id: &str) -> Option<QueuedSpawn> {
        let mut inner = self.inner.write().unwrap();
        let pos = inner.queue.iter().position(|item| item.id == id)?;
        Some(inner.queue.remove(pos).expect("queued position just found"))
    }

    /// 1-based FIFO position of a queued spawn, if still queued.
    pub fn queued_position(&self, id: &str) -> Option<usize> {
        self.inner
            .read()
            .unwrap()
            .queue
            .iter()
            .position(|item| item.id == id)
            .map(|pos| pos + 1)
    }

    pub fn queued_count(&self) -> usize {
        self.inner.read().unwrap().queue.len()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.inner.read().unwrap().subagents.contains_key(id)
    }

    /// Keep the live tail of a running child's output, so a `task_output` poll
    /// returns findings instead of a bare status line.
    ///
    /// Never touches a finished child: a late delta must not overwrite the
    /// final writeup with a fragment of it.
    pub fn set_progress(&self, id: &str, text: &str) {
        // Enough to be useful in a poll without being a second transcript.
        const MAX_PROGRESS_BYTES: usize = 4 * 1024;
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        // Keep the tail: the newest findings are the ones worth reporting.
        let start = if text.len() > MAX_PROGRESS_BYTES {
            crate::util::truncate_at_char_boundary(text, text.len() - MAX_PROGRESS_BYTES).len()
        } else {
            0
        };
        let mut inner = self.inner.write().unwrap();
        if let Some(snapshot) = inner.subagents.get_mut(id) {
            if snapshot.status.is_terminal() {
                return;
            }
            snapshot.summary = Some(text[start..].to_string());
        }
    }

    /// Transition a subagent to a terminal state and signal waiters.
    pub fn finish(
        &self,
        id: &str,
        status: SubagentStatus,
        summary: String,
        conversation: Vec<Message>,
    ) {
        let mut inner = self.inner.write().unwrap();
        if let Some(snapshot) = inner.subagents.get_mut(id) {
            snapshot.status = status;
            snapshot.summary = Some(summary);
            snapshot.conversation = conversation;
            snapshot.finished_at = Some(chrono::Utc::now());
        }
        if let Some(tx) = inner.completions.get(id) {
            // send() discards the value when no receiver exists. Background
            // children must still look completed to a later subscriber.
            tx.send_replace(true);
        }
        inner.cancels.remove(id);
    }

    /// Register the cancellation controller for a running child
    /// (`kill_task` target).
    pub fn register_cancel(&self, id: &str, controller: AbortController) {
        self.inner
            .write()
            .unwrap()
            .cancels
            .insert(id.to_string(), controller);
    }

    /// Send a cancel signal to a specific running subagent. Returns `true` when
    /// a child with that id exists (running or already finished).
    pub fn cancel(&self, id: &str) -> bool {
        let (controller, known) = {
            let inner = self.inner.read().unwrap();
            (
                inner.cancels.get(id).cloned(),
                inner.subagents.contains_key(id),
            )
        };
        if let Some(controller) = controller {
            controller.abort();
        }
        known
    }

    /// Update live fields (status/text) without finishing.
    pub fn update(&self, id: &str, f: impl FnOnce(&mut SubagentSnapshot)) {
        let mut inner = self.inner.write().unwrap();
        if let Some(snapshot) = inner.subagents.get_mut(id) {
            f(snapshot);
        }
    }

    pub fn remove(&self, id: &str) {
        let mut inner = self.inner.write().unwrap();
        inner.subagents.remove(id);
        inner.completions.remove(id);
        if let Some(controller) = inner.cancels.remove(id) {
            controller.abort();
        }
        inner.queue.retain(|item| item.id != id);
        inner.observed.remove(id);
        inner.timed_out.remove(id);
    }

    /// Completion watcher for `task_output` polling.
    pub fn completion_receiver(&self, id: &str) -> Option<tokio::sync::watch::Receiver<bool>> {
        self.inner
            .read()
            .unwrap()
            .completions
            .get(id)
            .map(|tx| tx.subscribe())
    }

    /// Live waiter count on the completion signal: foreground spawns hold
    /// theirs for the whole run, `task_output` polls hold one while waiting.
    /// Zero means nobody can receive the terminal result inline.
    pub fn receiver_count(&self, id: &str) -> usize {
        self.inner
            .read()
            .unwrap()
            .completions
            .get(id)
            .map(|tx| tx.receiver_count())
            .unwrap_or(0)
    }

    /// Record that the model already holds this child's terminal result.
    pub fn mark_observed(&self, id: &str) {
        self.inner.write().unwrap().observed.insert(id.to_string());
    }

    /// True when the terminal result was already delivered to the model.
    pub fn was_observed(&self, id: &str) -> bool {
        self.inner.read().unwrap().observed.contains(id)
    }

    /// Record a watchdog timeout abort. The forwarder converts the resulting
    /// cancellation into a `Failed: timed out` outcome exactly once.
    pub fn mark_timed_out(&self, id: &str, timeout_ms: u64) {
        self.inner
            .write()
            .unwrap()
            .timed_out
            .insert(id.to_string(), timeout_ms);
    }

    /// Take a recorded timeout, if any.
    pub fn take_timed_out(&self, id: &str) -> Option<u64> {
        self.inner.write().unwrap().timed_out.remove(id)
    }
}

pub(crate) enum SpawnAdmission {
    Running(tokio::sync::watch::Receiver<bool>),
    Queued { position: usize, running: usize },
}

/// A spawn admitted but not yet started: all inputs needed to launch the
/// child thread once a concurrency slot frees, without re-resolving.
#[derive(Clone)]
pub struct QueuedSpawn {
    pub id: String,
    pub request: SubagentSpawnRequest,
    pub cfg: EffectiveRuntimeConfig,
    pub controller: AbortController,
    pub depth: u32,
    /// Whether Plan-mode admission coerced this child to read-only (kept so
    /// the deferred launch reports the same start note as an immediate one).
    pub coerced_to_read_only: bool,
}

impl std::fmt::Debug for QueuedSpawn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueuedSpawn")
            .field("id", &self.id)
            .field("request", &self.request)
            .field("depth", &self.depth)
            .finish_non_exhaustive()
    }
}

/// Bound a conversation for resume storage (keep the tail).
pub fn bound_conversation(mut messages: Vec<Message>) -> Vec<Message> {
    if messages.len() > MAX_RESUME_MESSAGES {
        messages = messages.split_off(messages.len() - MAX_RESUME_MESSAGES);
    }
    messages
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(id: &str) -> SubagentSnapshot {
        SubagentSnapshot {
            id: id.to_string(),
            subagent_type: "explore".to_string(),
            description: "test".to_string(),
            prompt: "Explicit handoff".to_string(),
            status: SubagentStatus::Running,
            summary: None,
            conversation: Vec::new(),
            model: "m".to_string(),
            depth: 0,
            background: false,
            started_at: chrono::Utc::now(),
            finished_at: None,
            cwd: None,
            worktree: None,
        }
    }

    fn queued_item(id: &str) -> QueuedSpawn {
        let request = serde_json::from_value(serde_json::json!({
            "prompt": "do it", "description": "d", "subagent_type": "explore",
            "isolation": "none"
        }))
        .unwrap();
        let parent = super::super::definition::SubagentParentDefaults {
            model: "m".into(),
            project_dir: ".".into(),
            depth: 0,
        };
        let cfg =
            super::super::definition::resolve_effective_config(&request, &parent, &[]).unwrap();
        QueuedSpawn {
            id: id.into(),
            request,
            cfg,
            controller: AbortController::new(),
            depth: 0,
            coerced_to_read_only: false,
        }
    }

    #[test]
    fn progress_publishes_the_live_tail_and_never_clobbers_a_finished_child() {
        let registry = SubagentRegistry::new();
        registry.insert(snapshot("s-1"));

        registry.set_progress("s-1", "found the parser in src/parse.rs");
        assert_eq!(
            registry.get("s-1").unwrap().summary.as_deref(),
            Some("found the parser in src/parse.rs")
        );

        // The tail, not the head: a long transcript must not push the newest
        // findings out of the poll result.
        let long = format!("{}\nLATEST", "x".repeat(8 * 1024));
        registry.set_progress("s-1", &long);
        let kept = registry.get("s-1").unwrap().summary.clone().unwrap();
        assert!(
            kept.len() <= 4 * 1024 + 16,
            "tail grew to {} bytes",
            kept.len()
        );
        assert!(
            kept.ends_with("LATEST"),
            "tail kept the head instead of the end"
        );

        // A finished child keeps its final writeup.
        registry.finish(
            "s-1",
            SubagentStatus::Completed,
            "the final answer".into(),
            Vec::new(),
        );
        registry.set_progress("s-1", "a late delta");
        assert_eq!(
            registry.get("s-1").unwrap().summary.as_deref(),
            Some("the final answer")
        );
    }

    #[test]
    fn concurrent_admission_and_dequeue_respect_the_slot_limit() {
        let registry = SubagentRegistry::new();
        let barrier = std::sync::Barrier::new(16);
        std::thread::scope(|scope| {
            for n in 0..16 {
                let registry = &registry;
                let barrier = &barrier;
                scope.spawn(move || {
                    let id = format!("child-{n}");
                    barrier.wait();
                    registry.admit(snapshot(&id), queued_item(&id), 3).unwrap();
                });
            }
        });
        assert_eq!(registry.started_count(), 3);
        assert_eq!(registry.queued_count(), 13);
        for child in registry
            .list()
            .into_iter()
            .filter(|s| s.status == SubagentStatus::Running)
        {
            registry.finish(&child.id, SubagentStatus::Completed, "done".into(), vec![]);
        }
        std::thread::scope(|scope| {
            for _ in 0..16 {
                let registry = &registry;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    registry.start_next_queued(3);
                });
            }
        });
        assert_eq!(registry.started_count(), 3);
        assert_eq!(registry.queued_count(), 10);
    }

    #[test]
    fn background_completion_is_retained_without_a_waiter() {
        let registry = SubagentRegistry::new();
        drop(registry.insert(snapshot("bg")));
        registry.finish("bg", SubagentStatus::Completed, "done".into(), vec![]);
        assert!(*registry.completion_receiver("bg").unwrap().borrow());
    }

    #[test]
    fn duplicate_admission_does_not_replace_live_state() {
        let registry = SubagentRegistry::new();
        let item = queued_item("child");
        let signal = item.controller.signal();
        registry.admit(snapshot("child"), item, 1).unwrap();
        assert!(registry
            .admit(snapshot("child"), queued_item("child"), 1)
            .is_err());
        assert_eq!(registry.started_count(), 1);
        assert_eq!(registry.queued_count(), 0);
        registry.cancel("child");
        assert!(signal.is_aborted());
    }

    #[test]
    fn removal_clears_queue_and_lifecycle_metadata() {
        let registry = SubagentRegistry::new();
        let item = queued_item("child");
        let signal = item.controller.signal();
        registry.admit(snapshot("child"), item, 0).unwrap();
        registry.mark_observed("child");
        registry.mark_timed_out("child", 100);
        registry.remove("child");
        assert!(signal.is_aborted());
        assert_eq!(registry.queued_count(), 0);
        assert!(!registry.was_observed("child"));
        assert_eq!(registry.take_timed_out("child"), None);
        assert!(registry.completion_receiver("child").is_none());
    }

    #[test]
    fn registry_lifecycle_and_completion_signal() {
        let registry = SubagentRegistry::new();
        let rx = registry.insert(snapshot("s1"));
        assert_eq!(registry.running_count(), 1);
        assert!(!*rx.borrow());

        registry.finish("s1", SubagentStatus::Completed, "done".into(), vec![]);
        assert_eq!(registry.running_count(), 0);
        assert!(*rx.borrow());
        let snap = registry.get("s1").unwrap();
        assert_eq!(snap.status, SubagentStatus::Completed);
        assert_eq!(snap.summary.as_deref(), Some("done"));

        // Completion receiver works for task_output polling.
        let rx2 = registry.completion_receiver("s1").unwrap();
        assert!(*rx2.borrow());

        // Unknown ids are absent.
        assert!(registry.get("nope").is_none());
        assert!(registry.completion_receiver("nope").is_none());
    }

    #[test]
    fn observed_tracking_and_receiver_count() {
        let registry = SubagentRegistry::new();
        let rx = registry.insert(snapshot("s1"));
        // Foreground-style held watcher counts as a live waiter.
        assert_eq!(registry.receiver_count("s1"), 1);
        assert!(!registry.was_observed("s1"));
        drop(rx);
        // Background-style: nobody holds the signal.
        assert_eq!(registry.receiver_count("s1"), 0);
        assert_eq!(registry.receiver_count("ghost"), 0);

        registry.mark_observed("s1");
        assert!(registry.was_observed("s1"));
        assert!(!registry.was_observed("s2"));
    }

    #[test]
    fn queue_is_fifo_with_positions_and_started_count() {
        let registry = SubagentRegistry::new();
        registry
            .admit(snapshot("q1"), queued_item("q1"), 0)
            .unwrap();
        registry
            .admit(snapshot("q2"), queued_item("q2"), 0)
            .unwrap();
        assert_eq!(registry.queued_count(), 2);
        assert_eq!(registry.queued_position("q1"), Some(1));
        assert_eq!(registry.queued_position("q2"), Some(2));
        assert_eq!(registry.queued_position("ghost"), None);
        // Queued entries never occupy a concurrency slot.
        assert_eq!(registry.started_count(), 0);

        assert_eq!(registry.start_next_queued(1).unwrap().0.id, "q1");
        assert!(registry.start_next_queued(1).is_none());
        assert_eq!(registry.started_count(), 1);
        assert_eq!(registry.queued_position("q2"), Some(1));
        let taken = registry.take_queued("q2").expect("queued item taken");
        assert_eq!(taken.id, "q2");
        assert!(registry.take_queued("q2").is_none());
        assert_eq!(registry.queued_count(), 0);
    }

    #[test]
    fn timed_out_marking_arms_exactly_once() {
        let registry = SubagentRegistry::new();
        registry.insert(snapshot("s1"));
        assert_eq!(registry.take_timed_out("s1"), None);
        registry.mark_timed_out("s1", 5_000);
        assert_eq!(registry.take_timed_out("s1"), Some(5_000));
        assert_eq!(registry.take_timed_out("s1"), None);
    }

    #[test]
    fn registry_cancel_signals_running_child() {
        let registry = SubagentRegistry::new();
        let cancel_controller = AbortController::new();
        let cancel_signal = cancel_controller.signal();
        registry.insert(snapshot("s2"));
        registry.register_cancel("s2", cancel_controller);

        assert!(!cancel_signal.is_aborted());
        assert!(registry.cancel("s2"));
        assert!(cancel_signal.is_aborted());

        // Unknown id: cancel returns false (no child with that id).
        assert!(!registry.cancel("ghost"));
    }

    #[test]
    fn bound_conversation_keeps_tail() {
        let mut msgs = Vec::new();
        for i in 0..50 {
            msgs.push(Message {
                role: crate::types::Role::User,
                content: format!("m{i}"),
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
                attachments: Vec::new(),
            });
        }
        let bounded = bound_conversation(msgs);
        assert_eq!(bounded.len(), MAX_RESUME_MESSAGES);
        assert_eq!(bounded[0].content, "m10");
        assert_eq!(bounded.last().unwrap().content, "m49");
    }

    #[test]
    fn cancel_signals_only_registered_child() {
        let registry = SubagentRegistry::new();
        registry.insert(snapshot("s1"));

        let controller = AbortController::new();
        let signal = controller.signal();
        registry.register_cancel("s1", controller);

        // Cancelling a known child flips its flag.
        assert!(registry.cancel("s1"));
        assert!(signal.is_aborted());
        // Second kill is a no-op but still resolves to "known".
        assert!(registry.cancel("s1"));
        // Unknown ids are absent.
        assert!(!registry.cancel("missing"));

        // finish() clears the cancel entry.
        registry.finish("s1", SubagentStatus::Completed, "done".into(), vec![]);
        assert!(registry.cancel("s1"));
    }
}
