//! Where `web_search` searches.
//!
//! Kept in its own file (`<config dir>/web.json`) beside `config.json`, and
//! the API keys in the credential store (`auth.json`, under `web:<provider>`)
//! or the provider's usual environment variable — never in a config file
//! that could be committed. `/settings` in the TUI and the desktop's
//! Settings → Search both write here.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Results one `web_search` call returns by default.
pub const DEFAULT_RESULTS: usize = 8;

/// The search backends `web_search` can use.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchProvider {
    /// No key: DuckDuckGo's HTML results page.
    #[default]
    DuckDuckGo,
    Brave,
    Tavily,
    Exa,
    /// The user's own SearXNG instance (JSON format enabled).
    SearXng,
}

impl SearchProvider {
    pub const ALL: &'static [SearchProvider] = &[
        Self::DuckDuckGo,
        Self::Brave,
        Self::Tavily,
        Self::Exa,
        Self::SearXng,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::DuckDuckGo => "duckduckgo",
            Self::Brave => "brave",
            Self::Tavily => "tavily",
            Self::Exa => "exa",
            Self::SearXng => "searxng",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::DuckDuckGo => "DuckDuckGo",
            Self::Brave => "Brave Search",
            Self::Tavily => "Tavily",
            Self::Exa => "Exa",
            Self::SearXng => "SearXNG",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|p| p.id().eq_ignore_ascii_case(id.trim()))
    }

    /// Environment variables checked for the key, in order.
    pub fn key_vars(self) -> &'static [&'static str] {
        match self {
            Self::DuckDuckGo | Self::SearXng => &[],
            Self::Brave => &["BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"],
            Self::Tavily => &["TAVILY_API_KEY"],
            Self::Exa => &["EXA_API_KEY"],
        }
    }

    pub fn needs_key(self) -> bool {
        !self.key_vars().is_empty()
    }

    /// Where to get a key, for the settings hint.
    pub fn key_url(self) -> Option<&'static str> {
        match self {
            Self::Brave => Some("https://api-dashboard.search.brave.com"),
            Self::Tavily => Some("https://app.tavily.com"),
            Self::Exa => Some("https://dashboard.exa.ai"),
            Self::DuckDuckGo | Self::SearXng => None,
        }
    }

    /// The credential-store entry holding this provider's key.
    pub fn auth_id(self) -> String {
        format!("web:{}", self.id())
    }
}

/// `web.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebSettings {
    #[serde(default)]
    pub search_provider: SearchProvider,
    /// Base URL of a SearXNG instance (`SEARXNG_URL` otherwise).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub searxng_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_results: Option<usize>,
}

impl WebSettings {
    pub fn path() -> Option<PathBuf> {
        Some(crate::config::AppConfig::config_dir()?.join("web.json"))
    }

    /// The saved settings, or the defaults when there are none (or the file
    /// does not parse — a broken file must not take search down).
    pub fn load() -> Self {
        Self::path()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> std::io::Result<()> {
        let path = Self::path().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no config directory")
        })?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(path, text)
    }

    pub fn results(&self) -> usize {
        self.max_results.unwrap_or(DEFAULT_RESULTS).clamp(1, 20)
    }

    pub fn searxng_base(&self) -> Option<String> {
        self.searxng_url
            .clone()
            .filter(|url| !url.trim().is_empty())
            .or_else(|| std::env::var("SEARXNG_URL").ok())
            .map(|url| url.trim().trim_end_matches('/').to_string())
            .filter(|url| !url.is_empty())
    }

    /// Whether `provider` has what it needs (a key or a URL).
    pub fn ready(&self, provider: SearchProvider) -> bool {
        match provider {
            SearchProvider::DuckDuckGo => true,
            SearchProvider::SearXng => self.searxng_base().is_some(),
            _ => api_key(provider).is_some(),
        }
    }
}

/// The key for `provider`: the credential store first, then its variables.
pub fn api_key(provider: SearchProvider) -> Option<String> {
    crate::auth::AuthStore::load()
        .get_key(&provider.auth_id())
        .or_else(|| {
            provider
                .key_vars()
                .iter()
                .find_map(|var| std::env::var(var).ok())
        })
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

/// Providers whose key another surface can hand over, in the order `auto`
/// prefers them.
const KEYED: &[SearchProvider] = &[
    SearchProvider::Brave,
    SearchProvider::Tavily,
    SearchProvider::Exa,
];

/// What another surface hands over (the desktop's Settings → Search, through
/// the daemon's `web.sync`): its provider choice in its own words, and the
/// keys and URL it holds. That surface is the source of truth while it syncs.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct WebSync {
    /// The client's provider id. Ids the core has no backend for (`auto`,
    /// `aggregator`, `jina`, …) pick the first provider with a key, else
    /// DuckDuckGo.
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub searxng_url: Option<String>,
    #[serde(default)]
    pub max_results: Option<usize>,
    /// Provider id → API key. A keyed provider left out loses its stored key.
    #[serde(default)]
    pub keys: std::collections::HashMap<String, String>,
}

