//! Loop health: tick counters, slow-frame logs, optional heartbeat file.
//!
//! Used to distinguish hard freezes (main loop not ticking) from soft freezes
//! (ticks running but paint/drain is expensive) and agent hangs (UI alive).

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Snapshot of the last completed UI tick.
#[derive(Debug, Clone)]
pub struct LoopHealth {
    pub tick_count: u64,
    pub last_tick_at: Instant,
    pub last_frame_ms: u64,
    pub last_drain_ms: u64,
    pub max_frame_ms: u64,
    pub max_drain_ms: u64,
    pub last_backlog: bool,
    /// Rate-limit warn logs.
    last_slow_log_at: Option<Instant>,
    /// Rate-limit heartbeat writes.
    last_heartbeat_write_at: Option<Instant>,
    heartbeat_path: Option<PathBuf>,
}

impl Default for LoopHealth {
    fn default() -> Self {
        Self {
            tick_count: 0,
            last_tick_at: Instant::now(),
            last_frame_ms: 0,
            last_drain_ms: 0,
            max_frame_ms: 0,
            max_drain_ms: 0,
            last_backlog: false,
            last_slow_log_at: None,
            last_heartbeat_write_at: None,
            heartbeat_path: heartbeat_path_from_env(),
        }
    }
}

impl LoopHealth {
    pub fn on_tick(&mut self, drain: Duration, paint: Duration, backlog: bool, agent_state: &str) {
        let drain_ms = drain.as_millis() as u64;
        let frame_ms = paint.as_millis() as u64;
        self.tick_count = self.tick_count.wrapping_add(1);
        self.last_tick_at = Instant::now();
        self.last_drain_ms = drain_ms;
        self.last_frame_ms = frame_ms;
        self.max_drain_ms = self.max_drain_ms.max(drain_ms);
        self.max_frame_ms = self.max_frame_ms.max(frame_ms);
        self.last_backlog = backlog;

        // Always warn on slow ticks (rate-limited); AGENTE_PERF keeps the old lower threshold.
        let slow_threshold = if perf_logging_enabled() { 32 } else { 100 };
        let drain_threshold = if perf_logging_enabled() { 20 } else { 50 };
        if frame_ms > slow_threshold || drain_ms > drain_threshold {
            let should_log = self
                .last_slow_log_at
                .map(|t| t.elapsed() >= Duration::from_secs(1))
                .unwrap_or(true);
            if should_log {
                self.last_slow_log_at = Some(Instant::now());
                tracing::warn!(
                    frame_ms,
                    drain_ms,
                    backlog,
                    tick = self.tick_count,
                    agent_state,
                    "Slow UI tick"
                );
            }
        }

        self.maybe_write_heartbeat(agent_state);
    }

    fn maybe_write_heartbeat(&mut self, agent_state: &str) {
        let Some(path) = self.heartbeat_path.clone() else {
            return;
        };
        // At most ~10 Hz so disk I/O cannot become the freeze.
        let should_write = self
            .last_heartbeat_write_at
            .map(|t| t.elapsed() >= Duration::from_millis(100))
            .unwrap_or(true);
        if !should_write {
            return;
        }
        self.last_heartbeat_write_at = Some(Instant::now());
        let ts_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let body = format!(
            "{{\"tick\":{},\"ts_ms\":{},\"frame_ms\":{},\"drain_ms\":{},\"state\":{}}}\n",
            self.tick_count,
            ts_ms,
            self.last_frame_ms,
            self.last_drain_ms,
            serde_json_escape(agent_state)
        );
        let _ = std::fs::write(path, body);
    }
}

fn serde_json_escape(s: &str) -> String {
    // Minimal string JSON encoding for agent_state labels (no quotes inside).
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn heartbeat_path_from_env() -> Option<PathBuf> {
    let enabled = match std::env::var("AGENTE_HEARTBEAT") {
        Ok(v) => {
            let v = v.trim();
            v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes")
        }
        Err(_) => false,
    };
    if !enabled {
        return None;
    }
    if let Ok(p) = std::env::var("AGENTE_HEARTBEAT_PATH") {
        return Some(PathBuf::from(p));
    }
    let pid = std::process::id();
    let mut path = std::env::temp_dir();
    path.push(format!("agente-heartbeat-{pid}.json"));
    Some(path)
}

fn perf_logging_enabled() -> bool {
    match std::env::var("AGENTE_PERF") {
        Ok(v) => {
            let v = v.trim();
            v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes")
        }
        Err(_) => false,
    }
}

/// Seconds with no agent events before force-reset. Default 300; override with
/// `AGENTE_STUCK_SECS` (useful for freeze_harness tests).
pub fn stuck_timeout_secs() -> u64 {
    std::env::var("AGENTE_STUCK_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n| n > 0)
        // 120s hard reset (was 300) — stalled streams should not look frozen forever.
        .unwrap_or(120)
}

/// Soft warning threshold (status bar); does not force reset.
pub fn stuck_soft_warn_secs() -> u64 {
    stuck_timeout_secs().clamp(5, 30)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_tick_increments_and_tracks_max() {
        // heartbeat_path: None — no disk in unit test.
        let mut h = LoopHealth {
            heartbeat_path: None,
            ..LoopHealth::default()
        };
        h.on_tick(
            Duration::from_millis(5),
            Duration::from_millis(10),
            false,
            "Idle",
        );
        assert_eq!(h.tick_count, 1);
        assert_eq!(h.last_frame_ms, 10);
        assert_eq!(h.last_drain_ms, 5);
        h.on_tick(
            Duration::from_millis(3),
            Duration::from_millis(40),
            true,
            "StreamingResponse",
        );
        assert_eq!(h.tick_count, 2);
        assert_eq!(h.max_frame_ms, 40);
        assert_eq!(h.max_drain_ms, 5);
        assert!(h.last_backlog);
    }

    #[test]
    fn stuck_timeout_env_defaults() {
        // Don't assert absolute env (may be set by harness); just ensure parse path works.
        let n = stuck_timeout_secs();
        assert!(n >= 1);
    }
}
