//! `/skills`: the installed Agent Skills, one list.
//!
//! Each row is a skill with its scope on the right; the selected skill's
//! description shows under the list. Enter puts `/name ` in the composer so
//! the user can add a request and run it. Skills marked
//! `disable-model-invocation` are flagged "manual" — only `/name` runs them.

use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::{AppState, ListId};
use crate::style;
use crate::widgets::markdown::wrap_line;
use crate::widgets::pick::{pick_list, row_label, PickItem};
use crate::widgets::{centered_panel, footer_hints, modal_card, modal_footer, panel_row, s};

/// Rows the list shows before it scrolls.
const MAX_ROWS: usize = 10;
/// Description lines under the list.
const DESCRIPTION_ROWS: u16 = 2;

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_skills || area.width < 16 || area.height < 9 {
        return;
    }
    let skills = &state.input.skills;
    let rows = skills.len().clamp(1, MAX_ROWS) as u16;
    // gap + rows + gap + description + gap + footer inside the border.
    let panel = centered_panel(
        area,
        area.width.saturating_sub(4).min(72),
        rows + DESCRIPTION_ROWS + 6,
    );
    let count = match skills.len() {
        1 => " · 1 installed".to_string(),
        n => format!(" · {n} installed"),
    };
    let body = modal_card(
        frame,
        panel,
        vec![s("Skills", style::bold()), s(count, style::dim())],
    );
    let text_w = body.width.saturating_sub(2) as usize;

    if skills.is_empty() {
        let lines = [
            s("No skills installed.", style::muted()),
            s("Add one at .agente/skills/<name>/SKILL.md", style::dim()),
        ];
        for (dy, line) in (1u16..).zip(lines) {
            if let Some(row) = panel_row(body, dy, 1) {
                frame.render_widget(Paragraph::new(Line::from(line)), row);
            }
        }
    } else if let Some(top) = panel_row(body, 1, 1) {
        let selected = state.input.skills_selected.min(skills.len() - 1);
        let list_area = Rect {
            height: rows.min(body.height.saturating_sub(1)),
            ..top
        };
        let items = skills
            .iter()
            .enumerate()
            .map(|(i, skill)| {
                let trail = if skill.model_invocable {
                    skill.scope.label().to_string()
                } else {
                    format!("{} · manual", skill.scope.label())
                };
                PickItem::row_with_trail(
                    vec![s(skill.name.clone(), row_label(i == selected))],
                    vec![s(trail, style::dim())],
                )
            })
            .collect();
        pick_list(
            frame,
            list_area,
            &state.ui.hits,
            ListId::Skills,
            items,
            selected,
        );

        let description = Line::from(s(skills[selected].description.clone(), style::muted()));
        let wrapped = wrap_line(&description, text_w);
        let last = wrapped.len();
        for (i, mut line) in wrapped
            .into_iter()
            .take(DESCRIPTION_ROWS as usize)
            .enumerate()
        {
            if i + 1 == DESCRIPTION_ROWS as usize && last > DESCRIPTION_ROWS as usize {
                line.spans.push(s("…", style::dim()));
            }
            if let Some(row) = panel_row(body, rows + 2 + i as u16, 1) {
                frame.render_widget(Paragraph::new(line), row);
            }
        }
    }

    modal_footer(
        frame,
        body,
        footer_hints(
            &[("↑↓", "move"), ("Enter", "use"), ("Esc", "close")],
            body.width.saturating_sub(2),
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use agente_core::extensions::{Skill, SkillScope};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn screen(state: &AppState) -> String {
        let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
        terminal.draw(|f| render(f, f.area(), state)).unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    #[test]
    fn lists_skills_with_scope_and_the_selected_description() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/skills-test".into());
        state.input.show_skills = true;
        state.input.skills = vec![
            Skill {
                name: "pdf".into(),
                description: "Fill PDF forms. Use when the user mentions PDFs.".into(),
                source: "/s/pdf/SKILL.md".into(),
                dir: "/s/pdf".into(),
                scope: SkillScope::User,
                model_invocable: true,
                compatibility: None,
            },
            Skill {
                name: "release".into(),
                description: "Cut a release.".into(),
                source: "/p/release/SKILL.md".into(),
                dir: "/p/release".into(),
                scope: SkillScope::Project,
                model_invocable: false,
                compatibility: None,
            },
        ];
        let text = screen(&state);
        assert!(text.contains("2 installed"), "{text}");
        assert!(text.contains("pdf") && text.contains("release"), "{text}");
        assert!(text.contains("project · manual"), "{text}");
        assert!(
            text.contains("Fill PDF forms"),
            "selected description: {text}"
        );
    }

    #[test]
    fn empty_state_says_where_skills_go() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/skills-test".into());
        state.input.show_skills = true;
        let text = screen(&state);
        assert!(text.contains("No skills installed"), "{text}");
        assert!(text.contains(".agente/skills/<name>/SKILL.md"), "{text}");
    }
}