impl WebSync {
    /// Store the keys, write `web.json`, and return the provider in effect.
    pub fn apply(&self) -> std::io::Result<SearchProvider> {
        let mut store = crate::auth::AuthStore::load();
        for provider in KEYED {
            match self.key(*provider) {
                Some(key) => store.set_key(&provider.auth_id(), key),
                None => store.remove(&provider.auth_id()),
            }
        }
        store.save()?;

        let mut settings = WebSettings::load();
        settings.searxng_url = self
            .searxng_url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(str::to_string);
        settings.max_results = self.max_results.map(|n| n.clamp(1, 20));
        settings.search_provider = self.resolve(|provider| settings.ready(provider));
        settings.save()?;
        Ok(settings.search_provider)
    }

    fn key(&self, provider: SearchProvider) -> Option<String> {
        self.keys
            .get(provider.id())
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
    }

    /// An explicit choice the core has a backend for stays, even before it
    /// works (search then says what it needs and answers from DuckDuckGo);
    /// anything else takes the first keyed provider that is ready.
    fn resolve(&self, ready: impl Fn(SearchProvider) -> bool) -> SearchProvider {
        if let Some(provider) = SearchProvider::from_id(&self.provider) {
            return provider;
        }
        KEYED
            .iter()
            .copied()
            .find(|provider| self.key(*provider).is_some() || ready(*provider))
            .unwrap_or(SearchProvider::DuckDuckGo)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sync(provider: &str, keys: &[(&str, &str)]) -> WebSync {
        WebSync {
            provider: provider.into(),
            keys: keys
                .iter()
                .map(|(id, key)| (id.to_string(), key.to_string()))
                .collect(),
            ..WebSync::default()
        }
    }

    #[test]
    fn a_synced_choice_maps_onto_the_core_providers() {
        let never = |_| false;
        assert_eq!(sync("tavily", &[]).resolve(never), SearchProvider::Tavily);
        assert_eq!(sync("searxng", &[]).resolve(never), SearchProvider::SearXng);
        // Desktop-only ids take the first provider with a key.
        assert_eq!(
            sync("auto", &[("exa", "k1"), ("tavily", "k2")]).resolve(never),
            SearchProvider::Tavily
        );
        assert_eq!(
            sync("aggregator", &[("brave", "  ")]).resolve(never),
            SearchProvider::DuckDuckGo,
            "a blank key is no key"
        );
        assert_eq!(
            sync("perplexity", &[]).resolve(|p| p == SearchProvider::Exa),
            SearchProvider::Exa,
            "a key from the environment counts"
        );
        let parsed: WebSync = serde_json::from_str(
            r#"{"provider":"auto","keys":{"brave":"b"},"searxng_url":"https://s.example","max_results":7}"#,
        )
        .unwrap();
        assert_eq!(parsed.key(SearchProvider::Brave).as_deref(), Some("b"));
        assert_eq!(parsed.max_results, Some(7));
    }

    #[test]
    fn defaults_search_duckduckgo() {
        let settings = WebSettings::default();
        assert_eq!(settings.search_provider, SearchProvider::DuckDuckGo);
        assert_eq!(settings.results(), DEFAULT_RESULTS);
        assert!(settings.ready(SearchProvider::DuckDuckGo));
    }

    #[test]
    fn file_round_trips_and_tolerates_unknown_keys() {
        let settings: WebSettings =
            serde_json::from_str(r#"{"search_provider":"brave","max_results":5,"future":true}"#)
                .unwrap();
        assert_eq!(settings.search_provider, SearchProvider::Brave);
        assert_eq!(settings.results(), 5);
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"brave\""), "{json}");
    }

    #[test]
    fn provider_ids_parse() {
        for provider in SearchProvider::ALL {
            assert_eq!(SearchProvider::from_id(provider.id()), Some(*provider));
        }
        assert_eq!(
            SearchProvider::from_id("SearXNG"),
            Some(SearchProvider::SearXng)
        );
        assert_eq!(SearchProvider::from_id("bing"), None);
    }
}
