import { buildCurrentDateTimeContext } from '../utils/current-time-context';

const CHART_HINT = '\n\nWhen the user asks for a graph, chart, or visual data representation, output a chart block using this exact format:\n' +
  '<chart type="bar|line|pie|donut" title="Chart Title" xlabel="X axis label" ylabel="Y axis label">\n' +
  '{"labels":["A","B","C"],"datasets":[{"label":"Series","data":[10,20,30]}]}\n' +
  '</chart>\n' +
  'Supported types: bar, line, pie, donut. The JSON must be valid. Do not return raw chart JSON by itself and do not wrap chart JSON in markdown code fences unless it is inside the chart block. You may include multiple chart blocks in a single response.';

export function sharedAssistantStylePrompt(): string {
  return [
    'Write in Flaxeo Chat\'s normal assistant style regardless of backend.',
    'Keep answers clear, polished, and concise unless the user asks for depth.',
    'Use markdown structure only when it helps scanning.',
    'Never expose internal tool traces, raw payloads, model chatter, or hidden reasoning in the visible answer.'
  ].join('\n');
}

export function selectBaseSystemPrompt(params: {
  backendMode: 'api' | 'local';
  localPrompt?: string;
  providerPrompt?: string;
  globalPrompt?: string;
}): string {
  if (params.backendMode === 'local') {
    return params.localPrompt?.trim() || params.globalPrompt?.trim() || '';
  }
  return params.providerPrompt?.trim() || params.globalPrompt?.trim() || '';
}

export function buildSearchSystemPrefix(now = new Date()): string {
  return `${buildCurrentDateTimeContext(now)} ` +
    'You are a helpful assistant with access to real-time web search results. ' +
    'The user\'s message includes fresh web data retrieved moments ago. ' +
    'Ground your response in the provided search results — present facts, figures, and details from the sources. ' +
    'Always attribute information to its source when possible. ' +
    'If the search results are insufficient to answer fully, state what you found and what is missing.';
}

export function buildSystemPrompt(params: {
  basePrompt: string;
  userName?: string | null;
  searchSystemPrefix?: string;
  includeChartHint?: boolean;
  currentDate?: Date;
}): string {
  let systemPrompt = params.basePrompt.trim();
  const stylePrompt = sharedAssistantStylePrompt();
  systemPrompt = systemPrompt ? `${stylePrompt}\n\n${systemPrompt}` : stylePrompt;

  const dateTimeContext = buildCurrentDateTimeContext(params.currentDate);
  systemPrompt = `${dateTimeContext}\n\n${systemPrompt}`;

  if (params.userName?.trim()) {
    const userIdentity = `The user's name is ${params.userName.trim()}. Address them by name when appropriate.`;
    systemPrompt = systemPrompt ? `${userIdentity}\n\n${systemPrompt}` : userIdentity;
  }

  if (params.searchSystemPrefix) {
    systemPrompt = systemPrompt
      ? `${params.searchSystemPrefix}\n\n${systemPrompt}`
      : params.searchSystemPrefix;
  }

  if (params.includeChartHint) {
    systemPrompt = systemPrompt ? `${systemPrompt}${CHART_HINT}` : CHART_HINT.trim();
  }

  return systemPrompt;
}
