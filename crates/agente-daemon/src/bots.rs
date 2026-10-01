//! The bot roster over the socket (`bots.*`), and the personas the runtime
//! reads when a turn names a bot as its profile.
//!
//! Every bot has one permanent session. `bots.chat` runs a turn there, in the
//! bot's own workspace folder, on the bot's pinned model when it has one.

use std::sync::{Arc, OnceLock};

use agente_bot::{BotConfig, BotError, BotStore, Doc, NewBot};
use agente_core::tools::Tool;
use agente_protocol::{Message, Origin, RuntimeEvent, SessionId, StartTurn, TurnMode};
use agente_runtime::{ProfileSource, ProfileTurn, RuntimeHandle};
use serde::Deserialize;
use serde_json::{json, Value};

use super::connection::{parse, Failure};
use crate::bot_tools::{HandoffQueues, MemoryUpdateTool, MessageBotTool, HANDOFF_CHANNEL};
use agente_acp::rpc;

/// What the runtime asks about bots: their personas (straight from the bot
/// files, so a memory edit is in the very next turn) and their own tools.
pub struct BotProfiles {
    store: Arc<BotStore>,
    /// Set once the runtime is running: handoffs start turns on it.
    runtime: OnceLock<RuntimeHandle>,
    /// Handoffs waiting for a busy teammate, per bot.
    queues: Arc<HandoffQueues>,
}

impl BotProfiles {
    pub fn new(store: Arc<BotStore>) -> Self {
        Self {
            store,
            runtime: OnceLock::new(),
            queues: Arc::default(),
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
                Arc::clone(&self.queues),
                runtime.clone(),
                profile,
                turn,
            )));
        }
        tools
    }

    fn sandbox(&self, profile: &str) -> agente_core::sandbox::SandboxPolicy {
        match self.store.get(profile) {
            Ok(bot) => sandbox_policy(&bot.config.sandbox),
            // Unreadable bot: the closed default.
            Err(_) => agente_core::sandbox::SandboxPolicy::default(),
        }
    }

    fn tool_names(&self, profile: &str) -> Option<Vec<String>> {
        // A bot that can't be read gets no built-in tools rather than all of them.
        match self.store.get(profile) {
            Ok(bot) => agente_bot::tool_allowlist(&bot.config.toolsets),
            Err(_) => Some(Vec::new()),
        }
    }
}

/// A bot's `[sandbox]` settings as the box's policy (`~/` is the home folder).
fn sandbox_policy(settings: &agente_bot::SandboxSettings) -> agente_core::sandbox::SandboxPolicy {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let path = |text: &String| match (text.strip_prefix("~/"), &home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => std::path::PathBuf::from(text),
    };
    let default = agente_core::sandbox::SandboxPolicy::default();
    agente_core::sandbox::SandboxPolicy {
        network: settings.network,
        read: settings.read.iter().map(path).collect(),
        write: settings.write.iter().map(path).collect(),
        file_mb: settings.file_mb.unwrap_or(default.file_mb),
        cpu_secs: settings.cpu_secs.unwrap_or(default.cpu_secs),
    }
}

/// Whether a bot's turns run in auto: only when its programs are boxed and
/// it can't use MCP tools (their servers run outside the box). Otherwise
/// every change waits for an approval.
fn runs_boxed_auto(bot: &agente_bot::Bot) -> bool {
    agente_core::sandbox::available()
        && agente_bot::tool_allowlist(&bot.config.toolsets)
            .is_some_and(|tools| !tools.iter().any(|tool| tool == "mcp"))
}

