//! Session persistence, metadata, context lookups, compaction, and edit history.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agente_core::agent::UserInbox;
use agente_core::permissions::{shared_permission_engine_with_config, SharedPermissionEngine};
use agente_core::AbortController;
use agente_protocol::{
    Message, Role, RuntimeEvent, SessionId, SessionInfo, SessionSnapshot, Trust, TurnId,
};
use agente_session::SessionMeta;
use chrono::Utc;
use tokio::sync::mpsc;

use crate::turns::{TurnControl, TurnGuard};
use crate::{bridge, edits, RuntimeError, RuntimeHandle, RuntimeInner};

#[derive(Clone)]
pub(crate) struct SessionContext {
    pub(crate) project_dir: String,
    pub(crate) engine: SharedPermissionEngine,
}

pub(crate) fn new_info(session_id: SessionId, project_dir: &str) -> SessionInfo {
    let now = Utc::now();
    SessionInfo {
        session_id,
        title: String::new(),
        first_prompt: String::new(),
        project_dir: project_dir.to_string(),
        created_at: now,
        last_active: now,
        message_count: 0,
        provider: String::new(),
        model: String::new(),
        thinking_level: String::new(),
        profile: None,
    }
}

/// The first thing the user asked, flattened and trimmed to a list label.
/// Injected reminders (project instructions) are not the user's words.
pub(crate) fn first_prompt(conversation: &[Message]) -> String {
    const MAX_CHARS: usize = 60;
    let Some(message) = conversation.iter().find(|m| {
        m.role == Role::User
            && !m.content.trim().is_empty()
            && !m
                .content
                .contains(agente_core::context::PROJECT_REMINDER_MARKER)
    }) else {
        return String::new();
    };
    let flat = message
        .content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.chars().count() <= MAX_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(MAX_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

/// User and assistant messages: what a person would count as the chat.
pub(crate) fn chat_message_count(conversation: &[Message]) -> usize {
    conversation
        .iter()
        .filter(|m| matches!(m.role, Role::User | Role::Assistant))
        .count()
}

pub(crate) fn empty_snapshot(session_id: SessionId) -> SessionSnapshot {
    SessionSnapshot {
        session_id,
        revision: 0,
        conversation: Vec::new(),
    }
}

impl RuntimeInner {
    /// The session's project and permission engine, set up on first use.
    /// The runtime's own project keeps the shared engine; another project
    /// gets its own, so its approvals and mode never leak across projects.
    pub(crate) fn session_context(
        &self,
        session_id: SessionId,
        project_dir: Option<&str>,
    ) -> SessionContext {
        {
            let contexts = self
                .contexts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(context) = contexts.get(&session_id) {
                if project_dir.is_none() || project_dir == Some(context.project_dir.as_str()) {
                    return context.clone();
                }
            }
        }
        let saved_meta = self
            .config
            .session_store
            .as_ref()
            .and_then(|store| store.read_meta(session_id).ok().flatten());
        let saved_project = saved_meta
            .as_ref()
            .map(|meta| meta.info.project_dir.as_str())
            .filter(|dir| !dir.is_empty());
        let wanted = project_dir
            .or(saved_project)
            .unwrap_or(&self.config.project_dir);
        if let Some(history) = saved_meta
            .as_ref()
            .and_then(|meta| meta.clients.get("runtime_edits"))
        {
            self.lock_edits().restore(session_id, history.clone());
        }
        // Each session has its own engine: its mode, auto-approve and
        // approve-all grants never leak into another session.
        let engine = shared_permission_engine_with_config(
            self.config.mode,
            &self.config.auto_approve,
            wanted,
        );
        let context = SessionContext {
            project_dir: wanted.to_string(),
            engine,
        };
        let mut contexts = self
            .contexts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = contexts.get(&session_id) {
            if project_dir.is_none() || existing.project_dir == wanted {
                return existing.clone();
            }
        }
        contexts.insert(session_id, context.clone());
        context
    }

    /// Update the session's saved list entry (creating it on first use).
    /// Failures are logged: metadata never fails a turn.
    pub(crate) fn update_meta(
        &self,
        session_id: SessionId,
        project_dir: &str,
        change: impl FnOnce(&mut SessionInfo),
    ) {
        if self.config.session_store.is_none() {
            return;
        }
        let commit_lock = self.commit_lock(session_id);
        let _commit = commit_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.update_meta_locked(session_id, project_dir, change);
    }

    pub(crate) fn update_meta_locked(
        &self,
        session_id: SessionId,
        project_dir: &str,
        change: impl FnOnce(&mut SessionInfo),
    ) {
        let Some(store) = self.config.session_store.as_ref() else {
            return;
        };
        let mut meta = match store.read_meta(session_id) {
            Ok(Some(meta)) => meta,
            Ok(None) => SessionMeta {
                info: new_info(session_id, project_dir),
                clients: Default::default(),
            },
            Err(error) => {
                tracing::warn!(session = %session_id, %error, "session metadata unreadable; not updated");
                return;
            }
        };
        change(&mut meta.info);
        if let Err(error) = store.write_meta(&meta) {
            tracing::warn!(session = %session_id, %error, "session metadata not saved");
        }
    }

    /// In-memory snapshot for `session_id`, falling back to a durable recovery
    /// through the configured store on a cache miss. Recovered sessions with
    /// durable content are cached back into the in-memory map so subsequent
    /// commits keep the revision counter monotonic across restarts.
    pub(crate) fn lookup_session(&self, session_id: SessionId) -> SessionSnapshot {
        if let Some(snapshot) = self.read_sessions().get(&session_id) {
            return snapshot.clone();
        }
        let Some(store) = self.config.session_store.as_ref() else {
            return empty_snapshot(session_id);
        };
        match store.recover(session_id) {
            Ok(recovered) => {
                let snapshot = recovered.snapshot;
                // Cache only sessions with durable content: a bare miss must
                // keep returning an empty, uncached snapshot (previous
                // behavior for unknown ids).
                if !snapshot.conversation.is_empty() || snapshot.revision > 0 {
                    self.write_sessions().insert(session_id, snapshot.clone());
                }
                snapshot
            }
            Err(error) => {
                tracing::warn!(
                    session = %session_id,
                    %error,
                    "session recovery failed; treating as empty"
                );
                empty_snapshot(session_id)
            }
        }
    }

    /// Write a session snapshot through the configured store. Persistence
    /// failures never propagate: the in-memory session remains authoritative
    /// and the next commit retries. A no-op without a configured store.
    pub(crate) fn commit_lock(&self, session_id: SessionId) -> Arc<Mutex<()>> {
        self.commit_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(session_id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub(crate) fn persist_edits(&self, session_id: SessionId) {
        let Some(store) = &self.config.session_store else {
            return;
        };
        let commit_lock = self.commit_lock(session_id);
        let _commit = commit_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let value = self.lock_edits().snapshot(session_id);
        let Ok(Some(mut meta)) = store.read_meta(session_id) else {
            return;
        };
        if meta.clients.get("runtime_edits") == Some(&value) {
            return;
        }
        meta.clients.insert("runtime_edits".into(), value);
        if let Err(error) = store.write_meta(&meta) {
            tracing::warn!(%session_id, %error, "session edit history persistence failed");
        }
    }

    pub(crate) fn persist_snapshot(&self, snapshot: &SessionSnapshot) {
        let Some(store) = self.config.session_store.as_ref() else {
            return;
        };
        // The snapshot's revision doubles as the store sequence: revisions are
        // per-session, monotonic, and survive restarts via recovery, so a newer
        // snapshot can never strand future log events behind a stale sequence.
        if let Err(error) = store.write_snapshot(snapshot, snapshot.revision) {
            tracing::warn!(
                session = %snapshot.session_id,
                revision = snapshot.revision,
                %error,
                "session snapshot persistence failed; continuing from memory"
            );
        }
    }
}

impl RuntimeHandle {
    /// Every session this runtime knows: in memory, and saved in its store.
    pub fn list_sessions(&self) -> Vec<SessionId> {
        let mut ids: Vec<SessionId> = self.inner.read_sessions().keys().copied().collect();
        if let Some(store) = &self.inner.config.session_store {
            match store.list_sessions() {
                Ok(saved) => ids.extend(saved),
                Err(error) => tracing::warn!(%error, "listing saved sessions failed"),
            }
        }
        ids.sort_by_key(|id| id.as_uuid());
        ids.dedup();
        ids
    }

    /// Saved sessions' list entries, most recently active first.
    pub fn session_infos(&self) -> Vec<SessionInfo> {
        let Some(store) = &self.inner.config.session_store else {
            return Vec::new();
        };
        store.list_infos().unwrap_or_else(|error| {
            tracing::warn!(%error, "listing session infos failed");
            Vec::new()
        })
    }

    /// A saved session's list entry and what each client keeps about it.
    pub fn session_meta(&self, session_id: SessionId) -> Option<SessionMeta> {
        self.inner
            .config
            .session_store
            .as_ref()?
            .read_meta(session_id)
            .ok()
            .flatten()
    }

    /// Save what one client keeps about a session (its view of it), and
    /// optionally a new title. Needs a store.
    pub fn save_client_state(
        &self,
        session_id: SessionId,
        client: &str,
        state: serde_json::Value,
        title: Option<String>,
    ) -> Result<(), RuntimeError> {
        let store = self
            .inner
            .config
            .session_store
            .as_ref()
            .ok_or_else(|| RuntimeError::Store("persistence is off".into()))?;
        let commit_lock = self.inner.commit_lock(session_id);
        let _commit = commit_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut meta = store
            .read_meta(session_id)
            .map_err(|error| RuntimeError::Store(error.to_string()))?
            .unwrap_or_else(|| SessionMeta {
                info: new_info(session_id, &self.inner.config.project_dir),
                clients: Default::default(),
            });
        meta.clients.insert(client.to_string(), state);
        if let Some(title) = title {
            meta.info.title = title;
        }
        store
            .write_meta(&meta)
            .map_err(|error| RuntimeError::Store(error.to_string()))
    }

    /// Forget a session, in memory and on disk. Refused while a turn runs.
    pub fn delete_session(&self, session_id: SessionId) -> Result<bool, RuntimeError> {
        if self.is_busy(session_id) {
            return Err(RuntimeError::SessionBusy(session_id));
        }
        let mut existed = self.inner.write_sessions().remove(&session_id).is_some();
        self.inner.lock_edits().forget(session_id);
        self.inner
            .contexts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&session_id);
        self.inner
            .commit_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&session_id);
        self.inner
            .context_gaps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&session_id);
        if let Some(store) = &self.inner.config.session_store {
            existed |= store
                .delete(session_id)
                .map_err(|error| RuntimeError::Store(error.to_string()))?;
            let store_board = store
                .root()
                .join("boards")
                .join(format!("{session_id}.json"));
            if std::fs::remove_file(store_board).is_ok() {
                existed = true;
            }
        }
        let user_sessions = std::env::var_os("AGENTE_SESSIONS_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .map(|home| PathBuf::from(home).join(".agente").join("sessions"))
            });
        if let Some(sessions_dir) = user_sessions {
            let board_path = sessions_dir
                .join("boards")
                .join(format!("{session_id}.json"));
            if std::fs::remove_file(board_path).is_ok() {
                existed = true;
            }
        }
        let _ = agente_core::goal::GoalStore::user().clear(session_id.as_uuid());
        agente_core::tools::atomic_fs::forget_session_reads(session_id.as_uuid());
        Ok(existed)
    }

    /// Shrink the session's conversation now (trimming older turns, keeping
    /// recent ones), like the automatic compaction between model calls.
    /// Refused while a turn runs. Returns the new snapshot.
    fn reserve_compaction(
        &self,
        session_id: SessionId,
    ) -> Result<(TurnGuard, agente_core::cancellation::AbortSignal), RuntimeError> {
        let mut turns = self.inner.lock_turns();
        if turns
            .values()
            .any(|control| control.session_id == session_id)
        {
            return Err(RuntimeError::SessionBusy(session_id));
        }
        let turn_id = TurnId::new();
        let inbox = UserInbox::default();
        inbox.close();
        let (events, _rx) = mpsc::channel(1);
        let cancel = AbortController::new();
        let signal = cancel.signal();
        turns.insert(
            turn_id,
            TurnControl {
                trust: Trust::Owner,
                cancel,
                inbox,
                events,
                session_id,
            },
        );
        Ok((TurnGuard::new(Arc::clone(&self.inner), turn_id), signal))
    }

    pub(crate) fn commit_compaction(
        &self,
        session_id: SessionId,
        messages: Vec<Message>,
        summary: String,
        tokens_before: u32,
        tokens_after: u32,
        smart: bool,
    ) -> SessionSnapshot {
        self.inner.session_context(session_id, None);
        self.inner.lock_edits().compacted(session_id);
        self.inner.persist_edits(session_id);
        let revision = bridge::replace_conversation(&self.inner, session_id, messages);
        self.inner.publish(&self.envelope(
            session_id,
            TurnId::new(),
            None,
            RuntimeEvent::ContextCompacted {
                summary,
                revision,
                tokens_before,
                tokens_after,
                smart,
            },
        ));
        self.inner.lookup_session(session_id)
    }

    pub async fn compact_smart(
        &self,
        session_id: SessionId,
    ) -> Result<(SessionSnapshot, bool, Option<agente_core::llm::Usage>), RuntimeError> {
        let (_reservation, cancel_signal) = self.reserve_compaction(session_id)?;
        let snapshot = self.inner.lookup_session(session_id);
        let meta = self.session_meta(session_id).ok_or_else(|| {
            RuntimeError::Config(
                "Choose a model and start a conversation before smart compaction".into(),
            )
        })?;
        let live = self.inner.live();
        let provider_id = live
            .compaction_model
            .as_ref()
            .map_or(meta.info.provider.as_str(), |chosen| {
                chosen.provider.as_str()
            });
        let model_id = live
            .compaction_model
            .as_ref()
            .map_or(meta.info.model.as_str(), |chosen| chosen.model.as_str());
        let provider = live.provider_registry.get(provider_id).ok_or_else(|| {
            RuntimeError::Config("The conversation provider is unavailable".into())
        })?;
        let mut model = agente_core::providers::resolve_model_info(
            &live.provider_registry,
            live.catalog.as_deref(),
            provider_id,
            model_id,
        );
        model.options = provider.get_request_options(&model);
        let tokens_before = agente_core::context::estimate_message_tokens(&snapshot.conversation);
        let strategy = agente_core::context::CompactionStrategy::manual(
            model.limits.context as usize,
            tokens_before,
        );
        let summarizer = Arc::new(agente_core::providers::ProviderSummarizer::new(
            provider,
            model,
            agente_core::providers::RequestContext::new(session_id.as_uuid()),
        ));
        let compactor = agente_core::context::ContextCompactor::new(strategy)
            .with_summarizer(summarizer.clone());
        let result = tokio::select! {
            res = compactor.compact_async_forced(snapshot.conversation.clone()) => res,
            _ = cancel_signal.wait_aborted() => {
                return Err(RuntimeError::Config("Compaction cancelled".into()));
            }
        };
        let smart = matches!(
            result.summary.metadata.summary_type,
            agente_core::context::SummaryType::Semantic
        );
        let tokens_after = agente_core::context::estimate_message_tokens(&result.messages);
        if tokens_after >= tokens_before {
            return Ok((
                snapshot,
                false,
                if summarizer.attempted() {
                    summarizer.usage()
                } else {
                    Some(agente_core::llm::Usage::default())
                },
            ));
        }
        let updated = self.commit_compaction(
            session_id,
            result.messages,
            result.summary.content,
            tokens_before as u32,
            tokens_after as u32,
            smart,
        );
        Ok((
            updated,
            smart,
            if summarizer.attempted() {
                summarizer.usage()
            } else {
                Some(agente_core::llm::Usage::default())
            },
        ))
    }

    pub fn compact(&self, session_id: SessionId) -> Result<SessionSnapshot, RuntimeError> {
        let (_reservation, _cancel) = self.reserve_compaction(session_id)?;
        let snapshot = self.inner.lookup_session(session_id);
        let before = snapshot.conversation.len();
        let tokens_before =
            agente_core::context::estimate_message_tokens(&snapshot.conversation) as u32;
        // The session's own model decides how much room there is.
        let window = self
            .session_meta(session_id)
            .filter(|meta| !meta.info.provider.is_empty())
            .map(|meta| {
                self.model_info(&meta.info.provider, &meta.info.model)
                    .limits
                    .context
            })
            .unwrap_or(0) as usize;
        let result = agente_core::context::ContextCompactor::new(
            agente_core::context::CompactionStrategy::manual(window, tokens_before as usize),
        )
        .compact_forced(snapshot.conversation);
        if result.messages.len() == before && result.summary.tokens_saved == 0 {
            return Ok(self.inner.lookup_session(session_id));
        }
        let after = result.messages.len();
        let tokens_saved = result.summary.tokens_saved as u32;
        Ok(self.commit_compaction(
            session_id,
            result.messages,
            format!("{} messages compacted", before.saturating_sub(after)),
            tokens_before,
            tokens_before.saturating_sub(tokens_saved),
            false,
        ))
    }

    /// Restore the files the session's last turn changed. Refused while a
    /// turn runs, or when a file changed since (it is never overwritten).
    /// Returns the restored paths.
    pub fn undo(&self, session_id: SessionId) -> Result<Vec<String>, RuntimeError> {
        self.edit_files(session_id, |log, project| log.undo(session_id, project))
    }

    /// Re-apply the edits the last undo took back.
    pub fn redo(&self, session_id: SessionId) -> Result<Vec<String>, RuntimeError> {
        self.edit_files(session_id, |log, project| log.redo(session_id, project))
    }

    /// Atomically restore files back to before `turn_index`, keeping the
    /// conversation transcript intact.
    pub fn rollback_to_turn(
        &self,
        session_id: SessionId,
        turn_index: usize,
    ) -> Result<Vec<String>, RuntimeError> {
        self.edit_files(session_id, |log, project| {
            log.rollback_to_turn(session_id, turn_index, project)
        })
    }

    /// Go back to before `conversation_index` (a user message): undo the file
    /// edits of every turn from there on and drop those messages. Returns how
    /// many turns' edits were reverted.
    pub fn rewind(
        &self,
        session_id: SessionId,
        conversation_index: usize,
    ) -> Result<usize, RuntimeError> {
        if self.is_busy(session_id) {
            return Err(RuntimeError::SessionBusy(session_id));
        }
        if conversation_index > self.inner.lookup_session(session_id).conversation.len() {
            return Err(RuntimeError::Config(
                "conversation index is beyond this session".into(),
            ));
        }
        let project_dir = self.inner.session_context(session_id, None).project_dir;
        let reverted = self
            .inner
            .lock_edits()
            .rewind(session_id, conversation_index, &project_dir)
            .map_err(RuntimeError::Edits)?;
        let mut conversation = self.inner.lookup_session(session_id).conversation;
        conversation.truncate(conversation_index);
        bridge::replace_conversation(&self.inner, session_id, conversation);
        self.inner.persist_edits(session_id);
        Ok(reverted)
    }

    fn edit_files(
        &self,
        session_id: SessionId,
        change: impl FnOnce(&mut edits::EditLog, &str) -> Result<Vec<String>, String>,
    ) -> Result<Vec<String>, RuntimeError> {
        if self.is_busy(session_id) {
            return Err(RuntimeError::SessionBusy(session_id));
        }
        let project_dir = self.inner.session_context(session_id, None).project_dir;
        let paths =
            change(&mut self.inner.lock_edits(), &project_dir).map_err(RuntimeError::Edits)?;
        self.inner.persist_edits(session_id);
        Ok(paths)
    }

    pub fn session_snapshot(&self, session_id: SessionId) -> SessionSnapshot {
        self.inner.lookup_session(session_id)
    }

    /// Bind a client session before its first turn (including direct tools).
    pub fn open_session(
        &self,
        session_id: SessionId,
        project_dir: &str,
    ) -> Result<SessionSnapshot, RuntimeError> {
        if self.is_busy(session_id) {
            return Err(RuntimeError::SessionBusy(session_id));
        }
        if !std::path::Path::new(project_dir).is_dir() {
            return Err(RuntimeError::Config(format!(
                "project folder does not exist: {project_dir}"
            )));
        }
        self.inner.session_context(session_id, Some(project_dir));
        let snapshot = self.session_snapshot(session_id);
        self.inner.update_meta(session_id, project_dir, |info| {
            info.project_dir = project_dir.to_string()
        });
        Ok(snapshot)
    }

    pub fn checkpoints(&self, session_id: SessionId) -> serde_json::Value {
        let project = self
            .session_meta(session_id)
            .map(|meta| meta.info.project_dir);
        self.inner.session_context(session_id, project.as_deref());
        self.inner.lock_edits().checkpoints(session_id)
    }

    pub fn fork_session(&self, source: SessionId) -> SessionSnapshot {
        let source_meta = self.session_meta(source);
        let source = self.session_snapshot(source);
        let project_dir = self
            .inner
            .session_context(source.session_id, None)
            .project_dir;
        let session_id = SessionId::new();
        let snapshot = SessionSnapshot {
            session_id,
            revision: 0,
            conversation: source.conversation,
        };
        let prompt = first_prompt(&snapshot.conversation);
        let count = chat_message_count(&snapshot.conversation);
        self.inner
            .write_sessions()
            .insert(session_id, snapshot.clone());
        self.inner.session_context(session_id, Some(&project_dir));
        self.inner.update_meta(session_id, &project_dir, |info| {
            info.first_prompt = prompt;
            info.message_count = count;
            if let Some(source_info) = source_meta.map(|meta| meta.info) {
                info.provider = source_info.provider;
                info.model = source_info.model;
                info.thinking_level = source_info.thinking_level;
                info.profile = source_info.profile;
            }
        });
        self.inner.persist_snapshot(&snapshot);
        snapshot
    }
}
