//! The bot roster over the socket (`bots.*`), and the personas the runtime
//! reads when a turn names a bot as its profile.
//!
//! Every bot has one permanent session. `bots.chat` runs a turn there, in the
//! bot's own workspace folder, on the bot's pinned model when it has one.

use std::sync::{Arc, OnceLock};

use agente_bot::{BotConfig, BotError, BotStore, Doc, NewBot};
use agente_core::tools::Tool;
use agente_protocol::{Message, Origin, SessionId, StartTurn, TurnMode};
use agente_runtime::{ProfileSource, ProfileTurn, RuntimeHandle};
use serde::Deserialize;
use serde_json::{json, Value};

use super::connection::{parse, Failure};
use crate::bot_tools::{MemoryUpdateTool, MessageBotTool, HANDOFF_CHANNEL};
use agente_acp::rpc;

/// What the runtime asks about bots: their personas (straight from the bot
/// files, so a memory edit is in the very next turn) and their own tools.
pub struct BotProfiles {
    store: Arc<BotStore>,
    /// Set once the runtime is running: handoffs start turns on it.
    runtime: OnceLock<RuntimeHandle>,
}

impl BotProfiles {
    pub fn new(store: Arc<BotStore>) -> Self {
        Self {
            store,
            runtime: OnceLock::new(),
        }
    }

    /// Hand over the runtime these profiles belong to (enables `message_bot`).
    pub fn attach(&self, runtime: RuntimeHandle) {
        let _ = self.runtime.set(runtime);
    }
}

impl ProfileSource for BotProfiles {
    fn persona(&self, profile: &str) -> Option<String> {
        self.store.persona(profile).ok()
    }

    fn tools(&self, profile: &str, turn: &ProfileTurn) -> Vec<Box<dyn Tool>> {
        let mut tools: Vec<Box<dyn Tool>> = vec![Box::new(MemoryUpdateTool::new(
            Arc::clone(&self.store),
            profile,
        ))];
        // A bot answering a handoff can't hand work on: no loops, no chains.
        let answering_a_bot = turn.origin.channel == HANDOFF_CHANNEL;
        if let (false, Some(runtime)) = (answering_a_bot, self.runtime.get()) {
            tools.push(Box::new(MessageBotTool::new(
                Arc::clone(&self.store),
                runtime.clone(),
                profile,
                turn,
            )));
        }
        tools
    }
}

#[derive(Deserialize)]
struct HandleParams {
    handle: String,
}

#[derive(Deserialize)]
struct UpdateParams {
    handle: String,
    config: BotConfig,
}

#[derive(Deserialize)]
struct DocParams {
    handle: String,
    doc: Doc,
    text: String,
}

#[derive(Deserialize)]
pub(crate) struct ChatParams {
    handle: String,
    text: String,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    thinking_level: Option<String>,
}

pub(crate) fn bot_failure(error: BotError) -> Failure {
    let code = match error {
        BotError::Io(_) | BotError::Config { .. } => rpc::INTERNAL_ERROR,
        _ => rpc::INVALID_PARAMS,
    };
    (code, error.to_string())
}

/// A bot as clients see it: its settings, its chat session, and whether it
/// is working on something right now.
fn with_session(
    store: &BotStore,
    runtime: &RuntimeHandle,
    bot: &agente_bot::Bot,
) -> Result<Value, Failure> {
    let mut value = serde_json::to_value(bot).map_err(|e| (rpc::INTERNAL_ERROR, e.to_string()))?;
    let session_id = store.session_id(&bot.handle).map_err(bot_failure)?;
    let working = session_id
        .as_deref()
        .and_then(|id| id.parse::<SessionId>().ok())
        .is_some_and(|id| runtime.is_busy(id));
    value["session_id"] = json!(session_id);
    value["working"] = json!(working);
    Ok(value)
}

/// `bots.*` requests other than `bots.chat` (which starts a turn).
pub(crate) fn handle(
    store: &BotStore,
    runtime: &RuntimeHandle,
    method: &str,
    params: Value,
) -> Result<Value, Failure> {
    match method {
        "bots.list" => {
            let bots = store.list().map_err(bot_failure)?;
            Ok(Value::Array(
                bots.iter()
                    .map(|bot| with_session(store, runtime, bot))
                    .collect::<Result<_, _>>()?,
            ))
        }
        "bots.get" => {
            let HandleParams { handle } = parse(params)?;
            let bot = store.get(&handle).map_err(bot_failure)?;
            let mut value = with_session(store, runtime, &bot)?;
            for (key, doc) in [
                ("soul", Doc::Soul),
                ("user", Doc::User),
                ("memory", Doc::Memory),
            ] {
                value[key] = json!(store.read_doc(&handle, doc).map_err(bot_failure)?);
            }
            Ok(value)
        }
        "bots.create" => {
            let new: NewBot = parse(params)?;
            let bot = store.create(new).map_err(bot_failure)?;
            with_session(store, runtime, &bot)
        }
        "bots.update" => {
            let UpdateParams { handle, config } = parse(params)?;
            let bot = store.update(&handle, config).map_err(bot_failure)?;
            with_session(store, runtime, &bot)
        }
        "bots.delete" => {
            let HandleParams { handle } = parse(params)?;
            store.delete(&handle).map_err(bot_failure)?;
            Ok(json!({ "deleted": true }))
        }
        // `/new` in a bot's chat: the bot keeps its one conversation, shortened
        // (its memory carries what matters), instead of starting over.
        "bots.compact" => {
            let HandleParams { handle } = parse(params)?;
            let session_id = store
                .session_id(&handle)
                .map_err(bot_failure)?
                .and_then(|id| id.parse::<SessionId>().ok());
            match session_id {
                Some(id) => {
                    let snapshot = runtime
                        .compact(id)
                        .map_err(crate::connection::runtime_failure)?;
                    Ok(json!({ "messages": snapshot.conversation.len() }))
                }
                None => Ok(json!({ "messages": 0 })),
            }
        }
        "bots.write_doc" => {
            let DocParams { handle, doc, text } = parse(params)?;
            store.write_doc(&handle, doc, &text).map_err(bot_failure)?;
            Ok(json!({ "ok": true }))
        }
        _ => Err((rpc::METHOD_NOT_FOUND, format!("unknown method {method}"))),
    }
}

