//! Markdown rendering for chat content and the plan review panel.
//!
//! Custom parser (not pulldown-cmark) for tighter control over terminal
//! output: headings, lists, task lists, tables, quotes, horizontal rules,
//! fenced code with syntect highlighting, and inline bold/italic/code/strike.
//! Everything flows through [`wrap_line`], the one word-wrap engine, so
//! assistant markdown, user bubbles, and streaming text wrap identically.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::{display_width, is_wide_char, s, sf, sp, themed_blank_row};
use crate::style::*;

/// Format markdown for display (headings, lists, code) then wrap to `width`.
/// Used by chat and the full-screen plan review panel.
pub(crate) fn markdown_display_lines(content: &str, width: usize) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    for line in render_markdown_at_width(content, width) {
        for wrapped in wrap_line(&line, width.max(1)) {
            out.push(wrapped);
        }
    }
    out
}

pub(crate) fn render_markdown(content: &str) -> Vec<Line<'static>> {
    render_markdown_at_width(content, usize::MAX)
}

pub(crate) fn render_markdown_at_width(content: &str, width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut in_code_block = false;
    let mut code_lang = String::new();
    let mut code_buffer = String::new();
    let mut table_buffer: Vec<String> = Vec::new();

    // A table line begins with a `|` (optionally indented).
    let is_table_line = |line: &str| line.trim_start().starts_with('|');

    for line in content.lines() {
        // Flush a pending table before any non-table line.
        if !table_buffer.is_empty() && !is_table_line(line) {
            lines.extend(render_table(std::mem::take(&mut table_buffer), width));
        }
        if !in_code_block && is_table_line(line) {
            table_buffer.push(line.trim().to_string());
            continue;
        }
        if line.starts_with("```") {
            if !in_code_block {
                in_code_block = true;
                code_lang = line.trim_start_matches('`').trim().to_string();
                code_buffer.clear();
                let lang_display = if code_lang.is_empty() {
                    "code"
                } else {
                    &code_lang
                };
                lines.push(Line::from(vec![
                    sp("  "),
                    sf("┌", FG_DIM()),
                    sp("─ "),
                    s(
                        lang_display.to_string(),
                        Style::default().fg(SYNTAX_KEYWORD()),
                    ),
                ]));
            } else {
                in_code_block = false;
                let highlighted = crate::syntax_highlight::highlight_code(&code_buffer, &code_lang);
                for hl_line in highlighted {
                    let mut new_spans = vec![sp("  "), sf("│", FG_DIM()), sp(" ")];
                    // Skip the first span ("  " indent) that highlight_code adds
                    for (i, span) in hl_line.spans.into_iter().enumerate() {
                        if i > 0 {
                            new_spans.push(span);
                        }
                    }
                    lines.push(Line::from(new_spans));
                }
                lines.push(Line::from(vec![sp("  "), sf("└", FG_DIM())]));
            }
            continue;
        }

        if in_code_block {
            code_buffer.push_str(line);
            code_buffer.push('\n');
            continue;
        }

        if line.is_empty() {
            lines.push(Line::from(""));
            continue;
        }

        if let Some(stripped) = line.strip_prefix("### ") {
            // Sub-headings render blue-bold.
            lines.push(Line::from(vec![
                sp("  "),
                s(
                    stripped.to_string(),
                    Style::default()
                        .fg(SECONDARY())
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            continue;
        }
        if let Some(stripped) = line.strip_prefix("## ") {
            lines.push(Line::from(vec![
                sp("  "),
                s(stripped.to_string(), Style::default().fg(MD_HEADING())),
            ]));
            continue;
        }
        if let Some(stripped) = line.strip_prefix("# ") {
            lines.push(Line::from(vec![
                sp("  "),
                s(
                    stripped.to_string(),
                    Style::default()
                        .fg(MD_HEADING())
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            continue;
        }
        if line.starts_with('#') {
            // H4-H6: strip leading #'s and render as muted text
            let text = line.trim_start_matches('#').trim_start();
            lines.push(Line::from(vec![
                sp("  "),
                s(text.to_string(), Style::default().fg(FG_MUTED())),
            ]));
            continue;
        }

        // Task list items: `- [ ]` / `- [x]` render as a checkbox.
        if line.starts_with("- [") {
            // `- [x]` / `- [X]` / `- [ ]` all consume the 5-char marker; any
            // other `- […` keeps whatever follows the bullet.
            let rest = ["- [x]", "- [X]", "- [ ]"]
                .iter()
                .find_map(|marker| line.strip_prefix(marker))
                .or_else(|| line.strip_prefix("- "))
                .unwrap_or(line);
            let mut spans = vec![sp("  ")];
            let checked = line.starts_with("- [x]") || line.starts_with("- [X]");
            spans.push(s(
                if checked { "[x] " } else { "[ ] " }.to_string(),
                Style::default().fg(if checked { SUCCESS() } else { FG_DIM() }),
            ));
            spans.extend(inline_md(rest, Style::default().fg(FG())));
            lines.push(Line::from(spans));
            continue;
        }

        if line.starts_with("- ") || line.starts_with("* ") {
            let mut spans = vec![sp("  "), sf("• ", PRIMARY())];
            spans.extend(inline_md(&line[2..], Style::default().fg(FG())));
            lines.push(Line::from(spans));
            continue;
        }

        // Indented sub-lists (2+ leading spaces before `- ` or `* `)
        {
            let trimmed = line.trim_start();
            let indent = line.len() - trimmed.len();
            if (trimmed.starts_with("- ") || trimmed.starts_with("* ")) && indent >= 2 {
                let indent_str = " ".repeat(2 + indent.min(4));
                let list_text = &trimmed[2..];
                let mut spans = vec![s(indent_str, Style::default()), sf("◦ ", SECONDARY())];
                spans.extend(inline_md(list_text, Style::default().fg(FG_MUTED())));
                lines.push(Line::from(spans));
                continue;
            }
        }

        if let Some(dot_pos) = line.find(". ") {
            let prefix = &line[..dot_pos + 2];
            let rest = &line[dot_pos + 2..];
            if dot_pos > 0 && line[..dot_pos].chars().all(|c| c.is_ascii_digit()) {
                let mut spans = vec![
                    sp("  "),
                    s(prefix.to_string(), Style::default().fg(PRIMARY())),
                ];
                spans.extend(inline_md(rest, Style::default().fg(FG())));
                lines.push(Line::from(spans));
                continue;
            }
        }

        if let Some(stripped) = line.strip_prefix("> ") {
            lines.push(Line::from(vec![
                sp("  "),
                sf("│ ", MD_QUOTE()),
                s(stripped.to_string(), Style::default().fg(MD_QUOTE())),
            ]));
            continue;
        }

        // Horizontal rule (3+ hyphens, nothing else) — a short dim `—`,
        // not a full-width line.
        {
            let trimmed = line.trim();
            if trimmed.len() >= 3 && trimmed.chars().all(|c| c == '-') {
                lines.push(Line::from(vec![sp("  "), sf("—", BORDER_ACTIVE())]));
                continue;
            }
        }

        for part in hard_breaks(line) {
            let mut spans = vec![sp("  ")];
            spans.extend(inline_md(part, Style::default().fg(FG())));
            lines.push(Line::from(spans));
        }
    }

    // Flush a table that reached the end of the content.
    if !table_buffer.is_empty() {
        lines.extend(render_table(std::mem::take(&mut table_buffer), width));
    }

    // Handle unclosed code block
    if in_code_block {
        let highlighted = crate::syntax_highlight::highlight_code(&code_buffer, &code_lang);
        for hl_line in highlighted {
            let mut new_spans = vec![sp("  "), sf("│", FG_DIM()), sp(" ")];
            for (i, span) in hl_line.spans.into_iter().enumerate() {
                if i > 0 {
                    new_spans.push(span);
                }
            }
            lines.push(Line::from(new_spans));
        }
        lines.push(Line::from(vec![
            sp("  "),
            sf("└", FG_DIM()),
            sp(" "),
            s("…", Style::default().fg(FG_DIM())),
        ]));
    }

    lines
}

/// Render a markdown table (consecutive `| a | b |` rows). The first row after
/// a `|---|---|` separator is the header. Columns are padded to the widest cell.
fn render_table(rows: Vec<String>, width: usize) -> Vec<Line<'static>> {
    let mut parsed: Vec<Vec<String>> = Vec::new();
    let mut has_separator = false;
    for row in rows {
        let inner = row.trim().trim_matches('|');
        if inner.trim().is_empty() {
            continue;
        }
        let cells: Vec<String> = inner.split('|').map(|c| c.trim().to_string()).collect();
        // Separator row (all dashes, optionally with alignment colons).
        if cells.iter().all(|c| {
            let t = c.trim();
            !t.is_empty() && t.trim_matches(':').chars().all(|ch| ch == '-')
        }) {
            has_separator = true;
            continue;
        }
        parsed.push(cells);
    }
    if parsed.is_empty() {
        return Vec::new();
    }
    let col_count = parsed.iter().map(|r| r.len()).max().unwrap_or(1).max(1);

    // Cells carry inline markdown. Render each one first, then measure the
    // *rendered* width: cells used to be pushed as raw strings, so `**bold**`
    // and `` `code` `` showed their markers literally, and measuring the raw
    // text left every column padded for markers that are not drawn.
    let cell_style = |is_header: bool| {
        if is_header {
            Style::default()
                .fg(MD_HEADING())
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(FG())
        }
    };
    let rendered: Vec<Vec<Vec<Span<'static>>>> = parsed
        .iter()
        .enumerate()
        .map(|(i, cells)| {
            let style = cell_style(has_separator && i == 0);
            (0..col_count)
                .map(|c| {
                    let cell = cells.get(c).map(|s| s.as_str()).unwrap_or("");
                    inline_md(cell, style)
                })
                .collect()
        })
        .collect();

    let span_width = |spans: &[Span<'static>]| -> usize {
        spans
            .iter()
            .map(|sp| crate::widgets::display_width(sp.content.as_ref()))
            .sum()
    };

    let mut widths = vec![0usize; col_count];
    for row in &rendered {
        for (c, cell) in row.iter().enumerate() {
            widths[c] = widths[c].max(span_width(cell));
        }
    }

    // Wide prose tables become labelled blocks instead of wrapping columns
    // into one another. Compact comparisons retain their aligned columns.
    if widths
        .iter()
        .sum::<usize>()
        .saturating_add(2 + col_count * 2)
        > width
        || parsed
            .iter()
            .flatten()
            .any(|cell| hard_breaks(cell).len() > 1)
    {
        let mut out = Vec::new();
        for (i, cells) in parsed.iter().enumerate() {
            if has_separator && i == 0 {
                continue;
            }
            if !out.is_empty() {
                out.push(Line::from(""));
            }
            for (column, cell) in cells.iter().enumerate() {
                for part in hard_breaks(cell) {
                    let mut spans = vec![sp(if column == 0 { "  " } else { "    " })];
                    let style = if column == 0 {
                        Style::default().fg(FG()).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(FG())
                    };
                    if col_count > 2 && column > 0 && has_separator {
                        if let Some(label) = parsed[0].get(column) {
                            spans.extend(inline_md(label, Style::default().fg(FG_MUTED())));
                            spans.push(sp(": "));
                        }
                    }
                    spans.extend(inline_md(part.trim(), style));
                    out.push(Line::from(spans));
                }
            }
        }
        return out;
    }

    let mut out = Vec::new();
    for (i, row) in rendered.iter().enumerate() {
        let is_header = has_separator && i == 0;
        let mut spans = vec![sp("  ")];
        for (c, width) in widths.iter().enumerate().take(col_count) {
            let cell = &row[c];
            let pad = width.saturating_sub(span_width(cell));
            spans.extend(cell.iter().cloned());
            spans.push(s(" ".repeat(pad + 2), Style::default()));
        }
        out.push(Line::from(spans));
        if is_header {
            let mut sep = vec![sp("  ")];
            for w in &widths {
                sep.push(s("─".repeat(*w + 2), Style::default().fg(FG_DIM())));
            }
            out.push(Line::from(sep));
        }
    }
    out
}

/// HTML breaks emitted by models are presentation markup outside inline code.
/// Keep source examples and unknown HTML literal.
fn hard_breaks(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut index = 0;
    let mut code_ticks = 0;
    while index < text.len() {
        let rest = &text[index..];
        if rest.starts_with('`') {
            let count = rest.bytes().take_while(|b| *b == b'`').count();
            if code_ticks == 0 {
                code_ticks = count;
            } else if code_ticks == count {
                code_ticks = 0;
            }
            index += count;
            continue;
        }
        if code_ticks == 0 && rest.starts_with('<') {
            if let Some(end) = rest.find('>') {
                let tag = rest[1..end].trim().trim_end_matches('/').trim();
                if tag.eq_ignore_ascii_case("br") {
                    parts.push(&text[start..index]);
                    index += end + 1;
                    start = index;
                    continue;
                }
            }
        }
        index += rest.chars().next().unwrap().len_utf8();
    }
    parts.push(&text[start..]);
    parts
}

/// Parse inline `**bold**`, `*italic*`, `` `code` ``, and `~~strike~~`.
/// Unclosed markers (mid-stream) style the rest without showing raw markers.
fn inline_md(text: &str, base: Style) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut remaining = text;
    let plain = base;
    let bold = base.add_modifier(Modifier::BOLD);
    let italic = base.add_modifier(Modifier::ITALIC).fg(MD_EMPH());
    let strike = base.add_modifier(Modifier::CROSSED_OUT).fg(FG_DIM());

    while !remaining.is_empty() {
        let pos = remaining
            .char_indices()
            .find(|(_, c)| *c == '`' || *c == '*' || *c == '~')
            .map(|(i, _)| i);

        let Some(pos) = pos else {
            spans.push(s(remaining.to_string(), plain));
            break;
        };

        if pos > 0 {
            spans.push(s(remaining[..pos].to_string(), plain));
            remaining = &remaining[pos..];
        }

        if remaining.starts_with('`') {
            if let Some(end) = remaining[1..].find('`') {
                spans.push(s(
                    remaining[1..end + 1].to_string(),
                    Style::default().bg(BG_ELEMENT()).fg(MD_CODE()),
                ));
                remaining = &remaining[end + 2..];
            } else {
                spans.push(s(
                    remaining[1..].to_string(),
                    Style::default().bg(BG_ELEMENT()).fg(MD_CODE()),
                ));
                break;
            }
        } else if remaining.starts_with("**") {
            if let Some(end) = remaining[2..].find("**") {
                spans.extend(inline_md(&remaining[2..end + 2], bold));
                remaining = &remaining[end + 4..];
            } else {
                spans.extend(inline_md(&remaining[2..], bold));
                break;
            }
        } else if remaining.starts_with('*') {
            if let Some(end) = remaining[1..].find('*') {
                spans.push(s(remaining[1..end + 1].to_string(), italic));
                remaining = &remaining[end + 2..];
            } else {
                spans.push(s(remaining[1..].to_string(), italic));
                break;
            }
        } else if remaining.starts_with("~~") {
            if let Some(end) = remaining[2..].find("~~") {
                spans.push(s(remaining[2..end + 2].to_string(), strike));
                remaining = &remaining[end + 4..];
            } else {
                spans.push(s(remaining[2..].to_string(), strike));
                break;
            }
        } else {
            // A literal single tilde must advance the parser.
            spans.push(s("~", plain));
            remaining = &remaining[1..];
        }
    }

    spans
}

/// Wrap a single Line into multiple Lines if it exceeds max_width characters.
/// Each span in the line contributes its character count. When a span would
/// push past the width, it's split at word boundaries.
///
/// The line's own leading whitespace becomes a **hanging indent**: continuation
/// rows are pushed out to the same column. Without it, a wrapped paragraph or a
/// long URL restarts at column 0 while its first row sits at the content
/// indent, which reads as text escaping the message.
pub(crate) fn wrap_line<'a>(line: &Line<'a>, max_width: usize) -> Vec<Line<'static>> {
    let total_width: usize = line
        .spans
        .iter()
        .map(|s| display_width(s.content.as_ref()))
        .sum();
    if total_width <= max_width || max_width == 0 {
        return vec![Line::from(
            line.spans
                .iter()
                .map(|s| Span::styled(s.content.clone().into_owned(), s.style))
                .collect::<Vec<_>>(),
        )];
    }

    // Hanging indent, copied from the line's own leading spaces. Capped so a
    // deeply indented line still gets usable room for its text.
    let lead_style = line.spans.first().map(|s| s.style).unwrap_or_default();
    let leading: usize = line
        .spans
        .iter()
        .flat_map(|s| s.content.chars())
        .take_while(|c| *c == ' ')
        .count()
        .min(max_width / 3);
    let indent = |spans: &mut Vec<Span<'static>>| {
        if leading > 0 {
            spans.push(Span::styled(" ".repeat(leading), lead_style));
        }
    };

    let chunks = line.spans.iter().flat_map(|span| {
        span.content
            .split_inclusive(' ')
            .map(move |word| (word, span.style))
    });

    let mut result: Vec<Line<'static>> = Vec::new();
    let mut current_spans: Vec<Span<'static>> = Vec::new();
    // Cells used on the row being built. The first row's indent arrives as
    // ordinary content; every later row gets it from `indent`.
    let mut current_width = 0usize;

    macro_rules! flush {
        () => {{
            result.push(Line::from(std::mem::take(&mut current_spans)));
            indent(&mut current_spans);
            current_width = leading;
        }};
    }

    for (text, style) in chunks {
        let mut remaining = text.to_string();
        loop {
            let piece_len = display_width(&remaining);

            // Fits on the row being built.
            if current_width + piece_len <= max_width {
                current_spans.push(Span::styled(remaining, style));
                current_width += piece_len;
                break;
            }

            // Doesn't fit, but the row already carries text: break the line and
            // retry the same word on the fresh row. (Falling straight through
            // to the push instead — the old behaviour — let an over-long word
            // run off the right edge and lose its tail.)
            let row_has_text = current_spans.iter().any(|s| !s.content.trim().is_empty());
            if row_has_text {
                flush!();
                continue;
            }

            // Fresh row and the word alone is still too long: hard-break it by
            // display columns (a single wide glyph may take 2 cells).
            let take = max_width.saturating_sub(current_width).max(1);
            let (chunk, rest) = split_owned_by_display_width(&remaining, take);
            current_spans.push(Span::styled(chunk, style));
            flush!();
            remaining = rest;
            if remaining.is_empty() {
                break;
            }
        }
    }

    // A trailing row holding only the hanging indent is not a row.
    if current_spans.iter().any(|s| !s.content.trim().is_empty()) {
        result.push(Line::from(current_spans));
    }

    if result.is_empty() {
        result.push(themed_blank_row(0));
    }
    result
}

/// Split `s` so the first piece occupies at most `max_cols` terminal columns.
fn split_owned_by_display_width(s: &str, max_cols: usize) -> (String, String) {
    if max_cols == 0 {
        return (String::new(), s.to_string());
    }
    let mut cols = 0usize;
    for (i, c) in s.char_indices() {
        let w = if is_wide_char(c) { 2 } else { 1 };
        if cols + w > max_cols {
            if i == 0 {
                // Single wide glyph on a 1-col budget — still emit it so we
                // make progress rather than loop forever.
                let next = s[c.len_utf8()..].to_string();
                return (c.to_string(), next);
            }
            return (s[..i].to_string(), s[i..].to_string());
        }
        cols += w;
    }
    (s.to_string(), String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prose_table_keeps_sections_and_breaks_readable() {
        let source = "| Area | Capabilities |\n|---|---|\n| **Code exploration** | • List files (`list_dir`)<br>• Inspect symbols (`file_outline`) |\n| **Planning** | • Write a plan<br/>• Review it |";
        for width in [20, 40, 80, 120] {
            let rows = markdown_display_lines(source, width);
            let text = rows
                .iter()
                .map(|row| {
                    row.spans
                        .iter()
                        .map(|span| span.content.as_ref())
                        .collect::<String>()
                })
                .collect::<Vec<_>>();
            assert!(rows.iter().all(|row| row.width() <= width));
            let joined = text.join("\n");
            assert!(!joined.contains("<br"));
            assert!(!joined.contains("**"));
            assert!(joined.contains("Code exploration"));
            assert!(joined.contains("Planning"));
            assert!(text
                .iter()
                .any(|row| row.trim_start().starts_with("• Review")));
            assert!(text.iter().any(|row| row.is_empty()));
        }
    }

    #[test]
    fn literal_tilde_and_nested_emphasis_preserve_content() {
        let spans = inline_md("~/.config and **what I *can* do**", Style::default());
        let text: String = spans.iter().map(|span| span.content.as_ref()).collect();
        assert_eq!(text, "~/.config and what I can do");
        assert!(spans.iter().any(|span| span.content == "can"
            && span
                .style
                .add_modifier
                .contains(Modifier::BOLD | Modifier::ITALIC)));
    }

    #[test]
    fn breaks_preserve_inline_and_fenced_code_examples() {
        assert_eq!(
            hard_breaks("one<BR />two `<br>` three"),
            vec!["one", "two `<br>` three"]
        );
        let rows = markdown_display_lines("```html\n<br>\n```", 40);
        assert!(rows.iter().any(|row| row
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>()
            .contains("<br>")));
    }

    #[test]
    fn wrap_line_hard_breaks_long_words() {
        let line = Line::from("abcdefghijklmnop".to_string());
        let wrapped = wrap_line(&line, 5);
        assert_eq!(wrapped.len(), 4);
        for l in wrapped {
            let width: usize = l
                .spans
                .iter()
                .map(|s| display_width(s.content.as_ref()))
                .sum();
            assert!(width <= 5);
        }
    }

    /// Regression: an over-long word arriving on a row that already had text
    /// used to be pushed whole, running off the right edge and losing its tail.
    #[test]
    fn wrap_line_hard_breaks_a_long_word_that_follows_text() {
        let url = "https://example.com/".to_string() + &"segment/".repeat(8);
        let line = Line::from(format!("  See {url}"));
        let wrapped = wrap_line(&line, 30);

        // Re-join, dropping the hanging indent that each continuation row adds.
        let mut joined = String::new();
        for (i, l) in wrapped.iter().enumerate() {
            let text: String = l.spans.iter().map(|s| s.content.as_ref()).collect();
            if i == 0 {
                joined.push_str(&text);
            } else {
                joined.push_str(text.trim_start_matches(' '));
            }
        }
        assert!(
            joined.contains(&url),
            "the whole URL survives wrapping, got: {joined:?}"
        );
        for l in &wrapped {
            let width: usize = l
                .spans
                .iter()
                .map(|s| display_width(s.content.as_ref()))
                .sum();
            assert!(width <= 30, "row wider than the wrap width: {l:?}");
        }
    }

    /// The leading indent of a line becomes a hanging indent, so wrapped text
    /// does not restart at column 0 while its first row sits inset.
    #[test]
    fn wrap_line_keeps_a_hanging_indent() {
        let line = Line::from("    alpha beta gamma delta epsilon zeta".to_string());
        let wrapped = wrap_line(&line, 16);
        assert!(wrapped.len() > 1, "expected the line to wrap");
        for (i, l) in wrapped.iter().enumerate().skip(1) {
            let text: String = l.spans.iter().map(|s| s.content.as_ref()).collect();
            assert!(
                text.starts_with("    "),
                "continuation row {i} lost the indent: {text:?}"
            );
        }
    }

    #[test]
    fn wrap_line_handles_multibyte_text() {
        let line = Line::from("é".repeat(12));
        let wrapped = wrap_line(&line, 4);
        assert_eq!(wrapped.len(), 3);
        for l in wrapped {
            let width: usize = l
                .spans
                .iter()
                .map(|s| display_width(s.content.as_ref()))
                .sum();
            assert!(width <= 4);
        }
    }

    #[test]
    fn wrap_line_accounts_for_emoji_display_width() {
        // 👋 is one char but two columns — three of them must wrap on width 4.
        let line = Line::from("👋👋👋".to_string());
        let wrapped = wrap_line(&line, 4);
        assert!(wrapped.len() >= 2, "expected emoji line to wrap by columns");
        for l in &wrapped {
            let width: usize = l
                .spans
                .iter()
                .map(|s| display_width(s.content.as_ref()))
                .sum();
            assert!(width <= 4, "row too wide: {width}");
        }
    }
    #[test]
    fn list_items_render_inline_bold() {
        let lines = render_markdown("- **Read & write files** — do stuff");
        assert!(!lines.is_empty());
        let joined: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(!joined.contains("**"), "raw markers leaked: {joined}");
        assert!(joined.contains("Read & write files"));
        assert!(joined.contains('•'));
    }

    #[test]
    fn streaming_partial_bold_hides_markers() {
        let spans = inline_md("Hello **world", Style::default().fg(FG()));
        let joined: String = spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(!joined.contains("**"), "raw markers leaked: {joined}");
        assert!(joined.contains("Hello "));
        assert!(joined.contains("world"));
    }

    #[test]
    fn strikethrough_renders_without_markers() {
        let spans = inline_md("~~gone~~ stays", Style::default().fg(FG()));
        let joined: String = spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(!joined.contains('~'), "raw markers leaked: {joined}");
        assert!(joined.contains("gone stays"));
        // The struck span gets CROSSED_OUT.
        assert!(spans.iter().any(|s| s.content.as_ref() == "gone"
            && s.style
                .add_modifier
                .contains(ratatui::style::Modifier::CROSSED_OUT)));
    }

    #[test]
    fn task_list_items_render_checkboxes() {
        let done = render_markdown("- [x] ship it");
        let joined_done: String = done[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(joined_done.contains("[x]"));
        assert!(
            !joined_done.contains("- [x]"),
            "raw marker leaked: {joined_done}"
        );

        let todo = render_markdown("- [ ] later");
        let joined_todo: String = todo[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(joined_todo.contains("[ ]"));
        assert!(joined_todo.contains("later"));
    }

    /// Table cells used to be pushed as raw strings, so a cell reading
    /// `**Core library**` displayed its asterisks and the column was padded
    /// for markers that are never drawn.
    #[test]
    fn table_cells_render_inline_markdown() {
        let lines =
            render_markdown("| Area | Detail |\n|------|--------|\n| **Core** | `lib.rs` |");
        let body = lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!body.contains("**"), "bold markers leaked:\n{body}");
        assert!(!body.contains('`'), "code markers leaked:\n{body}");
        assert!(body.contains("Core"), "cell text missing:\n{body}");
        assert!(body.contains("lib.rs"), "code cell text missing:\n{body}");

        // The bold cell must actually carry the BOLD modifier.
        let bolded = lines.iter().any(|l| {
            l.spans.iter().any(|s| {
                s.content.as_ref() == "Core" && s.style.add_modifier.contains(Modifier::BOLD)
            })
        });
        assert!(bolded, "cell text is not bold");
    }

    /// Column width follows the rendered text, not the raw markers.
    #[test]
    fn table_columns_size_to_rendered_width() {
        let lines = render_markdown("| A | B |\n|---|---|\n| **xx** | y |");
        // Header row and the body row must line up: `**xx**` renders as `xx`,
        // so column A is 2 cells wide, not 6.
        let widths: Vec<usize> = lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| crate::widgets::display_width(s.content.as_ref()))
                    .sum()
            })
            .collect();
        assert!(
            widths.windows(2).all(|w| w[0] == w[1]),
            "rows are ragged: {widths:?}"
        );
    }

    #[test]
    fn table_renders_header_separator_and_aligned_cells() {
        let md = "| A | BBB |\n|---|---|\n| 1 | 2 |";
        let rendered = render_markdown(md);
        let joined: String = rendered
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(joined.contains('A'), "header missing: {joined}");
        assert!(joined.contains("BBB"));
        assert!(joined.contains('1'));
        assert!(joined.contains('2'));
        // No raw `|` leaked.
        assert!(!joined.contains('|'), "raw pipes leaked: {joined}");
        // Header row should be bold; a separator row of ─ follows it.
        let header_bold = rendered[0]
            .spans
            .iter()
            .any(|s| s.style.add_modifier.contains(Modifier::BOLD));
        assert!(header_bold, "header not bold");
        assert!(!rendered[1]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect::<String>()
            .is_empty());
    }

    #[test]
    fn plain_pipe_line_is_not_a_table() {
        // A single line with pipes but no header structure still renders text.
        let rendered = render_markdown("just | a | sentence");
        let joined: String = rendered
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(joined.contains("just | a | sentence"));
    }
}
