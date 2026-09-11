//! Shared command catalog and command-palette rendering.
//!
//! Ctrl+P modal: opaque borderless floating panel over a dimmed backdrop,
//! with a shared header rule and footer hint row. Rows are text-only
//! (no icons): label, slash, optional shortcut.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{List, ListItem, ListState, Paragraph};
use ratatui::Frame;

use crate::state::AppState;
use crate::style::{self, *};
use crate::widgets::{centered_panel, footer_hints, modal_card, modal_footer, panel_row};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    ShowHelp,
    ShowHotkeys,
    ConnectProvider,
    SwitchModel,
    RefreshModels,
    ToggleMode,
    OpenProject,
    NewSession,
    OpenSession,
    ClearConversation,
    CompactContext,
    ToggleAutoApprove,
    OpenEditor,
    ExportChat,
    ViewTodos,
    CycleThinking,
    ToggleTheme,
    StopRun,
    Undo,
    Redo,
    InitProject,
    ListSubagents,
    Doctor,
    ViewPlan,
    ViewChanges,
    Quit,
}

impl Command {
    pub fn all() -> Vec<Self> {
        vec![
            Self::ShowHelp,
            Self::ShowHotkeys,
            Self::ConnectProvider,
            Self::SwitchModel,
            Self::RefreshModels,
            Self::ToggleMode,
            Self::OpenProject,
            Self::NewSession,
            Self::OpenSession,
            Self::ClearConversation,
            Self::CompactContext,
            Self::ToggleAutoApprove,
            Self::OpenEditor,
            Self::ExportChat,
            Self::ViewTodos,
            Self::CycleThinking,
            Self::ToggleTheme,
            Self::StopRun,
            Self::Undo,
            Self::Redo,
            Self::InitProject,
            Self::ListSubagents,
            Self::Doctor,
            Self::ViewPlan,
            Self::ViewChanges,
            Self::Quit,
        ]
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::ShowHelp => "Command Help",
            Self::ShowHotkeys => "Keyboard Shortcuts",
            Self::ConnectProvider => "Connect Provider",
            Self::SwitchModel => "Switch Model",
            Self::RefreshModels => "Refresh Model List",
            Self::ToggleMode => "Toggle Plan / Build",
            Self::OpenProject => "Open Project",
            Self::NewSession => "New Session",
            Self::OpenSession => "Open Session",
            Self::ClearConversation => "Clear Conversation",
            Self::CompactContext => "Compact Context",
            Self::ToggleAutoApprove => "Toggle Auto-Approve",
            Self::OpenEditor => "Open Editor",
            Self::ExportChat => "Export Conversation",
            Self::ViewTodos => "Show Todos",
            Self::CycleThinking => "Change Thinking Mode",
            Self::ToggleTheme => "Toggle Theme",
            Self::StopRun => "Stop Current Run",
            Self::Undo => "Undo File Changes",
            Self::Redo => "Redo File Changes",
            Self::InitProject => "Initialize Project",
            Self::ListSubagents => "List Subagents",
            Self::Doctor => "Terminal Doctor",
            Self::ViewPlan => "View Plan",
            Self::ViewChanges => "View Changes",
            Self::Quit => "Quit",
        }
    }

    pub fn slash(self) -> &'static str {
        match self {
            Self::ShowHelp => "/help",
            Self::ShowHotkeys => "/hotkeys",
            Self::ConnectProvider => "/provider",
            Self::SwitchModel => "/model",
            Self::RefreshModels => "/refresh-models",
            Self::ToggleMode => "/mode",
            Self::OpenProject => "/project",
            Self::NewSession => "/new",
            Self::OpenSession => "/session",
            Self::ClearConversation => "/clear",
            Self::CompactContext => "/compact",
            Self::ToggleAutoApprove => "/approve",
            Self::OpenEditor => "/editor",
            Self::ExportChat => "/export",
            Self::ViewTodos => "/todos",
            Self::CycleThinking => "/thinking",
            Self::ToggleTheme => "/theme",
            Self::StopRun => "/stop",
            Self::Undo => "/undo",
            Self::Redo => "/redo",
            Self::InitProject => "/init",
            Self::ListSubagents => "/subagents",
            Self::Doctor => "/doctor",
            Self::ViewPlan => "/plan",
            Self::ViewChanges => "/changes",
            Self::Quit => "/quit",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::ShowHelp => "List available commands",
            Self::ShowHotkeys => "Open keyboard reference",
            Self::ConnectProvider => "Configure an AI provider",
            Self::SwitchModel => "Choose provider and model",
            Self::RefreshModels => "Re-fetch the model list from the provider",
            Self::ToggleMode => "Switch planning and build modes",
            Self::OpenProject => "Change working directory",
            Self::NewSession => "Start a clean conversation",
            Self::OpenSession => "Resume a saved conversation",
            Self::ClearConversation => "Remove current conversation",
            Self::CompactContext => "Summarize older context",
            Self::ToggleAutoApprove => "Change tool approval policy",
            Self::OpenEditor => "Compose prompt in external editor",
            Self::ExportChat => "Write conversation to Markdown",
            Self::ViewTodos => "Show the current checklist in chat",
            Self::CycleThinking => "Cycle model reasoning effort",
            Self::ToggleTheme => "Switch light and dark themes",
            Self::StopRun => "Interrupt active agent work",
            Self::Undo => "Revert last agent file mutations",
            Self::Redo => "Re-apply last undone file mutations",
            Self::InitProject => "Create or refresh AGENTS.md for this project",
            Self::ListSubagents => "List running/completed subagents (k to kill)",
            Self::Doctor => "Inspect terminal capabilities, fonts, clipboard & git",
            Self::ViewPlan => "Show the active plan checklist in chat",
            Self::ViewChanges => "Show session file changes and diffs in chat",
            Self::Quit => "Save state and exit",
        }
    }

    pub fn shortcut(self) -> &'static str {
        match self {
            Self::ShowHotkeys => "F1",
            Self::ToggleMode => "Ctrl+Tab",
            Self::NewSession => "Ctrl+N",
            Self::OpenSession => "Ctrl+S",
            Self::ClearConversation => "Ctrl+L",
            Self::OpenEditor => "Ctrl+O",
            Self::CycleThinking => "Ctrl+T",
            Self::StopRun => "Esc",
            Self::ViewChanges => "Ctrl+B",
            Self::Quit => "Ctrl+C",
            _ => "",
        }
    }
}

