//! Chat turn lifecycle, queues, and shell steering.

use std::io;
use std::sync::Arc;

use agente_core::agent::{spawn_chat_task, spawn_discovery_task};
use agente_core::cancellation::AbortController;
use agente_core::context;
use agente_core::tools::{ToolExecutionContext, ToolOutputStream, ToolRegistry};
use agente_core::types::{self, AgentState, Message, Role};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::ExecutableCommand;

use crate::command_palette::Command;
use crate::editor;
use crate::state::{is_vague_feedback, template_ask_questions, PlanAskState, PlanReviewPhase};

use super::App;

impl App {
    pub(super) fn start_chat_turn(&mut self) -> anyhow::Result<()> {
        if self.state.session.conversation.is_empty() {
            let project_dir = self.state.session.project_dir.clone();
            // Build the prompt's tool list from the live registry so the system
            // prompt always matches the tools the agent can actually call.
            let tool_registry = agente_core::tools::ToolRegistry::new(&project_dir);
            let system_prompt = context::executor_system_prompt_with_tools(
                &project_dir,
                "",
                &tool_registry.definitions(),
            );
            self.state.session.conversation.push(Message {
                role: Role::System,
                content: system_prompt,
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
                attachments: Vec::new(),
            });
        }
        // Project instructions (AGENTS.md) as a user-message reminder —
        // injected whenever missing so compaction loss self-heals next turn.
        let project_dir = self.state.session.project_dir.clone();
        context::inject_project_reminder(&mut self.state.session.conversation, &project_dir);

        let mode = self.state.agent.mode;
        // A mode selected while the previous turn was busy intentionally did
        // not mutate that turn's live permissions. Activate it now, at the
        // boundary where the next turn becomes current.
        self.state.agent.set_mode(mode);
        self.state.agent.current_turn_mode = mode;
        self.state.agent.begin_turn_progress();
        self.state.agent.state = AgentState::StreamingResponse;
        self.state.agent.streaming_text.clear();
        self.state.agent.reasoning_text.clear();
        self.state.agent.thinking_start_time = Some(chrono::Utc::now());
        // Arm the stuck-guard clock for this turn (even before the first event).
        self.state.agent.mark_agent_event();
        // Thinking cards always start collapsed; user expands individually.
        self.state.agent.thinking_expanded = false;
        self.state.ui.chat_auto_scroll = true;
        // Reset the turn-scoped auto-approve override back to the user's persistent preference.
        self.state.agent.reset_auto_approve_runtime();

        let provider_id = self.state.config.current_provider.clone();
        let model = self.state.config.current_model.clone();

        if provider_id.is_empty() {
            self.state.add_system_message(
                "No provider connected. Use /provider to connect one.".to_string(),
            );
            self.state.agent.state = AgentState::Idle;
            return Ok(());
        }
        if model.is_empty() {
            self.state
                .add_system_message("No model selected. Use /model to select one.".to_string());
            self.state.agent.state = AgentState::Idle;
            return Ok(());
        }

        let project_dir = self.state.session.project_dir.clone();
        let conversation = self.state.session.conversation.clone();
        let registry = self.state.config.provider_registry.clone();
        if matches!(mode, types::AgentMode::Build) {
            if let Some(provider) = registry.get(&provider_id) {
                if let Some(model_info) = provider.get_model(&model) {
                    if !model_info.capabilities.toolcall {
                        self.state.add_system_message(format!(
                            "Selected model '{model}' does not advertise tool support, so file and shell tools may be unavailable. Try /model if the agent only replies with text."
                        ));
                    }
                }
            }
        }

        // Bump task id and create a one-shot cancellation controller for this
        // turn. Explicitly abort the previous controller before replacing it;
        // dropping a controller is intentionally not itself cancellation.
        self.current_task_id = self.next_task_id();
        self.state.agent.abort_task();
        self.state.cancel_tx.abort();
        let cancel_controller = AbortController::new();
        let cancel_signal = cancel_controller.signal();
        self.state.cancel_tx = cancel_controller;

        tracing::info!(session_id = %self.state.session.session_id, task_id = self.current_task_id, provider = %provider_id, model = %model, mode = ?mode, "Sending message to chat task");

        let task_handle = spawn_chat_task(
            self.state.session.session_id,
            self.current_task_id,
            self.agent_tx.clone(),
            conversation,
            provider_id,
            model,
            self.state.agent.thinking_level.clone(),
            project_dir,
            self.state.config.config.max_iterations(),
            registry,
            self.state.config.config.catalog.clone(),
            self.state.agent.shared_permission_engine(),
            cancel_signal,
            self.approval_broker.clone(),
            Some(Arc::clone(&self.state.config.mcp_manager)),
            self.state.subagent_registry.clone(),
            self.state.config.config.subagent_models.clone(),
            self.state.config.config.smart_compaction,
            self.state.config.config.parallel_subagents(),
            Arc::clone(&self.state.agent.user_inbox),
            agente_core::agent::TurnTools::default(),
        );
        self.state.agent.task_handle = Some(task_handle);

        Ok(())
    }

