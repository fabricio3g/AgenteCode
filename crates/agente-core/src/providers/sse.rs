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
}

impl<S> EventStream<S> {
    pub(crate) fn new(source: S) -> Self {
        Self {
            source,
            decoder: Decoder::default(),
            ended: false,
        }
    }
}

impl<S, B, E> EventStream<S>
where
    S: Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    /// Timeout measures raw transport inactivity, including provider keepalives.
    pub(crate) async fn next_event(&mut self, idle: Duration) -> Result<Option<String>, LlmError> {
        loop {
            if let Some(event) = self.decoder.events.pop_front() {
                return Ok(Some(event));
            }
            if self.ended {
                return Ok(None);
            }
            match tokio::time::timeout(idle, self.source.next()).await {
                Ok(Some(Ok(bytes))) => self.decoder.push(bytes.as_ref())?,
                Ok(Some(Err(e))) => return Err(LlmError::StreamError(e.to_string())),
                Ok(None) => {
                    self.ended = true;
                    self.decoder.finish()?;
                }
                Err(_) => {
                    return Err(LlmError::StreamError(format!(
                        "Stream stalled (no data for {}s).",
                        idle.as_secs()
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
