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

use agente_protocol::SessionId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileEdit {
    pub path: String,
    /// `None`: the file did not exist.
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone)]
struct Batch {
    edits: Vec<FileEdit>,
    /// Conversation length when the turn started (its user message included).
    conversation_len: usize,
}

#[derive(Debug, Default)]
struct History {
    undo: Vec<Batch>,
    redo: Vec<Batch>,
    /// Set when a turn starts; the batch is recorded when it ends.
    pending_start: Option<usize>,
}

#[derive(Debug, Default)]
pub(crate) struct EditLog {
    sessions: HashMap<SessionId, History>,
}

impl EditLog {
    pub fn begin_turn(&mut self, session_id: SessionId, conversation_len: usize) {
        self.sessions.entry(session_id).or_default().pending_start = Some(conversation_len);
    }

    /// Record a finished turn's edits as one batch. A new batch ends any
    /// redo chain, like typing after an undo in an editor.
    pub fn end_turn(&mut self, session_id: SessionId, edits: Vec<FileEdit>) {
        let history = self.sessions.entry(session_id).or_default();
        let start = history.pending_start.take().unwrap_or(0);
        let edits = merge(edits);
        if edits.is_empty() {
            return;
        }
        history.redo.clear();
        history.undo.push(Batch {
            edits,
            conversation_len: start,
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
        let mut undone = 0;
        while history
            .undo
            .last()
            .is_some_and(|batch| batch.conversation_len > conversation_index)
        {
            let batch = history.undo.pop().expect("checked above");
            if let Err(error) = apply(&batch.edits, project_dir, Side::Before) {
                history.undo.push(batch);
                return Err(format!(
                    "Reverted {undone} turn(s) of edits, then stopped: {error}"
                ));
            }
            undone += 1;
        }
        // Rewound turns are gone from the conversation: nothing to redo.
        history.redo.clear();
        Ok(undone)
    }

    pub fn forget(&mut self, session_id: SessionId) {
        self.sessions.remove(&session_id);
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

#[derive(Clone, Copy)]
enum Side {
    Before,
    After,
}

/// Put every file on `side`. Checks all files first, so a conflict changes
/// nothing.
fn apply(edits: &[FileEdit], project_dir: &str, side: Side) -> Result<Vec<String>, String> {
    for edit in edits {
        let current = std::fs::read_to_string(Path::new(project_dir).join(&edit.path)).ok();
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
        log.begin_turn(session, 2);
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
        log.begin_turn(session, 2);
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
            log.begin_turn(session, start);
            log.end_turn(session, vec![edit("a.txt", Some(before), Some(after))]);
        }

        // Back to before the user message at index 4: the turns that started
        // at 5 and 8 are undone, the first one stays.
        assert_eq!(log.rewind(session, 4, root).unwrap(), 2);
        assert_eq!(read(&dir, "a.txt").as_deref(), Some("t1"));
        assert_eq!(log.redo(session, root).unwrap_err(), "Nothing to redo");
        let _ = std::fs::remove_dir_all(dir);
    }
}
