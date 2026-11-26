//! Swarm mode: a board of cards the main model plans and subagents work.
//!
//! When swarm mode is on for a session, the main model gets the `board`
//! tool. It writes cards — a title, the role of the subagent it creates for
//! the card, a model from the user's list, the card's prompt, cards it waits
//! for, and the files it owns — and the host starts every card whose
//! dependencies are done, each as a created subagent (`subagent::host`). A
//! card moves Backlog → Working → Review (writers) or Done (readers); the
//! main model accepts a review, or sends a card back with feedback. One
//! writer per file: a writer's `owns` may not overlap another open writer's.
//!
//! Members talk through the board's findings log: each card's subagent gets
//! the `swarm` tool to post a finding (a fact, a decision, a changed
//! signature) and to read what the others posted. A post reaches the members
//! still working at their next step and every card that starts later; the
//! main model sees the log in each board result and may post to it too.
//!
//! The board is session state, not transcript: one file per session beside
//! the session goals, written atomically, so a restart keeps it.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::subagent::types::SubagentCapabilityMode;

/// Where a card is on the board.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardStatus {
    /// Waiting to start (its dependencies are not done yet, or no run yet).
    Backlog,
    /// A subagent is on it.
    Working,
    /// A writer finished; the main model checks the work.
    Review,
    Done,
    /// The subagent failed or was stopped.
    Failed,
}

impl CardStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::Working => "working",
            Self::Review => "review",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }

    fn is_open(self) -> bool {
        !matches!(self, Self::Done | Self::Failed)
    }
}

/// One card: a piece of work and the subagent created for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Card {
    /// `c1`, `c2`, … in the order cards were added.
    pub id: String,
    pub title: String,
    /// Who the subagent created for this card is.
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    pub capability: SubagentCapabilityMode,
    /// A name from the user's subagent model list, or `main`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Driver instance id targeting a specific CLI backend (e.g. `"claude"`, `"codex"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    pub prompt: String,
    /// Card ids this card waits for.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    /// Paths (or `dir/**`) only this card's subagent may change.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub owns: Vec<String>,
    pub status: CardStatus,
    /// The subagent working (or that worked) this card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_id: Option<String>,
    /// What its last subagent reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// Feedback from the main model when it sent the card back.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl Card {
    fn is_writer(&self) -> bool {
        self.capability != SubagentCapabilityMode::ReadOnly
    }
}

/// A session's board. `enabled` is the swarm switch; cards stay when it is
/// turned off, so turning it back on resumes the same board.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Board {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub cards: Vec<Card>,
    /// What members (and the lead) told each other, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub findings: Vec<Finding>,
    #[serde(default)]
    next_id: u32,
}

/// Who posted a finding when no card did: the main model.
pub const LEAD: &str = "lead";

/// The log keeps the newest findings; older ones fall off.
const MAX_FINDINGS: usize = 200;
/// Findings a starting member's prompt carries.
const PROMPT_FINDINGS: usize = 20;
/// Findings the main model's board result carries.
const SUMMARY_FINDINGS: usize = 10;

impl Finding {
    /// Who it came from and went to: `c1 → c2, c3`, `lead`, `c4`.
    pub fn route(&self) -> String {
        if self.to.is_empty() {
            self.from.clone()
        } else {
            format!("{} \u{2192} {}", self.from, self.to.join(", "))
        }
    }

    /// True when `card` wrote it or it was addressed to `card`.
    pub fn touches(&self, card: &str) -> bool {
        self.from == card || self.to.iter().any(|to| to == card)
    }
}

/// One entry in the swarm's findings log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    /// 1, 2, … in the order posted.
    pub id: u32,
    /// The card whose subagent posted it, or [`LEAD`].
    pub from: String,
    pub text: String,
    /// Cards it is addressed to; empty means everyone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub to: Vec<String>,
    /// Unix milliseconds.
    #[serde(default)]
    pub at: i64,
}

/// A card as the main model writes it (`board` `add`).
#[derive(Debug, Clone, Deserialize)]
pub struct CardSpec {
    pub title: String,
    pub role: String,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default, alias = "capability")]
    pub capability_mode: Option<SubagentCapabilityMode>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub instance_id: Option<String>,
    pub prompt: String,
    /// Ids (`c1`) or titles of cards this one waits for — earlier cards in
    /// the same call included.
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub owns: Vec<String>,
}

/// Where `board` `move` may send a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MoveTo {
    /// Accept the work.
    Done,
    /// Send it back: a new subagent starts over, with the feedback.
    Backlog,
    /// Give up on it.
    Failed,
}

fn trim_limit(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push('…');
    out
}

/// `src/parser/**` and `src/parser/` own the directory; anything else is a
/// file. Two claims overlap when one contains the other.
pub(crate) fn claim(path: &str) -> String {
    let raw = path.trim().replace('\\', "/");
    if raw.is_empty() {
        return String::new();
    }
    #[cfg(windows)]
    let raw = raw.to_lowercase();
    let mut is_dir = raw.ends_with('/') || raw.ends_with("/.") || raw.ends_with("/..");
    let mut segments: Vec<&str> = Vec::new();
    for seg in raw.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if segments.last().is_some_and(|last| *last != "..") {
                segments.pop();
            } else {
                segments.push("..");
            }
            continue;
        }
        if seg.contains(['*', '?', '[']) {
            is_dir = true;
            break;
        }
        segments.push(seg);
    }
    if segments.is_empty() {
        return "/".to_string();
    }
    let joined = segments.join("/");
    if is_dir {
        format!("{joined}/")
    } else {
        joined
    }
}

