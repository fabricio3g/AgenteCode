//! Agente Code brand bits shared by the TUI and its HTML surfaces.
//!
//! The current mark is the desktop's app icon (a white A crossed by an orbit
//! swoosh, the moon at its top right, on a black rounded tile). It exists as
//! a PNG only, so this module embeds a 64 px copy (`assets/brand/app-icon-64.png`,
//! downsampled from `apps/desktop/renderer/public/app-icon.png`); the welcome
//! card paints the same glyph in half blocks (`widgets::welcome`).

/// Product name, used for the terminal title and page titles.
pub const PRODUCT_NAME: &str = "Agente Code";

/// The app icon at 64 px, as PNG bytes.
const ICON_PNG: &[u8] = include_bytes!("../../../assets/brand/app-icon-64.png");

/// `<link rel="icon">` carrying the app icon as an inline PNG data URL, so
/// the exported gallery and the inspector page need no asset server.
pub fn favicon_link() -> String {
    format!(
        r#"<link rel="icon" type="image/png" href="data:image/png;base64,{}">"#,
        base64(ICON_PNG)
    )
}

/// Standard base64 (RFC 4648, padded). One small use does not justify a crate.
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(TABLE[((n >> shift) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn favicon_is_a_self_contained_png_data_url() {
        let link = favicon_link();
        assert!(link.starts_with(
            r#"<link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgo"#
        ));
        assert!(link.ends_with("\">"));
    }

    #[test]
    fn base64_matches_rfc_4648_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), expected);
        }
    }
}
