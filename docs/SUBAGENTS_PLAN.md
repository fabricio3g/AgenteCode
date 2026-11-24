# Subagents redesign — plan

Status: phase 1 and the board half of phase 4 built (2026-11-19); phases 2, 3 and the race / best-of strategies proposed.

## Goals

1. **No predetermined subagents.** The model decides: it creates each
   subagent for its task — a role, instructions, a tool level and a model —
   on the normal agent loop. In swarm mode it creates several at once.
2. **You choose the models** subagents may run on, from any provider, in the
   UI (TUI and Desktop), and write what each one is for.
3. The **main model orchestrates**: it reads your notes and picks a model per
   child, only from your list (or you switch picking off and one default
   model runs every child).
4. **Swarm**: several created children on one job — fan out, race,
   best-of-N — with one writer.
5. **Recovery** built for free models: rate limits, daily quotas, small
   windows, weak tool calling, stalls, restarts.

## How it is wired

```
task / task_output / kill_task          (hosted tools the parent model calls)
  │
agente-core  SubagentHost               built per turn: agent/channel/loop_.rs
  │  request.normalize() → resolve_effective_config (role → _role.md prompt)
  │  → routing::resolve_model (the user's list) → admit / queue → launch
  │  child = same run_agent_loop on its own OS thread + current-thread runtime
  │  child events → forwarder thread → AgentEvent::Subagent* on the parent channel
  ├─ TUI      app/agent_events.rs → state SubagentUiState → widgets/subagent_detail.rs
  └─ Desktop  Electron main → agente-daemon → agente-runtime (RuntimeSupervisor)
              → runtime/bridge.rs maps to protocol RuntimeEvent::Child* (with seat)
              → main/agente/rust-events.ts → renderer features/code/code-run.ts
              → SubagentCard / SubagentPill / SubagentView
```

Settings travel `runtime.settings` / `runtime.configure` (`subagents` key);
Desktop saves through `agente_subagent_settings` → `rust-engine.ts`
`subagentSettings`, which resolves each entry's provider like a turn does.

## What the research says (and what we took from it)

- **No orchestrator mode, no fixed roster.** Kilo deprecated its Orchestrator
  mode; any full-tool agent delegates. → The main agent orchestrates, and it
  writes each subagent's role itself; the user's own agent files remain
  optional.
- **Model precedence** (Claude Code, Codex): force > per-call `model` > agent
  file > parent. Known trap: an orchestrator spawning copies of its own
  expensive model. → The parent picks only from your named list; a default
  model covers the rest.
- **One writer.** Cognition: parallel writers make conflicting implicit
  decisions; research/review agents work while writes stay single-threaded.
  Anthropic: read-heavy fan-out pays (≈15× chat tokens); each child needs an
  objective, output format, tool guidance and boundaries. → Created
  subagents are read-only unless the parent asks; the `task` text teaches
  partitioned ownership; swarm writers get separate worktrees.
- **Selection over synthesis**: a judge picking one candidate beats voting
  and merging. → `best_of` with tests or a judge model.
- **Three recovery tools** (LiteLLM): retry with Retry-After, cooldown,
  fallback; free tiers are mostly daily caps (OpenRouter `:free` 20/min,
  50 or 1000/day); a `:free` model falling back to a paid one is billed.
- **Durable runs** (LangGraph): save after every step, never redo a finished
  side effect. **Model switches**: drop foreign thinking signatures, close
  orphaned tool calls.
- **Laws of UX** (lawsofux.com) for the settings UI: Jakob + Von Restorff
  (the default is a radio, the one row that stands out), Hick + Occam (only
  name, model, note; no duplicate headings, no live cards in settings),
  chunking + proximity + common region (row = name/model over note; list and
  switch in separate regions), Tesler (the picker absorbs provider detail;
  "Add model" opens it directly), Postel (names folded, never refused),
  Zeigarnik (a row without a model stays as a draft), Fitts (whole row
  opens it; Remove apart from Done).

## Design (built in phase 1)

### Creating a subagent

`task` takes `role` (who it is, a few words; shown on the card; defaults to
the description), `instructions` (method, standards), `capability_mode`
(`read-only` default; `read-write`, `execute`, `all`), `model`, and the
`prompt`. The child's system prompt is `crates/agente-core/agents/_role.md`
with `{role}` and `{instructions}` filled. A read-only child waits inline; a
writer runs in the background. `subagent_type` appears only when the user
has `.agente/agents/*.md` files, and launches one by name (a `role` sharpens
it). There are no built-in presets.

### The model list

```jsonc
"subagents": {
  "orchestrator_picks": false,          // omitted = on
  "models": [
    { "name": "scout", "provider": "openrouter", "model": "qwen/qwen3-coder:free",
      "thinking": "auto", "use_for": "Fast searches and reading docs. Never edits." }
  ],
  "default_model": "scout"              // omitted = the conversation's model
}
```

Old `subagent_models` pins fold in on read (`AppConfig::subagent_settings`):
one entry per distinct model, the `*` pin becomes the default.
`set_subagent_settings` clears them.

### Which model a child runs on

1. The parent's `model` (a list name or `main`), when picking is on; an
   unknown name fails the call and lists the names.
2. An agent file's `model:` (list name, `main`, or `provider/model` on a
   connected provider).
