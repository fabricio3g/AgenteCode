use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;

use crate::style::{self, *};

/// Unified diff view widget
pub struct DiffView {
    pub old_path: String,
    pub new_path: String,
    pub hunks: Vec<DiffHunk>,
    pub show_line_numbers: bool,
}

pub struct DiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<DiffLine>,
}

pub enum DiffLine {
    Context {
        line_num_old: usize,
        line_num_new: usize,
        content: String,
    },
    Added {
        line_num: usize,
        content: String,
    },
    Removed {
        line_num: usize,
        content: String,
    },
    HunkHeader(String),
}

impl DiffView {
    /// Width of the single line-number gutter: the digit count of the largest
    /// line number any rendered row will print (Context prints its NEW-side
    /// number, Added/Removed their own side), clamped to `3..=6` so tiny diffs
    /// don't jitter and huge files stay bounded. `0` when numbers are hidden.
    fn gutter_width(&self) -> usize {
        if !self.show_line_numbers {
            return 0;
        }
        let mut max_num = 0usize;
        for hunk in &self.hunks {
            for line in &hunk.lines {
                let n = match line {
                    DiffLine::Context { line_num_new, .. } => *line_num_new,
                    DiffLine::Added { line_num, .. } | DiffLine::Removed { line_num, .. } => {
                        *line_num
                    }
                    DiffLine::HunkHeader(_) => continue,
                };
                max_num = max_num.max(n);
            }
        }
        digits(max_num).clamp(3, 6)
    }

    pub fn new(old_path: String, new_path: String) -> Self {
        Self {
            old_path,
            new_path,
            hunks: Vec::new(),
            show_line_numbers: true,
        }
    }

    pub fn from_unified_diff(diff_text: &str, old_path: String, new_path: String) -> Self {
        let mut view = Self::new(old_path, new_path);
        let mut current_hunk: Option<DiffHunk> = None;
        let mut old_line = 0usize;
        let mut new_line = 0usize;

        for line in diff_text.lines() {
            if line.starts_with("@@") {
                // Save previous hunk
                if let Some(hunk) = current_hunk.take() {
                    view.hunks.push(hunk);
                }

                // Parse hunk header: @@ -1,3 +1,4 @@
                let header = DiffLine::HunkHeader(line.to_string());
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    let old_range = parts[1].trim_start_matches('-');
                    let new_range = parts[2].trim_start_matches('+');

                    let (old_start, old_count) = parse_range(old_range);
                    let (new_start, new_count) = parse_range(new_range);

                    old_line = old_start;
                    new_line = new_start;

                    current_hunk = Some(DiffHunk {
                        old_start,
                        old_lines: old_count,
                        new_start,
                        new_lines: new_count,
                        lines: vec![header],
                    });
                }
            } else if let Some(ref mut hunk) = current_hunk {
                if let Some(content) = line.strip_prefix('+') {
                    hunk.lines.push(DiffLine::Added {
                        line_num: new_line,
                        content: content.to_string(),
                    });
                    new_line += 1;
                } else if let Some(content) = line.strip_prefix('-') {
                    hunk.lines.push(DiffLine::Removed {
                        line_num: old_line,
                        content: content.to_string(),
                    });
                    old_line += 1;
                } else if let Some(content) = line.strip_prefix(' ') {
                    hunk.lines.push(DiffLine::Context {
                        line_num_old: old_line,
                        line_num_new: new_line,
                        content: content.to_string(),
                    });
                    old_line += 1;
                    new_line += 1;
                } else if line == "\\ No newline at end of file" {
                    // Skip this marker
                }
            }
        }

        if let Some(hunk) = current_hunk {
            view.hunks.push(hunk);
        }

