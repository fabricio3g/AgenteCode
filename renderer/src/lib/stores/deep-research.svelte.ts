import type { SearchResult } from '$lib/types/tauri';
import { completeAssistantReply, extractJsonFromResponse, type RequestMessage, validateStructuredOutput } from '$lib/services/chat-api';
import { listen, invoke, isTauri } from '$lib/services/tauri';
import { webSearch } from '$lib/services/search';

type DeepResearchStatus = 'queued' | 'awaiting_input' | 'searching' | 'crawling' | 'synthesizing' | 'completed' | 'failed' | 'cancelled';

export interface ResearchQuestion {
  id: string;
  question: string;
  hint?: string;
}

export interface DeepResearchTask {
  id: string;
  chatId: string;
  messageId: string;
  chatTitle: string;
  query: string;
  mode: 'deep' | 'max';
  status: DeepResearchStatus;
  createdAt: number;
  updatedAt: number;
  currentStep: string;
  detail: string;
  progressLog: Array<{ step: string; detail: string; at: number }>;
  providerUsed?: string | null;
  results: SearchResult[];
  context: string;
  summary: string;
  error?: string | null;
  questions: ResearchQuestion[];
  answers: Record<string, string>;
  enhancedQuery?: string;
  crawlStats?: {
    pages_crawled: number;
    pages_discovered: number;
    truncated: boolean;
    max_depth_reached: number;
  } | null;
}

const STORAGE_KEY = 'talamolm_deep_research_tasks_v2';

const QUESTION_SCHEMA = {
  name: 'research_questions',
  description: 'Generate clarifying questions before deep research.',
  schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            hint: { type: 'string' }
          },
          required: ['question']
        }
      }
    },
    required: ['questions']
  }
} as const;

const QUESTION_TIMEOUT_MS = 1800;
const QUESTION_TOKEN_THRESHOLD = 14;
const questionCache = new Map<string, { questions: ResearchQuestion[]; expires: number }>();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);

    void promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

function tokenCount(text: string) {
  return normalizeWhitespace(text).toLowerCase().match(/[a-z0-9]+/g)?.length || 0;
}

function shouldAskClarifyingQuestions(query: string, mode: 'deep' | 'max') {
  const tokens = tokenCount(query);
  if (tokens === 0) return false;
  // Keep UX fast: ask only when query is broad/short.
  if (tokens > QUESTION_TOKEN_THRESHOLD) return false;
  if (mode === 'max') return true;
  return tokens <= 10;
}

function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeWhitespace(text: unknown) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function persistTasks(tasks: DeepResearchTask[]) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.slice(0, 20)));
}

function loadTasks(): DeepResearchTask[] {
  if (typeof localStorage === 'undefined') return [];
  const parsed = safeParse<DeepResearchTask[]>(localStorage.getItem(STORAGE_KEY), []);
  return parsed.map((task) => ({
    ...task,
    questions: Array.isArray(task.questions) ? task.questions : [],
    answers: task.answers && typeof task.answers === 'object' ? task.answers : {},
    crawlStats: task.crawlStats || null
  }));
}

async function synthesizeResearch(task: DeepResearchTask): Promise<string> {
  const sourceLines = task.results
    .slice(0, 14)
    .map((entry, index) => `${index + 1}. ${entry.title}\nURL: ${entry.url}\nSnippet: ${entry.snippet || 'No snippet available.'}`)
    .join('\n\n');

  const answerContext = Object.entries(task.answers || {})
    .map(([id, value]) => {
      const q = task.questions.find((entry) => entry.id === id)?.question || id;
      return `${q}\nAnswer: ${value || '[skipped]'}`;
    })
    .join('\n\n');

  const messages: RequestMessage[] = [
    {
      role: 'system',
      content: [
        'You are a deep research synthesizer.',
        'Summarize the gathered online evidence into a detailed, precise research brief.',
        'Prioritize concrete facts, key comparisons, contradictions, dates, and actionable takeaways.',
        'Use concise markdown sections and bullets when useful.',
        'Cite sources inline by title when possible.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        `Research query: ${task.enhancedQuery || task.query}`,
        `Search mode: ${task.mode}`,
        answerContext ? `<clarifications>\n${answerContext}\n</clarifications>` : '',
        '<web_search_results>',
        task.context,
        '</web_search_results>',
        '',
        '<sources>',
        sourceLines,
        '</sources>',
        '',
        'Create sections: Overview, Detailed Findings, Evidence, Caveats, and What to verify next.'
      ].filter(Boolean).join('\n')
    }
  ];

  const completion = await completeAssistantReply({ messages });
  return completion.content.trim() || 'Research synthesis completed, but no summary text was returned.';
}

