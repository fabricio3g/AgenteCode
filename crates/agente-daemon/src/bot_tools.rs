//! Tools only bots have: `memory_update` edits the bot's own MEMORY.md, and
//! `message_bot` hands a task to a teammate and brings back its answer.

use std::sync::Arc;

use agente_bot::{BotStore, MemoryEdit};
use agente_core::tools::{Tool, ToolError, ToolKind};
use agente_protocol::{Origin, Role, Trust, TurnId, TurnStatus};
use agente_runtime::{ProfileTurn, RuntimeError, RuntimeHandle};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use crate::bots::{bot_turn, ClientModel};

/// The origin channel of a turn a bot started with `message_bot`.
pub(crate) const HANDOFF_CHANNEL: &str = "bot";
/// Longest answer brought back from a teammate, in characters.
const MAX_REPLY_CHARS: usize = 16_000;
/// How long a handoff waits for a busy teammate before giving up.
const MAX_QUEUE_WAIT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
/// How often a waiting handoff checks whether the teammate is free.
const QUEUE_POLL: std::time::Duration = std::time::Duration::from_millis(500);

/// One gate per bot: handoffs to a bot wait their turn in the order they
/// came (tokio's mutex is fair), instead of failing while it's busy.
#[derive(Default)]
pub(crate) struct HandoffQueues {
    gates: std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Handoffs in progress (waiting or running), as (from, to).
    active: std::sync::Mutex<std::collections::HashSet<(String, String)>>,
}

impl HandoffQueues {
    fn gate(&self, handle: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut gates = self
            .gates
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Arc::clone(gates.entry(handle.to_string()).or_default())
    }

    /// Record `from` → `to`, unless `to` is already waiting on `from`: two
    /// bots waiting on each other would each sit out the whole wait.
    fn begin(self: &Arc<Self>, from: &str, to: &str) -> Option<ActiveHandoff> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if active.contains(&(to.to_string(), from.to_string())) {
            return None;
        }
        let pair = (from.to_string(), to.to_string());
        active.insert(pair.clone());
        Some(ActiveHandoff {
            queues: Arc::clone(self),
            pair,
        })
    }
}

/// A handoff in progress; forgotten when dropped (done, failed or cancelled).
struct ActiveHandoff {
    queues: Arc<HandoffQueues>,
    pair: (String, String),
}

impl Drop for ActiveHandoff {
    fn drop(&mut self) {
        self.queues
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.pair);
    }
}

pub(crate) struct MemoryUpdateTool {
    store: Arc<BotStore>,
    handle: String,
}

impl MemoryUpdateTool {
    pub(crate) fn new(store: Arc<BotStore>, handle: &str) -> Self {
        Self {
            store,
            handle: handle.to_string(),
        }
    }
}

#[async_trait]
impl Tool for MemoryUpdateTool {
    fn name(&self) -> &str {
        "memory_update"
    }

    fn description(&self) -> &str {
        "Edit your memory (the notes in your system prompt, one per line). \
         action \"add\" with `line`; \"replace\" with `old` (text in the note to change) and `new`; \
         \"remove\" with `line` (text in the note to remove). Keep notes short and lasting \
         (preferences, names, decisions); never store passwords or keys."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["add", "replace", "remove"] },
                "line": { "type": "string", "description": "The note to add, or text in the note to remove." },
                "old": { "type": "string", "description": "Text in the note to replace." },
                "new": { "type": "string", "description": "The note that replaces it." }
            },
            "required": ["action"]
        })
    }

    fn icon(&self) -> &'static str {
        "✎"
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _project_dir: &str,
    ) -> Result<String, ToolError> {
        let edit: MemoryEdit = serde_json::from_value(args)
            .map_err(|error| ToolError::InvalidArguments(error.to_string()))?;
        let memory = self
            .store
            .update_memory(&self.handle, &edit)
            .map_err(|error| ToolError::ExecutionError(error.to_string()))?;
        let notes = memory.lines().count();
        Ok(format!(
            "Memory saved ({notes} note{}).",
            if notes == 1 { "" } else { "s" }
        ))
    }
}

pub(crate) struct MessageBotTool {
    store: Arc<BotStore>,
    queues: Arc<HandoffQueues>,
    runtime: RuntimeHandle,
    from: String,
    trust: Trust,
    model: ProfileTurn,
}

impl MessageBotTool {
    pub(crate) fn new(
        store: Arc<BotStore>,
        queues: Arc<HandoffQueues>,
        runtime: RuntimeHandle,
        from: &str,
        turn: &ProfileTurn,
    ) -> Self {
        Self {
            store,
            queues,
            runtime,
            from: from.to_string(),
            trust: turn.origin.trust,
            model: turn.clone(),
        }
    }
}

