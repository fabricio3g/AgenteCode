//! Background model-discovery task.

use std::sync::mpsc::Sender;
use std::sync::Arc;

use crate::providers::ProviderRegistry;

use super::config::send_event;
use super::errors::sanitize_discovery_error;
use crate::agent::events::{AgentEvent, AgentTaskEvent};

pub fn spawn_discovery_task(
    sender: Sender<AgentTaskEvent>,
    provider_id: String,
    registry: Arc<ProviderRegistry>,
) {
    let task_id = 0u64;
    let provider = match registry.get(&provider_id) {
        Some(p) => p.clone(),
        None => {
            send_event(
                &sender,
                task_id,
                AgentEvent::ModelDiscoveryFailed {
                    provider: provider_id,
                    error: "Unknown provider".into(),
                },
            );
            return;
        }
    };
    tracing::info!(provider = %provider_id, "Spawning model discovery task");
    tokio::spawn(async move {
        /// Bound discovery so a hung models endpoint cannot leave the UI in
        /// "discovering…" forever (same order of magnitude as title gen).
        const DISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
        let started = std::time::Instant::now();
        let result = tokio::time::timeout(DISCOVERY_TIMEOUT, provider.list_models()).await;
        match result {
            Ok(Ok(models)) => {
                tracing::info!(provider = %provider_id, count = models.len(), elapsed_ms = started.elapsed().as_millis(), "Models discovered");
                send_event(
                    &sender,
                    task_id,
                    AgentEvent::ModelsDiscovered {
                        provider: provider_id,
                        models,
                    },
                );
            }
            Ok(Err(e)) => {
                tracing::error!(provider = %provider_id, elapsed_ms = started.elapsed().as_millis(), error = %e, "Model discovery failed");
                send_event(
                    &sender,
                    task_id,
                    AgentEvent::ModelDiscoveryFailed {
                        provider: provider_id,
                        error: sanitize_discovery_error(&e.to_string()),
                    },
                );
            }
            Err(_elapsed) => {
                tracing::error!(provider = %provider_id, elapsed_ms = started.elapsed().as_millis(), "Model discovery timed out");
                send_event(&sender, task_id, AgentEvent::ModelDiscoveryFailed {
                    provider: provider_id,
                    error: "Model discovery timed out. Check the network or API key, then retry /provider."
                        .into(),
                });
            }
        }
    });
}
