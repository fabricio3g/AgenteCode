//! `/settings`: the few preferences worth a toggle, in one dialog.
//!
//! Rows are toggles (Enter flips, saved immediately) or links into another
//! dialog (subagent models). Values show on the right in the list's trail.

use agente_core::tools::web::settings::{SearchProvider, WebSettings};
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::Frame;

use crate::state::{AppState, ListId};
use crate::style;
use crate::widgets::pick::{pick_list, row_label, PickItem};
use crate::widgets::{s, ModalChrome};

/// Every settings row, in display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Setting {
    SmartCompaction,
    ParallelSubagents,
    ReduceMotion,
    AutoApprove,
    /// Media capabilities: cycle `ask` → `allow` → `block`.
    MediaImages,
    MediaAudio,
    MediaVideo,
    MediaPdf,
    Theme,
    /// Which provider `web_search` uses (`web.json`).
    WebSearch,
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
    Setting::MediaPdf,
    Setting::Theme,
    Setting::WebSearch,
    Setting::SubagentModels,
];

impl Setting {
    pub fn label(self) -> &'static str {
        match self {
            Self::SmartCompaction => "Smart compaction",
            Self::ParallelSubagents => "Parallel subagents",
            Self::ReduceMotion => "Reduce motion",
            Self::AutoApprove => "Always approve tool calls",
            Self::MediaImages => "Images / Vision",
            Self::MediaAudio => "Audio",
            Self::MediaVideo => "Video",
            Self::MediaPdf => "PDFs",
            Self::Theme => "Theme",
            Self::WebSearch => "Web search",
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
            Self::MediaPdf => Some(AttachmentKind::Pdf),
            _ => None,
        }
    }

    /// Current value and its tint: accent when changed from the default,
    /// warning when it cannot work yet, dim otherwise.
    fn value(self, state: &AppState) -> (String, Style) {
        if self == Self::WebSearch {
            return web_search_value(&WebSettings::load());
        }
        if let Some(kind) = self.media_kind() {
            if state.config.config.is_media_denied(kind) {
                return ("block".to_string(), style::warning());
            }
            if state.config.config.allow_media.contains(&kind) {
                return ("allow".to_string(), style::accent());
            }
            return ("ask".to_string(), style::dim());
        }
        let (text, on) = self.toggle_value(state);
        (text, if on { style::accent() } else { style::dim() })
    }

    /// Current value of an ordinary row, plus whether it is "on".
    fn toggle_value(self, state: &AppState) -> (String, bool) {
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
            Self::MediaImages | Self::MediaAudio | Self::MediaVideo | Self::MediaPdf => {
                (String::new(), false)
            }
            Self::Theme => (
                match crate::style::current_theme() {
                    crate::style::Theme::Dark => "dark",
                    crate::style::Theme::Light => "light",
                }
                .to_string(),
                false,
            ),
            Self::WebSearch => (String::new(), false),
            Self::SubagentModels => {
                let n = state.config.config.subagent_settings().models.len();
                if n == 0 {
                    ("main model ›".to_string(), false)
                } else {
                    (
                        format!("{n} model{} ›", if n == 1 { "" } else { "s" }),
                        true,
                    )
                }
            }
        }
    }
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    if !state.input.show_settings || area.width < 12 || area.height < 7 {
        return;
    }
    let modal = ModalChrome::new(vec![s("Settings", style::bold())])
        .footer(&[("↑↓", "move"), ("Enter", "change"), ("Esc", "close")])
        .render_centered(
            frame,
            area,
            area.width.saturating_sub(4).min(64),
            SETTINGS.len() as u16 + 5,
        );
    if modal.body.width > 0 && modal.body.height > 0 {
        let selected = state.input.settings_selected;
        let items = SETTINGS
            .iter()
            .enumerate()
            .map(|(i, setting)| {
                let (value, tint) = setting.value(state);
                PickItem::row_with_trail(
                    vec![s(setting.label(), row_label(i == selected))],
                    vec![s(value, tint)],
                )
            })
            .collect();
        pick_list(
            frame,
            modal.body,
            &state.ui.hits,
            ListId::Settings,
            items,
            selected,
        );
    }
}

/// The Web search row: the provider, or what it still needs.
fn web_search_value(settings: &WebSettings) -> (String, Style) {
    let provider = settings.search_provider;
    if provider == SearchProvider::DuckDuckGo {
        return (provider.label().to_string(), style::dim());
    }
    if settings.ready(provider) {
        (provider.label().to_string(), style::accent())
    } else {
        (
            format!("{} · {}", provider.label(), missing(provider)),
            style::warning(),
        )
    }
}

/// What a provider lacks, in the words of the fix.
fn missing(provider: SearchProvider) -> String {
    match provider.key_vars().first() {
        Some(var) => format!("set {var}"),
        None => "set SEARXNG_URL".to_string(),
    }
}

/// Move Web search to the next provider, save it, and say what it needs.
pub fn cycle_web_search() -> Result<String, String> {
    let mut settings = WebSettings::load();
    let all = SearchProvider::ALL;
    let at = all
        .iter()
        .position(|p| *p == settings.search_provider)
        .unwrap_or(0);
    let next = all[(at + 1) % all.len()];
    settings.search_provider = next;
    settings
        .save()
        .map_err(|e| format!("Could not save web search: {e}"))?;
    Ok(if settings.ready(next) {
        format!("Web search: {}", next.label())
    } else {
        let mut note = format!(
            "{} needs {} — DuckDuckGo answers until then",
            next.label(),
            missing(next).trim_start_matches("set ")
        );
        if let Some(url) = next.key_url() {
            note.push_str(&format!(" (key: {url})"));
        }
        note
    })
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
    fn web_search_row_names_the_provider_or_what_it_needs() {
        let default = WebSettings::default();
        assert_eq!(
            web_search_value(&default),
            ("DuckDuckGo".to_string(), style::dim())
        );
        let searxng = WebSettings {
            search_provider: SearchProvider::SearXng,
            searxng_url: Some("https://search.example".into()),
            ..WebSettings::default()
        };
        assert_eq!(
            web_search_value(&searxng),
            ("SearXNG".to_string(), style::accent())
        );
        assert_eq!(missing(SearchProvider::Brave), "set BRAVE_SEARCH_API_KEY");
        assert_eq!(missing(SearchProvider::SearXng), "set SEARXNG_URL");
    }

    #[test]
    fn parallel_subagents_cycle_and_wrap() {
        assert_eq!(next_parallel(8), 12);
        assert_eq!(next_parallel(16), 2, "wraps to the smallest");
        assert_eq!(next_parallel(5), 8, "an off-step value rounds up");
    }
}
