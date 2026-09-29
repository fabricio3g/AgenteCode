//! A bot's Telegram channel: its Telegram bot token (in a file only this user
//! can read, never in bot.toml), the chats paired with it, and the one-time
//! code that pairs a new chat.
//!
//! Nobody can talk to a bot on Telegram until its owner pairs them: the owner
//! makes a code (in Desktop or over the socket), the person sends
//! `/pair <code>` to the bot, and their chat is remembered with the trust the
//! code gave (owner, or trusted: read-only).

use std::path::PathBuf;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::{BotError, BotStore};

const TOKEN_FILE: &str = "telegram.token";
/// How long a pairing code works.
const CODE_LIFETIME_MINUTES: i64 = 10;
/// Wrong codes (from anyone) before the current code stops working, so it
/// can't be guessed by trying many.
const MAX_WRONG_CODES: u32 = 5;

/// What a paired person may do. Owner chats can run tools (approving them
/// with buttons); trusted chats are read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelTrust {
    Owner,
    Trusted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PairedChat {
    pub chat_id: i64,
    /// Their Telegram name, for the owner's list.
    pub name: String,
    pub trust: ChannelTrust,
    pub paired_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PairingCode {
    pub code: String,
    pub trust: ChannelTrust,
    pub expires_at: DateTime<Utc>,
    #[serde(default)]
    pub wrong_tries: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TelegramState {
    /// Next update to ask Telegram for (so none is handled twice).
    #[serde(default)]
    pub offset: i64,
    #[serde(default)]
    pub paired: Vec<PairedChat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pairing: Option<PairingCode>,
    /// The Telegram bot's @username once the token works.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// Why the channel isn't working, when it isn't.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BotStore {
    fn telegram_token_path(&self, handle: &str) -> Result<PathBuf, BotError> {
        self.get(handle)?;
        Ok(self.dir(handle).join(TOKEN_FILE))
    }

    /// The bot's Telegram token, if it has one.
    pub fn telegram_token(&self, handle: &str) -> Result<Option<String>, BotError> {
        match std::fs::read_to_string(self.telegram_token_path(handle)?) {
            Ok(token) => Ok(Some(token.trim().to_string()).filter(|token| !token.is_empty())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Set (or, with `None`, remove) the Telegram token. A new token starts
    /// a new Telegram bot: pairings and the update offset are forgotten.
    pub fn set_telegram_token(&self, handle: &str, token: Option<&str>) -> Result<(), BotError> {
        let path = self.telegram_token_path(handle)?;
        match token.map(str::trim).filter(|token| !token.is_empty()) {
            Some(token) => write_private(&path, token)?,
            None => match std::fs::remove_file(&path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.into())
                }
                _ => {}
            },
        }
        self.edit_state(handle, |state| state.telegram = None)
    }

    pub fn telegram_state(&self, handle: &str) -> Result<TelegramState, BotError> {
        Ok(self.read_state(handle)?.telegram.unwrap_or_default())
    }

    /// Remember that updates before `offset` are handled.
    pub fn set_telegram_offset(&self, handle: &str, offset: i64) -> Result<(), BotError> {
        self.edit_state(handle, |state| {
            state.telegram.get_or_insert_with(Default::default).offset = offset;
        })
    }

    /// Record whether the channel works: the bot's @username, or the error.
    pub fn set_telegram_status(
        &self,
        handle: &str,
        username: Option<String>,
        error: Option<String>,
    ) -> Result<(), BotError> {
        self.edit_state(handle, |state| {
            let telegram = state.telegram.get_or_insert_with(Default::default);
            if username.is_some() {
                telegram.username = username;
            }
            telegram.error = error;
        })
    }

    /// A fresh six-digit code that pairs one chat with `trust`, replacing any
    /// earlier code.
    pub fn new_pairing_code(
        &self,
        handle: &str,
        trust: ChannelTrust,
        now: DateTime<Utc>,
    ) -> Result<PairingCode, BotError> {
        let code = PairingCode {
            code: six_digits(),
            trust,
            expires_at: now + Duration::minutes(CODE_LIFETIME_MINUTES),
            wrong_tries: 0,
        };
        let saved = code.clone();
        self.edit_state(handle, |state| {
            state.telegram.get_or_insert_with(Default::default).pairing = Some(saved);
        })?;
        Ok(code)
    }

    /// Pair `chat_id` if `code` is the bot's current, unexpired code (it
    /// works once). Returns the trust it was paired with.
    pub fn redeem_pairing_code(
        &self,
        handle: &str,
        code: &str,
        chat_id: i64,
        name: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<ChannelTrust>, BotError> {
        let mut granted = None;
        self.edit_state(handle, |state| {
            let telegram = state.telegram.get_or_insert_with(Default::default);
            let Some(pairing) = telegram.pairing.as_mut() else {
                return;
            };
            if pairing.expires_at < now {
                telegram.pairing = None;
                return;
            }
            if pairing.code != code.trim() {
                pairing.wrong_tries += 1;
                if pairing.wrong_tries >= MAX_WRONG_CODES {
                    telegram.pairing = None;
                }
                return;
            }
            let trust = pairing.trust;
            telegram.pairing = None;
            telegram.paired.retain(|chat| chat.chat_id != chat_id);
            telegram.paired.push(PairedChat {
                chat_id,
                name: name.to_string(),
                trust,
                paired_at: now,
            });
            granted = Some(trust);
        })?;
        Ok(granted)
    }

    pub fn unpair_chat(&self, handle: &str, chat_id: i64) -> Result<(), BotError> {
        self.edit_state(handle, |state| {
            if let Some(telegram) = state.telegram.as_mut() {
                telegram.paired.retain(|chat| chat.chat_id != chat_id);
            }
        })
    }

    /// The trust a chat was paired with, if it is paired.
    pub fn paired_trust(
        &self,
        handle: &str,
        chat_id: i64,
    ) -> Result<Option<ChannelTrust>, BotError> {
        Ok(self
            .telegram_state(handle)?
            .paired
            .iter()
            .find(|chat| chat.chat_id == chat_id)
            .map(|chat| chat.trust))
    }
}

/// Six random digits (from a v4 UUID's random bits).
fn six_digits() -> String {
    let random = uuid::Uuid::new_v4().as_u128();
    format!("{:06}", random % 1_000_000)
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(text.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    std::fs::write(path, text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DEFAULT_BOT;

    #[test]
    fn a_code_pairs_one_chat_once_and_expires() {
        let dir = tempfile::tempdir().unwrap();
        let store = BotStore::open(dir.path()).unwrap();
        let now = Utc::now();
        let code = store
            .new_pairing_code(DEFAULT_BOT, ChannelTrust::Trusted, now)
            .unwrap();
        assert_eq!(code.code.len(), 6);
        assert_eq!(
            store
                .redeem_pairing_code(DEFAULT_BOT, "000000x", 1, "Ana", now)
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .redeem_pairing_code(DEFAULT_BOT, &code.code, 1, "Ana", now)
                .unwrap(),
            Some(ChannelTrust::Trusted)
        );
        // Used up.
        assert_eq!(
            store
                .redeem_pairing_code(DEFAULT_BOT, &code.code, 2, "Bo", now)
                .unwrap(),
            None
        );
        assert_eq!(
            store.paired_trust(DEFAULT_BOT, 1).unwrap(),
            Some(ChannelTrust::Trusted)
        );

        let late = store
            .new_pairing_code(DEFAULT_BOT, ChannelTrust::Owner, now)
            .unwrap();
        let after = now + Duration::minutes(CODE_LIFETIME_MINUTES + 1);
        assert_eq!(
            store
                .redeem_pairing_code(DEFAULT_BOT, &late.code, 3, "Cy", after)
                .unwrap(),
            None
        );

        store.unpair_chat(DEFAULT_BOT, 1).unwrap();
        assert_eq!(store.paired_trust(DEFAULT_BOT, 1).unwrap(), None);
    }

    #[test]
    fn too_many_wrong_codes_burn_the_code() {
        let dir = tempfile::tempdir().unwrap();
        let store = BotStore::open(dir.path()).unwrap();
        let now = Utc::now();
        let code = store
            .new_pairing_code(DEFAULT_BOT, ChannelTrust::Owner, now)
            .unwrap();
        for _ in 0..MAX_WRONG_CODES {
            store
                .redeem_pairing_code(DEFAULT_BOT, "nope", 9, "Eve", now)
                .unwrap();
        }
        assert_eq!(
            store
                .redeem_pairing_code(DEFAULT_BOT, &code.code, 1, "Me", now)
                .unwrap(),
            None
        );
    }

    #[test]
    fn the_token_is_private_and_a_new_one_forgets_pairings() {
        let dir = tempfile::tempdir().unwrap();
        let store = BotStore::open(dir.path()).unwrap();
        assert_eq!(store.telegram_token(DEFAULT_BOT).unwrap(), None);
        store
            .set_telegram_token(DEFAULT_BOT, Some(" 123:abc "))
            .unwrap();
        assert_eq!(
            store.telegram_token(DEFAULT_BOT).unwrap().as_deref(),
            Some("123:abc")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.path().join(DEFAULT_BOT).join(TOKEN_FILE);
            let mode = std::fs::metadata(path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let now = Utc::now();
        let code = store
            .new_pairing_code(DEFAULT_BOT, ChannelTrust::Owner, now)
            .unwrap();
        store
            .redeem_pairing_code(DEFAULT_BOT, &code.code, 7, "Me", now)
            .unwrap();
        store.set_telegram_offset(DEFAULT_BOT, 42).unwrap();
        store.set_telegram_token(DEFAULT_BOT, None).unwrap();
        assert_eq!(store.telegram_token(DEFAULT_BOT).unwrap(), None);
        assert_eq!(
            store.telegram_state(DEFAULT_BOT).unwrap(),
            TelegramState::default()
        );
    }
}
