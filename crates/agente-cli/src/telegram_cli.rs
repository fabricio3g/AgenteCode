//! `agente telegram …`: the Telegram channel of a bot on a running
//! `agente serve`, for servers without Desktop.

use anyhow::bail;
use clap::Subcommand;
use serde_json::{json, Value};

use crate::attach::{open, ServerOptions};

#[derive(Subcommand)]
pub enum TelegramAction {
    /// Who can message the bot, and whether Telegram is connected.
    Status {
        /// The bot, as @handle.
        bot: String,
    },
    /// Connect the bot to a Telegram bot token from @BotFather.
    Connect {
        bot: String,
        /// The token (or set TELEGRAM_BOT_TOKEN, which keeps it out of your
        /// shell history).
        #[arg(env = "TELEGRAM_BOT_TOKEN", hide_env_values = true)]
        telegram_token: String,
    },
    /// Stop answering on Telegram and forget who was paired.
    Disconnect { bot: String },
    /// Make a one-time code that pairs one person (read-only by default).
    Pair {
        bot: String,
        /// Full access: tools can run, approved with buttons in Telegram.
        #[arg(long)]
        full: bool,
    },
    /// Remove a paired person by their chat id (see `status`).
    Unpair { bot: String, chat_id: i64 },
}

fn handle(bot: &str) -> anyhow::Result<String> {
    let handle = bot.trim_start_matches('@');
    if handle.is_empty() {
        bail!("name the bot as @handle");
    }
    Ok(handle.to_string())
}

pub fn run(action: TelegramAction, server: ServerOptions) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async move {
        let (client, _events) = open(&server).await?;
        match action {
            TelegramAction::Status { bot } => {
                let status = client
                    .call("bots.telegram", json!({ "handle": handle(&bot)? }))
                    .await?;
                print!("{}", describe(&status));
            }
            TelegramAction::Connect {
                bot,
                telegram_token,
            } => {
                client
                    .call(
                        "bots.telegram_connect",
                        json!({ "handle": handle(&bot)?, "token": telegram_token }),
                    )
                    .await?;
                println!("Connecting… run `agente telegram status {bot}` in a few seconds.");
            }
            TelegramAction::Disconnect { bot } => {
                client
                    .call(
                        "bots.telegram_disconnect",
                        json!({ "handle": handle(&bot)? }),
                    )
                    .await?;
                println!("Disconnected.");
            }
            TelegramAction::Pair { bot, full } => {
                let trust = if full { "owner" } else { "trusted" };
                let code = client
                    .call(
                        "bots.telegram_pair",
                        json!({ "handle": handle(&bot)?, "trust": trust }),
                    )
                    .await?;
                println!(
                    "Send this to the bot on Telegram within 10 minutes:\n\n  /pair {}\n",
                    code["code"].as_str().unwrap_or_default()
                );
            }
            TelegramAction::Unpair { bot, chat_id } => {
                client
                    .call(
                        "bots.telegram_unpair",
                        json!({ "handle": handle(&bot)?, "chat_id": chat_id }),
                    )
                    .await?;
                println!("Removed.");
            }
        }
        Ok(())
    })
}

/// The status as a few lines of text.
fn describe(status: &Value) -> String {
    let mut out = String::new();
    if status["connected"] != true {
        out.push_str("Not connected. Get a token from @BotFather, then: agente telegram connect @bot <token>\n");
        return out;
    }
    match (status["username"].as_str(), status["error"].as_str()) {
        (_, Some(error)) => out.push_str(&format!("Not working: {error}\n")),
        (Some(username), None) => out.push_str(&format!("Connected as @{username}\n")),
        (None, None) => out.push_str("Connecting…\n"),
    }
    let paired = status["paired"].as_array().cloned().unwrap_or_default();
    if paired.is_empty() {
        out.push_str("Nobody is paired yet: agente telegram pair @bot\n");
    }
    for chat in paired {
        let access = if chat["trust"] == "owner" {
            "full access"
        } else {
            "read-only"
        };
        out.push_str(&format!(
            "  {}  {}  ({access})\n",
            chat["chat_id"],
            chat["name"].as_str().unwrap_or_default()
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reads_as_text() {
        assert!(describe(&json!({ "connected": false })).starts_with("Not connected"));
        let text = describe(&json!({
            "connected": true,
            "username": "colina_bot",
            "error": null,
            "paired": [{ "chat_id": 42, "name": "Ana", "trust": "trusted" }]
        }));
        assert!(text.contains("Connected as @colina_bot"));
        assert!(text.contains("42  Ana  (read-only)"));
        assert_eq!(handle("@colina").unwrap(), "colina");
        assert!(handle("@").is_err());
    }
}
