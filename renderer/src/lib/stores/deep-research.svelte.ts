import type { SearchResult } from '$lib/types/tauri';
import { completeAssistantReply, type RequestMessage } from '$lib/services/chat-api';
import { listen, isTauri } from '$lib/services/tauri';
import { webSearch } from '$lib/services/search';

type DeepResearchStatus = 'queued' | 'searching' | 'synthesizing' | 'completed' | 'failed' | 'cancelled';

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
}

const STORAGE_KEY = 'talamolm_deep_research_tasks_v1';

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

function persistTasks(tasks: DeepResearchTask[]) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.slice(0, 20)));
}

function loadTasks(): DeepResearchTask[] {
  if (typeof localStorage === 'undefined') return [];
  return safeParse<DeepResearchTask[]>(localStorage.getItem(STORAGE_KEY), []);
}

async function synthesizeResearch(task: DeepResearchTask): Promise<string> {
  const sourceLines = task.results
    .slice(0, 12)
    .map((entry, index) => `${index + 1}. ${entry.title}\nURL: ${entry.url}\nSnippet: ${entry.snippet || 'No snippet available.'}`)
    .join('\n\n');

  const messages: RequestMessage[] = [
    {
      role: 'system',
      content: [
        'You are a deep research synthesizer.',
        'Summarize the gathered online evidence into a concise but information-dense research brief.',
        'Prioritize concrete facts, key comparisons, contradictions, dates, and actionable takeaways.',
        'Use short markdown sections and bullet points when helpful.',
        'Do not mention missing tools or internal process. Focus on the findings.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        `Research query: ${task.query}`,
        `Search mode: ${task.mode}`,
        '',
        '<web_search_results>',
        task.context,
        '</web_search_results>',
        '',
        '<sources>',
        sourceLines,
        '</sources>',
        '',
        'Create a tight research brief with these sections if possible: Overview, Key Findings, Important Sources, Open Questions.'
      ].join('\n')
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
        `Given a research question, generate ${numQueries} diverse, specific search queries that together will provide comprehensive coverage.`,
        'Each query should target a different aspect: facts, comparisons, recent news, expert opinions, technical details.',
        'Return ONLY the queries, one per line, no numbering, no explanation.'
      ].join(' ')
    },
    { role: 'user', content: mainQuery }
  ];

  try {
    const completion = await completeAssistantReply({ messages });
    const lines = completion.content.trim().split('\n').map(l => l.trim()).filter(Boolean);
    return lines.slice(0, numQueries);
  } catch {
    return [mainQuery];
  }
}

class DeepResearchStore {
  tasks = $state<DeepResearchTask[]>(loadTasks());
  activeTaskId = $state<string | null>(null);
  initialized = false;
  private unlisten: (() => void) | null = null;
  private queue: string[] = [];
  private waiters = new Map<string, { resolve: (task: DeepResearchTask) => void; reject: (error: unknown) => void }>();

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