async function generateSubQueries(mainQuery: string, mode: 'deep' | 'max'): Promise<string[]> {
  const numQueries = mode === 'max' ? 5 : 3;
  const messages: RequestMessage[] = [
    {
      role: 'system',
      content: [
        'You are a search query planner.',
        `Given a research question, generate ${numQueries} diverse, specific search queries for comprehensive coverage.`,
        'Each query should target a different aspect: facts, comparisons, recency, technical depth, and practical guidance.',
        'Return ONLY the queries, one per line, no numbering.'
      ].join(' ')
    },
    { role: 'user', content: mainQuery }
  ];

  try {
    const completion = await completeAssistantReply({ messages });
    const lines = completion.content.trim().split('\n').map((line) => line.trim()).filter(Boolean);
    return lines.slice(0, numQueries);
  } catch {
    return [mainQuery];
  }
}

async function generateQuestions(mainQuery: string, mode: 'deep' | 'max'): Promise<ResearchQuestion[]> {
  if (!shouldAskClarifyingQuestions(mainQuery, mode)) return [];

  const cacheKey = `${mode}:${normalizeWhitespace(mainQuery).toLowerCase()}`;
  const cached = questionCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    return cached.questions;
  }

  const messages: RequestMessage[] = [
    {
      role: 'system',
      content: [
        'Generate 1-3 concise clarifying questions before deep web research.',
        'Focus on scope, timeframe, geography, constraints, or comparison criteria.',
        'If query is specific, ask at most one optional refinement question.',
        'Return JSON only: {"questions":[{"question":"...","hint":"..."}]}'
      ].join(' ')
    },
    {
      role: 'user',
      content: `Mode: ${mode}\nQuery: ${mainQuery}`
    }
  ];

  try {
    const completion = await withTimeout(completeAssistantReply({ messages }), QUESTION_TIMEOUT_MS, {
      content: '',
      reasoning: ''
    });
    if (!completion?.content) return [];
    const parsed = extractJsonFromResponse(completion.content || '');
    if (!parsed.parsed || !parsed.data) return [];
    const validated = validateStructuredOutput<{ questions: Array<{ question: string; hint?: string }> }>(parsed.data, QUESTION_SCHEMA as any);
    if (!validated.valid) return [];
    const questionEntries = Array.isArray(validated.data?.questions) ? validated.data.questions : [];
    const generated = questionEntries
      .map((entry: any, index: number) => ({
        id: `rq_${index + 1}`,
        question: normalizeWhitespace(entry?.question),
        hint: normalizeWhitespace(entry?.hint)
      }))
      .filter((entry: ResearchQuestion) => entry.question)
      .slice(0, 3);
    if (generated.length) {
      questionCache.set(cacheKey, {
        questions: generated,
        expires: Date.now() + (5 * 60 * 1000)
      });
    }
    return generated;
  } catch {
    return [];
  }
}

function mergeAnswersIntoQuery(query: string, questions: ResearchQuestion[], answers: Record<string, string>) {
  const pieces = [normalizeWhitespace(query)];
  for (const question of questions) {
    const answer = normalizeWhitespace(answers?.[question.id] || '');
    if (!answer) continue;
    pieces.push(`${question.question}: ${answer}`);
  }
  return pieces.join(' | ').trim();
}

class DeepResearchStore {
  tasks = $state<DeepResearchTask[]>(loadTasks());
  activeTaskId = $state<string | null>(null);
  initialized = false;
  private unlisten: (() => void) | null = null;
  private queue: string[] = [];
  private waiters = new Map<string, { resolve: (task: DeepResearchTask) => void; reject: (error: unknown) => void }>();
  private inputWaiters = new Map<string, { resolve: (answers: Record<string, string>) => void }>();

  private getTask(taskId: string | null | undefined): DeepResearchTask | null {
    if (!taskId) return null;
    return this.tasks.find((task) => task.id === taskId) || null;
  }

