//! Network research tools (permission-gated by the agent permission engine).

use std::net::{IpAddr, ToSocketAddrs};

use futures::StreamExt;

use super::{
    truncate_tool_output, ToolCore, ToolError, ToolExecutionContext, ToolExecutionMode,
    MAX_SHELL_LINES,
};

const MAX_FETCH_BYTES: usize = 100 * 1024;

/// Loopback/private/link-local destinations are refused: a tool that fetches
/// arbitrary URLs must not become a probe for the host's internal network.
fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                // Carrier-grade NAT 100.64.0.0/10.
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_forbidden_ip(IpAddr::V4(mapped));
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
        }
    }
}

fn is_forbidden_host(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return true;
    };
    let host = host.to_ascii_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return true;
    }
    // `host_str()` keeps the brackets of an IPv6 literal (`[::1]`), which
    // neither parses as an address nor resolves, so it would slip through as
    // "no internal address found".
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = literal.parse::<IpAddr>() {
        return is_forbidden_ip(ip);
    }
    // Resolve and refuse when any address is internal (a public name can
    // still point at 127.0.0.1 or a LAN address).
    let port = url.port_or_known_default().unwrap_or(80);
    match (host.as_str(), port).to_socket_addrs() {
        Ok(addrs) => addrs.into_iter().any(|addr| is_forbidden_ip(addr.ip())),
        Err(_) => false,
    }
}

/// Process-wide HTTP client shared by the web tools so connection pools are
/// reused across calls instead of rebuilt per invocation. Redirects are
/// re-validated against the SSRF guard on every hop.
fn shared_http_client() -> Result<&'static reqwest::Client, ToolError> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .user_agent(concat!("agente/", env!("CARGO_PKG_VERSION")))
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if is_forbidden_host(attempt.url()) {
                        attempt.error(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "blocked request to a private/loopback address",
                        ))
                    } else if attempt.previous().len() >= 5 {
                        attempt.stop()
                    } else {
                        attempt.follow()
                    }
                }))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| ToolError::ExecutionError(e.clone()))
}

/// Arguments accepted by the `web_fetch` tool.
#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct WebFetchArgs {
    /// Full URL to fetch (https preferred)
    #[serde(default)]
    pub url: Option<String>,
    /// Maximum characters to return (default 20000)
    #[serde(default)]
    pub max_chars: Option<usize>,
}

#[derive(Default)]
pub struct WebFetchTool;

impl ToolCore for WebFetchTool {
    type Args = WebFetchArgs;

    fn name(&self) -> &str {
        "web_fetch"
    }
    fn kind(&self) -> super::ToolKind {
        super::ToolKind::Web
    }

    fn description(&self) -> &str {
        "Fetch a public HTTP/HTTPS URL and return text content (HTML is lightly stripped). Use for docs and research. Always prefer local files when available."
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Parallel
    }

    fn allowed_in_plan(&self) -> bool {
        true
    }

    async fn run(
        &self,
        args: WebFetchArgs,
        _project_dir: &str,
        _context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let url = args
            .url
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'url'".into()))?
            .trim()
            .to_string();

        let parsed = reqwest::Url::parse(&url)
            .map_err(|e| ToolError::InvalidArguments(format!("Invalid URL: {e}")))?;
        if is_forbidden_host(&parsed) {
            return Err(ToolError::ExecutionError(format!(
                "Refusing to fetch {url}: private/loopback addresses are blocked"
            )));
        }

        let max_chars = args.max_chars.unwrap_or(20_000);

        let client = shared_http_client()?;

        let response = client
            .get(parsed)
            .send()
            .await
            .map_err(|e| ToolError::ExecutionError(format!("Request failed: {e}")))?;

        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        // Stop reading at the cap instead of buffering the whole body first.
        let mut stream = response.bytes_stream();
        let mut bytes: Vec<u8> = Vec::with_capacity(64 * 1024);
        let mut overflow = false;
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|e| ToolError::ExecutionError(format!("Read body failed: {e}")))?;
            let remaining = MAX_FETCH_BYTES.saturating_sub(bytes.len());
            if chunk.len() > remaining {
                bytes.extend_from_slice(&chunk[..remaining]);
                overflow = true;
                break;
            }
            bytes.extend_from_slice(&chunk);
        }

        let text = String::from_utf8_lossy(&bytes).to_string();
        if overflow {
            let body = if content_type.contains("html") || text.trim_start().starts_with('<') {
                strip_html_rough(&text)
            } else {
                text
            };
            return Ok(format!(
                "URL: {url}\nStatus: {status}\nContent-Type: {content_type}\n\n\
                 [Body too large: truncated to {MAX_FETCH_BYTES} bytes]\n{body}"
            ));
        }

        let body = if content_type.contains("html") || text.trim_start().starts_with('<') {
            strip_html_rough(&text)
        } else {
            text
        };

        let mut out =
            format!("URL: {url}\nStatus: {status}\nContent-Type: {content_type}\n\n{body}");
        if out.chars().count() > max_chars {
            out = out.chars().take(max_chars).collect::<String>() + "\n\n... truncated ...";
        }
        Ok(truncate_tool_output(&out, MAX_SHELL_LINES, "head"))
    }
}