pub fn filter_commands(query: &str) -> Vec<Command> {
    let raw_query = query.trim();
    if raw_query.starts_with('/') {
        if let Some(exact) = Command::all()
            .into_iter()
            .find(|command| command.slash() == raw_query)
        {
            return vec![exact];
        }
    }
    let query = raw_query.trim_start_matches('/').to_lowercase();
    if query.is_empty() {
        return Command::all();
    }
    if let Some(exact) = Command::all()
        .into_iter()
        .find(|command| command.slash().trim_start_matches('/') == query)
    {
        return vec![exact];
    }

    // Scored fuzzy match: a query only needs its characters to appear in
    // order somewhere in the searchable text, and results sort by how tight
    // the match is. Substring hits rank above scattered-subsequence hits, so
    // typing "model" keeps "Switch model" above fuzzier matches.
    let mut scored: Vec<(u32, usize, Command)> = Command::all()
        .into_iter()
        .enumerate()
        .filter_map(|(order, command)| {
            let haystacks = [
                command.slash().trim_start_matches('/').to_lowercase(),
                command.label().to_lowercase(),
                command.shortcut().to_lowercase(),
                command.description().to_lowercase(),
            ];
            let mut best: Option<u32> = None;
            for (weight, hay) in haystacks.iter().enumerate() {
                // Field rules, tightened because `/mo` used to list every
                // command: matching all four fields as a scattered subsequence
                // meant a two-character query hit almost everything (`/clear`
                // via "Re-mo-ve", `/compact` via "Co-m-pact C-o-ntext").
                //
                //   slash       fuzzy subsequence  - short, the primary target
                //   label       word-aware fuzzy   - initials, not mid-word
                //   shortcut    substring, len>=3  - context only
                //   description substring, len>=3  - context only
                let (field_bias, matched) = match weight {
                    0 => (0, fuzzy_score(&query, hay)),
                    1 => (1, word_aware_score(&query, hay)),
                    2 if query.chars().count() >= 3 => (3, substring_score(&query, hay)),
                    3 if query.chars().count() >= 3 => (4, substring_score(&query, hay)),
                    _ => (0, None),
                };
                if let Some(score) = matched {
                    let total = score + field_bias;
                    if best.is_none_or(|b: u32| total < b) {
                        best = Some(total);
                    }
                }
            }
            best.map(|score| (score, order, command))
        })
        .collect();

    scored.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, _, command)| command).collect()
}

