/// Strip Windows extended-length / verbatim prefixes from a path string.
///
/// `std::fs::canonicalize` on Windows returns paths like `\\?\D:\foo`. Those
/// prefixes are correct for the Win32 API but look wrong in the UI.
///
/// Also accepts the forward-slash form `//?/` some layers emit.
///
/// **Note:** UNC verbatim paths (`\\?\UNC\server\share`) are *not* handled
/// here — they need an owned rewrite. Use [`normalize_project_dir`] for those.
pub fn strip_verbatim_prefix(path: &str) -> &str {
    if path.starts_with(r"\\?\UNC\")
        || path.starts_with(r"//?/UNC/")
        || path.starts_with(r"\\?\unc\")
        || path.starts_with(r"//?/unc/")
    {
        return path;
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest;
    }
    if let Some(rest) = path.strip_prefix(r"//?/") {
        return rest;
    }
    path
}

/// Normalize a project directory for storage and display.
///
/// Strips Windows `\\?\` / `//?/` prefixes and UNC verbatim forms, keeps the
/// OS path separators (unlike [`clean_path`], which forces `/` for tool paths).
pub fn normalize_project_dir(path: impl AsRef<std::path::Path>) -> String {
    let raw = path.as_ref().to_string_lossy();
    // UNC verbatim: \\?\UNC\server\share → \\server\share
    if let Some(rest) = raw
        .strip_prefix(r"\\?\UNC\")
        .or_else(|| raw.strip_prefix(r"//?/UNC/"))
        .or_else(|| raw.strip_prefix(r"\\?\unc\"))
        .or_else(|| raw.strip_prefix(r"//?/unc/"))
    {
        return format!(r"\\{rest}");
    }
    strip_verbatim_prefix(raw.as_ref()).to_string()
}

/// Truncate `text` to at most `max_bytes` without splitting a UTF-8 character.
///
/// Slicing a string at an arbitrary byte offset panics when that offset lands
/// inside a multibyte char; every byte-budget truncation must route through
/// this helper instead of `&text[..max_bytes]`.
pub fn truncate_at_char_boundary(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Clean a path for tool-facing use: strip verbatim prefixes and normalize
/// separators to `/`.
/// Shared reqwest client for LLM providers: connect timeout only.
/// No overall request timeout — streaming responses can run for minutes.
/// Idle-body stalls are handled by per-chunk timeouts in the stream loops.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .user_agent("agente/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Max silence on an SSE/byte stream before we abort (seconds).
/// Override with `AGENTE_STREAM_IDLE_SECS`.
pub fn stream_idle_timeout() -> std::time::Duration {
    let secs = std::env::var("AGENTE_STREAM_IDLE_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n: &u64| n > 0)
        .unwrap_or(90);
    std::time::Duration::from_secs(secs)
}

pub fn clean_path(path: &str) -> String {
    // UNC needs owned rewrite before separator normalize.
    let owned;
    let p = if path.starts_with(r"\\?\UNC\")
        || path.starts_with(r"//?/UNC/")
        || path.starts_with(r"\\?\unc\")
        || path.starts_with(r"//?/unc/")
    {
        owned = normalize_project_dir(path);
        owned.as_str()
    } else {
        strip_verbatim_prefix(path)
    };
    p.replace('\\', "/")
}

/// Expand `${VAR}` (and bare `$VAR`) environment templates inside a string.
///
/// Providers like databricks / snowflake / neon / cloudflare-workers-ai encode
/// account or region variables directly in their base URLs
/// (`https://${DATABRICKS_HOST}/ai-gateway/...`). Unset variables are replaced
/// with the empty string so callers can detect the URL is incomplete.
pub fn expand_env_templates(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' {
            // ${VAR}
            if i + 1 < chars.len() && chars[i + 1] == '{' {
                if let Some(close) = chars[i + 2..].iter().position(|&c| c == '}') {
                    let var: String = chars[i + 2..i + 2 + close].iter().collect();
                    let val = std::env::var(&var).unwrap_or_default();
                    out.push_str(&val);
                    i = i + 2 + close + 1;
                    continue;
                }
            }
            // $VAR (only when followed by identifier chars, e.g. URLs like /v1)
            if i + 1 < chars.len() && (chars[i + 1].is_alphanumeric() || chars[i + 1] == '_') {
                let mut j = i + 1;
                while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                    j += 1;
                }
                let var: String = chars[i + 1..j].iter().collect();
                let val = std::env::var(&var).unwrap_or_default();
                out.push_str(&val);
                i = j;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Redact likely API keys / bearer tokens / secrets from a string so errors
/// and logs never leak credentials back to the user or into the transcript.
///
/// Covers `sk-…` keys, `Bearer …` tokens, `api_key=` query params, and long
/// base64-ish tokens (>= 20 chars). Conservative: only masks the token-like
/// run, never valid paths or short identifiers.
pub fn redact_secrets(text: &str) -> String {
    let mut out = text.to_string();
    let patterns: &[(&str, &str)] = &[
        // sk-... OpenAI-style keys
        (r"(?i)\bsk-[A-Za-z0-9_\-]{16,}", "sk-***"),
        // Bearer tokens (JWT or opaque)
        (r"(?i)bearer\s+[A-Za-z0-9._\-]{16,}", "Bearer ***"),
        // Authorization header value
        (r"(?i)authorization:\s*\S+", "authorization: ***"),
        // api_key / apikey / key= query params
        (r"(?i)([?&])(api[_-]?key|key)=[^&\s]+", "$1$2=***"),
        // X-API-Key header
        (r"(?i)x-api-key:\s*\S+", "x-api-key: ***"),
        // Long base64/base64url-ish tokens (e.g. Anthropic, Gemini)
        (r"[A-Za-z0-9+/_\-]{40,}={0,2}", "***"),
    ];
    for (re, replacement) in patterns {
        if let Ok(re) = regex::Regex::new(re) {
            out = re.replace_all(&out, *replacement).to_string();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_braced_env_template() {
        std::env::set_var("AGENTE_TEST_HOST", "myhost");
        assert_eq!(
            expand_env_templates("https://${AGENTE_TEST_HOST}/ai-gateway/v1"),
            "https://myhost/ai-gateway/v1"
        );
        std::env::remove_var("AGENTE_TEST_HOST");
    }

    #[test]
    fn unset_var_expands_to_empty() {
        assert_eq!(
            expand_env_templates("https://${UNSET_VAR_XYZ}/v1"),
            "https:///v1"
        );
    }

    #[test]
    fn leaves_plain_urls_untouched() {
        assert_eq!(
            expand_env_templates("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1"
        );
    }

    #[test]
    fn redacts_sk_and_bearer_tokens() {
        let s = "key=sk-abcdefghijklmnopqrstuvwxyz and Bearer eyJhbGciOiJIUzI1NiJ9.abc.def";
        let out = redact_secrets(s);
        assert!(!out.contains("sk-abcdefghijklmnop"), "leaked: {out}");
        assert!(out.contains("sk-***"));
        assert!(!out.contains("eyJhbGciOiJIUzI1NiJ9"), "leaked: {out}");
        assert!(out.contains("Bearer ***"));
    }

    #[test]
    fn redacts_query_api_key() {
        let s = "https://x.example/v1?api_key=sk-abcdefghijklmnopqrstuvwxyz&model=gpt";
        let out = redact_secrets(s);
        assert!(!out.contains("sk-abcdefghijklmnop"), "leaked: {out}");
        assert!(out.contains("api_key=***"));
        // Non-secret query values survive.
        assert!(out.contains("model=gpt"));
    }

    #[test]
    fn redact_leaves_normal_text_alone() {
        let s = "Error from provider: request failed for src/main.rs (status 500)";
        assert_eq!(redact_secrets(s), s);
    }

    #[test]
    fn strips_windows_verbatim_drive_prefix() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\D:\Nuevo2\tests"),
            r"D:\Nuevo2\tests"
        );
        assert_eq!(
            normalize_project_dir(r"\\?\D:\Nuevo2\tests"),
            r"D:\Nuevo2\tests"
        );
        assert_eq!(clean_path(r"\\?\D:\Nuevo2\tests"), "D:/Nuevo2/tests");
    }

    #[test]
    fn strips_forward_slash_verbatim_prefix() {
        assert_eq!(strip_verbatim_prefix("//?/C:/foo"), "C:/foo");
        assert_eq!(normalize_project_dir("//?/C:/foo"), "C:/foo");
    }

    #[test]
    fn normalizes_unc_verbatim_prefix() {
        assert_eq!(
            normalize_project_dir(r"\\?\UNC\server\share"),
            r"\\server\share"
        );
        assert_eq!(clean_path(r"\\?\UNC\server\share"), "//server/share");
    }

    #[test]
    fn leaves_plain_paths_alone() {
        assert_eq!(
            normalize_project_dir(r"D:\Nuevo2\tests"),
            r"D:\Nuevo2\tests"
        );
        assert_eq!(normalize_project_dir("/home/user/proj"), "/home/user/proj");
        assert_eq!(strip_verbatim_prefix("relative/path"), "relative/path");
    }

    #[test]
    fn truncates_on_char_boundary() {
        let text = "aé日🎉tail";
        assert_eq!(truncate_at_char_boundary(text, text.len()), text);
        for max in 0..text.len() {
            let cut = truncate_at_char_boundary(text, max);
            assert!(text.starts_with(cut));
            assert!(text.is_char_boundary(cut.len()));
        }
        assert_eq!(truncate_at_char_boundary(text, 2), "a");
    }
}
