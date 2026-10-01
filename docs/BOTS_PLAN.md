# Bots: investigation and plan

Bots have to make sense on every surface: the Rust core, `agente serve` (local or
the Docker server), Desktop, `agente attach`, Telegram, and eventually the TUI.
This plan puts every rule and every piece of identity in the core and keeps the
clients thin, so a bot looks, answers and behaves the same wherever you meet it.

## Where things stand

| Area | Today | Where |
|---|---|---|
| Storage | `~/.agente/bots/<handle>/`: `bot.toml`, `SOUL.md`, `USER.md`, `MEMORY.md`, `routines.toml`, `workspace/` | `crates/agente-bot` |
| Runtime | One permanent session per bot, run by the daemon's runtime; JSON-RPC `bots.*` (list, get, create, update, delete, chat, compact, write_doc, telegram_*) | `crates/agente-daemon/src/bots.rs` |
| Prompt | Persona (`SOUL.md`), what it knows about you, memory, and a teammate list | `crates/agente-bot/src/prompt.rs` |
| Handoffs | `message_bot(to, message)`: runs a turn in the teammate's **one conversation**, waits for it, returns the last assistant message (16k cap). A busy teammate is an error. A handoff can't hand off again. Trust never rises. | `crates/agente-daemon/src/bot_tools.rs` |
| Model | `ModelPin { provider, model }` or nothing ("same as the chat"). A handoff falls back to the asker's model and its thinking level. | `agente-bot` `BotConfig.model`, `bots.rs::bot_turn` |
| Face | Derived in TypeScript from the handle: 10 shapes, 8 temperaments, 4 tints (±14° hue). Every face has the same eyes. Nothing is stored; there's no re-roll; a new bot's face changes as you type its name. | `renderer/.../bots/face/{cast,geometry,engine}.ts` |
| Model picker | Its own provider `Select` plus a free-text model id with 8 suggestions from `fetch_provider_models`. No capabilities, no thinking level, no prices. | `BotModelPicker.svelte` |
| Prompt shell | A hand-copied composer: no sending while the bot works (no queue), no attachments, `/new` is the only command, the model is a static label. | `BotChat.svelte` |
| Other surfaces | `agente attach @bot` is line mode; Telegram answers paired people; **the TUI has no bots**; only Desktop can draw a face. | `crates/agente-cli/src/attach.rs`, `telegram.rs` |
| Isolation | **None at the OS level.** A bot turn gets the full core toolset with `project_dir` = its `workspace/`. `shell` is `sh -c` in that folder with the daemon's environment, the user's privileges and open network. Only path checks in the file tools confine it. Non-owner channels (Telegram Trusted/Public) are forced read-only. | `agente-core/src/tools/{exec,mod}.rs`, `agente-runtime` `effective_mode` |
| Unattended work | Bot turns start in **Build** (`bots.rs::bot_turn`), so shell and writes need an approval. Routines and handoffs on a headless server have nobody to approve, so they either stall or would need full auto with no isolation. | `crates/agente-daemon/src/bots.rs` |
| Toolsets | `bot.toml` has `toolsets`, but **nothing reads it**: every bot gets every tool. | `agente-bot`, daemon |
| Documents | `create_document` / `create_spreadsheet` / `create_presentation` (docx, xlsx, pptx, pdf) exist only in Desktop's Node main process for Home chat. Bots, the server, attach and the TUI can't make documents. | `apps/desktop/main/generated-documents.ts`, `shared/work-product.ts` |
| Old sandbox | Desktop's `main/sandbox.ts` (`chatealm-sandbox` temp dir) is an allowlist that includes `bash`/`sh`, plus a scrubbed environment: not isolation. | `apps/desktop/main/sandbox.ts` |

## What others do (research)