/// Browser-like UA for the DuckDuckGo HTML endpoints (they refuse plain bots).
const DDG_HTML_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// Arguments accepted by the `web_search` tool.
#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct WebSearchArgs {
    /// Search query
    #[serde(default)]
    pub query: Option<String>,
}

#[derive(Default)]
pub struct WebSearchTool;

impl ToolCore for WebSearchTool {
    type Args = WebSearchArgs;

    fn name(&self) -> &str {
        "web_search"
    }
    fn kind(&self) -> super::ToolKind {
        super::ToolKind::Web
    }

    fn description(&self) -> &str {
        "Search the public web via DuckDuckGo. Returns up to 8 results with titles, URLs and snippets. Use for up-to-date docs, APIs and research; prefer local project files first."
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Parallel
    }

    fn allowed_in_plan(&self) -> bool {
        true
    }

    async fn run(
        &self,
        args: WebSearchArgs,
        _project_dir: &str,
        _context: &ToolExecutionContext,
    ) -> Result<String, ToolError> {
        let query = args
            .query
            .ok_or_else(|| ToolError::InvalidArguments("Missing 'query'".into()))?
            .trim()
            .to_string();
        if query.is_empty() {
            return Err(ToolError::InvalidArguments("Query is empty".into()));
        }

        let client = shared_http_client()?;

        // Real search results first; the instant-answer API (which only knows
        // about famous entities) is the last-resort fallback. A failing
        // fallback is logged instead of vanishing.
        match duckduckgo_html_search(&query, client).await {
            Ok(out) if !out.is_empty() => return Ok(out),
            Ok(_) => {}
            Err(err) => tracing::debug!(%err, "DDG HTML search failed"),
        }
        match duckduckgo_lite_search(&query, client).await {
            Ok(out) if !out.is_empty() => return Ok(out),
            Ok(_) => {}
            Err(err) => tracing::debug!(%err, "DDG Lite search failed"),
        }
        duckduckgo_instant_answer(&query, client).await
    }
}

/// Search via the DuckDuckGo HTML endpoint — a real web search. Returns an
/// empty string when the page yields no parseable results (e.g. blocked).
async fn duckduckgo_html_search(
    query: &str,
    client: &reqwest::Client,
) -> Result<String, ToolError> {
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding_lite(query)
    );
    let response = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(20))
        .header(reqwest::header::USER_AGENT, DDG_HTML_UA)
        .send()
        .await
        .map_err(|e| ToolError::ExecutionError(format!("Search failed: {e}")))?;
    let html = response
        .text()
        .await
        .map_err(|e| ToolError::ExecutionError(format!("Read failed: {e}")))?;

    let results = parse_ddg_html_results(&html);
    if results.is_empty() {
        return Ok(String::new());
    }
    let mut lines = vec![format!("Query: {}", query)];
    for r in results.into_iter().take(8) {
        lines.push(format!("- {} — {}\n  {}", r.title, r.url, r.snippet));
    }
    Ok(lines.join("\n"))
}