  get recentTasks(): DeepResearchTask[] {
    return [...this.tasks].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 5);
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
    if (!current || current.status === 'cancelled' || current.status === 'completed' || current.status === 'failed') {
      return;
    }
    this.updateTask(taskId, (task) => ({
      ...task,
      currentStep: step,
      detail,
      updatedAt: Date.now(),
      progressLog: [...task.progressLog, { step, detail, at: Date.now() }].slice(-20)
    }));
  }

  private settleTask(taskId: string, finalTask: DeepResearchTask, error?: unknown) {
    const waiter = this.waiters.get(taskId);
    if (!waiter) return;
    this.waiters.delete(taskId);
    if (error) waiter.reject(error);
    else waiter.resolve(finalTask);
  }

  async runTask(args: {
    chatId: string;
    messageId: string;
    chatTitle: string;
    query: string;
    mode: 'deep' | 'max';
  }): Promise<DeepResearchTask> {
    this.init();

    const task: DeepResearchTask = {
      id: createId('research'),
      chatId: args.chatId,
      messageId: args.messageId,
      chatTitle: args.chatTitle,
      query: args.query,
      mode: args.mode,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentStep: 'queued',
      detail: 'Waiting to start deep research',
      progressLog: [{ step: 'queued', detail: 'Waiting to start deep research', at: Date.now() }],
      providerUsed: null,
      results: [],
      context: '',
      summary: '',
      error: null
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
    const taskId = this.queue.shift()!;
    this.activeTaskId = taskId;
    this.updateTask(taskId, (task) => ({
      ...task,
      status: 'searching',
      currentStep: 'planning',
      detail: 'Planning search strategy...',
      updatedAt: Date.now()
    }));

    try {
      const task = this.tasks.find((entry) => entry.id === taskId);
      if (!task) return;

      const subQueries = await generateSubQueries(task.query, task.mode);
      const allQueries = [task.query, ...subQueries.filter(q => q !== task.query)];

      this.updateTask(taskId, (entry) => ({
        ...entry,
        currentStep: 'searching',
        detail: `Searching ${allQueries.length} queries...`,
        progressLog: [...entry.progressLog, { step: 'planning', detail: `Generated ${subQueries.length} sub-queries`, at: Date.now() }].slice(-20)
      }));

      const searchResults = await Promise.allSettled(
        allQueries.map(q => webSearch({ query: q, deep: true, mode: task.mode }))
      );

      if (this.getTask(taskId)?.status === 'cancelled') {
        return;
      }

      const allResults: SearchResult[] = [];
      let combinedContext = '';
      const providers = new Set<string>();

      for (const result of searchResults) {
        if (result.status === 'fulfilled' && result.value) {
          allResults.push(...result.value.results);
          combinedContext += (result.value.context || '') + '\n\n';
          if (result.value.provider_used) providers.add(result.value.provider_used);
        }
      }

      const seenUrls = new Set<string>();
      const dedupedResults = allResults.filter(r => {
        if (seenUrls.has(r.url)) return false;
        seenUrls.add(r.url);
        return true;
      }).slice(0, 30);

      this.updateTask(taskId, (entry) => ({
        ...entry,
        status: 'synthesizing',
        currentStep: 'synthesizing',
        detail: 'Passing collected evidence through the LLM',
        updatedAt: Date.now(),
        providerUsed: Array.from(providers).join(', ') || 'auto',
        results: dedupedResults,
        context: combinedContext.slice(0, 20000),
        progressLog: [...entry.progressLog, { step: 'found', detail: `Collected ${dedupedResults.length} sources from ${allQueries.length} queries`, at: Date.now() }].slice(-20)
      }));

      const summary = await synthesizeResearch({ ...task, results: dedupedResults, context: combinedContext.slice(0, 20000), providerUsed: Array.from(providers).join(',') || 'auto', status: 'synthesizing', currentStep: 'synthesizing', detail: 'Passing collected evidence through the LLM', updatedAt: Date.now() });
      if (this.getTask(taskId)?.status === 'cancelled') {
        return;
      }
      let finalTask: DeepResearchTask | null = null;
      this.updateTask(taskId, (entry) => {
        finalTask = {
          ...entry,
          status: 'completed',
          currentStep: 'completed',
          detail: 'Deep research finished',
          updatedAt: Date.now(),
          summary,
          results: dedupedResults,
          context: combinedContext.slice(0, 20000),
          progressLog: [...entry.progressLog, { step: 'completed', detail: 'Deep research finished', at: Date.now() }].slice(-20)
        };
        return finalTask!;
      });
      if (finalTask) {
        this.settleTask(taskId, finalTask);
      }
    } catch (error) {
      if (this.getTask(taskId)?.status === 'cancelled') {
        return;
      }
      let failedTask: DeepResearchTask | null = null;
      this.updateTask(taskId, (entry) => {
        failedTask = {
          ...entry,
          status: 'failed',
          currentStep: 'failed',
          detail: String((error as Error)?.message || error || 'Deep research failed'),
          updatedAt: Date.now(),
          error: String((error as Error)?.message || error || 'Deep research failed'),
          progressLog: [...entry.progressLog, { step: 'failed', detail: String((error as Error)?.message || error || 'Deep research failed'), at: Date.now() }].slice(-20)
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
      progressLog: [...entry.progressLog, { step: 'cancelled', detail: 'Deep research stopped by the user', at: Date.now() }].slice(-20)
    }));

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

export const deepResearchStore = new DeepResearchStore();

export function cancelDeepResearchTask(taskId: string) {
  deepResearchStore.cancelTask(taskId);
}