        view
    }

    /// Create diff from old and new content
    pub fn from_content(
        old_content: &str,
        new_content: &str,
        old_path: String,
        new_path: String,
    ) -> Self {
        let diff_text = generate_unified_diff(old_content, new_content, &old_path, &new_path);
        Self::from_unified_diff(&diff_text, old_path, new_path)
    }

    pub fn stats(&self) -> DiffStats {
        let mut additions = 0;
        let mut deletions = 0;

        for hunk in &self.hunks {
            for line in &hunk.lines {
                match line {
                    DiffLine::Added { .. } => additions += 1,
                    DiffLine::Removed { .. } => deletions += 1,
                    _ => {}
                }
            }
        }

        DiffStats {
            additions,
            deletions,
        }
    }

    /// Rows `render()` actually paints below the header bar: one per
    /// non-`HunkHeader` line plus one separator per inter-hunk gap with a
    /// computable, non-zero unchanged count. Callers sizing a container for
    /// the widget (approval card) must use this instead of counting
    /// `hunk.lines` — raw lines include the never-printed `@@` headers.
    pub fn rendered_height(&self) -> usize {
        let mut rows = 0usize;
        let mut previous_hunk: Option<&DiffHunk> = None;
        for hunk in &self.hunks {
            rows += hunk
                .lines
                .iter()
                .filter(|line| !matches!(line, DiffLine::HunkHeader(_)))
                .count();
            if let Some(prev) = previous_hunk {
                let gap = hunk
                    .old_start
                    .saturating_sub(prev.old_start.saturating_add(prev.old_lines));
                if gap > 0 {
                    rows += 1;
                }
            }
            previous_hunk = Some(hunk);
        }
        rows
    }
}

pub struct DiffStats {
    pub additions: usize,
    pub deletions: usize,
}

impl Widget for &DiffView {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // Zero-sized areas index outside the buffer; a 1-wide area has no room
        // for the one-space text indent (text writes at `area.x + 1`), so text
        // is gated on `area.width >= 2` below. All callers pre-clamp today,
        // but the widget must survive a degenerate rect on its own.
        if area.width == 0 || area.height == 0 {
            return;
        }
        let stats = self.stats();
        let header = format!(
            " {} (+{} -{}) ",
            self.new_path, stats.additions, stats.deletions
        );

        // Render header bar with BG_PANEL() background and FG() text
        let header_style = Style::default()
            .bg(BG_PANEL())
            .fg(FG())
            .add_modifier(Modifier::BOLD);

        for x in area.x..area.x + area.width {
            buf[(x, area.y)].set_style(header_style);
        }

        if area.width >= 2 {
            buf.set_stringn(
                area.x + 1,
                area.y,
                &header,
                area.width.saturating_sub(2) as usize,
                header_style,
            );
        }

        // One right-aligned line-number column; the number itself carries the
        // change tag (added/removed tint), so no +/- sign column is printed.
        let gutter = self.gutter_width();

        // Render diff lines
        let mut y = area.y + 1;
        let max_y = area.y + area.height;

        for (i, hunk) in self.hunks.iter().enumerate() {
            if y >= max_y {
                break;
            }

            for line in &hunk.lines {
                if y >= max_y {
                    break;
                }

                // `@@ -a,b +c,d @@` headers stay in the data model but are no
                // longer printed: a between-hunk unchanged separator replaces
                // them visually.
                let (line_num, fg_style, bg_style, content) = match line {
                    DiffLine::HunkHeader(_) => continue,
                    DiffLine::Context {
                        line_num_new,
                        content,
                        ..
                    } => (
                        *line_num_new,
                        Style::default().fg(FG_MUTED()),
                        Style::default(),
                        content,
                    ),
                    DiffLine::Added { line_num, content } => (
                        *line_num,
                        Style::default().fg(DIFF_ADDED()),
                        Style::default().bg(DIFF_ADDED_BG()),
                        content,
                    ),
                    DiffLine::Removed { line_num, content } => (
                        *line_num,
                        Style::default().fg(DIFF_REMOVED()),
                        Style::default().bg(DIFF_REMOVED_BG()),
                        content,
                    ),
                };

                // Band the full row, then print gutter + content with one
                // space between them. Sign-less: the number color plus the
                // background band carry the change tag.
                for x in area.x..area.x + area.width {
                    buf[(x, y)].set_style(bg_style);
                }
                if area.width >= 2 {
                    let mut text = String::with_capacity(gutter + 1 + content.len());
                    if gutter > 0 {
                        text.push_str(&format!("{line_num:>gutter$}"));
                        text.push(' ');
                    }
                    text.push_str(content);
                    buf.set_stringn(
                        area.x + 1,
                        y,
                        &text,
                        area.width.saturating_sub(2) as usize,
                        fg_style.patch(bg_style),
                    );
                }

                y += 1;
            }

            // Between consecutive hunks: one muted row counting the unchanged
            // lines the header accounting says were skipped (only when the
            // gap is positive).
            if let Some(next) = self.hunks.get(i + 1) {
                let skipped = next
                    .old_start
                    .saturating_sub(hunk.old_start.saturating_add(hunk.old_lines));
                if skipped > 0 && y < max_y {
                    if area.width >= 2 {
                        let text = format!(" … {skipped} unchanged lines ");
                        buf.set_stringn(
                            area.x + 1,
                            y,
                            &text,
                            area.width.saturating_sub(2) as usize,
                            Style::default().fg(FG_DIM()),
                        );
                    }
                    y += 1;
                }
            }
        }
    }
}

