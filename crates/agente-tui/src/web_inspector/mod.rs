//! Live interactive Web Inspector & Debug Server.
//!
//! Serves an interactive visual studio in the browser, allowing developers to:
//! - View and interact with live TUI frames in real-time
//! - Send keyboard (`handle_key`) and mouse (`handle_mouse`) events
//! - Dynamically resize the virtual terminal
//! - Select from all built-in test scenarios
//! - Simulate agent lifecycle turns (token streaming, tool executions, approvals, errors, compaction)
//! - Inspect live [`AppState`] and layout invariants (theme holes, wide glyphs)

use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, oneshot};

use ratatui::backend::TestBackend;
use ratatui::Terminal;

use agente_core::agent::ApprovalSource;
use agente_core::config::AppConfig;
use agente_core::types::{AgentMode, AgentState, ApprovalRequest, ChatEntry, Role};

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

impl InspectorServer {
    pub fn new() -> Self {
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<InspectorCmd>(100);
        let (broadcast_tx, _) = broadcast::channel(100);

        // Spawn dedicated single-thread actor owning AppState and rendering
        std::thread::spawn(move || {
            let mut state = AppState::new(AppConfig::default(), "/home/dev/agente".to_string());
            state.config.current_provider = "deepseek".to_string();
            state.config.current_model = "deepseek-v4-flash".to_string();
            state.config.connected_providers = vec!["deepseek".to_string()];
            state.ui.show_welcome_screen = false;

            let mut width: u16 = 100;
            let mut height: u16 = 30;

            while let Some(cmd) = cmd_rx.blocking_recv() {
                match cmd {
                    InspectorCmd::RenderFrame(reply) => {
                        let backend = TestBackend::new(width, height);
                        let mut terminal = Terminal::new(backend).expect("test terminal");
                        terminal
                            .draw(|frame| crate::app::render_app(frame, &mut state))
                            .expect("draw");
                        let buf = terminal.backend().buffer().clone();
                        let serialized = serialize_buffer(&buf);
                        let _ = reply.send(serialized);
                    }
                    InspectorCmd::DispatchAction(action, reply) => {
                        dispatch_actor_action(&mut state, &mut width, &mut height, action);
                        let _ = reply.send(());
                    }
                    InspectorCmd::GetState(reply) => {
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
    pub async fn render_frame(&self) -> SerializedFrame {
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
    pub async fn broadcast_frame(&self) {
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
            // Server-Sent Events stream
            let headers = "HTTP/1.1 200 OK\r\n\
                           Content-Type: text/event-stream\r\n\
                           Cache-Control: no-cache\r\n\
                           Connection: keep-alive\r\n\
                           Access-Control-Allow-Origin: *\r\n\r\n";
            stream.write_all(headers.as_bytes()).await?;

            let mut rx = self.broadcast_tx.subscribe();

            // Send initial frame
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
            // Serve Web Studio UI
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

fn char_to_byte(s: &str, char_idx: usize) -> usize {
    s.char_indices()
        .nth(char_idx)
        .map(|(byte_idx, _)| byte_idx)
        .unwrap_or(s.len())
}

fn dispatch_actor_action(
    state: &mut AppState,
    width: &mut u16,
    height: &mut u16,
    action: serde_json::Value,
) {
    let action_type = action.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match action_type {
        "resize" => {
            let w = action.get("width").and_then(|v| v.as_u64()).unwrap_or(100) as u16;
            let h = action.get("height").and_then(|v| v.as_u64()).unwrap_or(30) as u16;
            *width = w;
            *height = h;
        }
        "set_theme" => {
            let theme = action
                .get("theme")
                .and_then(|v| v.as_str())
                .unwrap_or("dark");
            match theme {
                "light" => {
                    state.apply_theme(crate::style::Theme::Light);
                    state.config.config.theme = Some("light".to_string());
                }
                _ => {
                    state.apply_theme(crate::style::Theme::Dark);
                    state.config.config.theme = Some("dark".to_string());
                }
            }
        }
        "show_changes" => state.show_changes_in_chat(),
        "show_plan" => state.show_plan_in_chat(),
        "simulate_token" => {
            let text = action.get("text").and_then(|v| v.as_str()).unwrap_or("...");
            state.agent.state = AgentState::StreamingResponse;
            state.agent.streaming_text.push_str(text);
        }
        "simulate_tool_start" => {
            let name = action
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("shell");
            let args = action.get("args").and_then(|v| v.as_str()).unwrap_or("{}");
            state.agent.state = AgentState::Executing;
            state
                .agent
                .start_live_tool("tool-1".into(), name.into(), args.into(), false);
        }
        "simulate_tool_output" => {
            let output = action.get("output").and_then(|v| v.as_str()).unwrap_or("");
            state.agent.append_live_tool_output("tool-1", output);
        }
        "finish_turn" | "simulate_finish" => {
            if !state.agent.streaming_text.is_empty() {
                let content = std::mem::take(&mut state.agent.streaming_text);
                state.session.chat_history.push(ChatEntry {
                    id: uuid::Uuid::new_v4(),
                    role: Role::Assistant,
                    content,
                    tool_name: None,
                    tool_args: None,
                    is_error: false,
                    timestamp: chrono::Utc::now(),
                    response_duration: Some(420.0),
                    mode: format!("{:?}", state.agent.mode),
                    interrupted: false,
                    reasoning: None,
                    subagent_id: None,
                    subagent_type: None,
                    diff_stats: None,
                    attachments: Vec::new(),
                });
            }
            state.agent.finish_live_tool("tool-1");
            state.agent.state = AgentState::Idle;
        }
        "simulate_approval" => {
            let tool_name = action
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("shell");
            let args = action.get("args").and_then(|v| v.as_str()).unwrap_or("{}");
            state.agent.state = AgentState::WaitingApproval;
            state.agent.enqueue_approval(
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
            state.agent.state = AgentState::Idle;
            state.session.chat_history.push(ChatEntry {
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
            let current = state.agent.mode;
            let next = if current == AgentMode::Plan {
                AgentMode::Build
            } else {
                AgentMode::Plan
            };
            state.agent.set_mode(next);
        }
        "simulate_todo" => {
            state.todo.update(vec![
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
            state.refresh_plan_in_chat();
        }
        "click" => {
            let _ = action.get("x").and_then(|v| v.as_u64()).unwrap_or(0);
            let _ = action.get("y").and_then(|v| v.as_u64()).unwrap_or(0);
        }
        "key" => {
            let key_code = action.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let ctrl = action
                .get("ctrl")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let shift = action
                .get("shift")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let alt = action.get("alt").and_then(|v| v.as_bool()).unwrap_or(false);

            use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
            let mut modifiers = KeyModifiers::empty();
            if ctrl {
                modifiers.insert(KeyModifiers::CONTROL);
            }
            if shift {
                modifiers.insert(KeyModifiers::SHIFT);
            }
            if alt {
                modifiers.insert(KeyModifiers::ALT);
            }

            let code = match key_code {
                "Enter" => KeyCode::Enter,
                "Escape" => KeyCode::Esc,
                "Backspace" => KeyCode::Backspace,
                "Delete" => KeyCode::Delete,
                "Tab" => KeyCode::Tab,
                "ArrowUp" => KeyCode::Up,
                "ArrowDown" => KeyCode::Down,
                "ArrowLeft" => KeyCode::Left,
                "ArrowRight" => KeyCode::Right,
                "PageUp" => KeyCode::PageUp,
                "PageDown" => KeyCode::PageDown,
                "Home" => KeyCode::Home,
                "End" => KeyCode::End,
                "F1" => KeyCode::F(1),
                s if s.chars().count() == 1 => KeyCode::Char(s.chars().next().unwrap()),
                _ => KeyCode::Null,
            };

            if code != KeyCode::Null {
                let key_event = KeyEvent::new(code, modifiers);
                if state.agent.is_waiting_approval() {
                    match key_event.code {
                        KeyCode::Char('y') | KeyCode::Char('Y') => {
                            state.agent.pop_approval();
                        }
                        KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                            state.agent.pop_approval();
                        }
                        KeyCode::Char('a') | KeyCode::Char('A') => {
                            state.agent.set_auto_approve_runtime(true);
                            state.agent.pop_approval();
                        }
                        _ => {}
                    }
                } else if state.agent.is_working() {
                    match key_event.code {
                        KeyCode::Esc | KeyCode::Char('c') if ctrl => {
                            state.agent.state = AgentState::Idle;
                            state.agent.streaming_text.clear();
                        }
                        KeyCode::Enter if state.agent.state == AgentState::StreamingResponse => {
                            let content = std::mem::take(&mut state.agent.streaming_text);
                            state.agent.state = AgentState::Idle;
                            state.session.chat_history.push(ChatEntry {
                                id: uuid::Uuid::new_v4(),
                                role: Role::Assistant,
                                content,
                                tool_name: None,
                                tool_args: None,
                                is_error: false,
                                timestamp: chrono::Utc::now(),
                                response_duration: Some(300.0),
                                mode: format!("{:?}", state.agent.mode),
                                interrupted: false,
                                reasoning: None,
                                subagent_id: None,
                                subagent_type: None,
                                diff_stats: None,
                                attachments: Vec::new(),
                            });
                        }
                        _ => {}
                    }
                } else {
                    match key_event.code {
                        KeyCode::Char(c) if !ctrl && !alt => {
                            let byte_idx =
                                char_to_byte(&state.input.input_text, state.input.input_cursor);
                            state.input.input_text.insert(byte_idx, c);
                            state.input.input_cursor += 1;
                        }
                        KeyCode::Backspace => {
                            if state.input.input_cursor > 0 && !state.input.input_text.is_empty() {
                                state.input.input_cursor -= 1;
                                let byte_idx =
                                    char_to_byte(&state.input.input_text, state.input.input_cursor);
                                state.input.input_text.remove(byte_idx);
                            }
                        }
                        KeyCode::Delete => {
                            let count = state.input.input_text.chars().count();
                            if state.input.input_cursor < count {
                                let byte_idx =
                                    char_to_byte(&state.input.input_text, state.input.input_cursor);
                                state.input.input_text.remove(byte_idx);
                            }
                        }
                        KeyCode::Left => {
                            if state.input.input_cursor > 0 {
                                state.input.input_cursor -= 1;
                            }
                        }
                        KeyCode::Right => {
                            let count = state.input.input_text.chars().count();
                            if state.input.input_cursor < count {
                                state.input.input_cursor += 1;
                            }
                        }
                        KeyCode::Home => {
                            state.input.input_cursor = 0;
                        }
                        KeyCode::End => {
                            state.input.input_cursor = state.input.input_text.chars().count();
                        }
                        KeyCode::Char('a') if ctrl => {
                            state.input.input_cursor = 0;
                        }
                        KeyCode::Char('e') if ctrl => {
                            state.input.input_cursor = state.input.input_text.chars().count();
                        }
                        KeyCode::Char('u') if ctrl => {
                            let byte_idx =
                                char_to_byte(&state.input.input_text, state.input.input_cursor);
                            state.input.input_text = state.input.input_text[byte_idx..].to_string();
                            state.input.input_cursor = 0;
                        }
                        KeyCode::Char('k') if ctrl => {
                            let byte_idx =
                                char_to_byte(&state.input.input_text, state.input.input_cursor);
                            state.input.input_text.truncate(byte_idx);
                        }
                        KeyCode::Char('c') if ctrl => {
                            state.input.input_text.clear();
                            state.input.input_cursor = 0;
                        }
                        KeyCode::Char('l') if ctrl => {
                            state.session.chat_history.clear();
                            state.input.input_text.clear();
                            state.input.input_cursor = 0;
                        }
                        KeyCode::Char('p') if ctrl => {
                            state.input.show_command_palette = !state.input.show_command_palette;
                        }
                        KeyCode::Char('b') if ctrl => {
                            state.show_changes_in_chat();
                        }
                        KeyCode::Esc => {
                            state.input.show_command_palette = false;
                            state.input.show_model_selector = false;
                            state.ui.show_help = false;
                            state.ui.diff_peek = None;
                        }
                        KeyCode::F(1) => {
                            state.ui.show_help = !state.ui.show_help;
                        }
                        KeyCode::Enter => {
                            if !state.input.input_text.is_empty() {
                                let content = std::mem::take(&mut state.input.input_text);
                                state.input.input_cursor = 0;
                                state.session.chat_history.push(ChatEntry {
                                    id: uuid::Uuid::new_v4(),
                                    role: Role::User,
                                    content,
                                    tool_name: None,
                                    tool_args: None,
                                    is_error: false,
                                    timestamp: chrono::Utc::now(),
                                    response_duration: None,
                                    mode: format!("{:?}", state.agent.mode),
                                    interrupted: false,
                                    reasoning: None,
                                    subagent_id: None,
                                    subagent_type: None,
                                    diff_stats: None,
                                    attachments: Vec::new(),
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        "reset" => {
            let mut new_state = AppState::new(AppConfig::default(), "/home/dev/agente".to_string());
            new_state.config.current_provider = "deepseek".to_string();
            new_state.config.current_model = "deepseek-v4-flash".to_string();
            new_state.config.connected_providers = vec!["deepseek".to_string()];
            *state = new_state;
        }
        _ => {}
    }
}

/// Standalone interactive studio web page, with the brand favicon.
fn get_studio_html() -> &'static str {
    static PAGE: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        STUDIO_HTML.replacen(
            "<title>",
            &format!("{}\n<title>", crate::brand::favicon_link()),
            1,
        )
    });
    &PAGE
}

const STUDIO_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agente Code — Live Browser Studio & Inspector</title>
<style>
  :root {
    --bg-app: #0c0c0f;
    --bg-surface: #131317;
    --bg-card: #1a1a21;
    --bg-card-hover: #24242e;
    --border: #282833;
    --border-active: #8abeb7;
    --fg: #e4e4e6;
    --fg-muted: #9a9aa2;
    --fg-dim: #60606a;
    --primary: #8abeb7;
    --secondary: #61afef;
    --success: #b5bd68;
    --warning: #d9a13b;
    --error: #cc6666;
    --theme-hole: rgba(255, 50, 50, 0.45);
    --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  
  body {
    background-color: var(--bg-app);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  /* Left Panel: Controls & Simulator */
  #control-panel {
    width: 330px;
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .panel-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }

  .panel-header h1 {
    font-size: 15px;
    font-weight: 700;
    color: var(--primary);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .panel-header p {
    font-size: 12px;
    color: var(--fg-muted);
    margin-top: 3px;
  }

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
    transition: all 0.15s ease;
  }

  .action-btn:hover {
    background: var(--bg-card-hover);
    border-color: var(--primary);
  }

  .action-btn:active {
    transform: scale(0.98);
  }

  .action-btn.primary {
    background: rgba(138, 190, 183, 0.15);
    border-color: var(--primary);
    color: var(--primary);
    font-weight: 600;
  }

  .action-btn.danger {
    background: rgba(204, 102, 102, 0.15);
    border-color: var(--error);
    color: #ff9999;
  }

  /* Center Workspace */
  #workspace {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg-app);
    overflow: hidden;
  }

  .top-bar {
    height: 50px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
  }

  .top-bar-left, .top-bar-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .size-pill-group {
    display: flex;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .size-pill {
    background: transparent;
    border: none;
    color: var(--fg-muted);
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
    font-weight: 500;
  }

  .size-pill.active {
    background: var(--primary);
    color: #111114;
    font-weight: 700;
  }

  .toggle-pill {
    background: var(--bg-card);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .toggle-pill.active {
    border-color: var(--error);
    background: rgba(204, 102, 102, 0.2);
    color: #ff9999;
  }

  .status-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--success);
  }

  .pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 8px var(--success);
  }

  /* Interactive Stage */
  #stage {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    overflow: auto;
    background: radial-gradient(circle at center, #141419 0%, #09090c 100%);
    position: relative;
  }

  .terminal-box {
    box-shadow: 0 25px 60px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    overflow: hidden;
    background: #111114;
    outline: none;
  }

  .terminal-box:focus {
    box-shadow: 0 25px 60px rgba(0, 0, 0, 0.75), 0 0 0 2px var(--primary);
  }

  .terminal-bar {
    height: 30px;
    background: #18181c;
    border-bottom: 1px solid #282830;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
  }

  .bar-dots { display: flex; gap: 6px; }
  .bdot { width: 10px; height: 10px; border-radius: 50%; }
  .bdot.red { background: #ff5f56; }
  .bdot.yellow { background: #ffbd2e; }
  .bdot.green { background: #27c93f; }

  .bar-title {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--fg-muted);
  }

  .terminal-viewport {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.15;
    white-space: pre;
    user-select: text;
    background: #111114;
    overflow: hidden;
  }

  .tui-row { display: flex; height: 1.15em; }
  .tui-span { display: inline-block; height: 100%; flex-shrink: 0; }

  .theme-hole-active .tui-span.theme-hole {
    background-color: var(--theme-hole) !important;
    outline: 1px dashed #ff3333;
  }

  /* Bottom Drawer: Live State Tree */
  #bottom-drawer {
    height: 130px;
    background: var(--bg-surface);
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
  }

  .drawer-header {
    padding: 6px 16px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--fg-dim);
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
  }

  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 16px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
</style>
</head>
<body>

<div id="control-panel">
  <div class="panel-header">
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
        <button class="action-btn warning" onclick="sendAction({type:'simulate_approval', tool_name:'edit_file', args:'{\"path\":\"src/lib.rs\"}'})">⚠ Request Approval</button>
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

<div id="workspace">
  <div class="top-bar">
    <div class="top-bar-left">
      <div class="size-pill-group" id="size-selector">
        <button class="size-pill active" onclick="setSize(this, 100, 30)">100x30</button>
        <button class="size-pill" onclick="setSize(this, 80, 24)">80x24</button>
        <button class="size-pill" onclick="setSize(this, 60, 18)">60x18</button>
        <button class="size-pill" onclick="setSize(this, 40, 12)">40x12</button>
      </div>
      <span class="meta-tag" id="size-meta">100x30</span>
      <button class="size-pill" id="theme-holes-toggle" onclick="toggleThemeHoles()">Show Theme Holes</button>
    </div>
    <div class="top-bar-right">
      <span id="state-summary"><span style="color:var(--success)">✓ Invariants Clean</span></span>
    </div>
  </div>

  <div class="terminal-container">
    <div class="terminal-box" id="terminal-box" tabindex="0">
      <div id="viewport"></div>
    </div>
  </div>

  <div id="state-drawer">
    <div class="drawer-header">State Tree & Inspector Data</div>
    <div class="drawer-content">
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
  const stateSummaryEl = document.getElementById("state-summary");
  const stateBodyEl = document.getElementById("state-body");
  const terminalBoxEl = document.getElementById("terminal-box");

  // Connect Server-Sent Events (SSE)
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === "frame") {
        viewportEl.innerHTML = data.html;
        currentCols = data.frame.width;
        currentRows = data.frame.height;
        sizeMetaEl.textContent = `${data.frame.width}x${data.frame.height}`;
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
    document.querySelectorAll("#size-selector .size-pill").forEach(p => p.classList.remove("active"));
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

  // Click on terminal cells routes to TUI mouse click handler
  viewportEl.addEventListener("click", (e) => {
    const pre = viewportEl.querySelector("pre");
    if (!pre) return;
    const rect = pre.getBoundingClientRect();
    const charW = rect.width / (currentCols || 100);
    const lineH = rect.height / (currentRows || 30);
    const col = Math.floor((e.clientX - rect.left) / charW);
    const row = Math.floor((e.clientY - rect.top) / lineH);
    if (col >= 0 && col < currentCols && row >= 0 && row < currentRows) {
      sendAction({ type: "click", x: col, y: row });
    }
  });

  // Keyboard capture when terminal is focused
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