  get activeTask(): DeepResearchTask | null {
    const task = this.getTask(this.activeTaskId);
    if (!task) return null;
    if (task.status === 'cancelled' || task.status === 'completed' || task.status === 'failed') return null;
    return task;
  }

  get pendingInputTask(): DeepResearchTask | null {
    return this.tasks.find((task) => task.status === 'awaiting_input') || null;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    if (!isTauri()) return;

    void listen<{ step: string; detail: string }>('search-progress', (payload) => {
      if (!this.activeTaskId) return;
      this.appendProgress(this.activeTaskId, payload.step, payload.detail);
    }).then((dispose) => {
      this.unlisten = dispose;
    }).catch(() => {
      this.unlisten = null;
    });
  }

  private updateTask(taskId: string, updater: (task: DeepResearchTask) => DeepResearchTask) {
    const index = this.tasks.findIndex((task) => task.id === taskId);
    if (index === -1) return;
    this.tasks[index] = updater(this.tasks[index]);
    this.tasks = [...this.tasks].sort((left, right) => right.updatedAt - left.updatedAt);
    persistTasks(this.tasks);
  }

  private appendProgress(taskId: string, step: string, detail: string) {
    const current = this.getTask(taskId);
    if (!current || current.status === 'cancelled' || current.status === 'completed' || current.status === 'failed') return;
    this.updateTask(taskId, (task) => ({
      ...task,
      currentStep: step,
      detail,
      updatedAt: Date.now(),
      progressLog: [...task.progressLog, { step, detail, at: Date.now() }].slice(-40)
    }));
  }

  private settleTask(taskId: string, finalTask: DeepResearchTask, error?: unknown) {
    const waiter = this.waiters.get(taskId);
    if (!waiter) return;
    this.waiters.delete(taskId);
    if (error) waiter.reject(error);
    else waiter.resolve(finalTask);
  }

  private async waitForTaskInput(taskId: string): Promise<Record<string, string>> {
    return new Promise((resolve) => {
      this.inputWaiters.set(taskId, { resolve });
    });
  }

  submitTaskAnswers(taskId: string, answers: Record<string, string>, skip = false) {
    const task = this.getTask(taskId);
    if (!task || task.status !== 'awaiting_input') return;
    const sanitized: Record<string, string> = {};
    if (!skip) {
      for (const key of Object.keys(answers || {})) {
        sanitized[key] = normalizeWhitespace(answers[key]).slice(0, 500);
      }
    }
    this.updateTask(taskId, (entry) => ({
      ...entry,
      answers: sanitized,
      status: 'searching',
      currentStep: 'searching',
      detail: 'Running search plan...',
      updatedAt: Date.now(),
      progressLog: [...entry.progressLog, {
        step: 'input',
        detail: skip ? 'Skipped clarifying questions' : 'Clarifying questions answered',
        at: Date.now()
      }].slice(-40)
    }));
    const waiter = this.inputWaiters.get(taskId);
    if (waiter) {
      this.inputWaiters.delete(taskId);
      waiter.resolve(sanitized);
    }
  }

  async runTask(args: {
    chatId: string;
    messageId: string;
    chatTitle: string;
    query: string;
    mode: 'deep' | 'max';
  }): Promise<DeepResearchTask> {
    this.init();

    const questions = await generateQuestions(args.query, args.mode);
    const task: DeepResearchTask = {
      id: createId('research'),
      chatId: args.chatId,
      messageId: args.messageId,
      chatTitle: args.chatTitle,
      query: args.query,
      mode: args.mode,
      status: questions.length ? 'awaiting_input' : 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentStep: questions.length ? 'awaiting_input' : 'queued',
      detail: questions.length ? 'Waiting for clarifying answers' : 'Waiting to start deep research',
      progressLog: [{
        step: questions.length ? 'awaiting_input' : 'queued',
        detail: questions.length ? 'Waiting for clarifying answers' : 'Waiting to start deep research',
        at: Date.now()
      }],
      providerUsed: null,
      results: [],
      context: '',
      summary: '',
      error: null,
      questions,
      answers: {},
      enhancedQuery: args.query,
      crawlStats: null
    };

    this.tasks = [task, ...this.tasks].slice(0, 20);
    persistTasks(this.tasks);

    const promise = new Promise<DeepResearchTask>((resolve, reject) => {
      this.waiters.set(task.id, { resolve, reject });
    });

    this.queue.push(task.id);
    void this.processQueue();
    return promise;
  }

