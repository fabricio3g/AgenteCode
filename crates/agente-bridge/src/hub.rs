// ── Hub ───────────────────────────────────────────────────────────────
// The one process a browser talks to. The first bridge to bind the loopback
// port becomes the hub; later ones reach the browser through it as peers.
//
// The hub never invents page state: it forwards an action, waits for the
// browser's answer, and turns a silent browser into text a model can act on.

use crate::driver::{offline_text, ActionResult, Offline};
use crate::pairing::Pairing;
use crate::protocol::{ClientInfo, Frame, Role};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{Bytes, Message};

/// How long the browser has to answer one action before the tool gives up
/// with a sentence instead of hanging the turn.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
/// A client that does not say `hello` this fast is not one of ours.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const PING_INTERVAL: Duration = Duration::from_secs(20);
/// What the chat panel shows when nobody can answer it.
pub const NO_APP: &str = "Agente Desktop is not running. Open it to chat from the browser — your conversations are kept there.";

#[derive(Clone)]
struct Link {
    connection: u64,
    info: ClientInfo,
    tx: mpsc::UnboundedSender<Frame>,
}

#[derive(Default)]
struct Inner {
    extension: Option<Link>,
    /// Agente Desktop, answering the extension's chat panel.
    app: Option<Link>,
    pending: HashMap<String, oneshot::Sender<ActionResult>>,
    sequence: u64,
}

/// The loopback listener plus the extension attached to it.
pub struct Hub {
    pairing: Pairing,
    inner: Mutex<Inner>,
    connections: AtomicU64,
}

impl Hub {
    pub fn new(pairing: Pairing) -> Arc<Self> {
        Arc::new(Self {
            pairing,
            inner: Mutex::new(Inner::default()),
            connections: AtomicU64::new(0),
        })
    }

