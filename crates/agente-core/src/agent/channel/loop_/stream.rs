//! Streaming consumer for a single provider completion request.

use std::collections::HashMap;
use std::time::Instant;

use tokio::sync::mpsc::Receiver;
use tokio::task::JoinHandle;

use crate::agent::channel::config::{send_event, UserInbox};
use crate::agent::channel::progress::StreamProgress;
use crate::agent::events::AgentEvent;
use crate::cancellation::AbortSignal;
use crate::catalog::ModelCost;
use crate::llm::{LlmError, StopReason, StreamEvent, Usage};
use crate::types::{FunctionCall, ProviderContinuation, ToolCall};

use super::TurnState;

pub(super) struct StreamCollected {
    pub full_response: String,
    pub full_reasoning: String,
    pub thinking_signature: Option<String>,
    pub continuation: Option<ProviderContinuation>,
    pub tool_calls: Vec<ToolCall>,
    pub stream_error: Option<String>,
    pub stop_reason: StopReason,
    pub received_output: bool,
    pub first_event_ms: Option<u128>,
    pub first_output_ms: Option<u128>,
}

pub(super) enum StreamOutcome {
    /// User steered or changed settings mid-stream; restart the iteration.
    Steered { partial_text: String },
    /// Turn was cancelled during streaming.
    Cancelled { partial_text: String },
    /// Stream ended normally or with an error.
    Completed {
        collected: Box<StreamCollected>,
        stream_result: Result<Usage, String>,
    },
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn consume_completion_stream(
    state: &mut TurnState,
    generation_progress: &mut StreamProgress,
    mut rx: Receiver<StreamEvent>,
    stream_handle: JoinHandle<Result<Usage, LlmError>>,
    user_inbox: Option<&UserInbox>,
    cancel_signal: &AbortSignal,
    price: &ModelCost,
    request_estimate: usize,
    request_started: Instant,
) -> StreamOutcome {
    let mut full_response = String::new();
    let mut full_reasoning = String::new();
    let mut thinking_signature: Option<String> = None;
    let mut continuation = None;
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut tool_call_accumulators: HashMap<String, (String, String)> = HashMap::new();
    let mut stream_error: Option<String> = None;
    let mut stream_stop_reason = StopReason::Unknown;
    let mut received_output = false;
    let mut first_event_ms: Option<u128> = None;
    let mut first_output_ms: Option<u128> = None;
    let mut steered = false;

    loop {
        tokio::select! {
            // Once a tool call starts, finish the provider response and
            // tool round before injecting input. Incomplete tool pairs or
            // unsigned thinking must never be replayed to a provider.
            _ = async {
                match user_inbox {
                    Some(inbox) => inbox.wait_interrupt().await,
                    None => std::future::pending::<()>().await,
                }
            }, if tool_calls.is_empty() && tool_call_accumulators.is_empty() => {
                if user_inbox.is_some_and(|inbox| !inbox.lock().is_empty() || inbox.has_settings_update()) {
                    stream_handle.abort();
                    steered = true;
                    break;
                }
            }
            event = rx.recv() => {
                match event {
                    Some(event) => match event {
                        StreamEvent::TextDelta(text) => {
                            received_output |= !text.is_empty();
                            generation_progress.record(text.len(), None, &state.sender, state.task_id);
                            full_response.push_str(&text);
                            send_event(&state.sender, state.task_id, AgentEvent::TextDelta(text.clone()));
                            if text.len() > 10 {
                                tokio::task::yield_now().await;
                            }
                        }
                        StreamEvent::TextStart | StreamEvent::TextEnd => {}
                        StreamEvent::ReasoningDelta(text) => {
                            received_output |= !text.is_empty();
                            generation_progress.record(text.len(), None, &state.sender, state.task_id);
                            full_reasoning.push_str(&text);
                            send_event(&state.sender, state.task_id, AgentEvent::ReasoningDelta(text));
                        }
                        StreamEvent::ReasoningStart | StreamEvent::ReasoningEnd => {}
                        StreamEvent::ThinkingSignature(sig) => {
                            received_output = true;
                            thinking_signature = Some(sig);
                        }
                        StreamEvent::Continuation(value) => {
                            received_output = true;
                            continuation = Some(value);
                        }
                        StreamEvent::ToolCallStart { name, id } => {
                            received_output = true;
                            generation_progress.record(0, Some(&name), &state.sender, state.task_id);
                            tool_call_accumulators.insert(id.clone(), (name, String::new()));
                        }
                        StreamEvent::ToolCallDelta { id, args_delta } => {
                            received_output |= !args_delta.is_empty();
                            if let Some((name, accumulated)) = tool_call_accumulators.get_mut(&id) {
                                generation_progress.record(args_delta.len(), Some(name), &state.sender, state.task_id);
                                accumulated.push_str(&args_delta);
                            }
                        }
                        StreamEvent::ToolCallEnd { id } => {
                            received_output = true;
                            if let Some((name, args)) = tool_call_accumulators.remove(&id) {
                                tool_calls.push(ToolCall {
                                    id: id.clone(),
                                    call_type: "function".to_string(),
                                    function: FunctionCall {
                                        name: name.clone(),
                                        arguments: args.clone(),
                                    },
                                });
                                send_event(&state.sender, state.task_id, AgentEvent::ToolCallStart {
                                    id: id.clone(),
                                    name: name.clone(),
                                    args: args.clone(),
                                });
                            }
                        }
                        StreamEvent::Done { usage, stop_reason } => {
                            state.record_completion_usage(&usage, price, request_estimate);
                            stream_stop_reason = stop_reason;
                            break;
                        }
                        StreamEvent::Error(msg) => {
                            stream_error = Some(msg);
                            break;
                        }
                    },
                    None => break,
                }
                first_event_ms.get_or_insert_with(|| request_started.elapsed().as_millis());
                if received_output {
                    first_output_ms.get_or_insert_with(|| request_started.elapsed().as_millis());
                }
            }
            _ = cancel_signal.wait_aborted() => {
                tracing::info!("Chat task cancelled during streaming");
                stream_handle.abort();
                generation_progress.finish_request(&state.sender, state.task_id);
                return StreamOutcome::Cancelled {
                    partial_text: full_response,
                };
            }
        }
    }

    generation_progress.finish_request(&state.sender, state.task_id);
    // A provider must not remain blocked sending after its terminal event.
    drop(rx);

    if steered {
        let _ = stream_handle.await;
        return StreamOutcome::Steered {
            partial_text: full_response,
        };
    }

    let stream_result = match stream_handle.await {
        Ok(Ok(usage)) => Ok(usage),
        Ok(Err(e)) => Err(format!("Stream error: {e}")),
        Err(e) => Err(format!("Task join error: {e}")),
    };

    StreamOutcome::Completed {
        collected: Box::new(StreamCollected {
            full_response,
            full_reasoning,
            thinking_signature,
            continuation,
            tool_calls,
            stream_error,
            stop_reason: stream_stop_reason,
            received_output,
            first_event_ms,
            first_output_ms,
        }),
        stream_result,
    }
}
