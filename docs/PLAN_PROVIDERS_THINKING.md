# Plan — shared providers, model lists and thinking

One provider definition (TOML) and one model directory in `agente-core`, read by
the TUI directly and by Desktop through the daemon. Adding a provider is one
TOML file. Model lists, thinking levels and the request body come from the same
core code, so what a UI offers is exactly what goes on the wire. OpenRouter and
local llama.cpp are first-class.

## What is broken today

| Problem | Where |
|---|---|
| Three provider definitions that drift | `core/config.rs` built-ins + `provider_is_supported` allowlist; `core/thinking.rs::detect_thinking_format` (id/URL sniffing); `desktop/main/providers/dialects.ts` |
| Live model discovery exists only in the TUI | `agente-tui/src/state/config.rs::set_discovered_models` (called from `app/agent_events.rs`). `agente-runtime` / daemon never discover, so Desktop Code turns and `models.info` only see models.dev |
| models.dev is lossy for OpenRouter | models.dev says `openrouter/anthropic/claude-sonnet-4.5` is `toggle` only; OpenRouter's own `/models` says `mandatory` + `max…low` efforts |
| Desktop never asks the core for levels | `openai-core.ts::getReasoningCapabilities`: DeepSeek hardcoded; OpenRouter/Go get a fixed `off/low/medium/high` if `supported_parameters` lists reasoning (Go never does → hidden); custom/Ollama/LM Studio → hidden |
| Desktop levels ≠ core levels | Code turns send the desktop level to `apply_thinking_level`, which silently drops anything the core doesn't list (`kimi-k3` is `max` only) |
| OpenRouter efforts come in descending order | `supported_efforts` is documented highest-first (`max, xhigh, high, medium, low`); `supported_thinking_levels` keeps raw order, so a slider would run backwards |
| models.dev cache never expires | `ModelCatalog::load_from_cache` has no age check → new models (`claude-sonnet-5-5`, `gpt-6.1-sol`) get no levels |
| Budget-only models get only `on` | Anthropic 4.5 / Gemini 2.5 budget models can't turn thinking off and have no ladder; one level hides the Desktop selector |
| llama.cpp is off/on and needs a restart | Desktop passes `--reasoning on|off` at launch; per-request control is unused |

## What the providers give us (research)

### OpenRouter