    /// Take the loopback port. Fails when another program holds it.
    pub async fn bind(pairing: &Pairing) -> std::io::Result<(Arc<Self>, TcpListener)> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, pairing.port)).await?;
        Ok((Self::new(pairing.clone()), listener))
    }

    /// Accept connections until the process ends.
    pub fn serve(self: &Arc<Self>, listener: TcpListener) -> tokio::task::JoinHandle<()> {
        let hub = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => hub.accept(stream),
                    Err(error) => {
                        tracing::warn!(%error, "bridge listener stopped accepting");
                        break;
                    }
                }
            }
        })
    }

    pub fn pairing(&self) -> &Pairing {
        &self.pairing
    }

    /// The attached browser, if one is connected.
    pub fn extension(&self) -> Option<ClientInfo> {
        self.inner
            .lock()
            .expect("hub state")
            .extension
            .as_ref()
            .map(|link| link.info.clone())
    }

    /// Ask the browser to run one action.
    pub async fn request(&self, action: &str, args: Value) -> ActionResult {
        let (id, receiver) = {
            let mut inner = self.inner.lock().expect("hub state");
            let Some(link) = inner.extension.clone() else {
                return ActionResult::error(offline_text(&self.pairing, &Offline::NoBrowser));
            };
            inner.sequence += 1;
            let id = format!("a{}", inner.sequence);
            let (sender, receiver) = oneshot::channel();
            inner.pending.insert(id.clone(), sender);
            let frame = Frame::Action {
                id: id.clone(),
                action: action.to_string(),
                args,
            };
            if link.tx.send(frame).is_err() {
                inner.pending.remove(&id);
                return ActionResult::error(offline_text(
                    &self.pairing,
                    &Offline::Unreachable("the browser socket closed".into()),
                ));
            }
            (id, receiver)
        };

        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.forget(&id);
                ActionResult::error(format!(
                    "The browser disconnected while running {action}. Reconnect the extension and retry."
                ))
            }
            Err(_) => {
                self.forget(&id);
                ActionResult::error(format!(
                    "The browser did not answer {action} within {}s — a modal dialog, a permission prompt or a sleeping tab will do that. Check the window and retry.",
                    REQUEST_TIMEOUT.as_secs()
                ))
            }
        }
    }

    fn forget(&self, id: &str) {
        self.inner.lock().expect("hub state").pending.remove(id);
    }

    fn accept(self: &Arc<Self>, stream: TcpStream) {
        let hub = Arc::clone(self);
        tokio::spawn(async move { hub.session(stream).await });
    }

    async fn session(self: Arc<Self>, stream: TcpStream) {
        let connection = self.connections.fetch_add(1, Ordering::Relaxed) + 1;
        let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
            return;
        };
        let (mut sink, mut source) = ws.split();

        // First frame must be `hello` with the pairing token.
        let hello = match tokio::time::timeout(HELLO_TIMEOUT, source.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Frame>(&text).ok(),
            _ => None,
        };
        let Some(Frame::Hello {
            token,
            role,
            client,
        }) = hello
        else {
            let _ = sink
                .send(Message::text(
                    serde_json::to_string(&Frame::error("Expected a hello frame"))
                        .unwrap_or_default(),
                ))
                .await;
            let _ = sink.close().await;
            return;
        };
        if token != self.pairing.token {
            let _ = sink
                .send(Message::text(
                    serde_json::to_string(&Frame::error(
                        "Wrong pairing token — copy the code from `agente bridge status`",
                    ))
                    .unwrap_or_default(),
                ))
                .await;
            let _ = sink.close().await;
            return;
        }

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Frame>();
        match role {
            Role::Extension => self.attach_extension(connection, client.clone(), out_tx.clone()),
            Role::App => self.attach_app(connection, client.clone(), out_tx.clone()),
            Role::Peer => {}
        }
        let welcome = Frame::Welcome {
            version: crate::VERSION.to_string(),
            role,
            extension: self.extension(),
            app: self.app(),
        };
        if out_tx.send(welcome).is_err() {
            return;
        }

        let writer = tokio::spawn(async move {
            let mut ping = tokio::time::interval(PING_INTERVAL);
            ping.tick().await;
            loop {
                tokio::select! {
                    frame = out_rx.recv() => match frame {
                        Some(frame) => {
                            let Ok(text) = serde_json::to_string(&frame) else { continue };
                            if sink.send(Message::text(text)).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    },
                    _ = ping.tick() => {
                        if sink.send(Message::Ping(Bytes::new())).await.is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = sink.close().await;
        });

        while let Some(message) = source.next().await {
            match message {
                Ok(Message::Text(text)) => {
                    if let Ok(frame) = serde_json::from_str::<Frame>(&text) {
                        self.on_frame(role, frame, &out_tx);
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }

        writer.abort();
        match role {
            Role::Extension => self.detach_extension(connection),
            Role::App => self.detach_app(connection),
            Role::Peer => {}
        }
    }

    fn on_frame(self: &Arc<Self>, role: Role, frame: Frame, out: &mpsc::UnboundedSender<Frame>) {
        match frame {
            // The extension's chat panel → Desktop. The hub only relays.
            Frame::Chat { id, body } if role == Role::Extension => {
                let app = self.inner.lock().expect("hub state").app.clone();
                let delivered = app.is_some_and(|app| {
                    app.tx
                        .send(Frame::Chat {
                            id: id.clone(),
                            body,
                        })
                        .is_ok()
                });
                if !delivered {
                    let _ = out.send(Frame::ChatEvent {
                        id,
                        body: serde_json::json!({
                            "type": "error",
                            "message": NO_APP,
                        }),
                    });
                }
            }
            // Desktop's answers → the extension.
            Frame::ChatEvent { id, body } if role == Role::App => {
                let extension = self.inner.lock().expect("hub state").extension.clone();
                if let Some(extension) = extension {
                    let _ = extension.tx.send(Frame::ChatEvent { id, body });
                }
            }
            Frame::Chat { .. } | Frame::ChatEvent { .. } | Frame::Status { .. } => {}
            Frame::Result {
                id,
                ok,
                text,
                image,
                url,
            } => {
                let sender = self.inner.lock().expect("hub state").pending.remove(&id);
                if let Some(sender) = sender {
                    let _ = sender.send(ActionResult {
                        ok,
                        text,
                        image,
                        url,
                    });
                }
            }
            // A peer bridge asking the hub to run an action on its behalf.
            Frame::Forward { id, action, args } => {
                let hub = Arc::clone(self);
                let out = out.clone();
                tokio::spawn(async move {
                    let result = hub.request(&action, args).await;
                    let _ = out.send(Frame::Result {
                        id,
                        ok: result.ok,
                        text: result.text,
                        image: result.image,
                        url: result.url,
                    });
                });
            }
            Frame::Ping { id } => {
                let _ = out.send(Frame::Pong { id });
            }
            Frame::Hello { .. } => {
                let _ = out.send(Frame::error("This socket is already paired"));
            }
            Frame::Pong { .. } => {}
            Frame::Action { .. } | Frame::Error { .. } | Frame::Welcome { .. } => {}
        }
    }

    /// The attached Desktop, if one is connected.
    pub fn app(&self) -> Option<ClientInfo> {
        self.inner
            .lock()
            .expect("hub state")
            .app
            .as_ref()
            .map(|link| link.info.clone())
    }

    /// Newest Desktop wins, like the extension; the extension hears about it
    /// so its chat panel can say whether anyone will answer.
    fn attach_app(&self, connection: u64, info: ClientInfo, tx: mpsc::UnboundedSender<Frame>) {
        let mut inner = self.inner.lock().expect("hub state");
        inner.app = Some(Link {
            connection,
            info: info.clone(),
            tx,
        });
        if let Some(extension) = &inner.extension {
            let _ = extension.tx.send(Frame::Status { app: Some(info) });
        }
    }

    fn detach_app(&self, connection: u64) {
        let mut inner = self.inner.lock().expect("hub state");
        if inner
            .app
            .as_ref()
            .is_some_and(|link| link.connection == connection)
        {
            inner.app = None;
            if let Some(extension) = &inner.extension {
                let _ = extension.tx.send(Frame::Status { app: None });
            }
        }
    }

    /// The newest extension socket wins: a restarted service worker
    /// reconnects before the old socket has noticed it is gone, and only the
    /// live one should receive actions.
    fn attach_extension(
        &self,
        connection: u64,
        info: ClientInfo,
        tx: mpsc::UnboundedSender<Frame>,
    ) {
        let mut inner = self.inner.lock().expect("hub state");
        inner.extension = Some(Link {
            connection,
            info,
            tx,
        });
    }

    fn detach_extension(&self, connection: u64) {
        let mut inner = self.inner.lock().expect("hub state");
        let is_current = inner
            .extension
            .as_ref()
            .is_some_and(|link| link.connection == connection);
        if !is_current {
            // A replaced socket closing late: the live one keeps its work.
            return;
        }
        inner.extension = None;
        // Every pending action needed that browser.
        let pending: Vec<_> = inner.pending.drain().map(|(_, sender)| sender).collect();
        drop(inner);
        for sender in pending {
            let _ = sender.send(ActionResult::error(
                "The browser disconnected before answering.",
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

    type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

    async fn start() -> (Arc<Hub>, u16) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let hub = Hub::new(Pairing::new(port));
        hub.serve(listener);
        (hub, port)
    }

    async fn send(socket: &mut Socket, frame: &Frame) {
        socket
            .send(Message::text(serde_json::to_string(frame).expect("json")))
            .await
            .expect("send");
    }

    /// The next JSON frame, skipping pings.
    async fn next(socket: &mut Socket) -> Frame {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
                .await
                .expect("a frame in time")
                .expect("open")
                .expect("ok");
            if let Message::Text(text) = message {
                return serde_json::from_str(&text).expect("frame");
            }
        }
    }

    async fn join(hub: &Hub, port: u16, role: Role, browser: Option<&str>) -> (Socket, Frame) {
        let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{port}/"))
            .await
            .expect("connect");
        let client = ClientInfo {
            name: format!("{role:?}"),
            browser: browser.map(str::to_string),
            ..ClientInfo::default()
        };
        send(
            &mut socket,
            &Frame::hello(&hub.pairing().token, role, client),
        )
        .await;
        let welcome = next(&mut socket).await;
        (socket, welcome)
    }

    #[tokio::test]
    async fn chat_is_relayed_between_the_extension_and_desktop() {
        let (hub, port) = start().await;
        let (mut extension, welcome) = join(&hub, port, Role::Extension, Some("chrome")).await;
        assert!(matches!(welcome, Frame::Welcome { app: None, .. }));

        // Nobody to answer yet: the panel hears why, at once.
        send(
            &mut extension,
            &Frame::Chat {
                id: "c1".into(),
                body: json!({"type": "send", "text": "hi"}),
            },
        )
        .await;
        match next(&mut extension).await {
            Frame::ChatEvent { id, body } => {
                assert_eq!(id, "c1");
                assert_eq!(body["type"], "error");
                assert!(body["message"].as_str().unwrap().contains("Desktop"));
            }
            other => panic!("unexpected {other:?}"),
        }

        // Desktop attaches; the extension is told.
        let (mut app, welcome) = join(&hub, port, Role::App, None).await;
        match welcome {
            Frame::Welcome {
                extension: Some(info),
                ..
            } => assert_eq!(info.browser.as_deref(), Some("chrome")),
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            next(&mut extension).await,
            Frame::Status { app: Some(_) }
        ));
        assert!(hub.app().is_some());

        // A chat goes to Desktop and its events come back.
        send(
            &mut extension,
            &Frame::Chat {
                id: "c2".into(),
                body: json!({"type": "send", "text": "sum this"}),
            },
        )
        .await;
        match next(&mut app).await {
            Frame::Chat { id, body } => {
                assert_eq!(id, "c2");
                assert_eq!(body["text"], "sum this");
            }
            other => panic!("unexpected {other:?}"),
        }
        send(
            &mut app,
            &Frame::ChatEvent {
                id: "c2".into(),
                body: json!({"type": "delta", "text": "Sure"}),
            },
        )
        .await;
        match next(&mut extension).await {
            Frame::ChatEvent { id, body } => {
                assert_eq!(id, "c2");
                assert_eq!(body["text"], "Sure");
            }
            other => panic!("unexpected {other:?}"),
        }

        // Desktop leaves; the extension is told again.
        drop(app);
        assert!(matches!(
            next(&mut extension).await,
            Frame::Status { app: None }
        ));
    }

    #[tokio::test]
    async fn a_wrong_token_is_refused() {
        let (_hub, port) = start().await;
        let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{port}/"))
            .await
            .expect("connect");
        send(
            &mut socket,
            &Frame::hello("wrong", Role::Extension, ClientInfo::default()),
        )
        .await;
        assert!(matches!(next(&mut socket).await, Frame::Error { .. }));
    }

    #[tokio::test]
    async fn actions_without_a_browser_say_how_to_connect_one() {
        let (hub, _port) = start().await;
        let result = hub.request("snapshot", json!({})).await;
        assert!(!result.ok);
        assert!(result.text.contains("pairing code"));
    }
}
