// ── Google Docs v1 ────────────────────────────────────────────────────
// Read a document as markdown, create one, and edit it through a small op
// vocabulary — append / prepend markdown, find-and-replace — instead of raw
// `batchUpdate` passthrough, so a model can never invent a request shape
// Docs rejects. Every write carries the revision it was planned against, so
// a person typing in the same doc makes the call fail instead of being
// overwritten.
//
// Docs indexes count UTF-16 code units; every offset here does too.

use super::{encode, Google};
use serde_json::{json, Value};

const API: &str = "https://docs.googleapis.com/v1/documents";

pub fn edit_url(id: &str) -> String {
    format!("https://docs.google.com/document/d/{id}/edit")
}

pub async fn read(google: &Google, id: &str) -> Result<String, String> {
    let doc = google.get_json(&format!("{API}/{}", encode(id))).await?;
    Ok(format!(
        "Document: {} — {}\n\n{}",
        doc.get("title").and_then(Value::as_str).unwrap_or("(untitled)"),
        edit_url(id),
        render(&doc)
    ))
}

pub async fn create(google: &Google, title: &str, markdown: Option<&str>) -> Result<String, String> {
    let doc = google.post_json(API, &json!({ "title": title })).await?;
    let id = doc
        .get("documentId")
        .and_then(Value::as_str)
        .ok_or("Google created no document id")?
        .to_string();
    if let Some(markdown) = markdown.filter(|text| !text.trim().is_empty()) {
        apply(google, &id, &Op::Append(markdown.to_string())).await?;
    }
    Ok(format!("Created \"{title}\": {}", edit_url(&id)))
}

/// One edit, in the vocabulary the `doc_edit` tool offers.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Append(String),
    Prepend(String),
    Replace {
        find: String,
        replace: String,
        match_case: bool,
    },
}

impl Op {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        match value.get("op").and_then(Value::as_str).unwrap_or_default() {
            "append" => text("markdown")
                .map(Op::Append)
                .ok_or_else(|| "append needs \"markdown\"".to_string()),
            "prepend" => text("markdown")
                .map(Op::Prepend)
                .ok_or_else(|| "prepend needs \"markdown\"".to_string()),
            "replace" => Ok(Op::Replace {
                find: text("find")
                    .filter(|find| !find.is_empty())
                    .ok_or("replace needs a non-empty \"find\"")?,
                replace: text("replace").unwrap_or_default(),
                match_case: value.get("match_case").and_then(Value::as_bool).unwrap_or(false),
            }),
            other => Err(format!(
                "Unknown op \"{other}\" — use append, prepend or replace"
            )),
        }
    }
}

pub async fn edit(google: &Google, id: &str, ops: &[Op]) -> Result<String, String> {
    let mut lines = Vec::with_capacity(ops.len());
    for op in ops {
        lines.push(apply(google, id, op).await?);
    }
    lines.push(edit_url(id));
    Ok(lines.join("\n"))
}

async fn apply(google: &Google, id: &str, op: &Op) -> Result<String, String> {
    let doc = google.get_json(&format!("{API}/{}", encode(id))).await?;
    let revision = doc.get("revisionId").and_then(Value::as_str).map(str::to_string);
    let end = body_end(&doc);
    let (requests, summary) = match op {
        Op::Append(markdown) => {
            // The body always ends in a newline the API will not let us move;
            // insert before it, on a fresh paragraph unless the doc is empty.
            let lead = end > 2;
            (
                markdown_requests(markdown, end - 1, lead, false),
                format!("Appended {} line(s).", markdown.lines().count()),
            )
        }
        Op::Prepend(markdown) => (
            markdown_requests(markdown, 1, false, true),
            format!("Inserted {} line(s) at the top.", markdown.lines().count()),
        ),
        Op::Replace {
            find,
            replace,
            match_case,
        } => (
            vec![json!({ "replaceAllText": {
                "containsText": { "text": find, "matchCase": match_case },
                "replaceText": replace,
            }})],
            String::new(),
        ),
    };
    if requests.is_empty() {
        return Ok("Nothing to write.".to_string());
    }
    let mut body = json!({ "requests": requests });
    if let Some(revision) = revision {
        body["writeControl"] = json!({ "requiredRevisionId": revision });
    }
    let reply = google
        .post_json(&format!("{API}/{}:batchUpdate", encode(id)), &body)
        .await
        .map_err(|error| {
            if error.contains("400") && error.to_lowercase().contains("revision") {
                "Someone edited the document while this change was being written. Read it again and retry.".to_string()
            } else {
                error
            }
        })?;
    if let Op::Replace { find, .. } = op {
        let changed = reply
            .pointer("/replies/0/replaceAllText/occurrencesChanged")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        return Ok(format!("Replaced {changed} occurrence(s) of \"{find}\"."));
    }
    Ok(summary)
}

