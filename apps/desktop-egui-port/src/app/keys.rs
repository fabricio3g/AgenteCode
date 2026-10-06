//! Global keyboard handling. Ports `AppShell.svelte`'s key handler plus the
//! TUI's shortcut table, so the same chord does the same thing here.
//!
//! Chords are consumed with `InputState::consume_shortcut`, which marks them
//! handled so a focused text field never sees them twice.

use egui::{Context, Key, KeyboardShortcut, Modifiers};

use crate::app::commands;
use crate::backend::AgentMode;
use crate::state::overlays::PaletteMode;

use super::DesktopApp;

/// Handles every global chord. Returns true when one was consumed.
pub fn handle(app: &mut DesktopApp, ctx: &Context) -> bool {
    let mut consumed = false;

    // Escape closes the topmost overlay first, then stops a running turn.
    if ctx.input_mut(|input| input.consume_key(Modifiers::NONE, Key::Escape)) {
        if app.overlays.escape() {
            return true;
        }
        if app.engine.running() {
            app.stop_turn();
            return true;
        }
        if app.nav.settings_open {
            app.nav.close_settings();
            return true;
        }
    }

    // Palette.
    if chord(ctx, Modifiers::COMMAND, Key::P) {
        app.overlays.palette = Some(commands::palette());
        return true;
    }
    // New chat.
    if chord(ctx, Modifiers::COMMAND, Key::N)
        || chord(ctx, Modifiers::COMMAND, Key::K)
    {
        commands::run(app, "new", "");
        return true;
    }
    // Chat search.
    if chord(
        ctx,
        Modifiers {
            command: true,
            shift: true,
            ..Default::default()
        },
        Key::K,
    ) {
        app.overlays.chat_search = Some(Default::default());
        return true;
    }
    // Settings.
    if chord(ctx, Modifiers::COMMAND, Key::Comma) {
        app.nav.toggle_settings();
        return true;
    }
    // Sidebar.
    if chord(ctx, Modifiers::COMMAND, Key::B) {
        app.dock_changes = !app.dock_changes;
        consumed = true;
    }
    // Clear conversation.
    if chord(ctx, Modifiers::COMMAND, Key::L) {
        commands::run(app, "clear", "");
        return true;
    }
    // Subagents.
    if chord(ctx, Modifiers::COMMAND, Key::X) {
        commands::run(app, "subagents", "");
        return true;
    }
    // Artifact studio.
    if chord(ctx, Modifiers::COMMAND, Key::Backtick) {
        commands::run(app, "studio", "");
        return true;
    }
    // Export.
    if chord(ctx, Modifiers::COMMAND, Key::E) {
        commands::run(app, "export", "");
        return true;
    }
    // Session picker.
    if chord(ctx, Modifiers::COMMAND, Key::S) {
        app.overlays.session_picker = Some(Default::default());
        return true;
    }
    // Help.
    if chord(ctx, Modifiers::COMMAND, Key::Slash) || ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::F1)) {
        app.overlays.help = !app.overlays.help;
        return true;
    }
    // Rename.
    if ctx.input_mut(|input| input.consume_key(Modifiers::NONE, Key::F2)) {
        app.start_rename();
        return true;
    }
    // Mode cycle.
    if chord(
        ctx,
        Modifiers {
            shift: true,
            ..Default::default()
        },
        Key::Tab,
    ) {
        app.code.mode = app.code.mode.toggle();
        app.engine.set_mode(app.code.mode);
        app.toast(format!("{} mode", app.code.mode.label()));
        return true;
    }
    // Model picker.
    if chord(ctx, Modifiers::COMMAND, Key::M) {
        app.open_model_picker();
        return true;
    }
    // Jump to the newest message.
    if chord(
        ctx,
        Modifiers {
            shift: true,
            ..Default::default()
        },
        Key::G,
    ) {
        app.scroll_to_bottom = true;
        consumed = true;
    }
    // Quit.
    if chord(ctx, Modifiers::COMMAND, Key::Q) {
        app.quit_requested = true;
        return true;
    }

    // Palette navigation happens while it owns the keyboard.
    if app.overlays.palette.is_some() {
        palette_keys(app, ctx);
        return true;
    }
    consumed
}

/// Enter / arrows inside the palette or the model picker.
fn palette_keys(app: &mut DesktopApp, ctx: &Context) {
    let (up, down, enter, tab) = ctx.input_mut(|input| {
        (
            input.consume_key(Modifiers::NONE, Key::ArrowUp),
            input.consume_key(Modifiers::NONE, Key::ArrowDown),
            input.consume_key(Modifiers::NONE, Key::Enter),
            input.consume_key(Modifiers::NONE, Key::Tab),
        )
    });
    let Some((mode, query, index)) = app
        .overlays
        .palette
        .as_ref()
        .map(|palette| (palette.mode, palette.query.clone(), palette.index))
    else {
        return;
    };
    let rows = match mode {
        PaletteMode::Commands => commands::filtered(&query).len(),
        PaletteMode::Models => app.model_choices().len(),
    };
    if rows == 0 {
        return;
    }
    let mut index = index.min(rows - 1);
    if up {
        index = index.saturating_sub(1);
    }
    if down || tab {
        index = (index + 1).min(rows - 1);
    }
    if let Some(palette) = app.overlays.palette.as_mut() {
        palette.index = index;
    }
    if !enter {
        return;
    }
    match mode {
        PaletteMode::Commands => {
            if let Some(command) = commands::filtered(&query).get(index) {
                let id = command.id;
                app.overlays.palette = None;
                commands::run(app, id, "");
            }
        }
        PaletteMode::Models => {
            if let Some(model) = app.model_choices().get(index).cloned() {
                app.overlays.palette = None;
                app.set_model(&model);
            }
        }
    }
}

/// True when the chord was pressed and not already consumed.
fn chord(ctx: &Context, modifiers: Modifiers, key: Key) -> bool {
    ctx.input_mut(|input| input.consume_shortcut(&KeyboardShortcut::new(modifiers, key)))
}

/// Mode label used by the status row, so keys and the strip agree.
pub fn mode_label(mode: AgentMode) -> &'static str {
    mode.label()
}
