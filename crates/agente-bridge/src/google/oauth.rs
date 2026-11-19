// ── Google OAuth ──────────────────────────────────────────────────────
// A desktop-app client, PKCE, and a loopback redirect: the flow a person
// runs once with `agente bridge auth google`. The browser is the user's
// own, so the consent screen is the one they already trust.
//
// Loopback redirects are what Google allows for installed apps — the
// extension never sees the token, and the bridge never sees the password.

use agente_core::auth::OAuthGrant;
use base64::Engine;
use sha2::Digest;
use std::time::Duration;

pub const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

/// Least privilege that still does the job: edit Docs and Sheets, find and
/// export files the account can already see, and create new ones.
pub const SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
];

const FLOW_TIMEOUT: Duration = Duration::from_secs(180);
const SOCKET_READ_TIMEOUT: Duration = Duration::from_secs(5);

/// PKCE: the verifier never leaves this machine, only its hash does.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn pkce() -> Pkce {
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes);
    let challenge =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(&bytes));
    Pkce {
        verifier,
        challenge,
    }
}

pub fn authorize_url(client_id: &str, redirect_uri: &str, state: &str, challenge: &str) -> String {
    let scopes = SCOPES.join(" ");
    format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        urlencode(client_id),
        urlencode(redirect_uri),
        urlencode(&scopes),
        urlencode(challenge),
        urlencode(state),
    )
}

pub async fn exchange_code(
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<OAuthGrant, String> {
    let form = vec![
        ("client_id", client_id.to_string()),
        ("client_secret", client_secret.to_string()),
        ("code", code.to_string()),
        ("code_verifier", verifier.to_string()),
        ("grant_type", "authorization_code".to_string()),
        ("redirect_uri", redirect_uri.to_string()),
    ];
    let response = http
        .post(TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|error| format!("Could not reach Google's token endpoint: {error}"))?;
    let status = response.status().as_u16();
    let body: serde_json::Value = response.json().await.map_err(|error| {
        format!("Google's token endpoint answered something unreadable: {error}")
    })?;
    if !(200..300).contains(&status) {
        return Err(crate::google::http_error_text(status, &body.to_string()));
    }
    crate::google::grant_from_token_response(&body)
}

pub async fn refresh(
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<OAuthGrant, String> {
    let form = vec![
        ("client_id", client_id.to_string()),
        ("client_secret", client_secret.to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("grant_type", "refresh_token".to_string()),
    ];
    let response = http
        .post(TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|error| format!("Could not reach Google's token endpoint: {error}"))?;
    let status = response.status().as_u16();
    let body: serde_json::Value = response.json().await.map_err(|error| {
        format!("Google's token endpoint answered something unreadable: {error}")
    })?;
    if !(200..300).contains(&status) {
        return Err(crate::google::http_error_text(status, &body.to_string()));
    }
    let mut grant = crate::google::grant_from_token_response(&body)?;
    // A refresh response usually omits the refresh token; keep the one we have.
    if grant.refresh_token.is_none() {
        grant.refresh_token = Some(refresh_token.to_string());
    }
    Ok(grant)
}

/// Run the whole flow: print the URL, open the browser, wait for the
/// loopback redirect, exchange the code.
pub async fn run_flow(client_id: &str, client_secret: &str) -> anyhow::Result<OAuthGrant> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let pkce = pkce();
    let state = uuid::Uuid::new_v4().simple().to_string();
    let url = authorize_url(client_id, &redirect_uri, &state, &pkce.challenge);

    println!("Open this URL and approve access:\n\n  {url}\n");
    open_browser(&url);

    let code = tokio::time::timeout(FLOW_TIMEOUT, wait_for_code(listener, &state))
        .await
        .map_err(|_| anyhow::anyhow!("No answer from the browser within three minutes"))??;

    let http = reqwest::Client::new();
    let grant = exchange_code(
        &http,
        client_id,
        client_secret,
        &code,
        &pkce.verifier,
        &redirect_uri,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(grant)
}

async fn wait_for_code(listener: tokio::net::TcpListener, state: &str) -> anyhow::Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    loop {
        let (mut socket, _) = listener.accept().await?;
        let mut buffer = vec![0u8; 8192];
        let read = match tokio::time::timeout(SOCKET_READ_TIMEOUT, socket.read(&mut buffer)).await {
            Ok(Ok(n)) if n > 0 => n,
            _ => {
                let _ = socket.shutdown().await;
                continue;
            }
        };
        let request = String::from_utf8_lossy(&buffer[..read]).to_string();
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or_default()
            .to_string();

        let (status, body, code) = match parse_callback(&target, state) {
            Ok(code) => (
                "200 OK",
                "<h2>Agente is connected to Google.</h2><p>You can close this tab.</p>".to_string(),
                Some(code),
            ),
            Err(message) => ("400 Bad Request", message, None),
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;
        if let Some(code) = code {
            return Ok(code);
        }
    }
}

/// `GET /callback?code=…&state=…` → the code, refusing anything else.
pub fn parse_callback(target: &str, expected_state: &str) -> Result<String, String> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        return Err("<h2>Waiting for the sign-in to finish…</h2>".to_string());
    }
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key {
            "code" => code = Some(urldecode(value)),
            "state" => state = Some(urldecode(value)),
            "error" => error = Some(urldecode(value)),
            _ => {}
        }
    }
    if let Some(error) = error {
        return Err(format!(
            "<h2>Google refused the request</h2><p>{}</p>",
            html_escape(&error)
        ));
    }
    match (code, state) {
        (Some(code), Some(state)) if state == expected_state => Ok(code),
        (Some(_), _) => Err("<h2>That answer was not for this sign-in.</h2>".to_string()),
        _ => Err("<h2>Waiting for the sign-in to finish…</h2>".to_string()),
    }
}

