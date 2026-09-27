//! JSON-RPC 2.0 wire layer: inbound-frame classification.
//!
//! ACP transports one JSON object per line. A line is classified as a request
//! (has `id` + `method`), a response (has `id`, no `method` — the answer to an
//! agent-issued request such as `session/request_permission`) or a
//! notification (no `id`). Unparseable lines become `FrameError` values so the
//! connection loop can answer `-32700`/`-32600` and keep going.

use serde_json::Value;

pub const PARSE_ERROR: i32 = -32700;
pub const INVALID_REQUEST: i32 = -32600;
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;
pub const INTERNAL_ERROR: i32 = -32603;

/// Why a line could not be turned into any JSON-RPC message.
#[derive(Debug)]
pub enum FrameError {
    /// The line is not valid JSON at all (`-32700`, id `null`).
    Parse(serde_json::Error),
    /// Valid JSON but not a single JSON-RPC message object (`-32600`, id `null`).
    NotAMessage,
    /// A message whose `jsonrpc` member is present but not `"2.0"`
    /// (`-32600`, echoing the id when one is detectable).
    UnsupportedProtocol(Value),
}

/// One inbound line, classified per the ACP transport.
#[derive(Debug)]
pub enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: Value,
        result: Option<Value>,
        error: Option<Value>,
    },
}

pub fn classify(line: &str) -> Result<Incoming, FrameError> {
    let value: Value = serde_json::from_str(line).map_err(FrameError::Parse)?;
    let object = value.as_object().ok_or(FrameError::NotAMessage)?;

    // A wrong `jsonrpc` version is an invalid request with the id echoed when
    // one is present; a missing member is tolerated for lenient transports.
    match object.get("jsonrpc") {
        None => {}
        Some(member) if member.as_str() == Some("2.0") => {}
        Some(_) => {
            return Err(match object.get("id") {
                Some(id) => FrameError::UnsupportedProtocol(id.clone()),
                None => FrameError::NotAMessage,
            });
        }
    }

    // The presence of the `id` key decides request vs notification, exactly
    // matching the transport rule (a JSON-RPC notification carries no `id`).
    let method = match object.get("method") {
        None => None,
        Some(Value::String(method)) => Some(method.clone()),
        Some(_) => return Err(FrameError::NotAMessage),
    };
    let params = object.get("params").cloned().unwrap_or(Value::Null);
    match (method, object.contains_key("id")) {
        (Some(method), true) => Ok(Incoming::Request {
            id: object.get("id").cloned().unwrap_or(Value::Null),
            method,
            params,
        }),
        (Some(method), false) => Ok(Incoming::Notification { method, params }),
        (None, true) => Ok(Incoming::Response {
            id: object.get("id").cloned().unwrap_or(Value::Null),
            result: object.get("result").cloned(),
            error: object.get("error").cloned(),
        }),
        (None, false) => Err(FrameError::NotAMessage),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn expect_request(line: &str) -> (Value, String, Value) {
        match classify(line).unwrap() {
            Incoming::Request { id, method, params } => (id, method, params),
            other => panic!("expected a request, got {other:?}"),
        }
    }

    fn expect_notification(line: &str) -> (String, Value) {
        match classify(line).unwrap() {
            Incoming::Notification { method, params } => (method, params),
            other => panic!("expected a notification, got {other:?}"),
        }
    }

    #[test]
    fn request_with_id_is_classified() {
        let (id, method, params) = expect_request(
            r#"{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{"sessionId":"s"}}"#,
        );
        assert_eq!(id, json!(7));
        assert_eq!(method, "session/prompt");
        assert_eq!(params["sessionId"], "s");
    }

    #[test]
    fn string_and_null_ids_round_trip() {
        let (id, ..) = expect_request(r#"{"id":"abc-1","method":"m"}"#);
        assert_eq!(id, json!("abc-1"));
        let (id, ..) = expect_request(r#"{"id":null,"method":"m"}"#);
        assert_eq!(id, Value::Null);
    }

    #[test]
    fn spec_notifications_are_classified_without_an_id() {
        let (method, params) = expect_notification(r#"{"jsonrpc":"2.0","method":"initialized"}"#);
        assert_eq!(method, "initialized");
        assert_eq!(params, Value::Null);

        let (method, params) = expect_notification(
            r#"{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}"#,
        );
        assert_eq!(method, "session/cancel");
        assert_eq!(params["sessionId"], "s");
    }

    #[test]
    fn missing_params_default_to_null() {
        let (.., params) = expect_request(r#"{"id":1,"method":"initialize"}"#);
        assert_eq!(params, Value::Null);
    }

    #[test]
    fn response_without_method_is_classified() {
        let line = r#"{"jsonrpc":"2.0","id":3,"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}"#;
        match classify(line).unwrap() {
            Incoming::Response { id, result, error } => {
                assert_eq!(id, json!(3));
                assert_eq!(result.unwrap()["outcome"]["optionId"], "allow_once");
                assert!(error.is_none());
            }
            other => panic!("expected a response, got {other:?}"),
        }
    }

    #[test]
    fn error_response_is_classified() {
        let line = r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32603,"message":"boom"}}"#;
        match classify(line).unwrap() {
            Incoming::Response { id, result, error } => {
                assert_eq!(id, json!(4));
                assert!(result.is_none());
                assert_eq!(error.unwrap()["code"], -32603);
            }
            other => panic!("expected a response, got {other:?}"),
        }
    }

    #[test]
    fn malformed_lines_report_frame_errors() {
        assert!(matches!(
            classify("this is not json"),
            Err(FrameError::Parse(_))
        ));
        assert!(matches!(classify("{ truncated"), Err(FrameError::Parse(_))));
        for line in [
            "[1, 2, 3]",
            r#""just a string""#,
            "42",
            "{}",
            r#"{"jsonrpc":"2.0"}"#,
        ] {
            assert!(
                matches!(classify(line), Err(FrameError::NotAMessage)),
                "line: {line}"
            );
        }
    }

    #[test]
    fn non_string_method_is_not_a_message() {
        assert!(matches!(
            classify(r#"{"method":42,"id":1}"#),
            Err(FrameError::NotAMessage)
        ));
    }

    #[test]
    fn wrong_jsonrpc_version_echoes_the_id() {
        match classify(r#"{"jsonrpc":"1.0","id":9,"method":"initialize"}"#).unwrap_err() {
            FrameError::UnsupportedProtocol(id) => assert_eq!(id, json!(9)),
            other => panic!("expected UnsupportedProtocol, got {other:?}"),
        }
        // No id to echo degrades to NotAMessage.
        assert!(matches!(
            classify(r#"{"jsonrpc":"1.0","method":"x"}"#),
            Err(FrameError::NotAMessage)
        ));
    }
}
