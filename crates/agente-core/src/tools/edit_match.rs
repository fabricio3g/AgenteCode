//! One matcher for every edit call.
//!
//! The model is unreliable about exactness — aider's leaderboard puts the
//! search/replace format at 86.7–97.8 % well formed even for frontier models —
//! so the tool, not the model, has to absorb drift. But absorbing it must
//! never mean guessing: an edit that lands in the wrong place is far worse
//! than one that refuses.
//!
//! So edits go through a graded ladder, first level with **exactly one**
//! match wins:
//!
//! | level | tolerates |
//! |---|---|
//! | exact | nothing |
//! | trailing | trailing whitespace per line |
//! | whitespace | any run of spaces/tabs, and indentation |
//! | normalized | CRLF/BOM, Unicode quotes, dashes, NBSP |
//! | blank-line tolerant | blank lines in `old` match anything |
//! | similar | token overlap ≥ 0.90, unique best only |
//!
//! Ambiguity is a refusal that hands back the candidates and the exact text
//! to retry with — the error is the instruction.

use std::ops::Range;

/// How much the file had to be coaxed to match the requested `old` text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchLevel {
    /// Byte-identical.
    Exact,
    /// Trailing whitespace differed per line.
    Trailing,
    /// Indentation or runs of spaces/tabs differed.
    Whitespace,
    /// Unicode punctuation, CRLF or a BOM differed.
    Normalized,
    /// Blank lines in `old` were treated as wildcards.
    BlankTolerant,
    /// Token overlap, in percent (90..=100). Never used when a stricter level
    /// could match.
    Similar(u8),
}

impl MatchLevel {
    /// What the tool result calls this, so the transcript says what happened.
    pub fn label(self) -> String {
        match self {
            Self::Exact => "exact".to_string(),
            Self::Trailing => "trailing whitespace".to_string(),
            Self::Whitespace => "whitespace".to_string(),
            Self::Normalized => "normalized".to_string(),
            Self::BlankTolerant => "blank-line tolerant".to_string(),
            Self::Similar(pct) => format!("similar {pct}%"),
        }
    }

    /// True when the file matched byte for byte, so `old` can be trusted as
    /// context for the surrounding lines.
    pub fn is_exact(self) -> bool {
        matches!(self, Self::Exact)
    }
}

/// One place the requested text could apply.
#[derive(Debug, Clone)]
pub struct Found {
    /// Byte range in the file to replace (never includes the newline that
    /// follows the last matched line).
    pub range: Range<usize>,
    /// 1-based line of `range.start`.
    pub line: usize,
    pub level: MatchLevel,
}

impl Found {
    /// 1-based last line of the match.
    pub fn end_line(&self, content: &str) -> usize {
        line_of(
            content,
            self.range.end.saturating_sub(1).max(self.range.start),
        )
    }
}

/// The outcome of looking for one edit.
#[derive(Debug)]
pub enum EditMatch {
    /// Exactly one place matched, at `level`.
    Found(Found),
    /// More than one place matched at `level`; the line numbers of the first
    /// few. Never resolved by picking one.
    Ambiguous {
        level: MatchLevel,
        lines: Vec<usize>,
    },
    /// No level matched.
    NotFound,
}

/// A file split into `(byte offset, text)` lines. The text excludes the line
/// terminator, so a range built from line starts keeps the original `\n`
/// (or `\r\n`) that follows the last line.
fn split_lines(content: &str) -> Vec<(usize, &str)> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    for (index, byte) in content.bytes().enumerate() {
        if byte == b'\n' {
            let mut text = &content[start..index];
            if let Some(stripped) = text.strip_suffix('\r') {
                text = stripped;
            }
            lines.push((start, text));
            start = index + 1;
        }
    }
    if start < content.len() {
        lines.push((start, &content[start..]));
    }
    lines
}

/// 1-based line number of a byte offset.
pub fn line_of(content: &str, offset: usize) -> usize {
    // Byte-wise on purpose: callers pass `range.end - 1`, which can sit inside
    // a multi-byte character. Counting newlines in the bytes cannot panic.
    let bytes = content.as_bytes();
    let offset = offset.min(bytes.len());
    bytes[..offset]
        .iter()
        .filter(|byte| **byte == b'\n')
        .count()
        + 1
}