/// Search via the lighter DuckDuckGo HTML endpoint (second fallback).
async fn duckduckgo_lite_search(
    query: &str,
    client: &reqwest::Client,
) -> Result<String, ToolError> {
    let url = format!(
        "https://lite.duckduckgo.com/lite/?q={}",
        urlencoding_lite(query)
    );
    let response = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(20))
        .header(reqwest::header::USER_AGENT, DDG_HTML_UA)
        .send()
        .await
        .map_err(|e| ToolError::ExecutionError(format!("Search failed: {e}")))?;
    let html = response
        .text()
        .await
        .map_err(|e| ToolError::ExecutionError(format!("Read failed: {e}")))?;

    let links = collect_anchors(&html, "result-link");
    if links.is_empty() {
        return Ok(String::new());
    }
    let snippets = collect_cells(&html, "result-snippet");
    let mut lines = vec![format!("Query: {}", query)];
    for (i, (title, href)) in links.into_iter().take(8).enumerate() {
        let url = href.map(|h| resolve_ddg_url(&h)).unwrap_or_default();
        let snippet = snippets.get(i).cloned().unwrap_or_default();
        lines.push(format!("- {title} — {url}\n  {snippet}"));
    }
    Ok(lines.join("\n"))
}

/// Last-resort fallback: the DuckDuckGo Instant Answer API (knowledge graph).
async fn duckduckgo_instant_answer(
    query: &str,
    client: &reqwest::Client,
) -> Result<String, ToolError> {
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
        urlencoding_lite(query)
    );
    let response = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| ToolError::ExecutionError(format!("Search failed: {e}")))?;
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| ToolError::ExecutionError(format!("Parse failed: {e}")))?;

    let mut lines = vec![format!("Query: {}", query)];
    if let Some(heading) = json.get("Heading").and_then(|v| v.as_str()) {
        if !heading.is_empty() {
            lines.push(format!("Heading: {heading}"));
        }
    }
    if let Some(abs) = json.get("AbstractText").and_then(|v| v.as_str()) {
        if !abs.is_empty() {
            lines.push(format!("Abstract: {abs}"));
        }
    }
    if let Some(abs_url) = json.get("AbstractURL").and_then(|v| v.as_str()) {
        if !abs_url.is_empty() {
            lines.push(format!("Source: {abs_url}"));
        }
    }
    if let Some(related) = json.get("RelatedTopics").and_then(|v| v.as_array()) {
        lines.push("Related:".to_string());
        let mut count = 0;
        for item in related {
            if count >= 8 {
                break;
            }
            if let Some(text) = item.get("Text").and_then(|v| v.as_str()) {
                let url = item.get("FirstURL").and_then(|v| v.as_str()).unwrap_or("");
                lines.push(format!("- {text} {url}"));
                count += 1;
            } else if let Some(topics) = item.get("Topics").and_then(|v| v.as_array()) {
                for nested in topics {
                    if count >= 8 {
                        break;
                    }
                    if let Some(text) = nested.get("Text").and_then(|v| v.as_str()) {
                        let url = nested
                            .get("FirstURL")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        lines.push(format!("- {text} {url}"));
                        count += 1;
                    }
                }
            }
        }
    }
    if lines.len() <= 1 {
        lines.push("No structured results. Try web_fetch on a specific documentation URL.".into());
    }
    Ok(lines.join("\n"))
}

/// One parsed DuckDuckGo HTML result.
struct DdgResult {
    title: String,
    url: String,
    snippet: String,
}

/// Parse the DuckDuckGo HTML results page: `result__a` anchors carry the
/// title + redirect link, `result__snippet` anchors carry the snippet text.
fn parse_ddg_html_results(html: &str) -> Vec<DdgResult> {
    let titled = collect_anchors(html, "result__a");
    let snippets = collect_anchors(html, "result__snippet");
    let mut results = Vec::with_capacity(titled.len());
    for (i, (title, href)) in titled.into_iter().enumerate() {
        results.push(DdgResult {
            title,
            url: href.map(|h| resolve_ddg_url(&h)).unwrap_or_default(),
            snippet: snippets.get(i).map(|(t, _)| t.clone()).unwrap_or_default(),
        });
    }
    results
}

