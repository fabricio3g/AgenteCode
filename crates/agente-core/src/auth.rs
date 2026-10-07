use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;

/// Auth entry for a provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthEntry {
    #[serde(rename = "api")]
    ApiKey { key: String },
    /// An OAuth grant. `token` alone is enough for a provider that hands out
    /// long-lived tokens; the rest lets a caller renew one that expires
    /// (Google, for instance).
    #[serde(rename = "oauth")]
    OAuth {
        token: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refresh_token: Option<String>,
        /// Unix seconds. Absent = the provider never said when it dies.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expires_at: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
    },
}

/// A stored OAuth grant, with what it takes to renew it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthGrant {
    pub token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    pub scope: Option<String>,
}

impl OAuthGrant {
    /// Whether the token is dead or about to be — one minute of slack so a
    /// call never starts on a token that expires while it is in flight.
    pub fn expired(&self) -> bool {
        self.expires_at
            .is_some_and(|expires_at| expires_at <= now_seconds() + 60)
    }
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// Persistent auth store for API keys and OAuth tokens.
///
/// Stored at the platform's data directory (`%APPDATA%/agente/auth.json` on Windows,
/// `~/.local/share/agente/auth.json` on Linux, `~/Library/Application Support/agente/auth.json`
/// on macOS) with 0o600 permissions on Unix.
/// Kept separate from config so credentials are never accidentally committed.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthStore {
    #[serde(default)]
    entries: HashMap<String, AuthEntry>,
}

impl AuthStore {
    /// Load the auth store from disk, or create an empty one.
    pub fn load() -> Self {
        match Self::path() {
            Some(path) if path.exists() => {
                match fs::read_to_string(&path)
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                {
                    Some(store) => store,
                    None => {
                        tracing::warn!(path = %path.display(), "Failed to parse auth store");
                        Self::default()
                    }
                }
            }
            _ => Self::default(),
        }
    }

    /// Save the auth store to disk.
    pub fn save(&self) -> io::Result<()> {
        let path = Self::path().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "Could not determine home directory",
            )
        })?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(self)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        fs::write(&path, content)?;

        // Restrict permissions: owner read/write only.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&path)?.permissions();
            perms.set_mode(0o600);
            fs::set_permissions(&path, perms)?;
        }

        Ok(())
    }

    /// Get the API key for a provider.
    pub fn get_key(&self, provider: &str) -> Option<String> {
        self.entries.get(provider).and_then(|e| match e {
            AuthEntry::ApiKey { key } if !key.is_empty() => Some(key.clone()),
            AuthEntry::OAuth { token, .. } if !token.is_empty() => Some(token.clone()),
            _ => None,
        })
    }

    /// The stored OAuth grant for a provider, if there is one.
    pub fn oauth(&self, provider: &str) -> Option<OAuthGrant> {
        match self.entries.get(provider) {
            Some(AuthEntry::OAuth {
                token,
                refresh_token,
                expires_at,
                scope,
            }) if !token.is_empty() => Some(OAuthGrant {
                token: token.clone(),
                refresh_token: refresh_token.clone(),
                expires_at: *expires_at,
                scope: scope.clone(),
            }),
            _ => None,
        }
    }

    /// Store an OAuth grant.
    pub fn set_oauth(&mut self, provider: &str, grant: OAuthGrant) {
        self.entries.insert(
            provider.to_string(),
            AuthEntry::OAuth {
                token: grant.token,
                refresh_token: grant.refresh_token,
                expires_at: grant.expires_at,
                scope: grant.scope,
            },
        );
    }

    /// Set (or overwrite) the API key for a provider.
    pub fn set_key(&mut self, provider: &str, key: String) {
        self.entries
            .insert(provider.to_string(), AuthEntry::ApiKey { key });
    }

    /// Remove auth for a provider.
    pub fn remove(&mut self, provider: &str) {
        self.entries.remove(provider);
    }

    /// Check if a provider has stored auth.
    pub fn has(&self, provider: &str) -> bool {
        self.entries.contains_key(provider)
    }

    fn path() -> Option<PathBuf> {
        // `AGENTE_CONFIG_DIR` redirects the whole credential/config home so a
        // test run cannot touch the developer's real key store.
        if let Some(dir) = std::env::var_os("AGENTE_CONFIG_DIR") {
            return Some(PathBuf::from(dir).join("auth.json"));
        }
        dirs::data_dir().map(|d| d.join("agente").join("auth.json"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auth_store_roundtrip() {
        let mut store = AuthStore::default();
        store.set_key("openai", "sk-test".to_string());
        store.set_key("anthropic", "sk-ant".to_string());

        assert_eq!(store.get_key("openai"), Some("sk-test".to_string()));
        assert_eq!(store.get_key("anthropic"), Some("sk-ant".to_string()));
        assert_eq!(store.get_key("missing"), None);
    }
}
