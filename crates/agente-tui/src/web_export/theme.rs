//! Shared graphite theme tokens, terminal frame CSS, and `<head>` builder
//! for the static Visual Gallery (`web_export`) and Live Browser Studio
//! (`web_inspector`).
//!
//! Uses the same graphite canvas (`#1c1c1c`), panels (`#232323`), muted
//! neutrals (`#b3b3b3`), and single orange accent (`#e8793a`) as the TUI and
//! desktop surfaces.

/// Shared base stylesheet embedded in both the visual gallery and the live
/// browser inspector.
pub(crate) const STUDIO_BASE_CSS: &str = r##"
  :root {
    --bg-app: #1c1c1c;
    --bg-surface: #232323;
    --bg-card: #2a2a2a;
    --bg-card-hover: #323232;
    --border: #363636;
    --border-active: #e8793a;
    --fg: #e8e8e8;
    --fg-muted: #b3b3b3;
    --fg-dim: #858585;
    --primary: #e8793a;
    --primary-tint: rgba(232, 121, 58, 0.16);
    --success: #73c991;
    --warning: #e5b567;
    --error: #e06c75;
    --theme-hole: rgba(224, 108, 117, 0.45);
    --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'Courier New', monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background-color: var(--bg-app);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  /* Left sidebar */
  .studio-sidebar {
    width: 324px;
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .studio-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }

  .studio-header h1 {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.3px;
    color: var(--primary);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .studio-header p {
    font-size: 12px;
    color: var(--fg-muted);
    margin-top: 4px;
  }

  /* Main workspace column */
  .studio-workspace {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg-app);
    overflow: hidden;
  }

  .studio-toolbar {
    height: 50px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
  }

  .studio-toolbar-left, .studio-toolbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .studio-pill-group {
    display: flex;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .studio-pill {
    background: transparent;
    border: none;
    color: var(--fg-muted);
    padding: 6px 11px;
    font-size: 12px;
    cursor: pointer;
    font-weight: 500;
    transition: background 0.09s ease, color 0.09s ease;
  }

  .studio-pill:hover {
    color: var(--fg);
    background: rgba(255, 255, 255, 0.05);
  }

  .studio-pill.active {
    background: var(--primary);
    color: #1c1c1c;
    font-weight: 700;
  }

  .studio-toggle {
    background: var(--bg-card);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .studio-toggle.active {
    border-color: var(--error);
    background: rgba(224, 108, 117, 0.2);
    color: #ff9fa6;
  }

  /* Terminal stage & chrome */
  .studio-stage {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    overflow: auto;
    background: radial-gradient(circle at center, #222222 0%, #161616 100%);
    position: relative;
  }

  .terminal-frame {
    position: relative;
    box-shadow: 0 20px 52px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-app);
    outline: none;
  }

  .terminal-frame:focus {
    box-shadow: 0 20px 52px rgba(0, 0, 0, 0.65), 0 0 0 2px var(--primary);
  }

  .terminal-titlebar {
    height: 30px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
  }

  .titlebar-dots {
    display: flex;
    gap: 6px;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .dot.red { background: #ff5f56; }
  .dot.yellow { background: #ffbd2e; }
  .dot.green { background: #27c93f; }

  .titlebar-title {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--fg-muted);
  }

  .titlebar-meta {
    font-size: 11px;
    color: var(--fg-dim);
    font-family: var(--font-mono);
  }

  .terminal-screen {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.15;
    letter-spacing: 0px;
    white-space: pre;
    user-select: text;
    padding: 0;
    background: var(--bg-app);
    overflow: hidden;
  }

  .tui-row {
    display: flex;
    height: 1.15em;
  }

  .tui-span {
    display: inline-block;
    height: 100%;
    flex-shrink: 0;
  }

  .theme-hole-active .tui-span.theme-hole {
    background-color: var(--theme-hole) !important;
    outline: 1px dashed #e06c75;
    animation: pulse-hole 1.5s infinite alternate;
  }

  @keyframes pulse-hole {
    from { background-color: rgba(224, 108, 117, 0.3); }
    to { background-color: rgba(224, 108, 117, 0.7); }
  }

  /* Bottom drawer */
  .studio-drawer {
    height: 140px;
    background: var(--bg-surface);
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
  }

  .studio-drawer-header {
    padding: 7px 16px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--fg-dim);
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
  }

  .studio-drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 10px 16px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
"##;

/// Render the shared `<!DOCTYPE html>...<head>` block with the brand favicon,
/// graphite theme tokens, and any page-specific CSS rules.
pub(crate) fn studio_head(title: &str, extra_css: &str) -> String {
    let favicon = crate::brand::favicon_link();
    format!(
        "<!DOCTYPE html>\n\
         <html lang=\"en\">\n\
         <head>\n\
         <meta charset=\"UTF-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n\
         {favicon}\n\
         <title>{title}</title>\n\
         <style>{STUDIO_BASE_CSS}{extra_css}</style>\n\
         </head>\n"
    )
}
