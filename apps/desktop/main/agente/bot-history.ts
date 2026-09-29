// ── A bot's saved conversation, as the Code UI's events ─────────────────
// A bot's chat lives in its runtime session. To show it with the same run
// rendering the live stream uses, each exchange is replayed as the runtime
// events it would have produced and run through RustTurnTranslator: one
// renderer path for history and for what is happening now.

import type { Message, RuntimeEvent, RuntimeEventEnvelope } from '../../shared/agente-protocol.gen.ts';
import type { CodeAgentEvent } from '../../shared/agente-protocol.ts';
import { RustTurnTranslator } from './rust-events.ts';

/** Who asked: you, a routine, or another bot handing work over. */
export type BotTurnSource = { kind: 'user' } | { kind: 'routine'; title: string } | { kind: 'handoff'; from: string };

export type BotTurn = { prompt: string; source: BotTurnSource; events: CodeAgentEvent[] };

/** Project instructions the runtime adds as a user message; not something anyone said. */
const REMINDER_MARKER = '<system-reminder>';
const ROUTINE = /^Routine “(.+?)”:\n\n([\s\S]*)$/;
const HANDOFF = /^Message from @([a-z][a-z0-9-]*) \(another bot on your team\):\n\n([\s\S]*?)\n\nYour reply goes back to @[a-z0-9-]+\.$/;

/** What a turn's opening message says, and who it came from. */
export function turnSource(text: string): { prompt: string; source: BotTurnSource } {
  const routine = ROUTINE.exec(text);
  if (routine) return { prompt: routine[2], source: { kind: 'routine', title: routine[1] } };
  const handoff = HANDOFF.exec(text);
  if (handoff) return { prompt: handoff[2], source: { kind: 'handoff', from: handoff[1] } };
  return { prompt: text, source: { kind: 'user' } };
}

function envelope(event: RuntimeEvent): RuntimeEventEnvelope {
  return { event, protocol_version: 2, sequence: 0, session_id: '', timestamp: '', turn_id: '' };
}

function assistantEvents(message: Message, toolNames: Map<string, string>): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  if (message.thinking) events.push({ type: 'reasoning_delta', text: message.thinking });
  if (message.content.trim()) events.push({ type: 'assistant_delta', text: message.content });
  for (const call of message.tool_calls ?? []) {
    toolNames.set(call.id, call.function.name);
    events.push({ type: 'tool_proposed', id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  return events;
}

function toolResult(message: Message, toolNames: Map<string, string>): RuntimeEvent[] {
  const id = message.tool_call_id;
  if (!id) return [];
  const isError = /^Error\b/.test(message.content);
  return [{ type: 'tool_result', id, name: toolNames.get(id) ?? 'tool', content: message.content, is_error: isError }];
}

/** The runtime events one saved message stands for. */
function eventsFor(message: Message, toolNames: Map<string, string>): RuntimeEvent[] {
  if (message.role === 'assistant') return assistantEvents(message, toolNames);
  if (message.role === 'tool') return toolResult(message, toolNames);
  return [];
}

/** Split a saved conversation into turns, each with the events that render it. */
export function historyTurns(conversation: Message[], chatId: string): BotTurn[] {
  const turns: BotTurn[] = [];
  const toolNames = new Map<string, string>();
  let translator: RustTurnTranslator | null = null;
  let current: BotTurn | null = null;
  const run = (event: RuntimeEvent) => {
    if (translator && current) current.events.push(...translator.translate(envelope(event)));
  };
  const close = () => {
    run({ type: 'turn_finished', revision: 0 });
    current = null;
  };
  for (const message of conversation) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      if (message.content.includes(REMINDER_MARKER)) continue;
      if (current) close();
      translator = new RustTurnTranslator(chatId, () => 0);
      current = { ...turnSource(message.content), events: [] };
      turns.push(current);
      run({ type: 'turn_started' });
      continue;
    }
    for (const event of eventsFor(message, toolNames)) run(event);
  }
  if (current) close();
  return turns;
}