    /// Drain steering and message queues after a turn completes.
    /// Steering commands take priority: if any exist, message queue is cleared
    /// and the turn is not auto-started. Returns true when a follow-up turn
    /// was started.
    pub(super) fn drain_queues_and_continue(&mut self) -> bool {
        let steering: Vec<String> = std::mem::take(&mut self.state.agent.steering_queue);
        if !steering.is_empty() {
            // Process steering commands
            for cmd in steering {
                if cmd.starts_with('!') {
                    // Execute bash command directly
                    let command = cmd.trim_start_matches('!').trim();
                    self.run_shell_command(command);
                } else {
                    self.state.add_system_message("Stopped by user".to_string());
                }
            }
            // Steering cancels any queued follow-up messages
            self.state.agent.reclaim_inbox();
            self.state.agent.message_queue.clear();
            return false;
        }

        // No steering — drain normal follow-up messages (anything the
        // ended turn never took from its inbox included).
        self.state.agent.reclaim_inbox();
        let queued = std::mem::take(&mut self.state.agent.message_queue);
        let had_queued = !queued.is_empty();
        for queued in queued {
            let message = queued.to_message();
            self.state
                .add_user_message_with(queued.display, queued.attachments);
            self.state.session.conversation.push(message);
        }
        if had_queued {
            let _ = self.start_chat_turn();
            return true;
        }
        false
    }

    /// Execute a bash command in the project directory and report the result
    /// as a system message. It deliberately uses the same async ShellTool path
    /// as an agent call, including bounded output, timeout, and cancellation.
    /// Used by steering commands (both while running and when idle). No-op for
    /// empty commands.
    pub(super) fn run_shell_command(&mut self, command: &str) {
        let command = command.trim();
        if command.is_empty() {
            return;
        }

        let project_dir = self.state.session.project_dir.clone();
        self.state.agent.abort_task();
        self.state.cancel_tx.abort();
        self.current_task_id = self.next_task_id();
        let task_id = self.current_task_id;
        let controller = AbortController::new();
        let signal = controller.signal();
        self.state.cancel_tx = controller;
        self.state.agent.state = AgentState::Executing;
        self.state.agent.mark_agent_event();

        let call_id = format!("direct-{}", uuid::Uuid::new_v4());
        let args = serde_json::json!({"command": command});
        let _ = self.agent_tx.send(agente_core::agent::AgentTaskEvent {
            task_id,
            event: agente_core::agent::AgentEvent::ToolCallStart {
                id: call_id.clone(),
                name: "shell".to_string(),
                args: args.to_string(),
            },
        });

        let sender = self.agent_tx.clone();
        let progress_id = call_id.clone();
        let command_args = args.clone();
        let task_handle = self.runtime.spawn(async move {
            let registry = ToolRegistry::new(&project_dir);
            let progress_sender = sender.clone();
            let progress_call_id = progress_id.clone();
            let context = ToolExecutionContext::new(signal).with_progress(move |progress| {
                let chunk = match progress.stream {
                    ToolOutputStream::Stdout => progress.content,
                    ToolOutputStream::Stderr => format!("[stderr] {}", progress.content),
                };
                let _ = progress_sender.send(agente_core::agent::AgentTaskEvent {
                    task_id,
                    event: agente_core::agent::AgentEvent::ToolCallProgress {
                        id: progress_call_id.clone(),
                        chunk,
                    },
                });
            });
            let result = registry
                .execute_with_context("shell", command_args, context)
                .await;
            let (result, is_error) = match result {
                Ok(result) => (result, false),
                Err(error) => (format!("Error: {error}"), true),
            };
            let _ = sender.send(agente_core::agent::AgentTaskEvent {
                task_id,
                event: agente_core::agent::AgentEvent::ToolCallResult {
                    id: call_id,
                    name: "shell".to_string(),
                    result,
                    is_error,
                },
            });
        });
        self.state.agent.task_handle = Some(task_handle);
    }

