//! Unit tests for chat rendering, tool grouping, caching, and streaming wrap.

use ratatui::text::Span;

use crate::state::{Fold, RenderedChatBlock, StreamMarkdownCache, SubagentUiState, UiState};
use crate::widgets::display_width;

use super::blocks::{
    render_assistant, render_entry_block, render_subagent, render_thinking_block, render_tool,
    shell_display, subagent_activity, worked_for_duration,
};
use super::snapshot::{
    derive_tool_groups, render_group_header_block, skipped_entries, subagent_fingerprint,
    GroupInfo, HistoryRenderCtx, ToolFamily,
};
use super::streaming::render_streaming;
use super::*;

#[test]
fn task_spawn_results_hide_behind_their_subagent_card() {
    let card = agente_core::types::ChatEntry {
        subagent_id: Some("a4fd3374".into()),
        ..tool_entry("task", "Explore the repo", None)
    };
    let echo = tool_entry(
        "task",
        "Subagent a4fd3374 (running) started.\nstatus: running",
        None,
    );
    let unrelated = tool_entry("task", "Subagent zzzz started.", None);
    let history = vec![card, echo, unrelated];
    let ctx = HistoryRenderCtx {
        live_tools: &std::collections::HashMap::new(),
        subagents: &std::collections::HashMap::new(),
    };
    assert_eq!(skipped_entries(&history, &ctx), vec![false, true, false]);
}

#[test]
fn subagent_card_stays_compact_with_long_history() {
    let mut entry = tool_entry("task", "Explore", None);
    entry.subagent_id = Some("child".into());
    entry.subagent_type = Some("explore".into());
    let mut ui = SubagentUiState {
        status: "running".into(),
        description: "Explore the project".into(),
        streaming_text: "old output\n".repeat(10_000),
        ..Default::default()
    };
    ui.tool_rows = (0..10_000)
        .map(|i| crate::state::SubagentToolRow {
            call_id: i.to_string(),
            name: "read_file".into(),
            args: format!(r#"{{"path":"src/file{i}.rs"}}"#),
            result: Some("large output\n".repeat(10)),
            is_error: false,
            finished: true,
        })
        .collect();
    for width in [1, 3, 20, 60, 100] {
        let lines = render_subagent(&entry, width, Some(&ui), true);
        assert_eq!(lines.len(), 3, "header + activity + gap");
        assert!(lines.iter().all(|line| line.width() <= width));
        assert!(
            lines[..2]
                .iter()
                .flat_map(|line| &line.spans)
                .all(|span| span.style.bg == Some(BG())),
            "flat canvas, no band"
        );
    }
    // `⧗ Explore  desc ··· running` then `└ <activity> · 10000 tools`.
    let text = |line: &Line<'static>| -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    };
    let lines = render_subagent(&entry, 100, Some(&ui), false);
    let row1 = text(&lines[0]);
    assert!(
        row1.contains("Explore  Explore the project"),
        "row1: {row1:?}"
    );
    assert!(row1.trim_end().ends_with("running"), "row1: {row1:?}");
    let row2 = text(&lines[1]);
    assert!(row2.starts_with("   └ Read"), "row2: {row2:?}");
    assert!(row2.contains("· 10000 tools"), "row2: {row2:?}");
    assert!(subagent_activity(Some(&ui), 100).contains("file9999"));
    let mut map = std::collections::HashMap::from([("child".into(), ui)]);
    let before = subagent_fingerprint(&map, 100);
    map.get_mut("child").unwrap().tool_rows[0].result = Some("changed old output".into());
    assert_eq!(before, subagent_fingerprint(&map, 100));
}

#[test]
fn a_swarm_member_card_reads_as_its_lane() {
    let mut board = agente_core::swarm::Board::default();
    let spec = |title: &str, deps: &[&str]| -> agente_core::swarm::CardSpec {
        serde_json::from_value(serde_json::json!({
            "title": title, "role": "Lexer mapper", "prompt": "p", "depends_on": deps
        }))
        .unwrap()
    };
    board
        .add(vec![spec("Map lexer", &[]), spec("Wire parser", &["c1"])])
        .unwrap();
    board.start("c1", "child");
    board.post("c1", "Tokens live in lexer.rs", &[]).unwrap();

    let mut entry = tool_entry("task", "Map lexer", None);
    entry.subagent_id = Some("child".into());
    let mut ui = SubagentUiState {
        status: "running".into(),
        description: "Map lexer".into(),
        swarm: crate::state::SwarmLane::of(&board, "child"),
        ..Default::default()
    };
    let text = |line: &Line<'static>| -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    };
    let lines = render_subagent(&entry, 100, Some(&ui), false);
    assert_eq!(lines.len(), 4, "header + activity + finding + gap");
    let row1 = text(&lines[0]);
    assert!(row1.contains("c1 Map lexer  Lexer mapper"), "row1: {row1:?}");
    assert!(text(&lines[1]).contains("· feeds c2"), "{:?}", text(&lines[1]));
    assert!(
        text(&lines[2]).contains("\u{270e} c1  Tokens live in lexer.rs"),
        "{:?}",
        text(&lines[2])
    );

    // A new finding re-renders the card.
    let mut map = std::collections::HashMap::from([("child".into(), ui.clone())]);
    let before = subagent_fingerprint(&map, 100);
    board.post(agente_core::swarm::LEAD, "Keep the API", &["c1".into()]).unwrap();
    ui.swarm = crate::state::SwarmLane::of(&board, "child");
    map.insert("child".into(), ui);
    assert_ne!(before, subagent_fingerprint(&map, 100));
}

#[test]
fn expanded_group_survives_opening_a_child_and_keeps_line_alignment() {
    let entries: Vec<_> = (0..3).map(|_| tool_entry("grep", "output", None)).collect();
    let expanded = HashSet::from([entries[0].id]);
    let groups = derive_tool_groups(
        &entries,
        &[],
        &|id| {
            if id == entries[1].id {
                Fold::Expanded
            } else {
                Fold::Collapsed
            }
        },
        &expanded,
    );
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].2.members.len(), 3);
    for expanded in [false, true] {
        let mut info = groups[0].2.clone();
        info.expanded = expanded;
        let block = render_group_header_block(&entries, &info, 80, false);
        assert_eq!(block.lines.len(), block.plain.len());
    }
}

