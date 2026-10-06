# desktop-egui-port — Agente Desktop as a native egui app

A 1:1 port of `apps/desktop` (Electron + Svelte + TypeScript) to native Rust
with [egui](https://www.egui.rs/) / `eframe`. Electron is untouched; every new
file lives under `apps/desktop-egui-port/`.

Run it without Electron running:

```bash
cargo run -p desktop-egui --bin agente-desktop-egui
```

## The engine is the core, not a reimplementation

A turn is one `agente_core::agent::spawn_chat_task` (`src/backend/engine.rs`),
which is the same loop the TUI runs. That is why the port gets provider specs
and transport policy, prompt caching, thinking profiles, parallel/sequential
tool batching, the approval broker, subagents, compaction with before/after
tokens, loop detection, spend accounting and MCP servers without a second
implementation. The UI only starts turns, drains `AgentEvent`s into transcript
rows (`src/app.rs`) and answers approvals through the broker.

Config is shared too: providers, API keys, default model, thinking level and
project settings live in `~/.agente/config.json` plus the project's
`agente.json`. A key added in Settings here is the key the terminal agent uses.
Only window preferences (theme, text size, sidebar) live in
`~/.agente/desktop-egui.json`.

## Electron → egui map

| Electron | egui port |
|---|---|
| `App.svelte` + `layout/AppShell.svelte` | `src/views/shell.rs` + `src/app.rs` |
| `layout/ActivityRail.svelte` (52px strip, settings at bottom) | rail panel in `shell.rs` + `widgets::rail_button` |
| `layout/Sidebar.svelte` (240px, New row, artifacts toggle, search, date groups, footer) | `src/views/sidebar.rs` |
| `layout/Titlebar.svelte` (36px, sidebar toggle, downloads + theme right) | titlebar panel in `shell.rs` |
| `layout/PanelTabs.svelte` | `strip()` in `shell.rs` (space description, Plan/Build + Auto, dock doors) |
| `WorkspaceHost` right/bottom docks | right dock panel in `shell.rs` (search, browser, canvas) |
| `spaces.ts` (home/code/roleplay + bots) | `Space` in `src/state.rs` (same four) |
| `features/chat/thread/*` (48rem column, right bubbles, plain assistant prose) | `src/views/thread.rs` + `widgets::{user_bubble, assistant_prose}` |
| `features/chat/Composer.svelte` (pill card, ring, two rows, mode tabs, suggestions) | `src/views/composer.rs` + `src/views/home.rs` |
| `features/code/*` + `services/agent-*.ts` | `src/views/code.rs` + the engine in `src/backend/engine.rs` |
| `features/artifacts/*` (homeView toggle) | `src/views/artifacts.rs` via `HomeView` |
| `features/bots/*` + daemon bots/routines/telegram | `src/views/bots.rs` (daemon client in `src/backend.rs`) |
| `features/canvas/*` | `src/views/canvas.rs` (dock) |
| `features/home/*` | `src/views/home.rs` |
| `features/roleplay/*` | `src/views/roleplay.rs` |
| `components/search/*` drawer | `src/views/search.rs` (dock) |
| `components/settings/*` screen over workspace | `src/views/settings.rs` + `DesktopConfig` in `src/backend.rs` |
| `components/onboarding/*` | `src/views/onboarding.rs` |
| `components/browser/*` panel | `src/views/browser.rs` (dock; full embedding deferred) |
| titlebar `DownloadsButton` | `src/views/downloads.rs` modal |
| `main/*` IPC handlers, `preload.cjs`, `shared/*` | gone — the app calls `agente-core` / `agente-protocol` / `agente-session` directly |
| `main/agente/*` (the Electron agent) | `src/backend/engine.rs` (the core loop, no Node hop) |
| `stores/*.svelte.ts` + `AgentState` | `src/state/mod.rs`: `Session` holds the core `conversation`, the painted `entries`, approvals, spend, todos, changed files and subagent cards |
| `components/ui/*` | `src/widgets.rs` |
| `app.css` tokens (dark-first `#161616`, monochrome + `#e76d1f`/`#e8793a`, 15/14/13/12 type ladder, 48rem thread, 24px pills) | `src/style.rs` (`ThemeTokens::of`, `apply_type_scale`, `geom`) |

## Comparing against the real Electron UI

`docs/reference/` holds 1x screenshots of the Electron renderer (its `?mock=1`
bridge) plus `compare-home.png`, a side-by-side of the reference and this port.
They were captured with puppeteer against the running renderer:

```bash
cd apps/desktop/renderer && npx vite --port 5173     # renderer only, no Electron
node ../../.agente/scratch/electron-shots.mjs         # writes docs/reference/*.png
```

Measured against those shots, the shell now lines up: rail 52px with 36px
buttons on a 40px pitch, sidebar 240px with 30px rows inset 4px, content
starting at 292 with a 48rem column centred in it, panel separators `#363637`,
the composer card 766x92px with its hint line, user bubbles `#222222`
right-aligned at 14px radius, and the step rows indented 20px per level.

## Style: egui's own model, Electron's numbers

`src/style.rs` installs one `Style` for both egui themes and pins the app's
theme with `Context::set_theme`, so the OS preference never overrides it:

- `Visuals` per theme (`Visuals::dark` / `light`) with the exact CSS tokens:
  page `#161616`, card `#1e1e1e`, sidebar `#0f0f10`, rail `#252525`, hairlines
  `#292929`, one brand orange `#e8793a` for focus only.
- `Spacing` on an 8px rhythm: `item_spacing` 8/6, `button_padding` 10/5,
  `interact_size.y` 26, `ScrollStyle` floating with a 6px dormant bar that
  brightens on hover (egui's `ScrollStyle::thin` preset, retuned).
- `text_styles`: the Electron ladder — 16 heading, 14 chrome, 13 buttons,
  12 floor, 13 monospace, all multiplied by the reading scale.

Chrome rows are painted by hand (`widgets::row`) because egui buttons center
their label and Electron's rows are left-aligned with a hover band. Two-column
rows (titlebar, panel-tabs strip, dock header) use egui's documented
`containers::Sides`, and the closures return an action the caller applies,
which keeps borrows simple.

### Screenshots without a display server

The app carries its own harness: with `AGENTE_EGUI_SCREENSHOT=/tmp/out.png`
it paints a few frames, asks the backend for a screenshot and exits. Combine it
with `AGENTE_EGUI_THEME=dark|light` to pin the theme (the harness never writes
the user's config).

```bash
AGENTE_EGUI_THEME=dark AGENTE_EGUI_SCREENSHOT=/tmp/agente.png \
  cargo run -p desktop-egui --bin agente-desktop-egui
```

## What is live

Every screen below is wired to real state or to the engine; nothing is a
placeholder frame.

| Surface | State |
|---|---|
| Home chat | thread, markdown, tool rows, thoughts, compaction, errors, `Worked for Ns` footer, hover actions (copy · edit · fork · delete · retry · listen · prompt) |
| Composer | send/stop, queue rows while a turn runs, "send the queue now", slash autocomplete, `@file` mentions, media attachment chips, model chip, thinking chip, mic, context meter |
| Slash + palette | `/new`, `/search`, `/settings`, `/model`, `/provider`, `/theme`, `/plan`, `/build`, `/auto`, `/compact`, `/clear`, `/rename`, `/fork`, `/changes`, `/files`, `/plan-review`, `/processes`, `/terminal`, `/subagents`, `/artifacts`, `/studio`, `/skills`, `/mcp`, `/agents`, `/voice`, `/runtime`, `/export`, `/help`, `/quit` — the palette (Ctrl+P) and slash input share one catalog |
| Shortcuts | Ctrl+P palette · Ctrl+N/Ctrl+K new · Ctrl+Shift+K search · Ctrl+, settings · Ctrl+B changes dock · Ctrl+L clear · Ctrl+X subagents · Ctrl+\` studio · Ctrl+E export · Ctrl+S session picker · Ctrl+M model · Ctrl+Q quit · F1/? help · F2 rename · Shift+Tab mode |
| Code space | approvals (once/all/deny through the broker), changed files with diff preview, project tree, plan review (accept/redo/comment), processes with live output and stop, embedded terminal over the shell tool, todos, subagent cards, prompt inspector |
| Sessions | list grouped by day, rename, fork, delete with confirm, session picker, `--resume [id|prefix]`, resume hint on quit |
| Artifacts | library, studio with file rail, source editor, preview toggle, save |
| Bots | roster, editor (identity, model, instructions), routines with cron lines, Telegram pairing, sandbox notes |
| Roleplay | cast strip, character editor (persona, greeting, scenario, examples), lorebook, prompt inspector |
| Search / Browser | query, run as an engine turn (web tools), deep-research flag; URL fetch through `web_fetch` |
| Canvas | per-conversation board, saved to its own file |
| Downloads / Runtime | model and runtime files on disk, local runtime panel, load points the session at llama.cpp |
| Onboarding | provider, key, model, project folder, plan/build |
| Settings | theme, text size, provider + key (core config), model, thinking level, project folder, auto-approve, advanced engine facts |

Still deferred, with the UI present: dictation and playback (the STT/TTS
engines), the daemon surface for bots (the roster, routines and Telegram run
locally today), a Chromium artifact preview, and a real PTY terminal (commands
run through the core shell tool).

## Style: egui's own model, Electron's numbers

`src/style.rs` installs one `Style` for both egui themes and pins the app's
theme with `Context::set_theme`, so the OS preference never overrides it:

- `Visuals` per theme (`Visuals::dark` / `light`) with the exact CSS tokens:
  page `#161616`, card `#1e1e1e`, sidebar `#0f0f10`, rail `#252525`, hairlines
  `#292929`, one brand orange `#e8793a` for focus only.
- `Spacing` on an 8px rhythm: `item_spacing` 8/6, `button_padding` 10/5,
  `interact_size.y` 26, `ScrollStyle` floating with a 6px dormant bar that
  brightens on hover (egui's `ScrollStyle::thin` preset, retuned).
- `text_styles`: the Electron ladder — 16 heading, 14 chrome, 13 buttons,
  12 floor, 13 monospace, all multiplied by the reading scale.

Chrome rows are painted by hand (`widgets::row`) because egui buttons center
their label and Electron's rows are left-aligned with a hover band. Two-column
rows (titlebar, panel-tabs strip, dock header) use egui's documented
`containers::Sides`, and the closures return an action the caller applies,
which keeps borrows simple.

### Screenshots without a display server

The app carries its own harness: with `AGENTE_EGUI_SCREENSHOT=/tmp/out.png`
it paints a few frames, asks the backend for a screenshot and exits. Combine it
with `AGENTE_EGUI_THEME=dark|light` to pin the theme (the harness never writes
the user's config).

```bash
AGENTE_EGUI_THEME=dark AGENTE_EGUI_SCREENSHOT=/tmp/agente.png \
  cargo run -p desktop-egui --bin agente-desktop-egui
```

## What is live

Every screen below is wired to real state or to the engine; nothing is a
placeholder frame.

| Surface | State |
|---|---|
| Home chat | thread, markdown, tool rows, thoughts, compaction, errors, `Worked for Ns` footer, hover actions (copy · edit · fork · delete · retry · listen · prompt) |
| Composer | send/stop, queue rows while a turn runs, "send the queue now", slash autocomplete, `@file` mentions, media attachment chips, model chip, thinking chip, mic, context meter |
| Slash + palette | `/new`, `/search`, `/settings`, `/model`, `/provider`, `/theme`, `/plan`, `/build`, `/auto`, `/compact`, `/clear`, `/rename`, `/fork`, `/changes`, `/files`, `/plan-review`, `/processes`, `/terminal`, `/subagents`, `/artifacts`, `/studio`, `/skills`, `/mcp`, `/agents`, `/voice`, `/runtime`, `/export`, `/help`, `/quit` — the palette (Ctrl+P) and slash input share one catalog |
| Shortcuts | Ctrl+P palette · Ctrl+N/Ctrl+K new · Ctrl+Shift+K search · Ctrl+, settings · Ctrl+B changes dock · Ctrl+L clear · Ctrl+X subagents · Ctrl+\` studio · Ctrl+E export · Ctrl+S session picker · Ctrl+M model · Ctrl+Q quit · F1/? help · F2 rename · Shift+Tab mode |
| Code space | approvals (once/all/deny through the broker), changed files with diff preview, project tree, plan review (accept/redo/comment), processes with live output and stop, embedded terminal over the shell tool, todos, subagent cards, prompt inspector |
| Sessions | list grouped by day, rename, fork, delete with confirm, session picker, `--resume [id|prefix]`, resume hint on quit |
| Artifacts | library, studio with file rail, source editor, preview toggle, save |
| Bots | roster, editor (identity, model, instructions), routines with cron lines, Telegram pairing, sandbox notes |
| Roleplay | cast strip, character editor (persona, greeting, scenario, examples), lorebook, prompt inspector |
| Search / Browser | query, run as an engine turn (web tools), deep-research flag; URL fetch through `web_fetch` |
| Canvas | per-conversation board, saved to its own file |
| Downloads / Runtime | model and runtime files on disk, local runtime panel, load points the session at llama.cpp |
| Onboarding | provider, key, model, project folder, plan/build |
| Settings | theme, text size, provider + key (core config), model, thinking level, project folder, auto-approve, advanced engine facts |

Still deferred, with the UI present: dictation and playback (STT/TTS engines),
the daemon surface for bots (roster/routines/Telegram run locally), a Chromium
artifact preview, and a real PTY terminal (commands run through the core shell
tool today).

- Bots screens wired to `agente-daemon` (roster, routines, Telegram, sandbox status).
- Artifact studio: file rail, source editor, preview and run-preview window.
- Canvas and browser panels with real document state.
- Terminal pane (`egui_term`-style) instead of an external-terminal link.
- Voice: dictation and playback through the same engines the Electron app uses.
