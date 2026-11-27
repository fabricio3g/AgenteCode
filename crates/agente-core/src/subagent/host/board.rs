//! Swarm mode in the host: the `board` tool, starting cards as created
//! subagents, and moving a card when its subagent finishes.
//!
//! The board itself (cards, rules, storage) lives in `crate::swarm`; this is
//! where it meets the subagent machinery. Cards start as background spawns
//! through the ordinary `spawn` path, so routing, queueing, worktrees and
//! approvals are the same as for any `task`.

use super::*;
use crate::subagent::definition::capability_for_parent_mode;
use crate::swarm::{
    BoardAction, BoardArgs, BoardStore, ChildState, DeliverFinding, SwarmTool, LEAD,
};

/// Children claimed for a card but not yet admitted to the registry. The
/// claim marks the card Working before `spawn` runs, so for that moment the
/// registry has never heard of the child; a reconcile in between must not
/// take it for a lost run. Process-wide, like the registry it stands in for.
static STARTING: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

fn starting(child_id: &str, add: bool) {
    let mut set = STARTING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let set = set.get_or_insert_with(Default::default);
    if add {
        set.insert(child_id.to_string());
    } else {
        set.remove(child_id);
    }
}

/// A session's swarm as the hosts see it. A host lives for one turn, but the
/// board lives for the session, and its members outlive the turn that started
/// them: a later turn's `board` call, a queued card launched by another
/// turn's host, or a finding posted from either must all reach the same
/// members. So this is kept per session for the whole process.
#[derive(Default)]
struct SessionSwarm {
    /// The newest `board` call's turn: what card starts run under.
    lead: Option<BoardLead>,
    /// Child id → card id, set before a card's spawn so its launch (by
    /// whichever host drains the queue) gives the child the `swarm` tool.
    members: std::collections::HashMap<String, String>,
    /// Running members' inboxes, where findings from the others land.
    inboxes: std::collections::HashMap<String, crate::agent::channel::UserInbox>,
}

static SWARMS: std::sync::Mutex<Option<std::collections::HashMap<uuid::Uuid, SessionSwarm>>> =
    std::sync::Mutex::new(None);

fn with_swarm<T>(session: uuid::Uuid, f: impl FnOnce(&mut SessionSwarm) -> T) -> T {
    let mut swarms = SWARMS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(swarms
        .get_or_insert_with(Default::default)
        .entry(session)
        .or_default())
}

