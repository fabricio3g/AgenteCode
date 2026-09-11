<p align="center">
  <img src="assets/hero.svg" alt="Agente — real ceibo blooms rendered in diamond glyphs" width="100%" />
</p>

<p align="center">
  <em>A keyboard-first terminal coding agent in Rust — clean minimal TUI, robust agent core, editor embedding on the horizon.</em>
</p>

## Features

- **Keyboard-first TUI** — command palette, slash commands, `@`-file mentions, saved sessions, plan/build modes
- **Robust agent core** — parallel tool execution, subagents with approval routing, compaction, prompt caching
- **10 providers** — popular, local and custom OpenAI-compatible endpoints, with per-project config
- **ACP + headless** — embed via the Agent Client Protocol, or run `--no-tui` in CI/pipes
- **Safe by default** — approval cards with real diffs, plan mode, undo/redo, secret redaction

## Quick start

```bash
cargo build --release
./target/release/agente            # interactive TUI
./target/release/agente "refactor the auth module"   # one-shot prompt
./target/release/agente --no-tui "fix the failing test"  # headless
```

Connect a provider on first run with `/provider`, pick a model with `/model`.

| Key | Action |
|-----|--------|
| `Ctrl+P` | Command palette |
| `Ctrl+C` | Quit |
| `Tab` | Autocomplete slash commands |
| `Shift+Tab` | Toggle plan / build mode |
| `Esc` | Interrupt the running turn |
| `?` / `F1` | Help overlay |

## Layout

- `crates/agente-core` — agent loop, tools, providers, permissions, subagents
- `crates/agente-tui` — terminal UI (widgets, dialogs, key/mouse routing)
- `crates/agente-cli` — `agente` binary (TUI + headless)
- `crates/agente-{acp,runtime,session,protocol,node}` — embedding, persistence, Electron/Node surfaces

See [AGENTS.md](AGENTS.md) for architecture notes, keyboard map and build commands.

## License

MIT

---
<sub>Hero photo: ceibo blooms (<i>Erythrina crista-galli</i>) by <a href="https://commons.wikimedia.org/wiki/File:Erythrina_crista-galli_1z_01.jpg">Anish nellickal</a>, CC BY-SA 4.0, rendered in Diamond Glyphs style.</sub>
