//! Layout and paint orchestration for the TUI.

use std::io;

use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout};
use ratatui::Terminal;

use crate::at_file_picker;
use crate::command_palette;
use crate::connect;
use crate::model_selector;
use crate::session_picker;
use crate::slash_command;
use crate::state::AppState;
use crate::widgets;

/// Render with crash logging: if rendering panics, write a crash log
/// with terminal dimensions and state before re-panicking.
pub(super) fn render_app_safe(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    state: &mut AppState,
) {
    let size = terminal.size().unwrap_or_default();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        terminal.draw(|frame| render_app(frame, state)).ok();
    }));
    if let Err(panic_info) = result {
        write_render_crash_log(size.width, size.height, state);
        std::panic::resume_unwind(panic_info);
    }
}

fn write_render_crash_log(width: u16, height: u16, state: &AppState) {
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("agente_render_crash_{timestamp}.log");
    let path = dirs::home_dir()
        .map(|h| h.join(".agente").join("crashes"))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let _ = std::fs::create_dir_all(&path);
    let filepath = path.join(&filename);

    let mut content = String::new();
    content.push_str(&format!("Render crash log: {timestamp}\n"));
    content.push_str(&format!("Terminal size: {width}x{height}\n"));
    content.push_str(&format!("Agent state: {:?}\n", state.agent.state));
    content.push_str(&format!(
        "Provider: {}  Model: {}\n",
        state.config.current_provider, state.config.current_model
    ));
    content.push_str(&format!(
        "Chat entries: {}  Conversation messages: {}\n",
        state.session.chat_history.len(),
        state.session.conversation.len()
    ));
    content.push_str(&format!(
        "Streaming text length: {}  Reasoning text length: {}\n",
        state.agent.streaming_text.len(),
        state.agent.reasoning_text.len()
    ));
    content.push_str("---\n");

    let _ = std::fs::write(&filepath, content);
    tracing::error!("Render crash log written to: {:?}", filepath);
}

pub(crate) fn render_app(frame: &mut ratatui::Frame, state: &mut AppState) {
    let size = frame.area();
    state.ui.hits.begin_frame();
    frame.render_widget(
        ratatui::widgets::Block::default().style(
            ratatui::style::Style::default()
                .bg(crate::style::BG())
                .fg(crate::style::FG()),
        ),
        size,
    );

    if size.width == 0 || size.height == 0 {
        return;
    }
    // Session tabs take the top row once two or more are open.
    let size = if state.ui.tab_strip.visible() && size.height > 8 {
        let [strip, rest] =
            Layout::vertical([Constraint::Length(1), Constraint::Fill(1)]).areas(size);
        widgets::tabs::render(frame, strip, &state.ui);
        rest
    } else {
        size
    };

    use crate::state::PlanReviewPhase;

    // Plan review fills the chat list; hide composer while choosing A/R/C.
    let plan_takes_chat = state.plan_review.takes_chat_area();
    let hide_composer =
        state.plan_review.phase == PlanReviewPhase::Review && !state.agent.has_pending_approval();

    let mut input_height = if hide_composer {
        0
    } else {
        (widgets::input::desired_height(
            &state.input.input_text,
            size.width,
            state.agent.message_queue.len(),
        ) + u16::from(!state.input.attachments.is_empty()))
        .max(widgets::input::min_height())
    };
    // Layout chrome: chat fills the middle, an activity strip
    // appears between chat and composer while a turn runs, and a one-row hint
    // bar sits at the bottom. No live status on the hint bar — approvals have
    // their floating card, retry/stalled surface in the activity strip.
    let hints_height: u16 = 1;
    let activity_height = widgets::activity::visible_height(state);
    // One blank row separates the conversation from the composer block; the
    // activity strip sits above the gap while a turn runs.
    let spacer_height: u16 = 1;
    let bottom = hints_height + activity_height + spacer_height;
    let max_input = size.height.saturating_sub(bottom + 2);
    if input_height > 0 {
        input_height = input_height
            .min(max_input)
            .max(widgets::input::min_height().min(max_input));
    }
    let [content, activity, _gap, input, hints] = Layout::vertical([
        Constraint::Fill(1),
        Constraint::Length(activity_height),
        Constraint::Length(spacer_height),
        Constraint::Length(input_height),
        Constraint::Length(hints_height),
    ])
    .areas(size);

    // Plan approve UI replaces the chat list entirely.
    if plan_takes_chat {
        widgets::plan_review::render(frame, content, state);
    } else if state.ui.show_welcome_screen && state.session.chat_history.is_empty() {
        widgets::welcome::render(frame, content, state);
    } else {
        render_content(frame, content, state);
    }
    if input_height > 0 {
        widgets::input::render(frame, input, state);
    }
    if activity_height > 0 {
        widgets::activity::render(frame, activity, state);
    }
    // Composer pickers float up over the transcript *and* the activity strip,
    // so they paint after both — otherwise the strip cuts through the list.
    if input_height > 0 {
        render_composer_picker(frame, input, state);
    }
    widgets::hints::render(frame, hints, state);
    render_overlays(frame, size, content, state);
    // Ephemeral confirmation chip; expires itself, never persisted.
    state.ui.clear_expired_toast();
    widgets::chat::render_toast(frame, content, state);
}

