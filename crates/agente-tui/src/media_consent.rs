//! Asking before images, audio and video are opened or attached.
//!
//! Attaching (a pasted or dropped path, a clipboard image, an `@` file) and
//! opening (the `[Open]` chip in the chat) both go through [`MediaRequest`].
//! Kinds listed in `allow_media` (`/settings`) skip the question; the others
//! show this card: Enter allows once, `a` always allows that kind, Esc
//! declines. PDFs never ask.

use std::path::PathBuf;

use agente_core::media::AttachmentKind;
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::state::AppState;
use crate::style;
use crate::widgets::{
    centered_panel, footer_hints, modal_card, modal_footer, panel_row, s, truncate_cells,
};

/// What the user is being asked to allow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaAction {
    /// Copy a file into the attachment store and add it to the composer.
    AttachPath(PathBuf),
    /// Store pasted bytes (a clipboard image) and add them to the composer.
    AttachBytes { bytes: Vec<u8>, mime: String },
    /// Open the file in the system viewer.
    Open(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaRequest {
    pub kind: AttachmentKind,
    pub name: String,
    pub bytes: u64,
    pub action: MediaAction,
}

impl MediaRequest {
    /// Kinds that ask first (PDFs are documents, not media).
    pub fn needs_consent(&self, allowed: &[AttachmentKind]) -> bool {
        self.kind != AttachmentKind::Pdf && !allowed.contains(&self.kind)
    }

    fn verb(&self) -> &'static str {
        match self.action {
            MediaAction::Open(_) => "Open",
            _ => "Attach",
        }
    }
}

/// `images` / `audio` / `video` for the "always allow" hint.
pub fn plural(kind: AttachmentKind) -> &'static str {
    match kind {
        AttachmentKind::Image => "images",
        AttachmentKind::Audio => "audio",
        AttachmentKind::Video => "video",
        AttachmentKind::Pdf => "PDFs",
    }
}

pub fn render(frame: &mut Frame, area: Rect, state: &AppState) {
    let Some(request) = &state.ui.media_consent else {
        return;
    };
    if area.width < 20 || area.height < 8 {
        return;
    }
    let panel = centered_panel(area, area.width.saturating_sub(4).min(64), 8);
    let body = modal_card(
        frame,
        panel,
        vec![s(
            format!("{} {}?", request.verb(), request.kind.label()),
            style::bold(),
        )],
    );
    let width = body.width.saturating_sub(2) as usize;
    let detail = match &request.action {
        MediaAction::Open(_) => "Opens in your system viewer.".to_string(),
        _ => "It is copied to ~/.agente/attachments and sent to the model with your message."
            .to_string(),
    };
    let lines = [
        Line::from(vec![
            s(
                truncate_cells(&request.name, width.saturating_sub(12)),
                style::accent(),
            ),
            s(
                format!(" · {}", agente_core::media::human_bytes(request.bytes)),
                style::dim(),
            ),
        ]),
        Line::from(s(truncate_cells(&detail, width), style::muted())),
    ];
    for (dy, line) in (1u16..).zip(lines) {
        if let Some(row) = panel_row(body, dy, 1) {
            frame.render_widget(Paragraph::new(line), row);
        }
    }
    let always = format!("always allow {}", plural(request.kind));
    modal_footer(
        frame,
        body,
        footer_hints(
            &[("Enter", "allow"), ("a", always.as_str()), ("Esc", "no")],
            body.width.saturating_sub(2),
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_asks_unless_allowed_and_pdfs_never_ask() {
        let request = |kind| MediaRequest {
            kind,
            name: "x".into(),
            bytes: 1,
            action: MediaAction::Open("x".into()),
        };
        assert!(request(AttachmentKind::Image).needs_consent(&[]));
        assert!(!request(AttachmentKind::Image).needs_consent(&[AttachmentKind::Image]));
        assert!(request(AttachmentKind::Video).needs_consent(&[AttachmentKind::Image]));
        assert!(!request(AttachmentKind::Pdf).needs_consent(&[]));
    }
}
