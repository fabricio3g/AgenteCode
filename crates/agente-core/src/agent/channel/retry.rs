//! Retry policy helpers for provider/stream failures.

use crate::cancellation::AbortSignal;

pub(crate) fn is_retryable_error(msg: &str) -> bool {
    // A status the provider reported is authoritative: 408/429 and 5xx are
    // transient, every other code is a client error that a retry cannot fix.
    // Matching the bare text "500" instead caught model ids ("gpt-500") and
    // token counts, and retried failures that were never going to succeed.
    if let Some(status) = super::errors::http_status(msg) {
        return status == 408 || status == 429 || (500..600).contains(&status);
    }

    let lower = msg.to_lowercase();
    lower.contains("overloaded")
        || lower.contains("rate limit")
        || lower.contains("rate_limit")
        // The providers phrase a 90s SSE stall as "Stream stalled (no data
        // for Ns)" - one stall must trigger the retry path, not kill the turn.
        || lower.contains("stream stalled")
        || lower.contains("stalled (no data")
        || lower.contains("connection reset")
        || lower.contains("chat stream ended before completion")
        || lower.contains("network error")
        || super::errors::contains_word(&lower, "timeout")
        || lower.contains("timed out")
}

/// Wait out the retry backoff. Returns `true` when the turn was cancelled
/// while waiting (the caller emits `Cancelled` and stops).
pub(crate) async fn wait_retry_or_cancel(signal: &AbortSignal, delay: std::time::Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(delay) => false,
        _ = signal.wait_aborted() => true,
    }
}

/// Exponential backoff with ±20% jitter, capped at 30 s. Jitter spreads simultaneous retry
/// storms from many clients so a recovering provider is not hit in lockstep.
pub(crate) fn jittered_backoff(base_delay_ms: u64, attempt: u32) -> std::time::Duration {
    let doubling = 1u64.checked_shl(attempt.min(20)).unwrap_or(u64::MAX);
    let capped = base_delay_ms.saturating_mul(doubling).min(30_000);
    let jitter_range = (capped / 5).max(1);
    // Nanosecond sub-second entropy is enough spread for retry pacing and
    // keeps this dependency-free and deterministic in cost.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let offset = nanos % (2 * jitter_range + 1);
    std::time::Duration::from_millis(capped - jitter_range + offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A status the provider reported decides retryability. Matching bare
    /// "500"/"429" against the message text retried permanent failures whose
    /// model id or token count merely contained those digits.
    #[test]
    fn status_decides_retryability_not_stray_digits() {
        assert!(is_retryable_error("OpenAI: HTTP 503 - unavailable"));
        assert!(is_retryable_error("OpenAI: HTTP 429 - slow down"));
        assert!(is_retryable_error("OpenAI: HTTP 408 - request timeout"));

        // Client errors must fail fast, even when the body mentions 5xx-ish digits.
        assert!(!is_retryable_error("OpenAI: HTTP 401 - invalid key"));
        assert!(!is_retryable_error(
            "OpenAI: HTTP 404 - model gpt-500 not found"
        ));
        assert!(!is_retryable_error(
            "OpenAI: HTTP 400 - prompt is 5000 tokens"
        ));
    }

    /// Transport failures carry no status and still have to be retried.
    #[test]
    fn statusless_transport_failures_stay_retryable() {
        assert!(is_retryable_error("Stream stalled (no data for 90s)"));
        assert!(is_retryable_error("connection reset by peer"));
        assert!(is_retryable_error(
            "Stream error: Chat stream ended before completion"
        ));
        assert!(is_retryable_error("request timed out"));
        assert!(is_retryable_error("server overloaded"));
        assert!(!is_retryable_error("model refused to answer"));
    }

    #[test]
    fn backoff_stays_within_twenty_percent_of_the_exponential_value() {
        for attempt in 0..4u32 {
            let expected = 1000u64 * 2u64.pow(attempt);
            for _ in 0..50 {
                let delay = jittered_backoff(1000, attempt).as_millis() as u64;
                let lower = expected * 8 / 10;
                let upper = expected * 12 / 10;
                assert!(
                    (lower..=upper).contains(&delay),
                    "attempt {attempt}: {delay}ms outside [{lower}, {upper}]"
                );
            }
        }
    }

    #[test]
    fn backoff_is_capped_at_thirty_seconds() {
        for _ in 0..50 {
            let delay = jittered_backoff(1000, 30).as_millis() as u64;
            assert!(delay <= 30_000 + 30_000 / 5, "cap violated: {delay}ms");
            assert!(delay >= 24_000, "cap floor violated: {delay}ms");
        }
    }

    #[test]
    fn backoff_never_overflows_on_large_attempts() {
        let delay = jittered_backoff(u64::MAX / 2, 40).as_millis() as u64;
        assert!(delay <= 36_000);
    }
}