/// Index just past the last character of the body (its final newline).
fn body_end(doc: &Value) -> i64 {
    doc.pointer("/body/content")
        .and_then(Value::as_array)
        .and_then(|content| content.last())
        .and_then(|last| last.get("endIndex"))
        .and_then(Value::as_i64)
        .unwrap_or(2)
        .max(2)
}

fn utf16(text: &str) -> i64 {
    text.encode_utf16().count() as i64
}

/// A line of markdown the way Docs needs it: plain text, paragraph style,
/// list kind, and the bold spans inside it.
#[derive(Debug, PartialEq)]
struct Line {
    text: String,
    style: &'static str,
    list: Option<&'static str>,
    bold: Vec<(i64, i64)>,
}

fn parse_line(raw: &str) -> Line {
    let trimmed = raw.trim_start();
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    let (body, style, list) = if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
        const HEADINGS: [&str; 6] = [
            "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6",
        ];
        (&trimmed[hashes + 1..], HEADINGS[hashes - 1], None)
    } else if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
        (rest, "NORMAL_TEXT", Some("BULLET_DISC_CIRCLE_SQUARE"))
    } else if let Some(rest) = numbered(trimmed) {
        (rest, "NORMAL_TEXT", Some("NUMBERED_DECIMAL_ALPHA_ROMAN"))
    } else {
        (raw, "NORMAL_TEXT", None)
    };

    // `**bold**` → plain text plus the span to embolden.
    let mut text = String::new();
    let mut bold = Vec::new();
    let mut open: Option<i64> = None;
    let mut rest = body;
    while let Some(at) = rest.find("**") {
        text.push_str(&rest[..at]);
        match open.take() {
            Some(start) => bold.push((start, utf16(&text))),
            None => open = Some(utf16(&text)),
        }
        rest = &rest[at + 2..];
    }
    text.push_str(rest);
    if let Some(start) = open {
        // An unclosed marker was literal after all.
        let mut fixed = text.encode_utf16().collect::<Vec<_>>();
        let marker: Vec<u16> = "**".encode_utf16().collect();
        let at = start as usize;
        fixed.splice(at..at, marker);
        text = String::from_utf16_lossy(&fixed);
    }
    Line {
        text,
        style,
        list,
        bold,
    }
}

fn numbered(line: &str) -> Option<&str> {
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    line[digits..].strip_prefix(". ")
}

/// Requests that insert `markdown` at `index` and style it.
///
/// `lead` starts a new paragraph first (appending after existing text);
/// `trail` ends with a paragraph break (prepending before existing text).
fn markdown_requests(markdown: &str, index: i64, lead: bool, trail: bool) -> Vec<Value> {
    let lines: Vec<Line> = markdown.trim_end().lines().map(parse_line).collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let mut text = String::new();
    if lead {
        text.push('\n');
    }
    let mut spans = Vec::with_capacity(lines.len());
    for (n, line) in lines.iter().enumerate() {
        if n > 0 {
            text.push('\n');
        }
        let start = index + utf16(&text);
        text.push_str(&line.text);
        spans.push((start, index + utf16(&text)));
    }
    if trail {
        text.push('\n');
    }
    let first = spans[0].0;
    let last = spans[spans.len() - 1].1;

    let mut requests = vec![
        json!({ "insertText": { "location": { "index": index }, "text": text } }),
        // Inserted text inherits the paragraph it lands in; reset it first.
        json!({ "updateParagraphStyle": {
            "range": { "startIndex": first, "endIndex": last + 1 },
            "paragraphStyle": { "namedStyleType": "NORMAL_TEXT" },
            "fields": "namedStyleType",
        }}),
        json!({ "deleteParagraphBullets": { "range": { "startIndex": first, "endIndex": last + 1 } } }),
        json!({ "updateTextStyle": {
            "range": { "startIndex": first, "endIndex": last.max(first + 1) },
            "textStyle": { "bold": false },
            "fields": "bold",
        }}),
    ];
    for (line, (start, end)) in lines.iter().zip(&spans) {
        if line.style != "NORMAL_TEXT" {
            requests.push(json!({ "updateParagraphStyle": {
                "range": { "startIndex": start, "endIndex": end + 1 },
                "paragraphStyle": { "namedStyleType": line.style },
                "fields": "namedStyleType",
            }}));
        }
        for (from, to) in &line.bold {
            if to > from {
                requests.push(json!({ "updateTextStyle": {
                    "range": { "startIndex": start + from, "endIndex": start + to },
                    "textStyle": { "bold": true },
                    "fields": "bold",
                }}));
            }
        }
    }
    // Consecutive list lines of one kind become one list.
    let mut n = 0;
    while n < lines.len() {
        let Some(preset) = lines[n].list else {
            n += 1;
            continue;
        };
        let begin = n;
        while n + 1 < lines.len() && lines[n + 1].list == Some(preset) {
            n += 1;
        }
        requests.push(json!({ "createParagraphBullets": {
            "range": { "startIndex": spans[begin].0, "endIndex": spans[n].1 + 1 },
            "bulletPreset": preset,
        }}));
        n += 1;
    }
    requests
}

