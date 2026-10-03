# Desktop and Rust performance measurements

Measured locally on 2026-10-02 in development mode. These are observations,
not timing assertions in CI. Provider response times vary independently of
local CPU and disk costs.

## Findings and fixes

- Each Plan turn appended another generated restriction to the saved system
  message. That changed the prefix every turn. Replace the footer once, recover
  old duplicates, and remove it when returning to Build.
- Runtime RPC reads deep-cloned the model catalog twice. Live configuration is
  now an immutable shared snapshot; configuring creates a new snapshot while
  running turns retain their settings.
- Snapshot JSON used an unbuffered file for reads and writes. Buffer atomic
  writes, parse byte buffers, borrow serialized snapshots/metadata, and skip
  allocating client transcripts when listing session summaries. Flush, sync
  and atomic replacement remain intact.
- Long chats laid out and painted every message while scrolling. Use native
  offscreen content visibility, a stable slot map, derived timeline previews
  and binary search for the nearest message. Streaming/editing messages remain
  fully laid out; messages stay mounted for search and selection.
- Every composer key saved the whole transcript and all chats. Draft-only IPC
  updates one SQLite row, retaining messages, versions and attachments.
- Provider/model/local-file choices were global. Store identity per conversation
  for Home, Code and Roleplay, preserve Home runtime metadata through hydration,
  capture selection when launching, and pass local-file identity to preflight.
  Discard stale model-list responses and clear context readings on route/chat
  changes; late background usage cannot replace the current model's context.
  Authentication remains separate from chat records.

## Before and after

| Measurement | Before | After |
| --- | ---: | ---: |
| Real daemon `providers.status`, median of 10 | 66.24 ms | 0.32 ms |
| Real daemon `session.list`, median of 10 | 510.13 ms | 88.17 ms |
| Synthetic ~2 MiB snapshot recovery, median of 5 | 1387.04 ms | 32.61 ms |
| Synthetic snapshot atomic write, median of 5 | 241.36 ms | 103.91 ms |
| List 24 ~0.5 MiB metadata files, median of 5 | 796.42 ms | 142.97 ms |
| Electron 400-message mount | 3085.4 ms | 1254.1 ms |
| Electron 400-message scroll frame, median | 106.4 ms | 16.8 ms |
| Electron 400-message scroll frame, p95 | 124.2 ms | 64.5 ms |
| Electron 20 composer updates, synchronous UI work | 550.6 ms | 0.4 ms |

Electron uses a visible isolated window, software rendering, the actual dev
renderer and 400 synthetic messages (~80,000 DOM nodes). Draft measurements
include synchronous work and IPC enqueueing; they do not measure SQLite flush
latency. Offscreen content still needs layout when newly revealed, so large
scroll jumps retain slower frames. Mounting remains linear in message count.
The harness checks app initialization and rendered message count, and exports
an actual Chromium CPU profile.

Live OpenCode Go `space-bunny-free` performed three read-only coding turns:
`read_file`, then `PERF_OK`. Before, each new turn's first call hit only 128
cached tokens; the final run's warm first calls hit 5851/5934 tokens and processed
only 36 new prompt tokens. The isolated daemon has a smaller tool set than the
Desktop-attached baseline; compare prefix reuse, not absolute token totals.
Warm full-turn times ranged from 2.2–4.7 seconds across two runs after the fix;
the baseline ranged from 2.9 to 12.3 seconds. These small samples do not establish
provider latency guarantees. No user model/reasoning preference was changed.
Live credentials were used only for Go; other protocol behaviors are covered
by local HTTP fixtures and the [official provider audit](PROVIDERS.md).

## Validation

- Full renderer suite: 1,015 passed; one optional live test skipped. Final
  model/isolation regression run: 13 passed.
- Rust core/runtime/session suites and protocol fixtures passed (one existing
  ignored test); workspace check, formatting and debug binary build passed.
- Desktop provider/preflight tests: 29 passed. Main and production renderer
  builds passed; Svelte checking reported zero errors and zero warnings.
- Real Electron verified Home/Code/Roleplay model and reasoning isolation,
  cloud/local context restoration, out-of-order discovery, and SQLite reopen.
  Draft-only saves retained messages, attachments and response versions.
- The dependency tooling still prints its existing stale Browserslist-data
  notice; this is separate from Svelte/compiler diagnostics.

## Model list freshness follow-up

The active-chat model cache and provider-picker cache previously had no expiry.
A failed listing returned `[]`, which the picker replaced with its saved model
and then treated as a completed load. Refresh updated only the active group,
leaving other displayed providers stale. Thinking discovery also ran only once.

