//! `/settings`: the few preferences worth a toggle, in one dialog.
//!
//! Rows are toggles (Enter flips, saved immediately) or links into another
//! dialog (subagent models). Values show on the right in the list's trail.

use ratatui::layout::Rect;
use ratatui::Frame;

use crate::state::{AppState, ListId};
use crate::style;
use crate::widgets::pick::{pick_list, row_label, PickItem};
use crate::widgets::{centered_panel, footer_hints, modal_card, modal_footer, panel_row, s};

/// Every settings row, in display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Setting {
    SmartCompaction,
    ParallelSubagents,
    ReduceMotion,
    AutoApprove,
    /// Open/attach images without asking.
    MediaImages,
    MediaAudio,
    MediaVideo,
    Theme,
    SubagentModels,
}

pub const SETTINGS: &[Setting] = &[
    Setting::SmartCompaction,
    Setting::ParallelSubagents,
    Setting::ReduceMotion,
    Setting::AutoApprove,
    Setting::MediaImages,
    Setting::MediaAudio,
    Setting::MediaVideo,
    Setting::Theme,
    Setting::SubagentModels,
];

impl Setting {
    pub fn label(self) -> &'static str {
        match self {
            Self::SmartCompaction => "Smart compaction",
            Self::ParallelSubagents => "Parallel subagents",
            Self::ReduceMotion => "Reduce motion",
            Self::AutoApprove => "Always approve tool calls",
            Self::MediaImages => "Images",
            Self::MediaAudio => "Audio",
            Self::MediaVideo => "Video",
            Self::Theme => "Theme",
            Self::SubagentModels => "Subagent models",
        }
    }

    /// The media kind a permission row controls.
    pub fn media_kind(self) -> Option<agente_core::media::AttachmentKind> {
        use agente_core::media::AttachmentKind;
        match self {
            Self::MediaImages => Some(AttachmentKind::Image),
            Self::MediaAudio => Some(AttachmentKind::Audio),
            Self::MediaVideo => Some(AttachmentKind::Video),
            _ => None,
        }
    }

    /// Current value, plus whether it is "on" (accent) or neutral (dim).
    fn value(self, state: &AppState) -> (String, bool) {
        let on_off = |on: bool, on_text: &str, off_text: &str| {
            (if on { on_text } else { off_text }.to_string(), on)
        };
        match self {
            Self::SmartCompaction => on_off(state.config.config.smart_compaction, "on", "off"),
            Self::ParallelSubagents => (
                format!("{} at once", state.config.config.parallel_subagents()),
                false,
            ),
            Self::ReduceMotion => on_off(state.ui.reduce_motion, "on", "off"),
            Self::AutoApprove => on_off(state.agent.auto_approve_persistent, "on", "off"),
            Self::MediaImages | Self::MediaAudio | Self::MediaVideo => on_off(
                self.media_kind()
                    .is_some_and(|kind| state.config.config.allow_media.contains(&kind)),
                "allow",
                "ask",
            ),
            Self::Theme => (
                match crate::style::current_theme() {
                    crate::style::Theme::Dark => "dark",
                    crate::style::Theme::Light => "light",
                }
                .to_string(),
                false,
            ),
            Self::SubagentModels => {
                let n = state.config.config.subagent_models.len();
                if n == 0 {
                    ("main model ›".to_string(), false)
                } else {
                    (format!("{n} set ›"), true)
                }
            }
        }
    }
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_settings || area.width < 12 || area.height < 7 {
        return;
    }
    // gap + rows + gap + footer inside the border.
    let panel = centered_panel(
        area,
        area.width.saturating_sub(4).min(64),
        SETTINGS.len() as u16 + 5,
    );
    let body = modal_card(frame, panel, vec![s("Settings", style::bold())]);
    if let Some(top) = panel_row(body, 1, 1) {
        let list_area = Rect {
            height: body.height.saturating_sub(3),
            ..top
        };
        let selected = state.input.settings_selected;
        let items = SETTINGS
            .iter()
            .enumerate()
            .map(|(i, setting)| {
                let (value, on) = setting.value(state);
                PickItem::row_with_trail(
                    vec![s(setting.label(), row_label(i == selected))],
                    vec![s(value, if on { style::accent() } else { style::dim() })],
                )
            })
            .collect();
        pick_list(
            frame,
            list_area,
            &state.ui.hits,
            ListId::Settings,
            items,
            selected,
        );
    }
    modal_footer(
        frame,
        body,
        footer_hints(
            &[("↑↓", "move"), ("Enter", "change"), ("Esc", "close")],
            body.width.saturating_sub(2),
        ),
    );
}

/// Steps `Enter` cycles through for Parallel subagents.
pub const PARALLEL_STEPS: &[usize] = &[2, 4, 8, 12, 16];

/// The next step after `current` (wrapping), for the settings toggle.
pub fn next_parallel(current: usize) -> usize {
    PARALLEL_STEPS
        .iter()
        .copied()
        .find(|&step| step > current)
        .unwrap_or(PARALLEL_STEPS[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    use agente_core::config::AppConfig;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn smart_compaction_is_listed_and_off_by_default() {
        let mut state = AppState::new(AppConfig::default(), "/tmp/settings-test".into());
        state.input.show_settings = true;
        let mut terminal = Terminal::new(TestBackend::new(80, 16)).unwrap();
        terminal.draw(|f| render(f, f.area(), &state)).unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(text.contains("Smart compaction"), "{text}");
        assert!(text.contains("off"), "{text}");
        assert!(text.contains("Subagent models"), "{text}");
        assert!(text.contains("8 at once"), "default parallelism: {text}");
    }

    #[test]
    fn parallel_subagents_cycle_and_wrap() {
        assert_eq!(next_parallel(8), 12);
        assert_eq!(next_parallel(16), 2, "wraps to the smallest");
        assert_eq!(next_parallel(5), 8, "an off-step value rounds up");
    }
}
