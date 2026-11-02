// ── Bridge frames ─────────────────────────────────────────────────────
// One WebSocket protocol, three roles: the browser extension, a bridge
// process that did not win the listener, and the hub itself. The hub is the
// only process a browser talks to; a peer bridge reaches the browser through
// it, so several Agente sessions share one connected browser.
//
// Every frame is JSON with a `type` tag and carries no binary: page
// screenshots ride as base64 inside `result.image`, which keeps the
// extension's service worker free of Blob/ArrayBuffer plumbing.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Who is on the other end of the socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// The browser extension: the only role that can drive a page.
    Extension,
    /// Another bridge process, forwarding tool calls to the hub's browser.
    Peer,
    /// Agente Desktop: answers the extension's chat panel with Home turns.
    App,
}

/// What the client says about itself in `hello`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientInfo {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    /// `chrome` / `firefox` / `edge` … when the client knows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<String>,
    /// Optional features the client can serve, e.g. `trusted_input`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
}

impl ClientInfo {
    pub fn label(&self) -> String {
        match (self.browser.as_deref(), self.name.is_empty()) {
            (Some(browser), false) => format!("{browser} ({})", self.name),
            (Some(browser), true) => browser.to_string(),
            (None, false) => self.name.clone(),
            (None, true) => "browser".to_string(),
        }
    }
}

/// A screenshot, base64 PNG/JPEG plus its mime type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImagePayload {
    pub data: String,
    pub mime: String,
}

/// Everything that crosses the socket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Frame {
    /// First frame from any client; the hub closes the socket if the token
    /// is wrong or the frame does not arrive within five seconds.
    Hello {
        token: String,
        role: Role,
        #[serde(default)]
        client: ClientInfo,
    },
    /// The hub's answer to `hello`.
    Welcome {
        version: String,
        role: Role,
        /// The extension already attached, so a peer can show its state.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        extension: Option<ClientInfo>,
        /// Agente Desktop, when it is attached to answer chat.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app: Option<ClientInfo>,
    },
    /// Hub → extension: Desktop came or went.
    Status {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app: Option<ClientInfo>,
    },
    /// Extension → hub → app: a chat request. The hub never reads `body`;
    /// its shape belongs to the extension and Desktop
    /// (`apps/desktop/shared/browser/chat-protocol.ts`).
    Chat {
        id: String,
        #[serde(default)]
        body: Value,
    },
    /// App → hub → extension: one answer or stream event for a chat request.
    ChatEvent {
        id: String,
        #[serde(default)]
        body: Value,
    },
    /// Hub → extension: do this, answer with `result` carrying the same id.
    Action {
        id: String,
        action: String,
        #[serde(default)]
        args: Value,
    },
    /// Extension → hub, or peer → hub, answering an `action`.
    Result {
        id: String,
        ok: bool,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image: Option<ImagePayload>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// Peer → hub: the same action/result pair, but the hub runs it against
    /// the attached extension and answers with `result`.
    Forward {
        id: String,
        action: String,
        #[serde(default)]
        args: Value,
    },
    /// Either direction: keeps a sleeping service worker awake and lets both
    /// sides notice a half-open socket.
    Ping {
        #[serde(default)]
        id: u64,
    },
    Pong {
        #[serde(default)]
        id: u64,
    },
    /// A refusal or a protocol problem; the hub never sends this instead of
    /// a `result` for a well-formed action.
    Error { message: String },
}

impl Frame {
    pub fn hello(token: &str, role: Role, client: ClientInfo) -> Self {
        Frame::Hello {
            token: token.to_string(),
            role,
            client,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Frame::Error {
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trip(frame: &Frame) -> Frame {
        let text = serde_json::to_string(frame).expect("serialize");
        serde_json::from_str(&text).expect("deserialize")
    }

    #[test]
    fn frames_survive_a_round_trip() {
        let frames = vec![
            Frame::hello("token", Role::Extension, ClientInfo::default()),
            Frame::Welcome {
                version: "0.2.3".into(),
                role: Role::Peer,
                extension: Some(ClientInfo {
                    name: "agente-extension".into(),
                    version: "0.1.0".into(),
                    browser: Some("firefox".into()),
                    capabilities: vec!["trusted_input".into()],
                }),
                app: None,
            },
            Frame::Status { app: None },
            Frame::Chat {
                id: "c1".into(),
                body: json!({"type": "send", "text": "hi"}),
            },
            Frame::ChatEvent {
                id: "c1".into(),
                body: json!({"type": "delta", "text": "hello"}),
            },
            Frame::Action {
                id: "1".into(),
                action: "snapshot".into(),
                args: json!({}),
            },
            Frame::Result {
                id: "1".into(),
                ok: true,
                text: "page".into(),
                image: Some(ImagePayload {
                    data: "AAA".into(),
                    mime: "image/png".into(),
                }),
                url: Some("https://example.com".into()),
            },
            Frame::Ping { id: 7 },
            Frame::error("no"),
        ];
        for frame in &frames {
            let back = round_trip(frame);
            assert_eq!(
                serde_json::to_value(frame).unwrap(),
                serde_json::to_value(&back).unwrap()
            );
        }
    }

    #[test]
    fn the_wire_shape_is_tagged_and_snake_case() {
        let value = serde_json::to_value(Frame::hello("t", Role::Peer, ClientInfo::default()))
            .expect("json");
        assert_eq!(value["type"], "hello");
        assert_eq!(value["role"], "peer");
        let action = serde_json::to_value(Frame::Action {
            id: "9".into(),
            action: "click".into(),
            args: json!({"ref": "e3"}),
        })
        .expect("json");
        assert_eq!(action["type"], "action");
        assert_eq!(action["args"]["ref"], "e3");
    }

    #[test]
    fn client_labels_read_like_a_person_wrote_them() {
        let chrome = ClientInfo {
            name: "agente-extension".into(),
            version: "0.1.0".into(),
            browser: Some("chrome".into()),
            capabilities: Vec::new(),
        };
        assert_eq!(chrome.label(), "chrome (agente-extension)");
        assert_eq!(ClientInfo::default().label(), "browser");
        assert_eq!(
            ClientInfo {
                browser: Some("firefox".into()),
                ..ClientInfo::default()
            }
            .label(),
            "firefox"
        );
    }
}
