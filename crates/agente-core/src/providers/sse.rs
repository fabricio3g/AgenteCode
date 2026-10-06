//! Shared byte-safe SSE transport. Adapters only interpret complete JSON events.

use crate::llm::LlmError;
use futures::{Stream, StreamExt};
use std::collections::VecDeque;
use std::time::Duration;

const MAX_EVENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
struct Decoder {
    line: Vec<u8>,
    data: String,
    has_data: bool,
    events: VecDeque<String>,
}

impl Decoder {
    fn push(&mut self, bytes: &[u8]) -> Result<(), LlmError> {
        for segment in bytes.split_inclusive(|byte| *byte == b'\n') {
            if self.line.len() + self.data.len() + segment.len() > MAX_EVENT_BYTES {
                return Err(LlmError::StreamError("SSE event exceeds 8 MiB".into()));
            }
            self.line.extend_from_slice(segment);
            if segment.last() == Some(&b'\n') {
                self.consume_line()?;
            }
        }
        Ok(())
    }

    fn consume_line(&mut self) -> Result<(), LlmError> {
        let bytes = std::mem::take(&mut self.line);
        let line = std::str::from_utf8(&bytes)
            .map_err(|e| LlmError::StreamError(format!("Invalid UTF-8 in SSE: {e}")))?;
        let line = line.strip_suffix('\n').unwrap_or(line);
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            self.dispatch();
        } else {
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            if field == "data" {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
                self.has_data = true;
            }
        }
        Ok(())
    }

    fn dispatch(&mut self) {
        if self.has_data {
            self.events.push_back(std::mem::take(&mut self.data));
            self.has_data = false;
        }
    }

    fn finish(&mut self) -> Result<(), LlmError> {
        if !self.line.is_empty() {
            self.consume_line()?;
        }
        self.dispatch();
        Ok(())
    }
}

pub(crate) struct EventStream<S> {
    source: S,
    decoder: Decoder,
    ended: bool,
    /// Any transport bytes at all (data, comments or keepalives).
    received_any: bool,
    /// Deadline for the *first* bytes only; `None` uses the idle timeout.
    first_byte: Option<Duration>,
}

impl<S> EventStream<S> {
    pub(crate) fn new(source: S) -> Self {
        Self {
            source,
            decoder: Decoder::default(),
            ended: false,
            received_any: false,
            first_byte: None,
        }
    }

    /// A provider completion stream from `url`: the first chunk runs against
    /// its own deadline (`AGENTE_STREAM_FIRST_BYTE_SECS`), so a request that
    /// never answered is retried instead of holding the turn for the idle
    /// timeout — except on a local model server, which gets the longer local
    /// deadline to read the prompt.
    pub(crate) fn for_completion(source: S, url: &str) -> Self {
        Self::new(source).with_first_byte_timeout(crate::util::completion_first_byte_timeout(url))
    }

    pub(crate) fn with_first_byte_timeout(mut self, timeout: Duration) -> Self {
        self.first_byte = Some(timeout);
        self
    }
}

impl<S, B, E> EventStream<S>
where
    S: Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    /// Timeout measures raw transport inactivity, including provider keepalives.
    /// Before the first chunk arrives the shorter first-byte deadline applies.
    pub(crate) async fn next_event(&mut self, idle: Duration) -> Result<Option<String>, LlmError> {
        loop {
            if let Some(event) = self.decoder.events.pop_front() {
                return Ok(Some(event));
            }
            if self.ended {
                return Ok(None);
            }
            let wait = if self.received_any {
                idle
            } else {
                self.first_byte.unwrap_or(idle)
            };
            match tokio::time::timeout(wait, self.source.next()).await {
                Ok(Some(Ok(bytes))) => {
                    self.received_any = true;
                    self.decoder.push(bytes.as_ref())?;
                }
                Ok(Some(Err(e))) => return Err(LlmError::StreamError(e.to_string())),
                Ok(None) => {
                    self.ended = true;
                    self.decoder.finish()?;
                }
                Err(_) => {
                    return Err(LlmError::StreamError(format!(
                        "Stream stalled (no data for {}s).",
                        wait.as_secs()
                    )))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_utf8_at_every_chunk_boundary() {
        let wire = "event: delta\r\ndata:{\"text\":\"á界🦀\"}\r\n\r\ndata: [DONE]";
        for boundary in 0..=wire.len() {
            let mut decoder = Decoder::default();
            decoder.push(&wire.as_bytes()[..boundary]).unwrap();
            decoder.push(&wire.as_bytes()[boundary..]).unwrap();
            decoder.finish().unwrap();
            assert_eq!(decoder.events, ["{\"text\":\"á界🦀\"}", "[DONE]"]);
        }
    }

    #[test]
    fn multiline_data_comments_and_empty_events() {
        let mut decoder = Decoder::default();
        decoder
            .push(b": ping\n\ndata: {\ndata: \"ok\":true}\n\ndata:\n\n")
            .unwrap();
        assert_eq!(decoder.events, ["{\n\"ok\":true}", ""]);
    }

    #[test]
    fn rejects_invalid_utf8_and_unbounded_records() {
        assert!(Decoder::default().push(b"data: \xff\n").is_err());
        let mut decoder = Decoder::default();
        decoder.push(&vec![b'x'; MAX_EVENT_BYTES]).unwrap();
        assert!(decoder.push(b"x").is_err());
    }

    #[tokio::test]
    async fn first_chunk_has_its_own_deadline() {
        // A socket that never yields must fail on the first-byte deadline
        // (short here) instead of waiting out the much longer idle timeout.
        let source = futures::stream::pending::<Result<Vec<u8>, &str>>();
        let mut stream =
            EventStream::new(source).with_first_byte_timeout(Duration::from_millis(20));
        let started = std::time::Instant::now();
        let error = stream
            .next_event(Duration::from_secs(30))
            .await
            .expect_err("a silent stream must fail");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "idle timeout won"
        );
        assert!(error.to_string().contains("stalled"), "{error}");
    }

    #[tokio::test]
    async fn arrived_bytes_switch_to_the_idle_timeout() {
        // Keepalives and partial events count as life: after the first chunk
        // the longer idle timeout governs, so a thinking model is not cut off.
        let source = futures::stream::iter([Ok::<_, &str>(b"data: first\n\n".to_vec())])
            .chain(futures::stream::pending());
        let mut stream = EventStream::new(source).with_first_byte_timeout(Duration::from_secs(30));
        assert_eq!(
            stream
                .next_event(Duration::from_millis(20))
                .await
                .unwrap()
                .as_deref(),
            Some("first")
        );
        let started = std::time::Instant::now();
        assert!(stream.next_event(Duration::from_millis(20)).await.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "first-byte deadline leaked"
        );
    }

    #[tokio::test]
    async fn delivers_tail_and_transport_errors() {
        let mut stream = EventStream::new(futures::stream::iter([Ok::<_, &str>(
            b"data: tail".to_vec(),
        )]));
        assert_eq!(
            stream
                .next_event(Duration::from_secs(1))
                .await
                .unwrap()
                .as_deref(),
            Some("tail")
        );
        assert!(stream
            .next_event(Duration::from_secs(1))
            .await
            .unwrap()
            .is_none());
        let mut stream =
            EventStream::new(futures::stream::iter([Err::<Vec<u8>, _>("disconnected")]));
        assert!(stream.next_event(Duration::from_secs(1)).await.is_err());
    }
}
