<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/agente-code-lockup-on-dark.svg" />
    <img src="assets/brand/agente-code-lockup-on-light.svg" alt="Agente Code" height="72" />
  </picture>
</p>

<p align="center">
  <strong>A keyboard-first coding agent for your terminal, written in Rust.</strong><br />
  Any model, any provider — with subagents, skills, MCP, tabs and real cost tracking.
</p>

---

## Why Agente Code

- **Your models, your keys.** 45+ built-in providers — OpenRouter, OpenCode Go, DeepSeek, Z.AI/GLM, MiniMax, Kimi, Qwen, OpenAI, Groq, Mistral, xAI, local Ollama / LM Studio — plus any OpenAI-, Anthropic- or Gemini-compatible endpoint.
- **A calm, fast TUI.** One consistent look for every list and dialog, hover and click everywhere, eased scrolling, light and dark themes, and nothing on screen you did not ask for.
- **An agent core built for long work.** Parallel tools, background subagents in isolated git worktrees, automatic compaction, prompt caching on every provider that supports it.
- **Honest numbers.** The status row shows what you really spent and how much of your prompt came from cache — the provider's own charge when it reports one, marked as an estimate when it does not.

## Features

| | |
|---|---|
| **Modes** | `plan` (read-only, ends with a plan you accept or revise), `build`, and `auto` (build with every tool call approved). `Shift+Tab` cycles. |
| **Subagents** | `explore`, `plan`, `general-purpose` and your own types from `.agente/agents/*.md`; up to 8 run at once, each with a live card, detail view and its own cost. |
| **Skills** | [Agent Skills](https://agentskills.io/specification) from `.agente/skills`, `.agents/skills` or `.claude/skills`. The agent picks the right one itself; `/skill-name` runs one on demand. |
| **MCP** | stdio and Streamable HTTP servers through the official Rust SDK, from `agente.json` or the project's `.mcp.json` (approved first). Read-only tools run unasked; `/mcp` shows status. |
| **Media** | Drop or paste an image, audio, video or PDF, paste a screenshot with `Ctrl+V`, or `@` a media file. Sent in each provider's native format to models that accept it — after asking you (`/settings`). |
| **Tabs** | Several sessions at once; background tabs keep working and tell you when they finish or need approval. |
| **Message queue** | Type while the agent works: `Enter` queues, `Enter` again hands it to the running turn at its next step. |
| **Sessions** | Every session is saved. Click one of your messages to **revert** (undoes the file edits since) or **fork** it into a new session. `agente --resume` reopens any session. |
| **Safety** | Approval cards with real diffs, per-tool permissions, undo/redo of file edits, secret redaction in logs and errors. |
| **Embedding** | `--acp-stdio` speaks the Agent Client Protocol for editors; `--no-tui` runs headless in CI and pipes. |

## Install

**Linux** (x86_64 and arm64), Agente Code into `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/fabricio3g/AgenteCode/main/install.sh | sh
```

With Agente Desktop too (AppImage plus an app menu entry):

```bash
curl -fsSL https://raw.githubusercontent.com/fabricio3g/AgenteCode/main/install.sh | sh -s -- --desktop
```

Other options: `--desktop-only`, `--version v0.2.0`, `--dir ~/bin`.

**Windows** (x64, PowerShell), Agente Code into `%LOCALAPPDATA%\Agente\bin`, added to your PATH:

```powershell
irm https://raw.githubusercontent.com/fabricio3g/AgenteCode/main/install.ps1 | iex
```

With Agente Desktop too (runs its installer):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/fabricio3g/AgenteCode/main/install.ps1))) -Desktop
```

Both scripts verify the download against the release's `SHA256SUMS`. Every file is also on the [Releases](https://github.com/fabricio3g/AgenteCode/releases) page.

### From source

Requirements: **Rust 1.88+**.

```bash
git clone https://github.com/fabricio3g/AgenteCode
cd AgenteCode
cargo build --release
./target/release/agente
```

On Linux, `packaging/linux/install-desktop.sh` adds an **Agente Code** launcher with its icon to your app menu (per user, no root needed).

## Quick start

```bash
agente                                   # interactive TUI in the current folder
agente -p ~/src/my-app                   # … in another project
agente "refactor the auth module"        # start with a prompt
agente --no-tui "fix the failing test"   # headless, auto-approving tools
agente --resume                          # pick a saved session to reopen
agente --resume 3f2a                     # reopen by id or unique prefix
```

1. Connect a provider with `/provider` (keys are stored in `~/.agente/auth.json`, never in config files).
2. Choose a model with `/model`, and a reasoning effort with `Ctrl+T` when the model supports it.
3. Type what you want. Use `@` to mention files, `/` for commands, `Ctrl+P` for everything else.

When you quit, Agente prints `Resume with: agente --resume <session-id>` for every open tab.

## Everyday use

| Key | Action |
|---|---|
| `Enter` | Send · while working: queue · again on an empty composer: send the queue now |
| `↑` | Previous prompt · with a queued message: edit it |
| `Shift+Tab` / `Ctrl+Tab` | Cycle plan → build → auto |
| `Esc` | Interrupt the running turn (press twice) |
| `Ctrl+P` | Command palette |
| `Ctrl+T` | Reasoning effort |
| `Ctrl+V` | Paste text, or attach a screenshot from the clipboard |
| `Ctrl+X` | Subagents |
| `Ctrl+S` | Session picker |
| `Ctrl+N` | New session |
| `F2` | New tab |
| `Ctrl+PgUp` / `Ctrl+PgDn` | Switch tabs |
| `Ctrl+O` | Open the prompt in your `$EDITOR` |
| `Ctrl+B` | Show this session's file changes |
| `PgUp` / `PgDn`, wheel | Scroll the chat |
| `?` / `F1` | All shortcuts |

Useful commands: `/settings`, `/skills`, `/mcp`, `/subagent-models`, `/compact`, `/undo`, `/redo`, `/init` (writes an `AGENTS.md` for your project), `/doctor`.

The status row under the composer reads `mode │ $spend · cache% │ context`:
`~$0.04` is an estimate from catalog prices, `$0.04+` means some calls had no known price, `free` means the provider charged nothing, and `~12k` marks a locally estimated context size.

## Configuration

Settings merge from `~/.agente/config.json` and the project's `agente.json` (the project wins). Most of them are also one keypress away in `/settings`: smart compaction, parallel subagents, reduced motion, always-approve, per-kind media permission, theme and per-subagent models. See [`agente.json.example`](agente.json.example) for every field.

### Skills

A skill is a folder with a `SKILL.md`:

```markdown
---
name: release-notes
description: Draft release notes from merged PRs. Use when the user asks for a changelog or release notes.
---
1. Run `scripts/collect.sh <tag>` to list the merged PRs.
2. …
```

Put it in `<project>/.agente/skills/` (or `.agents/skills/`, `.claude/skills/`; user-wide under `~/.agente/skills/`). The model sees each skill's name and description and loads the full instructions when a task matches. `/release-notes <request>` runs it directly; `disable-model-invocation: true` keeps a skill manual-only.

### MCP servers

```json
{
  "mcp": {
    "docs":   { "command": ["npx", "-y", "@acme/docs-mcp"] },
    "sentry": {
      "type": "http",
      "url": "https://mcp.sentry.dev/mcp",
      "headers": { "Authorization": "Bearer $SENTRY_TOKEN" }
    }
  }
}
```

Servers connect in the background and a slow one never delays a turn. Tools a server marks read-only run without asking (and in plan mode); the rest ask first unless the server has `"trust": true`. Servers declared in a project's `.mcp.json` run only after you approve them in `/mcp`.

## Project layout

| Crate | What it holds |
|---|---|
| `crates/agente-core` | Agent loop, tools, providers, permissions, subagents, skills, MCP, compaction |
| `crates/agente-tui` | The terminal UI: state, widgets, dialogs, key and mouse routing |
| `crates/agente-cli` | The `agente` binary (TUI, headless, ACP) |
| `crates/agente-{acp,runtime,session,protocol,node}` | Editor embedding, persistence, shared types, Node/Electron bindings |
| `apps/desktop` | **Agente Desktop**, the Electron app: chat, local models, artifacts, voice and the Code section ([its README](apps/desktop/README.md)) |

Per project, Agente keeps its data in `.agente/`: saved plans (`plans/`), subagent worktrees, custom commands, agents and skills.

## Development

```bash
cargo check                     # must stay at zero warnings
cargo test --workspace
cargo clippy --workspace --all-targets
```

Agente Desktop has its own toolchain; run `npm install` and `npm run dev` inside `apps/desktop`. CI runs the Rust and Desktop jobs only when their folders change.

[AGENTS.md](AGENTS.md) documents the architecture, the design decisions behind the UI and the full keyboard map — read it before a larger change.

Brand assets live in `assets/brand/` (icon sizes, `favicon.ico`, lockups for dark and light backgrounds) and are generated by `crates/agente-tui/examples/gen_brand.rs`. The wordmark is outlined from [Space Grotesk](https://github.com/floriankarsten/space-grotesk) Medium (SIL Open Font License 1.1), so the SVGs embed no font.

## License

[MIT](LICENSE)
