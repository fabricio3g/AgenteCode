# README screenshots

These images show Agente's UI at the `0.2.2` release-candidate stage, using
development fixtures rather than private conversations or live provider calls.

| File | Surface | Source |
|---|---|---|
| `desktop.png` | Home chat with a web artifact preview | Renderer browser harness, `chat-artifacts` |
| `desktop-code.png` | Code approval with the Changes dock | Renderer browser harness, scripted supervised Code turn |
| `bots.png` | Colina, a handoff to Scout, and scheduled routines | Renderer browser harness, Bots screen |
| `terminal.png` | Terminal conversation, markdown, and tool receipts | TUI visual harness, `chat_markdown_and_tools`, `120x40` |

## Refreshing the captures

For Desktop, start the renderer with installed desktop and renderer dependencies:

```bash
cd apps/desktop/renderer
npx vite --host 127.0.0.1 --port 5178 --strictPort
```

Open `http://127.0.0.1:5178/?mock=1` in a fresh browser profile. Set
`localStorage.chatealm_locale` to `en` and reload for English labels. Capture
the dark UI at **1400 × 920** after fonts and panels have settled:

1. Home: select **Q3 launch plan** and open **Launch landing page**.
2. Code: start a conversation in **demo-app**, select supervised mode, send a
   startup-logging request, and open **Changes** when the approval appears.
3. Bots: select **Colina** with the **Routines** panel open.

For the terminal, generate the current visual gallery from the repository root:

```bash
CARGO_BUILD_JOBS=2 AGENTE_UI_THEME=dark cargo test -p agente-tui -j 2 ui_gallery_writes_screenshots -- --test-threads=1
```

Open `crates/agente-tui/target/ui-shots/gallery.html` with
`?scenario=chat_markdown_and_tools&size=120x40` and capture only the terminal
frame. The README capture uses a neutral window title and gray title-bar dots;
the TUI content is rendered directly by the harness.

## Presentation

The gray background is baked into each PNG so it works on GitHub in either
theme, without relying on README CSS:

- Desktop: 88 px padding, **1576 × 1096** final size.
- Terminal: 72 px padding, **1084 × 772** final size.
- Window corners: 16 px radius.
- Shadow: `0 30px 65px -14px rgba(0, 0, 0, .38)`.
- Background: a soft white radial highlight over
  `linear-gradient(135deg, #dedede 0%, #bebebe 55%, #969696 100%)`.

Keep captures free of real credentials, personal chats, and machine-specific
paths. Changes to screenshot presentation do not require changes to app styles.
