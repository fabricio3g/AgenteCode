/**
 * Stop guards for the Home agent loop.
 *
 * - `createLoopGuard`: repeated calls only count as a loop while the run is
 *   also stagnating (no new sources, files, successful observations or draft
 *   growth). Three shapes: the exact same call 3+ times, the same tool name
 *   too often, or an A-B-A-B-A-B cycle.
 * - `createExploreGuard`: the Code profile's cap on read/list/search streaks
 *   that never write anything.
 */

import type { ToolCall } from '$lib/services/agent-types';
import { hasProgressSince, type ProgressSnapshot } from '$lib/services/agent-flow';

/** Tools cheap and repeatable enough that repeating them alone is not a loop. */
const LOW_IMPACT_LOOP_TOOLS = new Set(['list_files', 'read_file', 'search_files', 'query_knowledge']);
const LOOP_STAGNATION_MIN_DRAFT_GROWTH = 120;
const HISTORY = 10;

interface LoopVerdict {
  /** The tool (or `a ↔ b` cycle) the run is stuck on; null when it is fine. */
  stuckTool: string | null;
  /** A repeat was seen but progress is still being made, so it was let through. */
  suppressed: string | null;
}

export function createLoopGuard(options: { localMode: boolean; isResearchChat: boolean }) {
  const signatures: string[] = [];
  const progress: ProgressSnapshot[] = [];

  function exactRepeat(calls: string[], stagnating: boolean): string | null {
    const counts = new Map<string, number>();
    for (const call of calls) counts.set(call, (counts.get(call) || 0) + 1);
    for (const [call, count] of counts) {
      if (count < 3) continue;
      const toolName = call.split(':')[0];
      if (!LOW_IMPACT_LOOP_TOOLS.has(toolName) || stagnating) return toolName;
    }
    return null;
  }

  function nameRepeat(names: string[]): string | null {
    // Local models get a tighter guard: each extra loop is much more expensive.
    const limit = options.localMode ? 4 : 6;
    const counts = new Map<string, number>();
    for (const name of names) {
      if (name === 'fetch_url' || LOW_IMPACT_LOOP_TOOLS.has(name)) continue;
      if (options.isResearchChat && name === 'web_search') continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    for (const [name, count] of counts) if (count >= limit) return name;
    return null;
  }

  function twoToolCycle(names: string[]): string | null {
    if (names.length < 6) return null;
    const last6 = names.slice(-6);
    const cycling = new Set(last6).size === 2
      && last6[0] === last6[2] && last6[2] === last6[4]
      && last6[1] === last6[3] && last6[3] === last6[5];
    if (!cycling) return null;
    const onlyLowImpact = [...new Set(last6)].every((name) => LOW_IMPACT_LOOP_TOOLS.has(name));
    return onlyLowImpact ? null : `${last6[0]} ↔ ${last6[1]}`;
  }

  return {
    /** Record one turn's calls and the run's progress after it was planned. */
    observe(toolCalls: ToolCall[], snapshot: ProgressSnapshot): LoopVerdict {
      signatures.push(toolCalls.map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`).join('|'));
      if (signatures.length > HISTORY) signatures.shift();
      progress.push(snapshot);
      if (progress.length > HISTORY) progress.shift();

      const calls = signatures.flatMap((sig) => sig.split('|')).filter(Boolean);
      const names = calls.map((call) => call.split(':')[0]);
      const window = Math.min(signatures.length, 6);
      const stagnating = !hasProgressSince(progress.slice(-Math.max(2, window)), LOOP_STAGNATION_MIN_DRAFT_GROWTH);

      const exact = exactRepeat(calls, stagnating);
      // Repeats only stop the run when they coincide with stagnation.
      if (!stagnating) return { stuckTool: null, suppressed: exact };
      return { stuckTool: exact || nameRepeat(names) || twoToolCycle(names), suppressed: null };
    }
  };
}

/** Stop exploring if this many consecutive calls are browse-only with no write/bash. */
const CODE_MAX_CONSECUTIVE_EXPLORE = 8;
const EXPLORE_TOOLS = new Set([...LOW_IMPACT_LOOP_TOOLS, 'web_search', 'fetch_url', 'get_diagnostics']);
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'bash']);

export function createExploreGuard() {
  let streak = 0;
  return {
    get streak() {
      return streak;
    },
    /** `nudge` asks the model to act; `stop` ends the run. */
    observe(toolCalls: ToolCall[]): 'ok' | 'nudge' | 'stop' {
      if (!toolCalls.length) return 'ok';
      if (toolCalls.some((tc) => MUTATING_TOOLS.has(tc.name))) streak = 0;
      else if (toolCalls.every((tc) => EXPLORE_TOOLS.has(tc.name))) streak += toolCalls.length;
      if (streak >= CODE_MAX_CONSECUTIVE_EXPLORE + 4) return 'stop';
      if (streak >= CODE_MAX_CONSECUTIVE_EXPLORE) return 'nudge';
      return 'ok';
    }
  };
}