pub(crate) fn overlaps(a: &str, b: &str) -> bool {
    let (a, b) = (claim(a), claim(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == "/" || b == "/" {
        return true;
    }
    a.trim_end_matches('/') == b.trim_end_matches('/')
        || (a.ends_with('/') && b.starts_with(&a))
        || (b.ends_with('/') && a.starts_with(&b))
}

/// True when `owned` (a card's `owns` entry) covers the project-relative file
/// `target`. Unlike [`overlaps`], this is directional: a file claim does not
/// cover a parent directory, and parent-traversal paths (`..`) never match.
pub(crate) fn path_is_owned(owned: &str, target: &str) -> bool {
    let (owned, target) = (claim(owned), claim(target));
    if owned.is_empty()
        || target.is_empty()
        || target == "/"
        || target == ".."
        || target.starts_with("../")
    {
        return false;
    }
    if owned == "/" {
        return true;
    }
    if owned.ends_with('/') {
        target.starts_with(&owned)
    } else {
        !target.ends_with('/') && owned == target
    }
}

/// True when a card with `from_deps` transitively waits for `target_id` through
/// open cards (`Backlog`/`Working`/`Review`).
fn waits_for_open(cards: &[Card], staged: &[Card], from_deps: &[String], target_id: &str) -> bool {
    let mut stack: Vec<&str> = from_deps.iter().map(String::as_str).collect();
    let mut visited: Vec<&str> = Vec::new();
    while let Some(dep_id) = stack.pop() {
        if dep_id == target_id {
            return true;
        }
        if visited.contains(&dep_id) {
            continue;
        }
        visited.push(dep_id);
        if let Some(dep_card) = cards
            .iter()
            .chain(staged.iter())
            .find(|card| card.id == dep_id && card.status.is_open())
        {
            for next in &dep_card.depends_on {
                stack.push(next.as_str());
            }
        }
    }
    false
}

impl Board {
    pub fn card(&self, id: &str) -> Option<&Card> {
        self.cards.iter().find(|card| card.id == id)
    }

    fn card_mut(&mut self, id: &str) -> Option<&mut Card> {
        self.cards.iter_mut().find(|card| card.id == id)
    }

    /// Add cards. Every card is checked before any is added: dependencies
    /// must name a card (by id or title), and a writer's files must not
    /// overlap another open writer's (unless one waits for the other).
    /// Returns the new ids.
    pub fn add(&mut self, specs: Vec<CardSpec>) -> Result<Vec<String>, String> {
        if specs.is_empty() {
            return Err("add needs at least one card".into());
        }
        let mut next = self.next_id;
        let mut staged: Vec<Card> = Vec::new();
        for spec in specs {
            let title = spec.title.trim().to_string();
            let prompt = spec.prompt.trim().to_string();
            if title.is_empty() || prompt.is_empty() {
                return Err("every card needs a title and a prompt".into());
            }
            let role = Some(spec.role.trim())
                .filter(|role| !role.is_empty())
                .unwrap_or(&title)
                .to_string();
            let capability = spec
                .capability_mode
                .unwrap_or(SubagentCapabilityMode::ReadOnly);
            let mut depends_on = Vec::new();
            for dep in &spec.depends_on {
                let dep = dep.trim();
                let found = self
                    .cards
                    .iter()
                    .chain(staged.iter())
                    .find(|card| card.id == dep || card.title.eq_ignore_ascii_case(dep));
                match found {
                    Some(card) => depends_on.push(card.id.clone()),
                    None => {
                        return Err(format!(
                            "card \"{title}\" waits for \"{dep}\", which is not on the board"
                        ))
                    }
                }
            }
            let owns: Vec<String> = if capability == SubagentCapabilityMode::ReadOnly {
                Vec::new()
            } else {
                spec.owns
                    .iter()
                    .map(|path| path.trim().to_string())
                    .filter(|path| !path.is_empty())
                    .collect()
            };
            for other in self
                .cards
                .iter()
                .chain(staged.iter())
                .filter(|card| card.is_writer() && card.status.is_open())
            {
                if waits_for_open(&self.cards, &staged, &depends_on, &other.id) {
                    continue;
                }
                if let Some((mine, theirs)) = owns.iter().find_map(|mine| {
                    other
                        .owns
                        .iter()
                        .find(|theirs| overlaps(mine, theirs))
                        .map(|theirs| (mine, theirs))
                }) {
                    return Err(format!(
                        "card \"{title}\" owns {mine}, but {} \"{}\" already owns {theirs}: one writer per file — split the files or make one card wait for the other",
                        other.id, other.title
                    ));
                }
            }
            next += 1;
            staged.push(Card {
                id: format!("c{next}"),
                title,
                role,
                instructions: spec
                    .instructions
                    .map(|text| text.trim().to_string())
                    .filter(|text| !text.is_empty()),
                capability,
                model: spec
                    .model
                    .map(|text| text.trim().to_string())
                    .filter(|text| !text.is_empty()),
                instance_id: spec
                    .instance_id
                    .map(|text| text.trim().to_string())
                    .filter(|text| !text.is_empty()),
                prompt,
                depends_on,
                owns,
                status: CardStatus::Backlog,
                child_id: None,
                result: None,
                notes: Vec::new(),
            });
        }
        self.next_id = next;
        let ids = staged.iter().map(|card| card.id.clone()).collect();
        self.cards.extend(staged);
        Ok(ids)
    }

    /// Backlog cards whose dependencies are all done, in board order.
    pub fn ready(&self) -> Vec<String> {
        self.cards
            .iter()
            .filter(|card| card.status == CardStatus::Backlog)
            .filter(|card| {
                card.depends_on.iter().all(|dep| {
                    self.card(dep)
                        .is_some_and(|dep| dep.status == CardStatus::Done)
                })
            })
            .map(|card| card.id.clone())
            .collect()
    }

    /// A card's subagent started.
    pub fn start(&mut self, id: &str, child_id: &str) {
        if let Some(card) = self.card_mut(id) {
            card.status = CardStatus::Working;
            card.child_id = Some(child_id.to_string());
        }
    }

    /// Record the effective capability a card's subagent actually launched with
    /// (e.g. after Plan-mode coercion to `ReadOnly`).
    pub fn set_capability(&mut self, id: &str, capability: SubagentCapabilityMode) {
        if let Some(card) = self.card_mut(id) {
            card.capability = capability;
        }
    }

    /// Clear a dangling `child_id` when a spawn fails before admission.
    pub fn clear_child_id(&mut self, id: &str) {
        if let Some(card) = self.card_mut(id) {
            card.child_id = None;
        }
    }

    /// A subagent finished: its card goes to review (a writer) or done (a
    /// reader), or failed. Returns the card id when the child was a card's.
    pub fn child_finished(&mut self, child_id: &str, ok: bool, summary: &str) -> Option<String> {
        let card = self
            .cards
            .iter_mut()
            .find(|card| card.child_id.as_deref() == Some(child_id))?;
        if card.status != CardStatus::Working {
            return None;
        }
        card.result = Some(trim_limit(summary, 4_000));
        card.status = match (ok, card.is_writer()) {
            (false, _) => CardStatus::Failed,
            (true, true) => CardStatus::Review,
            (true, false) => CardStatus::Done,
        };
        Some(card.id.clone())
    }

    /// The main model moves a card: accept it, send it back with feedback,
    /// or give up on it. A working card cannot move; stop its subagent first.
    pub fn move_card(&mut self, id: &str, to: MoveTo, note: Option<&str>) -> Result<(), String> {
        let target = self
            .card(id)
            .ok_or_else(|| format!("no card {id} on the board"))?;
        if target.status == CardStatus::Working {
            return Err(format!(
                "{id} is still working; wait for it or stop its subagent with kill_task first"
            ));
        }
        if to == MoveTo::Backlog && target.is_writer() {
            for other in self
                .cards
                .iter()
                .filter(|card| card.id != id && card.is_writer() && card.status.is_open())
            {
                let card_waits = waits_for_open(&self.cards, &[], &target.depends_on, &other.id);
                let other_waits = other.status == CardStatus::Backlog
                    && waits_for_open(&self.cards, &[], &other.depends_on, id);
                if card_waits || other_waits {
                    continue;
                }
                if let Some((mine, theirs)) = target.owns.iter().find_map(|mine| {
                    other
                        .owns
                        .iter()
                        .find(|theirs| overlaps(mine, theirs))
                        .map(|theirs| (mine, theirs))
                }) {
                    return Err(format!(
                        "card \"{}\" owns {mine}, but {} \"{}\" already owns {theirs}: one writer per file — split the files or make one card wait for the other",
                        target.title, other.id, other.title
                    ));
                }
            }
        }
        let card = self
            .card_mut(id)
            .ok_or_else(|| format!("no card {id} on the board"))?;
        if let Some(note) = note.map(str::trim).filter(|note| !note.is_empty()) {
            card.notes.push(note.to_string());
        }
        card.status = match to {
            MoveTo::Done => CardStatus::Done,
            MoveTo::Failed => CardStatus::Failed,
            MoveTo::Backlog => {
                card.child_id = None;
                CardStatus::Backlog
            }
        };
        Ok(())
    }

    /// Post a finding. `from` is a card id or [`LEAD`]; `to` names cards by
    /// id or title (empty = everyone). Returns the finding.
    pub fn post(&mut self, from: &str, text: &str, to: &[String]) -> Result<Finding, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("a finding needs text".into());
        }
        if from != LEAD && self.card(from).is_none() {
            return Err(format!("no card {from}"));
        }
        let mut targets: Vec<String> = Vec::new();
        for name in to {
            let name = name.trim();
            let Some(card) = self
                .cards
                .iter()
                .find(|card| card.id == name || card.title.eq_ignore_ascii_case(name))
            else {
                return Err(format!("no card {name}"));
            };
            if !targets.contains(&card.id) {
                targets.push(card.id.clone());
            }
        }
        let finding = Finding {
            id: self.findings.last().map_or(1, |last| last.id + 1),
            from: from.to_string(),
            text: trim_limit(text, 1_200),
            to: targets,
            at: chrono::Utc::now().timestamp_millis(),
        };
        self.findings.push(finding.clone());
        if self.findings.len() > MAX_FINDINGS {
            let excess = self.findings.len() - MAX_FINDINGS;
            self.findings.drain(..excess);
        }
        Ok(finding)
    }

    /// The subagents a finding goes to now: every working card's but the
    /// author's, narrowed to the addressees when it names any.
    pub fn recipients(&self, finding: &Finding) -> Vec<String> {
        self.cards
            .iter()
            .filter(|card| card.status == CardStatus::Working && card.id != finding.from)
            .filter(|card| finding.to.is_empty() || finding.to.contains(&card.id))
            .filter_map(|card| card.child_id.clone())
            .collect()
    }

    /// How a finding reads to a member or the lead:
    /// `#3 c1 "Parse" (Parser refactorer) → c2: text`.
    pub fn finding_line(&self, finding: &Finding) -> String {
        let author = match self.card(&finding.from) {
            Some(card) => format!("{} \"{}\" ({})", card.id, card.title, card.role),
            None => "the lead".to_string(),
        };
        let to = if finding.to.is_empty() {
            String::new()
        } else {
            format!(" \u{2192} {}", finding.to.join(", "))
        };
        format!("#{} {author}{to}: {}", finding.id, finding.text)
    }

    /// The findings a card may read — everyone's, its own and those
    /// addressed to it; every finding for the lead (`None`) — newest `limit`.
    fn findings_for(&self, card: Option<&str>, limit: usize) -> Vec<&Finding> {
        let visible: Vec<&Finding> = self
            .findings
            .iter()
            .filter(|finding| match card {
                None => true,
                Some(id) => {
                    finding.to.is_empty()
                        || finding.from == id
                        || finding.to.iter().any(|to| to == id)
                }
            })
            .collect();
        let skip = visible.len().saturating_sub(limit);
        visible.into_iter().skip(skip).collect()
    }

    /// What `swarm` `read` returns to a member: every card's state, then the
    /// findings it may read.
    pub fn member_view(&self, card_id: &str) -> String {
        let mut out = String::from("Cards:\n");
        for card in &self.cards {
            let me = if card.id == card_id { " (you)" } else { "" };
            out.push_str(&format!(
                "- {} {} [{} · {}]{me}",
                card.id,
                card.title,
                card.role,
                card.status.as_str()
            ));
            if !card.owns.is_empty() {
                out.push_str(&format!(" owns {}", card.owns.join(", ")));
            }
            out.push('\n');
        }
        let findings = self.findings_for(Some(card_id), MAX_FINDINGS);
        if findings.is_empty() {
            out.push_str("No findings yet.");
        } else {
            out.push_str("Findings:\n");
            for finding in findings {
                out.push_str(&self.finding_line(finding));
                out.push('\n');
            }
        }
        out.trim_end().to_string()
    }

    /// The prompt a card's subagent gets: the card's own, then what the
    /// swarm needs it to know — its files and the results it builds on.
    pub fn child_prompt(&self, id: &str) -> Option<String> {
        let card = self.card(id)?;
        let mut out = card.prompt.clone();
        out.push_str(&format!(
            "\n\nYou are one member of a swarm working from a shared board. Your card: {} \"{}\".",
            card.id, card.title
        ));
        if !card.owns.is_empty() {
            out.push_str(&format!(
                " You own these paths and may change only them: {}.",
                card.owns.join(", ")
            ));
        }
        if !card.notes.is_empty() {
            out.push_str("\n\nFeedback on earlier attempts:");
            for note in &card.notes {
                out.push_str(&format!("\n- {note}"));
            }
        }
        let built_on: Vec<&Card> = card
            .depends_on
            .iter()
            .filter_map(|dep| self.card(dep))
            .filter(|dep| dep.result.is_some())
            .collect();
        if !built_on.is_empty() {
            out.push_str("\n\nResults you build on:");
            for dep in built_on {
                out.push_str(&format!(
                    "\n- {} \"{}\": {}",
                    dep.id,
                    dep.title,
                    trim_limit(dep.result.as_deref().unwrap_or_default(), 1_500)
                ));
            }
        }
        let findings = self.findings_for(Some(&card.id), PROMPT_FINDINGS);
        if !findings.is_empty() {
            out.push_str("\n\nFindings the swarm has posted so far:");
            for finding in findings {
                out.push_str(&format!("\n- {}", self.finding_line(finding)));
            }
        }
        out.push_str(&format!("\n\n{MEMBER_GUIDE} Your card id is {}.", card.id));
        Some(out)
    }

    /// The board as the main model reads it after every `board` call.
    pub fn summary(&self) -> String {
        if self.cards.is_empty() {
            return "The board is empty.".into();
        }
        let mut out = String::new();
        for status in [
            CardStatus::Working,
            CardStatus::Review,
            CardStatus::Backlog,
            CardStatus::Failed,
            CardStatus::Done,
        ] {
            let cards: Vec<&Card> = self.cards.iter().filter(|c| c.status == status).collect();
            if cards.is_empty() {
                continue;
            }
            out.push_str(&format!("{}:\n", status.as_str()));
            for card in cards {
                out.push_str(&format!("- {} {} [{}", card.id, card.title, card.role));
                if let Some(model) = &card.model {
                    out.push_str(&format!(" · {model}"));
                }
                out.push(']');
                if !card.depends_on.is_empty() && status == CardStatus::Backlog {
                    out.push_str(&format!(" waits for {}", card.depends_on.join(", ")));
                }
                if let Some(result) = &card.result {
                    if matches!(
                        status,
                        CardStatus::Review | CardStatus::Failed | CardStatus::Done
                    ) {
                        out.push_str(&format!(" — {}", trim_limit(result, 300)));
                    }
                }
                out.push('\n');
            }
        }
        let findings = self.findings_for(None, SUMMARY_FINDINGS);
        if !findings.is_empty() {
            out.push_str("findings:\n");
            for finding in findings {
                out.push_str(&format!("- {}\n", self.finding_line(finding)));
            }
        }
        out.trim_end().to_string()
    }
}