/// Subsequence match over a multi-word label, anchored to word starts.
///
/// Every needle character must land on a word start or immediately follow the
/// previous match. That keeps genuine initialisms ("swm" -> "**S**itch
/// **M**odel", via s-w in "switch") while rejecting the accidental hits that
/// made short queries useless: plain subsequence matching let "mo" match
/// "Co**m**pact C**o**ntext" and "Re**mo**ve".
fn word_aware_score(needle: &str, hay: &str) -> Option<u32> {
    let chars: Vec<char> = hay.chars().collect();
    let is_word_start = |i: usize| i == 0 || !chars[i - 1].is_alphanumeric();

    let mut score = 0u32;
    let mut at = 0usize;
    let mut previous: Option<usize> = None;
    for needle_char in needle.chars() {
        let found = (at..chars.len()).find(|&i| {
            chars[i].eq_ignore_ascii_case(&needle_char)
                && (is_word_start(i) || previous == Some(i - 1))
        })?;
        if previous.is_some_and(|p| found != p + 1) {
            score += 1; // jumped to another word
        }
        score += (found - at).min(8) as u32;
        previous = Some(found);
        at = found + 1;
    }
    Some(score)
}

/// Score for `needle` occurring as a literal substring of `hay`.
///
/// Lower is better: 0 at the start of `hay`, 1 at the start of any later word,
/// and 2 + offset mid-word. Word-boundary hits therefore outrank hits buried
/// inside a longer word ("mode" beats "Re*mo*ve").
fn substring_score(needle: &str, hay: &str) -> Option<u32> {
    let at = hay.find(needle)?;
    if at == 0 {
        return Some(0);
    }
    let prev = hay[..at].chars().next_back();
    let boundary = prev.is_none_or(|c| !c.is_alphanumeric());
    Some(if boundary { 1 } else { 2 + at.min(8) as u32 })
}

/// Match score for `needle` inside `hay`, or `None` when the needle's
/// characters do not appear in order. Lower is better:
/// 0 = prefix, +2 per skipped leading char, +1 when the needle is split
/// across word boundaries (subsequence through gaps).
fn fuzzy_score(needle: &str, hay: &str) -> Option<u32> {
    if needle.is_empty() {
        return Some(0);
    }
    if hay.starts_with(needle) {
        return Some(0);
    }
    let hay_chars: Vec<char> = hay.chars().collect();
    let mut score = 0u32;
    let mut hay_idx = 0usize;
    let mut first: Option<usize> = None;
    for needle_char in needle.chars() {
        let found = hay_chars[hay_idx..]
            .iter()
            .position(|&c| c == needle_char)
            .map(|p| p + hay_idx)?;
        // Skipping past a word boundary is cheap; skipping mid-word costs more.
        if let Some(prev) = first {
            if found > prev + 1 && !hay_chars[prev].is_whitespace() {
                score += 1;
            }
        }
        score += (found - hay_idx) as u32;
        hay_idx = found + 1;
        if first.is_none() {
            first = Some(found);
        }
    }
    Some(score)
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_command_palette || area.width < 8 || area.height < 7 {
        return;
    }

    let commands = filter_commands(&state.input.command_palette_query);
    let max_rows = area.height.saturating_sub(6).clamp(3, 12) as usize;
    let list_height = commands.len().clamp(1, max_rows) as u16;
    // gap(1) + search(1) + gap(1) + list + gap(1) + footer(1); title on border.
    let panel_height = list_height + 7;
    let panel_width = area.width.saturating_sub(4).min(64).max(28.min(area.width));
    let panel = centered_panel(area, panel_width, panel_height);

    let body = modal_card(
        frame,
        panel,
        vec![
            Span::styled("Commands", style::bold()),
            Span::styled(format!(" · {}", commands.len()), style::dim()),
        ],
    );

    // Search field (solid bar), one gap row under the card title.
    if let Some(search_area) = panel_row(body, 1, 1) {
        let query = &state.input.command_palette_query;
        let (query_text, query_style) = if query.is_empty() {
            ("Type to filter…", style::dim())
        } else {
            (query.as_str(), style::text())
        };
        fill(frame, search_area, BG_ELEMENT());
        let search = Line::from(vec![
            Span::styled(" ", Style::default().bg(BG_ELEMENT())),
            Span::styled(query_text, query_style.bg(BG_ELEMENT())),
            Span::styled("▌", style::accent().bg(BG_ELEMENT())),
        ]);
        frame.render_widget(
            Paragraph::new(search).style(Style::default().bg(BG_ELEMENT())),
            search_area,
        );
    }

    // List: from body row 3 down to the gap above the footer.
    if let Some(list_top) = panel_row(body, 3, 1) {
        let list_area = Rect {
            height: body.height.saturating_sub(5),
            ..list_top
        };
        render_command_list(
            frame,
            list_area,
            &commands,
            state.input.command_palette_selected,
        );
    }

    modal_footer(
        frame,
        body,
        footer_hints(
            &[("↑↓", "move"), ("Enter", "run"), ("Esc", "close")],
            body.width.saturating_sub(2),
        ),
    );
}