fn render_content(frame: &mut ratatui::Frame, area: ratatui::layout::Rect, state: &mut AppState) {
    let [header, body] = Layout::vertical([Constraint::Length(1), Constraint::Fill(1)]).areas(area);
    render_header(frame, header, state);

    widgets::chat::render(frame, body, state);
}

fn render_header(frame: &mut ratatui::Frame, area: ratatui::layout::Rect, state: &AppState) {
    use crate::style::*;
    use ratatui::style::Style;
    use ratatui::text::{Line, Span};
    use ratatui::widgets::Paragraph;

    // Header: cwd + git status on the left, context usage on the right.
    let mut spans: Vec<Span<'static>> = vec![
        Span::styled(" ", Style::default().bg(BG())),
        Span::styled(
            shorten_dir(&state.session.project_dir),
            Style::default().fg(FG_DIM()),
        ),
    ];

    if let Some(git) = crate::git_status::get_git_header_info(
        &state.session.project_dir,
        &state.session.modified_files,
    ) {
        spans.push(Span::styled("  ", Style::default().bg(BG())));
        let dirty = if git.is_dirty { "*" } else { "" };
        spans.push(Span::styled(
            format!(" {}{dirty}", git.branch),
            Style::default().fg(PRIMARY()),
        ));

        if area.width >= 70 && (git.additions > 0 || git.deletions > 0) {
            spans.push(Span::styled(" (", Style::default().fg(FG_MUTED())));
            if git.additions > 0 {
                spans.push(Span::styled(
                    format!("+{}", git.additions),
                    Style::default().fg(SUCCESS()),
                ));
            }
            if git.additions > 0 && git.deletions > 0 {
                spans.push(Span::styled("/", Style::default().fg(FG_MUTED())));
            }
            if git.deletions > 0 {
                spans.push(Span::styled(
                    format!("-{}", git.deletions),
                    Style::default().fg(ERROR()),
                ));
            }
            spans.push(Span::styled(")", Style::default().fg(FG_MUTED())));
        }
    }

    // Mode, spend and context live on the status row under the composer;
    // the header is just where you are.
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(BG())),
        area,
    );
}

/// `~/projects/agente` — home prefix collapsed to `~`, path separators
/// normalized, and deep paths trimmed to their last two components.
fn shorten_dir(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().replace('\\', "/"))
        .filter(|h| !h.is_empty() && normalized.starts_with(h.as_str()));
    let display = match home {
        Some(home) => format!("~{}", &normalized[home.len()..]),
        None => normalized,
    };
    if display.chars().count() <= 32 {
        return display;
    }
    let parts: Vec<&str> = display.split('/').filter(|p| !p.is_empty()).collect();
    match parts.len() {
        0 => display,
        1 => format!("…/{}", parts[0]),
        _ => format!("…/{}/{}", parts[parts.len() - 2], parts[parts.len() - 1]),
    }
}