/// How a member works with the others; ends every card's prompt.
const MEMBER_GUIDE: &str = "\
The other members work at the same time. Use the `swarm` tool to post what they need to know the \
moment you learn it — a fact about the code, a decision you made, a signature or file you changed — \
in one or two sentences, addressed with `to` when it concerns only some cards. Findings from the \
others arrive in your conversation as you work; `swarm` `read` shows the cards and every finding. \
Do not post your final report: your last message goes to the lead.";

/// One board file per session, written atomically. Session ids are UUIDs and
/// cannot escape the directory. Read-modify-write goes through one process
/// lock, since the forwarder threads of several children update one board.
pub struct BoardStore {
    directory: PathBuf,
}

static WRITE: Mutex<()> = Mutex::new(());

impl BoardStore {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    /// Beside the session goals (`~/.agente/sessions/boards`, or under
    /// `AGENTE_SESSIONS_DIR`).
    pub fn user() -> Self {
        let sessions = std::env::var_os("AGENTE_SESSIONS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".agente")
                    .join("sessions")
            });
        Self::new(sessions.join("boards"))
    }

    fn path(&self, session: Uuid) -> PathBuf {
        self.directory.join(format!("{session}.json"))
    }

    pub fn get(&self, session: Uuid) -> anyhow::Result<Board> {
        match fs::read(self.path(session)) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Board::default()),
            Err(error) => Err(error.into()),
        }
    }

    /// True when swarm mode is on for the session.
    pub fn enabled(&self, session: Uuid) -> bool {
        self.get(session).is_ok_and(|board| board.enabled)
    }

    /// Read, change and save the board under the process lock. The change
    /// returns a value or an error; on error nothing is saved.
    pub fn update<T>(
        &self,
        session: Uuid,
        change: impl FnOnce(&mut Board) -> Result<T, String>,
    ) -> Result<(T, Board), String> {
        let _guard = WRITE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut board = self.get(session).map_err(|error| error.to_string())?;
        let value = change(&mut board)?;
        crate::fs_atomic::write_atomic(
            &self.path(session),
            &serde_json::to_vec_pretty(&board).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        Ok((value, board))
    }

    /// Turn swarm mode on or off; the cards stay.
    pub fn set_enabled(&self, session: Uuid, enabled: bool) -> Result<Board, String> {
        self.update(session, |board| {
            board.enabled = enabled;
            Ok(())
        })
        .map(|(_, board)| board)
    }

    /// Empty the board, keeping the switch as it is.
    pub fn clear(&self, session: Uuid) -> Result<Board, String> {
        self.update(session, |board| {
            *board = Board {
                enabled: board.enabled,
                ..Board::default()
            };
            Ok(())
        })
        .map(|(_, board)| board)
    }
}