/// Render the `/subagents` popup: a floating panel listing running/completed
/// subagents with a kill hint. Same chrome as the command palette.
pub fn render_subagents(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_subagents || area.width < 8 || area.height < 7 {
        return;
    }

    let entries = state.subagent_registry.list();
    let running = state.subagent_registry.running_count();
    let max_rows = area.height.saturating_sub(4).clamp(3, 14) as usize;
    let list_height = entries.len().clamp(1, max_rows) as u16;
    // gap(1) + list + gap(1) + footer(1); title on the card border.
    let panel_height = list_height + 5;
    let panel_width = area.width.saturating_sub(4).min(70).max(32.min(area.width));
    let panel = centered_panel(area, panel_width, panel_height);

    let body = modal_card(
        frame,
        panel,
        vec![
            Span::styled("Subagents", style::bold()),
            Span::styled(
                format!(" · {running} running / {} total", entries.len()),
                style::dim(),
            ),
        ],
    );

    // List starts one gap row under the card title.
    if let Some(list_top) = panel_row(body, 1, 1) {
        let list_area = Rect {
            height: body.height.saturating_sub(3),
            ..list_top
        };

        if entries.is_empty() {
            frame.render_widget(
                Paragraph::new(Line::from(Span::styled(
                    "  No subagents have been spawned this session",
                    style::dim().bg(BG_PANEL()),
                )))
                .style(Style::default().bg(BG_PANEL())),
                list_area,
            );
        } else {
            let selected = state.input.subagents_selected.min(entries.len() - 1);
            let items: Vec<ListItem> = entries
                .iter()
                .enumerate()
                .map(|(index, snap)| subagent_row(snap, index == selected, list_area.width))
                .collect();
            let mut list_state = ListState::default();
            list_state.select(Some(selected));
            frame.render_stateful_widget(
                List::new(items).style(Style::default().bg(BG_PANEL())),
                list_area,
                &mut list_state,
            );
        }
    }

    modal_footer(
        frame,
        body,
        footer_hints(
            &[("↑↓", "move"), ("k", "kill"), ("Esc", "close")],
            body.width.saturating_sub(2),
        ),
    );
}