Chat and provider pickers now share a five-minute API cache keyed by provider,
endpoint and credential identity. Reopening or expanding a picker rechecks
freshness. Refresh bypasses it for every configured provider in the picker and
refreshes reasoning metadata. Endpoint/key changes invalidate snapshots after
the credentials are saved; selecting another model reuses the same list.
Successful responses replace membership, including removals and empty lists.
Failures show the existing retry notice, retain the previous picker snapshot,
and remain retryable. Late requests cannot overwrite newer refreshes.

Desktop discovery identifies itself with the shared Agente user agent, retains
provider headers, bypasses HTTP caches and follows declared pagination. These
rules are shared by provider adapters; no model allowlist was added. The live
endpoints returned 36 Go models and 466 OpenRouter models during verification
on 2026-10-02. The endpoints are documented in [Go](https://opencode.ai/docs/go/)
and [OpenRouter](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

Verification: 1,023 renderer tests passed (one optional live test skipped),
21 provider/HTTP/connection tests passed, and Svelte checking reported zero
errors/warnings. An actual Electron picker test exercised its Refresh button
through IPC and mutable HTTP catalogs: both providers updated, retired rows
disappeared, concurrent requests were shared, and selecting a model caused no
extra listing request. The conversation/context/SQLite smoke test still passed.

Run that fixture against the dev renderer:

```bash
cd apps/desktop
npx esbuild tests/electron/model-discovery.smoke.ts --bundle --platform=node \
  --format=cjs --external:electron \
  '--define:import.meta.url="file:///tmp/agente-model-discovery.cjs"' \
  --outfile=node_modules/.cache/agente-tests/model-discovery.cjs
AGENTE_RENDERER_URL='http://127.0.0.1:5173/?mock=1' \
  npx electron node_modules/.cache/agente-tests/model-discovery.cjs --no-sandbox
```

## Reproduce

Persistence (temporary synthetic files, removed on completion):

```bash
cargo run -p agente-session --example persistence_bench
```

Run a separate daemon to leave an existing app's turns alone:

```bash
cargo build --bin agente
./target/debug/agente serve --socket /tmp/agente-perf.sock
```

Read-only RPC benchmark; live turns require explicit provider/model variables:

```bash
cd apps/desktop
AGENTE_PERF_SOCKET=/tmp/agente-perf.sock npm run bench:runtime
AGENTE_PERF_SOCKET=/tmp/agente-perf.sock AGENTE_PERF_PROVIDER=opencode-go \
  AGENTE_PERF_MODEL=space-bunny-free npm run bench:runtime
```

Use a provider/model you have connected. Live turns use a temporary project
and delete their own session afterward. Reports contain timings and usage,
not keys or prompt/output text.

Electron fixtures (keep bundles under node_modules so native dependencies
resolve; the app profile/database is temporary):

```bash
cd apps/desktop
mkdir -p node_modules/.cache/agente-tests
npx esbuild tests/electron/performance.smoke.ts --bundle --platform=node \
  --format=cjs --external:electron --outfile=node_modules/.cache/agente-tests/performance.cjs
AGENTE_RENDERER_URL='http://127.0.0.1:5173/?mock=1' \
  npx electron node_modules/.cache/agente-tests/performance.cjs --no-sandbox
npx esbuild tests/electron/conversation-model.smoke.ts --bundle --platform=node \
  --format=cjs --external:electron --external:better-sqlite3 \
  '--define:import.meta.url="file:///tmp/agente-conversation-model.cjs"' \
  --outfile=node_modules/.cache/agente-tests/conversation-model.cjs
AGENTE_RENDERER_URL='http://127.0.0.1:5173/?mock=1' \
  npx electron node_modules/.cache/agente-tests/conversation-model.cjs --no-sandbox
```

Restart the development app and its existing Rust daemon to use the rebuilt
binary; rebuilding a running executable does not update the existing process.

## Queue, interruption and child execution (2026-10-03)

The hosted-tool branch was awaited inline before joining the parallel batch.
Two foreground children therefore ran serially even with parallel execution
modes. Hosted calls now enter the same JoinSet as ordinary parallel calls;
child admission limits, permissions, write isolation and result ordering remain
in the host. Child results use the final assistant message and preserve its
complete content. The 4,000-character handoff cutoff was removed. Live UI
previews remain bounded; previews are not the returned child result.

The regression `foreground_children_overlap_and_return_complete_results`
executes the actual hosted tool batch, child threads and result retrieval against
a controlled provider with a 150 ms delay per completion. Before the batch fix,
two children took 310.20 ms with peak concurrency one. After the fix they took
157.65 ms with peak concurrency two. Both inline results and task_output retained
the end of a 30 KB Unicode answer. This isolates orchestration overhead; it does
not measure a remote model's token generation speed.

Enter during a run now saves an editable per-conversation prompt above the
composer, without adding a transcript bubble. Empty Enter again sends it now.
Code wakes and cancels only the unfinished model completion; once a tool call
has started, its tool round completes before the input is injected. Home ends
its active request, saves the partial reply, and starts the queued continuation
from its finally handler. Stop leaves pending input editable. Inline Send now
saves the current editor text first. Draft-only SQLite writes include pending
prompts and attachments, without rewriting transcript history.

Elapsed time is accumulated across active intervals, excluding stopped gaps.
The activity line follows explicit engine request, reasoning, text, tool,
approval, retry and compaction events. A quiet interval adds a factual absence
of updates rather than replacing the activity with a guessed waiting state.

Validation includes core/runtime/session regressions, renderer queue and clock
tests, a real Electron queue editor smoke and SQLite close/reopen persistence.
The Electron fixture uses an isolated mock conversation: it checks edit-before-
send, removal, owner interruption, absence of premature bubbles and computed
14 px prose. Provider interruption is exercised separately by a controlled Rust
stream that stalls until the new prompt cancels it. Neither test sends paid API
requests.

```bash
cargo test -p agente-core -p agente-runtime -p agente-session
cd apps/desktop/renderer
npx vitest run
npm run check
cd ..
npm run build:main
npm run build:renderer
npx esbuild tests/electron/prompt-queue.smoke.ts --bundle --platform=node \
  --format=cjs --external:electron --outfile=/tmp/agente-prompt-queue-smoke.cjs
AGENTE_RENDERER_URL='http://127.0.0.1:5173/?mock=1' \
  npx electron /tmp/agente-prompt-queue-smoke.cjs --no-sandbox
```

Final checks: 1,039 renderer tests passed (one optional live-provider test
skipped); core 405, transport integrations 3, runtime 34, session 13 and one
core doctest passed (one ignored live test). Main-process regression fixtures
passed, and actual Electron SQLite verified persistence where the system Node
SQLite ABI was unavailable. Svelte reported zero errors and zero warnings;
main/renderer builds and the Rust development executable succeeded. The queue
was visually inspected in both themes, including a reduced-motion theme switch.

## Live controls, attachment previews, and compaction

Thinking changes now notify the running turn and restart an unfinished provider
request with the new setting. Mode restrictions are rebuilt for each request;
new child agents use the current parent mode. Session permission engines remain
independent, and untrusted turns cannot enter Build or Auto through this path.
Tools already executing finish their round before the next request.

Agent settings offer **Compact now** (local trimming, no model call),
**Summarize and compact** (the selected conversation model), and an automatic
summarization switch. Manual smart compaction bypasses the automatic threshold,
preserves recent messages, and falls back to trimming if summarization fails.
A session reservation prevents compaction from racing a new turn. The RPC
response carries a token receipt directly, so an idle chat can persist its
report without relying on a temporary event subscription or a streaming reply.
Context sizes are estimates; model usage is provider-reported and is labelled
unreported when absent. Automatic summarization usage also enters call spend.

Code composer and message bubbles share an attachment card. Image thumbnails
resolve only imported files in the attachment store; other formats show compact
file tiles. Preview caching includes the requested size. Copy uses Electron's
native clipboard before browser fallbacks and keeps the complete Unicode text.

Verification: 1,089 renderer tests passed (one optional live test skipped),
411 core tests passed (one optional live test ignored), 35 runtime tests passed,
and daemon tests passed. Svelte reported zero errors and zero warnings; desktop
main/renderer builds, workspace checking, and the Rust agent build succeeded.
A real isolated Electron smoke checked the rendered image preview, manual and
smart compaction controls, a persistent token report, and an intact 17 KB Unicode
clipboard write. The preview fixture is scripted; imported-file path validation
and the native streaming interruption are covered separately by Rust tests.
No paid provider requests were used for these checks.

```bash
cd apps/desktop
# Start a separate Vite renderer on port 5174 with the existing dependencies.
node_modules/.bin/esbuild tests/electron/chat-controls.smoke.ts --bundle \
  --platform=node --format=cjs --external:electron \
  --outfile=/tmp/agente-chat-controls.cjs
node_modules/.bin/electron /tmp/agente-chat-controls.cjs --no-sandbox
```
