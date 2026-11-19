//! Network research tools (permission-gated by the agent permission engine).
//!
//! `web_fetch` reads a page as markdown ([`extract`]) and hands over the
//! whole page; only when the model asks for `max_chars` does it come in parts
//! that the result says how to continue (`offset`), never cut off silently.
//! `web_search` ([`search`]) uses the provider chosen in `web.json`.

pub mod extract;
pub mod search;
pub mod settings;

pub use search::WebSearchTool;

use std::net::{IpAddr, ToSocketAddrs};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use futures::StreamExt;

use super::{ToolCore, ToolError, ToolExecutionContext, ToolExecutionMode};

/// A page is read up to this size; html5ever copes with a cut document.
const MAX_FETCH_BYTES: usize = 8 * 1024 * 1024;
/// Most sites answer an unknown agent with a bot wall or a 403, so pages are
/// requested the way a browser asks for them.
pub(crate) const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/// Pages read in this session, so continuing with `offset` does not
/// download the page again.
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const CACHE_ENTRIES: usize = 12;

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
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
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
    /// Read the page in parts of this many characters (default: the whole page)
    #[serde(default)]
    pub max_chars: Option<usize>,
    /// Character offset to start from (a previous part says which)
    #[serde(default)]
    pub offset: Option<usize>,
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
        "Read a public HTTP/HTTPS page as clean markdown: the main content with headings, lists, tables, code and links, without menus, ads or scripts. JSON and plain text come back as they are. The whole page comes back; pass max_chars to read it in parts (each part says which offset continues it). Prefer local files when available."
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
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(ToolError::InvalidArguments(format!(
                "Only http and https URLs can be fetched, not {}",
                parsed.scheme()
            )));
        }
        if is_forbidden_host(&parsed) {
            return Err(ToolError::ExecutionError(format!(
                "Refusing to fetch {url}: private/loopback addresses are blocked"
            )));
        }

        let max_chars = args.max_chars.map(|n| n.max(1_000));
        let page = match cached(&url) {
            Some(page) => page,
            None => {
                let page = Arc::new(fetch_page(parsed).await?);
                remember(&url, page.clone());
                page
            }
        };
        Ok(render_part(&page, args.offset.unwrap_or(0), max_chars))
    }
}

/// A page as read: its text and what the reader should know about it.
#[derive(Debug, Clone, Default)]
struct Fetched {
    url: String,
    title: String,
    text: String,
    notes: Vec<String>,
}

type PageCache = parking_lot::Mutex<Vec<(String, Instant, Arc<Fetched>)>>;

fn page_cache() -> &'static PageCache {
    static CACHE: OnceLock<PageCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn cached(url: &str) -> Option<Arc<Fetched>> {
    let mut cache = page_cache().lock();
    cache.retain(|(_, at, _)| at.elapsed() < CACHE_TTL);
    cache
        .iter()
        .find(|(key, _, _)| key == url)
        .map(|(_, _, page)| page.clone())
}

fn remember(url: &str, page: Arc<Fetched>) {
    let mut cache = page_cache().lock();
    cache.retain(|(key, _, _)| key != url);
    if cache.len() >= CACHE_ENTRIES {
        cache.remove(0);
    }
    cache.push((url.to_string(), Instant::now(), page));
}

async fn fetch_page(url: reqwest::Url) -> Result<Fetched, ToolError> {
    let client = shared_http_client()?;
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, BROWSER_UA)
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        )
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| ToolError::ExecutionError(format!("Request failed: {e}")))?;

    let final_url = response.url().clone();
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    // Stop reading at the cap instead of buffering an unbounded body.
    let mut stream = response.bytes_stream();
    let mut bytes: Vec<u8> = Vec::with_capacity(256 * 1024);
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

    let mut page = Fetched {
        url: final_url.to_string(),
        ..Fetched::default()
    };
    if overflow {
        page.notes.push(format!(
            "The response is larger than {} MB; only the first {} MB was read.",
            MAX_FETCH_BYTES / (1024 * 1024),
            MAX_FETCH_BYTES / (1024 * 1024)
        ));
    }

    match classify(&content_type, &bytes) {
        Kind::Html => {
            let html = decode(&bytes, &content_type);
            let extracted = extract::extract(&html, Some(&final_url));
            page.title = extracted.title;
            page.text = if extracted.markdown.trim().is_empty() {
                extracted.description
            } else {
                extracted.markdown
            };
            if extracted.body_chars < 400 && bytes.len() > 20_000 {
                page.notes.push(
                    "Little text is in this page's HTML — it is probably drawn by JavaScript. \
                     If the browser extension is connected, open the page there \
                     (web_browser_open) and read it with web_page_extract."
                        .into(),
                );
            }
        }
        Kind::Json => {
            let text = decode(&bytes, &content_type);
            page.text = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|value| serde_json::to_string_pretty(&value).ok())
                .unwrap_or(text);
        }
        Kind::Text => page.text = decode(&bytes, &content_type),
        Kind::Pdf => {
            return Err(ToolError::ExecutionError(format!(
                "{} is a PDF. web_fetch reads HTML, JSON and text; download it (curl -L -o file.pdf <url>) and extract its text with a PDF tool, or open it in the browser.",
                page.url
            )))
        }
        Kind::Binary => {
            return Err(ToolError::ExecutionError(format!(
                "{} returned {} — not text. web_fetch reads HTML, JSON and text.",
                page.url,
                if content_type.is_empty() {
                    "binary data"
                } else {
                    content_type.as_str()
                }
            )))
        }
    }

    if !status.is_success() {
        let hint = match status.as_u16() {
            401 | 403 | 429 | 503 => {
                " The site refused an automated request. If the browser extension is connected, open the page there (web_browser_open) and read it with web_page_extract."
            }
            404 | 410 => " The page does not exist; search for its current address.",
            _ => "",
        };
        if page.text.trim().is_empty() {
            return Err(ToolError::ExecutionError(format!(
                "{} answered HTTP {}.{hint}",
                page.url,
                status.as_u16()
            )));
        }
        page.notes.push(format!("HTTP {}.{hint}", status.as_u16()));
    }
    Ok(page)
}

