//! Non-blocking session-title generation and result routing.

use agente_core::types::Role;

use super::App;

const MAX_TITLE_EVENTS_PER_TICK: usize = 16;

pub(super) struct SessionTitleResult {
    pub session_id: uuid::Uuid,
    pub result: Result<String, String>,
}

impl App {
    /// Start at most one title request for an untitled session in this process.
    /// The normal chat task has already reached `Done`, so this request never
    /// delays the answer or shares its event/state lifecycle.
    pub(super) fn maybe_spawn_session_title(&mut self) {
        let session_id = self.state.session.session_id;
        if !self.state.session.title.trim().is_empty()
            || self.title_requests_started.contains(&session_id)
        {
            return;
        }

        let user_text = self
            .state
            .session
            .chat_history
            .iter()
            .find(|entry| entry.role == Role::User && !entry.content.trim().is_empty())
            .map(|entry| entry.content.clone());
        let assistant_text = self
            .state
            .session
            .chat_history
            .iter()
            .find(|entry| entry.role == Role::Assistant && !entry.content.trim().is_empty())
            .map(|entry| entry.content.clone());
        let (Some(user_text), Some(assistant_text)) = (user_text, assistant_text) else {
            return;
        };

        let provider_id = self.state.config.current_provider.clone();
        let model_id = self.state.config.current_model.clone();
        let Some(provider) = self.state.config.provider_registry.get(&provider_id) else {
            return;
        };
        let Some(model) = self.state.config.resolve_model(&provider_id, &model_id) else {
            return;
        };

        self.title_requests_started.insert(session_id);
        let sender = self.session_title_tx.clone();
        self.runtime.spawn(async move {
            let result = agente_core::providers::generate_session_title(
                provider,
                model,
                &user_text,
                &assistant_text,
                agente_core::providers::RequestContext::new(session_id),
            )
            .await
            .map_err(|error| error.to_string());
            let _ = sender.send(SessionTitleResult { session_id, result });
        });
    }

    /// Drain title results separately from agent events. Results are keyed by
    /// UUID so replacing the session while the model works is safe: stale
    /// titles update the saved session on disk, never the new live session.
    pub(super) fn process_session_title_results(&mut self) -> bool {
        let mut processed = 0;
        while processed < MAX_TITLE_EVENTS_PER_TICK {
            let Ok(event) = self.session_title_rx.try_recv() else {
                break;
            };
            processed += 1;
            match event.result {
                Ok(title) => {
                    if self
                        .state
                        .apply_session_title(event.session_id, title.clone())
                    {
                        self.queue_all_session_snapshots();
                    } else if !self.apply_title_to_background_tab(event.session_id, &title) {
                        self.persistence
                            .update_title(event.session_id, title.clone());
                    }
                    if let Some(meta) = self
                        .state
                        .ui
                        .recent_sessions
                        .iter_mut()
                        .find(|meta| meta.session_id == event.session_id)
                    {
                        meta.title = title.clone();
                    }
                    if let Some(meta) = self
                        .state
                        .picker
                        .sessions
                        .iter_mut()
                        .find(|meta| meta.session_id == event.session_id)
                    {
                        meta.title = title;
                    }
                    self.state.ui.needs_render = true;
                }
                Err(error) => {
                    tracing::debug!(
                        error = %error,
                        session_id = %event.session_id,
                        "Session title generation failed"
                    );
                }
            }
        }
        processed == MAX_TITLE_EVENTS_PER_TICK
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;

    #[test]
    fn stale_title_result_leaves_the_active_session_alone() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut app = App::new_for_test(
            AppConfig::default(),
            "/tmp/session-title".to_string(),
            runtime,
        )
        .unwrap();

        let first_id = app.state.session.session_id;
        app.state.reset_for_new_session();
        app.session_title_tx
            .send(SessionTitleResult {
                session_id: first_id,
                result: Ok("Improve Session Navigation".to_string()),
            })
            .unwrap();

        assert!(!app.process_session_title_results());
        assert!(app.state.session.title.is_empty());
    }
}