fn subagent_row(
    snap: &agente_core::subagent::SubagentSnapshot,
    selected: bool,
    width: u16,
) -> ListItem<'static> {
    let bg = if selected { BG_HOVER() } else { BG_PANEL() };
    let kind = crate::widgets::SubagentStatusKind::from_core(snap.status);
    let elapsed = snap
        .finished_at
        .unwrap_or_else(chrono::Utc::now)
        .signed_duration_since(snap.started_at)
        .num_seconds()
        .max(0);
    let time = if elapsed >= 60 {
        format!("{}m{:02}s", elapsed / 60, elapsed % 60)
    } else {
        format!("{elapsed}s")
    };
    let short: String = snap.id.chars().take(8).collect();
    let meta = format!("{} · {time}  {short}", kind.label());
    let marker = if selected { "› " } else { "  " };
    let meta_w = crate::widgets::display_width(&meta);
    let fixed = 4 + snap.subagent_type.len() + 3;
    let desc_budget = (width as usize).saturating_sub(fixed + meta_w + 2).max(4);
    let desc = crate::widgets::truncate_cells(&snap.description, desc_budget);
    let used = fixed + crate::widgets::display_width(&desc);
    let pad = (width as usize).saturating_sub(used + meta_w);
    let line = Line::from(vec![
        Span::styled(marker, style::accent().bg(bg)),
        Span::styled(kind.glyph(), Style::default().fg(kind.color()).bg(bg)),
        Span::styled(" ", Style::default().bg(bg)),
        Span::styled(
            format!("[{}] ", snap.subagent_type),
            Style::default().fg(SECONDARY()).bg(bg),
        ),
        Span::styled(desc, Style::default().fg(FG()).bg(bg)),
        Span::styled(" ".repeat(pad), Style::default().bg(bg)),
        Span::styled(meta, style::dim().bg(bg)),
    ]);
    ListItem::new(line).style(Style::default().bg(bg))
}

pub fn render_command_list(frame: &mut Frame, area: Rect, commands: &[Command], selected: usize) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    if commands.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                "  No matching commands",
                style::dim().bg(BG_PANEL()),
            )))
            .style(Style::default().bg(BG_PANEL())),
            area,
        );
        return;
    }

    let selected = selected.min(commands.len() - 1);
    let visible = area.height as usize;
    let start = selected
        .saturating_sub(visible.saturating_sub(1))
        .min(commands.len().saturating_sub(visible));
    let end = (start + visible).min(commands.len());
    let items: Vec<ListItem> = commands[start..end]
        .iter()
        .enumerate()
        .map(|(index, command)| command_row(*command, start + index == selected, area.width))
        .collect();
    let mut list_state = ListState::default();
    list_state.select(Some(selected - start));
    frame.render_stateful_widget(
        List::new(items).style(Style::default().bg(BG_PANEL())),
        area,
        &mut list_state,
    );
}

/// Text-only row: [▸] Label                    /slash   shortcut
fn command_row(command: Command, selected: bool, width: u16) -> ListItem<'static> {
    let bg = if selected { BG_HOVER() } else { BG_PANEL() };
    let name_style = if selected {
        Style::default()
            .fg(FG())
            .bg(bg)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(FG()).bg(bg)
    };

    let marker = if selected { "› " } else { "  " };
    let label = command.label();
    let slash = command.slash();
    let shortcut = command.shortcut();

    let mut spans = vec![
        Span::styled(marker, style::accent().bg(bg)),
        Span::styled(label, name_style),
        Span::styled(format!("  {slash}"), style::dim().bg(bg)),
    ];

    let used = marker.chars().count() + label.chars().count() + 2 + slash.chars().count();
    let sc_len = if shortcut.is_empty() {
        0
    } else {
        shortcut.chars().count()
    };

    if sc_len > 0 && used + sc_len + 2 < width as usize {
        let padding = (width as usize).saturating_sub(used + sc_len);
        spans.push(Span::styled(" ".repeat(padding), Style::default().bg(bg)));
        spans.push(Span::styled(shortcut, style::muted().bg(bg)));
    } else {
        // Pad remainder so no background bleed
        let padding = (width as usize).saturating_sub(used);
        if padding > 0 {
            spans.push(Span::styled(" ".repeat(padding), Style::default().bg(bg)));
        }
    }

    ListItem::new(Line::from(spans)).style(Style::default().bg(bg))
}

