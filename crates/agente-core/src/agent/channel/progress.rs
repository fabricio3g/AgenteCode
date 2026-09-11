//! Cheap, throttled generation telemetry, independent of disposable text buffers.

use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use super::config::send_event;
use crate::agent::{AgentEvent, AgentTaskEvent};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Default)]
pub(super) struct StreamProgress {
    output_bytes: usize,
    tool_name: Option<String>,
    last_emit: Option<Instant>,
}

impl StreamProgress {
    pub fn record(
        &mut self,
        bytes: usize,
        tool: Option<&str>,
        sender: &Sender<AgentTaskEvent>,
        task_id: u64,
    ) {
        self.record_at(bytes, tool, sender, task_id, Instant::now());
    }

    fn record_at(
        &mut self,
        bytes: usize,
        tool: Option<&str>,
        sender: &Sender<AgentTaskEvent>,
        task_id: u64,
        now: Instant,
    ) {
        self.output_bytes = self.output_bytes.saturating_add(bytes);
        let phase_changed = self.tool_name.as_deref() != tool;
        if phase_changed {
            self.tool_name = tool.map(str::to_string);
        }
        if phase_changed
            || self
                .last_emit
                .is_none_or(|last| now.duration_since(last) >= PROGRESS_INTERVAL)
        {
            self.emit(sender, task_id, now);
        }
    }

    /// Flush the last short burst and leave the preparation phase. Counters
    /// survive subsequent requests, tool execution, compaction, and retries.
    pub fn finish_request(&mut self, sender: &Sender<AgentTaskEvent>, task_id: u64) {
        self.tool_name = None;
        self.emit(sender, task_id, Instant::now());
    }

    fn emit(&mut self, sender: &Sender<AgentTaskEvent>, task_id: u64, now: Instant) {
        send_event(
            sender,
            task_id,
            AgentEvent::GenerationProgress {
                subagent_id: None,
                output_bytes: self.output_bytes,
                tool_name: self.tool_name.clone(),
            },
        );
        self.last_emit = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_counts_tool_json_across_requests_without_flooding_the_ui() {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut progress = StreamProgress::default();
        let now = Instant::now();
        progress.record_at(8, None, &tx, 7, now);
        progress.record_at(0, Some("write_file"), &tx, 7, now);
        for _ in 0..1_000 {
            progress.record_at(4, Some("write_file"), &tx, 7, now);
        }
        assert_eq!(rx.try_iter().count(), 2, "a burst must be coalesced");
        progress.finish_request(&tx, 7);
        let event = rx.try_recv().unwrap();
        assert_eq!(event.task_id, 7);
        assert!(matches!(
            event.event,
            AgentEvent::GenerationProgress {
                output_bytes: 4_008,
                tool_name: None,
                subagent_id: None,
            }
        ));
        progress.record(12, None, &tx, 7);
        progress.finish_request(&tx, 7);
        assert!(matches!(
            rx.try_iter().last().unwrap().event,
            AgentEvent::GenerationProgress {
                output_bytes: 4_020,
                ..
            }
        ));
    }

    #[test]
    fn long_tool_generation_continues_emitting_liveness() {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut progress = StreamProgress::default();
        let now = Instant::now();
        for n in 0..10 {
            progress.record_at(100, Some("edit_file"), &tx, 1, now + PROGRESS_INTERVAL * n);
        }
        let events: Vec<_> = rx.try_iter().collect();
        assert_eq!(events.len(), 10);
        assert!(matches!(
            events.last().unwrap().event,
            AgentEvent::GenerationProgress {
                output_bytes: 1_000,
                ..
            }
        ));
    }
}