3. `default_model`.
4. The parent's model.

The `task` description ends with the menu (`name — price · window — note`),
byte-stable for the same list. Cards read `scout · qwen3-coder:free`.

### UI

Desktop (`SubagentModelsEditor.svelte`, opened by `/subagents`): a radio per
row (`Default` badge on the chosen one), name and model on one line, the
note under it, the conversation's model as the last radio; `+ Add model`
opens the model picker at once; a row opens in place (Name, Model, Use for,
Done … Remove); the "Let the agent choose" switch in its own region; saves
as it changes. TUI (`/subagent-models`): the same rows in `pick_list` —
`◉/○` radio, name, note, model; Space sets the default, Enter re-picks the
model, `u` note, `n` rename, Del remove.

## Phases

Each phase compiles with zero warnings, keeps tests green, updates AGENTS.md,
and regenerates `apps/desktop/shared/agente-protocol.gen.ts` when the protocol
changes.

### Phase 1 — Created subagents and the model list ✅

Built as described above. Files: `subagent/{definition,routing,types,host}.rs`,
`agents/_role.md`, `config.rs`, `tools/subagent.rs`, `tools/mod.rs`,
`agent/channel/loop_.rs`, runtime + bridge + protocol (`ChildStarted.seat`),
daemon `project.rs`, TUI `subagent_models.rs`, Desktop
`SubagentModelsEditor.svelte`, `subagent-models.ts`, `rust-engine.ts`,
locales.

### Phase 2 — Limits and recovery (provider layer)

- Structured provider errors (`status`, kind: RateLimit | Quota |
  ContextOverflow | ModelUnavailable | Auth | Server | Transport |
  BadRequest, `retry_after`, `reset_at`); `Display` keeps today's strings.
- Model health shared by the main loop and children: rpm / tpm / rpd /
  concurrency buckets, cooldown with allowed fails, quota cooldown until
  reset, OpenRouter `GET /key` to seed the daily count.
- Retry policy: short Retry-After → wait; quota / unavailable / auth → fall
  back now; overflow → compact, then a larger window; server/transport →
  backoff, then fall back.
- Per entry: `fallback: [...]`, `limits`, `stay_free`; optional escalation
  to the main model (off by default).
- Weak tool calling: after K malformed calls, escalate along the chain.
- Model-switch hygiene (`providers/history.rs`): drop foreign signatures
  (incl. the legacy single-signature path in `providers/messages.rs`),
  close orphaned tool calls.
- Admission by model capacity, not only the global cap.
- `SubagentRecovering { from, to, reason, wait_ms }` → `ChildRecovering`;
  the `task` result carries the trail; UI rows show today's use and cooldown.

### Phase 3 — Durable children

- Children write ordinary session files after every step (parent id, role,
  seat); `resume_from` loads from disk and may change model.
- After a restart running children come back `Interrupted` with Resume; an
  unanswered tool call is closed so a resume never repeats an edit.
- Worktree GC keeps resumable checkouts; child sessions hidden from the
  picker, grouped under the parent.

### Phase 4 — Swarm (the agent creates many)

Built: swarm mode with a board (`swarm.rs`, `subagent/host/board.rs`). The
user switches it on per session (TUI `/swarm`, Desktop's mode menu); the main
model gets the `board` tool, adds cards (role, model, prompt, depends_on,
owns), and the host starts ready cards as created subagents, moving them
Backlog → Working → Review/Done/Failed and starting dependents as cards
finish. One writer per path. Board views: TUI `/board`, Desktop Board pane.
Members talk to each other through a findings log on the board (built
2026-11-24): each card's subagent gets the `swarm` tool — `post` a finding
(optionally `to` some cards) or `read` the cards and log — and an inbox, so a
post lands in the working members' conversations at their next step and in
the prompt of every card that starts later. The lead reads the newest findings
in every `board` result and broadcasts with `board` `post`. Display: a turn's
members draw as one swarm block (lanes + findings) on Desktop and as lane-named
cards with their newest finding in the TUI.
Still to build below: `race` and `best_of`; a member asking the lead and
waiting (`ask_lead`); steering one running card.

- Hosted `swarm` tool: the parent creates every member in one call —
  `{ strategy: "fan_out" | "race" | "best_of", members: [{ role,
  instructions?, capability_mode?, model?, prompt }], verify?, judge? }`.
  - `fan_out`: independent members (read-only unless asked); every result
    returned with its status; partial failure reported, not fatal.
  - `race`: one brief on several models from the list; first good answer
    wins, the rest are cancelled. The free-model strategy.
  - `best_of`: writers each in their own worktree; `verify` and/or a judge
    model (a list name) pick one; only the winner's diff is offered.
- Members obey the list routing and the phase-2 limits; the orchestrator
  guidance scales effort (one child for a lookup, 2–4 for comparisons,
  fan-out only for independent work, never two writers on one tree).
- Events: `swarm_id` on `ChildStarted`, `SwarmStarted` / `SwarmFinished`;
  one swarm card with a lane per member.

## Out of scope (for now)

- Subagents in Home / Design (the TypeScript runtime has none).
- Free-form chat between agents (members share findings through the board,
  not conversations).
- Learned / automatic routing; the parent picks by your notes.
- Project-level model lists.