fn render_composer_picker(
    frame: &mut ratatui::Frame,
    area: ratatui::layout::Rect,
    state: &AppState,
) {
    // @ file picker takes priority over slash when both flags set (shouldn't happen)
    if state.input.show_at_picker {
        at_file_picker::render_above_input(frame, area, state);
    } else {
        slash_command::render_above_input(frame, area, state);
    }
}

fn render_overlays(
    frame: &mut ratatui::Frame,
    size: ratatui::layout::Rect,
    content: ratatui::layout::Rect,
    state: &mut AppState,
) {
    // Every floating dialog is scoped to the chat area, never the whole frame.
    // Centered on the frame they straddle the composer — leaving its rounded
    // corners poking out on both sides of the card — and the ones that clear
    // their whole area (palette backdrop, session picker) used to erase the
    // composer and the status bar outright, so the user lost mode/model/status
    // the moment a dialog opened.
    let owner = crate::state::modal_owner(state);

    // One backdrop for every floating card, painted here rather than by each
    // widget. Only the palette and the subagents popup used to dim, so the
    // model selector and the approval card floated over full-brightness chat:
    // transcript text ran through the card's row band and was chopped mid-word
    // at both edges (harness shot `overlay_model_selector_80x24.txt`).
    //
    // Transparent gray veil, not an opaque wipe. `content` is the chat region
    // alone — the composer, activity strip and hint bar are separate rects
    // below it — so dimming it costs no chrome. Glyphs stay legible behind
    // the dialog; the card itself stays opaque (`panel_bg` / `modal_card`
    // Clear first), which is what reads as depth.
    if owner.floats_over_chat() {
        crate::widgets::dim_backdrop(frame, content);
    }

    // A dialog that just took over eases in from the canvas.
    if state.ui.last_modal_owner != Some(owner) {
        state.ui.last_modal_owner = Some(owner);
        if owner.floats_over_chat() && !state.ui.reduce_motion {
            state.ui.surface_fade = Some(crate::state::anim::Tween::start(
                crate::state::anim::MODAL_MS,
            ));
        }
    }

    match owner {
        crate::state::ModalOwner::Approval => widgets::approval::render(frame, content, state),
        crate::state::ModalOwner::PlanAsk => widgets::plan_ask::render(frame, content, state),
        crate::state::ModalOwner::CommandPalette => command_palette::render(frame, content, state),
        crate::state::ModalOwner::Subagents => {
            command_palette::render_subagents(frame, content, state)
        }
        crate::state::ModalOwner::SubagentDetail => {
            widgets::subagent_detail::render(frame, content, state)
        }
        crate::state::ModalOwner::ModelSelector => model_selector::render(frame, content, state),
        crate::state::ModalOwner::SubagentModels => {
            crate::subagent_models::render(frame, content, state)
        }
        crate::state::ModalOwner::Settings => crate::settings::render(frame, content, state),
        crate::state::ModalOwner::Skills => crate::skills::render(frame, content, state),
        crate::state::ModalOwner::Mcp => crate::mcp_servers::render(frame, content, state),
        crate::state::ModalOwner::MediaConsent => {
            crate::media_consent::render(frame, content, state)
        }
        crate::state::ModalOwner::MessageActions => {
            crate::message_actions::render(frame, content, state)
        }
        crate::state::ModalOwner::ProcessView => {
            widgets::process_view::render(frame, content, state)
        }
        crate::state::ModalOwner::ThinkingSelector => {
            crate::thinking_selector::render(frame, content, state)
        }
        crate::state::ModalOwner::Connect => connect::render(frame, content, state),
        crate::state::ModalOwner::SessionPicker => session_picker::render(frame, content, state),
        crate::state::ModalOwner::Help => crate::help::render(frame, content, state),
        crate::state::ModalOwner::DiffPeek => render_diff_peek(frame, size, state),
        crate::state::ModalOwner::Doctor => crate::doctor::render(frame, content, state),
        crate::state::ModalOwner::PlanReview
        | crate::state::ModalOwner::PlanComment
        | crate::state::ModalOwner::AtPicker
        | crate::state::ModalOwner::SlashPicker
        | crate::state::ModalOwner::Welcome
        | crate::state::ModalOwner::None => {}
    }
    if let Some(p) = state.ui.surface_fade.and_then(|t| t.progress()) {
        crate::state::anim::fade_toward(
            frame.buffer_mut(),
            content,
            crate::style::BG(),
            (1.0 - p) * 0.6,
        );
    }
}

