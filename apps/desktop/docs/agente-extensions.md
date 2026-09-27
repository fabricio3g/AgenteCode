# Agente Coding — Extensions

Agente is the coding agent living in the app's **Code** tab. Its engine runs
in the Electron main process (`main/agente/`) and is extensible at the same
level as its built-ins: the built-in tools are plain registered tools, not
privileged code.

## Extension shape

An extension is a `setup(pi)` factory receiving a capability object — the
same shape as [pi (badlogic/pi-mono)](https://github.com/earendil-works/pi),
so the future external loader (`~/.agente/extensions/*.ts` via jiti)
will load identical definitions with zero changes.

```ts
import type { AgenteExtensionDefinition } from '../agente/extensions/extension-api.ts';

export const myExtension: AgenteExtensionDefinition = {
  id: 'my-extension',
  name: 'My Extension',
  description: 'Adds a deploy tool.',
  defaultEnabled: true,
  setup(pi) {
    pi.registerTool({
      name: 'deploy',
      description: 'Deploy the current project.',
      parameters: {
        type: 'object',
        properties: { env: { type: 'string', enum: ['staging', 'prod'] } },
        required: ['env']
      },
      async execute(args, ctx) {
        // ctx.projectRoot, ctx.signal, ctx.onUpdate
        return { content: `Deployed to ${args.env}.` };
      }
    });

    pi.on('tool_call', async ({ toolName, args }) => {
      if (toolName === 'bash' && /deploy\.sh/.test(String(args?.command))) {
        return { block: 'Use the deploy tool instead.' };
      }
    });

    pi.on('context', async ({ messages }) => ({
      rewritten: messages // prune/rewrite before each LLM call
    }));

    pi.registerCommand('deploy', {
      description: 'Deploy via the composer',
      async handler(args) {
        return `Please deploy to ${args || 'staging'}.`;
      }
    });
  }
};
```

## Capability surface

| API | What it does |
| --- | --- |
| `registerTool(tool)` | Adds an LLM-callable tool (JSON Schema params, `mutating` flag participates in the approval gate, `executionMode` parallel/sequential). |
| `registerCommand(name, cmd)` | Composer slash command; the handler returns the text injected as the next user message. |
| `on(event, handler)` | Lifecycle hooks — see below. |
| `getActiveTools()` / `setActiveTools(names)` | Dynamic tool enable/disable. |

## Hook events

Handlers return values, never throw (a throwing hook is contained and
logged; the run continues). Results are merged across extensions — the first
`block` wins.

| Event | Payload | Return to affect the run |
| --- | --- | --- |
| `before_agent_start` | — | — |
| `turn_start` / `turn_end` | `turnIndex` | — |
| `message_end` | — | — |
| `tool_call` | `toolName`, `args` | `{ block, terminate }` — block fails the call; runs before the approval gate. |
| `tool_result` | `toolName`, `result` | `{ content, isError, details, terminate }` — field-wise override. |
| `context` | `messages` | `{ rewritten }` — replaces the message list for that LLM call. |

Every handler also receives a context: `{ extensionId, projectRoot,
sessionId, runtimeMode, appendEntry(type, data) }`. `appendEntry` persists
extension state into the session JSONL (survives restarts, never sent to the
LLM).

## Shipped extensions

- **Git Tools** (`git-tools`, on by default): `git_status` + `git_diff` tools.
- **Safety Rails** (`safety-rails`, on by default): blocks destructive bash
  commands (`rm -rf`, force push, fork bombs, `drop table`) before execution,
  and records run starts into the session tree.

## Enabling / disabling

Toggles live in `config.json` under `agente.extensions.{id}` and are exposed
through IPC (`agente_list_extensions`, `agente_set_extension_enabled`). The
Code tab's header has an extensions popover (puzzle icon) that flips them;
changes apply to sessions started afterwards.

## Execution order per tool call

1. `tool_call` extension hooks (policy — cheapest checks first)
2. Approval gate (supervised mode + mutating tool)
3. Checkpoint capture (pre-change file snapshot)
4. Tool execution → `tool_result` hooks (overrides) → model

## Roadmap

- External loading from `~/.agente/extensions/` and
  `<workspace>/.agente/extensions/` (jiti, pi-style discovery).
- Per-project extension sets.
- Commands surfaced in the composer UI.
