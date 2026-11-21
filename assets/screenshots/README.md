# README screenshots

These screenshots show the Agente Code UI at version `0.3.0` using mock fixtures rather than live provider calls. Unframed versions of the same captures are stored in `site/assets/` for the project website.

| File | Surface | Source |
|---|---|---|
| `desktop.png` | Home: board pack prompt answered with three downloadable file cards | Renderer mock (`?mock=1`), **Board pack for Q3** |
| `desktop-code.png` | Code: pending edit confirmation (`"Allow this edit?"`) above the composer with inline diff | Renderer mock (`?mock=1`), **demo-app** conversation: `"Add a verbose flag to boot"` |
| `terminal.png` | Terminal: plan output followed by the docked edit approval card and diff | TUI visual harness, `approval_edit_diff` |

## Refreshing the captures

For Desktop, start the Vite renderer dev server after installing dependencies in `apps/desktop` and `apps/desktop/renderer`:

```bash
cd apps/desktop/renderer
npx vite --host 127.0.0.1 --port 5178 --strictPort
```

Open `http://127.0.0.1:5178/?mock=1` in dark theme with `localStorage.chatealm_locale = 'en'` at a **1440 × 900** viewport (device scale factor `1.5`, producing `2160 × 1350` unframed captures):

1. **Home (`desktop.png` / `site/assets/desktop-home.webp`):** open the **Board pack for Q3** conversation showing the generated report, presentation, and spreadsheet file cards.
2. **Code (`desktop-code.png` / `site/assets/desktop-code.webp`):** open the **demo-app** conversation in the Code workspace with `"Allow this edit?"` above the composer and the diff visible in the transcript.

For Terminal, run the TUI visual harness from the repository root:

```bash
CARGO_BUILD_JOBS=2 AGENTE_UI_THEME=dark cargo test -p agente-tui -j 2 ui_gallery_writes_screenshots -- --test-threads=1
```

Open `crates/agente-tui/target/ui-shots/gallery.html` and capture the `approval_edit_diff` scenario frame for `assets/screenshots/terminal.png` (and the welcome scenario for `site/assets/terminal-welcome.webp`).

## Framing parameters

The README PNGs composite the window capture onto a neutral gray backdrop so they remain legible on both dark and light GitHub themes:

- **Desktop (`desktop.png`, `desktop-code.png`):** 1400 px window width, 88 px padding, **1576 × 1051** output size.
- **Terminal (`terminal.png`):** 940 px window width under a 30 px title bar with gray window controls, 72 px padding, **1084 × 790** output size.
- **Corner radius:** 16 px.
- **Shadow:** `0 30px 65px -14px rgba(0, 0, 0, .38)`.
- **Backdrop:** radial highlight over `linear-gradient(135deg, #dedede 0%, #bebebe 55%, #969696 100%)`.

Keep all captures free of credentials, personal conversations, and machine-specific paths.
