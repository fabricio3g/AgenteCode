//! Serialized background session persistence.

use std::collections::HashMap;
use std::sync::mpsc;
use std::time::Duration;

use agente_core::session::{self, SessionState};
use uuid::Uuid;

enum PersistenceCommand {
    // Boxed: `SessionState` dwarfs the other variants, and every queued
    // Delete/Flush/Shutdown would otherwise be padded out to its size.
    Save(Box<SessionState>),
    UpdateTitle(Uuid, String),
    Delete(Uuid),
    Flush(mpsc::Sender<()>),
    Shutdown,
}

enum PendingOperation {
    Save(Box<SessionState>),
    UpdateTitle(String),
    Delete,
}

pub(super) struct PersistenceWorker {
    sender: mpsc::Sender<PersistenceCommand>,
    handle: Option<std::thread::JoinHandle<()>>,
    disabled: bool,
}

impl PersistenceWorker {
    pub(super) fn start() -> Self {
        let (sender, receiver) = mpsc::channel();
        let handle = std::thread::spawn(move || run_worker(receiver));
        Self {
            sender,
            handle: Some(handle),
            disabled: false,
        }
    }

    #[cfg(test)]
    pub(super) fn disabled() -> Self {
        let (sender, receiver) = mpsc::channel();
        drop(receiver);
        Self {
            sender,
            handle: None,
            disabled: true,
        }
    }

    pub(super) fn save(&self, state: SessionState) {
        if self.disabled {
            return;
        }
        let _ = self.sender.send(PersistenceCommand::Save(Box::new(state)));
    }

    pub(super) fn update_title(&self, session_id: Uuid, title: String) {
        if self.disabled {
            return;
        }
        let _ = self
            .sender
            .send(PersistenceCommand::UpdateTitle(session_id, title));
    }

    pub(super) fn delete(&self, session_id: Uuid) {
        if self.disabled {
            return;
        }
        let _ = self.sender.send(PersistenceCommand::Delete(session_id));
    }

    pub(super) fn flush(&self, timeout: Duration) -> bool {
        if self.disabled {
            return true;
        }
        let (sender, receiver) = mpsc::channel();
        if self.sender.send(PersistenceCommand::Flush(sender)).is_err() {
            return false;
        }
        receiver.recv_timeout(timeout).is_ok()
    }

    pub(super) fn shutdown(&mut self) {
        if self.disabled {
            return;
        }
        let _ = self.sender.send(PersistenceCommand::Shutdown);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn run_worker(receiver: mpsc::Receiver<PersistenceCommand>) {
    let mut pending = HashMap::<Uuid, PendingOperation>::new();
    while let Ok(command) = receiver.recv() {
        let mut flush_waiters = Vec::new();
        let mut shutdown = false;
        collect_command(command, &mut pending, &mut flush_waiters, &mut shutdown);
        while let Ok(command) = receiver.try_recv() {
            collect_command(command, &mut pending, &mut flush_waiters, &mut shutdown);
        }

        for (session_id, operation) in pending.drain() {
            let result = match operation {
                PendingOperation::Save(state) => session::save_session(&state),
                PendingOperation::UpdateTitle(title) => {
                    session::update_session_title(&session_id, &title)
                }
                PendingOperation::Delete => session::delete_session(&session_id),
            };
            if let Err(error) = result {
                tracing::warn!(error = %error, session_id = %session_id, "Failed to apply session persistence operation");
            }
        }
        for waiter in flush_waiters {
            let _ = waiter.send(());
        }
        if shutdown {
            break;
        }
    }
}

fn collect_command(
    command: PersistenceCommand,
    pending: &mut HashMap<Uuid, PendingOperation>,
    flush_waiters: &mut Vec<mpsc::Sender<()>>,
    shutdown: &mut bool,
) {
    match command {
        PersistenceCommand::Save(state) => {
            pending.insert(state.session_id, PendingOperation::Save(state));
        }
        PersistenceCommand::UpdateTitle(session_id, title) => {
            match pending.get_mut(&session_id) {
                // A queued full snapshot absorbs the title so the write
                // carries it directly.
                Some(PendingOperation::Save(state)) => {
                    state.title = title;
                }
                // A delete wins over a late title — never resurrect sessions.
                Some(PendingOperation::Delete) => {}
                _ => {
                    pending.insert(session_id, PendingOperation::UpdateTitle(title));
                }
            }
        }
        PersistenceCommand::Delete(session_id) => {
            pending.insert(session_id, PendingOperation::Delete);
        }
        PersistenceCommand::Flush(waiter) => flush_waiters.push(waiter),
        PersistenceCommand::Shutdown => *shutdown = true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesces_latest_snapshot_per_session() {
        let id = Uuid::new_v4();
        let mut pending = HashMap::new();
        let mut waiters = Vec::new();
        let mut shutdown = false;
        let state = |title: &str| SessionState {
            session_id: id,
            title: title.into(),
            project_dir: String::new(),
            created_at: chrono::Utc::now(),
            chat_history: Vec::new(),
            conversation: Vec::new(),
            file_versions: HashMap::new(),
            modified_files: Vec::new(),
            current_provider: String::new(),
            current_model: String::new(),
            thinking_level: String::new(),
        };
        collect_command(
            PersistenceCommand::Save(Box::new(state("old"))),
            &mut pending,
            &mut waiters,
            &mut shutdown,
        );
        collect_command(
            PersistenceCommand::Save(Box::new(state("new"))),
            &mut pending,
            &mut waiters,
            &mut shutdown,
        );
        assert_eq!(pending.len(), 1);
        let Some(PendingOperation::Save(state)) = pending.get(&id) else {
            panic!("latest operation should be a save");
        };
        assert_eq!(state.title, "new");

        collect_command(
            PersistenceCommand::Delete(id),
            &mut pending,
            &mut waiters,
            &mut shutdown,
        );
        assert!(matches!(pending.get(&id), Some(PendingOperation::Delete)));
    }
}
