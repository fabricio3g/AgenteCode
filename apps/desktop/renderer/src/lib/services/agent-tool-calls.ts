/**
 * Turning one model reply into tool calls.
 *
 * Replies arrive in several dialects: native function calls, the XML
 * `<tool_call>` contract, fenced tool blocks, the tagless shape small models
 * fall back to, and — for website builds — plain code blocks that are really
 * file writes. Each parse also yields the assistant message to append, so
 * the provider history stays paired with the calls that will run.
 */

import type { CompletionResult, NativeToolCall, RequestMessage } from '$lib/services/chat-api';
import type { ToolCall } from '$lib/services/agent-types';
import {
  parseXmlToolCall, parseToolCallCodeblocks, parseDegradedXmlToolCalls,
  stripToolCallArtifacts, parseCodeblockWrites
} from '$lib/services/agent-parsing';

const PREPARING = 'Preparing to use tools…';

/** Website code blocks as write_file calls, plus a preview when there is HTML. */
export function websiteWritesFromCodeblocks(rawContent: string): { toolCalls: ToolCall[]; cleanContent: string } | null {
  const files = parseCodeblockWrites(rawContent);
  if (!files.length) return null;
  const toolCalls: ToolCall[] = files.map((file, index) => ({
    id: `auto-write-${index}`,
    name: 'write_file',
    arguments: { path: file.path, content: file.code }
  }));
  if (files.some((file) => file.path === 'index.html' || file.path.endsWith('.html'))) {
    toolCalls.push({ id: 'auto-preview', name: 'preview_project', arguments: { entryPoint: 'index.html' } });
  }
  return { toolCalls, cleanContent: stripToolCallArtifacts(rawContent.replace(/```[\s\S]*?```/g, '').trim()) };
}

export interface ExtractedToolCalls {
  toolCalls: ToolCall[];
  cleanContent: string;
  /** What to append to the provider history; null when there is nothing to run. */
  assistantMessage: RequestMessage | null;
  /** The model answered in a text dialect, so native tool calling is off for the run. */
  textDialect: boolean;
}

/**
 * Parse a non-direct-mode reply. Native calls win when native tools are in
 * use; otherwise the text dialects are tried in order of strictness.
 */
export function extractToolCalls(params: {
  rawContent: string;
  completion: Partial<Pick<CompletionResult, 'toolCalls' | 'providerState' | 'reasoning'>>;
  iter: number;
  nativeInUse: boolean;
  wantsWebsiteArtifact: boolean;
}): ExtractedToolCalls {
  const { rawContent, completion, iter } = params;

  if (params.nativeInUse && completion.toolCalls?.length) {
    const toolCalls = completion.toolCalls.map((tc: NativeToolCall, index: number) => ({
      id: tc.id || `call_${iter}_${index}_${Math.random().toString(36).slice(2, 8)}`,
      name: tc.name,
      arguments: tc.arguments
    }));
    // DeepSeek (and similar) require reasoning_content on tool-using assistant turns
    // to be echoed on all subsequent requests — omitting it yields HTTP 400.
    const assistantMessage: RequestMessage = {
      role: 'assistant',
      content: rawContent || null,
      ...(completion.providerState ? { providerState: completion.providerState } : {}),
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id!,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
      }))
    };
    if (completion.reasoning) assistantMessage.reasoning_content = completion.reasoning;
    return { toolCalls, cleanContent: rawContent, assistantMessage, textDialect: false };
  }

  const textCalls = (toolCalls: ToolCall[], clean: string): ExtractedToolCalls => {
    const cleanContent = stripToolCallArtifacts(clean);
    return {
      toolCalls,
      cleanContent,
      assistantMessage: { role: 'assistant', content: cleanContent || PREPARING },
      textDialect: true
    };
  };

  const xml = parseXmlToolCall(rawContent);
  if (xml.toolCall) return textCalls([xml.toolCall], xml.cleanContent);

  const fenced = parseToolCallCodeblocks(rawContent);
  if (fenced.toolCalls.length) return textCalls(fenced.toolCalls, fenced.cleanContent);

  // Small models often emit the tagless shape (`name="web_search"> name="query">…`)
  // when the XML contract does not stick — recover it instead of finalizing the draft.
  const degraded = parseDegradedXmlToolCalls(rawContent);
  if (degraded.toolCalls.length) {
    return textCalls(
      degraded.toolCalls.map((toolCall, index) => ({ id: `degraded-${iter}-${index}`, name: toolCall.name, arguments: toolCall.arguments })),
      degraded.cleanContent
    );
  }

  const site = params.wantsWebsiteArtifact ? websiteWritesFromCodeblocks(rawContent) : null;
  if (site) {
    return {
      toolCalls: site.toolCalls,
      cleanContent: site.cleanContent,
      assistantMessage: { role: 'assistant', content: site.cleanContent || 'Files have been written and are ready for preview.' },
      textDialect: true
    };
  }

  return { toolCalls: [], cleanContent: rawContent, assistantMessage: null, textDialect: false };
}

/**
 * Recover the known map-widget dialect (`maps` with `center`) without
 * changing the provider's call IDs or signed history. Execution still
 * validates the schema and honors the artifact toggle.
 */
export function normalizeMapCalls(toolCalls: ToolCall[], nativeInUse: boolean): ToolCall[] {
  return toolCalls.map((call) => {
    if (call.name !== 'create_map' && !(call.name === 'maps' && !nativeInUse)) return call;
    const { center, ...parameters } = call.arguments;
    return {
      ...call,
      name: 'create_map',
      arguments: {
        ...parameters,
        ...(typeof center === 'string' && !parameters.place ? { place: center } : {})
      }
    };
  });
}