fn is_starting(child_id: &str) -> bool {
    STARTING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .is_some_and(|set| set.contains(child_id))
}

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
        let outcome = |content: String, is_error: bool| {
            if is_error {
                ToolCallOutcome::err_raw(tool_call_id.clone(), "board", content)
            } else {
                ToolCallOutcome::ok(tool_call_id.clone(), "board", content)
            }
        };
        let Some(session) = self.board_session() else {
            return outcome("Error: the board needs a session".into(), true);
        };
        let args: BoardArgs = match serde_json::from_value(args) {
            Ok(args) => args,
            Err(error) => return outcome(format!("Error: invalid board arguments: {error}"), true),
        };
        // The newest call's turn is the one card starts belong to: a later
        // turn's board call takes over from the turn that first used it.
        with_swarm(session, |swarm| {
            swarm.lead = Some(BoardLead { cancel, depth })
        });
        // A card left Working by a run that is gone would block the board
        // (and everything that waits on it) for good: settle those first.
        self.reconcile_board();

        let store = BoardStore::user();
        let changed = match args.action {
            BoardAction::Show => match store.get(session) {
                Ok(board) => match args.id.as_deref() {
                    Some(id) => match board.card_detail(id) {
                        Some(detail) => return outcome(detail, false),
                        None => Err(format!("no card {id} on the board")),
                    },
                    None => Ok((String::new(), board)),
                },
                Err(error) => Err(error.to_string()),
            },
            BoardAction::Add => store
                .update(session, |board| board.add(args.cards))
                .map(|(ids, board)| (format!("Added {}.", ids.join(", ")), board)),
            BoardAction::Post => {
                let text = args
                    .text
                    .as_deref()
                    .or(args.note.as_deref())
                    .unwrap_or_default();
                let deliver = self.finding_deliverer();
                match crate::swarm::post_and_deliver(
                    session,
                    LEAD,
                    text,
                    &args.recipients,
                    &deliver,
                ) {
                    Ok(said) => store
                        .get(session)
                        .map(|board| (said, board))
                        .map_err(|e| e.to_string()),
                    Err(error) => Err(error),
                }
            }
            BoardAction::Move => {
                let (Some(id), Some(to)) = (args.id.as_deref(), args.to) else {
                    return outcome("Error: move needs `id` and `to`".into(), true);
                };
                crate::swarm::move_with_work(&store, session, id, to, args.note.as_deref())
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
        let Some(lead) = with_swarm(session, |swarm| swarm.lead.clone()) else {
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
            // Swarm switched off: running members finish, nothing new starts.
            if !board.enabled {
                return Ok(starts);
            }
            for id in board.ready() {
                let child_id = uuid::Uuid::new_v4().to_string();
                starting(&child_id, true);
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
            with_swarm(session, |swarm| {
                swarm.members.insert(child_id.clone(), card.id.clone())
            });
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
            starting(&child_id, false);
            if result.is_error {
                self.forget_swarm_member(&child_id);
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
        self.forget_swarm_member(child_id);
        let Some(session) = self.board_session() else {
            return;
        };
        let store = BoardStore::user();
        let Some(snapshot) = self.inner.registry.get(child_id) else {
            // The registry lost it: settle every orphaned card rather than
            // leave this one Working (and its dependents waiting) for good.
            if !self.reconcile_board().is_empty() {
                if let Ok(board) = store.get(session) {
                    self.send_board(&board);
                }
            }
            return;
        };
        let ok = snapshot.status == SubagentStatus::Completed;
        let summary = snapshot.summary.clone().unwrap_or_default();
        // What a writer really changed in its checkout, whatever tool did it:
        // the scope check sees only the file tools, not a shell redirect.
        let work = snapshot
            .worktree
            .as_ref()
            .map(|info| crate::swarm::CardWork {
                repo_root: info.repo_root.clone(),
                worktree: info.path.clone(),
                base_commit: info.base_commit.clone(),
                files: crate::subagent::worktree::child_work(info),
            });
        let Ok((Some(_card), board)) = store.update(session, |board| {
            let card = board.child_finished(child_id, ok, &summary);
            if let Some(card) = &card {
                let owns = board
                    .card(card)
                    .map(|card| card.owns.clone())
                    .unwrap_or_default();
                if let Some(work) = &work {
                    if !owns.is_empty() {
                        let changed: Vec<String> =
                            work.files.iter().map(|file| file.path.clone()).collect();
                        let outside = crate::swarm::outside_owns(&owns, &changed);
                        board.note_outside_owns(card, &outside);
                    }
                }
                // Only a writer's work waits to be applied; it is applied
                // when the card is accepted, never before.
                let writer = board
                    .card(card)
                    .is_some_and(|card| card.capability != SubagentCapabilityMode::ReadOnly);
                if writer {
                    board.set_work(card, work.clone().filter(|work| !work.files.is_empty()));
                }
            }
            Ok(card)
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

    /// For a swarm card's child (registered by `start_ready_cards`): its
    /// inbox, now open for findings, and its `swarm` tool.
    pub(super) fn swarm_member_tools(
        &self,
        child_id: &str,
    ) -> Option<(
        crate::agent::channel::UserInbox,
        Box<dyn crate::tools::Tool>,
    )> {
        let session = self.board_session()?;
        let inbox = crate::agent::channel::UserInbox::default();
        let card_id = with_swarm(session, |swarm| {
            let card_id = swarm.members.get(child_id).cloned()?;
            swarm.inboxes.insert(child_id.to_string(), inbox.clone());
            Some(card_id)
        })?;
        let tool = SwarmTool::new(session, card_id, self.finding_deliverer());
        Some((inbox, Box::new(tool)))
    }

    /// Settle the session's working cards against the registry: a child that
    /// finished unheard moves its card on, one nothing knows any more (the
    /// app restarted, the run was lost) fails its card as interrupted.
    /// Returns the cards that moved; reads before it writes, so a session
    /// without a board stays without one.
    pub(crate) fn reconcile_board(&self) -> Vec<String> {
        let Some(session) = self.board_session() else {
            return Vec::new();
        };
        let store = BoardStore::user();
        let has_working = store.get(session).is_ok_and(|board| {
            board
                .cards
                .iter()
                .any(|card| card.status == crate::swarm::CardStatus::Working)
        });
        if !has_working {
            return Vec::new();
        }
        let registry = &self.inner.registry;
        store
            .update(session, |board| {
                Ok(board.reconcile(|child_id| {
                    if is_starting(child_id) {
                        return ChildState::Live;
                    }
                    match registry.get(child_id) {
                        None => ChildState::Gone,
                        Some(snapshot) if snapshot.status.is_terminal() => ChildState::Finished {
                            ok: snapshot.status == SubagentStatus::Completed,
                            summary: snapshot.summary.clone().unwrap_or_default(),
                        },
                        Some(_) => ChildState::Live,
                    }
                }))
            })
            .map(|(moved, _)| moved)
            .unwrap_or_default()
    }

    fn forget_swarm_member(&self, child_id: &str) {
        let Some(session) = self.board_session() else {
            return;
        };
        with_swarm(session, |swarm| {
            swarm.members.remove(child_id);
            swarm.inboxes.remove(child_id);
        });
    }

    /// Delivers a finding: one message into each recipient's inbox, taken at
    /// its next step, then the board to the UI. Holds the host weakly — the
    /// tool lives in a child's registry, and must not keep the host alive.
    pub(super) fn finding_deliverer(&self) -> DeliverFinding {
        let host = std::sync::Arc::downgrade(&self.inner);
        std::sync::Arc::new(move |board, finding| {
            let Some(inner) = host.upgrade() else {
                return;
            };
            let host = SubagentHost { inner };
            let message = format!(
                "Swarm finding {}\n(From another member of your swarm. Use it if it bears on your card; there is no need to reply.)",
                board.finding_line(finding)
            );
            if let Some(session) = host.board_session() {
                with_swarm(session, |swarm| {
                    for child_id in board.recipients(finding) {
                        if let Some(inbox) = swarm.inboxes.get(&child_id) {
                            if !inbox.is_closed() {
                                inbox
                                    .lock()
                                    .push(crate::types::Message::user(message.clone()));
                            }
                        }
                    }
                });
            }
            host.send_board(board);
        })
    }
}
