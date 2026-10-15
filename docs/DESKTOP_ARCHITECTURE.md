# Desktop architecture

The desktop has three execution boundaries. Keep code on the side that owns its
state and privileges rather than reaching through the boundary for convenience.

| Boundary | Owns | Should not own |
| --- | --- | --- |
| `main/` | Files, processes, credentials, IPC handlers, native libraries and Rust-runtime adapters | Screen state or renderer components |
| `shared/` | Cross-process contracts, protocol types and deterministic data transformations | Window state, Electron objects or renderer stores |
| `renderer/src/lib/features/` | Feature behavior, views and feature-local state | Native process control or credential storage |
| `renderer/src/lib/components/ui/` | Reusable controls, layouts, interaction styles and accessibility | Agent business rules or provider-specific request fields |

`renderer/src/lib/ui/` is the generated-UI content renderer, not a second app
control library. Its adapters use the app's primitives. The HTML widget kit is
sandboxed content and cannot mount Svelte app components inside its frame.

## Chat service

`renderer/src/lib/services/chat-api.ts` remains the compatible transport and
model-discovery facade. Its pure implementation modules now have specific owners:

| Module | Responsibility |
| --- | --- |
| `chat/types.ts` | Message, tool and completion contracts; no runtime imports |
| `chat/messages.ts` | Request-history formatting, image limits and attachment notes |
| `chat/completion.ts` | Provider response/tool-call parsing and usage normalization |
| `chat/structured-response.ts` | JSON extraction from completed response text |
| `reasoning-route.ts` | Provider/model identity for thinking capabilities |

Prefer `chat/types` for type-only consumers. The facade preserves used imports
while callers migrate. Pure modules must not import stores, IPC or network
clients; `chat/boundaries.spec.ts` enforces that boundary.

Main-process document readers use `document-conversion-types.ts` for their result
contract. HTML conversion and table formatting live in `document-html.ts` and
`document-tables.ts`. EPUB and format readers do not import the conversion dispatcher
to obtain a type or render a chapter.

## Cleanup completed

- Retired the unused structured-output request, validation and retry pipeline.
  Research still uses the extracted JSON response reader.
- Retired the old renderer agent-provider adapter, the unused tool-call adapter,
  developer-console formatting helpers, and the orphaned stateful JavaScript
  Agent wrapper. Tests specific to those retired implementations were removed;
  active runtime, parser, queue and tool-execution tests remain.
- Removed duplicate checkbox/radio interaction styles and twelve obsolete
  generated-renderer CSS rules. Generated text callouts use the shared component.
- Removed unused direct `d3-axis` and `d3-selection` dependencies. Kept D3 modules
  actually used by charts and maps.
- Declared the existing packaging dependency `@electron/asar` explicitly.
- Corrected analyzer entry points for the database worker, browser extension,
  package hooks and diagnostic scripts. `ffprobe-static` resolves through native
  runtime paths, and `agente:snapshot` is an esbuild-provided virtual module.
- Distinguished settings-navigation types from settings-only sections.
- Updated the prompt-parity check to compare the current contracts byte for byte
  instead of pinning obsolete wording. Runtime prompt text was preserved.

Retired source contents, including preexisting uncommitted edits, were copied to
`.agente/validation/cleanup/retired/` before removal.

## Model responsibility division

`stores/models/` now owns the model domain behind the existing app-store facade:

| Owner | Owns | Dependencies supplied by the host |
| --- | --- | --- |
| `model-discovery.svelte.ts` | Catalog options, loading state, overlapping request ordering and route validation | Current configuration, cached catalog, cloud fetch and local discovery |
| `thinking-capabilities.svelte.ts` | Capability query construction, route provenance, freshness and cancellation | Current configuration, capability fetch and accepted-result callback |
| `model-settings.ts` | Provider/model setting commands and immutable configuration changes | Configuration snapshot and commit operation |
| `app.svelte.ts` | Conversation ownership, persistence boundary and public compatibility API | The controllers above |

Home and each Code pane use the same thinking-capability controller with different
configuration owners. A pane cancels its controller when its effect is disposed;
late responses cannot update the new pane or route. Provider-native levels still
come from the shared core; these controllers do not invent model capabilities.

Settings commands read one snapshot per operation. The host pins the owning
conversation before awaiting persistence and removes renderer-held credentials
after handing them to main. Those responsibilities remain at the host boundary,
where the conversation and persistence lifecycle are known.