/// The line terminator the file itself uses, so a replacement written with
/// `\n` does not create a mixed-ending file.
pub fn line_ending(content: &str) -> &'static str {
    let crlf = content.matches("\r\n").count();
    let lf = content.matches('\n').count().saturating_sub(crlf);
    if crlf > lf {
        "\r\n"
    } else {
        "\n"
    }
}

/// Convert `text`'s `\n` to `ending` (no-op for LF).
pub fn with_line_ending(text: &str, ending: &str) -> String {
    if ending == "\n" {
        text.to_string()
    } else {
        text.replace("\r\n", "\n").replace('\n', ending)
    }
}

/// Fold the characters models get wrong when they retype a line: smart
/// quotes, en/em dashes, the minus sign and the various spaces.
fn fold(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

/// Whitespace-insensitive key for one line: indentation, trailing spaces and
/// runs of spaces/tabs all collapse.
fn whitespace_key(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn key(level: MatchLevel, text: &str) -> String {
    match level {
        MatchLevel::Exact => text.to_string(),
        MatchLevel::Trailing => text.trim_end().to_string(),
        MatchLevel::Whitespace => whitespace_key(text),
        MatchLevel::Normalized | MatchLevel::BlankTolerant => fold(&whitespace_key(text)),
        MatchLevel::Similar(_) => fold(&whitespace_key(text)),
    }
}

/// Above this file size only the cheap levels run: a full window scan with
/// similarity scoring on a multi-megabyte file would cost more than it can
/// possibly save.
const SCAN_LIMIT_BYTES: usize = 512 * 1024;
/// Above this many lines in `old`, similarity scoring is skipped.
const SIMILAR_LIMIT_LINES: usize = 400;
/// Minimum token overlap for [`MatchLevel::Similar`].
const SIMILAR_THRESHOLD: u8 = 90;

/// Find where one edit applies.
///
/// `near_line` (1-based, from `read_file`) only breaks ties between matches
/// that are otherwise equal; it never lets an edit land somewhere the text
/// does not match.
pub fn locate(content: &str, old: &str, near_line: Option<usize>) -> EditMatch {
    if old.is_empty() {
        return EditMatch::NotFound;
    }

    let file_lines = split_lines(content);
    let old_lines: Vec<&str> = split_lines(old).into_iter().map(|(_, text)| text).collect();
    // `split_lines` drops a trailing empty line, which is what we want: an
    // `old` ending in "\n" addresses the same block as one without.
    let old_lines = if old_lines.is_empty() {
        vec![old.trim_end_matches(['\r', '\n'])]
    } else {
        old_lines
    };

    // L0: a byte search, so `old` may address part of a line.
    let exact_hits: Vec<usize> = content.match_indices(old).map(|(at, _)| at).collect();
    if !exact_hits.is_empty() {
        return resolve(
            exact_hits
                .into_iter()
                .map(|at| Found {
                    range: at..at + old.len(),
                    line: line_of(content, at),
                    level: MatchLevel::Exact,
                })
                .collect(),
            near_line,
            MatchLevel::Exact,
        );
    }

    let levels = [
        MatchLevel::Trailing,
        MatchLevel::Whitespace,
        MatchLevel::Normalized,
    ];
    for level in levels {
        let hits = window_hits(content, &file_lines, &old_lines, level);
        if !hits.is_empty() {
            return resolve(hits, near_line, level);
        }
    }

    // A fragment of a line (`say "hello"` inside `say “hello” world`) cannot
    // be found by a line window; folding with a byte map can find it without
    // guessing at byte lengths.
    let fragments = folded_substring_hits(content, old);
    if !fragments.is_empty() {
        return resolve(fragments, near_line, MatchLevel::Normalized);
    }

    let blanks = blank_tolerant_hits(content, &file_lines, &old_lines);
    if !blanks.is_empty() {
        return resolve(blanks, near_line, MatchLevel::BlankTolerant);
    }

    if content.len() <= SCAN_LIMIT_BYTES && old_lines.len() <= SIMILAR_LIMIT_LINES {
        if let Some(found) = similar_hit(content, &file_lines, &old_lines) {
            return EditMatch::Found(found);
        }
    }

    EditMatch::NotFound
}

/// How many times `text` appears in `content` (exact, then whitespace/
/// normalized). Used for the already-applied check.
pub fn occurrences(content: &str, text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let exact = content.match_indices(text).count();
    if exact > 0 {
        return exact;
    }
    let folded = fold(&text.replace("\r\n", "\n"));
    if folded.trim().is_empty() {
        return 0;
    }
    fold(&content.replace("\r\n", "\n"))
        .match_indices(&folded)
        .count()
}

fn window_hits(
    content: &str,
    file_lines: &[(usize, &str)],
    old_lines: &[&str],
    level: MatchLevel,
) -> Vec<Found> {
    let count = old_lines.len();
    if count == 0 || count > file_lines.len() {
        return Vec::new();
    }
    let old_keys: Vec<String> = old_lines.iter().map(|line| key(level, line)).collect();
    let file_keys: Vec<String> = file_lines
        .iter()
        .map(|(_, text)| key(level, text))
        .collect();

    let mut hits = Vec::new();
    for start in 0..=file_lines.len() - count {
        if (0..count).all(|i| old_keys[i] == file_keys[start + i]) {
            let (line_start, _) = file_lines[start];
            let (last_start, last_text) = file_lines[start + count - 1];
            hits.push(Found {
                range: line_start..last_start + last_text.len(),
                line: line_of(content, line_start),
                level,
            });
            if hits.len() > 16 {
                break;
            }
        }
    }
    hits
}

/// Blank lines in `old` (and blank lines the file added) are wildcards: the
/// non-blank lines must match in order, and the replaced span still covers
/// everything between the first and last matched line.
fn blank_tolerant_hits(
    content: &str,
    file_lines: &[(usize, &str)],
    old_lines: &[&str],
) -> Vec<Found> {
    let old_kept: Vec<String> = old_lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| key(MatchLevel::BlankTolerant, line))
        .collect();
    if old_kept.is_empty() {
        return Vec::new();
    }
    let kept: Vec<usize> = file_lines
        .iter()
        .enumerate()
        .filter(|(_, (_, text))| !text.trim().is_empty())
        .map(|(index, _)| index)
        .collect();
    if old_kept.len() > kept.len() {
        return Vec::new();
    }
    let file_keys: Vec<String> = kept
        .iter()
        .map(|index| key(MatchLevel::BlankTolerant, file_lines[*index].1))
        .collect();
    let mut hits = Vec::new();
    for start in 0..=kept.len() - old_kept.len() {
        if !(0..old_kept.len()).all(|i| old_kept[i] == file_keys[start + i]) {
            continue;
        }
        let first = kept[start];
        let last = kept[start + old_kept.len() - 1];
        let (line_start, _) = file_lines[first];
        let (last_start, last_text) = file_lines[last];
        hits.push(Found {
            range: line_start..last_start + last_text.len(),
            line: line_of(content, line_start),
            level: MatchLevel::BlankTolerant,
        });
        if hits.len() > 16 {
            break;
        }
    }
    hits
}

/// Block similarity, line by line: an identical line counts fully, a line with
/// at least half its tokens in common counts half. That is the realistic
/// near-miss (one line retyped differently in an otherwise exact block) — a
/// whole block of renamed identifiers is not an anchor and must be refused.
fn block_similarity(old_lines: &[&str], file_lines: &[(usize, &str)]) -> u8 {
    if old_lines.is_empty() {
        return 0;
    }
    let mut score = 0.0f32;
    for (old, (_, text)) in old_lines.iter().zip(file_lines) {
        let expected = key(MatchLevel::BlankTolerant, old);
        let actual = key(MatchLevel::BlankTolerant, text);
        if expected == actual {
            score += 1.0;
        } else if line_overlap(&expected, &actual) >= 50 {
            score += 0.5;
        }
    }
    (score / old_lines.len() as f32 * 100.0)
        .round()
        .clamp(0.0, 100.0) as u8
}

fn line_overlap(a: &str, b: &str) -> u8 {
    let left: Vec<String> = a.split_whitespace().map(str::to_string).collect();
    let right: Vec<String> = b.split_whitespace().map(str::to_string).collect();
    overlap_percent(&left, &right)
}

/// Best line-level similarity window, only when it is unambiguous.
fn similar_hit(content: &str, file_lines: &[(usize, &str)], old_lines: &[&str]) -> Option<Found> {
    let count = old_lines.len();
    if count == 0 || count > file_lines.len() {
        return None;
    }
    let mut best: Option<(u8, Found)> = None;
    let mut second_best = 0u8;
    for start in 0..=file_lines.len() - count {
        let score = block_similarity(old_lines, &file_lines[start..start + count]);
        if score < SIMILAR_THRESHOLD {
            continue;
        }
        let (line_start, _) = file_lines[start];
        let (last_start, last_text) = file_lines[start + count - 1];
        let candidate = Found {
            range: line_start..last_start + last_text.len(),
            line: line_of(content, line_start),
            level: MatchLevel::Similar(score),
        };
        match &best {
            Some((best_score, _)) if *best_score >= score => second_best = second_best.max(score),
            Some((best_score, _)) => {
                second_best = second_best.max(*best_score);
                best = Some((score, candidate));
            }
            None => best = Some((score, candidate)),
        }
    }
    // A near-tie is not a match: the model must widen the context.
    best.filter(|(score, _)| *score > second_best.saturating_add(2))
        .map(|(_, found)| found)
}

/// Dice coefficient over token multisets, in percent.
fn overlap_percent(a: &[String], b: &[String]) -> u8 {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    let mut remaining: Vec<&String> = b.iter().collect();
    let mut shared = 0usize;
    for token in a {
        if let Some(position) = remaining.iter().position(|candidate| *candidate == token) {
            remaining.remove(position);
            shared += 1;
        }
    }
    ((shared * 2 * 100) / (a.len() + b.len())) as u8
}

fn resolve(hits: Vec<Found>, near_line: Option<usize>, level: MatchLevel) -> EditMatch {
    match hits.len() {
        0 => EditMatch::NotFound,
        1 => EditMatch::Found(hits.into_iter().next().expect("length checked")),
        _ => {
            if let Some(near) = near_line {
                // Distance to the requested line; a tie is still ambiguous.
                let mut ranked: Vec<(usize, Found)> = hits
                    .into_iter()
                    .map(|found| (found.line.abs_diff(near.max(1)), found))
                    .collect();
                ranked.sort_by_key(|(distance, _)| *distance);
                if ranked.len() == 1 || ranked[0].0 != ranked[1].0 {
                    return EditMatch::Found(ranked.remove(0).1);
                }
                return EditMatch::Ambiguous {
                    level,
                    lines: ranked.into_iter().map(|(_, found)| found.line).collect(),
                };
            }
            EditMatch::Ambiguous {
                level,
                lines: hits.into_iter().map(|found| found.line).collect(),
            }
        }
    }
}

/// Fold with a char→byte map, so a folded substring can be translated back to
/// the original bytes. Folding changes byte lengths (a curly quote is three
/// bytes, its ASCII twin one), which is exactly why the map is needed.
fn fold_with_mapping(text: &str) -> (String, Vec<usize>) {
    let mut folded = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len());
    for (offset, ch) in text.char_indices() {
        let folded_char = fold(&ch.to_string());
        for mapped in folded_char.chars() {
            folded.push(mapped);
            map.push(offset);
        }
    }
    (folded, map)
}

