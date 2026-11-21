//! Model discovery and catalog refresh event handling.

use agente_core::agent::AgentEvent;

use crate::app::App;

impl App {
    pub(super) fn apply_discovery_event(&mut self, event: AgentEvent) {
        match event {
            AgentEvent::ModelCatalogUpdated { result } => match result {
                Ok(catalog) => {
                    self.state.config.update_model_catalog(&catalog);
                    self.state.clamp_thinking_level_for_current_model();
                    if self.state.input.show_thinking_selector {
                        self.open_thinking_selector();
                    }
                    self.state.ui.show_toast("Model metadata refreshed");
                }
                Err(error) => {
                    self.state.config.catalog_refresh_status =
                        crate::state::DiscoveryStatus::Failed(error.clone());
                    self.state.ui.show_toast(error);
                }
            },
            AgentEvent::ModelsDiscovered { provider, models } => {
                if !self.state.config.is_provider_connected(&provider) {
                    return;
                }
                tracing::info!(
                    provider = %provider,
                    model_count = models.len(),
                    "Models discovered"
                );
                self.state.set_discovered_models(&provider, models.clone());
                self.state.input.model_selector_selected = 0;
                self.state.clamp_thinking_level_for_current_model();
                self.state.ui.show_toast(format!(
                    "{}: {} models refreshed",
                    provider,
                    models.len()
                ));
                if self.state.config.current_provider.is_empty() {
                    self.state.config.current_provider = provider.clone();
                }
                let pending =
                    self.state.config.pending_after_connect.as_deref() == Some(provider.as_str());
                if pending {
                    self.state.config.pending_after_connect = None;
                }
                if pending || self.state.config.current_model.is_empty() {
                    self.refresh_model_selection_after_discovery(&provider);
                }
                self.state.persist_config();
            }
            AgentEvent::ModelDiscoveryFailed { provider, error } => {
                if !self.state.config.is_provider_connected(&provider) {
                    return;
                }
                self.state.set_discovery_failed(&provider, error.clone());
                self.state.ui.show_toast(format!("{provider}: {error}"));
                let pending =
                    self.state.config.pending_after_connect.as_deref() == Some(provider.as_str());
                if pending {
                    self.state.config.pending_after_connect = None;
                    let auth_fail = {
                        let lower = error.to_lowercase();
                        lower.contains("401")
                            || lower.contains("403")
                            || lower.contains("unauthorized")
                            || lower.contains("api key")
                            || lower.contains("authentication")
                    };
                    if auth_fail {
                        self.state.disconnect_provider(&provider, false);
                    }
                    self.state
                        .open_enter_key(&provider, String::new(), true, error);
                }
                if self.state.config.current_provider.is_empty() {
                    self.state.config.current_provider = provider.clone();
                }
            }
            _ => {}
        }
    }

    pub(in crate::app) fn refresh_model_selection_after_discovery(&mut self, provider: &str) {
        let entries = self.state.get_models_for_provider(provider);
        if entries.is_empty() {
            return;
        }

        if entries.len() == 1 {
            self.state.config.current_provider = entries[0].provider.clone();
            self.state.config.current_model = entries[0].model_id.clone();
            self.state.clamp_thinking_level_for_current_model();
            self.state.input.show_model_selector = false;
            self.state.persist_config();
            return;
        }

        if !self.state.config.current_model.is_empty()
            && self.state.config.current_provider == provider
            && entries
                .iter()
                .any(|e| e.model_id == self.state.config.current_model)
        {
            return;
        }

        self.state.input.model_selector_provider = Some(provider.to_string());
        self.state.input.model_selector_query.clear();
        self.state.input.show_model_selector = true;
        self.state.input.model_selector_selected = 0;
    }
}
