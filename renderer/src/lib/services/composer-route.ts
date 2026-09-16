import { normalizeSpace } from '$lib/spaces';

export type ComposerRoute = 'conversation' | 'tools' | 'agent';

export type ComposerModeControl = 'tabs' | 'auto';

/**
 * Deterministic intent routing for Auto composer mode (no extra LLM call).
 * - conversation: plain stream, no tool loop
 * - tools: light chat-agent tools (weather, FX, search, knowledge)
 * - agent: multi-step / files / work-style agent loop
 */
export function resolveComposerRoute(input: {
  prompt: string;
  hasAttachments?: boolean;
  searchMode?: 'chat' | 'search' | 'deep' | 'max' | null;
  contextMode?: string | null;
}): ComposerRoute {
  const prompt = String(input.prompt || '').trim();
  const lower = prompt.toLowerCase();
  const searchMode = input.searchMode || 'chat';
  const contextMode = normalizeSpace(input.contextMode);

  if (searchMode === 'search' || searchMode === 'deep' || searchMode === 'max') {
    return 'tools';
  }
  if (contextMode === 'code') {
    return 'agent';
  }
  if (input.hasAttachments) {
    return 'tools';
  }
  if (!prompt) {
    return 'conversation';
  }

  // Explicit agent / multi-step
  if (
    /\b(use tools?|as an agent|autonomous|multi[- ]?step)\b/i.test(prompt)
    || /\b(create|build|write|generate|make)\b.+\b(file|docx|xlsx|pdf|pptx|slides?|spreadsheet|document|app|website|page)\b/i.test(prompt)
    || /\b(create|build|write|generate|make|show|display|draw|plot|give|produce)\b.+\b(charts?|graphs?|diagrams?|flowcharts?|maps?|dashboards?|infographics?|html[- ]?cards?|info[- ]?cards?|fact[- ]?sheets?)\b/i.test(prompt)
    || /\b(charts?|graphs?|plots?)\b\s+(my|this|that|these|those|the|our|your)\b/i.test(prompt)
    || /\b(fix|debug|refactor|implement|install|deploy|migrate)\b/i.test(prompt)
    || /\b(edit|modify|update)\b.+\b(code|file|project)\b/i.test(prompt)
  ) {
    return 'agent';
  }

  // Live data + light research
  if (
    /\b(weather|forecast|temperature|humid|wind)\b/i.test(prompt)
    || /\b(what'?s it like|how'?s the weather)\b.+\b(in|at)\b/i.test(prompt)
    || /\b(convert|exchange|fx)\b/i.test(prompt)
    || /\b\d+(\.\d+)?\s*(usd|eur|gbp|jpy|cny|cad|aud|chf|mxn|brl)\b/i.test(lower)
    || /\b(usd|eur|gbp)\s*(to|into|in)\s*(usd|eur|gbp|jpy|cny)\b/i.test(lower)
    || /\b(stock|ticker|share price|market price)\b/i.test(prompt)
    || /\b(price of|how much is)\b.+\b(aapl|msft|tsla|btc|eth|bitcoin|ethereum|\$[a-z]{1,5})\b/i.test(lower)
    || /\b(aapl|msft|googl|tsla|nvda|amzn|meta)\b/i.test(lower)
    || /\b(btc|eth|bitcoin|ethereum|solana)\b/i.test(lower)
    || /\b(search|look up|latest|breaking|today'?s news|current (news|version|price|rate))\b/i.test(prompt)
    || /\b(who won|what happened)\b.+\b(today|yesterday|this week)\b/i.test(prompt)
  ) {
    return 'tools';
  }

  // Short social / pure chat
  if (
    prompt.length < 80
    && /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|good morning|good night|how are you)\b/i.test(prompt)
  ) {
    return 'conversation';
  }

  // Default: conversation for open-ended Q&A without tool signals
  return 'conversation';
}

export function shouldUseToolLoop(params: {
  control: ComposerModeControl;
  composerMode: 'chat' | 'instant' | 'agent';
  route: ComposerRoute;
  searchMode?: 'chat' | 'search' | 'deep' | 'max' | null;
  contextMode?: string | null;
}): boolean {
  // Instant is the fast path: the loop runs only when the heuristic intent gate
  // saw a grounding signal (live data, search, math). Anything else streams
  // a direct completion with zero tool-loop overhead.
  if (params.composerMode === 'instant') return params.route === 'tools';
  // Home is one conversational agent: the model can answer directly or call
  // tools on any turn, including follow-ups with no routing keywords. Legacy
  // mode preferences no longer disconnect tools. Code uses its workspace loop.
  return normalizeSpace(params.contextMode) === 'home' || normalizeSpace(params.contextMode) === 'code';
}
