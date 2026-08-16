// ── Extension runner ───────────────────────────────────────────────────
// Loads extension factories against a fresh API object, dispatches hook
// events in registration order, and isolates failures: one broken
// extension can neither kill the loop nor poison another extension's
// result. Errors are collected and reported through onError.

import type { AgentMessage, AgentTool, ToolResult } from '../core/types.ts';
import type {
  AgenteExtensionAPI,
  AgenteExtensionCommand,
  AgenteExtensionContext,
  AgenteExtensionDefinition,
  AgenteExtensionTool,
  AgenteHookEvent,
  AgenteHookHandler,
  AgenteHookPayload,
  AgenteHookResult
} from './extension-api.ts';

export class ExtensionRunner {
  readonly tools: AgentTool[] = [];
  readonly commands = new Map<string, AgenteExtensionCommand & { name: string }>();
  readonly loaded: string[] = [];
  readonly errors: Array<{ extensionId: string; error: string }> = [];

  private handlers = new Map<AgenteHookEvent, Array<{ extensionId: string; handler: AgenteHookHandler }>>();
  private activeTools = new Set<string>();

  constructor(
    private readonly ctx: Omit<AgenteExtensionContext, 'extensionId'>,
    private readonly onError?: (extensionId: string, error: string) => void
  ) {}

  /** Run each enabled extension's setup. Later extensions can shadow earlier tools. */
  async load(definitions: AgenteExtensionDefinition[]): Promise<void> {
    for (const definition of definitions) {
      const extensionCtx: AgenteExtensionContext = { ...this.ctx, extensionId: definition.id };
      const api: AgenteExtensionAPI = {
        registerTool: (tool: AgenteExtensionTool) => {
          const adapted: AgentTool = {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            mutating: tool.mutating,
            executionMode: tool.executionMode,
            execute: (toolCallId, args, execCtx) =>
              tool.execute(args, { projectRoot: this.ctx.projectRoot, signal: execCtx.signal, onUpdate: execCtx.onUpdate })
          };
          const existing = this.tools.findIndex((t) => t.name === tool.name);
          if (existing >= 0) this.tools[existing] = adapted;
          else this.tools.push(adapted);
          this.activeTools.add(tool.name);
        },
        registerCommand: (name: string, command: AgenteExtensionCommand) => {
          this.commands.set(name, { ...command, name });
        },
        on: (event: AgenteHookEvent, handler: AgenteHookHandler) => {
          const list = this.handlers.get(event) ?? [];
          list.push({ extensionId: definition.id, handler });
          this.handlers.set(event, list);
        },
        getActiveTools: () => Array.from(this.activeTools),
        setActiveTools: (names: string[]) => {
          this.activeTools = new Set(names);
        }
      };
      try {
        await definition.setup(api);
        this.loaded.push(definition.id);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.errors.push({ extensionId: definition.id, error: message });
        this.onError?.(definition.id, message);
      }
    }
  }

  /** Dispatch one hook; merge results — first block/terminate wins. */
  async dispatch(payload: AgenteHookPayload): Promise<AgenteHookResult> {
    const registered = this.handlers.get(payload.event) ?? [];
    let merged: AgenteHookResult = {};
    for (const { extensionId, handler } of registered) {
      try {
        const result = await handler(payload, { ...this.ctx, extensionId });
        if (result) {
          if (result.block && !merged.block) merged.block = result.block;
          if (result.terminate) merged.terminate = true;
          if (result.content !== undefined) merged.content = result.content;
          if (result.isError !== undefined) merged.isError = result.isError;
          if (result.details !== undefined) merged.details = result.details;
          if (result.rewritten) merged.rewritten = result.rewritten;
        }
      } catch (err: unknown) {
        // A throwing hook is contained: recorded, skipped, run continues.
        const message = err instanceof Error ? err.message : String(err);
        this.errors.push({ extensionId, error: message });
        this.onError?.(extensionId, message);
      }
    }
    return merged;
  }

  /** The `context` hook: extensions may rewrite messages before each LLM call. */
  async applyContextHooks(messages: AgentMessage[]): Promise<AgentMessage[]> {
    let current = messages;
    for (const { extensionId, handler } of this.handlers.get('context') ?? []) {
      try {
        const result = await handler({ event: 'context', messages: current }, { ...this.ctx, extensionId });
        if (result?.rewritten) current = result.rewritten;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.errors.push({ extensionId, error: message });
        this.onError?.(extensionId, message);
      }
    }
    return current;
  }

  /** Merge a tool_result hook outcome onto the raw result. */
  mergeToolResult(raw: ToolResult, hook: AgenteHookResult): ToolResult {
    return {
      ...raw,
      ...(hook.content !== undefined ? { content: hook.content } : {}),
      ...(hook.isError !== undefined ? { isError: hook.isError } : {}),
      ...(hook.details !== undefined ? { details: hook.details } : {}),
      ...(hook.terminate ? { terminate: true } : {})
    };
  }

  enabledToolNames(): Set<string> {
    return new Set(this.tools.map((tool) => tool.name).filter((name) => this.activeTools.has(name)));
  }

  listCommands(): Array<{ name: string; description: string }> {
    return Array.from(this.commands.values()).map(({ name, description }) => ({ name, description }));
  }
}