/// Collect `(inner_text, href)` for every anchor whose class attribute
/// contains `class_marker` (e.g. `result__a`). Tolerant of markup drift.
fn collect_anchors(html: &str, class_marker: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = html[from..].find(class_marker) {
        let marker_pos = from + rel;
        // Find the opening `<a` tag that contains the marker.
        let tag_start = html[..marker_pos].rfind("<a ").unwrap_or(marker_pos);
        let tag_end = html[marker_pos..]
            .find('>')
            .map(|p| marker_pos + p)
            .unwrap_or(html.len());
        let tag = &html[tag_start..tag_end];
        let href = extract_attr(tag, "href");
        // Inner text runs from after '>' until '</a>'.
        let inner_start = tag_end + 1;
        let inner_end = html[inner_start..]
            .find("</a>")
            .map(|p| inner_start + p)
            .unwrap_or(html.len());
        out.push((strip_html_rough(&html[inner_start..inner_end]), href));
        from = inner_end.saturating_add(4);
    }
    out
}

/// Collect the text of every `<td class="result-snippet">…</td>` cell
/// (DuckDuckGo Lite layout).
fn collect_cells(html: &str, class_marker: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = html[from..].find(class_marker) {
        let marker_pos = from + rel;
        let open = html[marker_pos..]
            .find('>')
            .map(|p| marker_pos + p)
            .unwrap_or(html.len());
        let end = html[open + 1..]
            .find("</td>")
            .map(|p| open + 1 + p)
            .unwrap_or(html.len());
        out.push(strip_html_rough(&html[open + 1..end]));
        from = end.saturating_add(5);
    }
    out
}

fn extract_attr(tag: &str, name: &str) -> Option<String> {
    let pat = format!("{name}=\"");
    let start = tag.find(&pat)? + pat.len();
    let end = tag[start..].find('"')? + start;
    Some(tag[start..end].to_string())
}

/// DuckDuckGo HTML links are redirect wrappers:
/// `//duckduckgo.com/l/?uddg=<url-encoded>&rut=…`. Pull out the real URL.
fn resolve_ddg_url(href: &str) -> String {
    if let Some(uddg) = href.split("uddg=").nth(1) {
        let clean = uddg.split('&').next().unwrap_or(uddg);
        let decoded = percent_decode(clean);
        if decoded.starts_with("http://") || decoded.starts_with("https://") {
            return decoded;
        }
    }
    if let Some(rest) = href.strip_prefix("//") {
        format!("https://{rest}")
    } else if href.starts_with('/') {
        format!("https://duckduckgo.com{href}")
    } else {
        href.to_string()
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn strip_html_rough(html: &str) -> String {
    // Collect raw bytes and decode once at the end: `bytes[i] as char`
    // re-encoded every UTF-8 continuation byte as Latin-1 and mojibaked any
    // non-ASCII page.
    let mut out: Vec<u8> = Vec::with_capacity(html.len() / 2);
    let mut in_tag = false;
    let mut in_script = false;
    let lower = html.to_ascii_lowercase();
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // `get(i..)` is None at non-char-boundary positions (mid multi-byte
        // glyph), which the byte loop can land on.
        if !in_tag
            && lower
                .get(i..)
                .is_some_and(|rest| rest.starts_with("<script"))
        {
            in_script = true;
        }
        if in_script
            && lower
                .get(i..)
                .is_some_and(|rest| rest.starts_with("</script"))
        {
            in_script = false;
        }
        let c = bytes[i];
        match c {
            b'<' => in_tag = true,
            b'>' => in_tag = false,
            _ if !in_tag && !in_script => out.push(c),
            _ => {}
        }
        i += 1;
    }
    // Collapse whitespace
    let text = String::from_utf8_lossy(&out);
    let mut collapsed = String::with_capacity(text.len());
    let mut prev_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                collapsed.push(' ');
                prev_space = true;
            }
        } else {
            collapsed.push(ch);
            prev_space = false;
        }
    }
    collapsed.trim().to_string()
}

