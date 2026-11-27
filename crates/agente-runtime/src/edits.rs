//! Undo, redo and rewind of the agent's file edits, per session.
//!
//! Each turn's edits (from the loop's own `FileChange` events, never a
//! subagent's isolated checkout) form one batch holding every file's content
//! before and after the turn. Undo restores the "before" side, redo the
//! "after" side; both refuse when a file no longer matches what the batch
//! expects, so a hand edit made since is never overwritten. Rewind undoes
//! every batch made after a given point in the conversation.

use std::collections::HashMap;
use std::path::Path;

use agente_protocol::{Message, Role, SessionId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FileEdit {
    pub path: String,
    /// `None`: the file did not exist.
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Batch {
    edits: Vec<FileEdit>,
    /// Conversation length when the turn started (its user message included).
    conversation_len: usize,
    turn_index: usize,
    created_at: i64,
    /// Hash of the turn's user message, so a compaction can find where the
    /// turn now sits in the shorter conversation.
    #[serde(default)]
    anchor: Option<u64>,
    /// Compaction summarized the turn's user message away: the batch no
    /// longer has a position, only its place in the history.
    #[serde(default)]
    unresolved: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct History {
    undo: Vec<Batch>,
    redo: Vec<Batch>,
    /// Set when a turn starts; the batch is recorded when it ends.
    #[serde(skip)]
    pending_start: Option<usize>,
    #[serde(skip)]
    pending_anchor: Option<u64>,
    #[serde(skip)]
    pending_unresolved: bool,
    turn_index: usize,
    /// After a compaction: the first message kept from before it (what the
    /// summary, carried skills and notes precede). Batches without a
    /// position are older than it.
    #[serde(default)]
    compacted_floor: Option<usize>,
}

#[derive(Debug, Default)]
pub(crate) struct EditLog {
    sessions: HashMap<SessionId, History>,
}

impl EditLog {
    /// `prompt` is the turn's user message, the anchor a later compaction
    /// uses to find the turn again.
    pub fn begin_turn(
        &mut self,
        session_id: SessionId,
        conversation_len: usize,
        prompt: Option<&str>,
    ) {
        let history = self.sessions.entry(session_id).or_default();
        history.pending_start = Some(conversation_len);
        history.pending_anchor = prompt.map(anchor_of);
        history.pending_unresolved = false;
        history.turn_index += 1;
    }

    /// Record a finished turn's edits as one batch. A new batch ends any
    /// redo chain, like typing after an undo in an editor.
    pub fn end_turn(&mut self, session_id: SessionId, edits: Vec<FileEdit>) {
        let history = self.sessions.entry(session_id).or_default();
        let start = history.pending_start.take().unwrap_or(0);
        let anchor = history.pending_anchor.take();
        let unresolved = std::mem::take(&mut history.pending_unresolved);
        let edits = merge(edits);
        if edits.is_empty() {
            return;
        }
        history.redo.clear();
        history.undo.push(Batch {
            edits,
            conversation_len: start,
            turn_index: history.turn_index,
            created_at: chrono::Utc::now().timestamp_millis(),
            anchor,
            unresolved,
        });
    }

    pub fn undo(
        &mut self,
        session_id: SessionId,
        project_dir: &str,
    ) -> Result<Vec<String>, String> {
        let history = self.sessions.entry(session_id).or_default();
        let batch = history.undo.pop().ok_or("Nothing to undo")?;
        match apply(&batch.edits, project_dir, Side::Before) {
            Ok(paths) => {
                history.redo.push(batch);
                Ok(paths)
            }
            Err(error) => {
                history.undo.push(batch);
                Err(error)
            }
        }
    }

    pub fn redo(
        &mut self,
        session_id: SessionId,
        project_dir: &str,
    ) -> Result<Vec<String>, String> {
        let history = self.sessions.entry(session_id).or_default();
        let batch = history.redo.pop().ok_or("Nothing to redo")?;
        match apply(&batch.edits, project_dir, Side::After) {
            Ok(paths) => {
                history.undo.push(batch);
                Ok(paths)
            }
            Err(error) => {
                history.redo.push(batch);
                Err(error)
            }
        }
    }

    /// Undo every batch made at or after `conversation_index`, newest first.
    /// Stops at the first file that changed underneath; returns how many
    /// batches were undone.
    pub fn rewind(
        &mut self,
        session_id: SessionId,
        conversation_index: usize,
        project_dir: &str,
    ) -> Result<usize, String> {
        let history = self.sessions.entry(session_id).or_default();
        let first = history
            .undo
            .iter()
            .position(|batch| !batch.unresolved && batch.conversation_len > conversation_index)
            .unwrap_or(history.undo.len());
        // Batches whose prompt a compaction summarized away are older than
        // every message kept from before it. A point inside the compacted
        // part cannot say which of them came after it: refuse rather than
        // truncate the conversation and leave their edits on disk.
        if history
            .compacted_floor
            .is_some_and(|floor| conversation_index < floor)
            && history.undo[..first].iter().any(|batch| batch.unresolved)
        {
            return Err(COMPACTED_REWIND.into());
        }
        let edits = merge_chain(&history.undo[first..])?;
        apply(&edits, project_dir, Side::Before)?;
        let batches = history.undo.split_off(first);
        let undone = batches.len();
        history.redo.extend(batches.into_iter().rev());
        Ok(undone)
    }

    /// Atomically undo every batch whose `turn_index >= turn_index` without
    /// modifying the conversation transcript. Checks every file before writing
    /// any, so a conflict leaves disk and history untouched.
    pub fn rollback_to_turn(
        &mut self,
        session_id: SessionId,
        turn_index: usize,
        project_dir: &str,
    ) -> Result<Vec<String>, String> {
        let history = self.sessions.entry(session_id).or_default();
        let first = history
            .undo
            .iter()
            .position(|batch| batch.turn_index >= turn_index)
            .unwrap_or(history.undo.len());
        if first == history.undo.len() {
            return Ok(Vec::new());
        }
        let edits = merge_chain(&history.undo[first..])?;
        let paths = apply(&edits, project_dir, Side::Before)?;
        let batches = history.undo.split_off(first);
        history.redo.extend(batches.into_iter().rev());
        Ok(paths)
    }

    pub fn restore(&mut self, session_id: SessionId, value: serde_json::Value) {
        if let std::collections::hash_map::Entry::Vacant(entry) = self.sessions.entry(session_id) {
            if let Ok(history) = serde_json::from_value(value) {
                entry.insert(history);
            }
        }
    }

    pub fn snapshot(&self, session_id: SessionId) -> serde_json::Value {
        self.sessions
            .get(&session_id)
            .and_then(|history| serde_json::to_value(history).ok())
            .unwrap_or(serde_json::Value::Null)
    }

    pub fn checkpoints(&self, session_id: SessionId) -> serde_json::Value {
        let Some(history) = self.sessions.get(&session_id) else {
            return serde_json::json!([]);
        };
        serde_json::Value::Array(history.undo.iter().map(|batch| {
            let (additions, deletions) = batch.edits.iter().map(line_delta).fold((0, 0), |total, value| (total.0 + value.0, total.1 + value.1));
            serde_json::json!({
                "turnIndex": batch.turn_index, "createdAt": batch.created_at,
                "conversationIndex": batch.conversation_len.saturating_sub(1),
                "fileCount": batch.edits.len(), "additions": additions, "deletions": deletions,
                "files": batch.edits.iter().map(|edit| &edit.path).collect::<Vec<_>>()
            })
        }).collect())
    }

    pub fn forget(&mut self, session_id: SessionId) {
        self.sessions.remove(&session_id);
    }

    /// Keep undo/redo after compaction: each batch finds its turn's user
    /// message in the compacted `conversation` (newest first, so a repeated
    /// prompt goes to the newest turn); one whose prompt was summarized away
    /// keeps only its place in the history.
    pub fn compacted(&mut self, session_id: SessionId, conversation: &[Message]) {
        let Some(history) = self.sessions.get_mut(&session_id) else {
            return;
        };
        let mut cursor = conversation.len();
        if history.pending_start.is_some() {
            match locate(conversation, history.pending_anchor, cursor) {
                Some(index) => {
                    history.pending_start = Some(index + 1);
                    cursor = index;
                }
                None => {
                    history.pending_start = Some(0);
                    history.pending_unresolved = true;
                }
            }
        }
        for batch in history.undo.iter_mut().rev() {
            let found = if batch.unresolved {
                None
            } else {
                locate(conversation, batch.anchor, cursor)
            };
            match found {
                Some(index) => {
                    batch.conversation_len = index + 1;
                    cursor = index;
                }
                None => {
                    batch.conversation_len = 0;
                    batch.unresolved = true;
                }
            }
        }
        for batch in &mut history.redo {
            match locate(conversation, batch.anchor, conversation.len()) {
                Some(index) => batch.conversation_len = index + 1,
                None => {
                    batch.conversation_len = 0;
                    batch.unresolved = true;
                }
            }
        }
        history.compacted_floor = Some(
            conversation
                .iter()
                .position(|message| {
                    !matches!(message.role, Role::System) && !compaction_note(&message.content)
                })
                .unwrap_or(conversation.len()),
        );
    }
}

const COMPACTED_REWIND: &str = "This point is in the part of the conversation that was \
compacted, so its file edits can no longer be matched to it. Use Undo to step back through \
them instead.";

/// A message compaction itself wrote: the summary, carried skills, a gap
/// note or the project reminder.
fn compaction_note(content: &str) -> bool {
    use agente_core::context::compaction::{CARRIED_SKILLS_HEADING, COMPACTED_GAP_NOTE};
    content.starts_with("[Conversation summary]")
        || content.starts_with(CARRIED_SKILLS_HEADING)
        || content.starts_with(COMPACTED_GAP_NOTE)
        || content.starts_with(agente_core::context::PROJECT_REMINDER_MARKER)
}

/// Stable across runs (it is persisted): FNV-1a over the trimmed prompt.
fn anchor_of(prompt: &str) -> u64 {
    prompt
        .trim()
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        })
}

/// The last user message before `before` whose text hashes to `anchor`.
fn locate(conversation: &[Message], anchor: Option<u64>, before: usize) -> Option<usize> {
    let anchor = anchor?;
    conversation[..before.min(conversation.len())]
        .iter()
        .rposition(|message| {
            matches!(message.role, Role::User) && anchor_of(&message.content) == anchor
        })
}

/// Several batches as one edit per file, refusing when a later batch did
/// not start from what an earlier one left: the file was changed by hand
/// between those turns, and restoring the first `before` would erase it.
fn merge_chain(batches: &[Batch]) -> Result<Vec<FileEdit>, String> {
    let mut merged: Vec<FileEdit> = Vec::new();
    for edit in batches.iter().flat_map(|batch| batch.edits.iter()) {
        match merged
            .iter_mut()
            .find(|existing| existing.path == edit.path)
        {
            Some(existing) => {
                if existing.after != edit.before {
                    return Err(format!(
                        "{} was changed between the agent's turns; refusing to overwrite",
                        edit.path
                    ));
                }
                existing.after = edit.after.clone();
            }
            None => merged.push(edit.clone()),
        }
    }
    merged.retain(|edit| edit.before != edit.after);
    Ok(merged)
}

/// What a file holds now: `None` only when it does not exist. A file that
/// is there but unreadable or not UTF-8 is not "missing": treating it so let
/// redo overwrite a file someone recreated with other bytes.
fn read_current(path: &Path, shown: &str) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| {
            format!("{shown} changed since (it is not UTF-8 text); refusing to overwrite")
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{shown}: {error}")),
    }
}

