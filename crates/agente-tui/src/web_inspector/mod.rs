//! Live interactive Web Inspector & Debug Server.
//!
//! Serves an interactive visual studio in the browser, allowing developers to:
//! - View and interact with live TUI frames in real-time
//! - Send keyboard (`App::handle_key`) and mouse (`App::handle_mouse`) events
//! - Dynamically resize the virtual terminal
//! - Simulate agent lifecycle turns (token streaming, tool executions, approvals, errors, compaction)
//! - Inspect live [`AppState`] and layout invariants (theme holes, wide glyphs)

use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, oneshot};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::backend::TestBackend;
use ratatui::Terminal;

use agente_core::agent::ApprovalSource;
use agente_core::config::AppConfig;
use agente_core::types::{AgentMode, AgentState, ApprovalRequest, ChatEntry, Role};

use crate::app::App;
use crate::state::AppState;
use crate::web_export::{serialize_buffer, SerializedFrame};

enum InspectorCmd {
    RenderFrame(oneshot::Sender<SerializedFrame>),
    DispatchAction(serde_json::Value, oneshot::Sender<()>),
    GetState(oneshot::Sender<serde_json::Value>),
}

pub struct InspectorServer {
    cmd_tx: mpsc::Sender<InspectorCmd>,
    broadcast_tx: broadcast::Sender<String>,
}

impl Default for InspectorServer {
    fn default() -> Self {
        Self::new()
    }
}

fn configure_demo_state(state: &mut AppState) {
    state.config.current_provider = "deepseek".to_string();
    state.config.current_model = "deepseek-v4-flash".to_string();
    state.config.connected_providers = vec!["deepseek".to_string()];
    state.ui.show_welcome_screen = false;
}