    pub(super) fn handle_user_input(&mut self, text: String) -> anyhow::Result<()> {
        // Slash input and Ctrl+P resolve through the same command catalog and
        // executor, keeping behavior identical across both entry points.
        if let Some(stripped) = text.strip_prefix('/') {
            let parts: Vec<&str> = stripped.splitn(2, char::is_whitespace).collect();
            if let Some(cmd) = parts.first() {
                if *cmd == "diff" {
                    let arg = parts.get(1).map(|s| s.trim()).unwrap_or("");
                    if arg.is_empty() {
                        self.state
                            .add_system_message("Usage: /diff <path>".to_string());
                    } else {
                        self.state.open_diff_peek(arg);
                        if self.state.ui.diff_peek.as_deref() != Some(arg) {
                            self.state
                                .add_system_message(format!("No tracked changes for {arg}"));
                        }
                    }
                    return Ok(());
                }
                let name = format!("/{cmd}");
                if let Some(command) = Command::all()
                    .into_iter()
                    .find(|command| command.slash() == name)
                {
                    self.execute_command(command)?;
                    return Ok(());
                }

                // Filesystem custom commands (.agente/commands/*.md)
                let customs =
                    agente_core::extensions::discover_commands(&self.state.session.project_dir);
                if let Some(custom) = customs.iter().find(|c| c.name == *cmd) {
                    let args = parts.get(1).map(|s| s.trim()).unwrap_or("");
                    let expanded =
                        agente_core::extensions::expand_command_template(&custom.template, args);
                    // Inject as a normal user turn so the agent runs the prompt.
                    if !self.state.agent.is_idle() {
                        self.state
                            .agent
                            .queue_message(crate::state::QueuedMessage::new(expanded));
                        return Ok(());
                    }
                    self.state.add_user_message(expanded.clone());
                    self.state.session.conversation.push(Message {
                        role: Role::User,
                        content: expanded,
                        tool_calls: None,
                        tool_call_id: None,
                        thinking: None,
                        thinking_signature: None,
                        continuation: None,
                        attachments: Vec::new(),
                    });
                    return self.start_chat_turn();
                }

                // Agent Skills: `/name request` loads the skill for this turn.
                if let Some(skill) =
                    agente_core::extensions::skills::find(&self.state.session.project_dir, cmd)
                {
                    let args = parts.get(1).map(|s| s.trim()).unwrap_or("");
                    let prompt =
                        match agente_core::extensions::skills::user_invocation(&skill, args) {
                            Ok(prompt) => prompt,
                            Err(e) => {
                                self.state.add_system_message(format!(
                                    "Could not read skill {name}: {e}"
                                ));
                                return Ok(());
                            }
                        };
                    // The bubble shows what was typed; the model gets the skill.
                    if !self.state.agent.is_idle() {
                        self.state
                            .agent
                            .queue_message(crate::state::QueuedMessage::with_prompt(
                                text.trim(),
                                prompt,
                            ));
                        return Ok(());
                    }
                    self.state.add_user_message(text.trim().to_string());
                    self.state.session.conversation.push(Message {
                        role: Role::User,
                        content: prompt,
                        tool_calls: None,
                        tool_call_id: None,
                        thinking: None,
                        thinking_signature: None,
                        continuation: None,
                        attachments: Vec::new(),
                    });
                    return self.start_chat_turn();
                }

                self.state
                    .add_system_message(format!("Unknown command: {name}"));
                return Ok(());
            }
        }

        // Expand @path mentions into attached file context when idle-submitting.
        let text = crate::mentions::expand_at_file_mentions(&text, &self.state.session.project_dir);

        // Plan review: Comment mode → vague? Ask card : revise plan
        if self.state.plan_review.phase == PlanReviewPhase::AwaitingComment {
            if is_vague_feedback(&text) {
                self.state.plan_review.ask = Some(PlanAskState {
                    original_comment: text.clone(),
                    questions: template_ask_questions(&text),
                    question_index: 0,
                    reask_count: 0,
                });
                self.state.plan_review.phase = PlanReviewPhase::Asking;
                self.state.add_system_message(
                    "Feedback is a bit vague — answer a few quick questions (or Q to re-ask)."
                        .into(),
                );
                return Ok(());
            }
            self.state.plan_review.phase = PlanReviewPhase::Idle;
            let feedback = format!(
                "User wants the plan revised:\n{text}\n\nCall present_plan with the updated plan."
            );
            return self.submit_plan_feedback(feedback);
        }

        // `!`-commands are steering/shell commands: they are executed directly
        // and must never appear as a user message in chat history.
        if text.starts_with('!') {
            let command = text.trim_start_matches('!').trim();
            if !self.state.agent.is_idle() {
                // Agent is working — queue the steering command and interrupt
                self.state.agent.steering_queue.push(text);
                self.state.cancel_tx.abort();
                self.state
                    .add_system_message("Stopping current operation...".to_string());
            } else {
                // Agent is idle — run the shell command right away
                self.run_shell_command(command);
            }
            return Ok(());
        }

        // Media in the composer goes with this message — if the model can
        // take it. Otherwise nothing is sent and everything stays put.
        let attachments = std::mem::take(&mut self.state.input.attachments);
        if !attachments.is_empty() {
            let model = self.state.resolve_model(
                &self.state.config.current_provider,
                &self.state.config.current_model,
            );
            let refused = model
                .as_ref()
                .map(|m| agente_core::media::unsupported(m, &attachments))
                .unwrap_or_default();
            if !refused.is_empty() {
                let kinds: Vec<&str> = refused.iter().map(|k| k.label()).collect();
                let name = model.map(|m| m.name).unwrap_or_default();
                self.state.add_system_message(format!(
                    "{name} does not accept {} input — pick another model with /model, or remove it (Backspace on an empty composer).",
                    kinds.join(" or ")
                ));
                self.state.input.attachments = attachments;
                self.state.input.input_cursor = text.chars().count();
                self.state.input.input_text = text;
                return Ok(());
            }
        }

        if !self.state.agent.is_idle() {
            // Agent is working — queue it. The bubble appears when it is
            // actually sent (next step if sent now, else after the turn),
            // so the transcript keeps its real order.
            self.state.agent.queue_message(
                crate::state::QueuedMessage::new(text).with_attachments(attachments),
            );
            return Ok(());
        }
        self.state
            .add_user_message_with(text.clone(), attachments.clone());

        // Agent is idle — start a new turn
        let mut message = Message::user(text);
        message.attachments = attachments;
        self.state.session.conversation.push(message);

        self.start_chat_turn()
    }