#[test]
fn click_regions_keep_absolute_offsets_beyond_u16() {
    let history = vec![tool_entry("grep", "found", None)];
    let ctx = HistoryRenderCtx {
        live_tools: &std::collections::HashMap::new(),
        subagents: &std::collections::HashMap::new(),
    };
    let mut ui = UiState::default();
    let mut blocks = Vec::new();
    let mut regions = Vec::new();
    let mut height = 70_000;
    render_history_range(
        &history,
        0,
        80,
        HistoryFrame {
            ctx: &ctx,
            skipped: &[false],
            groups: &[],
        },
        &mut ui,
        HistorySink {
            blocks: &mut blocks,
            regions: &mut regions,
            height: &mut height,
        },
    );
    assert_eq!(regions[0].0.content_start, 70_000);
    assert!(regions[0].0.content_end >= 70_000);
}

/// Assistant layout: an assistant block leads with a blank row and a
/// right-aligned timestamp row, and no row carries a card background.
#[test]
fn assistant_block_is_borderless_with_timestamp() {
    use std::collections::HashMap;
    let long = "I'm doing great, thanks for asking! I'm ready to help with whatever you need - whether it's coding, planning, research, or answering questions. What can I do for you today?";
    let entry = agente_core::types::ChatEntry {
        id: uuid::Uuid::new_v4(),
        role: agente_core::types::Role::Assistant,
        content: long.to_string(),
        tool_name: None,
        tool_args: None,
        is_error: false,
        timestamp: chrono::Utc::now(),
        response_duration: Some(3300.0),
        mode: "Build".to_string(),
        interrupted: false,
        reasoning: None,
        subagent_id: None,
        subagent_type: None,
        diff_stats: None,
        attachments: Vec::new(),
    };
    let width = 60;
    let block = render_entry_block(
        &entry,
        width,
        false,
        false,
        Fold::Collapsed,
        false,
        &HashMap::new(),
        None,
        None,
    );
    assert!(block.lines.len() >= 4, "blank + timestamp + body");
    // Borderless means every row sits on the flat canvas: spans carry
    // no bg or the canvas BG (the old card bg is now aliased to BG).
    for (i, line) in block.lines.iter().enumerate() {
        for span in &line.spans {
            assert!(
                span.style.bg.is_none_or(|bg| bg == BG()),
                "row {i} still carries a card bg: {:?}",
                span.content
            );
        }
    }
    // Row 1 (after the blank) is the right-aligned timestamp row.
    let ts_text: String = block.lines[1]
        .spans
        .iter()
        .map(|s| s.content.as_ref())
        .collect();
    assert!(
        ts_text.trim().ends_with("AM") || ts_text.trim().ends_with("PM"),
        "got: {ts_text}"
    );
    let ts_used: usize = block.lines[1]
        .spans
        .iter()
        .map(|s| display_width(s.content.as_ref()))
        .sum();
    assert_eq!(ts_used, width, "timestamp row must span full width");
    // Body rows wrap within the width.
    for (i, line) in block.lines.iter().enumerate().skip(2) {
        let used: usize = line
            .spans
            .iter()
            .map(|s| display_width(s.content.as_ref()))
            .sum();
        assert!(used <= width, "body row {i} exceeds chat width, got {used}");
    }
}

/// A thought stays glued to its own text: the timestamp chrome moves
/// above the thinking header and the blank lead is dropped, so no dead
/// rows divorce the `Thought …` row from the body that follows it.
#[test]
fn thought_with_body_has_no_blank_between_them() {
    use std::collections::HashMap;
    let entry = agente_core::types::ChatEntry {
        id: uuid::Uuid::new_v4(),
        role: agente_core::types::Role::Assistant,
        content: "The tool is restricting access to paths outside the project dir".to_string(),
        tool_name: None,
        tool_args: None,
        is_error: false,
        timestamp: chrono::Utc::now(),
        response_duration: Some(9200.0),
        mode: "Build".to_string(),
        interrupted: false,
        reasoning: Some("checking the workspace layout first".to_string()),
        subagent_id: None,
        subagent_type: None,
        diff_stats: None,
        attachments: Vec::new(),
    };
    let width = 100;
    let block = render_entry_block(
        &entry,
        width,
        false,
        false,
        Fold::Collapsed,
        false,
        &HashMap::new(),
        None,
        None,
    );
    let text: Vec<String> = block
        .lines
        .iter()
        .map(|l| {
            l.spans
                .iter()
                .map(|s| s.content.as_ref())
                .collect::<String>()
        })
        .collect();
    // timestamp, thought header, one-line preview, body — no blanks.
    assert_eq!(text.len(), 4, "got: {text:?}");
    assert!(
        text[0].trim().ends_with("AM") || text[0].trim().ends_with("PM"),
        "row 0 is the timestamp: {:?}",
        text[0]
    );
    assert!(text[1].contains("Thought for"), "got: {:?}", text[1]);
    assert!(
        text[2].contains("checking the workspace layout first"),
        "row 2 is the collapsed preview: {text:?}"
    );
    assert!(
        text[3].contains("restricting access"),
        "thought must sit directly above its body: {text:?}"
    );
    assert!(
        text.iter().all(|row| !row.trim().is_empty()),
        "no blank rows between thought and body: {text:?}"
    );
}