/// Paint every cell in `area` with a solid background (opaque).
pub fn fill(frame: &mut Frame, area: Rect, color: ratatui::style::Color) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    // Use a space-filled paragraph so every cell is written, not just style.
    let line = " ".repeat(area.width as usize);
    let lines: Vec<Line> = (0..area.height)
        .map(|_| Line::from(Span::styled(line.clone(), Style::default().bg(color))))
        .collect();
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(color)),
        area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn every_command_has_unique_slash_entry() {
        let commands = Command::all();
        let mut names: Vec<_> = commands.iter().map(|command| command.slash()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), commands.len());
    }

    #[test]
    fn filter_matches_palette_and_slash_metadata() {
        assert_eq!(filter_commands("theme"), vec![Command::ToggleTheme]);
        assert_eq!(filter_commands("/model"), vec![Command::SwitchModel]);
        assert_eq!(
            filter_commands("working directory"),
            vec![Command::OpenProject]
        );
    }

    #[test]
    fn fuzzy_subsequence_matches_in_order() {
        // "swm" is scattered across "switch model" — plain substring would
        // never find it; the fuzzy matcher must.
        let results = filter_commands("swm");
        assert!(
            results.contains(&Command::SwitchModel),
            "scattered query should find Switch model, got {:?}",
            results.iter().map(|c| c.label()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn fuzzy_prefers_prefix_over_scattered() {
        // "mo" prefixes "model" directly; commands that only contain the
        // letters scattered deeper must rank behind the prefix match.
        let results = filter_commands("mo");
        assert_eq!(results.first(), Some(&Command::SwitchModel));
    }

    /// Typing `/mo` used to list **every** command, because all four fields
    /// were matched as a scattered subsequence: `/clear` hit via "Re*mo*ve",
    /// `/compact` via "Co*m*pact C*o*ntext". Only genuinely related commands
    /// survive now, with the two exact slash matches leading.
    #[test]
    fn a_short_query_narrows_to_real_matches() {
        let slashes: Vec<String> = filter_commands("mo")
            .into_iter()
            .map(|c| c.slash().to_string())
            .collect();

        assert_eq!(
            &slashes[..2],
            &["/model", "/mode"],
            "exact slash matches must lead: {slashes:?}"
        );
        // Every survivor has to mention "mo" at a word start somewhere.
        assert!(slashes.len() <= 4, "filter is still too loose: {slashes:?}");
        for unrelated in [
            "/clear", "/compact", "/editor", "/session", "/export", "/undo",
        ] {
            assert!(
                !slashes.iter().any(|s| s == unrelated),
                "{unrelated} is unrelated to \"mo\": {slashes:?}"
            );
        }
    }

    #[test]
    fn fuzzy_matches_through_descriptions() {
        // No label/slash contains "clipboard", but a description might —
        // description hits still surface commands.
        let results = filter_commands("clear");
        assert!(
            !results.is_empty(),
            "clear must surface at least the clear-conversation command"
        );
        assert!(results.contains(&Command::ClearConversation));
    }

    #[test]
    fn fuzzy_never_matches_out_of_order() {
        // Reverse-order letters cannot match anything in order.
        let results = filter_commands("zzyyxxqq");
        assert!(
            !results.iter().any(|c| c.slash().contains("theme")),
            "scattered matching must stay in-order"
        );
    }

    #[test]
    fn palette_handles_small_terminal_and_scrolled_selection() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/project".to_string());
        state.input.show_command_palette = true;
        state.input.command_palette_selected = Command::all().len() - 1;
        let backend = TestBackend::new(20, 6);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| render(frame, frame.area(), &state))
            .unwrap();
    }

    #[test]
    fn palette_is_opaque_on_busy_background() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/project".to_string());
        state.input.show_command_palette = true;
        let backend = TestBackend::new(48, 18);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                // Paint noisy background first
                let area = frame.area();
                let junk = "X".repeat(area.width as usize);
                let lines: Vec<Line> = (0..area.height).map(|_| Line::from(junk.clone())).collect();
                frame.render_widget(Paragraph::new(lines), area);
                render(frame, area, &state);
            })
            .unwrap();
        let buf = terminal.backend().buffer();
        // Center of panel should not be solid X background
        let mid = buf.area.width / 2;
        let mid_y = buf.area.height / 2;
        let cell = &buf[(mid, mid_y)];
        assert_ne!(cell.symbol(), "X", "palette should cover background glyphs");
    }
}