    pub(super) fn refresh_model_catalog(&mut self) {
        if self.state.config.catalog_refresh_status == crate::state::DiscoveryStatus::InProgress {
            return;
        }
        self.state.config.catalog_refresh_status = crate::state::DiscoveryStatus::InProgress;
        self.state.ui.needs_render = true;
        let sender = self.agent_tx.clone();
        self.runtime.spawn(async move {
            let result = match tokio::time::timeout(
                std::time::Duration::from_secs(30),
                agente_core::catalog::ModelCatalog::fetch(),
            )
            .await
            {
                Ok(result) => result.map_err(|error| {
                    agente_core::util::redact_secrets(&format!(
                        "Model metadata refresh failed: {error}"
                    ))
                }),
                Err(_) => Err("Model metadata refresh timed out; retry Ctrl+R.".into()),
            };
            if let Ok(catalog) = &result {
                let cache = catalog.clone();
                let _ = tokio::task::spawn_blocking(move || cache.save_to_cache()).await;
            }
            let _ = sender.send(agente_core::agent::AgentTaskEvent {
                task_id: 0,
                event: agente_core::agent::AgentEvent::ModelCatalogUpdated { result },
            });
        });
    }

    pub(super) fn spawn_model_discovery(&mut self, provider: &str) {
        if matches!(
            self.state.config.discovery_status.get(provider),
            Some(crate::state::DiscoveryStatus::InProgress)
        ) {
            return;
        }
        self.state.config.discovery_status.insert(
            provider.to_string(),
            crate::state::DiscoveryStatus::InProgress,
        );
        let registry = self.state.config.provider_registry.clone();
        self.state.ui.needs_render = true;
        let _guard = self.runtime.enter();
        spawn_discovery_task(self.agent_tx.clone(), provider.to_string(), registry);
    }

