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
- Never add AI tools or services as commit authors or coauthors; commits use the user's Git identity

## Design decisions

- **Owned spans**: `Span<'static>` with helper `s(text, style)` to avoid lifetime issues
- **No borders on popups**: dialogs are floating panels on `BG_PANEL`; centered settings dialogs share `widgets::{modal_card, modal_footer}`
- **Dark/light theme**: `/theme` toggles; all widgets route colors through `style.rs` accessors; the syntect theme follows the app theme
- **Custom markdown parser**: headings, bold, italic, code, lists, rules, tables, task lists, strikethrough
- **One list look**: every picker renders through `widgets::pick::pick_list` (`›` accent marker + `BG_ACTIVE` band + bold label, `◈` for the item in effect, dim group headers) and filters through `pick::search_field`; key hints always use `footer_hints` grammar (`Ctrl+X action · Esc close`)
- **Running tools**: a live row shows its elapsed time and, when silent, why (`| tail` pipes print at the end); click it for the live output view (`widgets/process_view`, follows the tail, `s` stops, survives completion). The live buffer keeps the newest 32 KB. `task` spawn results are hidden behind their subagent card
- **Session tabs** (`state/tabs.rs`, `app/tabs.rs`, `widgets/tabs.rs`): several sessions open at once, each with its own agent, config (model), todos, plan, subagents, draft and scroll. The active tab lives in `AppState` so every widget is unchanged; background tabs are `TabState`s swapped in only to apply their own agent events (routed by the task ids each tab issued via `next_task_id`), so their turns keep running. The strip appears at the top once two tabs exist: number, status mark (accent `●` working, warning `◆` needs approval, success `●` finished while away), `×` on the active/hovered tab, `+`; overflow slides to keep the active tab visible. F2 / `/tab` opens one, Ctrl+PgUp/PgDn switch, `/close-tab` or `×` closes (never the last, never a working one). Quitting saves every tab and prints each resume id
- **Clipboard**: one `arboard::Clipboard` for the whole process (`clipboard.rs`) — a per-copy instance dropped at once made arboard print a warning onto the TUI (and lost the copy on Linux)
- **Message queue**: Enter while a turn runs queues the message (preview rows above the composer, no chat bubble yet); Enter again on the empty composer sends the queue *now* — it goes into the turn's `UserInbox`, the loop takes it at the next step boundary (after a tool round, or instead of finishing) and emits `UserMessagesInjected`, which turns it into bubbles in the order the model saw them. Up on an empty composer pulls the last unsent message back to edit. Whatever the turn never took runs as the next turn
- **Media input** (`core/media.rs`, `tui/media_consent.rs`, `app/media.rs`): images, audio, video and PDFs ride on `Message.attachments` / `ChatEntry.attachments` as references to a content-addressed copy in `~/.agente/attachments/` (sessions never store bytes); providers base64 them at request time — OpenAI chat `image_url`/`input_audio`/`video_url`/`file`, Anthropic `image`/`document`, Gemini `inlineData`, Responses `input_image`/`input_file`. Model support comes from models.dev `modalities.input` / OpenRouter `architecture.input_modalities` (`capabilities.input_modalities`); the composer refuses a send the model can't take, and history sent to another model turns unsupported media into a text note. Attach by dropping/pasting a path (quoted, `\ `-escaped or `file://`), Ctrl+V with an image on the clipboard, or `@` on a media file; chips show above the text (Backspace on an empty composer removes the last), bubbles list them. Images/audio/video ask first (Enter once, `a` always, Esc no) — also before `[Open]` launches a viewer; `/settings` Images/Audio/Video flip `allow_media`. Compaction drops old attachments with a note; estimates count them
- **Paste chips**: any paste of 2+ lines or 20+ characters collapses into an accent chip in the composer — `[#1 +12 lines]`, or `[#2 +58 chars]` for one line — deleted whole by Backspace and expanded on submit; shorter pastes stay inline and editable. Chip numbers never repeat within a draft; history keeps the expanded text. A pasted path to media attaches the file instead
- **Plans**: each `present_plan` writes its own file `<project>/.agente/plans/<date>-<title-slug>.md` (a revision with the same title updates it), so plans from other sessions and tabs are never overwritten
- **Resume**: quitting prints `Resume with: agente --resume <session-id>`; `agente --resume <id|prefix>` reopens it, bare `--resume` opens the picker
- **Sent messages**: your prompts render as a padded card with a full-height accent rail; hover lifts it and shows `revert · fork · copy`; click opens `message_actions` — Revert undoes the file edits made after it (undo stack, so Redo works) and rewinds chat + context, Fork opens a new session up to it; both put the prompt back in the composer
- **Hit map + hover**: widgets register interactive rects in `state.ui.hits` while painting; hovering a list row selects it, clicking selects + sends Enter; buttons lift to `BG_HOVER`; chat cards get a post-paint `hover_tint` (hover never enters render cache keys); pointer moves repaint only when `pointer_fingerprint` changes
- **One scrollbar**: chat, plan review and subagent detail all paint `widgets::scrollbar` (thin thumb, brighter on hover/drag, `HitTarget::Scrollbar` carrying its geometry — press jumps, drag scrubs, over modals too) and show a `12–25 of 120` position
- **Eased scrolling**: wheel / Ctrl+↑↓ / PageUp/Down go through `glide_by` (45% of the remaining distance per frame); `reduce_motion` in config snaps instead
- **Subtle motion**: `state::anim::Tween` (cubic ease-out) drives every transition — a sent prompt glides the transcript up (`glide_to_bottom`) while only its block fades in; floating dialogs ease in over the backdrop; the chat hover band eases in. Never re-fade text that was already on screen (streamed replies). `reduce_motion` starts no tweens; the visual harness runs with it on
- **Hero**: the welcome card carries the half-block pixel tilde-A (`welcome::ICON`, brand colors fixed across themes) and floats on the ambient "tilde sea" (`paint_tilde_sea`, ~15 fps via `wants_ambient_paint`, frozen under `reduce_motion` and in tests); New session dismisses the hero and hands keys to the composer
- **Brand**: "Agente Code" — tilde-A mark on the ink tile; assets in `assets/brand/` generated by `examples/gen_brand.rs` (wordmark outlined from Space Grotesk, OFL — open-source fonts only); `brand.rs` embeds the favicon and product name; Linux launcher in `packaging/linux/`
- **Manual word-wrapping** via `wrap_line()` (never `Wrap` on `Paragraph`) to avoid scroll bugs
- **Syntax highlighting**: `syntect` via `syntax_highlight.rs` for code blocks
- **Transcript grammar**: uniform `◆ Run <verb> <subject>` tool rows, `◇` collapsed thoughts with a one-line preview, `∴` activity line, `Worked for Ns` turn footer, `┃` error rails, rounded composer with the model on the bottom border; a status row under it carries `mode │ $spend · cache% │ context meter` — the one place the mode shows (the header only shows cwd + git)
- **Tool execution modes**: read/grep/list run in parallel; write/edit/shell run sequential; one `Sequential` tool forces the whole batch sequential
- **Cancel channel**: abort signals let Escape interrupt actually abort the LLM task; the stop button works even while a modal owns the screen
- **Tool result truncation**: shell=500 lines, read=2000 lines, grep=200 chars/line, list=500 entries
- **Compaction**: at 85% of the window the loop emits `CompactionStarted`, then trims (truncate tool results, drop old turns) — or, with the `smart_compaction` setting (off by default, `/settings`), writes an LLM checkpoint and falls back to trimming on failure. `ContextCompacted` carries before/after tokens: the transcript gets a `⟲ Context compacted · 182k → 64k · summarized|trimmed` divider, the activity strip and status meter show progress. Provider-reported overflow forces a trim + retry (max 2 per turn); manual `/compact` always trims; subagents always trim
- **Provider specs** (`crates/agente-core/providers/*.toml`, `providers/spec.rs`): one TOML per provider — endpoint, `api_format`, key vars, `match_hosts`, `models` source (`catalog` | `openrouter` | `openai_models` | `llamacpp`), `thinking` request shape, `offered` (replaces the old allowlist), `key_url` / `docs_url`, `order`, `openai_compatible_url` (for clients that only speak OpenAI chat, e.g. MiniMax's `/v1` beside its Anthropic API), plus fallback model data (`models_seed.<id>` `output`/`input`/`reasoning`, provider-wide `default_reasoning`, models.dev `reasoning_options` shape) used only where the provider and models.dev say nothing. Adding a provider = a file + a line in `SOURCES`; the TUI and Desktop pick it up — Desktop has no provider list of its own (`renderer/src/lib/utils/provider-directory.svelte.ts` loads `providers.list`; `llamacpp` keeps its own "On this computer" section). Services whose terms forbid using a person's key from third-party apps stay out (see `apps/desktop/shared/providers.ts`)
- **Thinking profile** (`thinking.rs`): `profile(model)` → levels low → high with token budgets, the provider default `auto` resolves to, and `mandatory`; `request_patch` builds the wire fields from the same profile, so no UI offers a level the wire drops. `auto` (send nothing) is the default level. Sources: models.dev, OpenRouter's live `reasoning` object (descending `supported_efforts` re-sorted), llama-server `/props` (`providers/llamacpp.rs`: template detector ported from llama.cpp's WebUI, `chat_template_caps` → per-request `enable_thinking` + `thinking_budget_tokens` ladder 512/2k/8k/∞). Live model discovery lives in `agente_core::models` (TUI and runtime share it); the models.dev cache refreshes in the background after 24 h. Desktop asks the daemon (`models.discover`, `models.thinking`, `thinking.request`, `thinking.template`) through `apps/desktop/main/agente/thinking.ts` — it has no level lists or body builders of its own
- **System message concatenation**: mode restrictions are appended to the system prompt, never a separate message
- **Transport policy** (`providers/policy.rs`, `docs/PROVIDERS.md`): shared route precedence is explicit model configuration → explicit live metadata → explicit catalog metadata → documented `transport.model_routes` → provider protocol default, only when `require_model_route` is unset/false. Go discovery determines membership; missing routes stay listed and fail before completion HTTP with a `models.<id>.provider.api_format` configuration hint. `models.info`/discovery expose additive transport readiness. Desktop aliases normalize policy and retain the core result when using the same endpoint. Catalog refresh and registry rebuilds preserve overrides
- **Prompt caching**: the request prefix must be byte-stable — tool definitions are sorted by name (the registry is a `HashMap` rebuilt per turn); `providers/cache.rs` consumes declarative `transport.cache` defaults/rules and model `cache_control: true|false` overrides. It annotates system + two newest user turns on a separate copy of the complete request. Only HTTP 400/422 explicitly rejecting the unsupported parameter retries once, and only when Agente inserted markers; the retained original preserves user fields and content shapes. Cache hits in every usage dialect (`prompt_tokens_details.cached_tokens`, DeepSeek `prompt_cache_hit_tokens`, `cache_write_tokens`) share usage accounting
- **Spend**: every model call emits `AgentEvent::CallUsage` with its cost — the provider's own charge when it reports one (OpenRouter `usage.cost`, always in the final chunk), else the catalog/live `/models` per-million price — tagged with the `subagent_id` that made it. Summed into `agent.spend` (status row `$0.042 · 82% cached`) and per child (`SubagentUiState::spend`, on the card and detail title); unpriced models show only the cache rate. Honest labels: `~$` = catalog estimate, `+` = some calls unpriced, `free` = provider charged $0, `<$0.001`, cache % floored and hidden until the provider reports cache fields; the context meter uses the last request's whole prompt (uncached + cache read + write, `TurnUsage.context_tokens`) and shows `~` only for the local estimate. Prices: OpenRouter `usage.cost` (+ `cost_details.upstream_inference_cost` under BYOK) → OpenRouter `/models` per-token pricing → models.dev per-1M `cost` including context `tiers` (the whole call bills at the tier once the prompt passes its size). OpenCode Go reports no per-call cost; its models.dev prices are what its dollar allowance ($12/5h, $30/week, $60/month) is charged at, so Go spend is shown as an estimate
- **Provider cache notes**: DeepSeek/GLM cache automatically on an exact prefix (hits in `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`); MiniMax's Anthropic API caches only `cache_control` breakpoints (≤4); Go's TOML enables a session `prompt_cache_key` on every route, with protocol defaults enabling markers only for Messages. OpenRouter's Claude/Gemini marker rules also live in TOML. These defaults are configurable; transport builders contain no provider/model cache branches. Gateways may report several dialects at once, so the largest cache count wins
- **Categorized errors**: API errors show actionable messages with `/compact`, `/model`, `/provider` hints
- **Subagents**: `task` / `task_output` / `kill_task` hosted tools routed to `SubagentHost`; built-ins `general-purpose` / `explore` / `plan` plus custom types from `.agente/agents/*.md`; capability modes enforced at the registry level; children run on the main model unless the user sets a `subagent_models` override (per type or `*`, via `/subagent-models`; frontmatter and `task` args never pick a model); children run unbounded (the wall-clock watchdog is the backstop); writing children get an isolated git worktree (two kept warm), read-only children (explore, plan, anything under Plan mode) read the parent root directly — no checkout; up to `max_parallel_subagents` (default 8, `/settings`) run at once, the rest queue FIFO; parent + child approvals route by `request_id` via `ApprovalBroker`
- **Loop guard**: identical tool-call signatures nudge after 3 repeats, hard-stop after 6 with a visible notice
- **Skills** (Agent Skills spec, `extensions/skills.rs`): folders with a `SKILL.md` discovered in `~/.claude|.agents|.config/agente|.agente/skills` then `<project>/.claude|.agents|.agente/skills` (later wins, so project beats user); lenient frontmatter (block scalars, nested `metadata`, colons in values), only a missing description skips a skill. Progressive disclosure: the catalog (name + description) lives in the `skill` tool's description with a `name` enum — the model picks the skill itself, and the tool is not registered when there are none; activation returns `<skill_content name="…">` with the body, skill dir and a resource listing (files are read on demand — `read_file`/`list_dir`/`grep`/`find` may open files inside skill dirs outside the project via `resolve_read_path`). `/skill-name request` injects the same block from the composer (the bubble shows what was typed); `/skills` lists them; `disable-model-invocation` keeps one manual-only. Compaction never truncates a skill block and re-attaches any it dropped (`carry_skills`)
- **MCP** (`mcp/`, official `rmcp` SDK): stdio child processes (stderr captured, never inherited) and Streamable HTTP (session id, protocol header, bearer/custom headers). `Arc<McpManager>` with per-server state and no lock across I/O — servers connect concurrently in the background, turns register whichever are ready, calls run concurrently; `tools/list_changed` re-lists on the next turn. Config: `agente.json` `mcp` (lenient: `_comment` keys skipped, `command` string + `args` accepted) plus the project's `.mcp.json` (`mcpServers`), which waits for approval in `/mcp` (`approved_mcp_servers`). Permissions come from `Tool::default_permission`: `readOnlyHint` tools run unasked and in Plan mode, others Ask (auto-approve still applies) unless `trust: true`; `isError` results fail the call. A new session in the same project keeps live connections

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
| `Shift+Tab` | Cycle plan → build → auto (auto = build with every tool call approved) |
| `PageUp/PageDown` | Scroll chat |
| `Shift+Up/Down` | Scroll chat 1 line |
| `Ctrl+Up/Down` | Scroll chat 5 lines |
| `Shift+G` | Scroll to bottom (auto-scroll) |
| `Shift+Home` | Scroll to top |
| `Ctrl+N` | New session |
| `F2` | New tab |
| `Ctrl+PgUp` / `Ctrl+PgDn` | Previous / next tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle plan / build / auto |
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
- MCP OAuth flows (bearer tokens via `headers` work), MCP resources/prompts, and deferred tool search for large MCP tool sets
- Project skills load with AGENTS.md's trust (no per-repo trust prompt yet); project `.mcp.json` servers already wait for approval
- Electron bindings expansion (streaming/turn surface for agente-node)
- Desktop attention notifications; audio/video playback previews in the TUI

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
- `crates/agente-core/src/extensions/` — custom commands, agents, `skills`; `crates/agente-core/src/mcp/` — MCP manager + tool adapter
- `crates/agente-tui/src/skills.rs`, `mcp_servers.rs` — `/skills` and `/mcp` dialogs

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
./target/release/agente.exe --resume <session-id>   # reopen a saved session
```
