//! Readable text from an HTML page: its main content as light markdown.
//!
//! `web_fetch` used to strip tags byte by byte, which kept stylesheets,
//! menus, cookie banners and undecoded entities and flattened the page into
//! one line. This parses the document (html5ever, through `scraper`), picks
//! the element that holds the content, drops the chrome around it, and
//! renders headings, paragraphs, lists, code, tables and links.

use std::sync::OnceLock;

use regex::Regex;
use scraper::{ElementRef, Html, Node, Selector};

/// What a page reads as once its chrome is gone.
#[derive(Debug, Clone, Default)]
pub struct Page {
    pub title: String,
    pub description: String,
    pub markdown: String,
    /// Readable characters in the whole body: next to the size of the HTML
    /// it tells a script-rendered shell from a page that has its text.
    pub body_chars: usize,
}

/// Parse `html` and render its main content. `base` resolves relative links.
pub fn extract(html: &str, base: Option<&reqwest::Url>) -> Page {
    let document = Html::parse_document(html);
    let title = page_title(&document);
    let description = meta(&document, "meta[name=description]")
        .or_else(|| meta(&document, "meta[property='og:description']"))
        .unwrap_or_default();

    let Some(body) = document.select(sel("body")).next() else {
        return Page {
            title,
            description,
            ..Page::default()
        };
    };
    let body_chars = score(body);
    let root = content_root(&document, body, body_chars);

    let mut writer = Writer::new(base);
    writer.children(root);
    writer.flush();
    let mut markdown = writer.finish();
    // The heading the page opens with is usually its title, said again.
    if let Some(rest) = markdown.strip_prefix(&format!("# {title}")) {
        markdown = rest.trim_start().to_string();
    }
    Page {
        title,
        description,
        markdown,
        body_chars,
    }
}

/// Plain text of an HTML fragment: a search snippet with `<b>` and entities.
pub fn html_text(fragment: &str) -> String {
    if !fragment.contains(['<', '&']) {
        return collapse(fragment);
    }
    let document = Html::parse_fragment(fragment);
    collapse(&document.root_element().text().collect::<String>())
}

// ── Picking the content ───────────────────────────────────────────────

/// Elements that usually hold a page's content, most specific last.
const CONTENT_SELECTOR: &str = "main, [role=main], article, #content, #main, #main-content, \
     .content, .main-content, .post-content, .entry-content, .article-body, .article-content, \
     .markdown-body, .post-body, .documentation, .docs-content, .prose";