The public model-list and capability properties remain available as reactive
facade accessors. Existing view components therefore retain their API while state
and request sequencing move to their respective owners.

## Shared behavior across spaces

`spaces.ts` owns composer-mode policy for Home, Code, Roleplay and Design. The
legacy normalization facade delegates there so persisted chat choices and new
sessions cannot acquire separate mode rules. All renderer clipboard writes use
`utils/clipboard.ts`, including Design export/handoff, spreadsheet selections and
local-model settings; native and browser fallbacks have one owner.

`components/ui/TileMeter.svelte` owns the rain animation markup used by every
chat. `utils/activity-meter.ts` owns its generic busy/quiet/attention/stopped
policy; Code's adapter supplies its run-specific status. Pending replies,
reasoning, tool execution, research, Bots and roleplay memory summaries use the
same component. The old feather and tool-spinner animations were removed.
Reduced-motion behavior stays in the existing shared theme styles.

## Design workspace ownership

`design-workspace.svelte.ts` owns workspace files, versions, loading state and
request ordering through injected read operations. `design.svelte.ts` keeps
canvas selection, comments, viewport, pane preferences and its compatibility
facade. Main retains filesystem access and path validation.

A workspace generation invalidates reads when leaving or reopening a design;
independent read/version sequences reject older responses. Finishing an older
read cannot clear a newer read's loading state. Failed inline edits and completed
variant promotion cannot change another design's canvas after a chat switch.

Verification for this pass uses small test selections with one worker and
sequential component compilation. Full regression tests and production builds were not completed; further heavy
checks and Electron runs were avoided at the user's request to conserve resources.
The final focused selection passed 26 tests; 21 changed Svelte components and
four reactive controllers compiled without warnings. Model-controller checks
also passed nine focused tests.

## Next priorities

1. Continue splitting `app.svelte.ts` by state ownership: conversations/turns,
   local-model lifecycle and workspace navigation. Model discovery, provider
   settings and thinking capabilities now have separate controllers behind the
   compatibility facade; move the remaining areas with their tests one at a time.
2. Move app-bound Home-tool dependency creation to the composition boundary.
   Domain handlers already accept `HomeToolDeps`; their dependencies should be
   supplied by the owning conversation, not discovered from a global active tab.
3. Review remaining unused exports individually. An exported type, public facade
   or registered callback is not automatically dead because production JavaScript
   does not reference it directly.
4. Measure startup, rendering and memory before changing lazy loading or caches.
   Monaco and office readers already load dynamically. Preserve their existing
   source-switch cancellation and virtualized rendering behavior.

Recursive step/subagent components intentionally form a render cycle. Keep that
separate from avoidable store/service dependency cycles. Renderer and shared-core
`ToolResult` contracts also mean different things: one carries UI/artifact data,
the other carries model-facing tool output. They should not be merged by name.

## Maintenance checks

From `apps/desktop`:

- `npm run check`: renderer type and Svelte diagnostics.
- `npm run audit:ui`: shared-control ownership inventory.
- `npm run fallow:dead-code`: reachability/dependency audit.
- `npm run fallow:dupes` and `npm run fallow:health`: duplication and complexity.
- Run renderer tests from `renderer/`, and relevant main-process tests under
  `tests/unit/`. Validate both bundles after changes across execution boundaries.

Do not auto-delete analyzer findings. Verify build entry points, virtual imports,
packaging references and test/benchmark ownership first. Do not reset baselines
merely to hide outstanding debt.

## Verified cleanup snapshot

| Check | Before | After |
| --- | ---: | ---: |
| Chat facade size | 1,225 lines | 678 lines |
| Application store size, model split | 3,772 lines | 3,631 lines |
| Production files reported unused | 19 | 0 |
| Unused direct dependencies reported | 3 | 0 |
| Unlisted dependencies | 2 | 0 |
| Circular import chains | 22 | 21 |

Entry-point fixes account for part of the audit improvement; nineteen files were
not deleted. Four unused implementation modules were retired. One reported
native dependency was retained because its binary is used through runtime paths.
Unused export/type findings remain, and the large application store remains the
main refactoring priority. The first pass improves ownership and dependency
hygiene; it does not claim a measured startup or runtime speedup.

Validation: 1,559 renderer regression tests passed (one optional live test skipped),
nine focused boundary/navigation checks, sixteen loop/prompt checks and twenty-one
document conversion checks passed. Svelte/type diagnostics reported zero errors
and warnings, and both production bundles built successfully.
