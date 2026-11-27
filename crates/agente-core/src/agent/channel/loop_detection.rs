//! "Action stationarity" detection: a model repeating an
//! identical tool call — same tool, same canonical arguments — is stuck in an
//! unproductive loop. After `nudge_after` repeats a guidance message is
//! injected into the conversation; after `stop_after` the turn is stopped with
//! paired error results so the transcript stays protocol-valid.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

/// Identical-call repeats before the loop injects a nudge.
pub(crate) const DEFAULT_LOOP_NUDGE_AFTER: u32 = 3;
/// Identical-call repeats before the loop stops the turn.
pub(crate) const DEFAULT_LOOP_STOP_AFTER: u32 = 6;

/// Native Home tools and the same tools namespaced by Desktop's MCP adapter.
pub(crate) fn is_computer_tool(name: &str) -> bool {
    matches!(
        name.strip_prefix("desktop_").unwrap_or(name),
        "computer_request" | "computer_observe" | "computer_act" | "computer_finish"
    )
}

/// Request tool that arms interactive desktop control and qualifies for the
/// extended computer-use iteration budget (both Home and Code MCP forms).
pub(crate) fn is_computer_request_tool(name: &str) -> bool {
    name.strip_prefix("desktop_").unwrap_or(name) == "computer_request"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LoopVerdict {
    /// Keep going.
    Normal,
    /// This signature just crossed the nudge threshold (fires once).
    Nudge,
    /// This signature reached the stop threshold (fires on every repeat).
    Stop,
}

pub(crate) struct LoopDetector {
    nudge_after: u32,
    stop_after: u32,
    counts: HashMap<u64, u32>,
}

impl LoopDetector {
    pub(crate) fn new(nudge_after: u32, stop_after: u32) -> Self {
        let nudge_after = nudge_after.max(2);
        Self {
            nudge_after,
            stop_after: stop_after.max(nudge_after + 1),
            counts: HashMap::new(),
        }
    }

    /// Record one tool call. Repeats are keyed by (tool name, canonical
    /// arguments) so JSON key-order differences do not hide identical calls.
    pub(crate) fn record(&mut self, tool_name: &str, arguments: &str) -> LoopVerdict {
        let signature = signature_for(tool_name, arguments);
        let count = self.counts.entry(signature).or_insert(0);
        *count += 1;
        let count = *count;
        if count >= self.stop_after {
            LoopVerdict::Stop
        } else if count == self.nudge_after {
            LoopVerdict::Nudge
        } else {
            LoopVerdict::Normal
        }
    }

    /// Times this exact (tool, arguments) pair has been recorded.
    pub(crate) fn repeats_of(&self, tool_name: &str, arguments: &str) -> u32 {
        self.counts
            .get(&signature_for(tool_name, arguments))
            .copied()
            .unwrap_or(0)
    }

    /// Computer observations deliberately have identical arguments, while each
    /// successful result is fresh progress. Only failures accumulate here.
    pub(crate) fn record_result(&mut self, tool_name: &str, arguments: &str, is_error: bool) {
        if !is_error && is_computer_tool(tool_name) {
            self.counts.remove(&signature_for(tool_name, arguments));
        }
    }
}

/// Hash of (tool name, key-order-insensitive canonical arguments).
pub(crate) fn signature_for(tool_name: &str, arguments: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    tool_name.hash(&mut hasher);
    canonical_json(arguments).hash(&mut hasher);
    hasher.finish()
}

/// Canonical argument text: JSON re-serialized with recursively sorted object
/// keys; non-JSON arguments fall back to the trimmed raw text.
pub(crate) fn canonical_json(value: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(value) {
        Ok(parsed) => canonical_value(&parsed),
        Err(_) => value.trim().to_string(),
    }
}

fn canonical_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            // Sort explicitly: serde_json maps are sorted unless the
            // `preserve_order` feature is enabled, and we must not depend on
            // that either way.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::Value::String((*key).clone()),
                        canonical_value(&map[key])
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        serde_json::Value::Array(items) => {
            let body = items
                .iter()
                .map(canonical_value)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{body}]")
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_computer_observations_do_not_trip_the_repeat_guard() {
        for name in ["computer_observe", "desktop_computer_observe"] {
            let mut detector = LoopDetector::new(DEFAULT_LOOP_NUDGE_AFTER, DEFAULT_LOOP_STOP_AFTER);
            for _ in 0..30 {
                assert_eq!(detector.record(name, "{}"), LoopVerdict::Normal);
                detector.record_result(name, "{}", false);
            }
        }
    }

    #[test]
    fn computer_failures_still_reach_the_limit_and_success_clears_them() {
        let mut detector = LoopDetector::new(3, 6);
        for _ in 0..5 {
            detector.record("computer_observe", "{}");
            detector.record_result("computer_observe", "{}", true);
        }
        assert_eq!(detector.record("computer_observe", "{}"), LoopVerdict::Stop);
        detector.record_result("computer_observe", "{}", false);
        assert_eq!(
            detector.record("computer_observe", "{}"),
            LoopVerdict::Normal
        );
        assert!(!is_computer_tool("untrusted_computer_observe"));
    }

    #[test]
    fn ordinary_tools_keep_the_existing_loop_protection() {
        let mut detector = LoopDetector::new(3, 6);
        for _ in 0..5 {
            detector.record("read_file", "{}");
            detector.record_result("read_file", "{}", false);
        }
        assert_eq!(detector.record("read_file", "{}"), LoopVerdict::Stop);
    }

    #[test]
    fn signatures_ignore_json_key_order() {
        let flat_a = signature_for("read_file", r#"{"path":"a.rs","limit":5}"#);
        let flat_b = signature_for("read_file", r#"{"limit":5,"path":"a.rs"}"#);
        assert_eq!(flat_a, flat_b);

        let nested_a = signature_for("shell", r#"{"cmd":"ls","opts":{"a":1,"b":2}}"#);
        let nested_b = signature_for("shell", r#"{"opts":{"b":2,"a":1},"cmd":"ls"}"#);
        assert_eq!(nested_a, nested_b);
    }

    #[test]
    fn different_arguments_or_tools_differ() {
        assert_ne!(
            signature_for("read_file", r#"{"path":"a.rs"}"#),
            signature_for("read_file", r#"{"path":"b.rs"}"#)
        );
        assert_ne!(
            signature_for("read_file", r#"{"path":"a.rs"}"#),
            signature_for("grep", r#"{"path":"a.rs"}"#)
        );
    }

    #[test]
    fn nudge_fires_once_at_threshold_and_stop_afterwards() {
        let mut detector = LoopDetector::new(3, 6);
        let args = r#"{"path":"loop.rs"}"#;
        let verdicts: Vec<LoopVerdict> =
            (0..7).map(|_| detector.record("read_file", args)).collect();
        assert_eq!(
            verdicts,
            vec![
                LoopVerdict::Normal,
                LoopVerdict::Normal,
                LoopVerdict::Nudge,
                LoopVerdict::Normal,
                LoopVerdict::Normal,
                LoopVerdict::Stop,
                LoopVerdict::Stop,
            ]
        );
        assert_eq!(detector.repeats_of("read_file", args), 7);
    }

    #[test]
    fn interleaved_different_calls_do_not_share_counts() {
        let mut detector = LoopDetector::new(3, 6);
        // Each path reaches its nudge at its OWN third repeat; counts never
        // bleed across distinct signatures.
        for round in 1..=4u32 {
            let expected = if round == 3 {
                LoopVerdict::Nudge
            } else {
                LoopVerdict::Normal
            };
            assert_eq!(
                detector.record("read_file", r#"{"path":"a"}"#),
                expected,
                "path a round {round}"
            );
            assert_eq!(
                detector.record("read_file", r#"{"path":"b"}"#),
                expected,
                "path b round {round}"
            );
        }
        assert_eq!(detector.repeats_of("read_file", r#"{"path":"a"}"#), 4);
        assert_eq!(detector.repeats_of("read_file", r#"{"path":"b"}"#), 4);
    }

    #[test]
    fn thresholds_are_clamped_to_sane_minimums() {
        let mut detector = LoopDetector::new(0, 0);
        // stop must stay strictly above nudge.
        assert_eq!(detector.record("t", "{}"), LoopVerdict::Normal);
        assert_eq!(detector.record("t", "{}"), LoopVerdict::Nudge);
        assert_eq!(detector.record("t", "{}"), LoopVerdict::Stop);
    }

    #[test]
    fn non_json_arguments_fall_back_to_trimmed_text() {
        assert_eq!(canonical_json("  ls -la  "), "ls -la");
        assert_eq!(
            signature_for("shell", "ls -la"),
            signature_for("shell", "  ls -la  ")
        );
    }

    #[test]
    fn computer_request_matches_home_and_desktop_mcp_names() {
        assert!(is_computer_request_tool("computer_request"));
        assert!(is_computer_request_tool("desktop_computer_request"));
        assert!(!is_computer_request_tool("untrusted_computer_request"));
        assert!(!is_computer_request_tool("computer_observe"));
    }
}
