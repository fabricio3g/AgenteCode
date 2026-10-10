//! Terminal Doctor (/doctor) diagnostic modal.
//!
//! Inspects terminal capabilities, Nerd Font glyph rendering, clipboard,
//! Git environment, and model configuration.

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::AppState;
use crate::style::*;
use crate::widgets::{centered_panel, footer_hints, modal_card, modal_footer, s, truncate_cells};

#[derive(Debug, Clone)]
pub struct DiagnosticCheck {
    pub category: &'static str,
    pub name: &'static str,
    pub status: CheckStatus,
    pub details: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
}

impl CheckStatus {
    pub fn badge(&self) -> (&'static str, Color) {
        match self {
            CheckStatus::Pass => ("✓ PASS", SUCCESS()),
            CheckStatus::Warn => ("! WARN", WARNING()),
            CheckStatus::Fail => ("✗ FAIL", ERROR()),
        }
    }
}

pub fn run_diagnostics(state: &AppState) -> Vec<DiagnosticCheck> {
    let mut checks = Vec::new();

    // 1. Terminal Environment
    let term = std::env::var("TERM").unwrap_or_else(|_| "unknown".to_string());
    let colorterm = std::env::var("COLORTERM").unwrap_or_else(|_| "none".to_string());
    let is_truecolor = colorterm.contains("truecolor") || colorterm.contains("24bit");
    checks.push(DiagnosticCheck {
        category: "Terminal",
        name: "Truecolor (24-bit)",
        status: if is_truecolor {
            CheckStatus::Pass
        } else {
            CheckStatus::Warn
        },
        details: format!("COLORTERM={colorterm}, TERM={term}"),
    });

    // 2. Unicode & Nerd Font Glyphs
    let glyphs = " ◉ ✎ ▸ ◆ ✓ ✗ ⧗";
    checks.push(DiagnosticCheck {
        category: "Fonts",
        name: "Symbols & Glyphs",
        status: CheckStatus::Pass,
        details: format!("Render test: {glyphs}"),
    });

    // 3. System Clipboard
    let clipboard_ok = arboard::Clipboard::new().is_ok();
    checks.push(DiagnosticCheck {
        category: "Clipboard",
        name: "System Clipboard (arboard)",
        status: if clipboard_ok {
            CheckStatus::Pass
        } else {
            CheckStatus::Warn
        },
        details: if clipboard_ok {
            "OS clipboard integration available".to_string()
        } else {
            "Fallback to OSC 52 terminal copy".to_string()
        },
    });

    // 4. Git Environment
    let git_branch = crate::git_status::get_git_branch(&state.session.project_dir);
    if let Some(branch) = git_branch {
        checks.push(DiagnosticCheck {
            category: "Git",
            name: "Repository & Branch",
            status: CheckStatus::Pass,
            details: format!(" {branch} (tracked)"),
        });
    } else {
        checks.push(DiagnosticCheck {
            category: "Git",
            name: "Repository & Branch",
            status: CheckStatus::Warn,
            details: "No git repository found in working directory".to_string(),
        });
    }

    // 5. Active Model & Provider
    let provider = &state.config.current_provider;
    let model = &state.config.current_model;
    let has_key = state.config.get_api_key_for(provider).is_some();
    checks.push(DiagnosticCheck {
        category: "Model",
        name: "Active Model & Provider",
        status: if has_key {
            CheckStatus::Pass
        } else {
            CheckStatus::Warn
        },
        details: if has_key {
            format!("{provider} · {model} (key configured)")
        } else {
            format!("{provider} · {model} (no API key set)")
        },
    });

    // 6. Mouse reporting (clicks, wheel, hover all depend on it).
    let regions = state.ui.click_regions.len();
    let (mouse_status, mouse_details) = if state.ui.mouse_pos.is_some() {
        let pos = state
            .ui
            .mouse_pos
            .map(|(x, y)| format!("last seen at ({x},{y})"))
            .unwrap_or_else(|| "position unknown".to_string());
        // Legacy conhost does not forward wheel events inside the alternate
        // screen; Windows Terminal does.
        let term_hint = if cfg!(target_os = "windows") && std::env::var("WT_SESSION").is_err() {
            " · not Windows Terminal: wheel may not report (conhost)"
        } else {
            ""
        };
        (
            CheckStatus::Pass,
            format!("mouse events arriving · {pos} · {regions} click regions{term_hint}"),
        )
    } else {
        (
            CheckStatus::Warn,
            "no mouse event seen yet — move or scroll; if clicks never work, \
             the terminal may not report mouse (legacy conhost, multiplexer)"
                .to_string(),
        )
    };
    checks.push(DiagnosticCheck {
        category: "Input",
        name: "Mouse Reporting",
        status: mouse_status,
        details: mouse_details,
    });

    checks
}