impl InspectorServer {
    pub fn new() -> Self {
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<InspectorCmd>(100);
        let (broadcast_tx, _) = broadcast::channel(100);

        // Spawn dedicated single-thread actor owning a real headless `App` so
        // keyboard and mouse events run through the genuine TUI handlers.
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("inspector runtime");
            let mut app = App::new_headless(
                AppConfig::default(),
                "/home/dev/agente".to_string(),
                runtime,
            )
            .expect("headless app");
            configure_demo_state(&mut app.state);

            let mut width: u16 = 100;
            let mut height: u16 = 30;

            while let Some(cmd) = cmd_rx.blocking_recv() {
                match cmd {
                    InspectorCmd::RenderFrame(reply) => {
                        let backend = TestBackend::new(width, height);
                        let mut terminal = Terminal::new(backend).expect("test terminal");
                        terminal
                            .draw(|frame| crate::app::render_app(frame, &mut app.state))
                            .expect("draw");
                        let buf = terminal.backend().buffer().clone();
                        let serialized = serialize_buffer(&buf);
                        let _ = reply.send(serialized);
                    }
                    InspectorCmd::DispatchAction(action, reply) => {
                        dispatch_actor_action(&mut app, &mut width, &mut height, action);
                        let _ = reply.send(());
                    }
                    InspectorCmd::GetState(reply) => {
                        let state = &app.state;
                        let summary = serde_json::json!({
                            "mode": format!("{:?}", state.agent.mode),
                            "agent_state": format!("{:?}", state.agent.state),
                            "total_tokens": state.agent.total_tokens,
                            "current_provider": state.config.current_provider,
                            "current_model": state.config.current_model,
                            "chat_history_len": state.session.chat_history.len(),
                            "message_queue": state.agent.message_queue.iter().map(|m| m.display.as_str()).collect::<Vec<_>>(),
                            "modified_files": state.session.modified_files,
                            "todo_count": state.todo.count(),
                            "subagents_count": state.agent.subagents.len(),
                            "input_text": state.input.input_text,
                            "input_cursor": state.input.input_cursor,
                        });
                        let _ = reply.send(summary);
                    }
                }
            }
        });

        Self {
            cmd_tx,
            broadcast_tx,
        }
    }

    /// Render the current state to a [`SerializedFrame`].
    pub(crate) async fn render_frame(&self) -> SerializedFrame {
        let (tx, rx) = oneshot::channel();
        let _ = self.cmd_tx.send(InspectorCmd::RenderFrame(tx)).await;
        rx.await.unwrap_or_else(|_| SerializedFrame {
            width: 80,
            height: 24,
            rows: Vec::new(),
            theme_holes: Vec::new(),
            violations: Vec::new(),
            raw_text: String::new(),
        })
    }

    /// Broadcast the newly rendered frame to all connected SSE clients.
    pub(crate) async fn broadcast_frame(&self) {
        let frame = self.render_frame().await;
        let payload = serde_json::json!({
            "type": "frame",
            "frame": frame,
            "html": crate::web_export::frame_to_html_snippet(&frame),
        });
        let _ = self.broadcast_tx.send(payload.to_string());
    }

    /// Run the HTTP/SSE server on the specified port.
    pub async fn run(self: Arc<Self>, port: u16) -> anyhow::Result<()> {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(_) => {
                let fallback = SocketAddr::from(([127, 0, 0, 1], port + 1));
                TcpListener::bind(fallback).await?
            }
        };

        let actual_port = listener.local_addr()?.port();
        let url = format!("http://127.0.0.1:{actual_port}");
        println!("◈ Agente TUI Studio & Live Inspector running at: {url}");
        println!("  Press Ctrl+C to stop.");

        // Open browser automatically
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
            #[cfg(target_os = "windows")]
            let _ = std::process::Command::new("cmd")
                .args(["/c", "start", &url])
                .spawn();
            #[cfg(target_os = "macos")]
            let _ = std::process::Command::new("open").arg(&url).spawn();
            #[cfg(target_os = "linux")]
            let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
        });

        loop {
            let (stream, _) = listener.accept().await?;
            let server = self.clone();
            tokio::spawn(async move {
                let _ = server.handle_connection(stream).await;
            });
        }
    }

    async fn handle_connection(&self, mut stream: TcpStream) -> anyhow::Result<()> {
        let mut buffer = [0u8; 16384];
        let bytes_read = stream.read(&mut buffer).await?;
        if bytes_read == 0 {
            return Ok(());
        }

        let request = String::from_utf8_lossy(&buffer[..bytes_read]);
        let mut lines = request.lines();
        let request_line = lines.next().unwrap_or("");
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("GET");
        let path = parts.next().unwrap_or("/");

        if path.starts_with("/api/events") {
            let headers = "HTTP/1.1 200 OK\r\n\
                           Content-Type: text/event-stream\r\n\
                           Cache-Control: no-cache\r\n\
                           Connection: keep-alive\r\n\
                           Access-Control-Allow-Origin: *\r\n\r\n";
            stream.write_all(headers.as_bytes()).await?;

            let mut rx = self.broadcast_tx.subscribe();

            let initial_frame = self.render_frame().await;
            let initial_payload = serde_json::json!({
                "type": "frame",
                "frame": initial_frame,
                "html": crate::web_export::frame_to_html_snippet(&initial_frame),
            });
            let sse_msg = format!("data: {initial_payload}\n\n");
            stream.write_all(sse_msg.as_bytes()).await?;

            loop {
                tokio::select! {
                    msg = rx.recv() => {
                        match msg {
                            Ok(data) => {
                                let sse_data = format!("data: {data}\n\n");
                                if stream.write_all(sse_data.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
        } else if path.starts_with("/api/action") && method == "POST" {
            let body = if let Some(idx) = request.find("\r\n\r\n") {
                &request[idx + 4..]
            } else {
                ""
            };

            let response_body = match serde_json::from_str::<serde_json::Value>(body) {
                Ok(action) => {
                    let (tx, rx) = oneshot::channel();
                    let _ = self
                        .cmd_tx
                        .send(InspectorCmd::DispatchAction(action, tx))
                        .await;
                    let _ = rx.await;
                    self.broadcast_frame().await;
                    serde_json::json!({ "status": "ok" }).to_string()
                }
                Err(e) => {
                    serde_json::json!({ "status": "error", "message": e.to_string() }).to_string()
                }
            };

            let response = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: application/json\r\n\
                 Content-Length: {}\r\n\
                 Access-Control-Allow-Origin: *\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream.write_all(response.as_bytes()).await?;
        } else if path.starts_with("/api/state") {
            let (tx, rx) = oneshot::channel();
            let _ = self.cmd_tx.send(InspectorCmd::GetState(tx)).await;
            let summary = rx.await.unwrap_or_else(|_| serde_json::json!({}));
            let body = summary.to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: application/json\r\n\
                 Content-Length: {}\r\n\
                 Access-Control-Allow-Origin: *\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await?;
        } else {
            let html = get_studio_html();
            let response = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: text/html; charset=utf-8\r\n\
                 Content-Length: {}\r\n\
                 Connection: close\r\n\r\n{}",
                html.len(),
                html
            );
            stream.write_all(response.as_bytes()).await?;
        }

        Ok(())
    }
}

/// Translate a browser `KeyboardEvent` JSON payload into a crossterm [`KeyEvent`].
fn parse_web_key_event(action: &serde_json::Value) -> Option<KeyEvent> {
    let key_code = action.get("key").and_then(|v| v.as_str()).unwrap_or("");
    let mut modifiers = KeyModifiers::empty();
    if action
        .get("ctrl")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        modifiers.insert(KeyModifiers::CONTROL);
    }
    if action
        .get("shift")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        modifiers.insert(KeyModifiers::SHIFT);
    }
    if action.get("alt").and_then(|v| v.as_bool()).unwrap_or(false) {
        modifiers.insert(KeyModifiers::ALT);
    }

    let code = match key_code {
        "Enter" => KeyCode::Enter,
        "Escape" => KeyCode::Esc,
        "Backspace" => KeyCode::Backspace,
        "Delete" => KeyCode::Delete,
        "Tab" => {
            if modifiers.contains(KeyModifiers::SHIFT) {
                KeyCode::BackTab
            } else {
                KeyCode::Tab
            }
        }
        "ArrowUp" => KeyCode::Up,
        "ArrowDown" => KeyCode::Down,
        "ArrowLeft" => KeyCode::Left,
        "ArrowRight" => KeyCode::Right,
        "PageUp" => KeyCode::PageUp,
        "PageDown" => KeyCode::PageDown,
        "Home" => KeyCode::Home,
        "End" => KeyCode::End,
        "F1" => KeyCode::F(1),
        "F2" => KeyCode::F(2),
        s if s.chars().count() == 1 => KeyCode::Char(s.chars().next()?),
        _ => return None,
    };

    Some(KeyEvent::new(code, modifiers))
}

fn dispatch_actor_action(
    app: &mut App,
    width: &mut u16,
    height: &mut u16,
    action: serde_json::Value,
) {
    let action_type = action.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match action_type {
        "resize" => {
            *width = action.get("width").and_then(|v| v.as_u64()).unwrap_or(100) as u16;
            *height = action.get("height").and_then(|v| v.as_u64()).unwrap_or(30) as u16;
        }
        "set_theme" => {
            let theme = action
                .get("theme")
                .and_then(|v| v.as_str())
                .unwrap_or("dark");
            match theme {
                "light" => {
                    app.state.apply_theme(crate::style::Theme::Light);
                    app.state.config.config.theme = Some("light".to_string());
                }
                _ => {
                    app.state.apply_theme(crate::style::Theme::Dark);
                    app.state.config.config.theme = Some("dark".to_string());
                }
            }
        }
        "show_changes" => app.state.show_changes_in_chat(),
        "show_plan" => app.state.show_plan_in_chat(),
        "simulate_token" => {
            let text = action.get("text").and_then(|v| v.as_str()).unwrap_or("...");
            app.state.agent.state = AgentState::StreamingResponse;
            app.state.agent.streaming_text.push_str(text);
        }
        "simulate_tool_start" => {
            let name = action
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("shell");
            let args = action.get("args").and_then(|v| v.as_str()).unwrap_or("{}");
            app.state.agent.state = AgentState::Executing;
            app.state
                .agent
                .start_live_tool("tool-1".into(), name.into(), args.into(), false);
        }
        "simulate_tool_output" => {
            let output = action.get("output").and_then(|v| v.as_str()).unwrap_or("");
            app.state.agent.append_live_tool_output("tool-1", output);
        }
        "finish_turn" | "simulate_finish" => {
            if !app.state.agent.streaming_text.is_empty() {
                let content = std::mem::take(&mut app.state.agent.streaming_text);
                app.state.session.chat_history.push(ChatEntry {
                    id: uuid::Uuid::new_v4(),
                    role: Role::Assistant,
                    content,
                    tool_name: None,
                    tool_args: None,
                    is_error: false,
                    timestamp: chrono::Utc::now(),
                    response_duration: Some(420.0),
                    mode: format!("{:?}", app.state.agent.mode),
                    interrupted: false,
                    reasoning: None,
                    subagent_id: None,
                    subagent_type: None,
                    diff_stats: None,
                    attachments: Vec::new(),
                });
            }
            app.state.agent.finish_live_tool("tool-1");
            app.state.agent.state = AgentState::Idle;
        }
        "simulate_approval" => {
            let tool_name = action
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("shell");
            let args = action.get("args").and_then(|v| v.as_str()).unwrap_or("{}");
            app.state.agent.state = AgentState::WaitingApproval;
            app.state.agent.enqueue_approval(
                ApprovalSource::Parent,
                ApprovalRequest {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    tool_name: tool_name.into(),
                    tool_args: args.into(),
                    description: format!("Execute: {tool_name} {args}"),
                    is_dangerous: true,
                    old_content: None,
                    new_content: None,
                    file_path: None,
                },
            );
        }
        "simulate_error" => {
            let msg = action
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Request failed: 429 rate limit");
            app.state.agent.state = AgentState::Idle;
            app.state.session.chat_history.push(ChatEntry {
                id: uuid::Uuid::new_v4(),
                role: Role::Assistant,
                content: msg.to_string(),
                tool_name: None,
                tool_args: None,
                is_error: true,
                timestamp: chrono::Utc::now(),
                response_duration: Some(120.0),
                mode: "Build".to_string(),
                interrupted: false,
                reasoning: None,
                subagent_id: None,
                subagent_type: None,
                diff_stats: None,
                attachments: Vec::new(),
            });
        }
        "toggle_plan_mode" => {
            let next = if app.state.agent.mode == AgentMode::Plan {
                AgentMode::Build
            } else {
                AgentMode::Plan
            };
            app.state.agent.set_mode(next);
        }
        "simulate_todo" => {
            app.state.todo.update(vec![
                agente_core::types::Todo {
                    id: "todo-1".into(),
                    content: "Add retry exponential backoff".into(),
                    status: agente_core::types::TodoStatus::InProgress,
                    priority: agente_core::types::TodoPriority::High,
                },
                agente_core::types::Todo {
                    id: "todo-2".into(),
                    content: "Write unit tests for HTTP 429 rate limiting".into(),
                    status: agente_core::types::TodoStatus::Pending,
                    priority: agente_core::types::TodoPriority::Medium,
                },
                agente_core::types::Todo {
                    id: "todo-3".into(),
                    content: "Review documentation in AGENTS.md".into(),
                    status: agente_core::types::TodoStatus::Completed,
                    priority: agente_core::types::TodoPriority::Low,
                },
            ]);
            app.state.refresh_plan_in_chat();
        }
        "click" => {
            let x = action.get("x").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let y = action.get("y").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let down = MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: x,
                row: y,
                modifiers: KeyModifiers::NONE,
            };
            let up = MouseEvent {
                kind: MouseEventKind::Up(MouseButton::Left),
                column: x,
                row: y,
                modifiers: KeyModifiers::NONE,
            };
            let _ = app.handle_mouse(down);
            let _ = app.handle_mouse(up);
        }
        "key" => {
            if let Some(key_event) = parse_web_key_event(&action) {
                let _ = app.handle_key(key_event);
                // Keep the inspector server alive if Ctrl+C was sent.
                app.state.ui.should_quit = false;
            }
        }
        "reset" => {
            let mut new_state = AppState::new(AppConfig::default(), "/home/dev/agente".to_string());
            configure_demo_state(&mut new_state);
            app.state = new_state;
        }
        _ => {}
    }
}

/// Standalone interactive studio web page, built with the shared graphite
/// theme tokens and terminal frame styles from `web_export::theme`.
fn get_studio_html() -> &'static str {
    static PAGE: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        let head = crate::web_export::theme::studio_head(
            "Agente Code — Live Browser Studio & Inspector",
            INSPECTOR_EXTRA_CSS,
        );
        format!("{head}{STUDIO_BODY_HTML}")
    });
    &PAGE
}