    pub(super) fn open_editor_for_input(&mut self) -> anyhow::Result<()> {
        self.restore_terminal()?;

        let content = self.state.input.input_text.clone();
        if let Ok(Some(new_content)) = editor::open_temp_editor(&content) {
            self.state.input.input_text = new_content.trim_end().to_string();
            self.state.input.input_cursor = self.state.input.input_text.chars().count();
        }

        self.reinit_terminal()?;
        Ok(())
    }

    pub(super) fn export_chat(&self) -> anyhow::Result<()> {
        let mut content = String::new();
        for entry in &self.state.session.chat_history {
            let role = match entry.role {
                Role::User => "You",
                Role::Assistant => "Assistant",
                Role::Tool => "Tool",
                Role::System => "System",
            };
            content.push_str(&format!(
                "[{} {}] {}\n",
                role,
                entry.timestamp.format("%H:%M:%S"),
                entry.content
            ));
            if let Some(tool) = &entry.tool_name {
                content.push_str(&format!("  Tool: {tool}\n"));
            }
            content.push('\n');
        }

        let path = format!("{}/agente_export.md", self.state.session.project_dir);
        std::fs::write(&path, content)?;
        Ok(())
    }

    pub(super) fn restore_terminal(&mut self) -> anyhow::Result<()> {
        disable_raw_mode()?;
        crossterm::execute!(
            io::stdout(),
            crossterm::event::DisableBracketedPaste,
            crossterm::event::DisableMouseCapture
        )?;
        io::stdout().execute(LeaveAlternateScreen)?;
        self.terminal.show_cursor()?;
        Ok(())
    }

    /// Persist current config + session to disk. Safe to call multiple times.
    /// Best-effort: errors are logged, not propagated, so quitting never fails.
    pub(super) fn flush_state_to_disk(&mut self) {
        self.state.persist_config();
        self.queue_all_session_snapshots();
        if !self.persistence.flush(std::time::Duration::from_secs(3)) {
            tracing::warn!("Timed out flushing session snapshots");
        }
        self.state.refresh_recent_sessions();
    }

    pub(super) fn queue_session_snapshot(&self) {
        self.persistence.save(self.state.to_session_state());
    }