/// The document body as markdown: headings, lists, bold, tables.
pub fn render(doc: &Value) -> String {
    let mut out = Vec::new();
    if let Some(content) = doc.pointer("/body/content").and_then(Value::as_array) {
        render_content(content, &mut out);
    }
    let text = out.join("\n");
    let text = text.trim();
    if text.is_empty() {
        "(empty document)".to_string()
    } else {
        text.to_string()
    }
}

fn render_content(content: &[Value], out: &mut Vec<String>) {
    for element in content {
        if let Some(paragraph) = element.get("paragraph") {
            out.push(render_paragraph(paragraph));
        } else if let Some(table) = element.get("table") {
            out.push(String::new());
            let rows = table
                .get("tableRows")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for (n, row) in rows.iter().enumerate() {
                let cells: Vec<String> = row
                    .get("tableCells")
                    .and_then(Value::as_array)
                    .map(|cells| {
                        cells
                            .iter()
                            .map(|cell| {
                                let mut inner = Vec::new();
                                if let Some(content) = cell.get("content").and_then(Value::as_array) {
                                    render_content(content, &mut inner);
                                }
                                crate::text::collapse(&inner.join(" ")).replace('|', "\\|")
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                out.push(format!("| {} |", cells.join(" | ")));
                if n == 0 {
                    out.push(format!("|{}", " --- |".repeat(cells.len().max(1))));
                }
            }
            out.push(String::new());
        }
    }
}

fn render_paragraph(paragraph: &Value) -> String {
    let mut text = String::new();
    for element in paragraph
        .get("elements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(run) = element.get("textRun") else {
            continue;
        };
        let content = run.get("content").and_then(Value::as_str).unwrap_or_default();
        let bold = run.pointer("/textStyle/bold").and_then(Value::as_bool) == Some(true);
        let trimmed = content.trim_end_matches('\n');
        if bold && !trimmed.trim().is_empty() {
            text.push_str(&format!("**{trimmed}**"));
        } else {
            text.push_str(trimmed);
        }
    }
    let style = paragraph
        .pointer("/paragraphStyle/namedStyleType")
        .and_then(Value::as_str)
        .unwrap_or("NORMAL_TEXT");
    let prefix = match style {
        "TITLE" => "# ".to_string(),
        "SUBTITLE" => "## ".to_string(),
        heading if heading.starts_with("HEADING_") => {
            let level: usize = heading[8..].parse().unwrap_or(1);
            format!("{} ", "#".repeat(level.clamp(1, 6)))
        }
        _ => match paragraph.get("bullet") {
            Some(bullet) => {
                let depth = bullet.get("nestingLevel").and_then(Value::as_u64).unwrap_or(0);
                format!("{}- ", "  ".repeat(depth as usize))
            }
            None => String::new(),
        },
    };
    if text.is_empty() {
        text
    } else {
        format!("{prefix}{text}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paragraph(text: &str, style: &str) -> Value {
        json!({ "paragraph": {
            "elements": [{ "textRun": { "content": format!("{text}\n") } }],
            "paragraphStyle": { "namedStyleType": style },
        }})
    }

    #[test]
    fn a_document_reads_back_as_markdown() {
        let doc = json!({ "body": { "content": [
            { "sectionBreak": {} },
            paragraph("Plan", "HEADING_1"),
            paragraph("Ship it", "NORMAL_TEXT"),
            { "paragraph": {
                "elements": [{ "textRun": { "content": "first\n" } }],
                "bullet": { "nestingLevel": 1 },
            }},
            { "paragraph": { "elements": [
                { "textRun": { "content": "Total: " } },
                { "textRun": { "content": "42", "textStyle": { "bold": true } } },
                { "textRun": { "content": "\n" } },
            ]}},
            { "table": { "tableRows": [
                { "tableCells": [
                    { "content": [paragraph("a", "NORMAL_TEXT")] },
                    { "content": [paragraph("b|c", "NORMAL_TEXT")] },
                ]},
                { "tableCells": [
                    { "content": [paragraph("1", "NORMAL_TEXT")] },
                    { "content": [paragraph("2", "NORMAL_TEXT")] },
                ]},
            ]}},
        ]}});
        let text = render(&doc);
        assert!(text.starts_with("# Plan\nShip it\n  - first\nTotal: **42**"), "{text}");
        assert!(text.contains("| a | b\\|c |\n| --- | --- |\n| 1 | 2 |"), "{text}");
        assert_eq!(render(&json!({})), "(empty document)");
    }

    #[test]
    fn markdown_lines_become_styles_and_spans() {
        let heading = parse_line("## Results");
        assert_eq!(heading.text, "Results");
        assert_eq!(heading.style, "HEADING_2");
        let bullet = parse_line("- **Revenue** up");
        assert_eq!(bullet.text, "Revenue up");
        assert_eq!(bullet.list, Some("BULLET_DISC_CIRCLE_SQUARE"));
        assert_eq!(bullet.bold, vec![(0, 7)]);
        assert_eq!(parse_line("3. third").list, Some("NUMBERED_DECIMAL_ALPHA_ROMAN"));
        assert_eq!(parse_line("#hashtag").style, "NORMAL_TEXT");
        assert_eq!(parse_line("a ** b").text, "a ** b");
    }

    #[test]
    fn appended_markdown_lands_on_its_own_paragraphs() {
        let requests = markdown_requests("# Title\n- one\n- two\nplain", 10, true, false);
        assert_eq!(requests[0]["insertText"]["location"]["index"], 10);
        assert_eq!(requests[0]["insertText"]["text"], "\nTitle\none\ntwo\nplain");
        let heading = requests
            .iter()
            .find(|r| r.pointer("/updateParagraphStyle/paragraphStyle/namedStyleType") == Some(&json!("HEADING_1")))
            .expect("heading style");
        // "\n" is index 10, "Title" spans 11..16.
        assert_eq!(heading["updateParagraphStyle"]["range"]["startIndex"], 11);
        let bullets: Vec<_> = requests.iter().filter(|r| r.get("createParagraphBullets").is_some()).collect();
        assert_eq!(bullets.len(), 1, "one list for consecutive bullets");
        assert_eq!(bullets[0]["createParagraphBullets"]["range"]["startIndex"], 17);
    }

    #[test]
    fn offsets_count_utf16_units() {
        let requests = markdown_requests("😀 **x**", 1, false, true);
        let bold = requests
            .iter()
            .find(|r| r.pointer("/updateTextStyle/textStyle/bold") == Some(&json!(true)))
            .expect("bold");
        // The emoji is two UTF-16 units, then a space: "x" starts at 1 + 3.
        assert_eq!(bold["updateTextStyle"]["range"]["startIndex"], 4);
        assert_eq!(bold["updateTextStyle"]["range"]["endIndex"], 5);
    }

    #[test]
    fn ops_parse_or_say_what_is_missing() {
        assert_eq!(
            Op::parse(&json!({"op": "append", "markdown": "hi"})).unwrap(),
            Op::Append("hi".into())
        );
        assert!(Op::parse(&json!({"op": "replace", "find": ""})).is_err());
        assert!(Op::parse(&json!({"op": "delete"})).unwrap_err().contains("append, prepend or replace"));
    }
}