#[derive(Debug, PartialEq, Eq)]
enum Kind {
    Html,
    Json,
    Text,
    Pdf,
    Binary,
}

fn classify(content_type: &str, bytes: &[u8]) -> Kind {
    let mime = content_type.split(';').next().unwrap_or("").trim();
    if bytes.starts_with(b"%PDF") || mime == "application/pdf" {
        return Kind::Pdf;
    }
    if mime.contains("html") {
        return Kind::Html;
    }
    if mime.contains("json") {
        return Kind::Json;
    }
    if mime.starts_with("text/")
        || ["xml", "javascript", "yaml", "toml", "csv", "markdown"]
            .iter()
            .any(|kind| mime.contains(kind))
    {
        return Kind::Text;
    }
    if mime.is_empty() || mime == "application/octet-stream" {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
        if head.contains("<html") || head.contains("<!doctype html") || head.contains("<body") {
            return Kind::Html;
        }
        if std::str::from_utf8(&bytes[..bytes.len().min(4096)]).is_ok() && !bytes.contains(&0) {
            return Kind::Text;
        }
    }
    Kind::Binary
}

/// Bytes to text in the page's own encoding: the header's charset, else a
/// `<meta charset>` in the first bytes, else UTF-8 (a BOM wins over both).
fn decode(bytes: &[u8], content_type: &str) -> String {
    let label = charset_in(content_type).or_else(|| {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
        charset_in(&head)
    });
    let encoding = label
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

fn charset_in(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let start = lower.find("charset=")? + "charset=".len();
    let label: String = lower[start..]
        .trim_start_matches(['"', '\'', ' '])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        .collect();
    (!label.is_empty()).then_some(label)
}

/// The page from `offset` — all of it, or with `max_chars` one part that
/// says where it is and how to go on, ending at a paragraph boundary.
fn render_part(page: &Fetched, offset: usize, max_chars: Option<usize>) -> String {
    let total = page.text.chars().count();
    let mut out = String::new();
    if !page.title.is_empty() {
        out.push_str(&format!("# {}\n", page.title));
    }
    out.push_str(&format!("URL: {}\n", page.url));
    for note in &page.notes {
        out.push_str(&format!("Note: {note}\n"));
    }
    if total == 0 {
        out.push_str("\n(The page has no readable text.)");
        return out;
    }
    if offset >= total {
        out.push_str(&format!(
            "\nThe page has {total} characters; offset {offset} is past its end."
        ));
        return out;
    }
    let (part, end) = window(&page.text, offset, max_chars.unwrap_or(usize::MAX));
    if offset > 0 || end < total {
        out.push_str(&format!("Part: characters {offset}–{end} of {total}."));
        if end < total {
            out.push_str(&format!(" Continue with offset={end}."));
        }
        out.push('\n');
    }
    out.push('\n');
    out.push_str(part.trim_end());
    if end < total {
        out.push_str(&format!(
            "\n\n[{} more characters — call web_fetch with offset={end} to continue]",
            total - end
        ));
    }
    out
}

/// Up to `max` characters from char `offset`, ending at a paragraph (else
/// line, else word) boundary in the part's last 40% when the text goes on.
/// Returns the part and the char offset it ends at.
fn window(text: &str, offset: usize, max: usize) -> (&str, usize) {
    let byte_at = |chars: usize| {
        text.char_indices()
            .nth(chars)
            .map(|(i, _)| i)
            .unwrap_or(text.len())
    };
    let start = byte_at(offset);
    let rest = &text[start..];
    let limit = rest
        .char_indices()
        .nth(max)
        .map(|(i, _)| i)
        .unwrap_or(rest.len());
    if limit == rest.len() {
        return (rest, offset + rest.chars().count());
    }
    let candidate = &rest[..limit];
    let floor = limit * 3 / 5;
    let cut = ["\n\n", "\n", " "]
        .iter()
        .find_map(|sep| {
            candidate
                .rfind(sep)
                .filter(|&i| i > floor)
                .map(|i| i + sep.len())
        })
        .unwrap_or(limit);
    let part = &rest[..cut];
    (part, offset + part.chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{Tool, TypedTool};

    #[test]
    fn web_fetch_schema_documents_args() {
        let schema = TypedTool::new(WebFetchTool).parameters();
        assert_eq!(
            schema["properties"]["url"]["description"],
            "Full URL to fetch (https preferred)"
        );
        assert!(schema["properties"]["offset"].is_object());
        assert!(schema["properties"]["max_chars"].is_object());
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

    #[tokio::test]
    async fn web_fetch_refuses_other_schemes() {
        let err = TypedTool::new(WebFetchTool)
            .execute(serde_json::json!({"url": "file:///etc/passwd"}), ".")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("http and https"), "{err}");
    }

    #[test]
    fn a_long_page_comes_in_parts_that_say_how_to_continue() {
        let text = (0..50)
            .map(|i| format!("Paragraph {i} with some words in it."))
            .collect::<Vec<_>>()
            .join("\n\n");
        let page = Fetched {
            url: "https://example.com/a".into(),
            title: "A".into(),
            text: text.clone(),
            notes: vec![],
        };
        let first = render_part(&page, 0, Some(400));
        assert!(
            first.starts_with("# A\nURL: https://example.com/a\nPart: characters 0–"),
            "{first}"
        );
        let next: usize = first
            .split("Continue with offset=")
            .nth(1)
            .and_then(|rest| rest.split('.').next())
            .and_then(|n| n.parse().ok())
            .expect("first part names the next offset");
        assert!(first
            .trim_end()
            .ends_with(&format!("offset={next} to continue]")));
        // The cut lands between paragraphs, and the next part starts where it ended.
        let body_end = first.rfind("\n\n[").unwrap();
        assert!(first[..body_end].ends_with("in it."), "{first}");
        let second = render_part(&page, next, Some(400));
        assert!(
            second.contains(&format!("Part: characters {next}–")),
            "{second}"
        );
        let tail = render_part(&page, 0, None);
        assert!(!tail.contains("Part:"), "the whole page by default");
        assert!(tail.ends_with("Paragraph 49 with some words in it."));
        let past = render_part(&page, text.chars().count() + 5, Some(400));
        assert!(past.contains("past its end"));
    }

    /// `AGENTE_FETCH_URL=<url> cargo test -p agente-core live_fetch -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "requires live network"]
    async fn live_fetch_reads_a_real_page() {
        let url = std::env::var("AGENTE_FETCH_URL")
            .unwrap_or_else(|_| "https://doc.rust-lang.org/book/ch00-00-introduction.html".into());
        let out = TypedTool::new(WebFetchTool)
            .execute(serde_json::json!({ "url": url }), ".")
            .await
            .expect("live fetch should not fail");
        eprintln!("{out}");
        assert!(out.contains("URL: "));
    }

    #[test]
    fn window_counts_characters_not_bytes() {
        let (part, end) = window("été été été", 4, 3);
        assert_eq!(part, "été");
        assert_eq!(end, 7);
    }

    #[test]
    fn content_is_classified_by_type_and_bytes() {
        assert_eq!(classify("text/html; charset=utf-8", b"<p>"), Kind::Html);
        assert_eq!(classify("application/json", b"{}"), Kind::Json);
        assert_eq!(classify("text/plain", b"hi"), Kind::Text);
        assert_eq!(classify("application/pdf", b""), Kind::Pdf);
        assert_eq!(classify("", b"%PDF-1.7"), Kind::Pdf);
        assert_eq!(classify("", b"<!DOCTYPE html><html>"), Kind::Html);
        assert_eq!(classify("image/png", b"\x89PNG"), Kind::Binary);
        assert_eq!(
            classify("application/octet-stream", b"\0\x01"),
            Kind::Binary
        );
    }

    #[test]
    fn decoding_follows_the_page_charset() {
        // "café" in Windows-1252.
        let bytes = b"caf\xe9";
        assert_eq!(decode(bytes, "text/plain; charset=windows-1252"), "café");
        let html = b"<html><head><meta charset=\"iso-8859-1\"></head><body>caf\xe9</body></html>";
        assert!(decode(html, "text/html").contains("café"));
        assert_eq!(decode("naïve".as_bytes(), "text/plain"), "naïve");
    }
}
