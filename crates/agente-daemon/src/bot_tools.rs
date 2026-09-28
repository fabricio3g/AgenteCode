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
    runtime: RuntimeHandle,
    from: String,
    trust: Trust,
    model: ProfileTurn,
}

impl MessageBotTool {
    pub(crate) fn new(
        store: Arc<BotStore>,
        runtime: RuntimeHandle,
        from: &str,
        turn: &ProfileTurn,
    ) -> Self {
        Self {
            store,
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
        let start = bot_turn(&self.store, &target.handle, text, fallback, Some(origin))
            .map_err(|error| failed(error.to_string()))?;
        let session_id = start.session_id;
        let mut turn = self
            .runtime
            .start_turn(start)
            .map_err(|error| match error {
                RuntimeError::SessionBusy(_) => failed(format!(
                    "@{} is busy in another conversation; try again in a moment.",
                    target.handle
                )),
                other => failed(other.to_string()),
            })?;
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