/// One entry per file: its first `before` and its last `after`.
fn merge(edits: Vec<FileEdit>) -> Vec<FileEdit> {
    let mut merged: Vec<FileEdit> = Vec::new();
    for edit in edits {
        match merged
            .iter_mut()
            .find(|existing| existing.path == edit.path)
        {
            Some(existing) => existing.after = edit.after,
            None => merged.push(edit),
        }
    }
    merged.retain(|edit| edit.before != edit.after);
    merged
}

fn line_delta(edit: &FileEdit) -> (usize, usize) {
    let diff = similar::TextDiff::from_lines(
        edit.before.as_deref().unwrap_or_default(),
        edit.after.as_deref().unwrap_or_default(),
    );
    let mut additions = 0usize;
    let mut deletions = 0usize;
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => additions += 1,
            similar::ChangeTag::Delete => deletions += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    (additions, deletions)
}

#[derive(Clone, Copy)]
enum Side {
    Before,
    After,
}

/// Put every file on `side`. Checks all files first, so a conflict changes
/// nothing.
fn apply(edits: &[FileEdit], project_dir: &str, side: Side) -> Result<Vec<String>, String> {
    for edit in edits {
        let current = read_current(&Path::new(project_dir).join(&edit.path), &edit.path)?;
        let (expected, _) = pick(edit, side);
        if &current != expected {
            return Err(format!(
                "{} changed since; refusing to overwrite",
                edit.path
            ));
        }
    }
    for edit in edits {
        let full = Path::new(project_dir).join(&edit.path);
        let (_, wanted) = pick(edit, side);
        match wanted {
            Some(content) => {
                if let Some(parent) = full.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", edit.path))?;
                }
                std::fs::write(&full, content).map_err(|e| format!("{}: {e}", edit.path))?;
            }
            None => {
                if full.exists() {
                    std::fs::remove_file(&full).map_err(|e| format!("{}: {e}", edit.path))?;
                }
            }
        }
    }
    Ok(edits.iter().map(|edit| edit.path.clone()).collect())
}

