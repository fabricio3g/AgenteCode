//! The bot roster over the socket (`bots.*`), and the personas the runtime
//! reads when a turn names a bot as its profile.
//!
//! Every bot has one permanent session. `bots.chat` runs a turn there, in the
//! bot's own workspace folder, on the bot's pinned model when it has one.

use std::sync::Arc;

use agente_bot::{BotConfig, BotError, BotStore, Doc, NewBot};
use agente_protocol::{Message, SessionId, StartTurn, TurnMode};
use agente_runtime::ProfileSource;
use serde::Deserialize;
use serde_json::{json, Value};

use super::connection::{parse, Failure};
use agente_acp::rpc;

/// Personas for the runtime, straight from the bot files: an edit to a
/// bot's memory is in its very next turn.
pub struct BotProfiles(pub Arc<BotStore>);

impl ProfileSource for BotProfiles {
    fn persona(&self, profile: &str) -> Option<String> {
        self.0.persona(profile).ok()
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

fn bot_failure(error: BotError) -> Failure {
    let code = match error {
        BotError::Io(_) | BotError::Config { .. } => rpc::INTERNAL_ERROR,
        _ => rpc::INVALID_PARAMS,
    };
    (code, error.to_string())
}

fn with_session(store: &BotStore, bot: &agente_bot::Bot) -> Result<Value, Failure> {
    let mut value = serde_json::to_value(bot).map_err(|e| (rpc::INTERNAL_ERROR, e.to_string()))?;
    value["session_id"] = json!(store.session_id(&bot.handle).map_err(bot_failure)?);
    Ok(value)
}

/// `bots.*` requests other than `bots.chat` (which starts a turn).
pub(crate) fn handle(store: &BotStore, method: &str, params: Value) -> Result<Value, Failure> {
    match method {
        "bots.list" => {
            let bots = store.list().map_err(bot_failure)?;
            Ok(Value::Array(
                bots.iter()
                    .map(|bot| with_session(store, bot))
                    .collect::<Result<_, _>>()?,
            ))
        }
        "bots.get" => {
            let HandleParams { handle } = parse(params)?;
            let bot = store.get(&handle).map_err(bot_failure)?;
            let mut value = with_session(store, &bot)?;
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
            with_session(store, &bot)
        }
        "bots.update" => {
            let UpdateParams { handle, config } = parse(params)?;
            let bot = store.update(&handle, config).map_err(bot_failure)?;
            with_session(store, &bot)
        }
        "bots.delete" => {
            let HandleParams { handle } = parse(params)?;
            store.delete(&handle).map_err(bot_failure)?;
            Ok(json!({ "deleted": true }))
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
    let bot = store.get(&handle).map_err(bot_failure)?;
    let session_id = match store
        .session_id(&handle)
        .map_err(bot_failure)?
        .and_then(|id| id.parse::<SessionId>().ok())
    {
        Some(id) => id,
        None => {
            let id = SessionId::new();
            store
                .set_session_id(&handle, &id.to_string())
                .map_err(bot_failure)?;
            id
        }
    };
    let workspace = store.workspace(&handle).map_err(bot_failure)?;
    // A pinned model wins; otherwise whatever the client is using.
    let (provider, model) = match bot.config.model {
        Some(pin) => (Some(pin.provider), Some(pin.model)),
        None => (provider, model),
    };
    Ok(StartTurn {
        session_id,
        prompt: Some(Message::user(text)),
        provider,
        model,
        thinking_level,
        profile: Some(bot.handle),
        mode: Some(TurnMode::Build),
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

    #[test]
    fn colina_cannot_be_deleted_over_the_socket() {
        let dir = std::env::temp_dir().join(format!("agente-bots-del-{}", std::process::id()));
        let store = BotStore::open(&dir).unwrap();
        let (code, message) =
            handle(&store, "bots.delete", json!({ "handle": "colina" })).unwrap_err();
        assert_eq!(code, rpc::INVALID_PARAMS);
        assert!(message.contains("built in"));
        let created = handle(
            &store,
            "bots.create",
            json!({ "title": "Scout", "role": "research" }),
        )
        .unwrap();
        assert_eq!(created["handle"], "scout");
        assert_eq!(
            handle(&store, "bots.list", Value::Null)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