/// Partial-line `old` text ("say \"hello\"" inside `say “hello” world`). The
/// line-window levels compare whole lines, so this is the only level that can
/// find a fragment; it is uniqueness-checked like every other level.
fn folded_substring_hits(content: &str, old: &str) -> Vec<Found> {
    let (haystack, map) = fold_with_mapping(content);
    let needle = fold_with_mapping(old).0;
    if needle.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    let mut from = 0usize;
    while from <= haystack.len() {
        let Some(relative) = haystack[from..].find(&needle) else {
            break;
        };
        let at = from + relative;
        let start_char = haystack[..at].chars().count();
        let end_char = start_char + needle.chars().count();
        let start = map[start_char];
        let end = map.get(end_char).copied().unwrap_or(content.len());
        hits.push(Found {
            range: start..end,
            line: line_of(content, start),
            level: MatchLevel::Normalized,
        });
        if hits.len() > 16 {
            break;
        }
        from = at + relative_len(&haystack, at, &needle);
        if from >= haystack.len() {
            break;
        }
    }
    hits
}

/// Advance past this hit without landing inside a character.
fn relative_len(haystack: &str, at: usize, needle: &str) -> usize {
    let mut end = (at + needle.len()).min(haystack.len());
    while end < haystack.len() && !haystack.is_char_boundary(end) {
        end += 1;
    }
    end - at
}