/// Arguments of the `board` tool.
#[derive(Debug, Clone, Deserialize)]
pub struct BoardArgs {
    pub action: BoardAction,
    #[serde(default)]
    pub cards: Vec<CardSpec>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub to: Option<MoveTo>,
    #[serde(default)]
    pub note: Option<String>,
    /// For post: what to tell the members.
    #[serde(default)]
    pub text: Option<String>,
    /// For post: the cards it is for (ids or titles); empty = every member.
    #[serde(default)]
    pub recipients: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoardAction {
    Add,
    Move,
    Show,
    Post,
}

/// Hands a new finding to the members working now (their inboxes) and
/// tells the UI the board changed. The host builds it; the `board` and
/// `swarm` tools call it after every post.
pub type DeliverFinding = std::sync::Arc<dyn Fn(&Board, &Finding) + Send + Sync>;

/// Post to a session's board and deliver the finding. Returns the line the
/// poster gets back.
pub fn post_and_deliver(
    session: Uuid,
    from: &str,
    text: &str,
    to: &[String],
    deliver: &DeliverFinding,
) -> Result<String, String> {
    let (finding, board) = BoardStore::user().update(session, |board| board.post(from, text, to))?;
    let reached = board.recipients(&finding).len();
    deliver(&board, &finding);
    Ok(match reached {
        0 => format!("Posted #{}. No other member is working right now; cards that start later will see it.", finding.id),
        1 => format!("Posted #{} to 1 working member.", finding.id),
        n => format!("Posted #{} to {n} working members.", finding.id),
    })
}

/// The `swarm` tool a card's subagent gets: post a finding to the other
/// members, or read the cards and the findings log.
pub struct SwarmTool {
    session: Uuid,
    card_id: String,
    deliver: DeliverFinding,
}

impl SwarmTool {
    pub fn new(session: Uuid, card_id: impl Into<String>, deliver: DeliverFinding) -> Self {
        Self {
            session,
            card_id: card_id.into(),
            deliver,
        }
    }
}

#[derive(Debug, Deserialize)]
struct SwarmArgs {
    action: SwarmAction,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    to: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SwarmAction {
    Post,
    Read,
}

const SWARM_DESCRIPTION: &str = "\
Talk to the other members of your swarm. action \"post\": share a finding the moment you have it — \
a fact about the code, a decision, a signature or file you changed — in one or two sentences \
(`text`); `to` addresses some cards (ids like c2, or titles), otherwise every member sees it. \
Members working now get it at their next step; cards that start later get it in their prompt. \
action \"read\": every card's state and the findings you may read. Your final report is not a \
finding: end with it as your last message.";

#[async_trait::async_trait]
impl crate::tools::Tool for SwarmTool {
    fn name(&self) -> &str {
        "swarm"
    }

