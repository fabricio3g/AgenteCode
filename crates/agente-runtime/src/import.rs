//! One-time move of the TUI's own saved sessions (`~/.agente/sessions`,
//! `agente_core::session`) into the runtime's store, so every client lists and
//! resumes the same sessions. Idempotent: a session already in the store is
//! left alone, so running it on every start is cheap and safe.

use agente_protocol::{SessionId, SessionInfo, SessionSnapshot};
use agente_session::{SessionMeta, SessionStore};

/// Client key the TUI's view state is kept under in [`SessionMeta::clients`].
pub const TUI_CLIENT: &str = "tui";

/// What an import did, for the log.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ImportReport {
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// Copy every legacy TUI session the store does not have yet.
pub fn import_legacy_sessions(store: &SessionStore) -> ImportReport {
    let mut report = ImportReport::default();
    let existing: std::collections::HashSet<SessionId> = store
        .list_sessions()
        .unwrap_or_default()
        .into_iter()
        .collect();
    for legacy in agente_core::session::list_sessions() {
        let session_id = SessionId::from_uuid(legacy.session_id);
        if existing.contains(&session_id) {
            report.skipped += 1;
            continue;
        }
        match import_one(store, session_id) {
            Ok(()) => report.imported += 1,
            Err(error) => {
                tracing::warn!(session = %session_id, %error, "legacy session not imported");
                report.failed += 1;
            }
        }
    }
    report
}

fn import_one(store: &SessionStore, session_id: SessionId) -> anyhow::Result<()> {
    let data = agente_core::session::load_session(&session_id.as_uuid())?;
    let meta = &data.meta;
    let snapshot = SessionSnapshot {
        session_id,
        revision: 1,
        conversation: data.conversation.clone(),
    };
    store.write_snapshot(&snapshot, snapshot.revision)?;
    let first_prompt = if meta.first_prompt.is_empty() {
        agente_core::session::first_user_prompt(&data.chat_history)
    } else {
        meta.first_prompt.clone()
    };
    let mut clients = std::collections::BTreeMap::new();
    clients.insert(
        TUI_CLIENT.to_string(),
        serde_json::json!({
            "chat_history": data.chat_history,
            "file_versions": data.file_versions,
            "modified_files": data.modified_files,
        }),
    );
    store.write_meta(&SessionMeta {
        info: SessionInfo {
            session_id,
            title: meta.title.clone(),
            first_prompt,
            project_dir: meta.project_dir.clone(),
            created_at: meta.created_at,
            last_active: meta.last_active,
            message_count: meta.message_count,
            provider: meta.provider.clone(),
            model: meta.model.clone(),
            thinking_level: meta.thinking_level.clone(),
            profile: None,
            instance_id: None,
            driver_kind: None,
            external_session_id: None,
            worktree: None,
        },
        clients,
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_sessions_are_imported_once_with_the_tui_view() {
        let base = std::env::temp_dir().join(format!("agente-import-{}", std::process::id()));
        let legacy = base.join("legacy");
        std::fs::create_dir_all(&legacy).unwrap();
        // Only this test touches the legacy location.
        std::env::set_var("AGENTE_SESSIONS_DIR", &legacy);

        let id = SessionId::new().as_uuid();
        agente_core::session::save_session(&agente_core::session::SessionState {
            session_id: id,
            title: "Fix the parser".into(),
            project_dir: "/work/app".into(),
            created_at: chrono::Utc::now(),
            chat_history: Vec::new(),
            conversation: vec![agente_protocol::Message::user("why does parsing fail?")],
            file_versions: Default::default(),
            modified_files: Vec::new(),
            current_provider: "openrouter".into(),
            current_model: "some/model".into(),
            thinking_level: "off".into(),
        })
        .unwrap();

        let store = SessionStore::open(base.join("store")).unwrap();
        let report = import_legacy_sessions(&store);
        assert_eq!(
            report,
            ImportReport {
                imported: 1,
                skipped: 0,
                failed: 0
            }
        );

        let session_id = SessionId::from_uuid(id);
        let meta = store.read_meta(session_id).unwrap().expect("meta written");
        assert_eq!(meta.info.title, "Fix the parser");
        assert_eq!(meta.info.project_dir, "/work/app");
        assert_eq!(meta.info.model, "some/model");
        assert!(meta.clients.contains_key(TUI_CLIENT));
        let recovered = store.recover(session_id).unwrap();
        assert_eq!(recovered.snapshot.conversation.len(), 1);

        let again = import_legacy_sessions(&store);
        assert_eq!(
            again,
            ImportReport {
                imported: 0,
                skipped: 1,
                failed: 0
            }
        );
        let _ = std::fs::remove_dir_all(base);
    }
}
