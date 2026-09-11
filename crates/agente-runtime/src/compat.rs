use agente_core::types as core;
use agente_protocol as protocol;

// Compatibility entrypoints are moves: both layers use the same protocol types.
pub(crate) fn conversation_to_core(messages: Vec<protocol::Message>) -> Vec<core::Message> {
    messages
}
pub(crate) fn conversation_from_core(messages: Vec<core::Message>) -> Vec<protocol::Message> {
    messages
}
