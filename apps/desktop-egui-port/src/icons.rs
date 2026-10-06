//! Icon font + bundled typefaces.
//!
//! Ports the Lucide set (`lucide-svelte`) to Phosphor regulars, the closest
//! feather-style outline match, plus the bundled OFL faces Electron uses:
//! Inter Variable for chrome and prose, IBM Plex Mono for code.

use egui::{Context, FontData, FontDefinitions, FontFamily};

pub use egui_phosphor::regular::{
    ARROW_CLOCKWISE as ICON_RETRY, ARROW_LEFT as ICON_BACK, ARROW_UP as ICON_UP,
    ARROWS_CLOCKWISE as ICON_SYNC, BELL as ICON_BELL, BROWSER as ICON_BROWSER,
    CARET_DOWN as ICON_CARET, CHAT_CIRCLE as ICON_CHAT, CHECK as ICON_CHECK,
    CLIPBOARD_TEXT as ICON_CLIPBOARD, CODE as ICON_CODE, COPY as ICON_COPY,
    DICE_FIVE as ICON_DICE, DOTS_THREE as ICON_MORE, DOWNLOAD_SIMPLE as ICON_DOWNLOADS,
    FILE_TEXT as ICON_FILE, FOLDER as ICON_FOLDER, GEAR as ICON_SETTINGS,
    GIT_BRANCH as ICON_BRANCH, GLOBE as ICON_GLOBE, HOUSE as ICON_HOME,
    IMAGE as ICON_IMAGE, INFO as ICON_INFO, LIST_CHECKS as ICON_TODOS,
    MAGNIFYING_GLASS as ICON_SEARCH, MASK_HAPPY as ICON_ROLEPLAY, MICROPHONE as ICON_MIC,
    MOON as ICON_MOON, PAPER_PLANE_TILT as ICON_SEND, PAPERCLIP as ICON_ATTACH,
    PENCIL as ICON_EDIT, PLAY as ICON_PLAY, PLUS as ICON_PLUS, PUZZLE_PIECE as ICON_ARTIFACT,
    QUESTION as ICON_HELP, ROBOT as ICON_BOTS, SIDEBAR as ICON_SIDEBAR,
    SLIDERS as ICON_SLIDERS, SPARKLE as ICON_SPARKLE, SQUARE as ICON_STOP,
    SUN as ICON_SUN, TERMINAL as ICON_TERMINAL, CPU as ICON_CPU, TRASH as ICON_DELETE, WRENCH as ICON_WRENCH,
    USERS as ICON_CAST, WARNING as ICON_WARN, X as ICON_CLOSE,
};

const INTER: &[u8] = include_bytes!("../assets/fonts/Inter.ttf");
const INTER_BOLD: &[u8] = include_bytes!("../assets/fonts/Inter-Bold.ttf");
const PLEX_REGULAR: &[u8] = include_bytes!("../assets/fonts/IBMPlexMono-Regular.ttf");
const PLEX_BOLD: &[u8] = include_bytes!("../assets/fonts/IBMPlexMono-Bold.ttf");

/// Installs Inter, IBM Plex Mono and the Phosphor icon font. Falls back to
/// the built-in faces for anything they do not cover.
pub fn install(ctx: &Context) {
    let mut defs = FontDefinitions::default();
    defs.font_data.insert(
        "inter".to_owned(),
        FontData::from_static(INTER).into(),
    );
    defs.font_data.insert(
        "plex".to_owned(),
        FontData::from_static(PLEX_REGULAR).into(),
    );
    defs.font_data.insert(
        "plex-bold".to_owned(),
        FontData::from_static(PLEX_BOLD).into(),
    );
    defs.font_data.insert(
        "inter-bold".to_owned(),
        FontData::from_static(INTER_BOLD).into(),
    );
    defs
        .families
        .insert(FontFamily::Name("bold".into()), vec!["inter-bold".to_owned()]);
    if let Some(proportional) = defs.families.get_mut(&FontFamily::Proportional) {
        proportional.insert(0, "inter".to_owned());
    }
    if let Some(monospace) = defs.families.get_mut(&FontFamily::Monospace) {
        monospace.insert(0, "plex".to_owned());
        monospace.insert(1, "plex-bold".to_owned());
    }
    egui_phosphor::add_to_fonts(&mut defs, egui_phosphor::Variant::Regular);
    ctx.set_fonts(defs);
}