- `GET /api/v1/models` (464 models today, no key needed; `/models/user`
  applies the account's provider preferences). Per model: `id`,
  `canonical_slug`, `name`, `context_length`, `architecture.input_modalities`,
  `pricing` (`prompt`, `completion`, `input_cache_read`, `input_cache_write`,
  `input_cache_write_1h`, `web_search`), `top_provider.max_completion_tokens`,
  `supported_parameters`, `default_parameters`, `expiration_date`,
  `knowledge_cutoff`, and `reasoning` (on 332 models):
  - `supported_efforts` — highest-first; `null` = every gateway effort;
    absent = no effort selector.
  - `default_effort` — pre-selected effort.
  - `default_enabled` — on/off when the request says nothing.
  - `mandatory` — cannot be disabled; `none` is rejected.
  - `supports_max_tokens` — takes a token budget instead of efforts (11 models).
- `GET /api/v1/models/{author}/{slug}/endpoints` — per upstream provider
  `supported_parameters`, pricing, limits, uptime. Upstreams differ, so a
  reasoning request should carry `provider.require_parameters: true` to avoid
  landing on one that ignores it.
- Request: `reasoning: { effort | max_tokens, exclude, enabled }`
  (`effort`: `max, xhigh, high, medium, low, minimal, none`; `effort` and
  `max_tokens` are exclusive; `enabled: true` alone = medium). Omitted →
  model default (`default_enabled`). Legacy `include_reasoning` /
  `reasoning_effort` still accepted.
- Response: `reasoning` (text) and `reasoning_details[]`
  (`reasoning.text|summary|encrypted`, `id`, `format`, `index`, `signature`).
  They must be sent back unmodified with tool results — the core already
  round-trips them (`providers/openai.rs`), keep it covered by tests.
- Cost: `usage.cost` per call (already used for spend).

### llama.cpp (`tools/ui` WebUI + `tools/server`)

- WebUI selector: Default · Off · Low · Medium · High · Max with budgets
  512 / 2048 / 8192 / unlimited; Default sends nothing.
- `/props`: `chat_template` and, on new servers, `chat_template_caps`
  (`supports_reasoning_effort`, `supports_preserve_reasoning`, …). No
  `supports_thinking` flag — the WebUI regex-detects it from the template
  (same detector as `apps/desktop/main/chat-templates.ts`).
- Request: `reasoning_format: "auto"`, `chat_template_kwargs.enable_thinking`,
  `thinking_budget_tokens` (server-enforced, any thinking model),
  `reasoning_effort` (`none` disables; else passed to the template),
  `reasoning_control` (stop thinking early via `/v1/chat/completions/control`).

### models.dev

- 6,136 reasoning models, all with `reasoning_options`
  (`effort` / `toggle` / `budget_tokens`). Good default for first-party APIs;
  stale for gateways — live data wins when a provider has it.

## Target shape

```
crates/agente-core/providers/*.toml ──► ProviderSpec registry
                                            │ spec.models picks an adapter
             ┌──────────────┬───────────────┼────────────────┐
         catalog        openrouter      openai_models      llamacpp
       (models.dev)   (/api/v1/models) (plain /models)     (/props)
             └──────────────┴───────┬───────┴────────────────┘
                                    ▼
                  ModelDirectory (core): merged ModelInfo per provider,
                  TTL cache on disk, background refresh
                                    │
                  thinking::profile(model) → ThinkingProfile
                  thinking::request_patch(model, level) → body fields
                                    │
            ┌───────────────────────┴───────────────────────┐
         TUI (direct)                           daemon: providers.list
                                                        models.list
                                                        models.thinking
                                                        thinking.request
                                                           │
                                                        Desktop
```

## Phase 1 — Provider specs (TOML)

`crates/agente-core/providers/<id>.toml`, embedded with `include_str!` in
`providers/spec.rs` (`toml = "0.8"` is already a workspace dep).

```toml
id = "openrouter"
name = "OpenRouter"
group = "cloud"                       # cloud | local
base_url = "https://openrouter.ai/api/v1"
api_format = "openai"                 # openai | anthropic | responses | google
env = ["OPENROUTER_API_KEY"]
match_hosts = ["openrouter.ai"]
key_check_path = "/key"
headers = { "HTTP-Referer" = "{app_url}", "X-Title" = "{app_name}" }
models = "openrouter"                 # catalog | openrouter | openai_models | llamacpp
catalog_id = "openrouter"             # models.dev key, fills gaps (defaults to id)
thinking = "openrouter"               # default | deepseek | qwen | openrouter | together
                                      # | antling | anthropic | google | llamacpp
stream_usage = true
offered = true                        # shown in connect dialogs (replaces the allowlist)

[cache]
breakpoints = "claude,gemini"         # model families that take cache_control
prompt_cache_key = false

[request]                             # static body fields added to every call
provider = { require_parameters = true }   # only when a reasoning field is sent
```

- First files: `openrouter`, `opencode-go`, `deepseek`, `minimax`, `glm`,
  `anthropic`, `openai`, `google`, `ollama`, `lmstudio`, `llamacpp`, `custom`.
- `AppConfig::default()` builds `provider` from specs; `agente.json` still
  overrides any field. `provider_is_supported` → `spec.offered`.
- `ModelInfo.compat` comes from `spec.thinking`; `detect_thinking_format` stays
  only as the fallback for `custom`.
- Test: every spec parses; ids unique; enums known; `match_hosts` don't collide.

## Phase 2 — Model directory in core (shared discovery)

Move discovery out of `agente-tui/src/state/config.rs` into
`agente-core/src/models/` so the runtime (daemon, Desktop, headless) and the
TUI use the same lists.

- `ModelSource` trait per `spec.models`:
  - `catalog` — models.dev only.
  - `openrouter` — parse `/api/v1/models` into `ModelInfo` (limits, modalities,
    pricing incl. cache prices, `reasoning` → `ReasoningOption::OpenRouter`,
    `expiration_date` → deprecated status). Optional per-model `/endpoints`
    lookup when the user pins an upstream.
  - `openai_models` — plain `/models` (Ollama, LM Studio, custom, Go); catalog
    fills metadata by id.
  - `llamacpp` — Phase 4.
- `ModelDirectory`: per-provider snapshot, on-disk cache
  (`~/.cache/agente/models/<provider>.json`, 6 h for live lists, 24 h for
  models.dev), stale-while-revalidate, a miss for the selected model forces one
  refresh, a failed fetch keeps the old copy. Live data beats models.dev; the
  merge rule is the existing `enrich_discovered_model`, moved to core.
- TUI `set_discovered_models` becomes a thin call into the directory; the
  runtime owns one directory and refreshes it on `runtime.configure`.

## Phase 3 — One thinking profile

`thinking.rs` gains `profile(model) -> ThinkingProfile`; `supported_thinking_levels`
/ `clamp` / `cycle` / `apply_thinking_level` become wrappers.

```rust
pub struct ThinkingProfile {
    pub levels: Vec<ThinkingLevel>,   // always low → high
    pub default: Option<String>,      // OpenRouter default_effort, template default…
    pub mandatory: bool,              // no "off"
    pub source: ProfileSource,        // Catalog | Live | Template | None
}
pub struct ThinkingLevel { pub id: String, pub budget_tokens: Option<i32> }
```

- One canonical order: `auto, off, minimal, low, medium, high, xhigh, max,
  on` — fixes OpenRouter's descending lists.
- `auto` (send nothing, provider default) is offered whenever the provider has
  a default, and the UI names what it resolves to ("Auto · high").
- OpenRouter: `mandatory` → no `off`; `supported_efforts` (or all efforts when
  `null`) → levels; `none` → `off`; `supports_max_tokens` without efforts →
  budget ladder sent as `reasoning.max_tokens`.
- Budget-only models (Anthropic 4.5, Gemini 2.5): `off` where the API can
  disable (Anthropic always; Google when `min == 0`) and `low / medium / high`
  from `[min, max]` instead of a lone `on`.
- `request_patch(model, level) -> serde_json::Map` is the only producer of
  thinking body fields; OpenRouter adds `provider.require_parameters` alongside
  `reasoning`.

## Phase 4 — llama.cpp provider in core

- Detection from `GET /props` (with the server key): `chat_template_caps`
  present → per-request control; `supports_reasoning_effort` → effort kwarg.
  Otherwise the template detector, ported to `models/llamacpp.rs`. Last resort:
  the session already received `reasoning_content`.
- Levels `auto · off · low · medium · high · max` (512 / 2048 / 8192 /
  unlimited). Old servers without caps → `auto · off · on`.
- Body: `reasoning_format: "auto"`; `off` → `enable_thinking=false`; others →
  `enable_thinking=true` + `thinking_budget_tokens` (omitted for max) +
  `reasoning_effort` only when the template takes it; `auto` sends none.
- Desktop keeps download / launch / port / key / template sidecar, stops
  forcing `--reasoning` unless the user set a startup default, and registers
  the running server as `llamacpp`. The TUI can point `llamacpp` at any
  llama-server URL.
- Later: `reasoning_control` + "stop thinking" button.

## Phase 5 — Surfaces

- Daemon (`agente-daemon/src/connection.rs`):
  - `providers.list` → specs + configured/connected state.
  - `models.list {provider}` → directory snapshot (+ refresh flag).
  - `models.thinking {provider, model}` → `ThinkingProfile`.
  - `thinking.request {provider, model, level}` → body patch.
- TUI: connect dialog lists specs; model picker, `/thinking`, Ctrl+T, status
  row read the directory + profile.
- Desktop main:
  - `dialects.ts` shrinks to transport details (SDK vs fetch-SSE,
    `normalizeBaseUrl`) keyed by spec id; `reasoningBody`,
    `reasoningCapabilities`, `EFFORT_LEVELS`, `DEEPSEEK_LEVELS`,
    `supportedParametersCaps`, and the desktop model fetchers are deleted.
  - Model lists come from `models.list`; `getReasoningCapabilities` →
    `models.thinking`; `openai-core.ts:149` merges `thinking.request` instead of
    `reasoningBody`.
  - Chat keeps streaming through TypeScript for now; moving Desktop chat onto
    core providers is follow-up work.
- Renderer: `ReasoningCapabilities` becomes the profile shape; level labels and
  hints keyed by level id in all 7 locales.

## Phase 6 — Desktop selector redesign (`ReasoningLevelSelector.svelte`)

- White card (`#fff` light; lifted surface in dark), 16 px radius, soft
  two-layer shadow, no border.
- Top row: "Faster / Response" left, **Thinking Mode** centered, "Deeper /
  Insights" right.
- Thick rounded rail, light→accent gradient, thin white dividers and a white
  dot per stop; large glossy accent thumb; keep drag, keyboard, sheen, reduced
  motion, `role="slider"`.
- First stop's name under the rail start.
- Footer: `Current Setting: ▂▄▆█ High`, plus the budget when the level has one;
  "Auto" shows what it resolves to.
- Hidden only when the profile has fewer than two levels; a mandatory
  single-level model shows a static "Always thinking · high" chip instead.
- Spec update + light/dark screenshots.

## Phase 7 — TUI selector (`thinking_selector.rs`)

```
  Faster           Thinking mode           Deeper
  ━━━━━━━━━━━●┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  auto   off   low   medium   high   max
  Current ▂▄▆ medium · ≤2k tokens
  ←→ change · Enter apply · Esc close
```

- Accent fill, `FG_DIM` rest, `·` stops, single-width glyphs, no borders.
- ←/→ Home/End, click a stop (hit rects), Enter applies; new harness state.

## Tests

- Spec validation (Phase 1).
- OpenRouter: saved `/api/v1/models` fixture → directory → profile for
  mandatory + efforts, optional + `none`, `supported_efforts: null`,
  `supports_max_tokens`, no `reasoning` object; body patch per level;
  `reasoning_details` round-trip with tool calls.
- Per-provider profile + body fixtures: DeepSeek, OpenCode Go, Anthropic 4.5 /
  5.x, Gemini 2.5 / 3, Ollama, llama.cpp (old and new `/props`).
- Directory: TTL, stale-while-revalidate, failed fetch keeps cache, live beats
  models.dev.
- Daemon round-trip for the four methods; Desktop has no hardcoded level list,
  body builder or model fetcher.
- `cargo check` zero warnings; `cargo test`, desktop `npm test` green.

## Adding a provider afterwards

1. Drop `crates/agente-core/providers/<id>.toml`.
2. New list format → one `ModelSource`; new wire shape → one `thinking`
   variant. Each with a fixture.
3. TUI and Desktop pick it up with no code.

## Order

1 → 2 → 3 → 4 → 5 fix the bug and unify; 6 and 7 are visual and can start once
the Phase 3 profile shape is fixed.