/// The element to render: the most specific content candidate that holds
/// most of the best one's text, or the body when none holds much of it (a
/// sidebar `<article>` card must not win over the page).
fn content_root<'a>(document: &'a Html, body: ElementRef<'a>, body_chars: usize) -> ElementRef<'a> {
    let candidates: Vec<(ElementRef<'a>, usize)> = document
        .select(sel(CONTENT_SELECTOR))
        .filter(|el| !skipped(el))
        .map(|el| (el, score(el)))
        .collect();
    let Some(best) = candidates.iter().map(|(_, s)| *s).max() else {
        return body;
    };
    if best < 200 || best * 3 < body_chars {
        return body;
    }
    // Deepest candidate that still carries 80% of the best text: `<article>`
    // inside `<main>` wins when it is the content, not when it is a teaser.
    candidates
        .iter()
        .filter(|(_, s)| *s * 5 >= best * 4)
        .max_by_key(|(el, _)| el.ancestors().count())
        .map(|(el, _)| *el)
        .unwrap_or(body)
}

/// Readable characters under `el`, link text counted at a third: menus and
/// link farms are mostly links, prose is mostly not.
fn score(el: ElementRef) -> usize {
    fn walk(el: ElementRef, in_link: bool, prose: &mut usize, links: &mut usize) {
        for child in el.children() {
            match child.value() {
                Node::Text(text) => {
                    let n = text.trim().chars().count();
                    if in_link {
                        *links += n;
                    } else {
                        *prose += n;
                    }
                }
                Node::Element(_) => {
                    if let Some(child) = ElementRef::wrap(child) {
                        if !skipped(&child) {
                            let link = in_link || child.value().name() == "a";
                            walk(child, link, prose, links);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let (mut prose, mut links) = (0, 0);
    walk(el, false, &mut prose, &mut links);
    prose + links / 3
}

/// Tags that never carry content worth reading.
const DROP_TAGS: &[&str] = &[
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "nav",
    "footer", "aside", "form", "button", "select", "input", "textarea", "label", "dialog", "menu",
    "head", "link", "meta", "video", "audio", "map", "img", "picture", "source",
];

/// Chrome: hidden, navigational, or named like a banner, menu or share bar.
fn skipped(el: &ElementRef) -> bool {
    let value = el.value();
    let tag = value.name();
    if DROP_TAGS.contains(&tag) {
        return true;
    }
    if value.attr("hidden").is_some() || value.attr("aria-hidden") == Some("true") {
        return true;
    }
    if let Some(role) = value.attr("role") {
        if matches!(
            role,
            "navigation"
                | "banner"
                | "contentinfo"
                | "complementary"
                | "dialog"
                | "search"
                | "menu"
        ) {
            return true;
        }
    }
    if let Some(style) = value.attr("style") {
        let style: String = style
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .to_ascii_lowercase();
        if style.contains("display:none") || style.contains("visibility:hidden") {
            return true;
        }
    }
    if tag == "header" && el.select(sel("nav")).next().is_some() {
        return true;
    }
    if matches!(
        tag,
        "body"
            | "main"
            | "article"
            | "table"
            | "pre"
            | "code"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
    ) {
        return false;
    }
    let names = format!(
        "{} {}",
        value.attr("class").unwrap_or_default(),
        value.attr("id").unwrap_or_default()
    );
    if names.trim().is_empty() {
        return false;
    }
    unlikely().is_match(&names) && !maybe_content().is_match(&names)
}

/// Class/id words of page chrome (after Mozilla Readability's list).
fn unlikely() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(^|[\s_-])(ads?|advert\w*|banner|breadcrumbs?|comments?|community|cookie\w*|consent|disqus|gdpr|menu|modal|navbar|newsletter|outbrain|pagination|pager|popup|promo\w*|related|replies|share|sharing|shoutbox|sidebar|skip-?link|skyscraper|social|sponsor\w*|subscribe|taboola|toolbar|tooltip|site-header|site-footer|masthead)($|[\s_-])",
        )
        .expect("static regex")
    })
}

/// Names that mean content even when they also match [`unlikely`].
fn maybe_content() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(^|[\s_-])(article|body|column|content|main|post|entry|markdown|prose)($|[\s_-])",
        )
        .expect("static regex")
    })
}

// ── Rendering ─────────────────────────────────────────────────────────

const BLOCK_TAGS: &[&str] = &[
    "address",
    "article",
    "blockquote",
    "body",
    "center",
    "dd",
    "details",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "hr",
    "html",
    "li",
    "main",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
];

fn is_block(tag: &str) -> bool {
    BLOCK_TAGS.contains(&tag)
}

/// Collects rendered blocks; inline text gathers in `line` until a block
/// boundary flushes it as a paragraph.
struct Writer<'b> {
    blocks: Vec<String>,
    line: String,
    base: Option<&'b reqwest::Url>,
}

impl<'b> Writer<'b> {
    fn new(base: Option<&'b reqwest::Url>) -> Self {
        Self {
            blocks: Vec::new(),
            line: String::new(),
            base,
        }
    }

    fn flush(&mut self) {
        let text = tidy_inline(&self.line);
        self.line.clear();
        if has_words(&text) {
            self.blocks.push(text);
        }
    }

    fn block(&mut self, text: String) {
        self.flush();
        if has_words(&text) {
            self.blocks.push(text);
        }
    }

    /// Blocks joined, consecutive repeats (a title said twice) dropped.
    fn finish(self) -> String {
        let mut out: Vec<String> = Vec::with_capacity(self.blocks.len());
        for block in self.blocks {
            if out.last() != Some(&block) {
                out.push(block);
            }
        }
        out.join("\n\n")
    }

    fn children(&mut self, el: ElementRef) {
        for child in el.children() {
            match child.value() {
                Node::Text(text) => push_text(&mut self.line, text),
                Node::Element(_) => {
                    if let Some(child) = ElementRef::wrap(child) {
                        self.element(child);
                    }
                }
                _ => {}
            }
        }
    }

