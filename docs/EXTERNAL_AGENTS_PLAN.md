# External Coding Agents & Universal Orchestration Plan

## Goal

Turn `agente serve` into a driver-agnostic control plane where Agente Core (`agente`) and external coding CLIs (ACP-compliant agents, Claude Code, Codex, OpenCode, Pi, and custom CLI instances) operate as equal peers. Any engine can lead a session or be delegated work as a worker, sharing one session store, unified event stream, approval router, and workspace isolation layer across Desktop, TUI / `agente attach`, and remote Web/Mobile clients.

## Core Design Principles

1. **Instance-First Identity (`instance_id` vs `driver_kind`)**
   - Separate the protocol driver (`driver_kind`: `agente`, `acp`, `claude`, `codex`, `opencode`, `pi`) from configured instances (`instance_id`: e.g. `claude`, `claude-work`, `codex`, `gemini`).
   - Support profile inheritance (`extends`), environment overlays, custom binary/args overrides, and explicit `strip_env` credential isolation in `~/.agente/drivers.json`.
   - Route session persistence, model catalogs, and live handles strictly by `instance_id` so multiple accounts or endpoint profiles never collide.

2. **Honest Capabilities & Native Permissions**
   - Every driver declares `DriverCapabilities` (`models`, `thinking`, `modes`, `native_plan_cards`, `approvals`, `steer`, `resume`, `fork`, `compact`, `rewind_conversation`, `mcp_injection`, `session_import`, `attachments`, `usage`, `cost`).
   - Clients and orchestration read declared capabilities rather than branching on driver names.
   - Never emulate unsupported permission modes by silently auto-approving behind the scenes.
   - Preserve native approval option IDs (`ApprovalOption`) unchanged in `ApprovalRequested` and `ApprovalDecision`.
   - Refuse combined file + conversation rollback before mutating workspace files if `rewind_conversation` is `false`.

3. **Passive Health Checks**
   - `drivers.list` and `drivers.probe` only resolve executables, run lightweight version checks (`--version`), and inspect local readiness signals.
   - Background probes never open interactive sessions, start MCP servers, trigger hooks, or launch login flows.

4. **Universal Peer-to-Peer Orchestration**
   - Any engine—not just `agente-core`—can orchestrate other engines.
   - `agente-daemon` injects a scoped, per-session authenticated Streamable HTTP MCP server (`agente-orchestrator`) into spawned sessions (with a stdio bridge for stdio-only ACP agents and an `agente run` CLI fallback via environment tokens).
   - Guardrails enforced at the daemon boundary: scoped bearer tokens, downward-only permission mode ceilings, recursion depth caps, global concurrency limits, and human approvals bubbling straight to the active UI.

5. **Per-Session Git Worktree Isolation**
   - Promote worktree pooling from `agente-core` subagents into daemon-managed session worktrees (`worktrees_v1`) so multiple engines can edit the same repository in parallel without clobbering files.

6. **Cross-Surface Continuity**
   - All surfaces (Desktop Code, `agente attach`, and remote clients) consume the same `RuntimeEventEnvelope` stream and JSON-RPC 2.0 daemon protocol.

---

## Architecture Overview