/// (what the file must hold now, what to write) for moving to `side`.
fn pick(edit: &FileEdit, side: Side) -> (&Option<String>, &Option<String>) {
    match side {
        Side::Before => (&edit.after, &edit.before),
        Side::After => (&edit.before, &edit.after),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("agente-edits-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn edit(path: &str, before: Option<&str>, after: Option<&str>) -> FileEdit {
        FileEdit {
            path: path.into(),
            before: before.map(Into::into),
            after: after.map(Into::into),
        }
    }

    fn read(dir: &Path, path: &str) -> Option<String> {
        std::fs::read_to_string(dir.join(path)).ok()
    }

    #[test]
    fn undo_and_redo_one_turn_including_a_new_file() {
        let dir = project("undo");
        let root = dir.to_str().unwrap();
        let session = SessionId::new();
        std::fs::write(dir.join("a.txt"), "v2").unwrap();
        std::fs::write(dir.join("new.txt"), "fresh").unwrap();
        let mut log = EditLog::default();
        log.begin_turn(session, 2, None);
        log.end_turn(
            session,
            vec![
                edit("a.txt", Some("v0"), Some("v1")),
                edit("a.txt", Some("v1"), Some("v2")),
                edit("new.txt", None, Some("fresh")),
            ],
        );

        let restored = log.undo(session, root).unwrap();
        assert_eq!(restored, vec!["a.txt", "new.txt"]);
        assert_eq!(
            read(&dir, "a.txt").as_deref(),
            Some("v0"),
            "first before wins"
        );
        assert_eq!(read(&dir, "new.txt"), None, "a created file is removed");
        assert_eq!(log.undo(session, root).unwrap_err(), "Nothing to undo");

        log.redo(session, root).unwrap();
        assert_eq!(
            read(&dir, "a.txt").as_deref(),
            Some("v2"),
            "last after wins"
        );
        assert_eq!(read(&dir, "new.txt").as_deref(), Some("fresh"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_hand_edit_since_blocks_undo_and_changes_nothing() {
        let dir = project("conflict");
        let root = dir.to_str().unwrap();
        let session = SessionId::new();
        std::fs::write(dir.join("a.txt"), "agent").unwrap();
        std::fs::write(dir.join("b.txt"), "mine now").unwrap();
        let mut log = EditLog::default();
        log.begin_turn(session, 2, None);
        log.end_turn(
            session,
            vec![
                edit("a.txt", Some("orig a"), Some("agent")),
                edit("b.txt", Some("orig b"), Some("agent b")),
            ],
        );

        let error = log.undo(session, root).unwrap_err();
        assert!(error.contains("b.txt"), "{error}");
        assert_eq!(
            read(&dir, "a.txt").as_deref(),
            Some("agent"),
            "nothing restored"
        );
        // Put the file back as the agent left it and undo works.
        std::fs::write(dir.join("b.txt"), "agent b").unwrap();
        log.undo(session, root).unwrap();
        assert_eq!(read(&dir, "b.txt").as_deref(), Some("orig b"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rewind_undoes_every_turn_after_the_point() {
        let dir = project("rewind");
        let root = dir.to_str().unwrap();
        let session = SessionId::new();
        std::fs::write(dir.join("a.txt"), "t3").unwrap();
        let mut log = EditLog::default();
        for (start, before, after) in [(2, "t0", "t1"), (5, "t1", "t2"), (8, "t2", "t3")] {
            log.begin_turn(session, start, None);
            log.end_turn(session, vec![edit("a.txt", Some(before), Some(after))]);
        }

        // Back to before the user message at index 4: the turns that started
        // at 5 and 8 are undone, the first one stays.
        assert_eq!(log.rewind(session, 4, root).unwrap(), 2);
        assert_eq!(read(&dir, "a.txt").as_deref(), Some("t1"));
        log.redo(session, root).unwrap();
        assert_eq!(read(&dir, "a.txt").as_deref(), Some("t2"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_conflict_in_an_older_batch_blocks_the_entire_rewind() {
        let dir = project("rewind-conflict");
        let root = dir.to_str().unwrap();
        let session = SessionId::new();
        let mut log = EditLog::default();
        log.begin_turn(session, 2, None);
        log.end_turn(
            session,
            vec![edit("a.txt", Some("original"), Some("agent"))],
        );
        log.begin_turn(session, 5, None);
        log.end_turn(session, vec![edit("b.txt", None, Some("new"))]);
        std::fs::write(dir.join("a.txt"), "hand edited").unwrap();
        std::fs::write(dir.join("b.txt"), "new").unwrap();
        assert!(log.rewind(session, 1, root).unwrap_err().contains("a.txt"));
        assert_eq!(read(&dir, "b.txt").as_deref(), Some("new"));
        assert_eq!(log.checkpoints(session).as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn message(role: Role, content: &str) -> Message {
        serde_json::from_value(serde_json::json!({ "role": role, "content": content })).unwrap()
    }

    #[test]
    fn redo_refuses_a_recreated_file_that_is_not_utf8() {
        let dir = project("redo-binary");
        let root = dir.to_str().unwrap();
        let session = SessionId::new();
        std::fs::write(dir.join("a.txt"), "agent text").unwrap();
        let mut log = EditLog::default();
        log.begin_turn(session, 2, None);
        log.end_turn(session, vec![edit("a.txt", None, Some("agent text"))]);
        log.undo(session, root).unwrap();
        assert_eq!(read(&dir, "a.txt"), None);
        std::fs::write(dir.join("a.txt"), [0xff, 0xfe, 0x00, 0x80]).unwrap();
        assert!(log.redo(session, root).unwrap_err().contains("a.txt"));
        assert_eq!(
            std::fs::read(dir.join("a.txt")).unwrap(),
            [0xff, 0xfe, 0x00, 0x80]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rewind_refuses_to_erase_a_hand_edit_made_between_turns() {
        let dir = project("rewind-between");
        let root = dir.to_str().unwrap();
        let session = SessionId::new();
        let mut log = EditLog::default();
        log.begin_turn(session, 2, None);
        log.end_turn(
            session,
            vec![edit("a.txt", Some("orig\n"), Some("agent1\n"))],
        );
        // The user adds a line by hand; the next turn keeps it.
        log.begin_turn(session, 5, None);
        log.end_turn(
            session,
            vec![edit(
                "a.txt",
                Some("agent1\nmine\n"),
                Some("agent2\nmine\n"),
            )],
        );
        std::fs::write(dir.join("a.txt"), "agent2\nmine\n").unwrap();
        let error = log.rewind(session, 1, root).unwrap_err();
        assert!(error.contains("a.txt"), "{error}");
        assert_eq!(read(&dir, "a.txt").as_deref(), Some("agent2\nmine\n"));
        assert_eq!(log.checkpoints(session).as_array().unwrap().len(), 2);
        // Undoing one turn at a time still works and keeps the hand edit.
        log.undo(session, root).unwrap();
        assert_eq!(read(&dir, "a.txt").as_deref(), Some("agent1\nmine\n"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rewind_after_compaction_finds_a_retained_prompt() {
        let dir = project("rewind-compacted");
        let root = dir.to_str().unwrap();
        let session = SessionId::new();
        std::fs::write(dir.join("a.txt"), "t2").unwrap();
        let mut log = EditLog::default();
        // Turn 1 ("old task") at 2, turn 2 ("keep this") at 4.
        log.begin_turn(session, 2, Some("old task"));
        log.end_turn(session, vec![edit("a.txt", Some("t0"), Some("t1"))]);
        log.begin_turn(session, 4, Some("keep this"));
        log.end_turn(session, vec![edit("a.txt", Some("t1"), Some("t2"))]);

        // Compaction summarized turn 1 away and kept turn 2's prompt.
        let compacted = vec![
            message(Role::System, "system"),
            message(Role::User, "[Conversation summary]\nold task done"),
            message(Role::User, "keep this"),
            message(Role::Assistant, "done"),
        ];
        log.compacted(session, &compacted);

        // A point inside the summary is refused before anything changes.
        assert!(log.rewind(session, 1, root).is_err());
        assert_eq!(read(&dir, "a.txt").as_deref(), Some("t2"));
        // Back to before the retained prompt (now at index 2): turn 2 only.
        assert_eq!(log.rewind(session, 2, root).unwrap(), 1);
        assert_eq!(read(&dir, "a.txt").as_deref(), Some("t1"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rollback_to_turn_is_atomic_and_preserves_earlier_turns() {
        let dir = project("rollback-turn");
        let root = dir.to_str().unwrap();
        let session = SessionId::new();
        std::fs::write(dir.join("a.txt"), "t3").unwrap();
        std::fs::write(dir.join("b.txt"), "b2").unwrap();
        let mut log = EditLog::default();
        log.begin_turn(session, 1, None);
        log.end_turn(session, vec![edit("a.txt", Some("t0"), Some("t1"))]);
        log.begin_turn(session, 3, None);
        log.end_turn(session, vec![edit("a.txt", Some("t1"), Some("t2"))]);
        log.begin_turn(session, 5, None);
        log.end_turn(
            session,
            vec![
                edit("a.txt", Some("t2"), Some("t3")),
                edit("b.txt", None, Some("b2")),
            ],
        );

        let paths = log.rollback_to_turn(session, 2, root).unwrap();
        assert_eq!(paths.len(), 2);
        assert_eq!(read(&dir, "a.txt").as_deref(), Some("t1"));
        assert_eq!(read(&dir, "b.txt"), None);
        assert_eq!(log.checkpoints(session).as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