    pub(super) fn queue_all_session_snapshots(&mut self) {
        self.queue_session_snapshot();
        self.queue_background_snapshots();
    }

    pub(super) fn reinit_terminal(&mut self) -> anyhow::Result<()> {
        enable_raw_mode()?;
        io::stdout().execute(EnterAlternateScreen)?;
        crossterm::execute!(
            io::stdout(),
            crossterm::event::EnableMouseCapture,
            crossterm::event::EnableBracketedPaste
        )?;
        // Re-query graphics after leaving/re-entering alt screen (e.g. external editor).
        self.terminal.clear()?;
        Ok(())
    }

    /// Decisively interrupt and stop the running operation or turn.
    /// Cancels tokens, aborts the tokio task handle, drops approvals,
    /// preserves in-flight streaming response as an interrupted entry,
    /// resets the agent state to Idle, and queues a snapshot.
    pub(super) fn stop_current_operation(&mut self) {
        let is_running = !matches!(
            self.state.agent.state,
            agente_core::types::AgentState::Idle | agente_core::types::AgentState::Error(_)
        );
        if !is_running {
            return;
        }

        // Reject queued events and late sends from the cancelled turn.
        // Aborting its producer does not remove events from the receiver.
        self.current_task_id = self.next_task_id();

        // 1. Signal cancellation
        self.state.cancel_tx.abort();

        // 2. Hard-abort the background task handle so it cannot linger
        self.state.agent.abort_task();

        // 3. Cancel all pending approvals in broker and queue
        self.approval_broker.cancel_all();
        self.state
            .agent
            .remove_approvals_from(&agente_core::agent::ApprovalSource::Parent);

        // 4. If there was streaming text, preserve it as an interrupted message
        if !self.state.agent.streaming_text.is_empty() {
            self.state.add_interrupted_message();
        } else {
            self.state.flush_live_reasoning();
        }

        // 5. Clear stream buffers and live tools
        self.state.agent.clear_stream_buffers();
        self.state.agent.live_tool_calls.clear();

        // 6. Reset agent state
        self.state.agent.state = agente_core::types::AgentState::Idle;
        self.state.ui.last_stream_paint_at = None;

        // 7. Promote any pending plan review so UI returns to normal
        self.state.plan_review.promote();

        // 8. Recompute token counts against live conversation
        let conv = self.state.session.conversation.clone();
        self.state.agent.recompute_total_from_conversation(&conv);

        // 9. Feedback to user
        self.state.add_system_message("Stopped by user".to_string());
        self.state.ui.needs_render = true;

        // 10. Persist session snapshot
        self.queue_session_snapshot();
    }
}

#[cfg(test)]
mod tests {
    use crate::state::{modal_owner, ModalOwner};

    #[test]
    fn diff_slash_opens_tracked_file_in_peek() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = crate::app::App::new_for_test(
            agente_core::config::AppConfig::default(),
            "/tmp/diff-slash".to_string(),
            runtime,
        )
        .unwrap();
        app.state.session.track_file_change(
            "src/main.rs",
            Some("old\n".into()),
            Some("new\n".into()),
        );
        app.handle_user_input("/diff src/main.rs".to_string())
            .unwrap();
        assert_eq!(app.state.ui.diff_peek.as_deref(), Some("src/main.rs"));
        assert_eq!(modal_owner(&app.state), ModalOwner::DiffPeek);
        let backend = ratatui::backend::TestBackend::new(80, 24);
        let mut terminal = ratatui::Terminal::new(backend).unwrap();
        terminal
            .draw(|f| crate::app::render::render_app(f, &mut app.state))
            .unwrap();
        let buf = terminal.backend().buffer().clone();
        let mut text = String::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                text.push_str(buf[(x, y)].symbol());
            }
            text.push('\n');
        }
        assert!(text.contains("Diff:"), "diff peek header must paint");
    }
}
