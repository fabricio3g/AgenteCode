// ── Google Workspace ──────────────────────────────────────────────────
// Documents, spreadsheets and files the user already has, through the
// documented APIs: Docs v1, Sheets v4, Drive v3. Nothing here needs the
// browser extension — the extension adds page-level reach (and Office on
// the web), never the ability to read a doc.
//
// Auth is the user's own OAuth client (see docs/GOOGLE_WORKSPACE.md). The
// grant lives in Agente's auth store under `google`, next to provider keys,
// and is refreshed here when it expires.

pub mod docs;
pub mod drive;
pub mod oauth;
pub mod sheets;

use crate::pairing::Settings;
use agente_core::auth::{AuthStore, OAuthGrant};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

/// Key the grant is stored under, beside `anthropic`, `openai`, …
pub const PROVIDER: &str = "google";

/// What to tell a model (or a person) when Google is not reachable.
pub fn not_connected_text(configured: bool) -> String {
    if configured {
        "Google is not signed in. Run `agente bridge auth google` once and finish in the browser."
            .to_string()
    } else {
        "Google is not set up. Create an OAuth client once (docs/GOOGLE_WORKSPACE.md), then run \
         `agente bridge auth google --client-id … --client-secret …`."
            .to_string()
    }
}

pub fn status_line() -> String {
    let settings = Settings::load();
    let configured = settings.google_client_id.is_some() && settings.google_client_secret.is_some();
    if !configured {
        return "google        not set up (docs/GOOGLE_WORKSPACE.md)".to_string();
    }
    match AuthStore::load().oauth(PROVIDER) {
        Some(grant) if !grant.expired() => match grant.expires_at {
            Some(expires_at) => format!(
                "google        signed in · token valid for {} min",
                (expires_at - now_seconds()).max(0) / 60
            ),
            None => "google        signed in".to_string(),
        },
        Some(_) => match grant_refreshable() {
            true => "google        signed in · token expired, refreshes on the next call".to_string(),
            false => "google        token expired with no refresh token — run `agente bridge auth google` again"
                .to_string(),
        },
        None => "google        client configured · not signed in (`agente bridge auth google`)"
            .to_string(),
    }
}

fn grant_refreshable() -> bool {
    AuthStore::load()
        .oauth(PROVIDER)
        .is_some_and(|grant| grant.refresh_token.is_some())
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// The three Google APIs behind one token.
pub struct Google {
    http: reqwest::Client,
    settings: Settings,
}

impl Google {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("agente-bridge/", env!("CARGO_PKG_VERSION")))
                .build()
                .unwrap_or_default(),
            settings: Settings::load(),
        }
    }

    pub fn configured(&self) -> bool {
        self.settings.google_client_id.is_some() && self.settings.google_client_secret.is_some()
    }

    /// Configured and holding a grant: worth trying before the browser.
    pub fn signed_in(&self) -> bool {
        self.configured() && AuthStore::load().oauth(PROVIDER).is_some()
    }

    fn client_parts(&self) -> Option<(String, String)> {
        Some((
            self.settings.google_client_id.clone()?,
            self.settings.google_client_secret.clone()?,
        ))
    }

    /// A usable access token, refreshing the grant when it has expired.
    pub async fn token(&self) -> Result<String, String> {
        let Some((client_id, client_secret)) = self.client_parts() else {
            return Err(not_connected_text(false));
        };
        let Some(grant) = AuthStore::load().oauth(PROVIDER) else {
            return Err(not_connected_text(true));
        };
        if !grant.expired() {
            return Ok(grant.token);
        }
        let Some(refresh_token) = grant.refresh_token.clone() else {
            return Err(
                "The Google token expired and no refresh token was stored. Run `agente bridge auth google` again."
                    .to_string(),
            );
        };
        let renewed =
            oauth::refresh(&self.http, &client_id, &client_secret, &refresh_token).await?;
        let mut store = AuthStore::load();
        store.set_oauth(PROVIDER, renewed.clone());
        if let Err(error) = store.save() {
            tracing::warn!(%error, "could not store the refreshed Google token");
        }
        Ok(renewed.token)
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
        let response = request
            .send()
            .await
            .map_err(|error| format!("Google request failed: {error}"))?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        Err(http_error_text(status, &body))
    }

    pub async fn get_json(&self, url: &str) -> Result<Value, String> {
        let token = self.token().await?;
        let response = self.send(self.http.get(url).bearer_auth(token)).await?;
        response
            .json::<Value>()
            .await
            .map_err(|error| format!("Google answered with something that is not JSON: {error}"))
    }

    pub async fn post_json(&self, url: &str, body: &Value) -> Result<Value, String> {
        let token = self.token().await?;
        let response = self
            .send(self.http.post(url).bearer_auth(token).json(body))
            .await?;
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        let text = response.text().await.unwrap_or_default();
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|error| format!("Google answered with something that is not JSON: {error}"))
    }

    pub async fn put_json(&self, url: &str, body: &Value) -> Result<Value, String> {
        let token = self.token().await?;
        let response = self
            .send(self.http.put(url).bearer_auth(token).json(body))
            .await?;
        response
            .json::<Value>()
            .await
            .map_err(|error| format!("Google answered with something that is not JSON: {error}"))
    }

    pub async fn get_bytes(&self, url: &str) -> Result<Vec<u8>, String> {
        let token = self.token().await?;
        let response = self.send(self.http.get(url).bearer_auth(token)).await?;
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|error| format!("Google sent a body that could not be read: {error}"))
    }

    pub async fn post_upload(
        &self,
        url: &str,
        boundary: &str,
        body: Vec<u8>,
    ) -> Result<Value, String> {
        let token = self.token().await?;
        let response = self
            .send(
                self.http
                    .post(url)
                    .bearer_auth(token)
                    .header(
                        reqwest::header::CONTENT_TYPE,
                        format!("multipart/related; boundary={boundary}"),
                    )
                    .body(body),
            )
            .await?;
        let text = response.text().await.unwrap_or_default();
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|error| format!("Google answered with something that is not JSON: {error}"))
    }

    pub async fn post_form(&self, url: &str, form: &[(&str, String)]) -> Result<Value, String> {
        let response = self.send(self.http.post(url).form(form)).await?;
        response
            .json::<Value>()
            .await
            .map_err(|error| format!("Google answered with something that is not JSON: {error}"))
    }
}