#[test]
fn render_entry_block_is_deterministic() {
    use std::collections::HashMap;
    let entry = agente_core::types::ChatEntry {
        id: uuid::Uuid::new_v4(),
        role: agente_core::types::Role::Assistant,
        content: "**bold** and `code`\n\n- list one\n- list two".to_string(),
        tool_name: None,
        tool_args: None,
        is_error: false,
        timestamp: chrono::Utc::now(),
        response_duration: Some(1234.0),
        mode: "Build".to_string(),
        interrupted: false,
        reasoning: None,
        subagent_id: None,
        subagent_type: None,
        diff_stats: None,
        attachments: Vec::new(),
    };
    let subagents = HashMap::new();
    let a = render_entry_block(
        &entry,
        60,
        false,
        false,
        Fold::Collapsed,
        false,
        &subagents,
        None,
        None,
    );
    let b = render_entry_block(
        &entry,
        60,
        false,
        false,
        Fold::Collapsed,
        false,
        &subagents,
        None,
        None,
    );
    assert!(!a.lines.is_empty());
    // Same inputs ⇒ identical parsed output (so the cache is safe to reuse).
    assert_eq!(a.lines.len(), b.lines.len());
    let join = |block: &RenderedChatBlock| -> String {
        block
            .lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    assert_eq!(join(&a), join(&b));
    // Width affects wrapping, so a different width must differ.
    let c = render_entry_block(
        &entry,
        20,
        false,
        false,
        Fold::Collapsed,
        false,
        &subagents,
        None,
        None,
    );
    assert!(join(&c) != join(&a));
    // Plain mirror has same row count as the display lines.
    assert_eq!(a.lines.len(), a.plain.len());
}

#[test]
fn chat_cache_roundtrip_and_mismatch() {
    let mut ui = crate::state::UiState::default();
    let id = uuid::Uuid::new_v4();
    let block = RenderedChatBlock {
        width: 60,
        user_expanded: false,
        thinking_expanded: false,
        tool_fold: Fold::Collapsed,
        dense_next: false,
        lines: Vec::new(),
        plain: Vec::new(),
        regions: Vec::new(),
    };
    ui.chat_cache_put(id, block);
    // Matching inputs hit; a changed flag (fold/dense/hover/width) misses.
    assert!(ui
        .chat_cache_get(
            &id,
            crate::state::ChatCacheKey {
                width: 60,
                user_expanded: false,
                thinking_expanded: false,
                tool_fold: Fold::Collapsed,
                dense_next: false
            }
        )
        .is_some());
    assert!(ui
        .chat_cache_get(
            &id,
            crate::state::ChatCacheKey {
                width: 60,
                user_expanded: false,
                thinking_expanded: false,
                tool_fold: Fold::Expanded,
                dense_next: false
            }
        )
        .is_none());
    assert!(ui
        .chat_cache_get(
            &id,
            crate::state::ChatCacheKey {
                width: 60,
                user_expanded: false,
                thinking_expanded: false,
                tool_fold: Fold::Collapsed,
                dense_next: true
            }
        )
        .is_none());
    assert!(ui
        .chat_cache_get(
            &id,
            crate::state::ChatCacheKey {
                width: 40,
                user_expanded: false,
                thinking_expanded: false,
                tool_fold: Fold::Collapsed,
                dense_next: false
            }
        )
        .is_none());
}

#[test]
fn shell_display_strips_framing_and_keeps_output() {
    let (lines, code) = shell_display("STDOUT:\nok\nEXIT CODE: 0");
    assert_eq!(lines, vec!["ok"]);
    assert_eq!(code, Some(0));
}

#[test]
fn shell_display_surfaces_nonzero_exit_and_stderr() {
    let (lines, code) = shell_display("STDOUT:\nboom\nSTDERR:\npanic!\nEXIT CODE: 2");
    assert_eq!(lines, vec!["boom", "panic!"]);
    assert_eq!(code, Some(2));
}

#[test]
fn shell_display_passthrough_without_framing() {
    let (lines, code) = shell_display("plain output\nno framing");
    assert_eq!(lines, vec!["plain output", "no framing"]);
    assert_eq!(code, None);
}

#[test]
fn shell_display_handles_truncated_exit_code() {
    // Core truncates huge outputs; the "EXIT CODE:" tail may be cut off.
    let (lines, code) = shell_display("STDOUT:\npartial…");
    assert_eq!(lines, vec!["partial…"]);
    assert_eq!(code, None);
}

fn tool_entry(tool: &str, content: &str, args: Option<&str>) -> agente_core::types::ChatEntry {
    agente_core::types::ChatEntry {
        id: uuid::Uuid::new_v4(),
        role: agente_core::types::Role::Tool,
        content: content.to_string(),
        tool_name: Some(tool.to_string()),
        tool_args: args.map(str::to_string),
        is_error: false,
        timestamp: chrono::Utc::now(),
        response_duration: None,
        mode: "Build".to_string(),
        interrupted: false,
        reasoning: None,
        subagent_id: None,
        subagent_type: None,
        diff_stats: None,
        attachments: Vec::new(),
    }
}

fn join_first_line(lines: &[Line<'_>]) -> String {
    lines[0].spans.iter().map(|s| s.content.as_ref()).collect()
}

/// A collapsed thought header that wraps (degenerate narrow terminal)
/// keeps every visual row clickable — the region must span the wrapped
/// rows, not just the first.
#[test]
fn collapsed_thought_region_covers_wrapped_header() {
    use std::collections::HashMap;
    let entry = agente_core::types::ChatEntry {
        id: uuid::Uuid::new_v4(),
        role: agente_core::types::Role::Assistant,
        content: String::new(),
        tool_name: None,
        tool_args: None,
        is_error: false,
        timestamp: chrono::Utc::now(),
        response_duration: Some(9_200.0),
        mode: "Build".to_string(),
        interrupted: false,
        reasoning: Some("checking the workspace layout first".to_string()),
        subagent_id: None,
        subagent_type: None,
        diff_stats: None,
        attachments: Vec::new(),
    };
    // 16 cols forces the ~20-col header onto two visual rows; the
    // collapsed preview adds the third.
    let block = render_entry_block(
        &entry,
        16,
        false,
        false,
        Fold::Collapsed,
        false,
        &HashMap::new(),
        None,
        None,
    );
    assert_eq!(block.lines.len(), 3, "header must wrap: {block:?}");
    let thinking: Vec<_> = block
        .regions
        .iter()
        .filter(|(_, _, kind, _)| *kind == ClickKind::Thinking)
        .collect();
    assert_eq!(thinking.len(), 1);
    assert_eq!((thinking[0].0, thinking[0].1), (0, 3));
}

/// A shell card is headed by the command, not the tool name.
#[test]
fn shell_card_header_shows_command() {
    let entry = tool_entry(
        "shell",
        "STDOUT:\nok\nEXIT CODE: 0",
        Some(r#"{"command":"cargo build"}"#),
    );
    let lines = render_tool(
        &entry,
        60,
        Fold::Truncated,
        false,
        Some(r#"{"command":"cargo build"}"#),
    );
    let header = join_first_line(&lines);
    assert!(header.contains("$ cargo build"), "header: {header:?}");
    assert!(!header.contains("shell"), "generic name leaked: {header:?}");
}

/// Without args the card falls back to the tool name.
#[test]
fn shell_card_header_falls_back_to_tool_name() {
    let entry = tool_entry("shell", "STDOUT:\nok\nEXIT CODE: 0", None);
    let lines = render_tool(&entry, 60, Fold::Truncated, false, None);
    assert!(join_first_line(&lines).contains("shell"));
}

/// Write/edit cards carry a `+A/-B` badge in the collapsed header.
#[test]
fn edit_card_header_shows_diff_stats() {
    let mut entry = tool_entry("edit_file", "Successfully edited src/lib.rs", None);
    entry.diff_stats = Some((3, 1));
    let lines = render_tool(&entry, 60, Fold::Collapsed, false, None);
    let header = join_first_line(&lines);
    assert!(header.contains("+3"), "header: {header:?}");
    assert!(header.contains("/-1"), "header: {header:?}");
}

/// Header grammar: `<verb> <subject>` — the verb owns the action word and
/// the subject is the bare target.
/// A tool-card header is exactly one row at any width.
///
/// It used to be padded but never trimmed, so a long path plus a trailing
/// duration overflowed and the generic wrapper broke it onto a second,
/// un-indented line — `412ms` alone in column 1 (harness shot
/// `sidebar_both_80x24.txt`).
/// Selecting text must not strip styling from the rest of the transcript.
///
/// `apply_selection_style` used to rebuild every visible line using only
/// the FIRST span's style, so the moment a selection existed anywhere,
/// syntax highlighting, bold and heading colours collapsed into one colour
/// across the whole chat.
#[test]
fn selection_preserves_unselected_span_styles() {
    use ratatui::style::Color;

    let line = Line::from(vec![
        Span::styled("fn ", Style::default().fg(Color::Magenta)),
        Span::styled("main", Style::default().fg(Color::Blue)),
        Span::styled("() {", Style::default().fg(Color::Green)),
    ]);

    let mut state =
        crate::state::AppState::new(agente_core::config::AppConfig::default(), "/tmp/sel".into());
    // A selection exists, but on a different row than the one we render.
    state.ui.selection = Some(crate::state::ChatSelection {
        start_line: 99,
        start_col: 0,
        end_line: 99,
        end_col: 4,
    });

    let styled = apply_selection_style(line.clone(), 0, &state);
    let colours: Vec<Option<Color>> = styled.spans.iter().map(|s| s.style.fg).collect();

    assert!(
        colours.contains(&Some(Color::Magenta))
            && colours.contains(&Some(Color::Blue))
            && colours.contains(&Some(Color::Green)),
        "styles were flattened: {colours:?}"
    );
}

#[test]
fn tool_card_header_never_wraps_to_a_second_row() {
    let entry = agente_core::types::ChatEntry {
        response_duration: Some(412.0),
        ..tool_entry(
            "read_file",
            "1  use reqwest::Client;",
            Some(r#"{"path":"crates/agente-core/src/providers/a_very_long_module_name.rs"}"#),
        )
    };

    for width in [28usize, 40, 52, 60, 80] {
        let block = render_entry_block(
            &entry,
            width,
            false,
            false,
            Fold::Collapsed,
            false,
            &std::collections::HashMap::new(),
            None,
            None,
        );
        // The collapsed card is header-only; every produced row must fit.
        for (row, line) in block.lines.iter().enumerate() {
            let cells: usize = line
                .spans
                .iter()
                .map(|sp| crate::widgets::display_width(sp.content.as_ref()))
                .sum();
            assert!(
                cells <= width,
                "row {row} is {cells} cells wide at width {width}: {:?}",
                line.spans
                    .iter()
                    .map(|sp| sp.content.as_ref())
                    .collect::<String>()
            );
        }
    }
}

#[test]
fn tool_header_grammar_uses_verb_plus_subject() {
    let read = tool_entry("read_file", "ok", Some(r#"{"path":"src/lib.rs"}"#));
    let header = join_first_line(&render_tool(&read, 60, Fold::Collapsed, true, None));
    assert!(header.contains("Run Read src/lib.rs"), "header: {header:?}");
    assert!(!header.contains("read_file"), "raw name leaked: {header:?}");
    assert!(
        !header.contains('✓') && !header.contains('✗'),
        "no status marks: {header:?}"
    );

    let grep = tool_entry("grep", "ok", Some(r#"{"query":"retry"}"#));
    let header = join_first_line(&render_tool(&grep, 60, Fold::Collapsed, true, None));
    assert!(
        header.contains("Run Search \"retry\""),
        "header: {header:?}"
    );

    // Unknown tools show their raw name as the verb.
    let custom = tool_entry("custom_tool", "ok", None);
    let header = join_first_line(&render_tool(&custom, 60, Fold::Collapsed, true, None));
    assert!(header.contains("Run custom_tool"), "header: {header:?}");
}

/// Collapsed fold is header-only (the trailing gap row is dropped when the
/// next block is another dense tool card).
#[test]
fn collapsed_tool_card_is_header_only() {
    let entry = tool_entry("grep", "row1\nrow2\nrow3\nrow4", Some(r#"{"query":"x"}"#));
    let dense = render_tool(&entry, 60, Fold::Collapsed, true, None);
    assert_eq!(dense.len(), 1, "header only, no gap: {dense:?}");
    let lone = render_tool(&entry, 60, Fold::Collapsed, false, None);
    assert_eq!(lone.len(), 2, "header + trailing gap row");
    let body: String = dense.iter().map(|l| line_text(l)).collect();
    assert!(!body.contains("row2"), "no body rows when collapsed");
}

/// Truncated fold shows the first rows plus a `+N lines` hint.
#[test]
fn truncated_tool_card_shows_three_rows_and_hint() {
    let body: Vec<String> = (1..=10).map(|i| format!("row {i}")).collect();
    let entry = tool_entry("grep", &body.join("\n"), Some(r#"{"query":"x"}"#));
    let lines = render_tool(&entry, 60, Fold::Truncated, false, None);
    let text: Vec<String> = lines.iter().map(|l| line_text(l)).collect();
    // header + 3 preview rows + hint + trailing gap
    assert_eq!(lines.len(), 6, "rows: {text:?}");
    assert!(text[1].contains("row 1"));
    assert!(text[3].contains("row 3"));
    assert!(!text.join("\n").contains("row 4"), "preview stops at 3");
    assert!(
        text[4].contains("… +7 lines · click to expand"),
        "hint: {:?}",
        text[4]
    );

    // Short results show everything with no hint row.
    let short = tool_entry("grep", "only line", Some(r#"{"query":"x"}"#));
    let lines = render_tool(&short, 60, Fold::Truncated, true, None);
    assert_eq!(lines.len(), 2, "header + preview row, no hint, no gap");
}

/// Expanded fold keeps the head/tail window so huge results stay bounded.
#[test]
fn expanded_shell_card_keeps_head_and_tail_window() {
    let body: Vec<String> = (1..=410).map(|i| format!("line {i}")).collect();
    let content = format!("STDOUT:\n{}\nEXIT CODE: 0", body.join("\n"));
    let entry = tool_entry("shell", &content, None);
    let lines = render_tool(&entry, 80, Fold::Expanded, true, None);
    let body_text: String = lines
        .iter()
        .map(|l| line_text(l))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(body_text.contains("line 1\n"), "head window kept");
    assert!(body_text.contains("line 410"), "tail window kept");
    assert!(!body_text.contains("line 205"), "middle elided");
    assert!(
        body_text.contains("line 300"),
        "line 300 sits in the tail window"
    );
    assert!(body_text.contains("… 10 lines omitted …"), "elision marker");
    assert!(body_text.contains("▴ collapse"), "collapse affordance");

    // Small results fit entirely: no elision row.
    let small = tool_entry("shell", "STDOUT:\nok\nEXIT CODE: 0", None);
    let lines = render_tool(&small, 80, Fold::Expanded, true, None);
    let text: String = lines
        .iter()
        .map(|l| line_text(l))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!text.contains("omitted"));
    assert!(text.contains("▴ collapse"));
}

fn line_text(line: &Line<'_>) -> String {
    line.spans.iter().map(|s| s.content.as_ref()).collect()
}

/// An interrupted (cancelled) assistant turn carries a footer tag unless
/// it is already an error entry.
#[test]
fn interrupted_assistant_shows_tag() {
    let mut entry = agente_core::types::ChatEntry {
        role: agente_core::types::Role::Assistant,
        content: "partial response".to_string(),
        interrupted: true,
        ..tool_entry("unused", "unused", None)
    };
    entry.tool_name = None;
    let lines = render_assistant(&entry, 60, None);
    let text: String = lines
        .iter()
        .map(|l| line_text(l))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("⚠ interrupted"), "tag: {text:?}");

    entry.is_error = true;
    let lines = render_assistant(&entry, 60, None);
    let text: String = lines
        .iter()
        .map(|l| line_text(l))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !text.contains("⚠ interrupted"),
        "errors keep their own marker"
    );
}

/// The reply closes with a dim whole-turn summary.
#[test]
fn assistant_reply_shows_worked_for_in_whole_seconds() {
    let entry = agente_core::types::ChatEntry {
        content: "Hello! How can I help you today?".to_string(),
        ..tool_entry("unused", "unused", None)
    };
    let lines = render_assistant(&entry, 60, Some(10_000.0));
    let text: String = lines
        .iter()
        .map(|l| line_text(l))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("Worked for 10s"), "got: {text:?}");
    assert!(!text.contains("10.0s"), "whole seconds only: {text:?}");

    let lines = render_assistant(&entry, 60, None);
    let text: String = lines
        .iter()
        .map(|l| line_text(l))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !text.contains("Worked for"),
        "no duration, no row: {text:?}"
    );
}

/// The turn clock pairs the reply with the nearest preceding user message.
#[test]
fn worked_for_duration_reads_the_turn_clock() {
    let mut user = tool_entry("unused", "unused", None);
    user.role = agente_core::types::Role::User;
    user.content = "hello".to_string();
    user.tool_name = None;
    user.tool_args = None;
    user.timestamp = chrono::Utc::now() - chrono::Duration::seconds(10);

    let mut reply = tool_entry("unused", "unused", None);
    reply.role = agente_core::types::Role::Assistant;
    reply.content = "hi".to_string();
    reply.tool_name = None;
    reply.tool_args = None;

    let history = vec![user.clone(), reply.clone()];
    let worked = worked_for_duration(&history, 1).expect("turn clock");
    assert!((worked - 10_000.0).abs() < 1_500.0, "got {worked}");

    let mut err = reply.clone();
    err.is_error = true;
    let history = vec![user.clone(), err];
    assert!(worked_for_duration(&history, 1).is_none());

    let history = vec![reply];
    assert!(
        worked_for_duration(&history, 0).is_none(),
        "no preceding user message means no turn clock"
    );
}

// ── Verb groups ─────────────────────────────────────────────────────

use std::collections::HashSet;

/// Three consecutive collapsed read cards of the same family derive one
/// group keyed by the first member's id.
#[test]
fn group_derivation_needs_three_consecutive_collapsed() {
    let entries: Vec<_> = (0..3).map(|_| tool_entry("grep", "x", None)).collect();
    let all_collapsed = |_id: uuid::Uuid| Fold::Collapsed;
    let groups = derive_tool_groups(&entries, &[false; 3], &all_collapsed, &HashSet::new());
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].0, 0, "run start");
    assert_eq!(groups[0].1, 3, "run length");
    assert_eq!(groups[0].2.head_id, entries[0].id);
    assert!(!groups[0].2.expanded);

    // A pair is left alone.
    let pair: Vec<_> = (0..2).map(|_| tool_entry("grep", "x", None)).collect();
    let groups = derive_tool_groups(&pair, &[false; 2], &all_collapsed, &HashSet::new());
    assert!(groups.is_empty(), "runs of two do not compress");
}

/// Any Truncated/Expanded member, a family change, or a rendered non-tool
/// entry between members breaks the run.
#[test]
fn group_derivation_breaks_on_family_fold_and_interleaves() {
    let entries = vec![
        tool_entry("grep", "x", None),
        tool_entry("grep", "x", None),
        // Family change (shell is Run, greps are Read) splits the run.
        tool_entry("shell", "x", None),
        tool_entry("grep", "x", None),
    ];
    let all_collapsed = |_id: uuid::Uuid| Fold::Collapsed;
    let groups = derive_tool_groups(&entries, &[false; 4], &all_collapsed, &HashSet::new());
    assert!(
        groups.is_empty(),
        "family change splits every run: {groups:?}"
    );

    // One member expanded below the default kills the run.
    let entries = vec![
        tool_entry("grep", "x", None),
        tool_entry("grep", "x", None),
        tool_entry("grep", "x", None),
    ];
    let third_expanded = |id: uuid::Uuid| {
        if id == entries[2].id {
            Fold::Expanded
        } else {
            Fold::Collapsed
        }
    };
    let groups = derive_tool_groups(&entries, &[false; 3], &third_expanded, &HashSet::new());
    assert!(groups.is_empty(), "expanded member breaks the run");

    // A rendered non-tool entry between tool cards also breaks the run…
    let mut interleaved = vec![tool_entry("grep", "x", None), tool_entry("grep", "x", None)];
    interleaved.push(agente_core::types::ChatEntry {
        role: agente_core::types::Role::Assistant,
        content: "meanwhile".to_string(),
        tool_name: None,
        ..tool_entry("grep", "x", None)
    });
    interleaved.push(tool_entry("grep", "x", None));
    let groups = derive_tool_groups(&interleaved, &[false; 4], &all_collapsed, &HashSet::new());
    assert!(groups.is_empty(), "assistant prose breaks the run");

    // …but invisible pending-call stubs do not.
    let mut stubbed: Vec<agente_core::types::ChatEntry> = Vec::new();
    let mut skip = Vec::new();
    for _ in 0..3 {
        let mut call = tool_entry("grep", "x", None);
        call.role = agente_core::types::Role::Assistant;
        call.content = String::new();
        skip.push(true); // the call stub is invisible
        stubbed.push(call);
        skip.push(false);
        stubbed.push(tool_entry("grep", "x", None));
    }
    let groups = derive_tool_groups(&stubbed, &skip, &all_collapsed, &HashSet::new());
    assert_eq!(groups.len(), 1, "stubs between results keep the run");
    assert_eq!(groups[0].1, 3);
}

/// Group header aggregates per-verb counts with pluralized nouns and a
/// failure suffix, and is one ToolGroup hit target.
#[test]
fn group_header_aggregates_counts_and_failures() {
    let mut entries = vec![
        tool_entry("read_file", "1", None),
        tool_entry("read_file", "2", None),
        tool_entry("grep", "3", None),
    ];
    entries[2].is_error = true;
    let info = GroupInfo {
        family: ToolFamily::Read,
        head_id: entries[0].id,
        members: vec![0, 1, 2],
        any_error: true,
        expanded: false,
    };
    let block = render_group_header_block(&entries, &info, 60, true);
    let text = line_text(&block.lines[0]);
    assert!(text.contains("◆"), "header: {text:?}");
    assert!(text.contains("Read 2 files"), "header: {text:?}");
    assert!(text.contains("Search 1 pattern"), "header: {text:?}");
    assert!(text.contains("1 failed"), "header: {text:?}");
    assert_eq!(block.lines.len(), 1, "dense next: no trailing gap");
    assert_eq!(
        block.regions,
        vec![(0, 1, ClickKind::ToolGroup, false)],
        "one group hit target"
    );
    assert_eq!(block.plain[0].entry_id, Some(info.head_id));

    // Pluralization of the second verb and the gap row.
    let entries = vec![
        tool_entry("read_file", "1", None),
        tool_entry("grep", "2", None),
        tool_entry("grep", "3", None),
    ];
    let info = GroupInfo {
        family: ToolFamily::Read,
        head_id: entries[0].id,
        members: vec![0, 1, 2],
        any_error: false,
        expanded: false,
    };
    let block = render_group_header_block(&entries, &info, 60, false);
    let text = line_text(&block.lines[0]);
    assert!(text.contains("Read 1 file "), "singular noun: {text:?}");
    assert!(text.contains("Search 2 patterns"), "plural noun: {text:?}");
    assert!(!text.contains("failed"));
    assert_eq!(block.lines.len(), 2, "lone header keeps its trailing gap");
}

/// An expanded group renders its header plus every member as a dense
/// stack; a collapsed group renders only the header row.
#[test]
fn group_render_collapses_and_expands_members() {
    use agente_core::types::Role;
    let mut history: Vec<agente_core::types::ChatEntry> = Vec::new();
    let mut skip = Vec::new();
    for _ in 0..3 {
        let mut call = tool_entry("grep", "x", None);
        call.role = Role::Assistant;
        call.content = String::new();
        skip.push(true);
        history.push(call);
        skip.push(false);
        history.push(tool_entry("grep", "x", None));
    }
    let all_collapsed = |_id: uuid::Uuid| Fold::Collapsed;

    let collapsed_groups = derive_tool_groups(&history, &skip, &all_collapsed, &HashSet::new());
    assert_eq!(collapsed_groups.len(), 1);
    let mut ui = crate::state::UiState::default();
    let ctx = HistoryRenderCtx {
        live_tools: &std::collections::HashMap::new(),
        subagents: &std::collections::HashMap::new(),
    };
    let mut blocks = Vec::new();
    let mut regions = Vec::new();
    let mut height = 0usize;
    render_history_range(
        &history,
        0,
        80,
        HistoryFrame {
            ctx: &ctx,
            skipped: &skip,
            groups: &collapsed_groups,
        },
        &mut ui,
        HistorySink {
            blocks: &mut blocks,
            regions: &mut regions,
            height: &mut height,
        },
    );
    assert_eq!(blocks.len(), 1, "collapsed group: one header block only");
    assert!(regions
        .iter()
        .all(|(r, _, _)| r.kind == ClickKind::ToolGroup));
    let header_text: String = blocks[0].2.plain.iter().map(|p| p.plain.as_ref()).collect();
    assert!(header_text.contains("Search 3 patterns"), "{header_text}");

    // Expanded: header + three member cards, densely stacked.
    let head_id = collapsed_groups[0].2.head_id;
    let mut expanded = HashSet::new();
    expanded.insert(head_id);
    let expanded_groups = derive_tool_groups(&history, &skip, &all_collapsed, &expanded);
    let mut ui = crate::state::UiState::default();
    let mut blocks = Vec::new();
    let mut regions = Vec::new();
    let mut height = 0usize;
    render_history_range(
        &history,
        0,
        80,
        HistoryFrame {
            ctx: &ctx,
            skipped: &skip,
            groups: &expanded_groups,
        },
        &mut ui,
        HistorySink {
            blocks: &mut blocks,
            regions: &mut regions,
            height: &mut height,
        },
    );
    assert_eq!(blocks.len(), 4, "header + three member cards");
    assert_eq!(ui.chat_plain_lines.len(), height);
    assert!(blocks[1..]
        .iter()
        .all(|(_, _, b)| b.plain[0].plain.starts_with("   │")));
    let tool_regions: Vec<_> = regions
        .iter()
        .filter(|(r, _, _)| r.kind == ClickKind::Tool)
        .collect();
    assert_eq!(tool_regions.len(), 3, "each member is clickable");
    assert!(
        tool_regions
            .iter()
            .all(|(r, _, _)| r.tool_name.as_deref() == Some("grep")),
        "regions carry the member's tool name"
    );
}

#[test]
fn thinking_click_region_is_header_only_when_expanded() {
    use std::collections::HashMap;
    let entry = agente_core::types::ChatEntry {
        id: uuid::Uuid::new_v4(),
        role: agente_core::types::Role::Assistant,
        content: "Done.".to_string(),
        tool_name: None,
        tool_args: None,
        is_error: false,
        timestamp: chrono::Utc::now(),
        response_duration: Some(100.0),
        mode: "Build".to_string(),
        interrupted: false,
        reasoning: Some("line one\nline two\nline three".to_string()),
        subagent_id: None,
        subagent_type: None,
        diff_stats: None,
        attachments: Vec::new(),
    };
    let block = render_entry_block(
        &entry,
        60,
        false,
        true,
        Fold::Collapsed,
        false,
        &HashMap::new(),
        None,
        None,
    );
    let thinking_regions: Vec<_> = block
        .regions
        .iter()
        .filter(|(_, _, k, _)| *k == ClickKind::Thinking)
        .collect();
    assert_eq!(thinking_regions.len(), 1, "one thinking hit target");
    let (start, end, _, _) = thinking_regions[0];
    assert_eq!(
        end - start,
        1,
        "thinking hit target must be header-only, got span {}",
        end - start
    );
    // Expanded body is present in the block lines.
    assert!(
        block.lines.len() > 4,
        "expanded thinking should add body lines"
    );
}

#[test]
fn live_thinking_header_uses_diamond_and_sweep_not_braille() {
    let lines = render_thinking_block("", false, true, false, 0, 60, None);
    assert_eq!(lines.len(), 1, "collapsed live header is one row");
    let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
    assert!(
        text.contains("Thinking..."),
        "live header matches reference copy, got: {text}"
    );
    assert!(
        text.contains('◆'),
        "dim diamond marker expected, got: {text}"
    );
    for frame in crate::widgets::SPINNER {
        assert!(
            !text.contains(frame),
            "braille frame {frame} must not appear in the thinking header"
        );
    }
    // Collapsed live preview tracks the newest reasoning chunk; empty
    // reasoning stays a bare header.
    let with_body = render_thinking_block(
        "first thought\nGreat, ffmpeg is installed (homebrew).",
        false,
        true,
        true,
        0,
        60,
        None,
    );
    assert_eq!(with_body.len(), 2, "header + one preview line");
    let preview: String = with_body[1]
        .spans
        .iter()
        .map(|s| s.content.as_ref())
        .collect();
    assert!(
        preview.contains("ffmpeg is installed"),
        "preview shows newest chunk, got: {preview}"
    );
    assert!(
        preview.starts_with("  │ "),
        "thread rail sits under the ◆ header, got: {preview:?}"
    );
    // The rail breathes with the sweep instead of sitting static.
    let rail_a = with_body[1].spans[1].style.fg;
    let with_body_b = render_thinking_block(
        "first thought\nGreat, ffmpeg is installed (homebrew).",
        false,
        true,
        true,
        30,
        60,
        None,
    );
    let rail_b = with_body_b[1].spans[1].style.fg;
    assert_ne!(rail_a, rail_b, "rail must shimmer across frames");
    // The sweep actually moves across frames.
    let other = render_thinking_block("", false, true, false, 30, 60, None);
    let colors: Vec<_> = lines[0].spans.iter().map(|s| s.style.fg).collect();
    let other_colors: Vec<_> = other[0].spans.iter().map(|s| s.style.fg).collect();
    assert_ne!(
        colors, other_colors,
        "shimmer sweep must advance with anim_frame"
    );
}

/// Tests for the checkpoint-based streaming markdown renderer
/// (`StreamMarkdownCache` + `render_streaming`): incremental frames must
/// match a one-shot rebuild, completed blocks get real markdown styling, the
/// live tail hides unclosed markers, and rewrite/resize fallbacks stay clean.
#[cfg(test)]
mod stream_wrap_tests {
    use super::*;

    fn plain_of(lines: &[Line<'static>]) -> Vec<String> {
        lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect()
    }

    #[test]
    fn incremental_streaming_matches_full_rebuild() {
        let width = 60usize;
        let deltas = [
            "# Title line\n",
            "Intro paragraph with **bold** text long enough to wrap across\n",
            "more than one terminal row in this test corpus.
",
            "```rust\nfn a() -> u32 { 1 }\n```\n",
            "- item one\n- item two\n",
            "tail without newline",
        ];
        let mut cache = StreamMarkdownCache::default();
        let mut text = String::new();
        for delta in deltas {
            text.push_str(delta);
            let incremental = render_streaming(&text, width, Style::default(), 0, &mut cache);
            let fresh = render_streaming(
                &text,
                width,
                Style::default(),
                0,
                &mut StreamMarkdownCache::default(),
            );
            assert_eq!(
                plain_of(&incremental),
                plain_of(&fresh),
                "mismatch after pushing {delta:?}"
            );
        }
    }

    #[test]
    fn completed_blocks_render_markdown_while_streaming() {
        let width = 60usize;
        let mut cache = StreamMarkdownCache::default();
        let text = "# Heading marker\n\npara with **bold** span\n";
        let out = render_streaming(text, width, Style::default(), 0, &mut cache);
        let joined = plain_of(&out).join("\n");
        assert!(joined.contains("Heading marker"), "got: {joined}");
        assert!(
            !joined.contains("# Heading"),
            "raw heading marker must not render: {joined}"
        );
        assert!(joined.contains("bold"), "got: {joined}");
        assert!(
            !joined.contains("**"),
            "raw bold markers must not render once the block closes: {joined}"
        );
    }

    /// Compare actual live rows to the final renderer, not to another call to
    /// the streaming renderer (which used to duplicate the same cached blocks).
    #[test]
    fn every_stream_prefix_matches_final_markdown_layout() {
        let corpora = [
            "| Area | Detail |\n|---|---|\n| **Explore** | List files<br>Inspect symbols |\n| **Plan** | Review changes<br/>Accept plan |\n\n**What I *can* do** in ~/.config",
            "# Title\n\nA **bold** paragraph followed by a second line.\nNext line\n\nDone",
            "- first item\n- second item\n\n1. numbered item\n> a quote\n",
            "A URL https://example.com/very/long/path/with/many/segments",
            "文字が折り返されます and more text\n\nFinal",
            "```rust\nfn main() {\n    println!(\"hello\");\n}\n```\nAfter code",
            "```text\n| this is code | not a table |\n\nlast code line\n```\n",
            "| step | status |\n| --- | --- |\n| read | done |\n| wrap | waiting |\n\nEnd",
            "First\n\n\nSecond\n\n",
        ];
        for text in corpora {
            for width in [4, 8, 20, 40, 80] {
                let mut cache = StreamMarkdownCache::default();
                for end in text.char_indices().map(|(i, c)| i + c.len_utf8()) {
                    let prefix = &text[..end];
                    let mut actual =
                        render_streaming(prefix, width, Style::default(), 0, &mut cache);
                    let expected = crate::widgets::markdown::markdown_display_lines(prefix, width);
                    let cursor_row = actual.last_mut().expect("live cursor row");
                    assert_eq!(cursor_row.spans.last().unwrap().content, "▊");
                    cursor_row.spans.pop();
                    if actual.len() > expected.len()
                        && actual
                            .last()
                            .unwrap()
                            .spans
                            .iter()
                            .all(|s| s.content.trim().is_empty())
                    {
                        actual.pop();
                    }
                    assert_eq!(actual, expected, "width {width}, prefix {prefix:?}");
                }
            }
        }
    }

    #[test]
    fn stream_checkpoints_preserve_long_tables_and_paragraphs() {
        for text in [
            (0..100).map(|i| format!("line {i}\n")).collect::<String>(),
            format!(
                "| id | description |\n| -- | -- |\n{}",
                (0..70)
                    .map(|i| format!("| {i} | row {} |\n", "x".repeat(i)))
                    .collect::<String>()
            ),
        ] {
            let mut cache = StreamMarkdownCache::default();
            let mut prefix = String::new();
            for line in text.split_inclusive('\n') {
                prefix.push_str(line);
                let mut actual = render_streaming(&prefix, 40, Style::default(), 0, &mut cache);
                actual.pop(); // standalone cursor after the source newline
                assert_eq!(
                    actual,
                    crate::widgets::markdown::markdown_display_lines(&prefix, 40)
                );
            }
        }
    }

    #[test]
    fn open_tail_hides_unclosed_markers() {
        let width = 60usize;
        let mut cache = StreamMarkdownCache::default();
        // A paragraph still streaming: the ** is unclosed mid-word.
        let text = "Hello **wor";
        let out = render_streaming(text, width, Style::default(), 0, &mut cache);
        let joined = plain_of(&out).join("\n");
        assert!(joined.contains("Hello"), "got: {joined}");
        assert!(joined.contains("wor"), "got: {joined}");
        assert!(
            !joined.contains("**"),
            "unclosed markers must not render raw: {joined}"
        );
    }

    #[test]
    fn closed_fence_renders_code_chrome_while_streaming() {
        let width = 60usize;
        let mut cache = StreamMarkdownCache::default();
        let text = "```rust\nfn a() -> u32 { 1 }\n```\n";
        let _ = render_streaming(text, width, Style::default(), 0, &mut cache);
        let all: String = cache.plain.join("\n");
        assert!(all.contains("│"), "code block chrome expected: {all}");
        assert!(all.contains("fn a"), "code content expected: {all}");
    }

    #[test]
    fn rewrite_falls_back_and_rebuilds() {
        let width = 60usize;
        let mut cache = StreamMarkdownCache::default();
        let long = "word ".repeat(40);
        let _ = render_streaming(&long, width, Style::default(), 0, &mut cache);
        // A retry/rewrite breaks the append-only prefix; the guard must
        // invalidate and produce identical output to a fresh rebuild.
        let rewritten = "# Brand new text";
        let incremental = render_streaming(rewritten, width, Style::default(), 0, &mut cache);
        let fresh = render_streaming(
            rewritten,
            width,
            Style::default(),
            0,
            &mut StreamMarkdownCache::default(),
        );
        assert_eq!(plain_of(&incremental), plain_of(&fresh));
    }

    #[test]
    fn width_change_rebuilds_cleanly() {
        let style = Style::default();
        let mut cache = StreamMarkdownCache::default();
        let text = "# heading\n\nsome paragraph lines here\n";
        let _ = render_streaming(text, 40, style, 0, &mut cache);
        let incremental = render_streaming(text, 30, style, 0, &mut cache);
        let fresh = render_streaming(text, 30, style, 0, &mut StreamMarkdownCache::default());
        assert_eq!(plain_of(&incremental), plain_of(&fresh));
    }
}
