// ── Text helpers ──────────────────────────────────────────────────────
// Everything the bridge hands a model is text, and tool output rides in
// every later request, so it gets cut here rather than by the provider.

/// Cut to `max` characters on a word-ish boundary, saying what was cut.
pub fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    let cut = head
        .rfind(['\n', ' '])
        .filter(|index| *index > max / 2)
        .map(|index| head[..index].to_string())
        .unwrap_or(head);
    format!("{cut}\n… truncated ({} of {} characters shown)", cut.chars().count(), text.chars().count())
}

/// Keep the first `max` lines, saying how many were dropped.
pub fn truncate_lines(text: &str, max: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= max {
        return text.to_string();
    }
    let mut out = lines[..max].join("\n");
    out.push_str(&format!(
        "\n… truncated ({} of {} lines shown)",
        max,
        lines.len()
    ));
    out
}

/// One line, trimmed — for titles and error rails.
pub fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A tab-separated block: what a spreadsheet grid wants pasted into it.
pub fn tsv(rows: &[Vec<String>]) -> String {
    rows.iter()
        .map(|row| {
            row.iter()
                .map(|cell| cell.replace(['\t', '\n'], " "))
                .collect::<Vec<_>>()
                .join("\t")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parse a TSV or CSV block into rows, so a model can hand over either.
pub fn parse_grid(text: &str) -> Vec<Vec<String>> {
    let delimiter = if text.lines().next().is_some_and(|line| line.contains('\t')) {
        '\t'
    } else {
        ','
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            if delimiter == ',' {
                split_csv_line(line)
            } else {
                line.split('\t').map(|cell| cell.trim().to_string()).collect()
            }
        })
        .collect()
}

fn split_csv_line(line: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cell.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => cells.push(cell.trim().to_string()),
            _ => cell.push(ch),
        }
    }
    cells.push(cell.trim().to_string());
    cells
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_says_what_it_dropped() {
        let short = "hello";
        assert_eq!(truncate_chars(short, 10), "hello");
        let long = "one two three four five";
        let cut = truncate_chars(long, 12);
        assert!(cut.starts_with("one two"));
        assert!(cut.contains("truncated"));
        assert!(!cut.contains("five"));
    }

    #[test]
    fn line_truncation_counts_lines() {
        let text = "a\nb\nc\nd";
        assert_eq!(truncate_lines(text, 10), text);
        let cut = truncate_lines(text, 2);
        assert!(cut.starts_with("a\nb"));
        assert!(cut.contains("2 of 4 lines"));
    }

    #[test]
    fn collapse_flattens_a_paragraph() {
        assert_eq!(collapse("  a\n  b\tc  "), "a b c");
    }

    #[test]
    fn tsv_strips_the_delimiters_it_cannot_carry() {
        let rows = vec![
            vec!["a".to_string(), "b\tc".to_string()],
            vec!["1".to_string(), "2\n3".to_string()],
        ];
        assert_eq!(tsv(&rows), "a\tb c\n1\t2 3");
    }

    #[test]
    fn a_grid_reads_back_from_tsv_and_csv() {
        assert_eq!(
            parse_grid("a\tb\n1\t2"),
            vec![vec!["a", "b"], vec!["1", "2"]]
        );
        assert_eq!(
            parse_grid("a,b\n\"x,y\",2"),
            vec![vec!["a", "b"], vec!["x,y", "2"]]
        );
        assert!(parse_grid("   ").is_empty());
    }
}