/// Follow every bot's turns: add the cost of each model call to the bot's
/// spend for today (so its daily budget can stop the next turn), and write
/// each tool call it makes to its activity log.
pub fn spawn_bot_tracker(service: crate::Service) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut events = service.runtime.subscribe();
        // Which bot a session belongs to (`None`: not a bot's), looked up once.
        let mut owners: std::collections::HashMap<String, Option<String>> =
            std::collections::HashMap::new();
        // Tool calls under way: id → (tool, arguments, started).
        let mut pending: std::collections::HashMap<String, (String, String, std::time::Instant)> =
            std::collections::HashMap::new();
        loop {
            let envelope = match events.recv().await {
                Ok(envelope) => envelope,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                    tracing::warn!(
                        missed,
                        "bot tracker fell behind; some costs and activity were not recorded"
                    );
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            let session = envelope.session_id.to_string();
            let handle = owners
                .entry(session.clone())
                .or_insert_with(|| owner_of(&service.bots, &session))
                .clone();
            let Some(handle) = handle else { continue };
            match envelope.event {
                RuntimeEvent::CallUsage {
                    cost_usd: Some(cost),
                    ..
                } => record_spend(&service.bots, &handle, cost),
                RuntimeEvent::ToolProposed {
                    id,
                    name,
                    arguments,
                } => {
                    pending.insert(id, (name, arguments, std::time::Instant::now()));
                }
                RuntimeEvent::ToolResult { id, is_error, .. } => {
                    if let Some((tool, arguments, started)) = pending.remove(&id) {
                        let ms = started.elapsed().as_millis() as u64;
                        let entry = agente_bot::Activity::new(
                            chrono::Utc::now(),
                            &tool,
                            &arguments,
                            !is_error,
                            ms,
                        );
                        if let Err(error) = service.bots.record_activity(&handle, &entry) {
                            tracing::warn!(%error, bot = handle, "could not record the bot's activity");
                        }
                    }
                }
                _ => {}
            }
        }
    })
}

fn owner_of(store: &BotStore, session_id: &str) -> Option<String> {
    match store.handle_for_session(session_id) {
        Ok(handle) => handle,
        Err(error) => {
            tracing::warn!(%error, "could not look up the bot of a session");
            None
        }
    }
}

fn record_spend(store: &BotStore, handle: &str, cost: f64) {
    if let Err(error) = store.add_spend(handle, chrono::Local::now().date_naive(), cost) {
        tracing::warn!(%error, bot = handle, "could not record the bot's spend");
    }
}

#[derive(Deserialize)]
struct HandleParams {
    handle: String,
}

#[derive(Deserialize)]
struct TokenParams {
    handle: String,
    token: String,
}

#[derive(Deserialize)]
struct PairParams {
    handle: String,
    trust: agente_bot::ChannelTrust,
}

#[derive(Deserialize)]
struct UnpairParams {
    handle: String,
    chat_id: i64,
}

/// `<digits>:<35 or so letters, digits, _ and ->`, as @BotFather gives them.
fn looks_like_telegram_token(token: &str) -> bool {
    let token = token.trim();
    token.split_once(':').is_some_and(|(id, secret)| {
        !id.is_empty()
            && id.chars().all(|c| c.is_ascii_digit())
            && secret.len() >= 30
            && secret
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    })
}

