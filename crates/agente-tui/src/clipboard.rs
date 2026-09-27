//! One system clipboard for the whole session.
//!
//! On Linux the copying program serves the clipboard's contents itself, so a
//! `Clipboard` created per copy and dropped right away both lost the text
//! (clipboard managers never saw it) and made arboard print a warning straight
//! to stderr — over the TUI, where it corrupted the screen. Keeping a single
//! instance alive for the process fixes both.

use std::sync::{Mutex, OnceLock};

fn shared() -> &'static Mutex<Option<arboard::Clipboard>> {
    static CLIPBOARD: OnceLock<Mutex<Option<arboard::Clipboard>>> = OnceLock::new();
    CLIPBOARD.get_or_init(|| Mutex::new(None))
}

fn with_clipboard<T>(
    f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, arboard::Error> {
    let mut guard = shared().lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        *guard = Some(arboard::Clipboard::new()?);
    }
    let result = f(guard.as_mut().expect("clipboard just initialized"));
    if result.is_err() {
        // A dead connection (display server restarted) is rebuilt next time.
        *guard = None;
    }
    result
}

/// Put `text` on the system clipboard.
pub fn copy(text: &str) -> Result<(), arboard::Error> {
    with_clipboard(|c| c.set_text(text))
}

/// Read text from the system clipboard.
pub fn paste() -> Result<String, arboard::Error> {
    with_clipboard(|c| c.get_text())
}

/// An image on the clipboard (a screenshot), as PNG bytes. `Ok(None)` when
/// the clipboard holds no image.
pub fn paste_image_png() -> anyhow::Result<Option<Vec<u8>>> {
    let image = match with_clipboard(|c| c.get_image()) {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, image.width as u32, image.height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(&image.bytes)?;
    }
    Ok(Some(png))
}