  private async processQueue() {
    if (this.activeTaskId || !this.queue.length) return;
    const taskId = this.queue.shift();
    if (!taskId) return;
    this.activeTaskId = taskId;

    try {
      let task = this.getTask(taskId);
      if (!task) return;

      if (task.status === 'awaiting_input') {
        await this.waitForTaskInput(taskId);
      }

      task = this.getTask(taskId);
      if (!task || task.status === 'cancelled') return;

      this.updateTask(taskId, (entry) => ({
        ...entry,
        status: 'searching',
        currentStep: 'planning',
        detail: 'Planning search strategy...',
        updatedAt: Date.now()
      }));

      task = this.getTask(taskId);
      if (!task) return;
      const enhancedQuery = mergeAnswersIntoQuery(task.query, task.questions, task.answers);
      const subQueries = await generateSubQueries(enhancedQuery, task.mode);
      const allQueries = [enhancedQuery, ...subQueries.filter((query) => query !== enhancedQuery)];

      this.updateTask(taskId, (entry) => ({
        ...entry,
        enhancedQuery,
        currentStep: 'searching',
        detail: `Searching ${allQueries.length} queries...`,
        progressLog: [...entry.progressLog, { step: 'planning', detail: `Generated ${subQueries.length} sub-queries`, at: Date.now() }].slice(-40)
      }));

      const searchResults = await Promise.allSettled(
        allQueries.map((query) => searchWithFallback(query, entryMode(taskId, this.tasks)))
      );

      if (this.getTask(taskId)?.status === 'cancelled') return;

      const allResults: SearchResult[] = [];
      let combinedContext = '';
      const providers = new Set<string>();

      for (const result of searchResults) {
        if (result.status === 'fulfilled' && result.value) {
          allResults.push(...(result.value.results || []));
          combinedContext += (result.value.context || '') + '\n\n';
          if (result.value.provider_used) providers.add(result.value.provider_used);
          const providerWarnings = normalizeWhitespace(result.value.error || '');
          if (providerWarnings && /401|unauthorized|authentication/i.test(providerWarnings)) {
            this.appendProgress(taskId, 'provider_fallback', 'Provider auth failed; switched to DuckDuckGo fallback');
          }
        }
      }

      const dedupedResults = dedupeResults(allResults).slice(0, 36);
      this.updateTask(taskId, (entry) => ({
        ...entry,
        status: 'crawling',
        currentStep: 'crawling',
        detail: 'Crawling linked sources for deeper evidence...',
        updatedAt: Date.now(),
        providerUsed: Array.from(providers).join(', ') || 'auto',
        results: dedupedResults,
        context: combinedContext.slice(0, 30000),
        progressLog: [...entry.progressLog, { step: 'search_found', detail: `Collected ${dedupedResults.length} base sources`, at: Date.now() }].slice(-40)
      }));

      const crawlSeeds = dedupedResults.map((item) => item.url).filter(Boolean).slice(0, task.mode === 'max' ? 10 : 6);
      const crawl = await invoke<{
        results: SearchResult[];
        context: string;
        stats: {
          pages_crawled: number;
          pages_discovered: number;
          truncated: boolean;
          max_depth_reached: number;
        };
      }>('crawl_web', {
        query: enhancedQuery,
        mode: task.mode,
        seed_urls: crawlSeeds,
        context_budget_chars: task.mode === 'max' ? 12000 : 8500
      });

      const merged = dedupeResults([...(dedupedResults || []), ...((crawl?.results || []) as SearchResult[])]).slice(0, task.mode === 'max' ? 44 : 26);
      const mergedContext = [combinedContext, crawl?.context || ''].filter(Boolean).join('\n\n---\n\n').slice(0, 42000);

      this.updateTask(taskId, (entry) => ({
        ...entry,
        status: 'synthesizing',
        currentStep: 'synthesizing',
        detail: 'Generating research brief...',
        updatedAt: Date.now(),
        results: merged,
        context: mergedContext,
        crawlStats: crawl?.stats || null,
        progressLog: [...entry.progressLog, {
          step: 'crawl_done',
          detail: `Crawler visited ${crawl?.stats?.pages_crawled || 0} pages`,
          at: Date.now()
        }].slice(-40)
      }));

      const latest = this.getTask(taskId);
      if (!latest || latest.status === 'cancelled') return;
      const summary = await synthesizeResearch({ ...latest, results: merged, context: mergedContext });
      if (this.getTask(taskId)?.status === 'cancelled') return;

      let finalTask: DeepResearchTask | null = null;
      this.updateTask(taskId, (entry) => {
        finalTask = {
          ...entry,
          status: 'completed',
          currentStep: 'completed',
          detail: 'Deep research finished',
          updatedAt: Date.now(),
          summary,
          results: merged,
          context: mergedContext,
          progressLog: [...entry.progressLog, { step: 'completed', detail: 'Deep research finished', at: Date.now() }].slice(-40)
        };
        return finalTask!;
      });
      if (finalTask) this.settleTask(taskId, finalTask);
    } catch (error) {
      if (this.getTask(taskId)?.status === 'cancelled') return;
      let failedTask: DeepResearchTask | null = null;
      this.updateTask(taskId, (entry) => {
        failedTask = {
          ...entry,
          status: 'failed',
          currentStep: 'failed',
          detail: String((error as Error)?.message || error || 'Deep research failed'),
          updatedAt: Date.now(),
          error: String((error as Error)?.message || error || 'Deep research failed'),
          progressLog: [...entry.progressLog, { step: 'failed', detail: String((error as Error)?.message || error || 'Deep research failed'), at: Date.now() }].slice(-40)
        };
        return failedTask!;
      });
      this.settleTask(taskId, failedTask!, error);
    } finally {
      this.activeTaskId = null;
      void this.processQueue();
    }
  }