const INSPECTOR_EXTRA_CSS: &str = r##"
  .panel-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--fg-dim);
    margin-bottom: 8px;
  }

  .btn-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .action-btn {
    background: var(--bg-card);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 12px;
    cursor: pointer;
    font-weight: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: background 0.09s ease, border-color 0.09s ease;
  }

  .action-btn:hover {
    background: var(--bg-card-hover);
    border-color: var(--primary);
  }

  .action-btn:active {
    transform: scale(0.98);
  }

  .action-btn.primary {
    background: var(--primary-tint);
    border-color: var(--primary);
    color: var(--primary);
    font-weight: 600;
  }

  .action-btn.danger {
    background: rgba(224, 108, 117, 0.16);
    border-color: var(--error);
    color: #ff9fa6;
  }

  .meta-tag {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--fg-dim);
  }
"##;

const STUDIO_BODY_HTML: &str = r##"<body>

<div id="control-panel" class="studio-sidebar">
  <div class="studio-header">
    <h1>◈ Agente Live Studio</h1>
    <p>Live interactive terminal testing & debugging</p>
  </div>
  <div class="panel-scroll">
    <div>
      <div class="section-title">Agent Turn Simulator</div>
      <div class="btn-grid">
        <button class="action-btn primary" onclick="sendAction({type:'simulate_token', text:' adding retry helper...'})">▸ Stream Token</button>
        <button class="action-btn" onclick="sendAction({type:'simulate_tool_start', name:'shell', args:'{\"command\":\"cargo test\"}'})">⚙ Start Tool</button>
        <button class="action-btn" onclick="sendAction({type:'simulate_tool_output', output:'Running 138 tests...\n'})">≡ Tool Output</button>
        <button class="action-btn primary" onclick="sendAction({type:'finish_turn'})">✓ Finish Turn</button>
        <button class="action-btn" onclick="sendAction({type:'simulate_approval', tool_name:'edit_file', args:'{\"path\":\"src/lib.rs\"}'})">⚠ Request Approval</button>
        <button class="action-btn danger" onclick="sendAction({type:'simulate_error', message:'Request failed: 429 Rate limit exceeded.'})">✗ Inject Error</button>
        <button class="action-btn" onclick="sendAction({type:'toggle_plan_mode'})">⇄ Toggle Mode</button>
        <button class="action-btn" onclick="sendAction({type:'simulate_todo'})">☐ Populate Todos</button>
      </div>
    </div>

    <div>
      <div class="section-title">Session & Overlays</div>
      <div class="btn-grid">
        <button class="action-btn" onclick="sendAction({type:'show_changes'})">📁 Changes in Chat</button>
        <button class="action-btn" onclick="sendAction({type:'show_plan'})">☐ Plan in Chat</button>
        <button class="action-btn" onclick="sendAction({type:'key', key:'p', ctrl:true})">Ctrl+P Palette</button>
        <button class="action-btn" onclick="sendAction({type:'key', key:'F1'})">F1 Help</button>
        <button class="action-btn" onclick="sendAction({type:'set_theme', theme:'dark'})">🌙 Dark Theme</button>
        <button class="action-btn" onclick="sendAction({type:'set_theme', theme:'light'})">☀ Light Theme</button>
      </div>
    </div>

    <div>
      <div class="section-title">Quick Actions</div>
      <button class="action-btn danger" style="width:100%" onclick="sendAction({type:'reset'})">↺ Reset State</button>
    </div>
  </div>
