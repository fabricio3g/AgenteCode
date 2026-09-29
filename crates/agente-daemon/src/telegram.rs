//! Bots on Telegram. A bot with a Telegram token (from @BotFather) gets a
//! poller here: people it has been paired with message it privately, each
//! message runs as a turn in the bot's one session (on the bot's own model,
//! within its budget), and the answer is sent back. Owner chats run with the
//! owner's trust and approve tools with buttons; trusted chats are
//! read-only. Everyone else is told to ask the owner for a pairing code.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use agente_bot::{BotStore, ChannelTrust};
use agente_protocol::{ApprovalDecision, ApprovalDecisionKind, Origin, RuntimeEvent, Trust};
use agente_runtime::RuntimeError;
use async_trait::async_trait;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::bots::{bot_turn, ClientModel};
use crate::Service;

const API: &str = "https://api.telegram.org";
/// Long-poll wait for new messages, in seconds.
const POLL_SECONDS: u64 = 30;
/// How often the set of connected bots is checked.
const RECONCILE: Duration = Duration::from_secs(10);
/// Telegram's limit is 4096 characters a message.
const MESSAGE_CHARS: usize = 4000;
/// How long a message waits for the bot to finish another conversation.
const BUSY_WAIT: Duration = Duration::from_secs(600);
pub(crate) const CHANNEL: &str = "telegram";