/// Decimal digit count of `n` (minimum 1, so 0 renders as "0").
fn digits(n: usize) -> usize {
    let mut n = n;
    let mut d = 1;
    while n >= 10 {
        n /= 10;
        d += 1;
    }
    d
}

fn parse_range(range: &str) -> (usize, usize) {
    let parts: Vec<&str> = range.split(',').collect();
    let start = parts[0].parse().unwrap_or(1);
    let count = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
    (start, count)
}

/// Generate a unified diff between two file contents.
///
/// Backed by Myers (`similar`). The hand-rolled scanner this replaces claimed
/// to be "LCS-based" but never re-synced after a divergence: it drained every
/// remaining old line, then every remaining new line, so a one-line edit near
/// the top of a file rendered the whole rest of the file as deleted-then-added.
/// That fed the approval card the user reads before authorising a write.
fn generate_unified_diff(
    old_content: &str,
    new_content: &str,
    old_path: &str,
    new_path: &str,
) -> String {
    use similar::{ChangeTag, TextDiff};

    let mut result = String::new();
    result.push_str(&format!("--- {old_path}\n"));
    result.push_str(&format!("+++ {new_path}\n"));

    let diff = TextDiff::from_lines(old_content, new_content);
    for hunk in diff
        .unified_diff()
        .context_radius(CONTEXT_RADIUS)
        .iter_hunks()
    {
        result.push_str(&format!("{}\n", hunk.header()));
        for change in hunk.iter_changes() {
            let sign = match change.tag() {
                ChangeTag::Delete => '-',
                ChangeTag::Insert => '+',
                ChangeTag::Equal => ' ',
            };
            result.push(sign);
            result.push_str(change.value().trim_end_matches(['\n', '\r']));
            result.push('\n');
        }
    }

    result
}

/// Unified-diff context lines kept either side of a change.
const CONTEXT_RADIUS: usize = 3;

/// Per-edit `(additions, deletions)` between two file snapshots.
///
/// Shared by the sidebar badges and the tool-card header so one differ backs
/// every count the user sees.
pub fn count_changed_lines(old_content: &str, new_content: &str) -> (usize, usize) {
    use similar::ChangeTag;

    let diff = similar::TextDiff::from_lines(old_content, new_content);
    let mut additions = 0;
    let mut deletions = 0;
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => additions += 1,
            ChangeTag::Delete => deletions += 1,
            ChangeTag::Equal => {}
        }
    }
    (additions, deletions)
}

/// Simple line-by-line diff for preview
pub fn inline_diff_preview(
    old_line: &str,
    new_line: &str,
) -> (Vec<Span<'static>>, Vec<Span<'static>>) {
    let removed = vec![
        Span::styled(
            "- ",
            Style::default().fg(DIFF_REMOVED()).bg(DIFF_REMOVED_BG()),
        ),
        Span::styled(
            old_line.to_string(),
            Style::default().fg(DIFF_REMOVED()).bg(DIFF_REMOVED_BG()),
        ),
    ];
    let added = vec![
        Span::styled("+ ", Style::default().fg(DIFF_ADDED()).bg(DIFF_ADDED_BG())),
        Span::styled(
            new_line.to_string(),
            Style::default().fg(DIFF_ADDED()).bg(DIFF_ADDED_BG()),
        ),
    ];
    (removed, added)
}