</div>

<div id="workspace" class="studio-workspace">
  <div class="studio-toolbar">
    <div class="studio-toolbar-left">
      <div class="studio-pill-group" id="size-selector">
        <button class="studio-pill active" onclick="setSize(this, 100, 30)">100x30</button>
        <button class="studio-pill" onclick="setSize(this, 80, 24)">80x24</button>
        <button class="studio-pill" onclick="setSize(this, 60, 18)">60x18</button>
        <button class="studio-pill" onclick="setSize(this, 40, 12)">40x12</button>
      </div>
      <span class="meta-tag" id="size-meta">100x30</span>
      <button class="studio-toggle" id="theme-holes-toggle" onclick="toggleThemeHoles()">Show Theme Holes</button>
    </div>
    <div class="studio-toolbar-right">
      <span id="state-summary"><span style="color:var(--success)">✓ Invariants Clean</span></span>
    </div>
  </div>

  <div id="stage" class="studio-stage">
    <div class="terminal-frame" id="terminal-box" tabindex="0">
      <div class="terminal-titlebar">
        <div class="titlebar-dots">
          <div class="dot red"></div>
          <div class="dot yellow"></div>
          <div class="dot green"></div>
        </div>
        <div class="titlebar-title">agente — live</div>
        <div class="titlebar-meta" id="frame-size-meta">100x30</div>
      </div>
      <div id="viewport" class="terminal-screen"></div>
    </div>
  </div>

  <div id="state-drawer" class="studio-drawer">
    <div class="studio-drawer-header">State Tree & Inspector Data</div>
    <div class="studio-drawer-body">
      <pre id="state-body">Loading state...</pre>
    </div>
  </div>