/// Full-width diff peek for a modified file (opened by clicking it in the
/// project-tree sidebar; Esc closes). Same borderless chrome as every other
/// floating surface: opaque panel, header rule, footer hint row.
fn render_diff_peek(frame: &mut ratatui::Frame, size: ratatui::layout::Rect, state: &mut AppState) {
    use crate::style::*;
    use ratatui::layout::Rect;

    let Some(path) = state.ui.diff_peek.clone() else {
        return;
    };
    if size.width < 20 || size.height < 6 {
        return;
    }

    let old_content = state
        .session
        .file_originals
        .get(&path)
        .and_then(|o| o.clone())
        .unwrap_or_default();
    let new_content = state
        .session
        .file_versions
        .get(&path)
        .cloned()
        .unwrap_or_default();

    // The peek is a takeover view, so it claims everything above the hint bar
    // (and the activity strip when one is up). A centered inset panel used to
    // straddle the composer, leaving the composer's rounded corners poking
    // out on either side of the diff.
    let reserved = 1 + widgets::activity::visible_height(state);
    let panel = Rect::new(
        size.x,
        size.y,
        size.width,
        size.height.saturating_sub(reserved).max(6),
    );

    widgets::panel_bg(frame, panel);

    let body = widgets::panel_header(
        frame,
        panel,
        vec![
            widgets::s("Diff: ", bold()),
            widgets::s(
                widgets::truncate_cells(&path, (panel.width as usize).saturating_sub(8)),
                muted(),
            ),
        ],
    );
    widgets::panel_footer(
        frame,
        panel,
        widgets::footer_hints(&[("Esc", "close")], panel.width.saturating_sub(4)),
    );

    // Diff between the header rule and the footer row (one gap row above it).
    let height = panel.height.saturating_sub(3);
    if height == 0 {
        return;
    }
    let inner = Rect::new(panel.x, body.y, panel.width, height);
    let view =
        widgets::diff_view::DiffView::from_content(&old_content, &new_content, path.clone(), path);
    frame.render_widget(&view, inner);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn shorten_dir_keeps_short_paths_whole() {
        assert_eq!(shorten_dir("/tmp/x"), "/tmp/x");
    }

    #[test]
    fn shorten_dir_trims_deep_paths_to_last_two_parts() {
        assert_eq!(
            shorten_dir("/a/very/long/path/with/many/components/here"),
            "…/components/here"
        );
    }

    #[test]
    fn render_app_paints_without_panic_at_typical_and_small_sizes() {
        for (w, h) in [(80, 24), (20, 10)] {
            let backend = TestBackend::new(w, h);
            let mut terminal = Terminal::new(backend).unwrap();
            let mut state = AppState::new(
                agente_core::config::AppConfig::default(),
                "/tmp/render-smoke".to_string(),
            );
            terminal
                .draw(|f| render_app(f, &mut state))
                .expect("render must not panic");
            let painted = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .any(|c| c.symbol() != " ");
            assert!(painted, "frame at {w}x{h} paints some cell");
        }
    }
}
