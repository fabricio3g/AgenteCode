// ── Driver ────────────────────────────────────────────────────────────
// One question — "run this browser action" — with three answers: this
// process owns the listener, another process does, or nobody has a browser
// at all. Only the third one is a dead end, and it says how to fix it.

use crate::hub::Hub;
use crate::pairing::Pairing;
use crate::peer::Peer;
use crate::protocol::{ClientInfo, ImagePayload};
use serde_json::Value;
use std::sync::Arc;

/// What a browser action answered, in the shape the tools already use.
#[derive(Debug, Clone, Default)]
pub struct ActionResult {
    pub ok: bool,
    /// Model-facing text: the page snapshot, the document, or the error.
    pub text: String,
    pub image: Option<ImagePayload>,
    pub url: Option<String>,
}

impl ActionResult {
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            ok: true,
            text: text.into(),
            ..Self::default()
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            ok: false,
            text: text.into(),
            ..Self::default()
        }
    }

    pub fn at(mut self, url: Option<String>) -> Self {
        self.url = url;
        self
    }

    pub fn with_image(mut self, image: Option<ImagePayload>) -> Self {
        self.image = image;
        self
    }
}

/// Why there is no browser to drive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Offline {
    /// The loopback port is held by something that is not a bridge.
    NoListener,
    /// A bridge is listening, but no browser extension is attached.
    NoBrowser,
    /// A peer bridge lost its hub.
    Unreachable(String),
}

/// The text a model gets when a browser action cannot run. Written to be
/// acted on: what is missing, and the one command that fixes it.
pub fn offline_text(pairing: &Pairing, reason: &Offline) -> String {
    match reason {
        Offline::NoListener => format!(
            "No Agente browser bridge is listening on 127.0.0.1:{}. Another program may hold that port, or the bridge failed to start. Run `agente bridge status` to see which.",
            pairing.port
        ),
        Offline::NoBrowser => format!(
            "No browser is connected to the Agente bridge. Open Chrome or Firefox with the Agente extension installed and connect it with the pairing code {} (side panel → Connect).",
            pairing.code()
        ),
        Offline::Unreachable(detail) => format!(
            "The Agente browser bridge lost its hub connection ({detail}) and is reconnecting. Retry in a moment."
        ),
    }
}

/// Where browser actions go.
pub enum Driver {
    Local(Arc<Hub>),
    Peer(Arc<Peer>),
    Offline { pairing: Pairing, reason: Offline },
}

impl Driver {
    pub fn offline(pairing: Pairing, reason: Offline) -> Self {
        Self::Offline { pairing, reason }
    }

    pub async fn request(&self, action: &str, args: Value) -> ActionResult {
        match self {
            Self::Local(hub) => hub.request(action, args).await,
            Self::Peer(peer) => peer.request(action, args).await,
            Self::Offline { pairing, reason } => ActionResult::error(offline_text(pairing, reason)),
        }
    }

    /// The attached browser, when there is one.
    pub fn extension(&self) -> Option<ClientInfo> {
        match self {
            Self::Local(hub) => hub.extension(),
            Self::Peer(peer) => peer.extension(),
            Self::Offline { .. } => None,
        }
    }

    /// One line for `agente bridge status` and the side panel.
    pub fn describe(&self) -> String {
        match self {
            Self::Local(hub) => match hub.extension() {
                Some(info) => format!(
                    "hub on 127.0.0.1:{} · {} connected",
                    hub.pairing().port,
                    info.label()
                ),
                None => format!(
                    "hub on 127.0.0.1:{} · no browser connected",
                    hub.pairing().port
                ),
            },
            Self::Peer(peer) => match peer.extension() {
                Some(info) => format!("connected to another bridge · {} attached", info.label()),
                None => "connected to another bridge · no browser attached".to_string(),
            },
            Self::Offline { pairing, reason } => {
                format!("offline · {}", offline_text(pairing, reason))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_text_names_the_next_step() {
        let pairing = Pairing::new(7391);
        let no_browser = offline_text(&pairing, &Offline::NoBrowser);
        assert!(no_browser.contains(&pairing.code()), "{no_browser}");
        assert!(no_browser.contains("extension"), "{no_browser}");
        let no_listener = offline_text(&pairing, &Offline::NoListener);
        assert!(no_listener.contains("7391"));
        assert!(no_listener.contains("agente bridge status"));
        let unreachable = offline_text(&pairing, &Offline::Unreachable("closed".into()));
        assert!(unreachable.contains("closed"));
    }

    #[tokio::test]
    async fn an_offline_driver_answers_every_action_with_that_text() {
        let driver = Driver::offline(Pairing::new(7391), Offline::NoBrowser);
        let result = driver.request("snapshot", serde_json::json!({})).await;
        assert!(!result.ok);
        assert!(result.text.contains("pairing code"));
        assert!(driver.extension().is_none());
    }
}