/// A bot's Telegram channel as Desktop shows it (never the token itself).
fn telegram_status(store: &BotStore, handle: &str) -> Result<Value, Failure> {
    let connected = store.telegram_token(handle).map_err(bot_failure)?.is_some();
    let state = store.telegram_state(handle).map_err(bot_failure)?;
    let now = chrono::Utc::now();
    Ok(json!({
        "connected": connected,
        "username": state.username,
        "error": state.error,
        "paired": state.paired,
        "pairing": state.pairing.filter(|code| code.expires_at > now),
    }))
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
    value["spent_today"] = json!(store
        .spent_on(&bot.handle, chrono::Local::now().date_naive())
        .map_err(bot_failure)?);
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
        // The toolsets a bot can be given, for the editor's Tools section.
        "bots.toolsets" => Ok(json!(agente_bot::TOOLSETS)),
        // What a bot did, newest last (`limit`, default 200).
        "bots.activity" => {
            #[derive(Deserialize)]
            struct ActivityParams {
                handle: String,
                #[serde(default = "default_activity_limit")]
                limit: usize,
            }
            fn default_activity_limit() -> usize {
                200
            }
            let ActivityParams { handle, limit } = parse(params)?;
            let entries = store.activity(&handle, limit).map_err(bot_failure)?;
            Ok(json!(entries))
        }
        // Whether this machine boxes bots' programs, and how.
        "bots.sandbox" => Ok(json!({
            "backend": agente_core::sandbox::backend(),
            "available": agente_core::sandbox::available(),
        })),
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
        "bots.telegram" => {
            let HandleParams { handle } = parse(params)?;
            telegram_status(store, &handle)
        }
        // Connecting takes effect within a few seconds (the channel poller
        // picks the token up); `bots.telegram` then shows the @name or error.
        "bots.telegram_connect" => {
            let TokenParams { handle, token } = parse(params)?;
            if !looks_like_telegram_token(&token) {
                return Err((
                    rpc::INVALID_PARAMS,
                    "That doesn't look like a Telegram bot token (from @BotFather, like 123456:ABC…).".into(),
                ));
            }
            store
                .set_telegram_token(&handle, Some(&token))
                .map_err(bot_failure)?;
            telegram_status(store, &handle)
        }
        "bots.telegram_disconnect" => {
            let HandleParams { handle } = parse(params)?;
            store
                .set_telegram_token(&handle, None)
                .map_err(bot_failure)?;
            telegram_status(store, &handle)
        }
        "bots.telegram_pair" => {
            let PairParams { handle, trust } = parse(params)?;
            let code = store
                .new_pairing_code(&handle, trust, chrono::Utc::now())
                .map_err(bot_failure)?;
            Ok(json!(code))
        }
        "bots.telegram_unpair" => {
            let UnpairParams { handle, chat_id } = parse(params)?;
            store.unpair_chat(&handle, chat_id).map_err(bot_failure)?;
            telegram_status(store, &handle)
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
#[derive(Clone, Default)]
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
    store.check_budget(handle, chrono::Local::now().date_naive())?;
    // Boxed bots work unattended; the rest ask before each change.
    let mode = if runs_boxed_auto(&bot) {
        TurnMode::Auto
    } else {
        TurnMode::Build
    };
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
    // The thinking level goes with the model it was chosen for: the pin's
    // with the pin, the client's with the client's model.
    let (provider, model, thinking_level) = match bot.config.model {
        Some(pin) => (Some(pin.provider), Some(pin.model), pin.thinking),
        None => (fallback.provider, fallback.model, fallback.thinking_level),
    };
    Ok(StartTurn {
        session_id,
        prompt: Some(Message::user(text)),
        provider,
        model,
        thinking_level,
        profile: Some(bot.handle),
        mode: Some(mode),
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
    fn a_bots_toolsets_limit_its_built_in_tools() {
        let dir = std::env::temp_dir().join(format!("agente-bots-tools-{}", std::process::id()));
        let store = Arc::new(BotStore::open(&dir).unwrap());
        let profiles = BotProfiles::new(Arc::clone(&store));
        // No toolsets (every bot made before them): every tool.
        assert_eq!(profiles.tool_names("colina"), None);
        let mut config = store.get("colina").unwrap().config;
        config.toolsets = vec!["web".into()];
        store.update("colina", config).unwrap();
        assert_eq!(
            profiles.tool_names("colina"),
            Some(vec!["web_search".to_string(), "web_fetch".to_string()])
        );
        // Unknown bot: nothing built in, never everything.
        assert_eq!(profiles.tool_names("nobody"), Some(Vec::new()));
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
            thinking: Some("high".into()),
        });
        store.update("colina", config).unwrap();
        let turn = chat_turn(
            &store,
            json!({ "handle": "colina", "text": "hi", "model": "client", "thinking_level": "low" }),
        )
        .unwrap();
        assert_eq!(turn.model.as_deref(), Some("pinned"));
        assert_eq!(turn.provider.as_deref(), Some("openrouter"));
        // The pin's thinking level, never the client's (it was for another model).
        assert_eq!(turn.thinking_level.as_deref(), Some("high"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_bot_past_its_daily_budget_starts_no_turn() {
        let dir = std::env::temp_dir().join(format!("agente-bots-budget-{}", std::process::id()));
        assert!(looks_like_telegram_token(
            "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
        ));
        assert!(!looks_like_telegram_token("hello"));
        assert!(!looks_like_telegram_token(
            "12a:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
        ));
        let store = BotStore::open(&dir).unwrap();
        let mut config = store.get("colina").unwrap().config;
        config.daily_budget = Some(0.5);
        store.update("colina", config).unwrap();
        let params = json!({ "handle": "colina", "text": "hi" });
        chat_turn(&store, params.clone()).unwrap();

        // The tracker finds a session's bot, then records its spend.
        let session = store.session_id("colina").unwrap().unwrap();
        let owner = owner_of(&store, &session).unwrap();
        record_spend(&store, &owner, 0.6);
        let (_, message) = chat_turn(&store, params).unwrap_err();
        assert!(message.contains("daily budget"), "{message}");
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

        // Clients list the toolsets from the core, not from a copy of their own.
        let sets = call("bots.toolsets", Value::Null).unwrap();
        assert_eq!(sets[0]["id"], "core");
        assert!(sets[0]["tools"]
            .as_array()
            .unwrap()
            .contains(&json!("read_file")));
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
