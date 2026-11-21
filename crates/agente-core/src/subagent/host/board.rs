//! Swarm mode in the host: the `board` tool, starting cards as created
//! subagents, and moving a card when its subagent finishes.
//!
//! The board itself (cards, rules, storage) lives in `crate::swarm`; this is
//! where it meets the subagent machinery. Cards start as background spawns
//! through the ordinary `spawn` path, so routing, queueing, worktrees and
//! approvals are the same as for any `task`.

use super::*;
use crate::swarm::{BoardAction, BoardArgs, BoardStore};

/// What a card start needs from the lead's turn: its cancel signal (a card
/// started after the turn ends still stops with it) and its depth.
#[derive(Clone)]
pub(super) struct BoardLead {
    pub cancel: AbortSignal,
    pub depth: u32,
}

impl SubagentHost {
    fn board_session(&self) -> Option<uuid::Uuid> {
        self.mcp_session_id()
    }

    fn send_board(&self, board: &crate::swarm::Board) {
        let _ = self.inner.config.event_sender.send(AgentTaskEvent {
            task_id: self.inner.config.task_id,
            event: AgentEvent::BoardChanged {
                board: board.clone(),
            },
        });
    }

    /// The `board` tool: add cards, move one, or show the board; every
    /// change starts whatever became ready.
    pub(super) async fn execute_board(
        &self,
        tool_call_id: String,
        args: serde_json::Value,
        cancel: AbortSignal,
        depth: u32,
    ) -> ToolCallOutcome {
        let outcome = |content: String, is_error: bool| ToolCallOutcome {
            tool_call_id: tool_call_id.clone(),
            tool_name: "board".to_string(),
            content,
            is_error,
            path_changed: None,
            changed_path: None,
            file_before: None,
            file_after: None,
            todos: None,
            attachments: Vec::new(),
        };
        let Some(session) = self.board_session() else {
            return outcome("Error: the board needs a session".into(), true);
        };
        let args: BoardArgs = match serde_json::from_value(args) {
            Ok(args) => args,
            Err(error) => return outcome(format!("Error: invalid board arguments: {error}"), true),
        };
        let _ = self.inner.board_lead.set(BoardLead { cancel, depth });

        let store = BoardStore::user();
        let changed = match args.action {
            BoardAction::Show => store
                .get(session)
                .map(|board| (String::new(), board))
                .map_err(|e| e.to_string()),
            BoardAction::Add => store
                .update(session, |board| board.add(args.cards))
                .map(|(ids, board)| (format!("Added {}.", ids.join(", ")), board)),
            BoardAction::Move => {
                let (Some(id), Some(to)) = (args.id.as_deref(), args.to) else {
                    return outcome("Error: move needs `id` and `to`".into(), true);
                };
                store
                    .update(session, |board| {
                        board.move_card(id, to, args.note.as_deref())
                    })
                    .map(|(_, board)| (format!("Moved {id}."), board))
            }
        };
        let (said, board) = match changed {
            Ok(changed) => changed,
            Err(error) => return outcome(format!("Error: {error}"), true),
        };
        let started = self.start_ready_cards(session).await;
        let board = store.get(session).unwrap_or(board);
        self.send_board(&board);
        let mut text = said;
        if !started.is_empty() {
            text.push_str(&format!(" Started {}.", started.join(", ")));
        }
        text.push_str(&format!("\n{}", board.summary()));
        outcome(text.trim().to_string(), false)
    }

    /// Start every ready card as a created background subagent. Returns the
    /// ids started. Without a lead (no `board` call yet) nothing starts.
    pub(super) async fn start_ready_cards(&self, session: uuid::Uuid) -> Vec<String> {
        let Some(lead) = self.inner.board_lead.get().cloned() else {
            return Vec::new();
        };
        if lead.cancel.is_aborted() {
            return Vec::new();
        }
        let parent_mode = self
            .inner
            .config
            .permission_engine
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .mode;
        let store = BoardStore::user();
        // Claim the ready cards in one locked update so two finishing
        // children never start the same card twice.
        let claimed = store.update(session, |board| {
            let mut starts = Vec::new();
            for id in board.ready() {
                let child_id = uuid::Uuid::new_v4().to_string();
                let prompt = board.child_prompt(&id).unwrap_or_default();
                board.start(&id, &child_id);
                if let Some(card) = board.card(&id) {
                    let (effective_cap, _) =
                        capability_for_parent_mode(parent_mode, card.capability);
                    board.set_capability(&id, effective_cap);
                }
                if let Some(card) = board.card(&id) {
                    starts.push((card.clone(), child_id, prompt));
                }
            }
            Ok(starts)
        });
        let Ok((starts, _)) = claimed else {
            return Vec::new();
        };
        let mut started = Vec::new();
        for (card, child_id, prompt) in starts {
            let owns = if card.capability == SubagentCapabilityMode::ReadOnly {
                Vec::new()
            } else {
                card.owns.clone()
            };
            let request = SubagentSpawnRequest {
                prompt,
                description: card.title.clone(),
                subagent_type: String::new(),
                role: Some(card.role.clone()),
                instructions: card.instructions.clone(),
                run_in_background: Some(true),
                capability_mode: Some(card.capability),
                cwd: None,
                isolation: Default::default(),
                max_iterations: None,
                timeout_ms: None,
                resume_from: None,
                model: card.model.clone(),
                task_id: Some(child_id.clone()),
                owns,
            };
            let result = Box::pin(self.spawn(request, lead.cancel.clone(), lead.depth)).await;
            if result.is_error {
                let summary = result.summary.unwrap_or_else(|| "could not start".into());
                let clear_child = !self.inner.registry.contains(&child_id);
                let _ = store.update(session, |board| {
                    board.child_finished(&child_id, false, &summary);
                    if clear_child {
                        board.clear_child_id(&card.id);
                    }
                    Ok(())
                });
            } else {
                started.push(card.id);
            }
        }
        started
    }

    /// A child finished: when it was a card's, move the card, tell the UI,
    /// and start the cards that were waiting on it. Runs on the child's
    /// forwarder thread.
    pub(super) fn board_child_finished(&self, child_id: &str) {
        let Some(session) = self.board_session() else {
            return;
        };
        let Some(snapshot) = self.inner.registry.get(child_id) else {
            return;
        };
        let ok = snapshot.status == SubagentStatus::Completed;
        let summary = snapshot.summary.clone().unwrap_or_default();
        let store = BoardStore::user();
        let Ok((Some(_card), board)) = store.update(session, |board| {
            Ok(board.child_finished(child_id, ok, &summary))
        }) else {
            return;
        };
        self.send_board(&board);
        if board.ready().is_empty() {
            return;
        }
        let Some(scheduler) = self.inner.scheduler.get() else {
            return;
        };
        let host = self.clone();
        scheduler.spawn(async move {
            let _ = host.start_ready_cards(session).await;
            if let Ok(board) = BoardStore::user().get(session) {
                host.send_board(&board);
            }
        });
    }
}