/// The shortest expansion of `old` that is unique in the file. Handed back in
/// the error so the retry can succeed on the first try.
pub fn unique_snippet(content: &str, old: &str, line: usize) -> Option<String> {
    let file_lines = split_lines(content);
    let old_lines = split_lines(old);
    if old_lines.is_empty() || file_lines.is_empty() {
        return None;
    }
    let start_index = line.saturating_sub(1);
    if start_index >= file_lines.len() {
        return None;
    }
    let count = old_lines.len();
    for extra in 0..=3usize {
        for (before, after) in [(0, extra), (extra, 0), (extra, extra)] {
            let from = start_index.saturating_sub(before);
            let to = (start_index + count - 1 + after).min(file_lines.len().saturating_sub(1));
            if from > start_index || to < start_index + count - 1 {
                continue;
            }
            let snippet = join_lines(&file_lines[from..=to]);
            if is_unique(content, &snippet) {
                return Some(snippet);
            }
        }
    }
    None
}

fn join_lines(lines: &[(usize, &str)]) -> String {
    lines
        .iter()
        .map(|(_, text)| *text)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Whether `text` appears at exactly one place, at any tolerance.
pub fn is_unique(content: &str, text: &str) -> bool {
    matches!(locate(content, text, None), EditMatch::Found(_)) && occurrences(content, text) == 1
}

/// `Could not find edits[n] …`: what was searched, the closest region with
/// line numbers, and the exact text to retry with.
pub fn not_found_error(path: &str, index: usize, old: &str, content: &str) -> String {
    let mut message = format!(
        "Could not find edits[{index}] in {path} at any tolerance \
         (exact, trailing whitespace, indentation, normalized)."
    );
    if old.contains('\u{2026}') || old.contains("...") {
        message.push_str(
            "\nThe old text contains an ellipsis: copy the real lines instead of abbreviating.",
        );
    }
    match closest_line(content, old) {
        Some(line) => {
            message.push_str(&format!("\n\nClosest region (line {line}):\n"));
            message.push_str(&numbered_context(content, line, 2, 2));
            if let Some(snippet) = snippet_around(content, line, old) {
                message.push_str(&format!(
                    "\n\nRetry with the exact current text as old:\n  \"old\": {}",
                    json_string(&snippet)
                ));
            }
        }
        None if content.trim().is_empty() => {
            message.push_str("\nThe file is empty, so there is nothing to match.");
        }
        None => message.push_str(&format!(
            "\nNo line in the file ({} bytes) resembles {}; nothing was changed.",
            content.len(),
            json_string(&first_line(old))
        )),
    }
    message
}

/// First non-empty line of `old`, trimmed and shortened for an error message.
fn first_line(old: &str) -> String {
    let line = old
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    if line.chars().count() > 80 {
        let head: String = line.chars().take(80).collect();
        format!("{head}…")
    } else {
        line.to_string()
    }
}

/// `Found N occurrences …`: where they are, and a unique snippet for each.
pub fn ambiguous_error(
    path: &str,
    index: usize,
    old: &str,
    content: &str,
    level: MatchLevel,
    lines: &[usize],
) -> String {
    let mut message = format!(
        "Could not find edits[{index}] in {path}: {} place(s) match with {} tolerance.",
        lines.len(),
        level.label()
    );
    message.push_str("\nUse more surrounding lines, or pass nearLine.");
    for line in lines.iter().take(3) {
        message.push_str(&format!("\n\nline {line}:\n"));
        message.push_str(&numbered_context(content, *line, 1, 1));
        if let Some(found) = found_at_line(content, old, *line, level) {
            if let Some(snippet) = unique_snippet(content, &found, *line) {
                message.push_str(&format!(
                    "\nunique old for this one:\n  {}",
                    json_string(&snippet)
                ));
            }
        }
    }
    message
}

fn found_at_line(content: &str, old: &str, line: usize, level: MatchLevel) -> Option<String> {
    let file_lines = split_lines(content);
    let old_lines = split_lines(old);
    if old_lines.is_empty() {
        return None;
    }
    let start = file_lines
        .iter()
        .position(|(offset, _)| line_of(content, *offset) == line)?;
    let to = (start + old_lines.len()).min(file_lines.len());
    if start >= to {
        return None;
    }
    // Only return the text when it really matches at this level.
    let snippet = join_lines(&file_lines[start..to]);
    match locate(content, &snippet, Some(line)) {
        EditMatch::Found(found) if found.line == line => Some(snippet),
        _ => {
            let _ = level;
            None
        }
    }
}

fn snippet_around(content: &str, line: usize, old: &str) -> Option<String> {
    let file_lines = split_lines(content);
    let count = split_lines(old).len().max(1);
    let start = file_lines
        .iter()
        .position(|(offset, _)| line_of(content, *offset) == line)?;
    let to = (start + count).min(file_lines.len());
    Some(join_lines(&file_lines[start..to]))
}

fn closest_line(content: &str, old: &str) -> Option<usize> {
    let needle = old.lines().map(str::trim).find(|line| !line.is_empty())?;
    let needle_tokens: Vec<String> = needle.split_whitespace().map(str::to_string).collect();
    let mut best: Option<(u8, usize)> = None;
    for (offset, text) in split_lines(content) {
        let tokens: Vec<String> = text.split_whitespace().map(str::to_string).collect();
        // Whole-token overlap first, then character bigrams: the common miss is
        // a typo or a stale line (`changd` for `changed`), not an unrelated
        // search, and the model needs the real line back in both cases.
        let score = overlap_percent(&needle_tokens, &tokens).max(bigram_overlap(needle, text));
        let line = line_of(content, offset);
        if best.is_none_or(|(best_score, _)| score > best_score) {
            best = Some((score, line));
        }
    }
    best.filter(|(score, _)| *score >= 40).map(|(_, line)| line)
}

/// Dice coefficient over character bigrams, in percent. Cheap and tolerant of
/// the one-character slips that token overlap cannot see.
fn bigram_overlap(a: &str, b: &str) -> u8 {
    fn grams(text: &str) -> Vec<String> {
        let chars: Vec<char> = text.chars().collect();
        if chars.len() < 2 {
            return vec![text.to_string()];
        }
        chars.windows(2).map(|pair| pair.iter().collect()).collect()
    }
    let left = grams(a);
    let mut right = grams(b);
    if left.is_empty() || right.is_empty() {
        return 0;
    }
    let mut shared = 0usize;
    for gram in &left {
        if let Some(position) = right.iter().position(|candidate| candidate == gram) {
            right.remove(position);
            shared += 1;
        }
    }
    ((shared * 2 * 100) / (left.len() + right.len())) as u8
}

fn numbered_context(content: &str, line: usize, before: usize, after: usize) -> String {
    let lines: Vec<&str> = split_lines(content)
        .into_iter()
        .map(|(_, text)| text)
        .collect();
    let start = line.saturating_sub(before).max(1);
    let end = (line + after).min(lines.len());
    let width = end.to_string().len();
    let mut out = String::new();
    for number in start..=end {
        let marker = if number == line { ">" } else { " " };
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!(
            "{marker} {number:>width$} | {}",
            lines[number - 1]
        ));
    }
    out
}

