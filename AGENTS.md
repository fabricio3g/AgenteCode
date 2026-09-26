# Agente — Project Context

## Goal

Build a development-engineer tool: a keyboard-first terminal coding agent (Rust) with a clean, minimal TUI, backed by a robust agent core (parallel tools, subagents, compaction, prompt caching) and a path toward editor embedding (ACP / Electron).

## Instructions

- Remove all duplications in UI code
- Implement proper scroll handling
- No harsh borders, no bright colors — use subtle, adaptive colors
- Keep the chat display free of "assistant"/"user" labels — icons only
- Keep the UI clean and minimal
- Keyboard-first design
- Every change compiles with zero warnings; tests stay green

## Design decisions

- **Owned spans**: `Span<'static>` with helper `s(text, style)` to avoid lifetime issues
- **No borders on popups**: dialogs are floating panels on `BG_PANEL`; centered settings dialogs share `widgets::{modal_card, modal_footer}`
- **Dark/light theme**: `/theme` toggles; all widgets route colors through `style.rs` accessors; the syntect theme follows the app theme
- **Custom markdown parser**: headings, bold, italic, code, lists, rules, tables, task lists, strikethrough
- **One list look**: every picker renders through `widgets::pick::pick_list` (`›` accent marker + `BG_ACTIVE` band + bold label, `◈` for the item in effect, dim group headers) and filters through `pick::search_field`; key hints always use `footer_hints` grammar (`Ctrl+X action · Esc close`)
- **Hit map + hover**: widgets register interactive rects in `state.ui.hits` while painting; hovering a list row selects it, clicking selects + sends Enter; buttons lift to `BG_HOVER`; chat cards get a post-paint `hover_tint` (hover never enters render cache keys); pointer moves repaint only when `pointer_fingerprint` changes
- **Eased scrolling**: wheel / Ctrl+↑↓ / PageUp/Down go through `glide_by` (45% of the remaining distance per frame); `reduce_motion` in config snaps instead
- **Manual word-wrapping** via `wrap_line()` (never `Wrap` on `Paragraph`) to avoid scroll bugs
- **Syntax highlighting**: `syntect` via `syntax_highlight.rs` for code blocks
- **Transcript grammar**: uniform `◆ Run <verb> <subject>` tool rows, `◇` collapsed thoughts with a one-line preview, `∴` activity line, `Worked for Ns` turn footer, `┃` error rails, rounded composer with `model · mode` on the bottom border; the mode also shows in the top header
- **Tool execution modes**: read/grep/list run in parallel; write/edit/shell run sequential; one `Sequential` tool forces the whole batch sequential
- **Cancel channel**: abort signals let Escape interrupt actually abort the LLM task; the stop button works even while a modal owns the screen
- **Tool result truncation**: shell=500 lines, read=2000 lines, grep=200 chars/line, list=500 entries
- **Two-phase compaction**: first truncates tool results, then drops old messages; provider-reported context overflow triggers forced compaction + retry (max 2 per turn); manual `/compact` always forces
- **System message concatenation**: mode restrictions are appended to the system prompt, never a separate message
- **Categorized errors**: API errors show actionable messages with `/compact`, `/model`, `/provider` hints
- **Subagents**: `task` / `task_output` / `kill_task` hosted tools routed to `SubagentHost`; built-ins `general-purpose` / `explore` / `plan` plus custom types from `.agente/agents/*.md`; capability modes enforced at the registry level; children run unbounded (the wall-clock watchdog is the backstop) in isolated git worktrees; parent + child approvals route by `request_id` via `ApprovalBroker`
- **Loop guard**: identical tool-call signatures nudge after 3 repeats, hard-stop after 6 with a visible notice

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+C`, `Ctrl+D` | Quit |
| `Ctrl+P` | Command palette |
| `Ctrl+L` | Clear conversation |
| `Ctrl+O` | Open external editor |
| `Ctrl+B` | Show session changes in chat |
| `Ctrl+S` | Session picker |
| `Ctrl+X` | View subagents |
| `Ctrl+A` | Move cursor to start |
| `Ctrl+E` | Move cursor to end |
| `Ctrl+K` | Kill to end of line |
| `Ctrl+U` | Kill to start of line |
| `Ctrl+W` | Delete word backward |
| `Escape` | Interrupt (double-press) |
| `Tab` | Autocomplete slash commands |
| `Shift+Tab` | Toggle plan/build mode |
| `PageUp/PageDown` | Scroll chat |
| `Shift+Up/Down` | Scroll chat 1 line |
| `Ctrl+Up/Down` | Scroll chat 5 lines |
| `Shift+G` | Scroll to bottom (auto-scroll) |
| `Shift+Home` | Scroll to top |
| `Ctrl+N` | New session |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Toggle plan/build mode |
| `?` / `F1` | Help overlay |

## Layout

- `crates/agente-core` — agent loop, tools, providers, permissions, subagents, context/compaction
- `crates/agente-tui` — terminal UI (`app/` run loop, `state/`, `widgets/`, dialogs, `ui_harness.rs`)
- `crates/agente-cli` — `agente` binary (TUI + headless)
- `crates/agente-{acp,runtime,session,protocol,node}` — embedding, persistence, Electron/Node surfaces
- `<project>/agente.json` — project config (`agente.json.example` is the template); `<project>/.agente/` — sessions, worktrees, commands, agents, skills

## Visual harness (`crates/agente-tui/src/ui_harness.rs`)

Test-only module rendering the composed frame for a catalogue of realistic app states. Rules worth keeping: clamp every dialog row with `widgets::centered_panel` / `panel_row` (a size preference is not a promise); `panel_bg` = `Clear` plus a background `Block`; chrome glyphs must be single-width; floating dialogs render into the content rect, never the whole frame.

## Known gaps

- Two turn engines remain: the TUI runs `agente_core::agent::channel`, `--no-tui` / `--acp-stdio` run `RuntimeSupervisor`. Converging them is a separate piece of work.
- Connect *dialog* end-to-end with a real key entered through the UI (the headless provider path is verified)
- Approval flow hooks for security plugins
- fsnotify-based file-change detection + write-conflict guard
- MCP adapter cache: children rebuild adapters per spawn under one mutex
- Electron bindings expansion (streaming/turn surface for agente-node)
- Image paste / desktop attention notifications

## Relevant files

- `crates/agente-tui/src/style.rs` — unified style system (dark/light themes, colors, helpers)
- `crates/agente-tui/src/app/` — `mod` (run loop), `keys`, `mouse`, `commands`, `chat_turn`, `render`, `agent_events`
- `crates/agente-tui/src/state/` — `agent`, `session`, `ui`, `input`, `config`, `picker`, `plan_review`, `todo`
- `crates/agente-tui/src/widgets/` — chat, input, approval, diff_view, hints, welcome
- `crates/agente-tui/src/connect.rs`, `model_selector.rs`, `command_palette.rs`, `session_picker.rs`, `slash_command.rs`, `at_file_picker.rs`, `syntax_highlight.rs`
- `crates/agente-core/src/agent/channel/` — agent loop, tool batching, hosted-tool interception, retry, loop detection
- `crates/agente-core/src/subagent/` — `types`, `definition`, `context`, `registry`, `host`, `worktree`
- `crates/agente-core/src/tools/` — registry, typed tools, execution modes, truncation
- `crates/agente-core/src/permissions.rs` — `ApprovalBroker` (request_id-routed approvals)
- `crates/agente-core/src/context/` — system prompts (dynamic tool list), compaction
- `crates/agente-core/src/providers/` — provider implementations

## Build commands

```bash
cargo check                          # Quick check (zero warnings expected)
cargo build --package agente-tui    # Build TUI library
cargo build --release                # Build full release binary
```

## Running

```bash
./target/release/agente.exe --help
./target/release/agente.exe "your prompt here"
```
