//! `web_search`: the configured provider (`web.json`), DuckDuckGo when none
//! is set or the configured one fails — and the result says which answered.

use scraper::{Html, Selector};
use serde_json::{json, Value};

use super::extract::html_text;
use super::settings::{api_key, SearchProvider, WebSettings};
use super::{searxng_http_client, shared_http_client};
use crate::tools::{ToolCore, ToolError, ToolExecutionContext, ToolExecutionMode};

/// Browser-like UA for the DuckDuckGo HTML endpoints (they refuse plain bots).
const BROWSER_UA: &str = super::BROWSER_UA;
const SNIPPET_CHARS: usize = 320;

/// Arguments accepted by the `web_search` tool.
#[derive(Debug, Default, serde::Deserialize, schemars::JsonSchema)]
pub struct WebSearchArgs {
    /// Search query
    #[serde(default)]
    pub query: Option<String>,
    /// How many results to return (1-20; default from settings, usually 8)
    #[serde(default)]
    pub max_results: Option<usize>,
}

/// One search hit.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Hit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Structured web search using the configured (or overridden) core provider,
/// falling back to DuckDuckGo when needed.
pub async fn search_structured(
    query: &str,
    max_results: Option<usize>,
    provider_override: Option<SearchProvider>,
) -> Result<(SearchProvider, Vec<Hit>, Vec<String>), ToolError> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err(ToolError::InvalidArguments("Query is empty".into()));
    }
    let settings = WebSettings::load();
    let count = max_results.unwrap_or(settings.results()).clamp(1, 20);
    let configured = provider_override.unwrap_or(settings.search_provider);

    let mut notes = Vec::new();
    if configured != SearchProvider::DuckDuckGo {
        match search_with(configured, &settings, &query, count).await {
            Ok(hits) if !hits.is_empty() => return Ok((configured, hits, notes)),
            Ok(_) => notes.push(format!("{} found nothing.", configured.label())),
            Err(err) => notes.push(format!("{} failed: {err}.", configured.label())),
        }
    }
    match duckduckgo(&query, count).await {
        Ok(hits) => Ok((SearchProvider::DuckDuckGo, hits, notes)),
        Err(err) => {
            notes.push(format!("DuckDuckGo failed: {err}."));
            Err(ToolError::ExecutionError(format!(
                "Search failed for \"{query}\".\n{}",
                notes.join("\n")
            )))
        }
    }
}

#[derive(Default)]
pub struct WebSearchTool;

impl ToolCore for WebSearchTool {
    type Args = WebSearchArgs;

    fn name(&self) -> &str {
        "web_search"
    }
    fn kind(&self) -> crate::tools::ToolKind {
        crate::tools::ToolKind::Web
    }

    fn description(&self) -> &str {
        "Search the public web. Returns numbered results with title, URL and snippet. Read a result with web_fetch. Use for up-to-date docs, APIs and research; prefer local project files first."
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
        let settings = WebSettings::load();
        let count = args.max_results.unwrap_or(settings.results()).clamp(1, 20);
        let configured = settings.search_provider;

        let mut notes = Vec::new();
        if configured != SearchProvider::DuckDuckGo {
            match search_with(configured, &settings, &query, count).await {
                Ok(hits) if !hits.is_empty() => {
                    return Ok(render(&query, configured, &hits, &notes))
                }
                Ok(_) => notes.push(format!("{} found nothing.", configured.label())),
                Err(err) => notes.push(format!("{} failed: {err}.", configured.label())),
            }
        }
        match duckduckgo(&query, count).await {
            Ok(hits) if !hits.is_empty() => {
                Ok(render(&query, SearchProvider::DuckDuckGo, &hits, &notes))
            }
            Ok(_) => {
                notes.push("DuckDuckGo found nothing.".into());
                Ok(format!(
                    "Query: {query}\n{}\nNo results. Try other words, or web_fetch a documentation URL you know.",
                    notes.join("\n")
                ))
            }
            Err(err) => {
                notes.push(format!("DuckDuckGo failed: {err}."));
                Err(ToolError::ExecutionError(format!(
                    "Search failed for \"{query}\".\n{}\nConfigure a search provider with an API key in /settings (Web search).",
                    notes.join("\n")
                )))
            }
        }
    }
}

fn render(query: &str, provider: SearchProvider, hits: &[Hit], notes: &[String]) -> String {
    let mut out = format!("Query: {query} · via {}\n", provider.label());
    for note in notes {
        out.push_str(note);
        out.push('\n');
    }
    for (i, hit) in hits.iter().enumerate() {
        out.push_str(&format!("\n{}. {}\n   {}", i + 1, hit.title, hit.url));
        if !hit.snippet.is_empty() {
            out.push_str(&format!("\n   {}", hit.snippet));
        }
        out.push('\n');
    }
    out.trim_end().to_string()
}