</div>

<script>
  let showThemeHoles = false;
  let currentCols = 100;
  let currentRows = 30;
  const viewportEl = document.getElementById("viewport");
  const sizeMetaEl = document.getElementById("size-meta");
  const frameSizeMetaEl = document.getElementById("frame-size-meta");
  const stateSummaryEl = document.getElementById("state-summary");
  const stateBodyEl = document.getElementById("state-body");
  const terminalBoxEl = document.getElementById("terminal-box");

  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === "frame") {
        viewportEl.innerHTML = data.html;
        currentCols = data.frame.width;
        currentRows = data.frame.height;
        const sizeLabel = `${data.frame.width}x${data.frame.height}`;
        sizeMetaEl.textContent = sizeLabel;
        frameSizeMetaEl.textContent = sizeLabel;
        if (data.frame.violations.length > 0) {
          stateSummaryEl.innerHTML = `<span style="color:var(--error)">✗ ${data.frame.violations.length} Invariant Violations</span>`;
        } else {
          stateSummaryEl.innerHTML = `<span style="color:var(--success)">✓ Invariants Clean</span>`;
        }
        fetchState();
      }
    } catch (err) {
      console.error("SSE parse error", err);
    }
  };

  async function sendAction(action) {
    await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    });
    fetchState();
  }

  async function fetchState() {
    try {
      const res = await fetch("/api/state");
      const state = await res.json();
      stateBodyEl.textContent = JSON.stringify(state, null, 2);
    } catch (_) {}
  }

  function setSize(btn, w, h) {
    document.querySelectorAll("#size-selector .studio-pill").forEach(p => p.classList.remove("active"));
    if (btn) btn.classList.add("active");
    currentCols = w;
    currentRows = h;
    sendAction({ type: "resize", width: w, height: h });
  }

  function toggleThemeHoles() {
    showThemeHoles = !showThemeHoles;
    document.getElementById("theme-holes-toggle").classList.toggle("active", showThemeHoles);
    viewportEl.classList.toggle("theme-hole-active", showThemeHoles);
  }

  viewportEl.addEventListener("click", (e) => {
    const rect = viewportEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const charW = rect.width / (currentCols || 100);
    const lineH = rect.height / (currentRows || 30);
    const col = Math.floor((e.clientX - rect.left) / charW);
    const row = Math.floor((e.clientY - rect.top) / lineH);
    if (col >= 0 && col < currentCols && row >= 0 && row < currentRows) {
      sendAction({ type: "click", x: col, y: row });
    }
  });

  terminalBoxEl.addEventListener("keydown", (e) => {
    e.preventDefault();
    sendAction({
      type: "key",
      key: e.key,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
    });
  });

  fetchState();
