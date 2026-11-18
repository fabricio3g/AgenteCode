// ── Peer ──────────────────────────────────────────────────────────────
// A bridge process that did not win the loopback port still has to serve
// tools: it keeps one socket to the hub and forwards every action through
// it, so a second Agente session drives the same browser as the first.
//
// The connection is kept alive in the background: the hub is usually the
// other session's process, and it dies when that session does.

use crate::driver::ActionResult;
use crate::pairing::Pairing;
use crate::protocol::{ClientInfo, Frame, Role};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const RECONNECT_MIN: Duration = Duration::from_millis(250);
const RECONNECT_MAX: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Inner {
    tx: Option<mpsc::UnboundedSender<Frame>>,
    pending: HashMap<String, oneshot::Sender<ActionResult>>,
    extension: Option<ClientInfo>,
    sequence: u64,
}

pub struct Peer {
    pairing: Pairing,
    inner: Mutex<Inner>,
}

impl Peer {
    /// Verify that a hub answers and speaks our protocol, then keep a
    /// connection to it for the life of the process.
    pub async fn start(pairing: Pairing) -> anyhow::Result<Arc<Self>> {
        probe(&pairing).await?;
        let peer = Arc::new(Self {
            pairing,
            inner: Mutex::new(Inner::default()),
        });
        tokio::spawn(reconnect_loop(Arc::clone(&peer)));
        Ok(peer)
    }
    pub fn extension(&self) -> Option<ClientInfo> {
        self.inner.lock().expect("peer state").extension.clone()
    }

    /// Forward one action to the hub, which forwards it to the browser.
    pub async fn request(&self, action: &str, args: Value) -> ActionResult {
        let (id, receiver) = {
            let mut inner = self.inner.lock().expect("peer state");
            let Some(tx) = inner.tx.clone() else {
                return ActionResult::error(crate::driver::offline_text(
                    &self.pairing,
                    &crate::driver::Offline::Unreachable("the hub is not connected yet".into()),
                ));
            };
            inner.sequence += 1;
            let id = format!("p{}", inner.sequence);
            let (sender, receiver) = oneshot::channel();
            inner.pending.insert(id.clone(), sender);
            let frame = Frame::Forward {
                id: id.clone(),
                action: action.to_string(),
                args,
            };
            if tx.send(frame).is_err() {
                inner.pending.remove(&id);
                return ActionResult::error(crate::driver::offline_text(
                    &self.pairing,
                    &crate::driver::Offline::Unreachable("the hub socket closed".into()),
                ));
            }
            (id, receiver)
        };

        match tokio::time::timeout(crate::hub::REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.forget(&id);
                ActionResult::error("The bridge hub disconnected while running the action.")
            }
            Err(_) => {
                self.forget(&id);
                ActionResult::error(format!(
                    "The browser did not answer {action} within {}s.",
                    crate::hub::REQUEST_TIMEOUT.as_secs()
                ))
            }
        }
    }

    fn forget(&self, id: &str) {
        self.inner.lock().expect("peer state").pending.remove(id);
    }

    fn set_connected(&self, tx: mpsc::UnboundedSender<Frame>, extension: Option<ClientInfo>) {
        let mut inner = self.inner.lock().expect("peer state");
        inner.tx = Some(tx);
        inner.extension = extension;
    }

    fn set_disconnected(&self) {
        let mut inner = self.inner.lock().expect("peer state");
        inner.tx = None;
        inner.extension = None;
        let pending: Vec<_> = inner.pending.drain().map(|(_, sender)| sender).collect();
        drop(inner);
        for sender in pending {
            let _ = sender.send(ActionResult::error(
                "The bridge hub went away before answering.",
            ));
        }
    }

    fn resolve(&self, id: &str, result: ActionResult) {
        let sender = self.inner.lock().expect("peer state").pending.remove(id);
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }
}

fn client_info() -> ClientInfo {
    ClientInfo {
        name: "agente-bridge".to_string(),
        version: crate::VERSION.to_string(),
        browser: None,
        capabilities: Vec::new(),
    }
}

async fn open(
    pairing: &Pairing,
) -> anyhow::Result<(
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Option<ClientInfo>,
)> {
    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}/", pairing.port)).await?;
    let hello = Frame::hello(&pairing.token, Role::Peer, client_info());
    socket
        .send(Message::text(serde_json::to_string(&hello)?))
        .await?;
    let extension = match socket.next().await {
        Some(Ok(Message::Text(text))) => match serde_json::from_str::<Frame>(&text)? {
            Frame::Welcome { extension, .. } => extension,
            Frame::Error { message } => anyhow::bail!("{message}"),
            _ => anyhow::bail!("the hub did not answer the hello"),
        },
        _ => anyhow::bail!("the hub closed the socket"),
    };
    Ok((socket, extension))
}

/// A short, disposable connection: does a hub answer at all, and which
/// browser is attached to it?
pub async fn probe(pairing: &Pairing) -> anyhow::Result<Option<ClientInfo>> {
    let (mut socket, extension) = tokio::time::timeout(PROBE_TIMEOUT, open(pairing))
        .await
        .map_err(|_| anyhow::anyhow!("the hub did not answer in time"))??;
    let _ = socket.close(None).await;
    Ok(extension)
}

async fn reconnect_loop(peer: Arc<Peer>) {
    let mut backoff = RECONNECT_MIN;
    loop {
        match connect_once(&peer).await {
            Ok(()) => backoff = RECONNECT_MIN,
            Err(error) => tracing::debug!(%error, "bridge hub connection ended"),
        }
        peer.set_disconnected();
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_MAX);
    }
}

async fn connect_once(peer: &Arc<Peer>) -> anyhow::Result<()> {
    let (socket, extension) = open(&peer.pairing).await?;
    let (mut sink, mut source) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Frame>();
    peer.set_connected(tx, extension);

    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let Ok(text) = serde_json::to_string(&frame) else {
                continue;
            };
            if sink.send(Message::text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    while let Some(message) = source.next().await {
        let Ok(Message::Text(text)) = message else {
            match message {
                Ok(Message::Close(_)) | Err(_) => break,
                _ => continue,
            }
        };
        let Ok(frame) = serde_json::from_str::<Frame>(&text) else {
            continue;
        };
        match frame {
            Frame::Result {
                id,
                ok,
                text,
                image,
                url,
            } => peer.resolve(
                &id,
                ActionResult {
                    ok,
                    text,
                    image,
                    url,
                },
            ),
            Frame::Ping { id } => {
                if let Some(tx) = peer.inner.lock().expect("peer state").tx.clone() {
                    let _ = tx.send(Frame::Pong { id });
                }
            }
            Frame::Error { message } => tracing::debug!(%message, "hub refused a frame"),
            _ => {}
        }
    }

    writer.abort();
    Ok(())
}
