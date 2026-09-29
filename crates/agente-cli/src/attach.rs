//! `agente attach`: join a live session (or a bot's chat) on a running
//! `agente serve`, from a second terminal or another machine. Turns started
//! anywhere stream here; lines typed here become new turns, or steer the
//! turn that is running. Approvals are answered inline.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agente_protocol::{Message, RuntimeEvent, RuntimeEventEnvelope};
use anyhow::{anyhow, bail, Context};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

pub struct AttachOptions {
    /// A session id (or a unique prefix), `@handle` for a bot, or nothing
    /// for the most recent session.
    pub target: Option<String>,
    pub socket: Option<PathBuf>,
    /// `host:port` of a remote `agente serve --listen`.
    pub remote: Option<String>,
    pub token: Option<String>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// A JSON-RPC connection to the daemon.
struct Client {
    outbox: mpsc::UnboundedSender<Value>,
    pending: Pending,
    next_id: std::sync::atomic::AtomicU64,
}

impl Client {
    fn start<R, W>(reader: R, writer: W) -> (Self, mpsc::UnboundedReceiver<(String, Value)>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (outbox, mut outgoing) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            let mut writer = writer;
            while let Some(message) = outgoing.recv().await {
                let mut line = serde_json::to_vec(&message).unwrap_or_default();
                line.push(b'\n');
                if writer.write_all(&line).await.is_err() || writer.flush().await.is_err() {
                    break;
                }
            }
        });
        let pending: Pending = Arc::default();
        let (notify, notifications) = mpsc::unbounded_channel();
        let replies = Arc::clone(&pending);
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    let reply = match message.get("error") {
                        Some(error) => {
                            Err(error["message"].as_str().unwrap_or("error").to_string())
                        }
                        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    if let Some(waiter) = lock(&replies).remove(&id) {
                        let _ = waiter.send(reply);
                    }
                } else if let Some(method) = message.get("method").and_then(Value::as_str) {
                    let params = message.get("params").cloned().unwrap_or(Value::Null);
                    if notify.send((method.to_string(), params)).is_err() {
                        break;
                    }
                }
            }
            // The daemon went away: fail whoever is still waiting.
            for (_, waiter) in lock(&replies).drain() {
                let _ = waiter.send(Err("the connection to agente closed".into()));
            }
        });
        let client = Self {
            outbox,
            pending,
            next_id: std::sync::atomic::AtomicU64::new(1),
        };
        (client, notifications)
    }

    async fn call(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (reply, waiting) = oneshot::channel();
        lock(&self.pending).insert(id, reply);
        self.outbox
            .send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .map_err(|_| anyhow!("the connection to agente closed"))?;
        waiting
            .await
            .map_err(|_| anyhow!("the connection to agente closed"))?
            .map_err(|message| anyhow!("{method}: {message}"))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

type Stream = (
    Box<dyn AsyncRead + Unpin + Send>,
    Box<dyn AsyncWrite + Unpin + Send>,
);

async fn connect(options: &AttachOptions) -> anyhow::Result<Stream> {
    if let Some(remote) = &options.remote {
        let stream = tokio::net::TcpStream::connect(remote)
            .await
            .with_context(|| format!("connect to {remote}"))?;
        let (reader, writer) = stream.into_split();
        return Ok((Box::new(reader), Box::new(writer)));
    }
    let path = options
        .socket
        .clone()
        .unwrap_or_else(agente_daemon::default_socket_path);
    connect_local(&path).await.with_context(|| {
        format!(
            "no agente serve on {} (start it with `agente serve`)",
            path.display()
        )
    })
}

#[cfg(unix)]
async fn connect_local(path: &std::path::Path) -> std::io::Result<Stream> {
    let stream = tokio::net::UnixStream::connect(path).await?;
    let (reader, writer) = stream.into_split();
    Ok((Box::new(reader), Box::new(writer)))
}

#[cfg(windows)]
async fn connect_local(path: &std::path::Path) -> std::io::Result<Stream> {
    let pipe = tokio::net::windows::named_pipe::ClientOptions::new().open(path.as_os_str())?;
    let (reader, writer) = tokio::io::split(pipe);
    Ok((Box::new(reader), Box::new(writer)))
}

#[cfg(not(any(unix, windows)))]
async fn connect_local(_path: &std::path::Path) -> std::io::Result<Stream> {
    Err(std::io::Error::other("not supported on this platform"))
}

/// What the attached terminal talks to.
enum Target {
    Session {
        id: String,
        title: String,
    },
    Bot {
        handle: String,
        title: String,
        session: Option<String>,
    },
}

impl Target {
    fn session(&self) -> Option<&str> {
        match self {
            Target::Session { id, .. } => Some(id),
            Target::Bot { session, .. } => session.as_deref(),
        }
    }
}

/// The session `query` names: an exact id, else the one id it starts, else
/// (no query) the most recently active one.
fn pick_session(sessions: &[Value], query: Option<&str>) -> anyhow::Result<(String, String)> {
    let id_of = |session: &Value| {
        session["session_id"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    };
    let title_of = |session: &Value| {
        let title = session["title"].as_str().unwrap_or_default();
        let first = session["first_prompt"].as_str().unwrap_or_default();
        if title.is_empty() { first } else { title }.to_string()
    };
    let chosen = match query {
        None => sessions
            .iter()
            .max_by_key(|session| {
                session["last_active"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            })
            .ok_or_else(|| anyhow!("there are no sessions yet; name a bot with @handle"))?,
        Some(query) => {
            let matches: Vec<&Value> = sessions
                .iter()
                .filter(|session| id_of(session).starts_with(query))
                .collect();
            match matches.as_slice() {
                [one] => *one,
                [] => bail!("no session starts with {query}"),
                _ => bail!(
                    "{query} matches {} sessions; type more of the id",
                    matches.len()
                ),
            }
        }
    };
    Ok((id_of(chosen), title_of(chosen)))
}

async fn resolve(client: &Client, target: Option<&str>) -> anyhow::Result<Target> {
    if let Some(handle) = target.and_then(|target| target.strip_prefix('@')) {
        let bot = client.call("bots.get", json!({ "handle": handle })).await?;
        return Ok(Target::Bot {
            handle: handle.to_string(),
            title: bot["title"].as_str().unwrap_or(handle).to_string(),
            session: bot["session_id"].as_str().map(str::to_string),
        });
    }
    let sessions = client.call("session.list", Value::Null).await?;
    let sessions = sessions.as_array().cloned().unwrap_or_default();
    let (id, title) = pick_session(&sessions, target)?;
    Ok(Target::Session { id, title })
}

/// Text to print for an event, if any.
fn render(event: &RuntimeEvent) -> Option<String> {
    let line = |text: String| Some(format!("\n{text}\n"));
    match event {
        RuntimeEvent::TurnStarted => Some("\n".into()),
        RuntimeEvent::AssistantDelta { text } => Some(text.clone()),
        RuntimeEvent::ToolProposed {
            name, arguments, ..
        } => line(format!("  · {name} {}", shorten(arguments, 100))),
        RuntimeEvent::ToolResult {
            name,
            content,
            is_error: true,
            ..
        } => line(format!("  ✗ {name}: {}", shorten(content, 200))),
        RuntimeEvent::ApprovalRequested {
            tool_name,
            description,
            ..
        } => Some(format!(
            "\n? Allow {tool_name}: {} — [y]es / [a]lways / [n]o: ",
            shorten(description, 200)
        )),
        RuntimeEvent::TurnFinished { .. } => Some("\n".into()),
        RuntimeEvent::TurnCancelled { .. } => line("(cancelled)".into()),
        RuntimeEvent::TurnFailed { message } => line(format!("error: {message}")),
        _ => None,
    }
}

fn shorten(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    format!("{}…", flat.chars().take(max).collect::<String>())
}

/// An approval answer from a typed line.
fn decision(answer: &str) -> Option<&'static str> {
    match answer.trim().to_lowercase().as_str() {
        "y" | "yes" | "s" | "si" | "sí" => Some("approve_once"),
        "a" | "all" | "always" => Some("approve_all"),
        "n" | "no" => Some("deny"),
        _ => None,
    }
}

pub fn run(options: AttachOptions) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(attach(options))
}

async fn attach(options: AttachOptions) -> anyhow::Result<()> {
    let (reader, writer) = connect(&options).await?;
    let (client, mut notifications) = Client::start(reader, writer);
    let token = options
        .token
        .clone()
        .filter(|token| !token.trim().is_empty());
    if options.remote.is_some() && token.is_none() {
        bail!("a remote agente needs its token: pass --token or set AGENTE_TOKEN");
    }
    client.call("initialize", json!({ "token": token })).await?;
    let mut target = resolve(&client, options.target.as_deref()).await?;
    if let Some(session) = target.session() {
        client
            .call("events.subscribe", json!({ "session_ids": [session] }))
            .await?;
    }
    match &target {
        Target::Session { id, title } => eprintln!("Attached to {title} ({id})."),
        Target::Bot { handle, title, .. } => eprintln!("Attached to {title} (@{handle})."),
    }
    eprintln!("Type a message and press Enter. /stop cancels the running turn, /quit leaves.");

    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    let mut running: Option<String> = None;
    let mut approval: Option<String> = None;
    loop {
        tokio::select! {
            line = stdin.next_line() => {
                let Some(line) = line? else { break };
                let text = line.trim();
                if text.is_empty() {
                    continue;
                }
                if let Some(request_id) = approval.clone() {
                    match decision(text) {
                        Some(kind) => {
                            client.call("approval.respond", json!({ "request_id": request_id, "decision": kind })).await?;
                            approval = None;
                        }
                        None => eprint!("Answer y, a or n: "),
                    }
                    continue;
                }
                match text {
                    "/quit" | "/exit" => break,
                    "/stop" => {
                        if let Some(turn_id) = &running {
                            client.call("turn.cancel", json!({ "turn_id": turn_id })).await?;
                        }
                    }
                    _ => {
                        if let Some(turn_id) = &running {
                            client.call("turn.steer", json!({ "turn_id": turn_id, "content": text })).await?;
                            eprintln!("(added to the running turn)");
                        } else {
                            send(&client, &mut target, text).await?;
                        }
                    }
                }
            }
            notification = notifications.recv() => {
                let Some((method, params)) = notification else {
                    eprintln!("\nagente closed the connection.");
                    break;
                };
                if method != "event" {
                    continue;
                }
                let Ok(envelope) = serde_json::from_value::<RuntimeEventEnvelope>(params) else {
                    continue;
                };
                if target.session() != Some(envelope.session_id.to_string().as_str()) {
                    continue;
                }
                if envelope.event.is_terminal() {
                    running = None;
                    approval = None;
                } else {
                    running = Some(envelope.turn_id.to_string());
                }
                if let RuntimeEvent::ApprovalRequested { request_id, .. } = &envelope.event {
                    approval = Some(request_id.clone());
                }
                if let Some(text) = render(&envelope.event) {
                    print!("{text}");
                    let _ = std::io::stdout().flush();
                }
            }
        }
    }
    Ok(())
}

/// Start a turn with `text` in the target's session.
async fn send(client: &Client, target: &mut Target, text: &str) -> anyhow::Result<()> {
    match target {
        Target::Session { id, .. } => {
            client
                .call(
                    "turn.start",
                    json!({ "session_id": id, "prompt": Message::user(text) }),
                )
                .await?;
        }
        Target::Bot {
            handle, session, ..
        } => {
            let started = client
                .call("bots.chat", json!({ "handle": handle, "text": text }))
                .await?;
            // A bot's first message makes its session: follow it from now on.
            if session.is_none() {
                let id = started["session_id"].as_str().map(str::to_string);
                if let Some(id) = &id {
                    client
                        .call("events.subscribe", json!({ "session_ids": [id] }))
                        .await?;
                }
                *session = id;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_are_picked_by_prefix_or_recency() {
        let sessions = vec![
            json!({ "session_id": "aaa111", "title": "Old", "last_active": "2026-09-01T00:00:00Z" }),
            json!({ "session_id": "aab222", "title": "", "first_prompt": "hello", "last_active": "2026-09-02T00:00:00Z" }),
        ];
        assert_eq!(
            pick_session(&sessions, None).unwrap(),
            ("aab222".into(), "hello".into())
        );
        assert_eq!(pick_session(&sessions, Some("aaa")).unwrap().0, "aaa111");
        assert!(pick_session(&sessions, Some("aa")).is_err());
        assert!(pick_session(&sessions, Some("zz")).is_err());
        assert!(pick_session(&[], None).is_err());
    }

    #[test]
    fn events_render_as_a_transcript() {
        assert_eq!(
            render(&RuntimeEvent::AssistantDelta { text: "hi".into() }).unwrap(),
            "hi"
        );
        let tool = render(&RuntimeEvent::ToolProposed {
            id: "1".into(),
            name: "read".into(),
            arguments: "{\"path\":\n\"a.rs\"}".into(),
        })
        .unwrap();
        assert_eq!(tool, "\n  · read {\"path\": \"a.rs\"}\n");
        assert!(render(&RuntimeEvent::Thinking).is_none());
        assert!(render(&RuntimeEvent::TurnFailed {
            message: "boom".into()
        })
        .unwrap()
        .contains("error: boom"));
    }

    #[test]
    fn approvals_take_short_answers() {
        assert_eq!(decision(" Y "), Some("approve_once"));
        assert_eq!(decision("a"), Some("approve_all"));
        assert_eq!(decision("no"), Some("deny"));
        assert_eq!(decision("maybe"), None);
    }
}