</script>
</body>
</html>
"##;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspector_key_action_routes_through_real_app_handle_key() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = App::new_for_test(
            AppConfig::default(),
            "/tmp/inspector-test".to_string(),
            runtime,
        )
        .unwrap();
        configure_demo_state(&mut app.state);

        let mut w = 100;
        let mut h = 30;
        dispatch_actor_action(
            &mut app,
            &mut w,
            &mut h,
            serde_json::json!({ "type": "key", "key": "h" }),
        );
        dispatch_actor_action(
            &mut app,
            &mut w,
            &mut h,
            serde_json::json!({ "type": "key", "key": "i" }),
        );
        assert_eq!(app.state.input.input_text, "hi");

        // Ctrl+P opens the real command palette through App::handle_key.
        dispatch_actor_action(
            &mut app,
            &mut w,
            &mut h,
            serde_json::json!({ "type": "key", "key": "p", "ctrl": true }),
        );
        assert!(app.state.input.show_command_palette);

        // Escape closes it via App::handle_key.
        dispatch_actor_action(
            &mut app,
            &mut w,
            &mut h,
            serde_json::json!({ "type": "key", "key": "Escape" }),
        );
        assert!(!app.state.input.show_command_palette);
    }

    #[test]
    fn studio_html_uses_shared_graphite_tokens() {
        let html = get_studio_html();
        assert!(html.contains("--bg-app: #1c1c1c;"));
        assert!(html.contains("--primary: #e8793a;"));
        assert!(html.contains("class=\"terminal-screen\""));
    }
}