    fn kind(&self) -> crate::tools::ToolKind {
        crate::tools::ToolKind::Todo
    }

    fn description(&self) -> &str {
        SWARM_DESCRIPTION
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["post", "read"] },
                "text": { "type": "string", "description": "For post: the finding, one or two sentences." },
                "to": { "type": "array", "items": { "type": "string" }, "description": "For post: the cards it is for; omit for every member." }
            },
            "required": ["action"]
        })
    }

    fn execution_mode(&self) -> crate::tools::ToolExecutionMode {
        crate::tools::ToolExecutionMode::Sequential
    }

    fn uses_host_filesystem(&self) -> bool {
        false
    }

    fn default_permission(
        &self,
        _mode: crate::types::AgentMode,
    ) -> Option<crate::permissions::Permission> {
        Some(crate::permissions::Permission::Allow)
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _project_dir: &str,
    ) -> Result<String, crate::tools::ToolError> {
        let args: SwarmArgs = serde_json::from_value(args)
            .map_err(|e| crate::tools::ToolError::InvalidArguments(e.to_string()))?;
        match args.action {
            SwarmAction::Read => BoardStore::user()
                .get(self.session)
                .map(|board| board.member_view(&self.card_id))
                .map_err(|e| crate::tools::ToolError::ExecutionError(e.to_string())),
            SwarmAction::Post => {
                let text = args.text.unwrap_or_default();
                post_and_deliver(self.session, &self.card_id, &text, &args.to, &self.deliver)
                    .map_err(crate::tools::ToolError::InvalidArguments)
            }
        }
    }
}

/// The `board` tool. Hosted like `task`: its schema is exposed through the
/// registry, its calls run in `SubagentHost` (they start subagents).
pub struct BoardTool {
    description: String,
    model_names: Vec<String>,
}

impl Default for BoardTool {
    fn default() -> Self {
        Self::new()
    }
}

impl BoardTool {
    pub fn new() -> Self {
        Self {
            description: BOARD_DESCRIPTION.to_string(),
            model_names: Vec::new(),
        }
    }