- **Two delegation patterns.** OpenAI's Agents SDK separates *agents as tools*: the caller keeps control and gets a result back, which is what `message_bot` does today. *Handoffs* are the other pattern: control moves to the other agent. Keep ours as agents-as-tools. It is the one that fits a team where each bot owns its conversation. ([Agents SDK](https://openai.github.io/openai-agents-python/), [pattern comparison](https://flocker.md/blog/anthropic-openai-agent-orchestration/))
- **Delegation quality comes from the brief.** Anthropic's multi-agent research system gets its gains from orchestrators writing detailed, self-contained task descriptions and running workers in parallel. Our teammate list is one line per bot, so there is little to route on.
- **Work is a task with a lifecycle, not a blocking call.** A2A models it as `submitted → working → (input-required) → completed | failed | canceled | rejected`. An *agent card* describes what an agent is good at. `input-required` is an interrupt, not an end: the caller resumes the same task. Work can be immediate, streamed or asynchronous. ([A2A spec](https://a2a-protocol.org/latest/specification/), [async lifecycle](https://www.glukhov.org/ai-systems/architecture/a2a-streaming-async-task-lifecycle))
- **Shared memory beats relaying everything.** Letta shares *memory blocks* between agents: one edits, every other agent sees it next turn. Background "sleep-time" agents tidy memory while the main agent is idle. ([shared memory](https://docs.letta.com/guides/agents/multi-agent-shared-memory/), [sleep-time](https://docs.letta.com/guides/agents/architectures/sleeptime/))
- **Coding agents sandbox at the OS level, per platform.** Codex CLI uses Landlock + seccomp on Linux and Seatbelt on macOS, and has an experimental native Windows sandbox. Writes are limited to the workspace and the network is off by default. ([Codex approvals & security](https://developers.openai.com/codex/agent-approvals-security), [Codex sandbox analysis](https://simonwillison.net/2025/Nov/9/codex-sandbox-investigation/)) Claude Code uses bubblewrap on Linux and Seatbelt on macOS. It has two independent layers: filesystem (write only the working dir and a session temp dir) and network (all traffic through a proxy outside the sandbox, checked against a domain allowlist). The runtime is open source (`@anthropic-ai/sandbox-runtime`). ([Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)) The lesson: a sandbox is what lets an agent run *without asking* safely, and it needs both layers.
- **Hosted agents pick an isolation strength.** Containers (shared kernel, fastest, as in Daytona) < gVisor (user-space kernel) < Firecracker microVMs (own kernel, as in E2B, about 150 ms cold start). ([Daytona vs E2B](https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes), [2026 comparison](https://amux.io/guides/ai-agent-sandboxing/)) For a self-hosted Agente server, the container plus an in-process per-bot sandbox is the default. gVisor or a microVM backend is the hardened option.
- **Rust building blocks exist.**
  - **Sandboxing:** `landlock` (per-path filesystem rules, kernel 5.13+; network bind/connect per port, 6.2+); `hakoniwa` (namespaces + cgroups + Landlock + seccomp for launching an isolated child); `birdcage` (Landlock / macOS sandbox behind one API, but it restricts the *calling* process); `extrasafe` (seccomp). ([hakoniwa](https://docs.rs/hakoniwa/latest/hakoniwa/), [birdcage](https://docs.rs/birdcage), [alternatives](https://github.com/akitaonrails/ai-jail/blob/master/docs/sandbox-alternatives.md))
  - **Documents:** `docx-rs` (docx write/read) and `rust_xlsxwriter` (xlsx with formats, formulas and charts) cover documents from Rust. ([docx-rs](https://github.com/bokuweb/docx-rs), [rust_xlsxwriter](https://docs.rs/rust_xlsxwriter))
- **Avatars: a stored seed and a parts vocabulary.** DiceBear and Boring Avatars generate from a seed and a palette. Variety comes from composing parts (eyes, shapes, accessories), not from one outline. People can re-roll the seed, and it is stored, not re-derived. ([DiceBear](https://www.dicebear.com/what-is-dicebear/))

## Principles

1. **The core owns a bot.** Identity, face parameters, model resolution, tasks and limits live in Rust and travel over RPC. Clients draw and ask; they never derive or decide.
2. **Server first.** Everything must work headless, with several clients at once (Desktop, attach, Telegram) and with keys that live on the server.
3. **One conversation stays readable.** Work for teammates happens beside the conversation, not inside it.
4. **Honest states.** Queued, working, needs input, done, failed: the same words on every surface.
5. **A bot works in a box.** Anything that runs code or touches files runs inside that bot's sandbox. Secrets stay in the daemon, and bots never see each other's files. The box, not an approval prompt, is what makes unattended work safe.
6. **Tools live in the core.** A tool that only Desktop has doesn't exist for a bot on a server.

---

## 1. A sandbox for every bot

**Goal.** Each bot gets a small, private machine of its own. It can write only its workspace, reach only the network it's allowed, see no secrets, and it's held to CPU, memory and time limits. Inside the box a bot may run in **auto**, so routines, handoffs and Telegram requests finish without anyone approving. Anything that reaches *out* of the box (messaging, spending, sending files) stays governed by trust and budget.

**Core: `agente_core::sandbox`** (one trait, several backends; used by `shell`, `process_*`, script runners and stdio MCP servers)
- `SandboxPolicy`:
  - **Write:** `workspace/` and a private tmp.
  - **Read:** workspace, the bot's skill dirs, read-only system toolchain paths, and the read-only team library `~/.agente/shared/`.
  - **Never readable:** `$HOME`, `~/.agente` (config, `auth.json`, sessions, other bots), ssh/gpg keys and browser profiles.
- **Environment:** built from scratch (`PATH`, `LANG`, `TZ`, `HOME=workspace`, `TMPDIR`). Provider keys are never passed in; model calls stay in the daemon.
- **Network:**
  - off by default for executed code;
  - `allowlist` of domains through an egress proxy owned by the daemon (the Claude Code model), with every attempt logged;
  - `open` only by owner choice.
  - `web_search` / `web_fetch` / browser run in the daemon, outside the box, with SSRF guards (no private IPs or metadata endpoints) and rate limits.
- **Limits:** wall-clock timeout, CPU time, memory, process count, file size, and a workspace disk quota. On Linux they're cgroups when available, rlimits otherwise.
- **Backends:**
  - **Linux:** unprivileged user + mount + pid + net namespaces with a Landlock ruleset and a seccomp filter. `hakoniwa` fits a child process launch; wrap it rather than rolling our own. If user namespaces are disabled, fall back to Landlock + seccomp only, still denying writes outside the workspace.
  - **macOS:** a Seatbelt profile generated per bot and launched through `sandbox-exec`, the way Codex and Claude Code do it.
  - **Windows:** restricted token / AppContainer as experimental. Until it's solid, Windows bots run *with approvals* (no auto) unless WSL is used.
  - **Docker server:** the container is the outer wall, and per-bot namespaces still apply inside it, so bots can't read each other. The documented hardened option is `--runtime=runsc` (gVisor). A **remote** backend (Firecracker / E2B-style microVM per bot) is kept behind the trait for later.
  - **`none`:** only when set explicitly, and it forces approvals for every execute/write.
- `bot.toml` gains a section:
  ```toml
  [sandbox]
  network = "off"                  # off | allowlist | open
  allow = ["api.github.com", "*.wikipedia.org"]
  timeout_secs = 120
  memory_mb = 1024
  disk_mb = 2048
  mounts = [{ path = "~/Documents/Reports", mode = "ro" }]   # shared by the owner, explicit
  ```
- **Mode:** with a working backend, bot turns run `Auto` inside the box. Without one they run `Build`, and an unattended turn that needs an approval pauses as `input_required` (section 5) instead of stalling silently.
- **Audit:** every sandboxed exec goes to `bots/<handle>/activity.log`: command, exit code, duration, bytes written, network attempts (allowed or denied). It's exposed as `bots.activity` and shown in Desktop and attach.
- **Files between bots:** no shared writable folders. Files travel with a task: the daemon copies attachments into the recipient's `workspace/inbox/`, and results come back from its `workspace/out/`. The owner curates `~/.agente/shared/` (read-only to bots).
- **Same box for the coding agent:** the TUI and Desktop Code can opt into the same sandbox ("workspace-write, network off", like Codex), and so can writing subagents in their worktrees. `main/sandbox.ts` is removed; Desktop's run-code path goes through the daemon.

## 2. A shared toolbox, in the core

**Goal.** Every bot, on every surface, can research, write documents, crunch data and hand results back, with the same tools, implemented once in Rust (or run inside the box). `toolsets` in `bot.toml` becomes real: the daemon registers only the sets a bot has.

| Toolset | Tools | Runs | Notes |
|---|---|---|---|
| `core` (always) | `read_file`, `list_dir`, `find`, `grep`, `write_file`, `edit_file`, `todo`, `memory_update`, `team_memory_update` | in the box (paths confined to it) | Also `read_document`: text and tables out of pdf / docx / xlsx / pptx / csv in the inbox |
| `team` (always) | `message_bot`, `task_status`, `cancel_task`, `ask_back` | daemon | Section 5 |
| `run` | `shell`, `process_start` / `process_stop`, `run_python`, `run_node` | **box only**; not registered when no backend exists | The server image ships Python 3 (pandas, matplotlib, openpyxl, python-docx) and Node, so scripts need no network to install |
| `web` | `web_search`, `web_fetch`, later `browser` (headless Chromium on the server, the browser panel on Desktop) | daemon, outside the box | SSRF guard, rate limit, cited sources in results |
| `documents` | `create_document` (docx), `create_spreadsheet` (xlsx), `create_presentation` (pptx), `create_pdf`, `convert` (md ↔ docx/pdf/html) | core | Port `shared/work-product.ts` (sections, sheets) to a Rust `work_product` module. Use `docx-rs` for docx and `rust_xlsxwriter` for xlsx. PDF comes from the same section model through an embedded typesetter (evaluate `typst` as a library vs. `printpdf`). pptx has no mature Rust writer: write a minimal OOXML writer for the work-product slide model, or run the existing JS generator inside the box until then. Desktop Home then calls the daemon instead of its own Node code, so there's one implementation. |
| `data` | `calculate`, `read_table` (csv/xlsx → rows), `chart` (SVG/PNG via `plotters`) | core / box | Charts feed documents and chat |
| `files` | `publish_file` (makes an output visible to the person), `list_outputs` | daemon | Desktop previews it in the dock; attach prints a path or URL; Telegram sends it; the server exposes `bots.files` / `bots.file_get` for download |
| `comms` | `notify_owner` (desktop notification or Telegram DM to the owner), `send_message` (on the bot's own channel) | daemon | Trust-gated; never available to Public/Trusted-origin turns |
| `schedule` | `routine_list`, `routine_propose` | daemon | A bot *proposes* routines; the owner accepts in Desktop, attach or Telegram |
| `mcp` | per-bot opt-in to MCP servers the owner approved | stdio servers run **inside** that bot's box | Reuses `mcp/` and `approved_mcp_servers` |

- **Defaults:**
  - **New bots:** `core`, `team`, `web`, `documents`, `data`, `files`.
  - **`run` and `mcp`:** turned on per bot, and only offered when a sandbox backend works on this machine.
  - **Colina:** also `comms` and `schedule`.
- **Desktop editor:** a "Tools" block with one toggle per toolset and a one-line description of each. The sandbox policy (network, limits, shared folders) appears in plain words ("Can't use the internet from scripts", "Up to 2 GB of files").
- **Honest failures:** a tool that needs the box reports "This bot can't run programs here: no sandbox on Windows yet". It never falls back to running unsandboxed.

## 3. Faces: quality, variety, and one source of truth

**Problems.** Too little variety: same eyes, blob-like outlines, 4 colors. Faces aren't stable: they come from the handle, so renaming changes the face and there's no re-roll. They're Desktop-only.

**Core (`agente-bot`)**
- `Avatar { seed: u64, tint: String, image: Option<String> }` in `bot.toml`. `create` draws a random seed. A missing seed means "derive from the handle with the existing FNV hash", so every existing bot keeps its face.
- New `agente_bot::face::identity(seed, tint) -> FaceSpec`: shape, palette (three stops), eye style, eye size/spacing/height, mouth, cheeks, accessory, temperament index. Pure and deterministic. It is returned by `bots.get`/`bots.list` as `face`.
- `bots.reroll_face(handle)` → a new seed. `bots.face_candidates(count)` → N seeds spread apart from the faces the roster already has (different shape and hue), for the "pick one" grid.
- Tests: a fixed seed gives a fixed `FaceSpec`, and a parity fixture shared with the TypeScript engine.

**Desktop (engine stays in `face/`, `cast.ts` stops deriving)**
- `engine.ts` draws a `FaceSpec` it is given.
- **New parts vocabulary:**
  - eye styles: round, oval, sleepy, wide-set, dots, visor, one-eye;
  - optional mouth: none, smile, o, flat;
  - cheeks;
  - accessories: antenna, sprout, spark, hat, headphones;
  - the unused `spiky` shape turned back on;
  - an 8–10 hue palette, plus a free hue for "custom".
- Small sizes (24–32 px) keep legibility: a thicker ink line, larger eyes and no accessories below 28 px. The LITE tier already exists; extend it.
- **Editor:**
  - a grid of 6 candidates plus a 🎲 Shuffle button, which morphs to the new face (the engine already morphs);
  - tint swatches become the palette;
  - the preview no longer changes while you type the name.
- Keep `face.spec.ts` and add the parity fixture.

**Server / Telegram / web**
- `bots.avatar(handle, size, format=svg|png)` renders a still face in Rust (SVG from `FaceSpec`, PNG through resvg). Telegram and future web clients use it, and so do exports.

**TUI / attach**
- A half-block mini face (like `welcome::ICON`) drawn from `FaceSpec`: shape mask, eyes, tint. It is used in the attach banner and in a future `/bots` picker.

## 4. Model selection per bot

**Problems.**
- **Duplicated picker:** it bypasses the daemon's model discovery (`models.discover`, `models.thinking`).
- **Missing information:** no thinking level, capabilities or prices.
- **"Same as the chat" means nothing on a server.**
- **Handoff inherits the asker's thinking level**, not the teammate's.

**Core**
- `ModelPin { provider, model, thinking: Option<String> }`.
- **One documented resolution, in `bot_turn`:** bot pin → server default (`config.json` `llm`) → error "no model set up".
- The asking bot's model is no longer a fallback for a teammate. A handoff runs on the *teammate's* model, and every bot answers the same way from every client.
- `bots.update` validates a pin against `models.discover`. If the provider has no key on this machine (common on servers), save it with a warning that `bots.get` exposes.

**Desktop**
- Give `ModelSwitcher` a controlled mode (`value` + `onchange` instead of writing the app config). Use it in the bot editor and in the bot composer. The result is one model menu in the app, with capabilities, thinking levels (`ReasoningLevelSelector`) and prices.
- "Same as the chat" becomes "Server default (…)", showing what that is.

**attach / TUI**
- `/model` inside `agente attach @bot` lists and sets the pin (`bots.update`). The banner shows the bot's model.

## 5. How bots work together

**Problems.**
- **Blocking and fragile:** a busy teammate makes the call fail.
- **Handoffs clutter the teammate's own chat**, since they're injected into its one conversation.
- **No parallel work** on the same bot, no chains, no way to ask back.
- **Little to route on:** one line per teammate.
- **Invisible outside Desktop.**

**Core: a `BotTask`** (new type in `agente-protocol`, stored under `~/.agente/bots/_tasks/`)
- **Fields:** `id`, `from` (bot or person), `to`, `brief`, `status` (queued/working/input_required/completed/failed/canceled), `result`, `cost`, `created/started/finished`, `session_id` (its own thread), `parent` (for chains).
- **Each task runs in its own thread session** of the teammate. It has the teammate's persona, memory and workspace, but not its main conversation. The teammate's main chat gets one compact line when the task ends.
- **Per-bot FIFO queue** (depth cap in settings) replaces the busy error. The caller sees "queued behind 1".
- **`message_bot(to, message, wait = true)`:**
  - `wait = false` returns the task id. The result is delivered into the caller's conversation when it finishes, the same way routines deliver.
  - `task_status(id)` and `cancel_task(id)` round it off.
  - Several calls in one tool batch run in parallel (different teammates, or the same one through its queue).
- **Chains:** depth ≤ 2, with cycle detection (visited handles carried in `Origin`). Trust still never rises. Cost is attributed to the bot that started the chain.
- **`ask_back(question)`** gives the A2A `input-required` state: the task pauses and the asker (or the person, when a person started the chain) answers. The task then resumes with the same id.
- **Bot cards:** each bot gets a short "good at / ask me for / don't ask me for" description in `bot.toml`, drafted from the role and SOUL when it is created. The teammate list in the prompt uses it, along with the model. This follows Anthropic's lesson that routing depends on the brief.
- **Team memory:** `TEAM.md`, shared by all bots, edited with `team_memory_update` (the same caps and rules as `MEMORY.md`), for shared facts and conventions. This is Letta's shared memory block.
- **Events:** `bot.task.{queued,started,input_required,finished}` on the event bus, so every client sees the same thing.
- **Server:** a cap on concurrent bot turns, tasks and queues that survive a restart (state on disk), and the token auth that already exists.
- **Later, optional:** expose bots as A2A agents from `agente serve`. An agent card per bot and the task RPC map almost one to one onto `BotTask`, which lets outside agents hire a bot.

**Desktop**
- **Handoff cards in both chats:** from and to faces, status, time, cost, and "open thread".
- **Roster:** live `@colina → @scout` edges, with a face reaction on each task event.
- **"Activity" dock:** the tasks across the team, with cancel and answer (for `input_required`).

**attach / Telegram**
- **attach** prints task lines (`↪ @scout queued · working · done 12s $0.004`) and can answer `input_required`.
- **Telegram** sends "@scout is on it" and the final answer.

## 6. The bot prompt shell

**Problems.** The composer was copied by hand, so the Home/Code features are missing: no queue, no attachments, few commands, a static model label.

**Desktop**
- Build it from the shared pieces (`ComposerCard`, `ComposerToolbar`, `SendButton`, `ComposerStatus`, `use-attachments`), the way Home and Code are built.
- **Same queue semantics as the TUI.** Enter while the bot works queues the message; Enter on an empty composer injects the queue at the next step. The core needs `bots.chat` to accept a queued/inject mode.
- **Attachments:** media flows through the core as it does in Code.
- **Slash commands** with the same `/` picker: `/new`, `/model`, `/memory`, `/routine`, `/ask @bot …` (starts a task), `/tasks`.
- **Chips:**
  - the model, clickable, sets the pin;
  - the thinking level;
  - today's budget (`$0.42 of $2`);
  - the TUI's status row (`spend · cache% · context`).
- A draft saved per bot. `@mention` keeps its face list.

**attach / TUI**
- The same slash commands in `agente attach @bot`, since the RPCs are shared.

## 7. Bots in the TUI

The TUI runs its own turn engine; bots run in the daemon. The known gap "two turn engines" in AGENTS.md is the root of this. Until the engines converge:
- `/bots` opens a `pick_list` of the roster with half-block faces. Choosing one opens a **session tab** connected to the daemon, with the same client as `attach`. If `agente serve` isn't running, the tab offers to start it.
- The tab renders the same transcript grammar (tool rows, task cards as `↪` rows) and has the same slash commands.

---

## Phases

**Status.** P0 is written (awaiting the Rust checks listed at the end of this plan):
- Each bot has a stored face seed, with Shuffle in the editor.
- Pins carry a thinking level, and it stays with its model.
- `toolsets` are enforced: built-in tools are filtered, MCP only with `mcp`, and subagents inherit the limit; the editor has a Tools section, and the list comes from `bots.toolsets`.
- Bot commands run with a clean environment (`ShellEnv::Clean`, inherited by subagents).
- Handoffs to a busy teammate queue in order, for up to 10 minutes, and a mutual wait fails at once.
- Desktop's bot model picker shares the composer's model loader (`provider-models.svelte.ts`) and thinking selector.

P1 (the sandbox) has landed its core; the Rust crates type-check, and the Linux box passed 15/15 escape checks on a 7.0 kernel:
- `agente_core::sandbox`: the Linux helper (`agente __sandbox`, Landlock plus a hand-written seccomp filter plus rlimits) and a macOS Seatbelt profile (untested on a Mac).
- `ShellEnv::Boxed` builds every shell and background process.
- Bot turns are boxed when a backend exists, and run Auto when boxed and without MCP.
- `[sandbox]` in `bot.toml` is exposed as `bots.sandbox`, and the editor states whether programs are boxed.

Still to do in P1:
- the egress proxy for per-domain network allowlists;
- the activity log;
- routing Desktop's legacy `main/sandbox.ts` through the daemon;
- memory and process limits through cgroups;
- a Windows backend.


| Phase | Scope | Surfaces |
|---|---|---|
| **P0: fixes** | `toolsets` honored; shell env built from scratch (no keys); stored face seed + Shuffle; pin gains `thinking`; one model resolution; `ModelSwitcher` controlled mode; busy → per-bot queue | core, daemon, Desktop |
| **P1: sandbox** | `agente_core::sandbox` with Linux (namespaces + Landlock + seccomp) and macOS (Seatbelt) backends, egress proxy, limits, activity log; bot turns run Auto inside the box; `none` forces approvals; Docker image + gVisor guide; remove `main/sandbox.ts` | core, daemon, server, Desktop |
| **P2: toolbox** | Documents in Rust (docx, xlsx, pdf; pptx interim), `read_document`, `data` and `chart`, `files` + `bots.files`, inbox/out, web tools in the daemon with SSRF guard; Desktop Home switches to the daemon's document tools; Tools block in the editor | core, daemon, Desktop, server, attach, Telegram |
| **P3: tasks** | `BotTask` + threads + events; handoff cards; attach task lines; `wait=false`, `task_status`, `cancel_task`; parallel handoffs; files travel with tasks | core, daemon, Desktop, attach, Telegram |
| **P4: faces and shell** | `FaceSpec` in Rust + parts vocabulary + candidates; shared-composer bot shell; `bots.avatar` render | core, Desktop, server, attach |
| **P5: teamwork** | Bot cards, `TEAM.md`, `ask_back`, chains ≤ 2; Activity dock; `comms` and `schedule` toolsets | core, Desktop, attach |
| **P6: reach** | TUI `/bots` and bot tabs; sandbox for the TUI coding agent and subagents; Windows AppContainer backend; remote microVM backend; optional A2A endpoint | TUI, server |

## Verification

- **Sandbox escape tests** (one per backend, run in CI on Linux and macOS). From inside a bot's box:
  - reading `~/.ssh`, `~/.agente/auth.json` or another bot's workspace fails;
  - writing outside `workspace/` fails;
  - `env` contains no provider key;
  - `curl` to a non-allowlisted host fails and is logged;
  - a fork bomb and a memory hog hit their limits;
  - a timeout kills the whole process tree.
- **Document round-trips:** create docx / xlsx / pdf from a fixed work-product fixture, then read each back with `read_document` and compare text and tables. Open the files in LibreOffice headless as a smoke test.

- **Rust:** unit tests for `face::identity` (fixed seeds), the model resolution order, queue ordering, cycle detection and task persistence across restart. Integration tests next to `bot_tools.rs`: parallel handoffs, a busy teammate queues, a cancel propagates, `input_required` resumes. Run them one crate at a time with low parallelism, for example `CARGO_BUILD_JOBS=2 cargo test -p agente-bot -j 2`.
- **Desktop:** the face parity fixture in `face.spec.ts`; composer queue and mention specs; `npm run check` and the Fallow audit.
- **Server:** the Docker image with two clients attached to one bot (Desktop and `attach`) plus Telegram. The same task states must appear everywhere, and a restart mid-task must resume or fail it honestly.
