//! Shared test setup.

/// Point user config and sessions at a per-process temp folder and hide
/// provider keys from the environment, so tests never read (or write) the
/// developer's `~/.agente`, never see a provider as connected because a key
/// happens to be exported, and render the same on every machine. Called by
/// `AppState::new` under test.
pub(crate) fn sandbox_user_state() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let root = std::env::temp_dir().join(format!("agente-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(root.join("sessions"));
        std::env::set_var("AGENTE_CONFIG_DIR", &root);
        std::env::set_var("AGENTE_SESSIONS_DIR", root.join("sessions"));
        for (name, _) in std::env::vars() {
            if name.ends_with("_API_KEY") || name.ends_with("_BASE_URL") {
                std::env::remove_var(name);
            }
        }
    });
}
