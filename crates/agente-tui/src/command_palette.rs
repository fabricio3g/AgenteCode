//! Shared command catalog and command-palette rendering.
//!
//! Ctrl+P modal: opaque borderless floating panel over a dimmed backdrop,
//! with a shared header rule and footer hint row. Rows are text-only
//! (no icons): label, slash, optional shortcut.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::{AppState, ListId};
use crate::style::{self, *};
use crate::widgets::pick::{pick_list, row_label, search_field, PickItem};
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
    NewTab,
    CloseTab,
    NextTab,
    PrevTab,
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
    SubagentModels,
    Swarm,
    Board,
    Settings,
    Skills,
    Mcp,
    Doctor,
    ViewPlan,
    ViewChanges,
    Quit,
}

impl Command {
    /// Every command, grouped (see [`Command::group`]) so the unfiltered
    /// palette reads as sections rather than one wall of rows.
    pub fn all() -> Vec<Self> {
        vec![
            Self::NewSession,
            Self::OpenSession,
            Self::OpenProject,
            Self::ClearConversation,
            Self::CompactContext,
            Self::ExportChat,
            Self::Undo,
            Self::Redo,
            Self::StopRun,
            Self::InitProject,
            Self::Swarm,
            Self::ConnectProvider,
            Self::SwitchModel,
            Self::RefreshModels,
            Self::CycleThinking,
            Self::ToggleMode,
            Self::ToggleAutoApprove,
            Self::SubagentModels,
            Self::NewTab,
            Self::CloseTab,
            Self::NextTab,
            Self::PrevTab,
            Self::ViewTodos,
            Self::ViewPlan,
            Self::ViewChanges,
            Self::ListSubagents,
            Self::Board,
            Self::OpenEditor,
            Self::ToggleTheme,
            Self::ShowHelp,
            Self::ShowHotkeys,
            Self::Settings,
            Self::Skills,
            Self::Mcp,
            Self::Doctor,
            Self::Quit,
        ]
    }

    /// The section this command is listed under in the unfiltered palette.
    pub fn group(self) -> &'static str {
        match self {
            Self::NewSession
            | Self::OpenSession
            | Self::OpenProject
            | Self::ClearConversation
            | Self::CompactContext
            | Self::ExportChat
            | Self::Undo
            | Self::Redo
            | Self::StopRun
            | Self::InitProject
            | Self::Swarm => "Session",
            Self::ConnectProvider
            | Self::SwitchModel
            | Self::RefreshModels
            | Self::CycleThinking
            | Self::ToggleMode
            | Self::ToggleAutoApprove
            | Self::SubagentModels => "Model",
            Self::NewTab | Self::CloseTab | Self::NextTab | Self::PrevTab => "Tabs",
            Self::ViewTodos
            | Self::ViewPlan
            | Self::ViewChanges
            | Self::ListSubagents
            | Self::Board
            | Self::OpenEditor
            | Self::ToggleTheme => "View",
            Self::ShowHelp
            | Self::ShowHotkeys
            | Self::Settings
            | Self::Skills
            | Self::Mcp
            | Self::Doctor
            | Self::Quit => "System",
        }
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
            Self::NewTab => "New Tab",
            Self::CloseTab => "Close Tab",
            Self::NextTab => "Next Tab",
            Self::PrevTab => "Previous Tab",
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
            Self::SubagentModels => "Subagent Models",
            Self::Swarm => "Toggle Swarm",
            Self::Board => "View Board",
            Self::Settings => "Settings",
            Self::Skills => "Skills",
            Self::Mcp => "MCP Servers",
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
            Self::NewTab => "/tab",
            Self::CloseTab => "/close-tab",
            Self::NextTab => "/next-tab",
            Self::PrevTab => "/prev-tab",
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
            Self::SubagentModels => "/subagent-models",
            Self::Swarm => "/swarm",
            Self::Board => "/board",
            Self::Settings => "/settings",
            Self::Skills => "/skills",
            Self::Mcp => "/mcp",
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
            Self::NewTab => "Open another session in a new tab; the others keep running",
            Self::CloseTab => "Save and close this tab",
            Self::NextTab => "Switch to the next tab",
            Self::PrevTab => "Switch to the previous tab",
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
            Self::SubagentModels => "The models the agent can give the subagents it creates",
            Self::Swarm => "Let the agent plan big work as a board its subagents work",
            Self::Board => "The swarm board: cards by backlog, working, review, done",
            Self::Settings => "Smart compaction, motion, approvals, theme",
            Self::Skills => "Installed agent skills — pick one to run it",
            Self::Mcp => "Tool servers — status, approve, reconnect",
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
            Self::NewTab => "F2",
            Self::NextTab => "Ctrl+PgDn",
            Self::PrevTab => "Ctrl+PgUp",
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
        search_field(
            frame,
            search_area,
            &state.input.command_palette_query,
            "Type to filter…",
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
            state,
            ListId::CommandPalette,
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
            let items = entries
                .iter()
                .enumerate()
                .map(|(index, snap)| subagent_item(snap, index == selected, list_area.width))
                .collect();
            pick_list(
                frame,
                list_area,
                &state.ui.hits,
                ListId::Subagents,
                items,
                selected,
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

fn subagent_item(
    snap: &agente_core::subagent::SubagentSnapshot,
    selected: bool,
    width: u16,
) -> PickItem {
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
    let fixed = 4 + snap.subagent_type.len() + 3;
    let desc_budget = (width as usize)
        .saturating_sub(fixed + crate::widgets::display_width(&meta) + 3)
        .max(4);
    PickItem::row_with_trail(
        vec![
            Span::styled(kind.glyph(), Style::default().fg(kind.color())),
            Span::raw(" "),
            Span::styled(
                format!("[{}] ", snap.subagent_type),
                Style::default().fg(SECONDARY()),
            ),
            Span::styled(
                crate::widgets::truncate_cells(&snap.description, desc_budget),
                row_label(selected),
            ),
        ],
        vec![Span::styled(meta, style::dim())],
    )
}

/// Palette / slash-picker list of commands. `selected` is clamped here.
pub fn render_command_list(
    frame: &mut Frame,
    area: Rect,
    state: &AppState,
    list: ListId,
    commands: &[Command],
    selected: usize,
) {
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
    // Section headers only on the full list: a filtered list is ranked by
    // match, and headers there would split the best hits apart.
    let grouped = commands.len() == Command::all().len();
    let mut items = Vec::with_capacity(commands.len() + 5);
    let mut current = "";
    for (index, command) in commands.iter().enumerate() {
        if grouped && command.group() != current {
            current = command.group();
            items.push(PickItem::Header(current.into()));
        }
        items.push(command_item(*command, index == selected));
    }
    pick_list(frame, area, &state.ui.hits, list, items, selected);
}

/// `› Label  /slash ······ shortcut`
fn command_item(command: Command, selected: bool) -> PickItem {
    PickItem::row_with_trail(
        vec![
            Span::styled(command.label(), row_label(selected)),
            Span::styled(format!("  {}", command.slash()), style::dim()),
        ],
        vec![Span::styled(command.shortcut(), style::muted())],
    )
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
        assert!(slashes.len() <= 5, "filter is still too loose: {slashes:?}");
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