fn html_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(ch),
        }
    }
    out
}

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let opener = "xdg-open";
    if let Err(error) = std::process::Command::new(opener).arg(url).spawn() {
        tracing::debug!(%error, "could not open a browser; the URL is printed above");
    }
}

fn urlencode(value: &str) -> String {
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

fn urldecode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_pairs_a_verifier_with_its_hash() {
        let one = pkce();
        let two = pkce();
        assert_ne!(one.verifier, two.verifier);
        assert!(one.verifier.len() >= 43);
        assert!(!one.challenge.contains('='));
        assert!(!one.verifier.contains('='));
        let expected =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(&one.verifier)
                    .unwrap(),
            ));
        assert_eq!(one.challenge, expected);
    }

    #[test]
    fn the_authorize_url_carries_everything_google_needs() {
        let url = authorize_url(
            "client.apps.googleusercontent.com",
            "http://127.0.0.1:8080/callback",
            "st4te",
            "ch4llenge",
        );
        assert!(url.starts_with(AUTH_URL));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("state=st4te"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A8080%2Fcallback"));
        // Every scope, space-encoded.
        assert!(url.contains("auth%2Fdocuments"));
        assert!(url.contains("auth%2Fspreadsheets"));
        assert!(!url.contains(' '));
    }

    #[test]
    fn the_callback_is_read_strictly() {
        assert_eq!(
            parse_callback("/callback?code=abc&state=s1", "s1").unwrap(),
            "abc"
        );
        assert_eq!(
            parse_callback("/callback?state=s1&code=a%2Fb", "s1").unwrap(),
            "a/b"
        );
        assert!(parse_callback("/callback?code=abc&state=other", "s1")
            .unwrap_err()
            .contains("not for this sign-in"));
        assert!(parse_callback("/callback?error=access_denied", "s1")
            .unwrap_err()
            .contains("access_denied"));
        assert!(parse_callback("/favicon.ico", "s1").is_err());
    }

    #[test]
    fn callback_rejects_missing_state_and_wrong_path_and_escapes_error_html() {
        // CSRF: missing state must be rejected even with a valid code.
        assert!(parse_callback("/callback?code=abc", "s1")
            .unwrap_err()
            .contains("not for this sign-in"));
        // Wrong request path must be rejected even with valid code and state.
        assert!(parse_callback("/other?code=abc&state=s1", "s1").is_err());
        assert!(parse_callback("/callback/extra?code=abc&state=s1", "s1").is_err());
        // XSS: HTML metacharacters in `error` must be escaped.
        let escaped = parse_callback(
            "/callback?error=%3Cscript%3Ealert(%27x%27%26%22y%22)%3C%2Fscript%3E",
            "s1",
        )
        .unwrap_err();
        assert!(!escaped.contains("<script>"), "{escaped}");
        assert!(
            escaped.contains("&lt;script&gt;alert(&#x27;x&#x27;&amp;&quot;y&quot;)&lt;/script&gt;"),
            "{escaped}"
        );
    }
}