    fn element(&mut self, el: ElementRef) {
        if skipped(&el) {
            return;
        }
        let tag = el.value().name();
        match tag {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level = tag[1..].parse::<usize>().unwrap_or(2);
                let text = tidy_inline(&self.inline_children(el)).replace('\n', " ");
                if has_words(&text) {
                    self.block(format!("{} {text}", "#".repeat(level)));
                }
            }
            "br" => self.line.push('\n'),
            "hr" => self.block("---".into()),
            "pre" => self.block(code_block(el)),
            "ul" | "ol" => {
                let list = self.list(el, tag == "ol");
                if list.is_empty() {
                    self.flush();
                    self.children(el);
                    self.flush();
                } else {
                    self.block(list);
                }
            }
            "table" => match self.table(el) {
                Some(table) => self.block(table),
                None => {
                    self.flush();
                    self.children(el);
                    self.flush();
                }
            },
            "blockquote" => {
                let inner = self.sub(el);
                let quoted = inner
                    .lines()
                    .map(|line| {
                        if line.is_empty() {
                            ">".to_string()
                        } else {
                            format!("> {line}")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                self.block(quoted);
            }
            "dt" | "summary" => {
                let text = tidy_inline(&self.inline_children(el));
                if has_words(&text) {
                    self.block(format!("**{text}**"));
                }
            }
            _ if is_block(tag) || has_block_child(el) => {
                self.flush();
                self.children(el);
                self.flush();
            }
            _ => {
                let text = self.inline(el);
                self.line.push_str(&text);
            }
        }
    }

    /// Render `el`'s children as their own document.
    fn sub(&self, el: ElementRef) -> String {
        let mut writer = Writer::new(self.base);
        writer.children(el);
        writer.flush();
        writer.finish()
    }

    fn inline_children(&self, el: ElementRef) -> String {
        let mut out = String::new();
        for child in el.children() {
            match child.value() {
                Node::Text(text) => push_text(&mut out, text),
                Node::Element(_) => {
                    if let Some(child) = ElementRef::wrap(child) {
                        out.push_str(&self.inline(child));
                    }
                }
                _ => {}
            }
        }
        out
    }

    fn inline(&self, el: ElementRef) -> String {
        if skipped(&el) {
            return String::new();
        }
        match el.value().name() {
            "br" => "\n".into(),
            "code" | "kbd" | "samp" | "tt" => {
                let text = collapse(&el.text().collect::<String>());
                if text.is_empty() {
                    String::new()
                } else if text.contains('`') {
                    format!("`` {text} ``")
                } else {
                    format!("`{text}`")
                }
            }
            "strong" | "b" => wrap(&self.inline_children(el), "**"),
            "em" | "i" => wrap(&self.inline_children(el), "_"),
            "a" => {
                let text = tidy_inline(&self.inline_children(el)).replace('\n', " ");
                if !has_words(&text) {
                    return String::new();
                }
                match el.value().attr("href").and_then(|href| self.link(href)) {
                    Some(href) if href != text => format!("[{text}]({href})"),
                    _ => text,
                }
            }
            tag if is_block(tag) => format!(" {} ", self.inline_children(el)),
            _ => self.inline_children(el),
        }
    }

    /// Absolute http(s) target of a link; page anchors and scripts drop.
    fn link(&self, href: &str) -> Option<String> {
        let href = href.trim();
        if href.is_empty() || href.starts_with('#') {
            return None;
        }
        let url = match self.base {
            Some(base) => base.join(href).ok()?,
            None => reqwest::Url::parse(href).ok()?,
        };
        matches!(url.scheme(), "http" | "https").then(|| url.to_string())
    }

    fn list(&self, el: ElementRef, ordered: bool) -> String {
        let mut number = el
            .value()
            .attr("start")
            .and_then(|start| start.trim().parse::<usize>().ok())
            .unwrap_or(1);
        let mut items = Vec::new();
        for li in el.child_elements().filter(|c| c.value().name() == "li") {
            if skipped(&li) {
                continue;
            }
            let body = self.sub(li);
            if body.is_empty() {
                continue;
            }
            let marker = if ordered {
                format!("{number}.")
            } else {
                "-".to_string()
            };
            number += 1;
            // Tight items: an item's paragraphs and nested lists follow on
            // the next lines, indented under its marker.
            let indent = " ".repeat(marker.len() + 1);
            let mut lines = body.lines().filter(|line| !line.is_empty());
            let mut item = format!("{marker} {}", lines.next().unwrap_or_default());
            for line in lines {
                item.push('\n');
                item.push_str(&indent);
                item.push_str(line);
            }
            items.push(item);
        }
        items.join("\n")
    }

    /// A data table as a markdown table; `None` for layout tables (one
    /// column, one row, or tables nested in tables), which render as text.
    fn table(&self, el: ElementRef) -> Option<String> {
        let mut rows: Vec<ElementRef> = Vec::new();
        for child in el.child_elements() {
            match child.value().name() {
                "tr" => rows.push(child),
                "thead" | "tbody" | "tfoot" => {
                    rows.extend(child.child_elements().filter(|r| r.value().name() == "tr"))
                }
                _ => {}
            }
        }
        if el.select(sel("table table")).next().is_some() {
            return None;
        }
        let grid: Vec<Vec<String>> = rows
            .iter()
            .map(|row| {
                row.child_elements()
                    .filter(|c| matches!(c.value().name(), "td" | "th"))
                    .map(|cell| {
                        self.sub(cell)
                            .replace('\n', " ")
                            .replace('|', "\\|")
                            .trim()
                            .to_string()
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|row| row.iter().any(|cell| !cell.is_empty()))
            .collect();
        let columns = grid.iter().map(Vec::len).max().unwrap_or(0);
        if grid.len() < 2 || columns < 2 {
            return None;
        }
        let line = |row: &Vec<String>| {
            let cells: Vec<&str> = (0..columns)
                .map(|i| row.get(i).map(String::as_str).unwrap_or(""))
                .collect();
            format!("| {} |", cells.join(" | "))
        };
        let mut out = vec![line(&grid[0])];
        out.push(format!("|{}", " --- |".repeat(columns)));
        out.extend(grid[1..].iter().map(line));
        Some(out.join("\n"))
    }
}

fn has_block_child(el: ElementRef) -> bool {
    el.child_elements()
        .any(|child| is_block(child.value().name()) && !skipped(&child))
}

fn code_block(el: ElementRef) -> String {
    let class = el
        .value()
        .attr("class")
        .or_else(|| {
            el.child_elements()
                .find(|c| c.value().name() == "code")
                .and_then(|c| c.value().attr("class"))
        })
        .unwrap_or_default();
    let language = class
        .split_whitespace()
        .find_map(|c| {
            c.strip_prefix("language-")
                .or_else(|| c.strip_prefix("lang-"))
        })
        .unwrap_or_default();
    let text: String = el.text().collect();
    let text = text.trim_matches('\n').trim_end();
    if text.is_empty() {
        return String::new();
    }
    let fence = if text.contains("```") { "````" } else { "```" };
    format!("{fence}{language}\n{text}\n{fence}")
}

/// Source whitespace (newlines included) is one space; `<br>` adds a real
/// newline through the writer.
fn push_text(out: &mut String, text: &str) {
    let mut space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            space = true;
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(ch);
        }
    }
    if space {
        out.push(' ');
    }
}

/// Collapse spaces, keep `<br>` newlines, trim each line.
fn tidy_inline(text: &str) -> String {
    let lines: Vec<String> = text.split('\n').map(collapse).collect();
    let mut out = String::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&line);
    }
    out
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn wrap(inner: &str, marker: &str) -> String {
    let core = inner.trim();
    if core.is_empty() {
        return inner.to_string();
    }
    let lead = if inner.starts_with(char::is_whitespace) {
        " "
    } else {
        ""
    };
    let trail = if inner.ends_with(char::is_whitespace) {
        " "
    } else {
        ""
    };
    format!("{lead}{marker}{core}{marker}{trail}")
}

/// A block worth keeping: some letter or digit, not just bullets and bars.
fn has_words(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

fn page_title(document: &Html) -> String {
    meta(document, "meta[property='og:title']")
        .or_else(|| {
            document
                .select(sel("title"))
                .next()
                .map(|t| collapse(&t.text().collect::<String>()))
                .filter(|t| !t.is_empty())
        })
        .or_else(|| {
            document
                .select(sel("h1"))
                .next()
                .map(|t| collapse(&t.text().collect::<String>()))
        })
        .unwrap_or_default()
}

fn meta(document: &Html, selector: &str) -> Option<String> {
    let selector = Selector::parse(selector).ok()?;
    document
        .select(&selector)
        .next()
        .and_then(|m| m.value().attr("content"))
        .map(collapse)
        .filter(|text| !text.is_empty())
}

/// Compiled once per selector string; every selector here is a literal.
fn sel(selector: &'static str) -> &'static Selector {
    static CACHE: OnceLock<parking_lot::Mutex<Vec<(&'static str, &'static Selector)>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let mut cache = cache.lock();
    if let Some((_, compiled)) = cache.iter().find(|(s, _)| *s == selector) {
        return compiled;
    }
    let compiled: &'static Selector = Box::leak(Box::new(
        Selector::parse(selector).expect("static selector"),
    ));
    cache.push((selector, compiled));
    compiled
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md(html: &str) -> String {
        let base = reqwest::Url::parse("https://example.com/docs/page").unwrap();
        extract(html, Some(&base)).markdown
    }

    #[test]
    fn drops_chrome_and_keeps_the_article() {
        let html = r#"<html><head><title>Guide</title><style>.x{color:red}</style>
            <script>var tracking = 1;</script></head><body>
            <header><nav><a href="/">Home</a><a href="/blog">Blog</a></nav></header>
            <div class="cookie-banner">We use cookies. Accept?</div>
            <main><h1>Guide</h1><p>Install the tool with <code>cargo install</code> &amp; run it.</p>
            <h2>Usage</h2><p>Pass a <a href="../api">path</a> to read.</p></main>
            <footer>© 2026 Example · Privacy</footer>
            </body></html>"#;
        let out = md(html);
        assert!(
            out.contains("Install the tool with `cargo install` & run it."),
            "{out}"
        );
        assert!(out.contains("## Usage"), "{out}");
        assert!(out.contains("[path](https://example.com/api)"), "{out}");
        for junk in ["color:red", "tracking", "cookies", "Blog", "Privacy"] {
            assert!(!out.contains(junk), "{junk} leaked: {out}");
        }
        assert!(!out.starts_with("# Guide"), "title is not repeated: {out}");
    }

    #[test]
    fn keeps_text_that_is_not_in_a_paragraph() {
        let out = md("<body><div>Loose text in a div<div>and a nested one</div></div></body>");
        assert!(out.contains("Loose text in a div"), "{out}");
        assert!(out.contains("and a nested one"), "{out}");
    }

    #[test]
    fn hidden_elements_are_not_read() {
        let out = md(r#"<body><p>Visible</p><p style="display: none">Secret</p>
            <div hidden>Also secret</div><span aria-hidden="true">icon</span></body>"#);
        assert!(out.contains("Visible"));
        assert!(
            !out.contains("Secret") && !out.contains("Also secret") && !out.contains("icon"),
            "{out}"
        );
    }

    #[test]
    fn a_sidebar_card_does_not_win_over_the_page() {
        let prose = "Real content sentence that keeps going. ".repeat(40);
        let html = format!(
            r#"<body><div class="layout"><article class="card">Teaser card</article>
            <div class="text"><p>{prose}</p></div></div></body>"#
        );
        let out = md(&html);
        assert!(out.contains("Real content sentence"), "{out}");
    }

    #[test]
    fn article_inside_main_wins_when_it_holds_the_text() {
        let prose = "Article sentence with real words in it. ".repeat(30);
        let html = format!(
            r#"<body><main><div class="toolbar-x">x</div><article><p>{prose}</p></article></main></body>"#
        );
        let out = md(&html);
        assert!(out.starts_with("Article sentence"), "{out}");
    }

    #[test]
    fn renders_lists_tables_and_code() {
        let html = r#"<body><main>
            <ol><li>First <b>step</b></li><li>Second<ul><li>nested</li></ul></li></ol>
            <table><thead><tr><th>Name</th><th>Value</th></tr></thead>
            <tbody><tr><td>a|b</td><td>1</td></tr></tbody></table>
            <pre><code class="language-rust">fn main() {
    println!("hi");
}</code></pre></main></body>"#;
        let out = md(html);
        assert!(out.contains("1. First **step**"), "{out}");
        assert!(out.contains("2. Second\n   - nested"), "{out}");
        assert!(
            out.contains("| Name | Value |\n| --- | --- |\n| a\\|b | 1 |"),
            "{out}"
        );
        assert!(
            out.contains("```rust\nfn main() {\n    println!(\"hi\");\n}\n```"),
            "{out}"
        );
    }

    #[test]
    fn layout_tables_render_as_text() {
        let out = md("<body><table><tr><td>Only one cell of prose</td></tr></table></body>");
        assert_eq!(out, "Only one cell of prose");
    }

    #[test]
    fn line_breaks_and_entities() {
        let out = md("<body><p>One<br>Two &lt;three&gt; &eacute;t&eacute;</p></body>");
        assert_eq!(out, "One\nTwo <three> été");
    }

    #[test]
    fn title_and_description_come_from_metadata() {
        let page = extract(
            r#"<html><head><meta property="og:title" content="OG Title">
            <meta name="description" content="About it"><title>Tab</title></head><body><p>x y</p></body></html>"#,
            None,
        );
        assert_eq!(page.title, "OG Title");
        assert_eq!(page.description, "About it");
    }
}