  cancelTask(taskId: string) {
    const task = this.getTask(taskId);
    if (!task) return;
    this.queue = this.queue.filter((id) => id !== taskId);
    this.updateTask(taskId, (entry) => ({
      ...entry,
      status: 'cancelled',
      currentStep: 'cancelled',
      detail: 'Deep research stopped by the user',
      updatedAt: Date.now(),
      error: null,
      progressLog: [...entry.progressLog, { step: 'cancelled', detail: 'Deep research stopped by the user', at: Date.now() }].slice(-40)
    }));

    const inputWaiter = this.inputWaiters.get(taskId);
    if (inputWaiter) {
      this.inputWaiters.delete(taskId);
      inputWaiter.resolve({});
    }

    const waiter = this.waiters.get(taskId);
    if (waiter) {
      waiter.reject(new Error('AbortError'));
      this.waiters.delete(taskId);
    }
  }

  cancelActiveTask() {
    if (!this.activeTaskId) return;
    this.cancelTask(this.activeTaskId);
  }

  destroy() {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    this.initialized = false;
  }
}

function entryMode(taskId: string, tasks: DeepResearchTask[]) {
  return tasks.find((entry) => entry.id === taskId)?.mode || 'deep';
}

function dedupeResults(results: SearchResult[]) {
  const seen = new Set<string>();
  return (Array.isArray(results) ? results : []).filter((entry) => {
    const url = normalizeWhitespace(entry?.url || '').toLowerCase();
    if (!url) return false;
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function isAuthFailure(searchError: unknown) {
  const text = normalizeWhitespace(searchError || '').toLowerCase();
  return text.includes('401')
    || text.includes('unauthorized')
    || text.includes('access denied')
    || text.includes('api key')
    || text.includes('authentication');
}

async function searchWithFallback(query: string, mode: 'deep' | 'max') {
  const primary = await webSearch({ query, deep: true, mode });
  const primaryResults = Array.isArray(primary?.results) ? primary.results : [];
  if (primaryResults.length > 0) return primary;

  if (!isAuthFailure(primary?.error || '')) {
    return primary;
  }

  const fallback = await webSearch({
    query,
    deep: true,
    mode,
    options: {
      provider: 'duckduckgo',
      max_results: mode === 'max' ? 10 : 8
    }
  });

  const fallbackResults = Array.isArray(fallback?.results) ? fallback.results : [];
  if (fallbackResults.length > 0) return fallback;

  const secondFallback = await webSearch({
    query,
    deep: true,
    mode,
    options: {
      provider: 'electron',
      max_results: mode === 'max' ? 10 : 8
    }
  });

  return secondFallback;
}

export const deepResearchStore = new DeepResearchStore();

export function cancelDeepResearchTask(taskId: string) {
  deepResearchStore.cancelTask(taskId);
}