async fn search_with(
    provider: SearchProvider,
    settings: &WebSettings,
    query: &str,
    count: usize,
) -> Result<Vec<Hit>, String> {
    let client = shared_http_client().map_err(|e| e.to_string())?;
    let key = || {
        api_key(provider).ok_or_else(|| {
            format!(
                "no API key (set it in /settings or {})",
                provider.key_vars().join(" / ")
            )
        })
    };
    let request = match provider {
        SearchProvider::DuckDuckGo => return duckduckgo(query, count).await,
        SearchProvider::Brave => client
            .get("https://api.search.brave.com/res/v1/web/search")
            .query(&[("q", query), ("count", &count.to_string())])
            .header("X-Subscription-Token", key()?)
            .header("Accept", "application/json"),
        SearchProvider::Tavily => {
            let key = key()?;
            client
                .post("https://api.tavily.com/search")
                .bearer_auth(&key)
                .json(&json!({ "api_key": key, "query": query, "max_results": count, "include_answer": false }))
        }
        SearchProvider::Exa => client
            .post("https://api.exa.ai/search")
            .header("x-api-key", key()?)
            .json(&json!({ "query": query, "numResults": count, "contents": { "text": { "maxCharacters": SNIPPET_CHARS } } })),
        SearchProvider::SearXng => {
            let base = settings
                .searxng_base()
                .ok_or("no SearXNG URL (set it in /settings or SEARXNG_URL)")?;
            let base_url =
                reqwest::Url::parse(&base).map_err(|e| format!("invalid SearXNG URL ({e})"))?;
            let searx_client = searxng_http_client(&base_url).map_err(|e| e.to_string())?;
            searx_client
                .get(format!("{base}/search"))
                .query(&[("q", query), ("format", "json")])
        }
    };
    let response = request
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("request failed ({e})"))?;
    let status = response.status();
    if !status.is_success() {
        let hint = match status.as_u16() {
            401 | 403 => " — check the API key",
            429 => " — rate limited or out of credits",
            _ => "",
        };
        return Err(format!("HTTP {}{hint}", status.as_u16()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("unreadable response ({e})"))?;
    Ok(parse_json_hits(provider, &body, count))
}

/// Results from a provider's JSON: each names its fields a little differently.
fn parse_json_hits(provider: SearchProvider, body: &Value, count: usize) -> Vec<Hit> {
    let items = match provider {
        SearchProvider::Brave => body.pointer("/web/results"),
        _ => body.get("results"),
    };
    let snippet_keys: &[&str] = match provider {
        SearchProvider::Brave => &["description"],
        SearchProvider::Exa => &["text", "summary"],
        _ => &["content", "snippet", "description"],
    };
    items
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let url = item.get("url")?.as_str()?.trim().to_string();
            if url.is_empty() {
                return None;
            }
            let title = item
                .get("title")
                .and_then(Value::as_str)
                .map(html_text)
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| url.clone());
            let snippet = snippet_keys
                .iter()
                .find_map(|key| item.get(*key).and_then(Value::as_str))
                .map(|s| clip(&html_text(s), SNIPPET_CHARS))
                .unwrap_or_default();
            Some(Hit {
                title,
                url,
                snippet,
            })
        })
        .take(count)
        .collect()
}

// ── DuckDuckGo ────────────────────────────────────────────────────────

/// The HTML results page, then the lighter Lite page.
async fn duckduckgo(query: &str, count: usize) -> Result<Vec<Hit>, String> {
    let mut last_error = String::new();
    for (url, parse) in [
        (
            "https://html.duckduckgo.com/html/",
            parse_ddg_html as fn(&str) -> Vec<Hit>,
        ),
        ("https://lite.duckduckgo.com/lite/", parse_ddg_lite),
    ] {
        match ddg_page(url, query).await {
            Ok(html) => {
                let hits = parse(&html);
                if !hits.is_empty() {
                    return Ok(hits.into_iter().take(count).collect());
                }
                if html.contains("anomaly") || html.contains("challenge-form") {
                    last_error = "DuckDuckGo asked for a bot check (too many searches from this address); try again later or set a search provider".into();
                }
            }
            Err(err) => last_error = err,
        }
    }
    if last_error.is_empty() {
        Ok(Vec::new())
    } else {
        Err(last_error)
    }
}