/// Mini diff for sidebar/tooltip
pub fn mini_diff(path: &str, additions: usize, deletions: usize) -> Line<'static> {
    Line::from(vec![
        Span::styled(path.to_string(), style::text()),
        Span::styled("  ", Style::default()),
        Span::styled(format!("+{additions}"), style::success()),
        Span::styled("  ", Style::default()),
        Span::styled(format!("-{deletions}"), style::error()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two hunks with a computable gap: hunk 1 spans old lines 1..=4, the next
    /// hunk starts at old line 10 → 5 unchanged lines between them.
    const TWO_HUNK_GAP: &str = "\
@@ -1,4 +1,4 @@
 a
-b
+c
 d
 e
@@ -10,2 +10,2 @@
-j
+k
";

    /// Two hunks whose header ranges touch (3 = 1 + 2): no separator row.
    const TWO_HUNK_ADJACENT: &str = "\
@@ -1,2 +1,2 @@
-a
+b
@@ -3,1 +3,1 @@
-c
+d
";

    /// Context straddling a renumbered region: the new side starts at 20 while
    /// the old side starts at 10, so each line kind prints a different side.
    const ASYMMETRIC_SIDES: &str = "\
@@ -10,3 +20,3 @@
 ctx
-old
+new
 ctx2
";

    fn view_for(text: &str) -> DiffView {
        DiffView::from_unified_diff(text, "old.rs".into(), "new.rs".into())
    }

    fn render_at(view: &DiffView, w: u16, h: u16) -> Buffer {
        let area = Rect::new(0, 0, w, h);
        let mut buf = Buffer::empty(area);
        view.render(area, &mut buf);
        buf
    }

    fn row_text(buf: &Buffer, y: u16) -> String {
        (0..buf.area.width)
            .map(|x| buf[(x, y)].symbol().to_string())
            .collect()
    }

    #[test]
    fn separator_row_between_hunks_with_computable_gap() {
        let view = view_for(TWO_HUNK_GAP);
        let buf = render_at(&view, 60, 24);

        // Header + 5 hunk-1 rows → exactly one separator, on body row 6.
        let sep_rows: Vec<u16> = (1..buf.area.height)
            .filter(|&y| row_text(&buf, y).contains("unchanged lines"))
            .collect();
        assert_eq!(sep_rows, vec![6]);
        assert!(row_text(&buf, 6).contains("… 5 unchanged lines"));

        // Hunk 2 follows immediately after the separator.
        assert!(row_text(&buf, 7).contains('j'));
        assert!(row_text(&buf, 8).contains('k'));
        assert!(row_text(&buf, 9).trim().is_empty());
    }

    #[test]
    fn no_separator_when_hunk_gap_is_zero() {
        let view = view_for(TWO_HUNK_ADJACENT);
        let buf = render_at(&view, 60, 24);
        for y in 1..buf.area.height {
            assert!(
                !row_text(&buf, y).contains("unchanged lines"),
                "unexpected separator on row {y}"
            );
        }
        // Hunk 2 starts directly on the row after hunk 1's last line.
        assert!(row_text(&buf, 3).contains('c'));
    }

    #[test]
    fn hunk_headers_are_not_printed() {
        let view = view_for(TWO_HUNK_GAP);
        let buf = render_at(&view, 60, 24);
        for y in 0..buf.area.height {
            let row = row_text(&buf, y);
            assert!(!row.contains("@@"), "raw hunk header printed on row {y}");
        }
    }

    #[test]
    fn gutter_width_autosizes_and_clamps() {
        // 1-digit line numbers → clamped up to the 3-column minimum.
        let small = view_for("@@ -1,1 +1,1 @@\n-x\n+y\n");
        assert_eq!(small.gutter_width(), 3);

        // 5-digit line numbers widen the gutter to exactly fit.
        let big = view_for("@@ -10000,1 +10000,1 @@\n-x\n+y\n");
        assert_eq!(big.gutter_width(), 5);

        // 7-digit line numbers clamp at the 6-column maximum.
        let huge = view_for("@@ -1234567,1 +1234567,1 @@\n-x\n+y\n");
        assert_eq!(huge.gutter_width(), 6);

        // Right-aligned in the buffer: "10000" flush against the one-space
        // gap, content starting right after it.
        let buf = render_at(&big, 40, 3);
        assert_eq!(buf[(1, 1)].symbol(), "1");
        assert_eq!(buf[(5, 1)].symbol(), "0");
        assert_eq!(buf[(6, 1)].symbol(), " ", "one-space gutter/content gap");
        assert_eq!(buf[(7, 1)].symbol(), "x");
    }

    #[test]
    fn gutter_numbers_carry_side_and_tag() {
        let view = view_for(ASYMMETRIC_SIDES);
        assert_eq!(view.gutter_width(), 3);
        let buf = render_at(&view, 40, 8);

        // Rows: 1 = Context (new-side 20), 2 = Removed (old-side 11: the
        // context line at old 10 is consumed first), 3 = Added (new-side 21),
        // 4 = Context (new-side 22).
        let gutter_num = |y: u16| -> String { row_text(&buf, y)[1..4].trim().to_string() };
        assert_eq!(gutter_num(1), "20");
        assert_eq!(gutter_num(2), "11", "removed shows the OLD side");
        assert_eq!(gutter_num(3), "21");
        assert_eq!(gutter_num(4), "22");

        // The number cell carries the change-tag color; context stays muted.
        assert_eq!(buf[(3, 1)].fg, FG_MUTED());
        assert_eq!(buf[(3, 2)].fg, DIFF_REMOVED());
        assert_eq!(buf[(3, 3)].fg, DIFF_ADDED());
        assert_eq!(buf[(3, 4)].fg, FG_MUTED());
    }

    #[test]
    fn bands_cover_the_full_row() {
        let view = view_for(ASYMMETRIC_SIDES);
        let w = 40;
        let buf = render_at(&view, w, 8);
        for x in 0..w {
            assert_eq!(buf[(x, 2)].bg, DIFF_REMOVED_BG(), "removed band at x={x}");
            assert_eq!(buf[(x, 3)].bg, DIFF_ADDED_BG(), "added band at x={x}");
        }
        // Context rows keep the plain (non-band) background.
        assert_ne!(buf[(0, 1)].bg, DIFF_ADDED_BG());
        assert_ne!(buf[(0, 1)].bg, DIFF_REMOVED_BG());
    }

    #[test]
    fn body_has_no_sign_glyphs() {
        let view = view_for(TWO_HUNK_GAP);
        let buf = render_at(&view, 60, 24);
        // Skip the header row: "(+A -B)" legitimately keeps its signs.
        for y in 1..buf.area.height {
            for x in 0..buf.area.width {
                let sym = buf[(x, y)].symbol();
                assert_ne!(sym, "+", "'+' leaked into the diff body at ({x},{y})");
                assert_ne!(sym, "-", "'-' leaked into the diff body at ({x},{y})");
            }
        }
    }

    #[test]
    fn line_numbers_hidden_drops_the_gutter() {
        let mut view = view_for(ASYMMETRIC_SIDES);
        view.show_line_numbers = false;
        assert_eq!(view.gutter_width(), 0);
        let buf = render_at(&view, 40, 8);
        // Content starts immediately after the one-space indent, no gutter.
        assert_eq!(buf[(1, 2)].symbol(), "o");
        assert_eq!(buf[(2, 2)].symbol(), "l");
    }

    #[test]
    fn degenerate_rects_do_not_panic() {
        let view = view_for(TWO_HUNK_GAP);
        for (w, h) in [(0u16, 0u16), (1, 1), (2, 1), (1, 5), (2, 5), (3, 3)] {
            let buf = render_at(&view, w, h);
            assert_eq!((buf.area.width, buf.area.height), (w, h));
        }
    }

    /// The bug this differ replaced: the old scanner never re-synced after a
    /// divergence, so editing one line of a three-line function reported
    /// `(+2 -2)` and printed the closing brace twice. Visible in the harness
    /// shot `diff_peek_80x24.txt`.
    #[test]
    fn a_one_line_edit_is_one_addition_and_one_deletion() {
        let old = "fn send() {\n    client.get(url).send()\n}\n";
        let new = "fn send() {\n    retry(3, || client.get(url).send())\n}\n";

        assert_eq!(count_changed_lines(old, new), (1, 1));

        let unified = generate_unified_diff(old, new, "a.rs", "b.rs");
        let removed: Vec<&str> = unified
            .lines()
            .filter(|l| l.starts_with('-') && !l.starts_with("---"))
            .collect();
        let added: Vec<&str> = unified
            .lines()
            .filter(|l| l.starts_with('+') && !l.starts_with("+++"))
            .collect();
        assert_eq!(removed, vec!["-    client.get(url).send()"]);
        assert_eq!(added, vec!["+    retry(3, || client.get(url).send())"]);
        // The trailing brace is shared context, not a delete-then-add pair.
        assert_eq!(
            unified.matches("}").count(),
            1,
            "closing brace duplicated:\n{unified}"
        );
    }

    /// An edit near the top of a long file must not mark the remainder changed.
    #[test]
    fn an_early_edit_does_not_cascade_through_the_file() {
        let old: String = (0..200).map(|i| format!("line {i}\n")).collect();
        let new = old.replacen("line 3\n", "line 3 edited\n", 1);
        assert_eq!(count_changed_lines(&old, &new), (1, 1));
    }

    /// Counting is positional, not set membership. The old helpers asked
    /// "does the other side contain this line at all", so a duplicated line
    /// counted as zero additions and a moved line as neither.
    #[test]
    fn duplicated_and_moved_lines_are_counted() {
        assert_eq!(count_changed_lines("a\n", "a\na\n"), (1, 0));
        assert_eq!(count_changed_lines("a\nb\n", "b\na\n"), (1, 1));
        assert_eq!(count_changed_lines("a\n", "a\n"), (0, 0));
    }
}
