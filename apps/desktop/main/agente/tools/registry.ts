// ── Tool registry ──────────────────────────────────────────────────────
// Registration + enable/disable + wire projection. Built-ins and extension
// tools are indistinguishable here — nothing is privileged (pi's
// dogfooding rule).

import type { AgentTool, WireTool } from '../../../shared/agent-core/types.ts';

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();
  private disabled = new Set<string>();

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.disabled.delete(name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /** Read-only view for consumers that need Map semantics (the Agent). */
  asMap(): ReadonlyMap<string, AgentTool> {
    return this.tools;
  }

  list(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  setEnabled(name: string, enabled: boolean): void {
    if (!this.tools.has(name)) return;
    if (enabled) this.disabled.delete(name);
    else this.disabled.add(name);
  }

  isEnabled(name: string): boolean {
    return this.tools.has(name) && !this.disabled.has(name);
  }

  enabledNames(): Set<string> {
    return new Set(this.list().map((tool) => tool.name).filter((name) => !this.disabled.has(name)));
  }

  toWireTools(): WireTool[] {
    return this.list()
      .filter((tool) => !this.disabled.has(tool.name))
      .map((tool) => ({
        type: 'function' as const,
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      }));
  }

  /** Snapshot for forking/templating a session's tool surface. */
  snapshot(): { tools: AgentTool[]; disabled: string[] } {
    return { tools: this.list(), disabled: Array.from(this.disabled) };
  }
}