pub fn render(frame: &mut Frame, area: Rect, state: &mut AppState) {
    if !state.input.show_doctor || area.width < 20 || area.height < 8 {
        return;
    }

    let desired_w = (area.width.saturating_sub(4)).min(74);
    let desired_h = (area.height.saturating_sub(2)).min(20);
    let panel = centered_panel(area, desired_w, desired_h);

    let body = modal_card(
        frame,
        panel,
        vec![
            s("Terminal Doctor ", bold()),
            s("· Environment & Diagnostics", muted()),
        ],
    );
    modal_footer(
        frame,
        body,
        footer_hints(
            &[("Esc", "close"), ("q", "quit diagnostics")],
            body.width.saturating_sub(2),
        ),
    );

    let checks = run_diagnostics(state);
    let visible = body.height as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();

    // 24-bit RGB gradient preview bar
    lines.push(Line::from(vec![
        s(" 24-bit RGB:  ", dim()),
        Span::styled(
            "███",
            Style::default().fg(Color::Rgb(255, 60, 60)).bg(BG_PANEL()),
        ),
        Span::styled(
            "███",
            Style::default().fg(Color::Rgb(255, 180, 40)).bg(BG_PANEL()),
        ),
        Span::styled(
            "███",
            Style::default().fg(Color::Rgb(80, 220, 100)).bg(BG_PANEL()),
        ),
        Span::styled(
            "███",
            Style::default().fg(Color::Rgb(60, 160, 255)).bg(BG_PANEL()),
        ),
        Span::styled(
            "███",
            Style::default()
                .fg(Color::Rgb(180, 100, 255))
                .bg(BG_PANEL()),
        ),
        s("  (RGB color ramp test)", dim()),
    ]));
    lines.push(Line::from(vec![s("", dim())]));

    for check in checks {
        let (badge_text, badge_color) = check.status.badge();
        // A pass is the expected state: it stays quiet so warnings and failures find the eye.
        let badge_style = if matches!(check.status, CheckStatus::Pass) {
            Style::default().fg(FG_DIM()).bg(BG_PANEL())
        } else {
            Style::default()
                .fg(badge_color)
                .add_modifier(Modifier::BOLD)
                .bg(BG_PANEL())
        };
        let row_spans = vec![
            s(" ", dim()),
            Span::styled(format!("{badge_text:<7}"), badge_style),
            s(" ", dim()),
            Span::styled(
                format!("{:<20}", check.name),
                Style::default().fg(FG()).bg(BG_PANEL()),
            ),
            s(" ", dim()),
            Span::styled(
                truncate_cells(&check.details, (body.width as usize).saturating_sub(32)),
                Style::default().fg(FG_MUTED()).bg(BG_PANEL()),
            ),
        ];
        lines.push(Line::from(row_spans));
    }

    let scroll = (state.input.doctor_scroll as usize).min(lines.len().saturating_sub(visible));
    let end = (scroll + visible).min(lines.len());
    let display_lines = lines[scroll..end].to_vec();

    frame.render_widget(
        Paragraph::new(display_lines).style(Style::default().bg(BG_PANEL())),
        body,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;

    #[test]
    fn diagnostics_run_without_panicking() {
        let state = AppState::new(AppConfig::default(), "/tmp/doctor-test".to_string());
        let checks = run_diagnostics(&state);
        assert!(!checks.is_empty());
        assert!(checks.iter().any(|c| c.name.contains("Truecolor")));
        assert!(checks.iter().any(|c| c.name.contains("Symbols")));
        assert!(checks.iter().any(|c| c.name.contains("Clipboard")));
        assert!(checks.iter().any(|c| c.name.contains("Mouse Reporting")));
    }

    #[test]
    fn mouse_check_warns_before_first_event_and_passes_after() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/doctor-test".to_string());
        let before: Vec<_> = run_diagnostics(&state)
            .into_iter()
            .filter(|c| c.name.contains("Mouse Reporting"))
            .collect();
        assert_eq!(before.len(), 1);
        assert!(matches!(before[0].status, CheckStatus::Warn));

        state.ui.mouse_pos = Some((12, 34));
        let after: Vec<_> = run_diagnostics(&state)
            .into_iter()
            .filter(|c| c.name.contains("Mouse Reporting"))
            .collect();
        assert_eq!(after.len(), 1);
        assert!(matches!(after[0].status, CheckStatus::Pass));
        assert!(after[0].details.contains("(12,34)"));
    }
}