#[derive(Debug)]
pub(crate) enum ApiError {
    /// The token is wrong or was revoked.
    Unauthorized,
    Other(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Unauthorized => f.write_str("Telegram rejected the token"),
            ApiError::Other(message) => f.write_str(message),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Update {
    update_id: i64,
    #[serde(default)]
    message: Option<TgMessage>,
    #[serde(default)]
    callback_query: Option<Callback>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct TgMessage {
    message_id: i64,
    chat: Chat,
    #[serde(default)]
    from: Option<User>,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Chat {
    id: i64,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct User {
    #[serde(default)]
    first_name: String,
    #[serde(default)]
    username: Option<String>,
}

impl User {
    fn display(&self) -> String {
        match &self.username {
            Some(username) => format!("{} (@{username})", self.first_name),
            None => self.first_name.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Callback {
    id: String,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    message: Option<TgMessage>,
}

/// The Telegram Bot API calls the channel uses (faked in tests).
#[async_trait]
pub(crate) trait TelegramApi: Send + Sync {
    async fn get_me(&self) -> Result<String, ApiError>;
    async fn get_updates(&self, offset: i64) -> Result<Vec<Update>, ApiError>;
    async fn send(&self, chat_id: i64, text: &str, buttons: Option<Value>) -> Result<(), ApiError>;
    async fn typing(&self, chat_id: i64);
    async fn answer_callback(&self, callback_id: &str, text: &str);
    async fn edit(&self, chat_id: i64, message_id: i64, text: &str);
}

struct HttpApi {
    client: reqwest::Client,
    /// Holds the token: never logged (errors drop the URL).
    base: String,
}

impl HttpApi {
    fn new(token: &str) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(POLL_SECONDS + 15))
                .build()
                .unwrap_or_default(),
            base: format!("{API}/bot{token}"),
        }
    }

    async fn call(&self, method: &str, body: Value) -> Result<Value, ApiError> {
        let response = self
            .client
            .post(format!("{}/{method}", self.base))
            .json(&body)
            .send()
            .await
            .map_err(|error| ApiError::Other(error.without_url().to_string()))?;
        let status = response.status();
        let reply: Value = response
            .json()
            .await
            .map_err(|error| ApiError::Other(error.without_url().to_string()))?;
        if status == reqwest::StatusCode::UNAUTHORIZED || reply["error_code"] == 401 {
            return Err(ApiError::Unauthorized);
        }
        if reply["ok"] != true {
            let description = reply["description"].as_str().unwrap_or("request failed");
            return Err(ApiError::Other(format!("Telegram: {description}")));
        }
        Ok(reply["result"].clone())
    }
}

#[async_trait]
impl TelegramApi for HttpApi {
    async fn get_me(&self) -> Result<String, ApiError> {
        let me = self.call("getMe", json!({})).await?;
        Ok(me["username"].as_str().unwrap_or_default().to_string())
    }

    async fn get_updates(&self, offset: i64) -> Result<Vec<Update>, ApiError> {
        let updates = self
            .call(
                "getUpdates",
                json!({ "offset": offset, "timeout": POLL_SECONDS, "allowed_updates": ["message", "callback_query"] }),
            )
            .await?;
        Ok(serde_json::from_value(updates).unwrap_or_default())
    }

    async fn send(&self, chat_id: i64, text: &str, buttons: Option<Value>) -> Result<(), ApiError> {
        let mut body = json!({ "chat_id": chat_id, "text": text });
        if let Some(buttons) = buttons {
            body["reply_markup"] = json!({ "inline_keyboard": buttons });
        }
        self.call("sendMessage", body).await.map(|_| ())
    }

    async fn typing(&self, chat_id: i64) {
        let _ = self
            .call(
                "sendChatAction",
                json!({ "chat_id": chat_id, "action": "typing" }),
            )
            .await;
    }

    async fn answer_callback(&self, callback_id: &str, text: &str) {
        let _ = self
            .call(
                "answerCallbackQuery",
                json!({ "callback_query_id": callback_id, "text": text }),
            )
            .await;
    }

    async fn edit(&self, chat_id: i64, message_id: i64, text: &str) {
        let _ = self
            .call(
                "editMessageText",
                json!({ "chat_id": chat_id, "message_id": message_id, "text": text }),
            )
            .await;
    }
}

/// What to do with an incoming message.
#[derive(Debug, PartialEq)]
pub(crate) enum Action {
    Ignore,
    Reply(String),
    /// A paired person's message: run it as a turn.
    Run {
        text: String,
        trust: ChannelTrust,
        name: String,
    },
}

const ASK_FOR_A_CODE: &str = "Hi! I only talk with people my owner has paired with me. Ask them for a pairing code, then send: /pair 123456";

/// Decide what a private message gets: pairing, instructions, or a turn.
pub(crate) fn decide(store: &BotStore, handle: &str, message: &TgMessage) -> Action {
    // Groups would let anyone in them talk to the bot: private chats only.
    if message.chat.kind != "private" {
        return Action::Ignore;
    }
    let Some(text) = message.text.as_deref().map(str::trim) else {
        return Action::Reply("I can only read text messages for now.".into());
    };
    let name = message
        .from
        .as_ref()
        .map(User::display)
        .unwrap_or_else(|| "someone".into());
    let chat_id = message.chat.id;
    let trust = store.paired_trust(handle, chat_id).ok().flatten();
    if let Some(code) = text.strip_prefix("/pair") {
        let code = code.trim();
        if code.is_empty() {
            return Action::Reply("Send the code after /pair, like: /pair 123456".into());
        }
        return match store.redeem_pairing_code(handle, code, chat_id, &name, Utc::now()) {
            Ok(Some(ChannelTrust::Owner)) => {
                Action::Reply("Paired as my owner. Write to me any time.".into())
            }
            Ok(Some(ChannelTrust::Trusted)) => Action::Reply(
                "Paired. I can chat and look things up for you; I won't change files or run commands here."
                    .into(),
            ),
            _ => Action::Reply(
                "That code didn't work. Codes last 10 minutes and work once; ask for a new one."
                    .into(),
            ),
        };
    }
    match trust {
        None => Action::Reply(ASK_FOR_A_CODE.into()),
        Some(_) if text == "/start" => Action::Reply("Hi again! Just write to me.".into()),
        Some(trust) => Action::Run {
            text: text.to_string(),
            trust,
            name,
        },
    }
}

/// `ap:<request id>:<o|a|n>` from an approval button.
fn approval_from_button(data: &str) -> Option<(String, ApprovalDecisionKind)> {
    let rest = data.strip_prefix("ap:")?;
    let (request_id, kind) = rest.rsplit_once(':')?;
    let decision = match kind {
        "o" => ApprovalDecisionKind::ApproveOnce,
        "a" => ApprovalDecisionKind::ApproveAll,
        "n" => ApprovalDecisionKind::Deny,
        _ => return None,
    };
    Some((request_id.to_string(), decision))
}

/// Split a long answer into Telegram-sized messages, at line breaks when it can.
fn chunks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for line in text.split_inclusive('\n') {
        if current.chars().count() + line.chars().count() > MESSAGE_CHARS && !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
        if line.chars().count() > MESSAGE_CHARS {
            let chars: Vec<char> = line.chars().collect();
            for piece in chars.chunks(MESSAGE_CHARS) {
                out.push(piece.iter().collect());
            }
        } else {
            current.push_str(line);
        }
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out
}

struct Job {
    chat_id: i64,
    text: String,
    trust: ChannelTrust,
    name: String,
}

/// Keep one poller running for each bot with a Telegram token.
pub fn spawn_telegram(service: Service) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut running: HashMap<String, (String, JoinHandle<()>)> = HashMap::new();
        let mut tick = tokio::time::interval(RECONCILE);
        loop {
            tick.tick().await;
            reconcile(&service, &mut running);
        }
    })
}

fn reconcile(service: &Service, running: &mut HashMap<String, (String, JoinHandle<()>)>) {
    let mut wanted = HashMap::new();
    for bot in service.bots.list().unwrap_or_default() {
        if let Ok(Some(token)) = service.bots.telegram_token(&bot.handle) {
            wanted.insert(bot.handle, token);
        }
    }
    running.retain(|handle, (token, task)| {
        let keep = wanted.get(handle) == Some(token) && !task.is_finished();
        if !keep {
            task.abort();
        }
        keep
    });
    for (handle, token) in wanted {
        if running.contains_key(&handle) {
            continue;
        }
        let api: Arc<dyn TelegramApi> = Arc::new(HttpApi::new(&token));
        let task = tokio::spawn(run_channel(service.clone(), handle.clone(), api));
        running.insert(handle, (token, task));
    }
}

async fn run_channel(service: Service, handle: String, api: Arc<dyn TelegramApi>) {
    let store = Arc::clone(&service.bots);
    let username = match api.get_me().await {
        Ok(username) => username,
        Err(error) => {
            tracing::warn!(bot = handle, %error, "Telegram channel could not start");
            let _ = store.set_telegram_status(&handle, None, Some(error.to_string()));
            // A bad token waits for a new one; anything else is retried by
            // the next reconcile (this task ends, so it starts again).
            if matches!(error, ApiError::Unauthorized) {
                std::future::pending::<()>().await;
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
            return;
        }
    };
    let _ = store.set_telegram_status(&handle, Some(username), None);
    tracing::info!(bot = handle, "Telegram channel connected");

    let (jobs, queue) = mpsc::unbounded_channel();
    tokio::spawn(work(
        service.clone(),
        handle.clone(),
        Arc::clone(&api),
        queue,
    ));
    let mut backoff = Duration::from_secs(1);
    loop {
        let offset = store
            .telegram_state(&handle)
            .map(|state| state.offset)
            .unwrap_or(0);
        match api.get_updates(offset).await {
            Ok(updates) => {
                backoff = Duration::from_secs(1);
                for update in updates {
                    handle_update(&service, &handle, api.as_ref(), &jobs, &update).await;
                    let _ = store.set_telegram_offset(&handle, update.update_id + 1);
                }
            }
            Err(ApiError::Unauthorized) => {
                let _ = store.set_telegram_status(
                    &handle,
                    None,
                    Some(ApiError::Unauthorized.to_string()),
                );
                std::future::pending::<()>().await;
            }
            Err(error) => {
                tracing::debug!(bot = handle, %error, "Telegram poll failed");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(60));
            }
        }
    }
}

async fn handle_update(
    service: &Service,
    handle: &str,
    api: &dyn TelegramApi,
    jobs: &mpsc::UnboundedSender<Job>,
    update: &Update,
) {
    if let Some(callback) = &update.callback_query {
        answer_button(service, handle, api, callback).await;
        return;
    }
    let Some(message) = &update.message else {
        return;
    };
    match decide(&service.bots, handle, message) {
        Action::Ignore => {}
        Action::Reply(text) => {
            let _ = api.send(message.chat.id, &text, None).await;
        }
        Action::Run { text, trust, name } => {
            let _ = jobs.send(Job {
                chat_id: message.chat.id,
                text,
                trust,
                name,
            });
        }
    }
}

/// An approval button: only the owner's chats can approve.
async fn answer_button(
    service: &Service,
    handle: &str,
    api: &dyn TelegramApi,
    callback: &Callback,
) {
    let Some(message) = &callback.message else {
        return;
    };
    let chat_id = message.chat.id;
    let owner =
        service.bots.paired_trust(handle, chat_id).ok().flatten() == Some(ChannelTrust::Owner);
    let Some((request_id, decision)) = callback.data.as_deref().and_then(approval_from_button)
    else {
        api.answer_callback(&callback.id, "").await;
        return;
    };
    if !owner {
        api.answer_callback(&callback.id, "Only the owner can approve.")
            .await;
        return;
    }
    let handled = service.runtime.approve(ApprovalDecision {
        request_id,
        decision,
    });
    let label = match (handled, decision) {
        (false, _) => "This request already ended.",
        (true, ApprovalDecisionKind::ApproveOnce) => "Allowed once.",
        (true, ApprovalDecisionKind::ApproveAll) => "Allowed from now on.",
        (true, _) => "Denied.",
    };
    api.answer_callback(&callback.id, label).await;
    api.edit(chat_id, message.message_id, label).await;
}

/// Run queued messages one at a time, in order, in the bot's session.
async fn work(
    service: Service,
    handle: String,
    api: Arc<dyn TelegramApi>,
    mut queue: mpsc::UnboundedReceiver<Job>,
) {
    while let Some(job) = queue.recv().await {
        run_job(&service, &handle, api.as_ref(), job).await;
    }
}

async fn run_job(service: &Service, handle: &str, api: &dyn TelegramApi, job: Job) {
    let chat_id = job.chat_id;
    let trust = match job.trust {
        ChannelTrust::Owner => Trust::Owner,
        ChannelTrust::Trusted => Trust::Trusted,
    };
    let origin = Origin {
        channel: CHANNEL.into(),
        sender: Some(job.name),
        trust,
    };
    // The bot's own model when it has one (bot_turn), and its budget.
    let start = match bot_turn(
        &service.bots,
        handle,
        job.text,
        ClientModel::default(),
        Some(origin),
    ) {
        Ok(start) => start,
        Err(error) => {
            let _ = api.send(chat_id, &error.to_string(), None).await;
            return;
        }
    };
    let deadline = tokio::time::Instant::now() + BUSY_WAIT;
    let mut told_busy = false;
    let mut turn = loop {
        match service.runtime.start_turn(start.clone()) {
            Ok(turn) => break turn,
            Err(RuntimeError::SessionBusy(_)) if tokio::time::Instant::now() < deadline => {
                if !told_busy {
                    let _ = api
                        .send(
                            chat_id,
                            "I'm finishing something else; I'll answer right after.",
                            None,
                        )
                        .await;
                    told_busy = true;
                }
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            Err(error) => {
                let _ = api
                    .send(chat_id, &format!("I couldn't start on that: {error}"), None)
                    .await;
                return;
            }
        }
    };

    let mut finished_text = String::new();
    let mut streaming = String::new();
    let mut typing = tokio::time::interval(Duration::from_secs(4));
    loop {
        tokio::select! {
            _ = typing.tick() => api.typing(chat_id).await,
            envelope = turn.recv() => {
                let Some(envelope) = envelope else { break };
                match envelope.event {
                    RuntimeEvent::AssistantDelta { text } => streaming.push_str(&text),
                    RuntimeEvent::AssistantMessage { text } => {
                        finished_text = text;
                        streaming.clear();
                    }
                    RuntimeEvent::ApprovalRequested { request_id, tool_name, description, .. } => {
                        if trust == Trust::Owner {
                            let buttons = json!([[
                                { "text": "Allow once", "callback_data": format!("ap:{request_id}:o") },
                                { "text": "Always", "callback_data": format!("ap:{request_id}:a") },
                                { "text": "Deny", "callback_data": format!("ap:{request_id}:n") }
                            ]]);
                            let text = format!("Allow {tool_name}?\n{description}");
                            let _ = api.send(chat_id, &text, Some(buttons)).await;
                        } else {
                            service.runtime.approve(ApprovalDecision { request_id, decision: ApprovalDecisionKind::Deny });
                        }
                    }
                    RuntimeEvent::TurnFinished { .. } => break,
                    RuntimeEvent::TurnCancelled { .. } => {
                        let _ = api.send(chat_id, "Stopped.", None).await;
                        return;
                    }
                    RuntimeEvent::TurnFailed { message } => {
                        let _ = api.send(chat_id, &format!("Something went wrong: {message}"), None).await;
                        return;
                    }
                    _ => {}
                }
            }
        }
    }
    let answer = if streaming.trim().is_empty() {
        finished_text
    } else {
        streaming
    };
    for part in chunks(&answer) {
        if api.send(chat_id, &part, None).await.is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_bot::DEFAULT_BOT;

    fn message(chat_id: i64, kind: &str, text: &str) -> TgMessage {
        TgMessage {
            message_id: 1,
            chat: Chat {
                id: chat_id,
                kind: kind.into(),
            },
            from: Some(User {
                first_name: "Ana".into(),
                username: Some("ana".into()),
            }),
            text: Some(text.into()),
        }
    }

    #[test]
    fn strangers_are_asked_for_a_code_and_a_code_pairs_them() {
        let dir = std::env::temp_dir().join(format!("agente-tg-{}", std::process::id()));
        let store = BotStore::open(&dir).unwrap();
        assert_eq!(
            decide(&store, DEFAULT_BOT, &message(5, "private", "hello")),
            Action::Reply(ASK_FOR_A_CODE.into())
        );
        assert_eq!(
            decide(&store, DEFAULT_BOT, &message(5, "group", "hello")),
            Action::Ignore
        );

        let code = store
            .new_pairing_code(DEFAULT_BOT, ChannelTrust::Trusted, Utc::now())
            .unwrap();
        let paired = decide(
            &store,
            DEFAULT_BOT,
            &message(5, "private", &format!("/pair {}", code.code)),
        );
        assert!(matches!(paired, Action::Reply(text) if text.starts_with("Paired.")));
        assert_eq!(
            decide(&store, DEFAULT_BOT, &message(5, "private", "what's new?")),
            Action::Run {
                text: "what's new?".into(),
                trust: ChannelTrust::Trusted,
                name: "Ana (@ana)".into()
            }
        );
        // Another person still can't talk to it.
        assert_eq!(
            decide(&store, DEFAULT_BOT, &message(6, "private", "hi")),
            Action::Reply(ASK_FOR_A_CODE.into())
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Records what the channel sends.
    #[derive(Default)]
    struct FakeApi {
        sent: std::sync::Mutex<Vec<(i64, String)>>,
        answered: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait]
    impl TelegramApi for FakeApi {
        async fn get_me(&self) -> Result<String, ApiError> {
            Ok("colina_bot".into())
        }
        async fn get_updates(&self, _offset: i64) -> Result<Vec<Update>, ApiError> {
            Ok(Vec::new())
        }
        async fn send(
            &self,
            chat_id: i64,
            text: &str,
            _buttons: Option<Value>,
        ) -> Result<(), ApiError> {
            self.sent.lock().unwrap().push((chat_id, text.into()));
            Ok(())
        }
        async fn typing(&self, _chat_id: i64) {}
        async fn answer_callback(&self, _callback_id: &str, text: &str) {
            self.answered.lock().unwrap().push(text.into());
        }
        async fn edit(&self, _chat_id: i64, _message_id: i64, _text: &str) {}
    }

    #[tokio::test]
    async fn updates_reply_queue_turns_and_guard_approvals() {
        use agente_core::config::AppConfig;
        use agente_runtime::{RuntimeConfig, RuntimeSupervisor};

        let dir = std::env::temp_dir().join(format!("agente-tg-upd-{}", std::process::id()));
        let bots = Arc::new(BotStore::open(dir.join("bots")).unwrap());
        let runtime = RuntimeSupervisor::start(RuntimeConfig::from_app_config(
            &AppConfig::default(),
            dir.to_string_lossy(),
        ));
        let service = Service {
            runtime,
            bots: Arc::clone(&bots),
        };
        let api = FakeApi::default();
        let (jobs, mut queue) = mpsc::unbounded_channel();
        let update = |message: TgMessage| Update {
            update_id: 1,
            message: Some(message),
            callback_query: None,
        };

        handle_update(
            &service,
            DEFAULT_BOT,
            &api,
            &jobs,
            &update(message(8, "private", "hi")),
        )
        .await;
        assert_eq!(
            api.sent.lock().unwrap().last().unwrap(),
            &(8, ASK_FOR_A_CODE.to_string())
        );
        assert!(queue.try_recv().is_err());

        let code = bots
            .new_pairing_code(DEFAULT_BOT, ChannelTrust::Trusted, Utc::now())
            .unwrap();
        handle_update(
            &service,
            DEFAULT_BOT,
            &api,
            &jobs,
            &update(message(8, "private", &format!("/pair {}", code.code))),
        )
        .await;
        handle_update(
            &service,
            DEFAULT_BOT,
            &api,
            &jobs,
            &update(message(8, "private", "summarize my day")),
        )
        .await;
        let job = queue.try_recv().unwrap();
        assert_eq!(
            (job.chat_id, job.text.as_str(), job.trust),
            (8, "summarize my day", ChannelTrust::Trusted)
        );

        // A trusted (not owner) chat can't press approval buttons.
        let press = Update {
            update_id: 2,
            message: None,
            callback_query: Some(Callback {
                id: "cb".into(),
                data: Some("ap:req:o".into()),
                message: Some(message(8, "private", "Allow shell?")),
            }),
        };
        handle_update(&service, DEFAULT_BOT, &api, &jobs, &press).await;
        assert_eq!(
            api.answered.lock().unwrap().last().unwrap(),
            "Only the owner can approve."
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn buttons_carry_the_decision() {
        assert_eq!(
            approval_from_button("ap:req-1:o"),
            Some(("req-1".into(), ApprovalDecisionKind::ApproveOnce))
        );
        assert_eq!(
            approval_from_button("ap:a:b:n"),
            Some(("a:b".into(), ApprovalDecisionKind::Deny))
        );
        assert_eq!(approval_from_button("ap:req-1:x"), None);
        assert_eq!(approval_from_button("other"), None);
    }

    #[test]
    fn long_answers_split_under_the_limit() {
        let long = format!("{}\n{}", "a".repeat(3000), "b".repeat(3000));
        let parts = chunks(&long);
        assert_eq!(parts.len(), 2);
        assert!(parts
            .iter()
            .all(|part| part.chars().count() <= MESSAGE_CHARS));
        assert_eq!(chunks(&"x".repeat(9000)).len(), 3);
        assert!(chunks("   ").is_empty());
    }
}
