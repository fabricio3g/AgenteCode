# Electron Integration (`agente serve` Daemon Architecture)

> Note: The former in-process N-API crate (`crates/agente-node`) has been retired in favor of the persistent Rust daemon (`agente serve`, `crates/agente-daemon`), which Desktop, `agente attach`, and ACP share over line-delimited JSON-RPC 2.0.

## Architecture

```text
Electron Renderer (Code / Home / Design / Roleplay)
  -> Electron Main Process (thin IPC + Desktop extension host)
    -> AgenteClient (local Unix socket / Windows named pipe, JSON-RPC 2.0)
      -> agente serve (crates/agente-daemon)
        -> agente-runtime (RuntimeSupervisor, sessions, edits, turns)
          -> agente-core (providers, thinking, tools, permissions, web, media, processes, MCP)
```

## Responsibilities

- **Rust Core / Daemon owns:**
  - All provider specs (`crates/agente-core/providers/*.toml`), wire formats (OpenAI, Anthropic, Responses, Google), streaming (`llm.stream` / `llm.cancel`), one-shot completions (`llm.complete`), title generation (`session.generate_title`), connection testing (`providers.test`), and auth (`auth.json` + env vars).
  - Model discovery (`models.discover`), live catalog refresh (`models.refresh_catalog`), capabilities (`models.info`), and thinking profiles/request bodies (`models.thinking`, `thinking.request`, `thinking.template`).
  - Turn execution (`turn.start`, `turn.exec`, `turn.cancel`, `turn.update`, `turn.steer`, `approval.respond`), subagent tracking (`children.list`, `children.cancel`), compaction (`session.compact`), and atomic file rollback (`edits.undo`, `edits.redo`, `edits.rewind`, `edits.rollback_to_turn`).
  - Core tools: workspace files, `.gitignore`-aware project indexing (`project.files`), background processes (`processes.{start,list,output,stop,prune}` + real-time `process.event` push), content-addressed media (`media.import`, `media.preview_path`), and SSRF-safe web search/fetch (`web.search`, `web.fetch`, `web.sync`).
- **Electron Desktop extends:**
  - Desktop UI shell, native OS dialogs, window management, notifications, and spaces.
  - Desktop-specific extensions registered via `client_tools` / complements: embedded browser panel (`agente-bridge`), computer use (`agente-computer`), local `llama.cpp` supervisor, Whisper STT / `audio.cpp` TTS, RAG/office document ingestion, Design/Blender canvas, and Calendar/live-data integrations.

## Relevant Files

- `crates/agente-daemon/src/connection/` — JSON-RPC 2.0 server, async task dispatch, push subscriptions (`event`, `turn.outcome`, `llm.chunk`, `process.event`, `client_tools.call`).
- `apps/desktop/main/agente-client.ts` & `apps/desktop/main/agente-daemon.ts` — daemon lifecycle and JSON-RPC client.
- `apps/desktop/main/agente/rust-engine.ts`, `home-runtime.ts`, `rust-processes.ts`, `chat-ipc.ts` — main-process bridges into the daemon.
- `docs/DESKTOP_ARCHITECTURE.md` & `docs/SERVER.md` — desktop boundary rules and headless server setup.
