//! The persona part of a bot's system prompt: who it is, what it knows about
//! the person it works for, what it remembers, and who its teammates are.
//! The runtime puts the usual working rules and tool list after it.

use crate::{Bot, DOC_CAP_CHARS};

pub fn persona_prompt(
    bot: &Bot,
    soul: &str,
    user: &str,
    memory: &str,
    teammates: &[Bot],
) -> String {
    let config = &bot.config;
    let mut out = format!("You are {} (@{})", config.title, bot.handle);
    if !config.role.trim().is_empty() {
        out.push_str(&format!(", {}", config.role.trim()));
    }
    out.push_str(".\n");
    if !soul.trim().is_empty() {
        out.push('\n');
        out.push_str(capped(soul).trim_end());
        out.push('\n');
    }
    section(
        &mut out,
        "ABOUT THE PERSON YOU WORK FOR",
        user,
        "Nothing yet.",
    );
    section(
        &mut out,
        "YOUR MEMORY (one note per line)",
        memory,
        "Empty.",
    );
    if !teammates.is_empty() {
        out.push_str("\nYOUR TEAMMATES:\n");
        for teammate in teammates {
            out.push_str(&format!(
                "- @{} — {}",
                teammate.handle, teammate.config.title
            ));
            if !teammate.config.role.trim().is_empty() {
                out.push_str(&format!(": {}", teammate.config.role.trim()));
            }
            out.push('\n');
        }
    }
    out
}

fn section(out: &mut String, title: &str, text: &str, empty: &str) {
    out.push_str(&format!("\n{title}:\n"));
    if text.trim().is_empty() {
        out.push_str(empty);
    } else {
        out.push_str(capped(text).trim_end());
    }
    out.push('\n');
}

/// Files are capped on write; this guards against edits made by hand.
fn capped(text: &str) -> String {
    if text.chars().count() <= DOC_CAP_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(DOC_CAP_CHARS).collect();
    out.push_str("\n…(cut: over the length limit)");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BotConfig;

    fn bot(handle: &str, title: &str, role: &str) -> Bot {
        Bot {
            handle: handle.into(),
            config: BotConfig {
                title: title.into(),
                role: role.into(),
                ..BotConfig::default()
            },
            builtin: false,
        }
    }

    #[test]
    fn empty_sections_say_so() {
        let prompt = persona_prompt(&bot("ada", "Ada", ""), "", "", "", &[]);
        assert!(prompt.starts_with("You are Ada (@ada).\n"));
        assert!(prompt.contains("ABOUT THE PERSON YOU WORK FOR:\nNothing yet."));
        assert!(prompt.contains("YOUR MEMORY (one note per line):\nEmpty."));
        assert!(!prompt.contains("TEAMMATES"));
    }

    #[test]
    fn hand_edited_files_are_cut_to_the_limit() {
        let huge = "y".repeat(DOC_CAP_CHARS * 2);
        let prompt = persona_prompt(&bot("ada", "Ada", ""), &huge, "", "", &[]);
        assert!(prompt.contains("…(cut: over the length limit)"));
        assert!(prompt.len() < DOC_CAP_CHARS * 2);
    }
}