/// The turn a `bots.chat` request starts, in the bot's permanent session.
pub(crate) fn chat_turn(store: &BotStore, params: Value) -> Result<StartTurn, Failure> {
    let ChatParams {
        handle,
        text,
        provider,
        model,
        thinking_level,
    } = parse(params)?;
    let fallback = ClientModel {
        provider,
        model,
        thinking_level,
    };
    bot_turn(store, &handle, text, fallback, None).map_err(bot_failure)
}

/// The model a client (or the bot handing work over) is using.
#[derive(Default)]
pub(crate) struct ClientModel {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
}

/// A turn in `handle`'s permanent session and workspace, on its pinned model
/// when it has one and on `fallback` otherwise.
pub(crate) fn bot_turn(
    store: &BotStore,
    handle: &str,
    text: String,
    fallback: ClientModel,
    origin: Option<Origin>,
) -> Result<StartTurn, BotError> {
    let bot = store.get(handle)?;
    let session_id = match store
        .session_id(handle)?
        .and_then(|id| id.parse::<SessionId>().ok())
    {
        Some(id) => id,
        None => {
            let id = SessionId::new();
            store.set_session_id(handle, &id.to_string())?;
            id
        }
    };
    let workspace = store.workspace(handle)?;
    let (provider, model) = match bot.config.model {
        Some(pin) => (Some(pin.provider), Some(pin.model)),
        None => (fallback.provider, fallback.model),
    };
    Ok(StartTurn {
        session_id,
        prompt: Some(Message::user(text)),
        provider,
        model,
        thinking_level: fallback.thinking_level,
        profile: Some(bot.handle),
        mode: Some(TurnMode::Build),
        origin,
        project_dir: Some(workspace.to_string_lossy().to_string()),
        ..StartTurn::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bot_chat_keeps_one_session_in_its_workspace() {
        let dir = std::env::temp_dir().join(format!("agente-bots-chat-{}", std::process::id()));
        let store = BotStore::open(&dir).unwrap();
        let first = chat_turn(
            &store,
            json!({ "handle": "colina", "text": "hi", "model": "m" }),
        )
        .unwrap();
        let second = chat_turn(&store, json!({ "handle": "colina", "text": "again" })).unwrap();
        assert_eq!(first.session_id, second.session_id);
        assert_eq!(first.profile.as_deref(), Some("colina"));
        assert_eq!(first.model.as_deref(), Some("m"));
        assert!(first.project_dir.unwrap().ends_with("workspace"));
        assert!(chat_turn(&store, json!({ "handle": "nobody", "text": "x" })).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_pinned_model_wins_over_the_clients() {
        let dir = std::env::temp_dir().join(format!("agente-bots-pin-{}", std::process::id()));
        let store = BotStore::open(&dir).unwrap();
        let mut config = store.get("colina").unwrap().config;
        config.model = Some(agente_bot::ModelPin {
            provider: "openrouter".into(),
            model: "pinned".into(),
        });
        store.update("colina", config).unwrap();
        let turn = chat_turn(
            &store,
            json!({ "handle": "colina", "text": "hi", "model": "client" }),
        )
        .unwrap();
        assert_eq!(turn.model.as_deref(), Some("pinned"));
        assert_eq!(turn.provider.as_deref(), Some("openrouter"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn colina_cannot_be_deleted_and_the_roster_says_who_is_working() {
        use agente_core::config::AppConfig;
        use agente_runtime::{RuntimeConfig, RuntimeSupervisor};

        let dir = std::env::temp_dir().join(format!("agente-bots-del-{}", std::process::id()));
        let store = BotStore::open(dir.join("bots")).unwrap();
        let runtime = RuntimeSupervisor::start(RuntimeConfig::from_app_config(
            &AppConfig::default(),
            dir.to_string_lossy(),
        ));
        let call = |method: &str, params: Value| handle(&store, &runtime, method, params);

        let (code, message) = call("bots.delete", json!({ "handle": "colina" })).unwrap_err();
        assert_eq!(code, rpc::INVALID_PARAMS);
        assert!(message.contains("built in"));
        let created = call(
            "bots.create",
            json!({ "title": "Scout", "role": "research" }),
        )
        .unwrap();
        assert_eq!(created["handle"], "scout");
        assert_eq!(created["working"], false);
        let list = call("bots.list", Value::Null).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 2);

        // A turn in Colina's session makes her "working" until it ends.
        let start = chat_turn(
            &store,
            json!({ "handle": "colina", "text": "hi", "provider": "definitely-not-a-provider" }),
        )
        .unwrap();
        let mut turn = runtime.start_turn(start).unwrap();
        assert_eq!(
            call("bots.get", json!({ "handle": "colina" })).unwrap()["working"],
            true
        );
        let _ = turn.outcome().await;
        assert_eq!(
            call("bots.get", json!({ "handle": "colina" })).unwrap()["working"],
            false
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