impl Default for Google {
    fn default() -> Self {
        Self::new()
    }
}

/// The file id in a Google URL (`…/d/<id>/edit`, `?id=<id>`), or the
/// target itself when it already is one.
pub fn file_id(target: &str) -> Option<String> {
    let target = target.trim();
    if target.is_empty() {
        return None;
    }
    let id_chars = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    if let Some((_, rest)) = target.split_once("/d/") {
        let id: String = rest.chars().take_while(|c| id_chars(*c)).collect();
        return (!id.is_empty()).then_some(id);
    }
    if let Some((_, rest)) = target.split_once("id=") {
        let id: String = rest.chars().take_while(|c| id_chars(*c)).collect();
        return (!id.is_empty()).then_some(id);
    }
    (target.len() >= 20 && target.chars().all(id_chars)).then(|| target.to_string())
}

/// Percent-encode one URL path segment or query value.
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Turn an HTTP failure into something a person can act on.
pub fn http_error_text(status: u16, body: &str) -> String {
    let detail = google_message(body);
    match status {
        401 => format!(
            "Google rejected the token (401{detail}). Run `agente bridge auth google` to sign in again."
        ),
        403 => format!(
            "Google refused the call (403{detail}). The account may lack access to this file, or the sign-in may not include the scope this needs."
        ),
        404 => format!(
            "Google could not find it (404{detail}). Check the id or URL, and that the signed-in account can open it."
        ),
        429 => "Google rate-limited the call (429). Wait a moment and retry.".to_string(),
        _ => format!("Google answered {status}{detail}."),
    }
}

/// ` : message` from a Google error body, when there is one.
fn google_message(body: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return String::new();
    };
    let message = value
        .pointer("/error/message")
        .or_else(|| value.pointer("/error_description"))
        .and_then(Value::as_str);
    match message {
        Some(message) => format!(": {}", crate::text::truncate_chars(message, 300)),
        None => String::new(),
    }
}

/// The grant shape both the code exchange and the refresh produce.
pub fn grant_from_token_response(value: &Value) -> Result<OAuthGrant, String> {
    let token = value
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            format!(
                "Google did not return an access token: {}",
                crate::text::truncate_chars(&value.to_string(), 300)
            )
        })?;
    let expires_at = value
        .get("expires_in")
        .and_then(Value::as_i64)
        .map(|seconds| now_seconds() + seconds);
    Ok(OAuthGrant {
        token: token.to_string(),
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_at,
        scope: value
            .get("scope")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn http_failures_read_like_instructions() {
        let unauthorized = http_error_text(401, r#"{"error":{"message":"Invalid Credentials"}}"#);
        assert!(unauthorized.contains("401"));
        assert!(unauthorized.contains("Invalid Credentials"));
        assert!(unauthorized.contains("agente bridge auth google"));

        let missing = http_error_text(404, "{}");
        assert!(missing.contains("could not find it"));

        let limited = http_error_text(429, "");
        assert!(limited.contains("rate-limited"));

        let odd = http_error_text(500, "<html>nope</html>");
        assert!(odd.contains("500"));
    }

    #[test]
    fn a_token_response_becomes_a_grant_with_an_expiry() {
        let grant = grant_from_token_response(&json!({
            "access_token": "at",
            "expires_in": 3600,
            "refresh_token": "rt",
            "scope": "a b"
        }))
        .expect("grant");
        assert_eq!(grant.token, "at");
        assert_eq!(grant.refresh_token.as_deref(), Some("rt"));
        assert_eq!(grant.scope.as_deref(), Some("a b"));
        assert!(!grant.expired());
        assert!(grant.expires_at.expect("expiry") > now_seconds());

        let error = grant_from_token_response(&json!({"error": "invalid_grant"})).unwrap_err();
        assert!(error.contains("did not return an access token"));
    }

    #[test]
    fn ids_come_out_of_every_google_url_shape() {
        let id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
        assert_eq!(
            file_id(&format!(
                "https://docs.google.com/document/d/{id}/edit#heading=h.1"
            ))
            .as_deref(),
            Some(id)
        );
        assert_eq!(
            file_id(&format!(
                "https://docs.google.com/spreadsheets/u/0/d/{id}/edit?gid=0"
            ))
            .as_deref(),
            Some(id)
        );
        assert_eq!(
            file_id(&format!("https://drive.google.com/open?id={id}")).as_deref(),
            Some(id)
        );
        assert_eq!(file_id(id).as_deref(), Some(id));
        assert!(file_id("").is_none());
        assert!(file_id("not an id").is_none());
    }

    #[test]
    fn encoding_keeps_sheet_ranges_intact() {
        assert_eq!(encode("Sheet 1!A1:B2"), "Sheet%201%21A1%3AB2");
    }

    #[test]
    fn the_status_line_says_what_to_do_next() {
        // No settings file in this process, so the "not set up" branch.
        let line = status_line();
        assert!(line.starts_with("google"), "{line}");
        assert!(line.contains("GOOGLE_WORKSPACE.md"), "{line}");
    }
}
