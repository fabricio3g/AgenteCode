//! Media attachments: images, audio, video and PDFs sent with a message.
//!
//! Attaching copies the file into `~/.agente/attachments/<hash>.<ext>` (so a
//! session keeps working after the original moves) and the message carries
//! only a reference. Providers read and base64-encode the copy when they
//! build a request, in their own format; kinds a model does not accept are
//! replaced by a short note instead of failing the request (the TUI refuses
//! them up front, this only covers history sent to a different model).

use std::path::{Path, PathBuf};

use base64::Engine;

pub use agente_protocol::{Attachment, AttachmentKind};

use crate::providers::ModelInfo;

/// Largest file accepted per kind (providers reject bigger inline payloads).
fn max_bytes(kind: AttachmentKind) -> u64 {
    const MB: u64 = 1024 * 1024;
    match kind {
        AttachmentKind::Image => 20 * MB,
        AttachmentKind::Audio => 25 * MB,
        AttachmentKind::Video => 50 * MB,
        AttachmentKind::Pdf => 32 * MB,
    }
}

/// Kind and MIME type from a file extension.
pub fn kind_for_path(path: &Path) -> Option<(AttachmentKind, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => (AttachmentKind::Image, "image/png"),
        "jpg" | "jpeg" => (AttachmentKind::Image, "image/jpeg"),
        "gif" => (AttachmentKind::Image, "image/gif"),
        "webp" => (AttachmentKind::Image, "image/webp"),
        "mp3" => (AttachmentKind::Audio, "audio/mpeg"),
        "wav" => (AttachmentKind::Audio, "audio/wav"),
        "m4a" => (AttachmentKind::Audio, "audio/mp4"),
        "ogg" | "oga" => (AttachmentKind::Audio, "audio/ogg"),
        "flac" => (AttachmentKind::Audio, "audio/flac"),
        "aac" => (AttachmentKind::Audio, "audio/aac"),
        "mp4" | "m4v" => (AttachmentKind::Video, "video/mp4"),
        "mov" => (AttachmentKind::Video, "video/quicktime"),
        "webm" => (AttachmentKind::Video, "video/webm"),
        "mpeg" | "mpg" => (AttachmentKind::Video, "video/mpeg"),
        "pdf" => (AttachmentKind::Pdf, "application/pdf"),
        _ => return None,
    })
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/mp4" => "m4a",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/aac" => "aac",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/mpeg" => "mpeg",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

fn store_dir() -> anyhow::Result<PathBuf> {
    let dir = crate::config::AppConfig::config_dir()
        .ok_or_else(|| anyhow::anyhow!("no home directory for attachments"))?
        .join("attachments");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Store `bytes` (content-addressed, so the same file is kept once).
pub fn store_bytes(
    bytes: &[u8],
    name: &str,
    kind: AttachmentKind,
    mime: &str,
) -> anyhow::Result<Attachment> {
    let size = bytes.len() as u64;
    if size == 0 {
        anyhow::bail!("{name} is empty");
    }
    if size > max_bytes(kind) {
        anyhow::bail!(
            "{name} is {} — {} attachments are limited to {}",
            human_bytes(size),
            kind.label(),
            human_bytes(max_bytes(kind))
        );
    }
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    let hash: String = digest.iter().take(12).map(|b| format!("{b:02x}")).collect();
    let path = store_dir()?.join(format!("{hash}.{}", extension_for(mime)));
    if !path.exists() {
        std::fs::write(&path, bytes)?;
    }
    Ok(Attachment {
        kind,
        mime: mime.to_string(),
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        bytes: size,
    })
}

/// Attach a media file from disk. `Ok(None)` when it is not a media type.
pub fn attach_file(path: &Path) -> anyhow::Result<Option<Attachment>> {
    let Some((kind, mime)) = kind_for_path(path) else {
        return Ok(None);
    };
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > max_bytes(kind) {
        anyhow::bail!(
            "{} is {} — {} attachments are limited to {}",
            path.display(),
            human_bytes(meta.len()),
            kind.label(),
            human_bytes(max_bytes(kind))
        );
    }
    let bytes = std::fs::read(path)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment".into());
    store_bytes(&bytes, &name, kind, mime).map(Some)
}

/// A pasted or dropped path (`'/a b.png'`, `file:///a%20b.png`, `/a\ b.png`)
/// resolved to an existing media file.
pub fn media_path_from_paste(text: &str, project_dir: &str) -> Option<PathBuf> {
    let text = text.trim();
    if text.is_empty() || text.contains('\n') {
        return None;
    }
    let unquoted = text
        .strip_prefix('\'')
        .and_then(|t| t.strip_suffix('\''))
        .or_else(|| text.strip_prefix('"').and_then(|t| t.strip_suffix('"')))
        .unwrap_or(text);
    let unescaped = unquoted.replace("\\ ", " ");
    let raw = match unescaped.strip_prefix("file://") {
        Some(rest) => percent_decode(rest),
        None => unescaped,
    };
    let expanded = if let Some(rest) = raw.strip_prefix("~/") {
        dirs::home_dir()?.join(rest)
    } else {
        PathBuf::from(&raw)
    };
    let path = if expanded.is_absolute() {
        expanded
    } else {
        Path::new(project_dir).join(expanded)
    };
    (kind_for_path(&path).is_some() && path.is_file()).then_some(path)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `240 KB`, `3.1 MB`.
pub fn human_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b >= KB * KB {
        format!("{:.1} MB", b / (KB * KB))
    } else if b >= KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

/// Whether `model` accepts `kind` as input. models.dev / OpenRouter input
/// modalities decide; without them only images are assumed for a model
/// flagged as vision-capable.
pub fn model_accepts(model: &ModelInfo, kind: AttachmentKind) -> bool {
    let modalities = &model.capabilities.input_modalities;
    if modalities.is_empty() {
        return kind == AttachmentKind::Image && model.capabilities.vision;
    }
    modalities.iter().any(|m| {
        let m = m.to_ascii_lowercase();
        m == kind.modality() || (kind == AttachmentKind::Pdf && m == "file")
    })
}

/// Kinds in `attachments` that `model` does not accept (for a clear refusal
/// before sending).
pub fn unsupported(model: &ModelInfo, attachments: &[Attachment]) -> Vec<AttachmentKind> {
    let mut kinds: Vec<AttachmentKind> = attachments
        .iter()
        .map(|a| a.kind)
        .filter(|kind| !model_accepts(model, *kind))
        .collect();
    kinds.dedup();
    kinds
}

/// An attachment ready for a request body: its base64 data, or why it was
/// left out.
pub enum Encoded<'a> {
    Data {
        attachment: &'a Attachment,
        base64: String,
    },
    Skipped(String),
}

/// Encode a message's attachments for `model`.
pub fn encode_for<'a>(model: &ModelInfo, attachments: &'a [Attachment]) -> Vec<Encoded<'a>> {
    attachments
        .iter()
        .map(|attachment| {
            if !model_accepts(model, attachment.kind) {
                return Encoded::Skipped(format!(
                    "[{} attachment {} not sent: {} does not accept {} input]",
                    attachment.kind.label(),
                    attachment.name,
                    model.name,
                    attachment.kind.label()
                ));
            }
            match std::fs::read(&attachment.path) {
                Ok(bytes) => Encoded::Data {
                    attachment,
                    base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                },
                Err(e) => Encoded::Skipped(format!(
                    "[{} attachment {} unavailable: {e}]",
                    attachment.kind.label(),
                    attachment.name
                )),
            }
        })
        .collect()
}

