//! Attaching and opening media, through the consent card when the kind asks.

use std::path::Path;

use crossterm::event::{KeyCode, KeyEvent};

use super::App;
use crate::media_consent::{MediaAction, MediaRequest};

impl App {
    /// A media file as a request (`None` when it is not a media type).
    pub(super) fn media_request_for_path(path: &Path, open: bool) -> Option<MediaRequest> {
        let (kind, _) = agente_core::media::kind_for_path(path)?;
        let bytes = std::fs::metadata(path).ok()?.len();
        Some(MediaRequest {
            kind,
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string()),
            bytes,
            action: if open {
                MediaAction::Open(path.to_path_buf())
            } else {
                MediaAction::AttachPath(path.to_path_buf())
            },
        })
    }

    /// Refuse when blocked, ask when this kind needs consent, otherwise do it.
    pub(super) fn request_media(&mut self, request: MediaRequest) {
        if self.state.config.config.is_media_denied(request.kind) {
            self.state
                .ui
                .show_toast(format!("{} is disabled in /settings", request.kind.label()));
            self.state.ui.needs_render = true;
            return;
        }
        if request.needs_consent(&self.state.config.config.allow_media) {
            self.state.ui.media_consent = Some(request);
        } else {
            self.perform_media(request);
        }
        self.state.ui.needs_render = true;
    }

    fn perform_media(&mut self, request: MediaRequest) {
        let result = match request.action {
            MediaAction::Open(path) => {
                super::mouse::open_asset_in_viewer(&path.to_string_lossy());
                self.state.ui.show_toast(format!("Opened {}", request.name));
                return;
            }
            MediaAction::AttachPath(path) => agente_core::media::attach_file(&path)
                .and_then(|found| found.ok_or_else(|| anyhow::anyhow!("not a media file"))),
            MediaAction::AttachBytes { bytes, mime } => {
                agente_core::media::store_bytes(&bytes, &request.name, request.kind, &mime)
            }
        };
        match result {
            Ok(attachment) => {
                self.state.ui.show_toast(format!(
                    "Attached {} · {}",
                    attachment.name,
                    agente_core::media::human_bytes(attachment.bytes)
                ));
                self.state.input.attachments.push(attachment);
            }
            Err(e) => self
                .state
                .add_system_message(format!("Could not attach {}: {e}", request.name)),
        }
    }

    /// Enter allows once, `a` always allows this kind, Esc/`n` declines.
    pub(super) fn handle_media_consent_key(&mut self, key: KeyEvent) {
        let Some(request) = self.state.ui.media_consent.take() else {
            return;
        };
        match key.code {
            KeyCode::Enter | KeyCode::Char('y') => self.perform_media(request),
            KeyCode::Char('a') => {
                let allow = &mut self.state.config.config.allow_media;
                if !allow.contains(&request.kind) {
                    allow.push(request.kind);
                }
                self.state.persist_config();
                self.perform_media(request);
            }
            KeyCode::Esc | KeyCode::Char('n') => {
                self.state
                    .ui
                    .show_toast(format!("{} not opened", request.name));
            }
            _ => self.state.ui.media_consent = Some(request),
        }
        self.state.ui.needs_render = true;
    }

    /// A paste that is a path to a media file attaches it. Returns whether
    /// the paste was taken.
    pub(super) fn attach_pasted_path(&mut self, text: &str) -> bool {
        let Some(path) =
            agente_core::media::media_path_from_paste(text, &self.state.session.project_dir)
        else {
            return false;
        };
        match Self::media_request_for_path(&path, false) {
            Some(request) => {
                self.request_media(request);
                true
            }
            None => false,
        }
    }

    /// Ctrl+V with an image on the clipboard (a screenshot).
    pub(super) fn attach_clipboard_image(&mut self) -> bool {
        if !crate::state::modal_owner(&self.state).allows_composer_input() {
            return false;
        }
        match crate::clipboard::paste_image_png() {
            Ok(Some(png)) => {
                let name = format!(
                    "pasted-{}.png",
                    chrono::Local::now().format("%Y%m%d-%H%M%S")
                );
                self.request_media(MediaRequest {
                    kind: agente_core::media::AttachmentKind::Image,
                    name,
                    bytes: png.len() as u64,
                    action: MediaAction::AttachBytes {
                        bytes: png,
                        mime: "image/png".into(),
                    },
                });
                true
            }
            Ok(None) => false,
            Err(error) => {
                tracing::debug!(%error, "clipboard image read failed");
                false
            }
        }
    }
}