    /// Offer the user's subagent models: their menu joins the description
    /// and their names (plus `main`) become the card `model` enum.
    pub fn with_models(menu: &[crate::subagent::routing::ModelMenuEntry]) -> Self {
        let mut tool = Self::new();
        if !menu.is_empty() {
            tool.description
                .push_str(&crate::subagent::routing::menu_text(menu));
            tool.model_names = crate::subagent::routing::model_names_from_menu(menu);
        }
        tool
    }
}

const BOARD_DESCRIPTION: &str = "\
Swarm mode is on: plan the work as a board of cards and let a swarm of subagents you create work it. \
Each card is one piece of work and the subagent created for it: a `title`, a `role` (who it is, \
e.g. \"Parser refactorer\"), optional `instructions`, a `capability_mode` (\"read-only\" by default; \
\"read-write\" to edit files, \"execute\" to also run commands), a `model` from the user's list, \
the `prompt` with everything it needs, `depends_on` (ids or titles of cards it waits for) and, for \
writers, `owns` (the paths only it may change — one writer per file; use `dir/**` for a folder).\n\
- action \"add\": add cards. Every card whose dependencies are done starts at once, each on its own \
subagent; the rest start as their dependencies finish. Readers go to done when they finish, writers \
to review.\n\
- action \"move\": accept a reviewed card (`to`: \"done\"), send one back with a `note` of what to fix \
(`to`: \"backlog\" — a new subagent retries with your note), or give up on one (`to`: \"failed\").\n\
- action \"show\": the board and the newest findings.\n\
- action \"post\": tell the working members something (`text`; `recipients` to address some cards) — \
a decision, a correction, a change of plan. It reaches them at their next step.\n\
Members post findings to each other as they work (they have a `swarm` tool), so related cards can run \
at once instead of waiting; the newest findings come back with every board result. \
Plan for parallel work: independent cards run at once, so split by area and give each writer its \
own files. Results of finished cards reach the cards that wait for them. You are told as cards \
finish; review writers' work (read the files, run the tests) before accepting it, and finish by \
summarising the board for the user.";

#[async_trait::async_trait]
impl crate::tools::Tool for BoardTool {
    fn name(&self) -> &str {
        "board"
    }