/// JSON-quote a snippet so the model can paste it straight into `old`.
fn json_string(text: &str) -> String {
    serde_json::Value::String(text.to_string()).to_string()
}

/// Replace `range` with `new`, keeping the file's own line endings and
/// avoiding a doubled blank line when `new` ends with a newline the range
/// already leaves in place.
pub fn apply(content: &str, range: Range<usize>, new: &str) -> String {
    let ending = line_ending(content);
    let mut replacement = with_line_ending(new, ending);
    if replacement.ends_with(ending) && content[range.end..].starts_with('\n') {
        replacement.truncate(replacement.len() - ending.len());
    }
    let mut out = String::with_capacity(content.len() + replacement.len());
    out.push_str(&content[..range.start]);
    out.push_str(&replacement);
    out.push_str(&content[range.end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "impl Spend {\n    pub fn label(&self) -> Option<String> {\n        let cost = self.cost_label();\n        let cache = self.cache_hit_rate();\n    }\n}\n";

    fn found(content: &str, old: &str) -> (MatchLevel, usize) {
        match locate(content, old, None) {
            EditMatch::Found(found) => (found.level, found.line),
            other => panic!("expected a match, got {other:?}"),
        }
    }

    #[test]
    fn exact_text_is_exact() {
        let (level, line) = found(FILE, "let cost = self.cost_label();");
        assert_eq!(level, MatchLevel::Exact);
        assert_eq!(line, 3);
    }

    #[test]
    fn indentation_drift_still_lands_on_the_intended_block() {
        // Four spaces where the file has eight, as a model retyping from
        // memory produces.
        let old = "    pub fn label(&self) -> Option<String> {\n    let cost = self.cost_label();";
        let (level, line) = found(FILE, old);
        assert_eq!(level, MatchLevel::Whitespace);
        assert_eq!(line, 2);
    }

    #[test]
    fn trailing_whitespace_is_the_first_tolerance() {
        let mut spaced = String::from("    pub fn label(&self) -> Option<String> {\n");
        spaced.push_str("        let cost = self.cost_label();   ");
        let (level, _) = found(FILE, &spaced);
        assert_eq!(level, MatchLevel::Trailing);
    }

    #[test]
    fn smart_quotes_and_crlf_are_normalized() {
        // A CRLF file with an LF `old`: line splitting drops the terminator, so
        // the first line window that succeeds is the trailing-whitespace one.
        let windows = FILE.replace('\n', "\r\n");
        let old =
            "    pub fn label(&self) -> Option<String> {\n        let cost = self.cost_label();";
        assert_eq!(found(&windows, old).0, MatchLevel::Trailing);
        // A fragment of a line is found by folding with a byte map, in either
        // direction: the file may hold the curly form, the model the straight one.
        let quoted = "let note = \u{201C}done\u{201D};";
        assert_eq!(
            found("let note = \"done\";", quoted).0,
            MatchLevel::Normalized
        );
        assert_eq!(
            found(quoted, "let note = \"done\";").0,
            MatchLevel::Normalized
        );
    }

    #[test]
    fn a_dropped_blank_line_is_tolerated() {
        let content = "fn a() {\n\n    let x = 1;\n}\n";
        let old = "fn a() {\n    let x = 1;";
        assert_eq!(found(content, old).0, MatchLevel::BlankTolerant);
    }

    #[test]
    fn duplicates_are_ambiguous_not_guessed() {
        let content = "let x = 1;\nlet y = 2;\nlet x = 1;\n";
        match locate(content, "let x = 1;", None) {
            EditMatch::Ambiguous { lines, level } => {
                assert_eq!(lines, vec![1, 3]);
                assert_eq!(level, MatchLevel::Exact);
            }
            other => panic!("expected ambiguity, got {other:?}"),
        }
    }

    #[test]
    fn a_near_line_breaks_a_tie_but_never_invents_a_match() {
        let content = "let x = 1;\nlet y = 2;\nlet x = 1;\n";
        match locate(content, "let x = 1;", Some(3)) {
            EditMatch::Found(found) => assert_eq!(found.line, 3),
            other => panic!("expected the near match, got {other:?}"),
        }
        // Ambiguity between two equally close lines stays ambiguous.
        match locate(content, "let x = 1;", Some(2)) {
            EditMatch::Ambiguous { .. } => {}
            other => panic!("expected ambiguity, got {other:?}"),
        }
        assert!(matches!(
            locate(content, "let z = 9;", Some(1)),
            EditMatch::NotFound
        ));
    }

    #[test]
    fn a_block_with_one_retyped_line_still_matches_and_a_vague_one_does_not() {
        let content = "fn build(items: &[Item]) -> Report {\n    let mut report = Report::new();\n    for item in items {\n        report.push(item);\n    }\n    report\n}\n";
        // One line retyped differently inside an otherwise exact block: the
        // realistic near-miss.
        let almost = "fn build(items: &[Item]) -> Report {\n    let mut report = Report::new();\n    for entry in items {\n        report.push(item);\n    }\n    report";
        let level = found(content, almost).0;
        assert!(
            matches!(level, MatchLevel::Similar(pct) if pct >= 90),
            "{level:?}"
        );
        // A block that only shares a shape is not an anchor.
        assert!(matches!(
            locate(
                content,
                "fn make(rows: &[Row]) -> Summary {\n    summary\n}",
                None
            ),
            EditMatch::NotFound
        ));
        assert!(matches!(
            locate(content, "completely unrelated text here", None),
            EditMatch::NotFound
        ));
    }

    #[test]
    fn a_near_tie_is_refused() {
        // Two windows with identical scores: similarity must not pick one.
        let content = "a b c d\na b c d\n";
        assert!(matches!(
            locate(content, "a b c e", None),
            EditMatch::Ambiguous { .. } | EditMatch::NotFound
        ));
    }

    #[test]
    fn the_error_hands_back_the_exact_text_to_retry_with() {
        let message = not_found_error("src/x.rs", 0, "let cost = self.cost_label();", FILE);
        assert!(
            message.starts_with("Could not find edits[0] in src/x.rs"),
            "{message}"
        );
        assert!(message.contains("Closest region (line 3)"), "{message}");
        assert!(
            message.contains("3 |         let cost = self.cost_label();"),
            "{message}"
        );
        assert!(
            message.contains("\"old\": \"        let cost = self.cost_label();\""),
            "{message}"
        );
    }

    #[test]
    fn the_ambiguity_error_names_the_places_and_a_unique_snippet() {
        let content = "fn a() {\n    run();\n}\nfn b() {\n    run();\n}\n";
        match locate(content, "    run();", None) {
            EditMatch::Ambiguous { lines, level } => {
                let message = ambiguous_error("src/x.rs", 0, "    run();", content, level, &lines);
                assert!(message.contains("2 place(s) match"), "{message}");
                assert!(
                    message.contains("line 2") && message.contains("line 5"),
                    "{message}"
                );
                assert!(message.contains("unique old for this one"), "{message}");
            }
            other => panic!("expected ambiguity, got {other:?}"),
        }
    }

    #[test]
    fn the_unique_snippet_is_actually_unique() {
        let content = "fn a() {\n    run();\n}\nfn b() {\n    run();\n}\n";
        let snippet = unique_snippet(content, "    run();", 2).expect("snippet");
        assert!(is_unique(content, &snippet), "{snippet}");
        assert!(snippet.contains("fn a()"), "{snippet}");

        let second = unique_snippet(content, "    run();", 5).expect("second snippet");
        assert!(is_unique(content, &second), "{second}");
        assert!(second.contains("fn b()"), "{second}");
        assert!(!second.contains("fn a()"), "{second}");
    }

    #[test]
    fn already_applied_text_is_detected() {
        assert_eq!(occurrences(FILE, "let cost = self.cost_label();"), 1);
        assert_eq!(occurrences(FILE, "nothing like this"), 0);
        // A normalized match counts too, so a CRLF re-send is still "applied".
        assert_eq!(
            occurrences(&FILE.replace('\n', "\r\n"), "let cost = self.cost_label();"),
            1
        );
    }

    #[test]
    fn replacing_keeps_crlf_files_crlf() {
        let content = "a\r\nb\r\nc\r\n";
        let old = "b";
        let EditMatch::Found(found) = locate(content, old, None) else {
            panic!("no match");
        };
        let updated = apply(content, found.range, "B1\nB2");
        assert_eq!(updated, "a\r\nB1\r\nB2\r\nc\r\n");
    }

    #[test]
    fn a_replacement_ending_in_a_newline_does_not_double_it() {
        let content = "one\ntwo\nthree\n";
        let EditMatch::Found(found) = locate(content, "two", None) else {
            panic!("no match");
        };
        assert_eq!(apply(content, found.range, "TWO\n"), "one\nTWO\nthree\n");
    }
}