/// `input_audio.format` for the OpenAI chat format.
pub fn audio_format(mime: &str) -> &'static str {
    match mime {
        "audio/wav" => "wav",
        "audio/mp4" => "m4a",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/aac" => "aac",
        _ => "mp3",
    }
}

/// Rough prompt cost of an attachment for context estimates.
pub fn estimated_tokens(attachment: &Attachment) -> usize {
    match attachment.kind {
        AttachmentKind::Image => 1_600,
        AttachmentKind::Pdf => (attachment.bytes / 2_000).clamp(1_000, 100_000) as usize,
        AttachmentKind::Audio | AttachmentKind::Video => {
            (attachment.bytes / 1_000).clamp(1_000, 200_000) as usize
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn media_types_come_from_the_extension() {
        assert_eq!(
            kind_for_path(Path::new("a/Shot.PNG")),
            Some((AttachmentKind::Image, "image/png"))
        );
        assert_eq!(
            kind_for_path(Path::new("talk.mp3")).map(|k| k.0),
            Some(AttachmentKind::Audio)
        );
        assert_eq!(
            kind_for_path(Path::new("demo.webm")).map(|k| k.0),
            Some(AttachmentKind::Video)
        );
        assert_eq!(
            kind_for_path(Path::new("spec.pdf")).map(|k| k.0),
            Some(AttachmentKind::Pdf)
        );
        assert_eq!(kind_for_path(Path::new("main.rs")), None);
    }

    #[test]
    fn dropped_paths_in_every_terminal_spelling_resolve() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("my shot.png");
        std::fs::write(&file, b"png").unwrap();
        let project = dir.path().to_string_lossy().into_owned();
        let abs = file.to_string_lossy().into_owned();
        for spelling in [
            format!("'{abs}'"),
            format!("\"{abs}\""),
            abs.replace(' ', "\\ "),
            format!("file://{}", abs.replace(' ', "%20")),
            "my shot.png".to_string(),
        ] {
            assert_eq!(
                media_path_from_paste(&spelling, &project).as_deref(),
                Some(file.as_path()),
                "{spelling}"
            );
        }
        assert_eq!(media_path_from_paste("not a path", &project), None);
    }

    /// A stored attachment backed by a real temp file.
    pub(crate) fn attachment(
        dir: &Path,
        name: &str,
        kind: AttachmentKind,
        mime: &str,
    ) -> Attachment {
        let path = dir.join(name);
        std::fs::write(&path, b"media-bytes").unwrap();
        Attachment {
            kind,
            mime: mime.into(),
            name: name.into(),
            path: path.to_string_lossy().into_owned(),
            bytes: 11,
        }
    }

    pub(crate) fn test_model() -> ModelInfo {
        ModelInfo {
            api: Default::default(),
            id: "m".into(),
            name: "Test Model".into(),
            api_id: "m".into(),
            provider_id: "p".into(),
            capabilities: Default::default(),
            cost: Default::default(),
            limits: Default::default(),
            status: crate::catalog::ModelStatus::Active,
            headers: Default::default(),
            options: Default::default(),
            reasoning_options: Vec::new(),
            reasoning_stream_field: None,
            compat: Default::default(),
        }
    }

    #[test]
    fn models_accept_what_their_modalities_list() {
        let mut model = test_model();
        assert!(!model_accepts(&model, AttachmentKind::Image));
        model.capabilities.vision = true;
        assert!(model_accepts(&model, AttachmentKind::Image), "vision flag");
        model.capabilities.input_modalities = vec!["text".into(), "audio".into(), "file".into()];
        assert!(model_accepts(&model, AttachmentKind::Audio));
        assert!(
            model_accepts(&model, AttachmentKind::Pdf),
            "OpenRouter `file`"
        );
        assert!(!model_accepts(&model, AttachmentKind::Video));
        assert!(
            !model_accepts(&model, AttachmentKind::Image),
            "listed modalities win"
        );
    }
}
