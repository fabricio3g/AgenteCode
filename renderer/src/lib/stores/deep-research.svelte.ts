import type { SearchResult } from '$lib/types/bridge';
import { completeAssistantReply, extractJsonFromResponse, type RequestMessage } from '$lib/services/chat-api';
import {
  buildResearchReportInstruction,
  isMedicalResearchQuery
} from '$lib/services/agent-prompts';
import { listen, invoke, isElectron } from '$lib/services/bridge';
import { webSearch } from '$lib/services/search';
import { createId } from '$lib/utils/id';
import { safeParse, normalizeWhitespace } from '$lib/utils/storage';

type DeepResearchStatus = 'queued' | 'awaiting_input' | 'searching' | 'crawling' | 'synthesizing' | 'completed' | 'failed' | 'cancelled';

export interface ResearchQuestion {
  id: string;
  question: string;
  hint?: string;
  suggestedAnswer?: string;
  suggestedAnswerSource?: 'ai' | 'fallback';
}

export interface DeepResearchTask {
  id: string;
  chatId: string;
  messageId: string;
  chatTitle: string;
  query: string;
  conversationContext?: string;
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

const STORAGE_KEY = 'chatealm_deep_research_tasks_v2';

const QUESTION_TIMEOUT_MS = 20000;
const questionCache = new Map<string, { questions: ResearchQuestion[]; expires: number }>();

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function parseGeneratedQuestions(data: unknown): ResearchQuestion[] {
  const payload = (data && typeof data === 'object') ? data as { questions?: unknown } : {};
  const entries = Array.isArray(payload.questions) ? payload.questions : [];
  return entries
    .map((entry, index) => {
      const item = (entry && typeof entry === 'object') ? entry as Record<string, unknown> : {};
      const question = normalizeWhitespace(item.q ?? item.question);
      const suggestedAnswer = normalizeWhitespace(item.a ?? item.answer ?? item.suggested_answer ?? item.suggestedAnswer);
      return {
        id: `rq_${index + 1}`,
        question,
        hint: normalizeWhitespace(item.h ?? item.hint),
        suggestedAnswer,
        suggestedAnswerSource: 'ai' as const
      };
    })
    .filter((entry: ResearchQuestion) => {
      if (!entry.question) return false;
      // drop generic low-signal suggestions
      const v = (entry.suggestedAnswer || '').toLowerCase();
      if (!v) return false;
      if (v === 'n/a' || v === 'not sure' || v === 'depends') return false;
      if (v.length < 12) return false;
      return true;
    })
    .slice(0, 6);
}

function fallbackQuestionsFromQuery(query: string): ResearchQuestion[] {
  const topic = normalizeWhitespace(query)
    .replace(/conversation context:[\s\S]*?current research request:/i, '')
    .replace(/^current research request:\s*/i, '')
    .replace(/^query:\s*/i, '')
    .slice(0, 90) || 'this topic';

  const q = topic.toLowerCase();
  const isMedical = /disease|syndrome|cancer|drug|therapy|treatment|diagnos|clinical|patient|autoimmune|trial|guideline/.test(q);

  if (isMedical) {
    return [
      {
        id: 'rq_1',
        question: 'Which clinical focus is most useful?',
        hint: 'diagnosis, first-line treatment, refractory cases, monitoring',
        suggestedAnswer: `Focus on diagnosis criteria and evidence-based treatment pathway for ${topic}.`,
        suggestedAnswerSource: 'fallback'
      },
      {
        id: 'rq_2',
        question: 'What evidence hierarchy should be prioritized?',
        hint: 'guidelines, meta-analyses, RCTs, cohort studies',
        suggestedAnswer: 'Prioritize recent clinical guidelines and systematic reviews, then RCT evidence.',
        suggestedAnswerSource: 'fallback'
      },
      {
        id: 'rq_3',
        question: 'Which patient context should be emphasized?',
        hint: 'adult vs pediatric, severe disease, comorbidities, pregnancy',
        suggestedAnswer: 'Emphasize adult moderate-to-severe cases and note key special populations separately.',
        suggestedAnswerSource: 'fallback'
      },
      {
        id: 'rq_4',
        question: 'What output format helps most?',
        hint: 'step-by-step protocol, comparison table, red flags checklist',
        suggestedAnswer: 'Provide a stepwise management summary plus a therapy comparison table and safety red flags.',
        suggestedAnswerSource: 'fallback'
      }
    ];
  }

  return [
    {
      id: 'rq_1',
      question: 'What exact decision should this research support?',
      hint: 'choose tool/vendor/strategy, implementation plan, risk tradeoff',
      suggestedAnswer: `Frame ${topic} as a decision brief with clear options and recommendation criteria.`,
      suggestedAnswerSource: 'fallback'
    },
    {
      id: 'rq_2',
      question: 'What constraints matter most?',
      hint: 'budget, timeline, team size, compliance, performance',
      suggestedAnswer: 'Prioritize practical constraints: implementation complexity, cost, timeline, and risk.',
      suggestedAnswerSource: 'fallback'
    },
    {
      id: 'rq_3',
      question: 'What comparisons should be included?',
      hint: 'top alternatives, baseline approach, build vs buy',
      suggestedAnswer: 'Compare the leading alternatives side-by-side with measurable pros/cons.',
      suggestedAnswerSource: 'fallback'
    },
    {
      id: 'rq_4',
      question: 'How should results be presented?',
      hint: 'executive summary, technical deep dive, action checklist',
      suggestedAnswer: 'Deliver an executive summary first, then concise technical detail and an action checklist.',
      suggestedAnswerSource: 'fallback'
    }
  ];
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

function buildSourceLines(task: DeepResearchTask, limit: number): string {
  return task.results
    .slice(0, limit)
    .map((entry, index) => `[${index + 1}] ${entry.title || entry.url}\nURL: ${entry.url}\nSnippet: ${entry.snippet || 'No snippet available.'}`)
    .join('\n\n');
}

function buildAnswerContext(task: DeepResearchTask): string {
  return Object.entries(task.answers || {})
    .map(([id, value]) => {
      const q = task.questions.find((entry) => entry.id === id)?.question || id;
      return `${q}\nAnswer: ${value || '[skipped]'}`;
    })
    .join('\n\n');
}

async function compressResearchEvidence(task: DeepResearchTask, sourceLines: string, answerContext: string): Promise<string> {
  const query = task.enhancedQuery || task.query;
  const medical = isMedicalResearchQuery(query);
  const messages: RequestMessage[] = [
    {
      role: 'system',
      content: [
        'You are the compression stage of a deep research pipeline.',
        'Turn noisy crawled web evidence into a compact evidence dossier for a final report writer.',
        'Deduplicate repeated facts, preserve source IDs, call out contradictions, rank source authority, and identify gaps.',
        medical ? 'For medical topics, rank evidence as guidelines/consensus first, then systematic reviews and trials, then peer-reviewed reviews, then clinical references, then patient resources.' : 'Rank evidence by primary/authoritative sources first, then reputable secondary sources, then low-authority or contextual sources.',
        'Do not write the final report. Output only the dossier.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        `Research query: ${query}`,
        `Search mode: ${task.mode}`,
        answerContext ? `<clarifications>\n${answerContext}\n</clarifications>` : '',
        '<source_index>',
        sourceLines,
        '</source_index>',
        '<crawled_evidence>',
        task.context,
        '</crawled_evidence>',
        '',
        'Create an evidence dossier with these exact headings:',
        '1. Priority Sources and Why They Matter',
        '2. Verified Claims by Theme with source IDs',
        '3. Conflicts, Uncertainties, and Weak Evidence',
        '4. Missing Information to Verify',
        '5. Suggested Final Report Outline'
      ].filter(Boolean).join('\n')
    }
  ];

  const completion = await completeAssistantReply({ messages });
  return completion.content.trim();
}

/**
 * Instructions for the standalone deep-research synthesis pass.
 *
 * The report shape comes from `buildResearchReportInstruction`, the one place it
 * is defined. This adds only what is specific to this pipeline: a numbered
 * source index to cite against, and (for Max) a compressed evidence dossier that
 * outranks the raw crawl. It previously restated the whole APA contract from
 * scratch, in wording that had already drifted from the canonical version.
 */
function finalReportRequest(mode: 'deep' | 'max', medical: boolean): string {
  const pipelineSpecific = [
    'Use inline source IDs like [1], [2] for important factual claims whenever the evidence provides source IDs, and number the References list to match that index.',
    mode === 'max'
      ? 'Use the compressed evidence dossier as the primary source of truth, then use crawled evidence only to fill gaps. This should be comprehensive enough to serve as a second-stage deep research deliverable.'
      : 'Include concise evidence-quality notes and practical takeaways.'
  ];

  return [buildResearchReportInstruction(mode, medical), '', ...pipelineSpecific].join('\n');
}

async function synthesizeResearch(task: DeepResearchTask): Promise<string> {
  const sourceLines = buildSourceLines(task, task.mode === 'max' ? 40 : 24);
  const answerContext = buildAnswerContext(task);
  const query = task.enhancedQuery || task.query;
  const medical = isMedicalResearchQuery(query);
  const evidenceDossier = task.mode === 'max'
    ? await compressResearchEvidence(task, sourceLines, answerContext)
    : '';

  const messages: RequestMessage[] = [
    {
      role: 'system',
      content: [
        'You are the final-report writer in a staged deep research pipeline.',
        'Your job is to produce a high-quality synthesized report from gathered evidence, not a raw evidence dump.',
        'Be precise, source-aware, and transparent about uncertainty.',
        finalReportRequest(task.mode, medical)
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        task.conversationContext ? `Conversation context:\n${task.conversationContext}` : '',
        `Research query: ${query}`,
        `Search mode: ${task.mode}`,
        answerContext ? `<clarifications>\n${answerContext}\n</clarifications>` : '',
        evidenceDossier ? '<compressed_evidence_dossier>' : '',
        evidenceDossier,
        evidenceDossier ? '</compressed_evidence_dossier>' : '',
        '<web_search_results>',
        task.context,
        '</web_search_results>',
        '',
        '<sources>',
        sourceLines,
        '</sources>',
        '',
        finalReportRequest(task.mode, medical)
      ].filter(Boolean).join('\n')
    }
  ];

  const completion = await completeAssistantReply({ messages });
  return completion.content.trim() || 'Research synthesis completed, but no summary text was returned.';
}

async function generateSubQueries(mainQuery: string, mode: 'deep' | 'max'): Promise<string[]> {
  const numQueries = mode === 'max' ? 8 : 4;
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

async function generateQuestions(mainQuery: string, mode: 'deep' | 'max', conversationContext?: string): Promise<ResearchQuestion[]> {
  const cacheKey = `${mode}:${normalizeWhitespace(mainQuery).toLowerCase()}:${normalizeWhitespace(conversationContext || '').toLowerCase()}`;
  const cached = questionCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) return cached.questions;

  async function request(prompt: string, attemptLabel: string): Promise<ResearchQuestion[]> {
    const messages: RequestMessage[] = [
      { role: 'system', content: prompt },
      { role: 'user', content: [
        `Mode: ${mode}`,
        `Query: ${mainQuery}`,
        conversationContext ? `Conversation context (optional):\n${conversationContext}` : ''
      ].filter(Boolean).join('\n\n') }
    ];

    const startedAt = Date.now();
    const completion = await withTimeout(completeAssistantReply({ messages }), QUESTION_TIMEOUT_MS, { content: '', reasoning: '' });
    const elapsedMs = Date.now() - startedAt;

    const raw = String(completion?.content || completion?.reasoning || '').trim();
    if (!raw) {
      console.warn('[deep-research] question generation failed: empty completion', {
        attempt: attemptLabel,
        mode,
        query: mainQuery,
        elapsedMs,
        timeoutMs: QUESTION_TIMEOUT_MS
      });
      return [];
    }

    const parsed = extractJsonFromResponse(raw);
    if (!parsed.parsed || !parsed.data) {
      console.warn('[deep-research] question generation failed: invalid JSON payload', {
        attempt: attemptLabel,
        mode,
        query: mainQuery,
        elapsedMs,
        preview: raw.slice(0, 320)
      });
      return [];
    }

    const questions = parseGeneratedQuestions(parsed.data);
    if (!questions.length) {
      console.warn('[deep-research] question generation failed: parsed but no valid options', {
        attempt: attemptLabel,
        mode,
        query: mainQuery,
        elapsedMs,
        data: parsed.data
      });
    }
    return questions;
  }

  try {
    const generated = await request([
      'Generate 4-6 high-signal clarifying options for the research query.',
      'Each option must be SPECIFIC to the exact query context, not generic.',
      'Never copy raw query framing text (e.g. "Conversation context" or "Current research request") into answers.',
      'For each item provide: q (the question), h (short hint), a (a concrete default answer).',
      'Default answers must contain concrete scope choices (time range, geography, audience level, comparison targets, deliverable style).',
      'Avoid generic defaults like "depends", "not sure", "overview" without scope.',
      'Return JSON only: {"questions":[{"q":"...","h":"...","a":"..."}]}'
    ].join(' '), 'primary');
    if (generated.length) {
      questionCache.set(cacheKey, { questions: generated, expires: Date.now() + (5 * 60 * 1000) });
      return generated;
    }

    const retry = await request('Retry with strict format. Output JSON only, no markdown, no extra text: {"questions":[{"q":"...","h":"...","a":"..."}]}. Ensure each answer is concrete and query-specific with explicit scope.', 'retry-1');
    if (retry.length) {
      questionCache.set(cacheKey, { questions: retry, expires: Date.now() + (5 * 60 * 1000) });
      return retry;
    }

    const finalRetry = await request('Final retry. Return 4-6 options in strict JSON only. Every suggested answer must include at least one explicit scope constraint and one concrete deliverable preference. No generic wording.', 'retry-2');
    if (finalRetry.length) {
      questionCache.set(cacheKey, { questions: finalRetry, expires: Date.now() + (5 * 60 * 1000) });
      return finalRetry;
    }

    console.warn('[deep-research] question generation exhausted all attempts', { mode, query: mainQuery });
    return [];
  } catch (error) {
    console.warn('[deep-research] question generation exception', { mode, query: mainQuery, error });
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

  getActiveTaskForMessage(messageId: string | null | undefined): DeepResearchTask | null {
    if (!messageId) return null;
    const task = this.tasks.find((entry) => entry.messageId === messageId && !['cancelled', 'completed', 'failed'].includes(entry.status));
    return task || null;
  }

  getTasksForChat(chatId: string | null | undefined): DeepResearchTask[] {
    if (!chatId) return [];
    return this.tasks.filter((entry) => entry.chatId === chatId);
  }

  get pendingInputTask(): DeepResearchTask | null {
    return this.tasks.find((task) => task.status === 'awaiting_input') || null;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    if (!isElectron()) return;

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
    conversationContext?: string;
    mode: 'deep' | 'max';
  }): Promise<DeepResearchTask> {
    this.init();

    const planningQuery = [args.conversationContext ? `Conversation context:\n${args.conversationContext}` : '', `Current research request:\n${args.query}`].filter(Boolean).join('\n\n');
    const generatedQuestions = await generateQuestions(args.query, args.mode, args.conversationContext);
    const questionGenerationFailed = generatedQuestions.length === 0;
    const questions = questionGenerationFailed
      ? [{
          id: 'rq_custom',
          question: 'Could not auto-generate options. Add your preferred research direction.',
          hint: 'Example: focus on latest guidelines, severe cases, and treatment comparison',
          suggestedAnswer: '',
          suggestedAnswerSource: 'fallback' as const
        }]
      : generatedQuestions;
    const isAwaitingInput = questions.length > 0;
    const task: DeepResearchTask = {
      id: createId('research'),
      chatId: args.chatId,
      messageId: args.messageId,
      chatTitle: args.chatTitle,
      query: args.query,
      conversationContext: args.conversationContext,
      mode: args.mode,
      status: isAwaitingInput ? 'awaiting_input' : 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentStep: isAwaitingInput ? 'awaiting_input' : 'queued',
      detail: isAwaitingInput
        ? (questionGenerationFailed ? 'Auto-options failed. Waiting for your custom input.' : 'Waiting for clarifying answers')
        : 'Waiting to start deep research',
      progressLog: [{
        step: isAwaitingInput ? 'awaiting_input' : 'queued',
        detail: isAwaitingInput
          ? (questionGenerationFailed ? 'Auto-options failed. Waiting for custom input.' : 'Waiting for clarifying answers')
          : 'Waiting to start deep research',
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
    if (isAwaitingInput) this.activeTaskId = task.id;
    persistTasks(this.tasks);

    const promise = new Promise<DeepResearchTask>((resolve, reject) => {
      this.waiters.set(task.id, { resolve, reject });
    });

    this.queue.push(task.id);
    void this.processQueue();
    return promise;
  }

  private async processQueue() {
    if (this.queue.length === 0) return;
    
    let taskId = this.activeTaskId;
    if (!taskId) {
      const next = this.queue.shift();
      if (!next) return;
      taskId = next;
      this.activeTaskId = taskId;
    }

    try {
      let task = this.getTask(taskId);
      if (!task) return;

      if (task.status === 'awaiting_input') {
        await this.waitForTaskInput(taskId);
        task = this.getTask(taskId);
        if (!task || task.status === 'cancelled') return;
        if (task.status !== 'searching') return;
      }

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
      const planningQuery = [task.conversationContext ? `Conversation context:\n${task.conversationContext}` : '', `Current research request:\n${enhancedQuery}`].filter(Boolean).join('\n\n');
      const subQueries = await generateSubQueries(planningQuery, task.mode);
      const allQueries = [enhancedQuery, ...subQueries.filter((query) => query !== enhancedQuery)];

      this.updateTask(taskId, (entry) => ({
        ...entry,
        enhancedQuery,
        currentStep: 'searching',
        detail: `Searching ${allQueries.length} queries...`,
        progressLog: [...entry.progressLog, { step: 'planning', detail: `Generated ${subQueries.length} sub-queries`, at: Date.now() }].slice(-40)
      }));

      const searchResults = await Promise.allSettled(
        allQueries.map((query) => searchWithFallback(query, entryMode(taskId, this.tasks), task?.conversationContext))
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
        context: combinedContext,
        progressLog: [...entry.progressLog, { step: 'search_found', detail: `Collected ${dedupedResults.length} base sources`, at: Date.now() }].slice(-40)
      }));

      const crawlSeeds = dedupedResults.map((item) => item.url).filter(Boolean).slice(0, task.mode === 'max' ? 16 : 8);
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
        context: task.conversationContext,
        mode: task.mode,
        seed_urls: crawlSeeds
      });

      const merged = dedupeResults([...(dedupedResults || []), ...((crawl?.results || []) as SearchResult[])]).slice(0, task.mode === 'max' ? 70 : 36);
      const mergedContext = [combinedContext, crawl?.context || ''].filter(Boolean).join('\n\n---\n\n');

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

  cancelTaskForMessage(messageId: string) {
    if (!messageId) return;
    for (const task of this.tasks) {
      if (task.messageId === messageId && !['completed', 'failed', 'cancelled'].includes(task.status)) {
        this.cancelTask(task.id);
      }
    }
  }

  cancelTasksForChat(chatId: string) {
    if (!chatId) return;
    for (const task of this.tasks) {
      if (task.chatId === chatId && !['completed', 'failed', 'cancelled'].includes(task.status)) {
        this.cancelTask(task.id);
      }
    }
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

async function searchWithFallback(query: string, mode: 'deep' | 'max', context?: string) {
  const primary = await webSearch({ query, context, deep: true, mode });
  const primaryResults = Array.isArray(primary?.results) ? primary.results : [];
  if (primaryResults.length > 0) return primary;

  if (!isAuthFailure(primary?.error || '')) {
    return primary;
  }

  const fallback = await webSearch({
    query,
    context,
    deep: true,
    mode,
    options: {
      provider: 'aggregator',
      max_results: mode === 'max' ? 18 : 12
    }
  });

  const fallbackResults = Array.isArray(fallback?.results) ? fallback.results : [];
  if (fallbackResults.length > 0) return fallback;

  const secondFallback = await webSearch({
    query,
    context,
    deep: true,
    mode,
    options: {
      provider: 'aggregator',
      max_results: mode === 'max' ? 18 : 12
    }
  });

  return secondFallback;
}

export const deepResearchStore = new DeepResearchStore();

export function cancelDeepResearchTask(taskId: string) {
  deepResearchStore.cancelTask(taskId);
}