fn urlencoding_lite(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{Tool, TypedTool};

    #[test]
    fn parses_ddg_html_results() {
        let html = r#"<html><body>
            <div class="result">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc">Example Docs</a>
            <a class="result__snippet" href="//duckduckgo.com/l/?uddg=...">The <b>example</b> documentation page</a>
            </div>
            <div class="result">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcrates.io%2Fserde&rut=1">serde - crates.io</a>
            <a class="result__snippet" href="//duckduckgo.com/l/?uddg=...">Serialization framework for <b>Rust</b></a>
            </div>
        </body></html>"#;
        let results = parse_ddg_html_results(html);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Example Docs");
        assert_eq!(results[0].url, "https://example.com/docs");
        assert!(results[0].snippet.contains("example documentation"));
        assert_eq!(results[1].title, "serde - crates.io");
        assert_eq!(results[1].url, "https://crates.io/serde");
    }

    #[test]
    fn parses_lite_results() {
        let html = r#"<table><tr><td><a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org">The Rust Programming Language</a></td>
        <td class="result-snippet">A language empowering everyone to build reliable software.</td></tr></table>"#;
        let links = collect_anchors(html, "result-link");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].0, "The Rust Programming Language");
        assert_eq!(
            links[0].1.as_deref(),
            Some("//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org")
        );
        let snippets = collect_cells(html, "result-snippet");
        assert_eq!(snippets.len(), 1);
        assert!(snippets[0].contains("reliable software"));
    }

    #[test]
    fn percent_decode_handles_encoded_urls() {
        assert_eq!(
            percent_decode("https%3A%2F%2Fexample.com%2Fa%20b"),
            "https://example.com/a b"
        );
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("100%25"), "100%");
    }

    #[test]
    fn resolve_ddg_url_extracts_uddg_and_prefixes_protocol() {
        assert_eq!(
            resolve_ddg_url("//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.io%2Fp&rut=1"),
            "https://x.io/p"
        );
        assert_eq!(resolve_ddg_url("//example.com/x"), "https://example.com/x");
        assert_eq!(
            resolve_ddg_url("/local/path"),
            "https://duckduckgo.com/local/path"
        );
    }

    #[test]
    fn web_fetch_schema_documents_args() {
        let schema = TypedTool::new(WebFetchTool).parameters();
        assert_eq!(
            schema["properties"]["url"]["description"],
            "Full URL to fetch (https preferred)"
        );
        assert_eq!(
            schema["properties"]["max_chars"]["description"],
            "Maximum characters to return (default 20000)"
        );
    }

    #[test]
    fn web_search_schema_documents_args() {
        let schema = TypedTool::new(WebSearchTool).parameters();
        assert_eq!(schema["properties"]["query"]["description"], "Search query");
    }

    #[tokio::test]
    #[ignore = "requires live network"]
    async fn live_html_search_returns_real_results() {
        let client = reqwest::Client::new();
        let out = duckduckgo_html_search("rust programming language", &client)
            .await
            .expect("live search should not fail");
        eprintln!("=== live results ===\n{out}");
        assert!(
            out.lines().count() > 3,
            "expected several result lines, got: {out}"
        );
    }

    #[test]
    fn ssrf_guard_blocks_internal_addresses() {
        let blocked = [
            "http://127.0.0.1/",
            "http://localhost:8080/",
            "http://[::1]/",
            "http://10.0.0.5/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://foo.internal/",
        ];
        for url in blocked {
            let parsed = reqwest::Url::parse(url).unwrap();
            assert!(is_forbidden_host(&parsed), "{url} must be blocked");
        }
        // IP-literal public host needs no DNS and must pass.
        let public = reqwest::Url::parse("https://93.184.216.34/").unwrap();
        assert!(!is_forbidden_host(&public));
    }

    #[tokio::test]
    async fn web_fetch_refuses_loopback_without_network() {
        let err = TypedTool::new(WebFetchTool)
            .execute(serde_json::json!({"url": "http://127.0.0.1:9/secret"}), ".")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("private/loopback"), "{err}");
    }

    #[test]
    fn strip_html_preserves_non_ascii() {
        assert_eq!(strip_html_rough("<p>café 日本語</p>"), "café 日本語");
        assert_eq!(
            strip_html_rough("<div><script>x()</script>Grüße <b>Welt</b></div>"),
            "Grüße Welt"
        );
    }
}