    fn kind(&self) -> crate::tools::ToolKind {
        crate::tools::ToolKind::Task
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters(&self) -> serde_json::Value {
        let mut schema = serde_json::json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["add", "move", "show", "post"] },
                "cards": {
                    "type": "array",
                    "description": "For add: the cards to put on the board.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": { "type": "string", "description": "The piece of work, a few words." },
                            "role": { "type": "string", "description": "Who the subagent created for it is." },
                            "instructions": { "type": "string" },
                            "capability_mode": { "type": "string", "enum": ["read-only", "read-write", "execute"] },
                            "instance_id": { "type": "string", "description": "Driver instance id such as \"agente\", \"claude\", \"codex\", or a custom ACP instance." },
                            "prompt": { "type": "string", "description": "Everything the subagent needs: it sees nothing else." },
                            "depends_on": { "type": "array", "items": { "type": "string" } },
                            "owns": { "type": "array", "items": { "type": "string" } }
                        },
                        "required": ["title", "role", "prompt"]
                    }
                },
                "id": { "type": "string", "description": "For move: the card (c1, c2, …)." },
                "to": { "type": "string", "enum": ["done", "backlog", "failed"] },
                "note": { "type": "string", "description": "For move to backlog: what to fix." },
                "text": { "type": "string", "description": "For post: what to tell the working members." },
                "recipients": { "type": "array", "items": { "type": "string" }, "description": "For post: the cards it is for; omit for every member." }
            },
            "required": ["action"]
        });
        if let Some(model_prop) = crate::subagent::routing::subagent_model_schema(
            &self.model_names,
            "A name from the user's subagent model list, or \"main\".",
        ) {
            schema["properties"]["cards"]["items"]["properties"]["model"] = model_prop;
        }
        schema
    }

    fn execution_mode(&self) -> crate::tools::ToolExecutionMode {
        crate::tools::ToolExecutionMode::Sequential
    }

    fn allowed_in_plan(&self) -> bool {
        true
    }

    async fn execute(
        &self,
        _args: serde_json::Value,
        _project_dir: &str,
    ) -> Result<String, crate::tools::ToolError> {
        Err(crate::tools::ToolError::ExecutionError(
            "board is a hosted tool and is executed by the agent harness".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(title: &str, writer: bool, deps: &[&str], owns: &[&str]) -> CardSpec {
        CardSpec {
            title: title.into(),
            role: format!("{title} role"),
            instructions: None,
            capability_mode: writer.then_some(SubagentCapabilityMode::ReadWrite),
            model: Some("scout".into()),
            instance_id: None,
            prompt: format!("do {title}"),
            depends_on: deps.iter().map(|d| d.to_string()).collect(),
            owns: owns.iter().map(|o| o.to_string()).collect(),
        }
    }

    #[test]
    fn cards_start_when_their_dependencies_are_done() {
        let mut board = Board::default();
        let ids = board
            .add(vec![
                spec("Map the code", false, &[], &[]),
                spec(
                    "Refactor parser",
                    true,
                    &["Map the code"],
                    &["src/parser/**"],
                ),
                spec("Write tests", true, &["c2"], &["tests/parser.rs"]),
            ])
            .unwrap();
        assert_eq!(ids, ["c1", "c2", "c3"]);
        assert_eq!(board.cards[1].depends_on, ["c1"]);
        assert_eq!(board.ready(), ["c1"]);

        board.start("c1", "child-1");
        assert!(board.ready().is_empty());
        assert_eq!(
            board.child_finished("child-1", true, "found it"),
            Some("c1".into())
        );
        // A reader goes straight to done; its result reaches the next card.
        assert_eq!(board.card("c1").unwrap().status, CardStatus::Done);
        assert_eq!(board.ready(), ["c2"]);
        let prompt = board.child_prompt("c2").unwrap();
        assert!(
            prompt.contains("Results you build on:\n- c1 \"Map the code\": found it"),
            "{prompt}"
        );
        assert!(
            prompt.contains("may change only them: src/parser/**"),
            "{prompt}"
        );

        // A writer goes to review; the lead accepts it.
        board.start("c2", "child-2");
        board.child_finished("child-2", true, "refactored");
        assert_eq!(board.card("c2").unwrap().status, CardStatus::Review);
        assert!(board.ready().is_empty());
        board.move_card("c2", MoveTo::Done, None).unwrap();
        assert_eq!(board.ready(), ["c3"]);
    }

    #[test]
    fn one_writer_per_file() {
        let mut board = Board::default();
        board
            .add(vec![spec("Parser", true, &[], &["src/parser/**"])])
            .unwrap();
        let err = board
            .add(vec![spec("Lexer", true, &[], &["src/parser/lexer.rs"])])
            .unwrap_err();
        assert!(err.contains("one writer per file"), "{err}");
        // Readers own nothing and never collide; other paths are fine.
        board
            .add(vec![
                spec("Read parser", false, &[], &["src/parser/lexer.rs"]),
                spec("Docs", true, &[], &["docs/parser.md"]),
            ])
            .unwrap();
        assert!(board.card("c2").unwrap().owns.is_empty());
        // A finished writer frees its files.
        board.cards[0].status = CardStatus::Done;
        assert!(board
            .add(vec![spec("Lexer", true, &[], &["src/parser/lexer.rs"])])
            .is_ok());
        // A bad card adds nothing.
        let before = board.cards.len();
        assert!(board
            .add(vec![
                spec("Ok", false, &[], &[]),
                spec("Bad", false, &["nope"], &[])
            ])
            .is_err());
        assert_eq!(board.cards.len(), before);
    }

    #[test]
    fn a_card_sent_back_retries_with_the_feedback() {
        let mut board = Board::default();
        board
            .add(vec![spec("Fix bug", true, &[], &["src/a.rs"])])
            .unwrap();
        board.start("c1", "child-1");
        assert!(board.move_card("c1", MoveTo::Done, None).is_err());
        board.child_finished("child-1", true, "patched");
        board
            .move_card(
                "c1",
                MoveTo::Backlog,
                Some("The test still fails on empty input."),
            )
            .unwrap();
        assert_eq!(board.ready(), ["c1"]);
        assert_eq!(board.card("c1").unwrap().child_id, None);
        let prompt = board.child_prompt("c1").unwrap();
        assert!(prompt
            .contains("Feedback on earlier attempts:\n- The test still fails on empty input."));
        board.start("c1", "child-2");
        board.child_finished("child-2", false, "crashed");
        assert_eq!(board.card("c1").unwrap().status, CardStatus::Failed);
        // An unknown child is not a card's.
        assert_eq!(board.child_finished("other", true, ""), None);
    }

    #[test]
    fn the_summary_groups_by_column() {
        let mut board = Board::default();
        board
            .add(vec![
                spec("Map", false, &[], &[]),
                spec("Build", true, &["c1"], &["src/**"]),
            ])
            .unwrap();
        board.start("c1", "x");
        let text = board.summary();
        assert!(
            text.starts_with("working:\n- c1 Map [Map role · scout]"),
            "{text}"
        );
        assert!(
            text.contains("backlog:\n- c2 Build [Build role · scout] waits for c1"),
            "{text}"
        );
        assert_eq!(Board::default().summary(), "The board is empty.");
    }

    #[test]
    fn findings_reach_working_members_and_later_cards() {
        let mut board = Board::default();
        board
            .add(vec![
                spec("Map", false, &[], &[]),
                spec("Parse", true, &[], &["src/parse.rs"]),
                spec("Docs", false, &[], &[]),
                spec("Wire", true, &["c1"], &["src/main.rs"]),
            ])
            .unwrap();
        board.start("c1", "child-1");
        board.start("c2", "child-2");
        board.start("c3", "child-3");

        // Everyone working but the author hears a broadcast.
        let all = board.post("c1", "  Tokens live in lexer.rs  ", &[]).unwrap();
        assert_eq!((all.id, all.text.as_str()), (1, "Tokens live in lexer.rs"));
        assert_eq!(board.recipients(&all), vec!["child-2", "child-3"]);

        // Addressed by id or title, only the addressee.
        let one = board.post("c2", "parse() now returns Result", &["docs".into()]).unwrap();
        assert_eq!(one.to, vec!["c3"]);
        assert_eq!(board.recipients(&one), vec!["child-3"]);
        assert!(board.post("c2", "x", &["nope".into()]).is_err());
        assert!(board.post("c9", "x", &[]).is_err());
        assert!(board.post("c1", "   ", &[]).is_err());

        // The lead posts too, and sees everything in its summary.
        board.post(LEAD, "Keep the public API", &[]).unwrap();
        let summary = board.summary();
        assert!(summary.contains("findings:\n- #1 c1 \"Map\" (Map role): Tokens live in lexer.rs"), "{summary}");
        assert!(summary.contains("#2 c2 \"Parse\" (Parse role) \u{2192} c3: parse() now returns Result"), "{summary}");
        assert!(summary.contains("#3 the lead: Keep the public API"), "{summary}");

        // A card starting later gets the broadcasts, not others' private notes.
        let prompt = board.child_prompt("c4").unwrap();
        assert!(prompt.contains("Tokens live in lexer.rs"), "{prompt}");
        assert!(prompt.contains("Keep the public API"), "{prompt}");
        assert!(!prompt.contains("returns Result"), "{prompt}");
        assert!(prompt.contains("`swarm` tool") && prompt.contains("Your card id is c4."), "{prompt}");

        // The addressee's view has it.
        assert!(board.member_view("c3").contains("returns Result"));
        assert!(board.member_view("c3").contains("c3 Docs [Docs role · working] (you)"));
    }

    #[test]
    fn the_findings_log_keeps_the_newest() {
        let mut board = Board::default();
        board.add(vec![spec("Map", false, &[], &[])]).unwrap();
        for n in 0..(MAX_FINDINGS + 5) {
            board.post("c1", &format!("note {n}"), &[]).unwrap();
        }
        assert_eq!(board.findings.len(), MAX_FINDINGS);
        assert_eq!(board.findings[0].id, 6);
        assert_eq!(board.findings.last().unwrap().id as usize, MAX_FINDINGS + 5);
    }

    #[test]
    fn the_store_keeps_the_switch_and_the_cards() {
        let dir = std::env::temp_dir().join(format!("agente-boards-{}", Uuid::new_v4()));
        let store = BoardStore::new(&dir);
        let session = Uuid::new_v4();
        assert!(!store.enabled(session));
        store.set_enabled(session, true).unwrap();
        let (ids, board) = store
            .update(session, |board| {
                board.add(vec![spec("Map", false, &[], &[])])
            })
            .unwrap();
        assert_eq!(ids, ["c1"]);
        assert!(board.enabled);
        // A failed change saves nothing.
        assert!(store
            .update(session, |board| board.move_card("c9", MoveTo::Done, None))
            .is_err());
        store.set_enabled(session, false).unwrap();
        let board = store.get(session).unwrap();
        assert!(!board.enabled);
        assert_eq!(board.cards.len(), 1);
        let board = store.clear(session).unwrap();
        assert!(board.cards.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claims_overlap_by_containment() {
        assert!(overlaps("src/parser/**", "src/parser/lexer.rs"));
        assert!(overlaps("src/parser/", "src/parser"));
        assert!(overlaps("./src/a.rs", "src/a.rs"));
        assert!(overlaps("src/a/../b.rs", "src/b.rs"));
        assert!(overlaps("src//parser//lexer.rs", "src/parser/lexer.rs"));
        assert!(overlaps(".", "src/a.rs"));
        assert!(overlaps("./", "src/a.rs"));
        assert!(overlaps("/**", "src/a.rs"));
        assert!(overlaps("src/*.rs", "src/lib.rs"));
        assert!(overlaps("src/**/*.rs", "src/sub/mod.rs"));
        #[cfg(windows)]
        assert!(overlaps("Src/Parser/Lexer.rs", "src/parser/lexer.rs"));
        assert!(!overlaps("src/parser/**", "src/parsers.rs"));
        assert!(!overlaps("src/a.rs", "src/b.rs"));

        assert!(path_is_owned("src/parser/**", "src/parser/lexer.rs"));
        assert!(path_is_owned("src/a.rs", "./src/b/../a.rs"));
        assert!(path_is_owned(".", "src/a.rs"));
        assert!(!path_is_owned("src/a.rs", "src/"));
        assert!(!path_is_owned("src/**", "../outside.rs"));
    }

    #[test]
    fn dependent_writers_on_same_file_are_allowed_and_move_to_backlog_rechecks_owns() {
        let mut board = Board::default();
        // Sequential chain c1 -> c2 -> c3 on the same file can be planned together.
        let ids = board
            .add(vec![
                spec("Step 1", true, &[], &["src/a.rs"]),
                spec("Step 2", true, &["Step 1"], &["src/a.rs"]),
                spec("Step 3", true, &["Step 2"], &["src/a.rs"]),
            ])
            .unwrap();
        assert_eq!(ids, ["c1", "c2", "c3"]);

        // If c1 finishes and is accepted (Done), and an independent writer c4 is added on src/a.rs
        // after c2/c3 are failed/done, moving c1 back to Backlog must fail because c4 is open.
        board.cards[0].status = CardStatus::Done;
        board.cards[1].status = CardStatus::Failed;
        board.cards[2].status = CardStatus::Failed;
        board
            .add(vec![spec("Parallel writer", true, &[], &["src/a.rs"])])
            .unwrap();
        let err = board.move_card("c1", MoveTo::Backlog, None).unwrap_err();
        assert!(err.contains("one writer per file"), "{err}");

        // Once c4 is Done, c1 can move back to Backlog.
        board.cards[3].status = CardStatus::Done;
        assert!(board.move_card("c1", MoveTo::Backlog, None).is_ok());
    }

    #[test]
    fn board_tool_gates_model_property_on_menu() {
        use crate::subagent::routing::ModelMenuEntry;
        use crate::tools::Tool;

        let default_schema = BoardTool::new().parameters();
        assert!(default_schema["properties"]["cards"]["items"]["properties"]
            .get("model")
            .is_none());

        let with_menu = BoardTool::with_models(&[ModelMenuEntry {
            name: "scout".into(),
            price: "free".into(),
            context: 128_000,
            use_for: "fast reads".into(),
        }]);
        let schema = with_menu.parameters();
        let model_enum = schema["properties"]["cards"]["items"]["properties"]["model"]["enum"]
            .as_array()
            .unwrap();
        assert_eq!(
            model_enum,
            &[serde_json::json!("scout"), serde_json::json!("main")]
        );
        assert!(with_menu.description().contains("Models you can assign"));
    }

    #[test]
    fn card_instance_id_round_trips_through_board_add_and_json() {
        let mut board = Board::default();
        let spec: CardSpec = serde_json::from_value(serde_json::json!({
            "title": "Audit API",
            "role": "Reviewer",
            "instance_id": "  claude-work  ",
            "prompt": "Review the changes"
        }))
        .unwrap();
        let ids = board.add(vec![spec]).unwrap();
        assert_eq!(ids, ["c1"]);
        assert_eq!(board.cards[0].instance_id.as_deref(), Some("claude-work"));

        let json = serde_json::to_string(&board).unwrap();
        let restored: Board = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.cards[0].instance_id.as_deref(), Some("claude-work"));
    }
}