async fn ddg_page(url: &str, query: &str) -> Result<String, String> {
    let client = shared_http_client().map_err(|e| e.to_string())?;
    let response = client
        .get(url)
        .query(&[("q", query)])
        .timeout(std::time::Duration::from_secs(20))
        .header(reqwest::header::USER_AGENT, BROWSER_UA)
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("request failed ({e})"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    response
        .text()
        .await
        .map_err(|e| format!("read failed ({e})"))
}

/// `html.duckduckgo.com`: one `.result` block per hit; ads are skipped.
fn parse_ddg_html(html: &str) -> Vec<Hit> {
    let document = Html::parse_document(html);
    let result = selector(".result");
    let link = selector("a.result__a");
    let snippet = selector(".result__snippet");
    document
        .select(&result)
        .filter(|block| {
            let class = block.value().attr("class").unwrap_or_default();
            !class.contains("result--ad")
        })
        .filter_map(|block| {
            let anchor = block.select(&link).next()?;
            let url = resolve_ddg_url(anchor.value().attr("href")?);
            if url.is_empty() || url.contains("duckduckgo.com/y.js") {
                return None;
            }
            let text = block
                .select(&snippet)
                .next()
                .map(|s| clip(&collapse_text(s.text()), SNIPPET_CHARS))
                .unwrap_or_default();
            Some(Hit {
                title: collapse_text(anchor.text()),
                url,
                snippet: text,
            })
        })
        .collect()
}

/// `lite.duckduckgo.com`: links and snippet cells in table rows, in order.
fn parse_ddg_lite(html: &str) -> Vec<Hit> {
    let document = Html::parse_document(html);
    let links: Vec<_> = document.select(&selector("a.result-link")).collect();
    let snippets: Vec<String> = document
        .select(&selector("td.result-snippet"))
        .map(|cell| clip(&collapse_text(cell.text()), SNIPPET_CHARS))
        .collect();
    links
        .into_iter()
        .enumerate()
        .filter_map(|(i, anchor)| {
            let url = resolve_ddg_url(anchor.value().attr("href")?);
            (!url.is_empty()).then(|| Hit {
                title: collapse_text(anchor.text()),
                url,
                snippet: snippets.get(i).cloned().unwrap_or_default(),
            })
        })
        .collect()
}

/// DuckDuckGo links are redirect wrappers
/// (`//duckduckgo.com/l/?uddg=<url-encoded>&rut=…`): pull out the real URL.
fn resolve_ddg_url(href: &str) -> String {
    let absolute = if let Some(rest) = href.strip_prefix("//") {
        format!("https://{rest}")
    } else if href.starts_with('/') {
        format!("https://duckduckgo.com{href}")
    } else {
        href.to_string()
    };
    let Ok(url) = reqwest::Url::parse(&absolute) else {
        return String::new();
    };
    if url
        .host_str()
        .is_some_and(|h| h.ends_with("duckduckgo.com"))
    {
        if let Some((_, target)) = url.query_pairs().find(|(key, _)| key == "uddg") {
            if target.starts_with("http://") || target.starts_with("https://") {
                return target.into_owned();
            }
        }
    }
    absolute
}

fn selector(css: &str) -> Selector {
    Selector::parse(css).expect("static selector")
}

fn collapse_text<'a>(parts: impl Iterator<Item = &'a str>) -> String {
    parts
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Cut on a word boundary with an ellipsis.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    let cut = head
        .rfind(' ')
        .filter(|i| *i > max / 2)
        .unwrap_or(head.len());
    format!("{}…", head[..cut].trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::Tool;
    use crate::tools::TypedTool;

    #[test]
    fn parses_ddg_html_results_and_skips_ads() {
        let html = r##"<html><body>
            <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
            <div class="result">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc">Example Docs</a>
            <a class="result__snippet" href="//duckduckgo.com/l/?uddg=...">The <b>example</b> documentation &amp; page</a>
            </div>
            <div class="result">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcrates.io%2Fserde&rut=1">serde - crates.io</a>
            <a class="result__snippet" href="#">Serialization framework for <b>Rust</b></a>
            </div>
        </body></html>"##;
        let results = parse_ddg_html(html);
        assert_eq!(results.len(), 2, "{results:?}");
        assert_eq!(results[0].title, "Example Docs");
        assert_eq!(results[0].url, "https://example.com/docs");
        assert_eq!(results[0].snippet, "The example documentation & page");
        assert_eq!(results[1].url, "https://crates.io/serde");
    }

    #[test]
    fn parses_lite_results() {
        let html = r#"<table><tr><td><a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org">The Rust Programming Language</a></td>
        <td class="result-snippet">A language empowering everyone to build reliable software.</td></tr></table>"#;
        let hits = parse_ddg_lite(html);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "The Rust Programming Language");
        assert_eq!(hits[0].url, "https://www.rust-lang.org");
        assert!(hits[0].snippet.contains("reliable software"));
    }

    #[test]
    fn resolve_ddg_url_extracts_uddg_and_prefixes_protocol() {
        assert_eq!(
            resolve_ddg_url("//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.io%2Fp%20q&rut=1"),
            "https://x.io/p q"
        );
        assert_eq!(resolve_ddg_url("//example.com/x"), "https://example.com/x");
        assert_eq!(
            resolve_ddg_url("/local/path"),
            "https://duckduckgo.com/local/path"
        );
    }

    #[test]
    fn provider_json_becomes_hits() {
        let brave = json!({ "web": { "results": [
            { "title": "Tokio <strong>docs</strong>", "url": "https://tokio.rs", "description": "An <strong>async</strong> runtime &amp; more" }
        ]}});
        let hits = parse_json_hits(SearchProvider::Brave, &brave, 5);
        assert_eq!(
            hits,
            vec![Hit {
                title: "Tokio docs".into(),
                url: "https://tokio.rs".into(),
                snippet: "An async runtime & more".into()
            }]
        );
        let tavily = json!({ "results": [
            { "title": "A", "url": "https://a.dev", "content": "alpha" },
            { "title": "B", "url": "", "content": "dropped: no url" }
        ]});
        assert_eq!(parse_json_hits(SearchProvider::Tavily, &tavily, 5).len(), 1);
        let exa = json!({ "results": [{ "url": "https://e.dev", "text": "exa text" }] });
        let hits = parse_json_hits(SearchProvider::Exa, &exa, 5);
        assert_eq!(
            hits[0].title, "https://e.dev",
            "untitled hits show their URL"
        );
        assert_eq!(hits[0].snippet, "exa text");
    }

    #[test]
    fn rendering_numbers_hits_and_names_the_provider() {
        let hits = vec![Hit {
            title: "T".into(),
            url: "https://t.dev".into(),
            snippet: "S".into(),
        }];
        let out = render(
            "q",
            SearchProvider::DuckDuckGo,
            &hits,
            &["Brave Search failed: HTTP 401 — check the API key.".into()],
        );
        assert!(
            out.starts_with("Query: q · via DuckDuckGo\nBrave Search failed"),
            "{out}"
        );
        assert!(out.contains("1. T\n   https://t.dev\n   S"), "{out}");
    }

    #[test]
    fn clip_cuts_on_a_word() {
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("one two three four", 10), "one two…");
    }

    #[test]
    fn web_search_schema_documents_args() {
        let schema = TypedTool::new(WebSearchTool).parameters();
        assert_eq!(schema["properties"]["query"]["description"], "Search query");
        assert!(schema["properties"]["max_results"].is_object());
    }

    #[tokio::test]
    async fn searxng_allows_configured_localhost_origin_and_blocks_cross_origin_private_redirect() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // 1. Mock SearXNG on localhost that redirects same-origin `/search` -> `/v2/search`
        //    and returns valid JSON hits.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 2048];
                let n = socket.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");
                if first_line.starts_with("GET /search?") {
                    let resp = format!(
                        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/v2/search\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    socket.write_all(resp.as_bytes()).await.unwrap();
                } else {
                    let body = r#"{"results":[{"title":"Local Hit","url":"https://example.org","content":"ok"}]}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    socket.write_all(resp.as_bytes()).await.unwrap();
                }
            }
        });

        let settings = WebSettings {
            search_provider: SearchProvider::SearXng,
            searxng_url: Some(format!("http://127.0.0.1:{port}")),
            max_results: Some(5),
        };
        let hits = search_with(SearchProvider::SearXng, &settings, "rust", 5)
            .await
            .expect("configured localhost SearXNG with same-origin redirect should succeed");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Local Hit");
        server.await.unwrap();

        // 2. Redirect to a different private/loopback origin must still be blocked.
        let listener2 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port2 = listener2.local_addr().unwrap().port();
        let server2 = tokio::spawn(async move {
            let (mut socket, _) = listener2.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let _ = socket.read(&mut buf).await;
            let resp = "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = socket.write_all(resp.as_bytes()).await;
        });
        let settings2 = WebSettings {
            search_provider: SearchProvider::SearXng,
            searxng_url: Some(format!("http://127.0.0.1:{port2}")),
            max_results: Some(5),
        };
        let err = search_with(SearchProvider::SearXng, &settings2, "rust", 5)
            .await
            .expect_err("redirect from SearXNG to another internal IP must be blocked");
        assert!(err.contains("private/loopback"), "{err}");
        server2.await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires live network"]
    async fn live_duckduckgo_returns_real_results() {
        let hits = duckduckgo("rust programming language", 8)
            .await
            .expect("live search should not fail");
        eprintln!("{hits:#?}");
        assert!(hits.len() > 2);
    }
}