#[derive(Deserialize)]
struct MessageArgs {
    to: String,
    message: String,
}

/// Cancels the teammate's turn if the handoff is dropped before it ends
/// (the asking turn was cancelled).
struct RunningTurn {
    runtime: RuntimeHandle,
    turn_id: TurnId,
    done: bool,
}

impl Drop for RunningTurn {
    fn drop(&mut self) {
        if !self.done {
            self.runtime.cancel(self.turn_id);
        }
    }
}

#[async_trait]
impl Tool for MessageBotTool {
    fn name(&self) -> &str {
        "message_bot"
    }

    fn description(&self) -> &str {
        "Hand a task or question to one of your teammates (see YOUR TEAMMATES) and get its \
         answer back. `to` is the teammate's @handle or name; `message` must stand on its own: \
         the teammate doesn't see this conversation."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "to": { "type": "string", "description": "The teammate's @handle or name." },
                "message": { "type": "string", "description": "What you need, with the context it needs." }
            },
            "required": ["to", "message"]
        })
    }

    fn kind(&self) -> ToolKind {
        ToolKind::Task
    }

    fn icon(&self) -> &'static str {
        "↪"
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _project_dir: &str,
    ) -> Result<String, ToolError> {
        let MessageArgs { to, message } = serde_json::from_value(args)
            .map_err(|error| ToolError::InvalidArguments(error.to_string()))?;
        let failed = |message: String| ToolError::ExecutionError(message);
        let target = self
            .store
            .resolve(&to)
            .map_err(|error| failed(error.to_string()))?;
        if target.handle == self.from {
            return Err(failed("That's you; message a teammate instead.".into()));
        }
        if message.trim().is_empty() {
            return Err(ToolError::InvalidArguments("The message is empty.".into()));
        }
        let text = format!(
            "Message from @{} (another bot on your team):\n\n{}\n\nYour reply goes back to @{}.",
            self.from,
            message.trim(),
            self.from
        );
        let fallback = ClientModel {
            provider: Some(self.model.provider.clone()),
            model: Some(self.model.model.clone()),
            thinking_level: Some(self.model.thinking_level.clone()),
        };
        // Trust never rises along a chain: the teammate runs with the
        // asking turn's trust, whoever started it.
        let origin = Origin {
            channel: HANDOFF_CHANNEL.into(),
            sender: Some(self.from.clone()),
            trust: self.trust,
        };
        // Wait our turn: handoffs to this teammate run one at a time, in the
        // order they came, and each waits for whatever it's doing now.
        let Some(_handoff) = self.queues.begin(&self.from, &target.handle) else {
            return Err(failed(format!(
                "@{} is waiting on you right now; finish this turn first, then ask again.",
                target.handle
            )));
        };
        let gate = self.queues.gate(&target.handle);
        let _slot = gate.lock().await;
        let waited = tokio::time::Instant::now();
        let (session_id, mut turn) = loop {
            let start = bot_turn(
                &self.store,
                &target.handle,
                text.clone(),
                fallback.clone(),
                Some(origin.clone()),
            )
            .map_err(|error| failed(error.to_string()))?;
            let session_id = start.session_id;
            match self.runtime.start_turn(start) {
                Ok(turn) => break (session_id, turn),
                Err(RuntimeError::SessionBusy(_)) if waited.elapsed() < MAX_QUEUE_WAIT => {
                    tokio::time::sleep(QUEUE_POLL).await;
                }
                Err(RuntimeError::SessionBusy(_)) => {
                    return Err(failed(format!(
                        "@{} stayed busy for {} minutes; try again later.",
                        target.handle,
                        MAX_QUEUE_WAIT.as_secs() / 60
                    )))
                }
                Err(other) => return Err(failed(other.to_string())),
            }
        };
        let mut running = RunningTurn {
            runtime: self.runtime.clone(),
            turn_id: turn.turn_id(),
            done: false,
        };
        // Drain the events (the turn's channel is bounded), then its outcome.
        while let Some(envelope) = turn.recv().await {
            if envelope.event.is_terminal() {
                break;
            }
        }
        let outcome = turn.outcome().await;
        running.done = true;
        match outcome {
            Some(outcome) if outcome.status == TurnStatus::Completed => {}
            Some(outcome) => {
                return Err(failed(format!(
                    "@{} couldn't finish: {}",
                    target.handle,
                    outcome
                        .error
                        .unwrap_or_else(|| format!("{:?}", outcome.status))
                )))
            }
            None => {
                return Err(failed(format!(
                    "@{} stopped without an answer.",
                    target.handle
                )))
            }
        }
        let answer = self
            .runtime
            .session_snapshot(session_id)
            .conversation
            .into_iter()
            .rev()
            .find(|message| message.role == Role::Assistant && !message.content.trim().is_empty())
            .map(|message| message.content)
            .unwrap_or_default();
        if answer.is_empty() {
            return Err(failed(format!(
                "@{} finished without a reply.",
                target.handle
            )));
        }
        let mut reply: String = answer.chars().take(MAX_REPLY_CHARS).collect();
        if answer.chars().count() > MAX_REPLY_CHARS {
            reply.push_str("\n…(reply cut at 16,000 characters)");
        }
        Ok(format!("@{} replied:\n\n{reply}", target.handle))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bots::BotProfiles;
    use agente_bot::{BotConfig, NewBot};
    use agente_core::config::AppConfig;
    use agente_runtime::{ProfileSource, RuntimeConfig, RuntimeSupervisor};

    fn setup(tag: &str) -> (std::path::PathBuf, Arc<BotStore>, Arc<BotProfiles>) {
        let dir =
            std::env::temp_dir().join(format!("agente-bot-tools-{tag}-{}", std::process::id()));
        let store = Arc::new(BotStore::open(dir.join("bots")).unwrap());
        store
            .create(NewBot {
                handle: Some("scout".into()),
                config: BotConfig {
                    title: "Scout".into(),
                    ..BotConfig::default()
                },
                ..NewBot::default()
            })
            .unwrap();
        let profiles = Arc::new(BotProfiles::new(Arc::clone(&store)));
        let config = RuntimeConfig::from_app_config(&AppConfig::default(), dir.to_string_lossy())
            .with_profile_source(profiles.clone());
        profiles.attach(RuntimeSupervisor::start(config));
        (dir, store, profiles)
    }

    fn turn(channel: &str) -> ProfileTurn {
        ProfileTurn {
            origin: Origin {
                channel: channel.into(),
                sender: None,
                trust: Trust::Owner,
            },
            // Unknown provider: a teammate's turn fails fast, offline.
            provider: "definitely-not-a-provider".into(),
            model: "m".into(),
            thinking_level: "off".into(),
        }
    }

    fn names(tools: &[Box<dyn Tool>]) -> Vec<&str> {
        tools.iter().map(|tool| tool.name()).collect()
    }

    #[tokio::test]
    async fn a_bot_answering_a_handoff_cannot_hand_work_on() {
        let (dir, _store, profiles) = setup("names");
        assert_eq!(
            names(&profiles.tools("colina", &turn("local"))),
            ["memory_update", "message_bot"]
        );
        assert_eq!(
            names(&profiles.tools("scout", &turn(HANDOFF_CHANNEL))),
            ["memory_update"]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn memory_update_edits_the_bots_own_memory() {
        let (dir, store, profiles) = setup("memory");
        let tools = profiles.tools("colina", &turn("local"));
        let result = tools[0]
            .execute(json!({ "action": "add", "line": "Prefers tea." }), ".")
            .await
            .unwrap();
        assert_eq!(result, "Memory saved (1 note).");
        assert!(store.persona("colina").unwrap().contains("Prefers tea."));
        assert!(tools[0]
            .execute(json!({ "action": "remove", "line": "coffee" }), ".")
            .await
            .is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn handoffs_to_one_bot_wait_in_line_and_others_do_not() {
        let queues = Arc::new(HandoffQueues::default());
        let scout = queues.gate("scout");
        let held = scout.lock().await;
        // A second handoff to Scout waits for the first…
        assert!(queues.gate("scout").try_lock().is_err());
        // …while one to another bot goes ahead.
        assert!(queues.gate("quill").try_lock().is_ok());
        drop(held);
        assert!(queues.gate("scout").try_lock().is_ok());

        // Two bots never wait on each other.
        let colina_to_scout = queues.begin("colina", "scout").unwrap();
        assert!(queues.begin("scout", "colina").is_none());
        drop(colina_to_scout);
        assert!(queues.begin("scout", "colina").is_some());
    }

    #[tokio::test]
    async fn message_bot_reports_what_went_wrong() {
        let (dir, _store, profiles) = setup("message");
        let tools = profiles.tools("colina", &turn("local"));
        let message = &tools[1];
        let error = |result: Result<String, ToolError>| result.unwrap_err().to_string();
        assert!(error(
            message
                .execute(json!({ "to": "@colina", "message": "hi" }), ".")
                .await
        )
        .contains("That's you"));
        assert!(error(
            message
                .execute(json!({ "to": "nobody", "message": "hi" }), ".")
                .await
        )
        .contains("no bot"));
        // The teammate's turn runs (in its own session) and fails offline.
        let failed = error(
            message
                .execute(json!({ "to": "Scout", "message": "hi" }), ".")
                .await,
        );
        assert!(failed.contains("@scout couldn't finish"), "{failed}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