```text
Clients:   Desktop Code   │   agente attach / TUI   │   Web / Mobile Client
                  └────────────────────┼────────────────────┘
                       JSON-RPC 2.0 (Socket / Pipe / TCP / WS)
                                       ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  agente-daemon (`agente serve`)                                            │
│   ├── git.rs + worktree.rs  (per-session isolated checkouts & PR actions)  │
│   ├── orchestrator_mcp.rs   (scoped HTTP MCP + stdio bridge + Swarm tools) │
│   └── agente-runtime        (`RuntimeHandle`, `SessionStore`, `ApprovalRouter`) │
│         ├── agente-core     (built-in default engine, `instance_id="agente"`) │
│         └── agente-drivers  (`DriverRegistry` + `AgentDriver` / `DriverSession`) │
│               ├── acp       (strict JSON-RPC 2.0 ACP client + custom/catalog) │
│               ├── claude    (bidirectional NDJSON `stream-json` + control)    │
│               ├── codex     (persistent `codex app-server` JSON-RPC 2.0)   │
│               ├── opencode  (HTTP/SSE server adapter)                      │
│               └── pi        (`pi --mode rpc` JSONL adapter)                │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Milestones

### Milestone 1 — Driver Abstraction, Protocol & Runtime Routing (Foundation)
- **`crates/agente-protocol`**: Add `DriverKind`, `DriverStatus`, `DriverModel`, `DriverCapabilities`, `DriverInstanceConfig`, `DriverInfo`, `ApprovalOption`, `SessionWorktree`; extend `StartTurn`, `SessionInfo`, `ApprovalDecision`, `RuntimeEvent::ApprovalRequested`; add `RuntimeEvent::{ModeChanged, ModelChanged, UsageLimitReached}`.
- **`crates/agente-drivers`**: Define `AgentDriver`, `DriverSession`, `ApprovalRouter`, `DriverRegistry`, `~/.agente/drivers.json` config/profile resolution (`extends` + `strip_env`), and shared `tokio::process` stdio/probe helpers (`shell: false`, Windows `CREATE_NO_WINDOW`, bounded stderr ring buffers, canonical `cwd`).
- **`crates/agente-runtime`**: Add `DriverRegistry`, live `DriverSession` tracking, and unified `ApprovalRouter` dispatch in `RuntimeHandle`; route external instances alongside `agente-core`; persist `instance_id`, `driver_kind`, and `external_session_id` in `SessionMeta`.
- **`crates/agente-daemon`**: Advertise `drivers_v1` and expose `drivers.list`, `drivers.probe`, `drivers.instances.save`, `drivers.instances.delete`, and `instance_id` on `session.open`.

### Milestone 2 — Core External CLI Drivers
- **Strict ACP Client (`acp`)**: JSON-RPC 2.0 over stdio (`initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/update`, `session/request_permission`, confined `fs/read_text_file` & `fs/write_text_file`) with zero vendor workarounds; supports ACP-capable CLIs and custom local ACP commands.
- **Claude Code (`claude`)**: Direct bidirectional NDJSON `stream-json` client (`can_use_tool` ⇄ `control_response`, native `--permission-mode`, `--resume`, `--model`, tool normalization, cost/usage, rate-limit classification).
- **Codex (`codex`)**: Persistent `codex app-server` JSON-RPC 2.0 client (128 MiB line cap, `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`, command & file-change approval requests, token usage).
- **Follow-up additions**: OpenCode HTTP/SSE server driver (`opencode`), Pi RPC driver (`pi`), and native session discovery/import (`drivers.sessions.list|import`).

### Milestone 3 — Per-Session Worktrees & Universal Orchestrator MCP
- Promote `crates/agente-core/src/subagent/worktree.rs` into daemon-level `worktree.create|list|merge|remove` RPCs (`worktrees_v1`).
- Serve scoped `agente-orchestrator` HTTP MCP from `agente-daemon` (`orchestrator_v1`), inject it into `agente`, `claude`, `codex`, `opencode`, and `acp` sessions (plus `agente mcp-bridge` stdio helper and `agente run` CLI fallback).
- Upgrade Swarm `Card` so any card can target any `instance_id`, allowing any lead CLI to coordinate mixed-engine swarms.

### Milestone 4 — Desktop Code & `agente attach` UI
- Wire `instance_id` / `driver_kind` through `apps/desktop/main/agente/rust-engine.ts` and `CodeComposer.svelte` (skipping API key preflight for external drivers, binding composer controls to `DriverCapabilities`).
- Add **Settings → External CLIs** (passive status, multi-account `extends` profiles, custom ACP entries, native session import) and worktree Diff/Merge/PR controls in `ChangesPane`.
- Add cross-agent handoff ("Continue in another agent…") and `agente attach --new --driver <instance> [--worktree]`.

### Milestone 5 — Remote Web / Mobile Control Plane
- Add authenticated WebSocket JSON-RPC transport to `agente serve` alongside local socket/pipe and TCP, with durable host IDs, QR pairing codes, and revocable per-device tokens.
- Ship a thin, mobile-first Web/PWA control surface sharing the exact daemon protocol (multi-repo attention inbox, one-tap diffs & approvals, prompt/steer, and notifications).
