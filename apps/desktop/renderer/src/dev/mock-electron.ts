// Dev-only browser harness (?mock=1): installs a scripted window.electronAPI
// so the renderer can be exercised in a plain browser without Electron.
// Never imported unless the query flag is present (see src/main.ts).

import { KICKOFF_PPTX, REAL_DOCX, REAL_PPTX, REAL_XLSX, SAMPLE_DOCX, SAMPLE_XLSX } from './mock-office-files';

type Listener = (payload: unknown) => void;

const eventListeners = new Map<string, Set<Listener>>();
// One conversation whose project was removed by an older build (orphan).
const savedSessions: unknown[] = [
  {
    id: 'chat-orphan',
    title: 'Refactor the auth flow',
    createdAt: Date.now() - 172_800_000,
    updatedAt: Date.now() - 172_800_000,
    folderId: null,
    draft: '',
    contextMode: 'code',
    projectId: null,
    messages: [{ id: 'm1', role: 'user', content: 'Refactor the auth flow', createdAt: Date.now() - 172_800_000 }]
  },
  // A Home chat with a few artifacts, for the Artifacts screen.
  {
    id: 'chat-artifacts',
    title: 'Q3 launch plan',
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now() - 3_600_000,
    folderId: null,
    draft: '',
    contextMode: 'home',
    projectId: null,
    messages: [
      { id: 'a0', role: 'user', content: 'Make a launch page and a written brief.', createdAt: Date.now() - 3_600_000 },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Here is the landing page.',
        createdAt: Date.now() - 3_500_000,
        artifact: {
          title: 'Launch landing page',
          files: {
            'index.html':
              '<!doctype html><html><body style="margin:0;font-family:system-ui;background:linear-gradient(135deg,#0f172a,#312e81);color:white;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center"><h1 style="font-size:64px;margin:0">Nimbus 3</h1><p style="font-size:24px;opacity:.8">Sync everything. Worry about nothing.</p><a style="margin-top:24px;padding:14px 28px;border-radius:999px;background:white;color:#312e81;font-weight:600;text-decoration:none">Get early access</a></body></html>'
          }
        }
      },
      {
        id: 'a2',
        role: 'assistant',
        content: 'And the brief.',
        createdAt: Date.now() - 90_000_000,
        artifact: {
          title: 'Launch brief',
          files: {
            'brief.md':
              '# Nimbus 3 launch brief\n\nNimbus 3 ships on October 14. The goal is 20,000 sign-ups in the first two weeks, led by a waitlist campaign and a partner webinar.\n\n## Audience\nSmall teams already using two or more sync tools.'
          }
        }
      },
      { id: 'a3', role: 'user', content: 'Give me three shorter taglines.', createdAt: Date.now() - 80_000_000 },
      {
        id: 'a4',
        role: 'assistant',
        content: '1. Sync, sorted.\n2. Everywhere, at once.\n3. Your files, finally calm.',
        createdAt: Date.now() - 79_000_000
      }
    ]
  }
];
// One artifact of every type, for checking viewers (see the "Artifact showcase" chat).
function inlineArtifact(kind: string, file: string, payload: Record<string, unknown>) {
  return {
    title: String(payload.title),
    files: { [file]: JSON.stringify({ kind, ...payload }) },
    inline: { kind, ...payload },
    manifest: { schemaVersion: 1, kind, presentation: 'inline', entryPath: file, status: 'ready' }
  };
}
const showcaseArtifacts: Array<Record<string, unknown>> = [
  inlineArtifact('chart', 'chart.json', {
    title: 'Sign-ups by week',
    chartType: 'bar',
    labels: ['W1', 'W2', 'W3', 'W4'],
    datasets: [{ label: 'Waitlist', data: [1200, 3400, 5200, 8100] }, { label: 'Partners', data: [300, 900, 1500, 2600] }]
  }),
  inlineArtifact('diagram', 'diagram.json', {
    title: 'Launch flow',
    source: 'flowchart LR\n  A[Waitlist] --> B{Invite}\n  B -->|yes| C[Onboarding]\n  B -->|no| D[Nurture]'
  }),
  inlineArtifact('map', 'map.json', {
    title: 'Launch cities',
    latitude: 44,
    longitude: -0.5,
    zoom: 4,
    markers: [{ lat: 40.4, lng: -3.7, label: 'Madrid' }, { lat: 48.85, lng: 2.35, label: 'Paris' }],
    polylines: []
  }),
  inlineArtifact('dashboard', 'dashboard.json', {
    title: 'Launch week',
    subtitle: 'Oct 14 – 20',
    metrics: [
      { label: 'Sign-ups', value: '18,240', trend: '+12%' },
      { label: 'Activation', value: '41', unit: '%', trend: '-2%' },
      { label: 'NPS', value: '52', trend: '0' }
    ],
    sections: [{ heading: 'Notes', content: 'Partner webinar drove the Thursday spike.' }]
  }),
  inlineArtifact('info_card', 'info-card.json', {
    title: 'Madrid',
    subtitle: 'Today',
    rows: [{ label: 'Temperature', value: '21 °C' }, { label: 'Wind', value: '12 km/h', hint: 'NW' }]
  }),
  inlineArtifact('html_card', 'html-card.json', {
    title: 'Pricing card',
    html: '<style>.p{font-family:system-ui;padding:16px;border-radius:12px;background:#f4f4f5}.p b{font-size:28px}</style><div class="p"><div>Pro</div><b>$12</b><span>/month</span></div>'
  }),
  inlineArtifact('html_card', 'widget.json', {
    title: 'Mortgage calculator',
    html: `<div class="fx-stack">
  <div class="fx-grid">
    <div class="fx-card"><div class="fx-label">Monthly payment</div><div class="fx-value" id="pay">–</div></div>
    <div class="fx-card"><div class="fx-label">Total interest</div><div class="fx-value" id="int">–</div></div>
  </div>
  <div><div class="fx-between"><label>Amount</label><span class="fx-small" id="aV"></span></div><input type="range" id="a" min="50000" max="800000" step="5000" value="300000"></div>
  <div><div class="fx-between"><label>Interest rate</label><span class="fx-small" id="rV"></span></div><input type="range" id="r" min="0.5" max="9" step="0.1" value="3.4"></div>
  <div class="fx-between"><label>Term</label><div class="fx-seg" id="t"><button data-y="15">15 y</button><button data-y="25" class="on">25 y</button><button data-y="30">30 y</button></div></div>
  <div><div class="fx-between fx-small fx-muted"><span>Principal vs interest</span><span id="share"></span></div><div class="fx-bar"><span id="bar"></span></div></div>
  <div class="fx-row"><button class="fx-btn ghost" id="ask">Compare with renting</button></div>
</div>`,
    script: `let years = 25;
const calc = () => {
  const P = +fx.$('#a').value, r = +fx.$('#r').value / 100 / 12, n = years * 12;
  const m = r ? P * r / (1 - Math.pow(1 + r, -n)) : P / n;
  const interest = m * n - P;
  fx.$('#pay').textContent = fx.money(m, 'EUR');
  fx.$('#int').textContent = fx.money(interest, 'EUR');
  fx.$('#aV').textContent = fx.money(P, 'EUR');
  fx.$('#rV').textContent = fx.$('#r').value + ' %';
  const share = P / (P + interest);
  fx.$('#bar').style.width = (share * 100) + '%';
  fx.$('#share').textContent = fx.pct(share, 0) + ' principal';
};
fx.$$('input').forEach((i) => i.addEventListener('input', calc));
fx.$$('#t button').forEach((b) => b.onclick = () => { fx.$$('#t button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); years = +b.dataset.y; calc(); });
fx.$('#ask').onclick = () => fx.ask('Compare this mortgage with renting a similar flat in Madrid.');
calc();`
  }),
  {
    title: 'Northwind Studio — Q4 kickoff',
    files: {
      'q4-kickoff.pptx': KICKOFF_PPTX,
      '__spec__/q4-kickoff.pptx.json': JSON.stringify({ kind: 'deck', deck: {"title": "Northwind Studio — Q4 kickoff", "subtitle": "Plan, people and priorities for October–December", "theme": "light", "accent": "blue", "slides": [{"title": "Northwind Studio — Q4 kickoff", "subtitle": "Plan, people and priorities for October–December"}, {"layout": "section", "title": "Where we are"}, {"title": "Q3 in numbers", "stats": [{"value": "€612K", "label": "Revenue, +9% QoQ"}, {"value": "31%", "label": "Operating margin"}, {"value": "14", "label": "Active clients"}]}, {"title": "Q4 goals", "bullets": ["Win two new retainer clients above €20K/month", "Ship the Aurora brand system on time", "Hire a senior product designer and a producer", "Keep utilization between 72% and 80%"], "notes": "Lead with the retainers."}, {"title": "Budget by month", "chart": {"type": "column", "labels": ["Oct", "Nov", "Dec"], "series": [{"name": "Revenue", "values": [205, 231, 198]}, {"name": "Costs", "values": [168, 176, 181]}]}}, {"title": "Projects", "table": {"columns": ["Client", "Project", "Budget", "Due"], "rows": [["Aurora", "Brand system", "€84K", "Nov 28"], ["Helio", "App redesign", "€126K", "Dec 19"], ["Kiln", "Campaign", "€38K", "Oct 31"]]}}, {"title": "Hiring vs. freelance", "left": {"heading": "Hire", "bullets": ["Senior product designer", "Producer"]}, "right": {"heading": "Freelance", "bullets": ["Motion for Kiln", "3D for Aurora launch"]}}, {"quote": "Fewer projects, done properly, for clients we want to keep.", "attribution": "Studio principle"}]} })
    },
    manifest: { schemaVersion: 1, kind: 'presentation', presentation: 'document', entryPath: 'q4-kickoff.pptx', status: 'ready' }
  },
  {
    title: 'Q3 budget',
    files: { 'q3-budget.xlsx': SAMPLE_XLSX },
    manifest: { schemaVersion: 1, kind: 'spreadsheet', presentation: 'document', entryPath: 'q3-budget.xlsx', status: 'ready' }
  },
  {
    title: 'Nimbus 3 launch brief',
    files: { 'launch-brief.docx': SAMPLE_DOCX },
    manifest: { schemaVersion: 1, kind: 'document', presentation: 'document', entryPath: 'launch-brief.docx', status: 'ready' }
  },
  {
    title: 'Launch report',
    files: {
      'report.html':
        '<!doctype html><html><head><style>body{font-family:system-ui;max-width:680px;margin:40px auto}</style></head><body><h1>Launch report</h1><p>Everything shipped on time.</p></body></html>'
    },
    manifest: { schemaVersion: 1, kind: 'report', presentation: 'document', entryPath: 'report.html', status: 'ready' }
  }
];
savedSessions.push({
  id: 'chat-showcase',
  title: 'Artifact showcase',
  createdAt: Date.now() - 1_800_000,
  updatedAt: Date.now() - 1_800_000,
  folderId: null,
  draft: '',
  contextMode: 'home',
  projectId: null,
  messages: [
    { id: 's0', role: 'user', content: 'Show me every artifact type.', createdAt: Date.now() - 1_800_000 },
    { id: 's1', role: 'assistant', content: 'Here they are.', createdAt: Date.now() - 1_790_000, artifacts: showcaseArtifacts }
  ]
});

// A finished Deep research answer, for the research widget.
const researchSources = [
  { title: 'Memory consolidation', url: 'https://en.wikipedia.org/wiki/Memory_consolidation', snippet: 'Memory consolidation is a category of processes that stabilize a memory trace after its initial acquisition.', provider: 'wikipedia' },
  { title: 'Sleep — a brain-state serving systems memory consolidation', url: 'https://pubmed.ncbi.nlm.nih.gov/37023710/', snippet: 'Neuron · 2023 · Brodt S, Inostroza M, Niethard N, Born J', provider: 'pubmed' },
  { title: 'Reactivation and Consolidation of Memory During Sleep', url: 'https://doi.org/10.1177/0963721415620112', snippet: 'Current Directions in Psychological Science · 2016', provider: 'crossref' },
  { title: 'The memory function of sleep', url: 'https://www.nature.com/articles/nrn2762', snippet: 'Nature Reviews Neuroscience · Diekelmann S, Born J', provider: 'crossref' },
  { title: 'Sleep spindles and memory: a meta-analysis', url: 'https://arxiv.org/abs/2106.10312', snippet: 'arXiv preprint · 2021', provider: 'arxiv' },
  { title: 'Slow oscillations orchestrate hippocampal reactivation', url: 'https://www.cell.com/neuron/fulltext/S0896-6273(19)30300-6', snippet: 'Neuron · 2019', provider: 'crossref' },
  { title: 'Targeted memory reactivation during sleep', url: 'https://www.sciencedirect.com/science/article/pii/S1087079216300934', snippet: 'Sleep Medicine Reviews · 2017', provider: 'crossref' }
];
savedSessions.push({
  id: 'chat-research',
  title: 'How sleep consolidates memory',
  createdAt: Date.now() - 900_000,
  updatedAt: Date.now() - 900_000,
  folderId: null,
  draft: '',
  contextMode: 'home',
  projectId: null,
  messages: [
    { id: 'q0', role: 'user', content: 'How does sleep consolidate memory? Give me the current evidence.', createdAt: Date.now() - 900_000, searchMode: 'deep' },
    {
      id: 'q1',
      role: 'assistant',
      searchMode: 'deep',
      mode: 'agent',
      createdAt: Date.now() - 880_000,
      content: '# How sleep consolidates memory\n\nDuring slow-wave sleep the hippocampus **replays** recent experiences, and that replay is timed to cortical slow oscillations and thalamic spindles [2][6]. Over repeated nights this shifts memories from hippocampal to neocortical storage [1][4].\n\n## What the evidence shows\n\n- Cueing a memory during sleep (targeted memory reactivation) improves later recall [7].\n- Spindle density correlates with overnight gains in declarative memory [5].\n- REM sleep appears to support emotional and procedural memory more than facts [4].',
      metadata: { totalElapsedSeconds: 74, outcome: 'complete' },
      searchMeta: { searchRequested: true, searchSucceeded: true, contextAvailable: true, sourceCount: 7, researchSummary: 'Converging evidence: hippocampal replay coupled to slow oscillations and spindles drives systems consolidation; REM contributes mainly to emotional and procedural memory.' },
      sources: researchSources,
      agentSteps: [
        { id: 'r-s1', type: 'searching', toolName: 'web_search', label: 'Search', status: 'done', detail: '7 results', research: { query: 'sleep memory consolidation mechanisms', results: 7 } },
        { id: 'r-s2', type: 'searching', toolName: 'web_search', label: 'Search', status: 'done', detail: '6 results', research: { query: 'hippocampal replay slow oscillations spindles', results: 6 } },
        { id: 'r-r1', type: 'reading', toolName: 'fetch_url', label: 'Read', status: 'done', research: { url: 'https://pubmed.ncbi.nlm.nih.gov/37023710/', title: 'Sleep — a brain-state serving systems memory consolidation' } },
        { id: 'r-r2', type: 'reading', toolName: 'fetch_url', label: 'Read', status: 'done', research: { url: 'https://www.nature.com/articles/nrn2762', title: 'The memory function of sleep' } },
        { id: 'r-s3', type: 'searching', toolName: 'web_search', label: 'Search', status: 'done', detail: '4 results', research: { query: 'targeted memory reactivation sleep evidence', results: 4 } }
      ]
    }
  ]
});

// Real work: files made outside the app, the way a user's own files arrive.
function officeArtifact(title: string, path: string, kind: string, dataUrl: string) {
  return {
    title,
    files: { [path]: dataUrl },
    manifest: { schemaVersion: 1, kind, presentation: 'document', entryPath: path, status: 'ready' }
  };
}
savedSessions.push({
  id: 'chat-realwork',
  title: 'Board pack for Q3',
  createdAt: Date.now() - 600_000,
  updatedAt: Date.now() - 600_000,
  folderId: null,
  draft: '',
  contextMode: 'home',
  projectId: null,
  messages: [
    { id: 'r0', role: 'user', content: 'Prepare the Q3 board pack: the report, the review deck and the operating model.', createdAt: Date.now() - 600_000 },
    {
      id: 'r1',
      role: 'assistant',
      content: 'Here is the board pack: a 2-page report, an 8-slide review deck and the FY2026 operating model.',
      createdAt: Date.now() - 590_000,
      artifacts: [
        officeArtifact('Q3 2026 Board Report', 'q3-board-report.docx', 'document', REAL_DOCX),
        officeArtifact('Q3 2026 Business Review', 'q3-business-review.pptx', 'presentation', REAL_PPTX),
        officeArtifact('FY2026 Operating Model', 'fy2026-operating-model.xlsx', 'spreadsheet', REAL_XLSX)
      ]
    }
  ]
});

/** Last runtime mode set via agente_set_runtime_mode — steers the script. */
let runtimeMode: 'full' | 'supervised' | 'plan' = 'supervised';
const savedProjects: Record<string, unknown>[] = [
  {
    id: 'proj-1',
    rootPath: '/home/work/Code/demo-app',
    rootName: 'demo-app',
    icon: null,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 3_600_000
  },
  {
    id: 'proj-2',
    rootPath: '/home/work/Code/missing-app',
    rootName: 'missing-app',
    icon: null,
    createdAt: Date.now() - 186_400_000,
    updatedAt: Date.now() - 186_400_000
  }
];

const mockLocalModel = {
  id: 'qwen3-4b-q4',
  name: 'Qwen3-4B-Instruct-Q4_K_M.gguf',
  path: '/home/work/models/Qwen3-4B-Instruct-Q4_K_M.gguf',
  size_gb: 2.5,
  modified_time: Date.now() - 86_400_000,
  architecture: 'qwen3',
  context_length: 40_960,
  parameter_count: 4_000_000_000,
  quantization_name: 'Q4_K_M',
  block_count: 36,
  chat_template_uses_tools: true,
  indexed_at: Date.now(),
  cache_key: 'mock'
};

const config = {
  llm: {
    backend_mode: 'api',
    provider: 'openrouter',
    providers: {
      openrouter: { base_url: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-flash', has_api_key: true }
    }
  },
  ui: {},
  search: { engines: {} }
};

function emit(channel: string, payload: unknown): void {
  for (const listener of eventListeners.get(channel) ?? []) {
    setTimeout(() => listener(payload), 0);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scripted agent run: text → read tool → approval-gated write → summary. */
async function scriptAgentRun(chatId: string): Promise<void> {
  const send = (payload: Record<string, unknown>) => emit('code_agent_event', { chatId, ...payload });

  await wait(150);
  send({ type: 'agent_start' });
  await wait(100);
  send({ type: 'turn_start', turnIndex: 1 });

  for (const delta of runtimeMode === 'plan'
    ? ['Here is my plan:\n1. ', 'Read src/index.ts to see the boot call.\n2. ', 'Add a verbose flag to boot().\n3. ', 'Verify the file parses.']
    : ['Alright, ', 'let me inspect ', 'the project first.']) {
    await wait(120);
    send({ type: 'text_delta', delta });
  }
  send({ type: 'usage', promptTokens: 3240, completionTokens: 42, totalTokens: 3282, contextWindow: 200_000 });

  await wait(150);
  send({ type: 'tool_start', toolCallId: 'tc-read-1', toolName: 'read', args: { path: 'src/index.ts' } });
  await wait(400);
  send({ type: 'tool_end', toolCallId: 'tc-read-1', result: '1  import { boot } from "./app";\n2  boot();', isError: false });

  await wait(200);
  send({ type: 'tool_start', toolCallId: 'tc-write-1', toolName: 'edit', args: { path: 'src/index.ts' } });
  await wait(250);
  send({
    type: 'approval_request',
    requestId: 'apr-1',
    toolName: 'edit',
    args: { path: 'src/index.ts' },
    diff: '--- src/index.ts\n+++ src/index.ts\n-boot();\n+boot({ verbose: true });',
    ...(runtimeMode === 'plan' ? { kind: 'plan' as const } : {})
  });

  // The decision arrives when the user clicks Allow/Deny (agente_respond_approval).
}

async function finishApprovedRun(chatId: string, decision: 'allow' | 'deny'): Promise<void> {
  const send = (payload: Record<string, unknown>) => emit('code_agent_event', { chatId, ...payload });
  send({ type: 'approval_resolved', requestId: 'apr-1', decision });
  await wait(200);
  send({
    type: 'tool_end',
    toolCallId: 'tc-write-1',
    result: decision === 'allow' ? 'Edited src/index.ts: replaced 1 occurrence(s).' : 'Blocked: user denied.',
    isError: decision !== 'allow'
  });
  await wait(150);
  send({
    type: 'checkpoint_finalized',
    turnIndex: 1,
    files: decision === 'allow' ? [{ path: 'src/index.ts', additions: 1, deletions: 1, kind: 'modified' }] : []
  });
  await wait(150);
  for (const delta of decision === 'allow'
    ? ['Done — ', '`src/index.ts` now boots with verbose mode. ', 'Tests would go here next.']
    : ['Understood — ', 'I left the file untouched. ', 'Tell me how you\u2019d like to proceed.']) {
    await wait(120);
    send({ type: 'text_delta', delta });
  }
  await wait(150);
  send({ type: 'turn_end', turnIndex: 1 });
  send({ type: 'usage', promptTokens: 4120, completionTokens: 96, totalTokens: 4216, contextWindow: 200_000 });
  send({ type: 'agent_end', stopReason: 'stop' });
}

// ── Agente Bot (the Bots screen) ────────────────────────────────────────
type MockBot = { handle: string; title: string; role: string; avatar: { initials?: string; tint: string }; builtin: boolean; working: boolean; session_id: string | null; soul: string; user: string; memory: string; daily_budget?: number; spent_today?: number };
const mockBots: MockBot[] = [
  { handle: 'colina', title: 'Colina', role: 'your everyday assistant', avatar: { initials: 'C', tint: 'green' }, builtin: true, working: false, session_id: 's-colina', daily_budget: 2, spent_today: 0.37, soul: 'Colina is warm, direct and practical.', user: 'Works on Agente; prefers short answers.', memory: 'Favorite color: teal.\n' },
  { handle: 'scout', title: 'Scout', role: 'researches things and reports back', avatar: { initials: 'S', tint: 'blue' }, builtin: false, working: false, session_id: 's-scout', soul: 'Precise and brief.', user: '', memory: '' },
  { handle: 'quill', title: 'Quill', role: 'writes and edits', avatar: { initials: 'Q', tint: 'yellow' }, builtin: false, working: false, session_id: null, soul: '', user: '', memory: '' }
];
const mockTelegram: { connected: boolean; username: string | null; error: string | null; paired: Array<{ chat_id: number; name: string; trust: string; paired_at: string }>; pairing: { code: string; trust: string; expires_at: string } | null } = {
  connected: true,
  username: 'colina_agente_bot',
  error: null,
  paired: [{ chat_id: 1, name: 'Fabricio (@fab)', trust: 'owner', paired_at: new Date().toISOString() }],
  pairing: null
};
const mockRoutines: Record<string, Record<string, unknown>[]> = {
  colina: [
    { id: 'morning-brief', title: 'Morning brief', prompt: 'Summarize what is on my plate today.', schedule: { every: 'weekdays', at: '08:00' }, paused: false, created_at: new Date(Date.now() - 86_400_000 * 3).toISOString(), last_run: { at: new Date(Date.now() - 3_600_000 * 5).toISOString(), status: 'completed' }, next_run: new Date(Date.now() + 3_600_000 * 19).toISOString() },
    { id: 'weekly-review', title: 'Weekly review', prompt: 'What did we finish this week?', schedule: { every: 'week', day: 'fri', at: '17:00' }, paused: true, created_at: new Date().toISOString(), last_run: null, next_run: null }
  ]
};
const botEvent = (handle: string, event: Record<string, unknown>) => emit('bot_event', { handle, event: { chatId: `bot:${handle}`, ...event } });
const botHistory: Record<string, unknown[]> = {
  colina: [
    { prompt: 'Summarize what is on my plate today.', source: { kind: 'routine', title: 'Morning brief' }, events: [
      { type: 'agent_start', chatId: 'bot:colina' },
      { type: 'text_delta', chatId: 'bot:colina', delta: 'Three things today:\n\n1. Review the **Bots screen** PR.\n2. Tag `v0.2.1` once Windows CI is green.\n3. Reply to the release notes thread.' },
      { type: 'agent_end', chatId: 'bot:colina', stopReason: 'stop' }
    ] },
    { prompt: 'What is 17 times 23? Ask Scout.', source: { kind: 'user' }, events: [
      { type: 'agent_start', chatId: 'bot:colina' },
      { type: 'text_delta', chatId: 'bot:colina', delta: 'Asking Scout.' },
      { type: 'tool_start', chatId: 'bot:colina', toolCallId: 'h1', toolName: 'message_bot', args: { to: '@scout', message: 'What is 17 times 23?' } },
      { type: 'tool_end', chatId: 'bot:colina', toolCallId: 'h1', result: '@scout replied:\n\n391', isError: false, status: 'done' },
      { type: 'text_delta', chatId: 'bot:colina', delta: '17 × 23 is **391**.' },
      { type: 'agent_end', chatId: 'bot:colina', stopReason: 'stop' }
    ] }
  ],
  scout: [
    { prompt: 'What is 17 times 23?', source: { kind: 'handoff', from: 'colina' }, events: [
      { type: 'agent_start', chatId: 'bot:scout' },
      { type: 'text_delta', chatId: 'bot:scout', delta: '391' },
      { type: 'agent_end', chatId: 'bot:scout', stopReason: 'stop' }
    ] }
  ]
};
const botHandlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
  bots_list: () => mockBots.map(({ soul: _s, user: _u, memory: _m, ...bot }) => bot),
  bots_get: (args) => mockBots.find((bot) => bot.handle === args?.handle),
  bots_history: (args) => botHistory[String(args?.handle)] ?? [],
  routines_list: (args) => mockRoutines[String(args?.handle)] ?? [],
  routines_save: (args) => ({ ...(args?.routine as object), id: 'new', created_at: new Date().toISOString(), last_run: null, next_run: null }),
  routines_delete: () => ({ deleted: true }),
  routines_run_now: () => ({ turn_id: 't-run' }),
  bots_create: (args) => {
    const { title = 'Bot', role = '', soul = '', avatar } = (args ?? {}) as { title?: string; role?: string; soul?: string; avatar?: { tint?: string } };
    const handle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const bot: MockBot = { handle, title, role, soul, avatar: { tint: avatar?.tint ?? 'blue' }, builtin: false, working: false, session_id: null, user: '', memory: '' };
    mockBots.push(bot);
    return bot;
  },
  bots_update: (args) => {
    const bot = mockBots.find((item) => item.handle === args?.handle);
    if (bot) Object.assign(bot, args?.config as object);
    return bot;
  },
  bots_write_doc: () => ({ ok: true }),
  bots_telegram: () => ({ ...mockTelegram }),
  bots_telegram_connect: () => Object.assign(mockTelegram, { connected: true, username: 'colina_agente_bot', error: null }),
  bots_telegram_disconnect: () => Object.assign(mockTelegram, { connected: false, username: null, paired: [], pairing: null }),
  bots_telegram_pair: (args) => {
    mockTelegram.pairing = { code: '482913', trust: String(args?.trust ?? 'trusted'), expires_at: new Date(Date.now() + 600_000).toISOString() };
    return mockTelegram.pairing;
  },
  bots_telegram_unpair: (args) => Object.assign(mockTelegram, { paired: mockTelegram.paired.filter((chat) => chat.chat_id !== args?.chat_id) }),
  bots_delete: (args) => {
    const index = mockBots.findIndex((bot) => bot.handle === args?.handle);
    if (index >= 0) mockBots.splice(index, 1);
    return { deleted: true };
  },
  bots_compact: () => ({ messages: 3 }),
  bots_cancel: () => ({ ok: true }),
  bots_respond_approval: () => ({ ok: true }),
  bots_chat: (args) => {
    const handle = String(args?.handle);
    setTimeout(() => botEvent(handle, { type: 'agent_start' }), 150);
    setTimeout(() => botEvent(handle, { type: 'text_delta', delta: 'On it. ' }), 500);
    setTimeout(() => botEvent(handle, { type: 'text_delta', delta: 'Here is a short answer from the mock bot.' }), 900);
    setTimeout(() => {
      // The runtime saves the exchange; the reload after agent_end shows it.
      const chatId = `bot:${handle}`;
      (botHistory[handle] ??= []).push({ prompt: String(args?.text ?? ''), source: { kind: 'user' }, events: [
        { type: 'agent_start', chatId },
        { type: 'text_delta', chatId, delta: 'On it. Here is a short answer from the mock bot.' },
        { type: 'agent_end', chatId, stopReason: 'stop' }
      ] });
      botEvent(handle, { type: 'agent_end', stopReason: 'stop' });
    }, 1200);
    return { turn_id: 't-mock', session_id: `s-${handle}` };
  }
};

const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
  ...botHandlers,
  get_config: () => config,
  save_config: () => ({}),
  update_config: () => ({}),
  is_first_run: () => false,
  get_hardware_limits: () => ({
    total_ram_gb: 32, free_ram_gb: 18, physical_cores: 8, cpu_threads: 16, cpu_model: 'Mock CPU',
    vram_gb: 8, gpu_name: 'Mock GPU 8GB', gpu_backend: 'vulkan', os_platform: 'linux', os_arch: 'x64'
  }),
  get_gguf_metadata: () => ({
    architecture: 'llama', quantization_name: 'IQ3_M', parameter_count: 2_000_000_000, file_size_bytes: 1.14 * 1024 ** 3,
    context_length: 131072, block_count: 42, head_count: 32, head_count_kv: 8, embedding_length: 2304,
    chat_template_uses_tools: true, chat_template_supports_thinking: true, chat_template_source: 'builtin',
    chat_template_family: 'minicpm5', has_mtp_layers: false
  }),
  get_recommended_settings: () => ({ context_length: 32768, gpu_layers: 42, cpu_threads: 8, batch_size: 512, backend: 'vulkan' }),
  preview_local_model_command: () => ({ args: [], runtime_path: '/opt/llama-server', command: '/opt/llama-server -m model.gguf --fit on --port 11435' }),
  get_desktop_capabilities: () => ({ platform: 'linux', capabilities: [] }),
  get_runtime_recommendations: () => ({ platform: 'linux', arch: 'x64', gpu_backend: 'vulkan', has_gpu: true, recommended_variant: 'vulkan' }),

  chat_db_load_all: () => savedSessions,
  chat_db_save_session: (args) => {
    // Upsert like the real table (id is the primary key).
    const session = (args as { session?: { id?: string } } | undefined)?.session;
    if (!session) return { ok: true };
    const index = savedSessions.findIndex((entry) => (entry as { id?: string } | null)?.id === session.id);
    if (index >= 0) savedSessions[index] = session;
    else savedSessions.unshift(session);
    return { ok: true };
  },
  chat_db_delete: (args) => {
    const id = (args as { chatId?: string; id?: string } | undefined);
    const target = id?.chatId ?? id?.id;
    const index = savedSessions.findIndex((entry) => (entry as { id?: string } | null)?.id === target);
    if (index >= 0) savedSessions.splice(index, 1);
    return { ok: true };
  },
  chat_db_migrate: () => ({ migrated: 0 }),
  chat_db_load_folders: () => [],
  chat_db_save_folder: () => ({ ok: true }),
  chat_db_delete_folder: () => ({ ok: true }),
  chat_db_load_code_projects: () => savedProjects,
  chat_db_save_code_project: (args) => {
    const project = (args as { project?: Record<string, unknown> } | undefined)?.project;
    if (!project) return { ok: true };
    const index = savedProjects.findIndex((p) => p.id === project.id);
    if (index >= 0) savedProjects[index] = project;
    else savedProjects.unshift(project);
    return { ok: true };
  },
  chat_db_delete_code_project: (args) => {
    const id = (args as { projectId?: string } | undefined)?.projectId;
    const index = savedProjects.findIndex((project) => project.id === id);
    if (index >= 0) savedProjects.splice(index, 1);
    return { ok: true };
  },

  pick_workspace_folder: () => '/home/work/Code/another-demo',
  path_exists: (args) => !String((args as { path?: string } | undefined)?.path ?? '').includes('missing'),
  open_workspace_file: () => undefined,
  agente_delete_session_data: () => ({ ok: true, removed: 1 }),
  agente_live_chats: () => [],

  // Models / runtime: one small local model and one installed runtime, so the
  // Model hub, the load dialog and the ModelSwitcher all have something to show.
  get_indexed_models: () => [mockLocalModel],
  refresh_model_index: () => 1,
  get_installed_runtimes: () => ({ runtimes: [{ id: 'llama-b6000-vulkan', name: 'llama.cpp b6000 (Vulkan)', path: '/mock/bin/llama-server', size_gb: 0.05, modified: Date.now() }] }),
  get_supervisor_status: () => ({ state: 'Stopped', active_model: null, sessions_count: 0 }),
  get_download_jobs: () => [],
  search_hf_models: () => ({ models: [], nextCursor: null }),
  get_api_model_context: () => ({ context_window: 200_000, source: 'mock' }),
  list_rag_documents: () => [],
  preload_tts: () => ({ ok: true }),
  list_tts_voices: () => [],
  chat_db_load_characters: () => [],
  chat_db_load_personas: () => [],
  chat_db_load_worlds: () => [],
  chat_db_save_character: () => ({ ok: true }),
  chat_db_save_persona: () => ({ ok: true }),
  chat_db_save_world: () => ({ ok: true }),
  agente_changes: () => ({
    source: 'git',
    branch: 'main',
    files: [
      { path: 'src/App.svelte', kind: 'modified', additions: 6, deletions: 2 },
      { path: 'src/lib/api.ts', kind: 'created', additions: 12, deletions: 0 }
    ]
  }),
  agente_file_diff: (args) => {
    const file = String((args as { path?: string })?.path ?? '');
    return file.endsWith('api.ts')
      ? { path: file, before: '', after: "export async function load() {\n  const res = await fetch('/api/items');\n  return res.json();\n}\n", binary: false, tooLarge: false }
      : { path: file, before: '<script>\n  let count = 0;\n</script>\n\n<button on:click={() => count++}>\n  Clicked {count}\n</button>\n', after: '<script>\n  import { load } from \'./lib/api\';\n  let count = $state(0);\n  const items = load();\n</script>\n\n<button onclick={() => count++}>\n  Clicked {count} times\n</button>\n', binary: false, tooLarge: false };
  },
  agente_revert_file: () => ({ ok: true }),
  agente_process_list: () => [],
  agente_process_output: () => '',
  agente_process_clear: () => undefined,
  agente_process_stop: () => true,
  agente_process_start: (args) => {
    const { chatId, command, cwd } = args as { chatId: string; command: string; cwd: string };
    const process = { id: `p${Date.now()}`, chatId, command, cwd, pid: 4242, status: 'running', exitCode: null, startedAt: Date.now(), endedAt: null, urls: [] as string[] };
    emit('code_process_event', { type: 'process_start', process });
    setTimeout(() => emit('code_process_event', { type: 'process_output', id: process.id, chatId, chunk: '> vite\n\n  VITE v6.0.0  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n' }), 400);
    setTimeout(() => emit('code_process_event', { type: 'process_url', process: { ...process, urls: ['http://localhost:5173/'] }, url: 'http://localhost:5173/' }), 450);
    return process;
  },
  terminal_create: () => { throw new Error('Terminals need the desktop app'); },
  fetch_provider_models: () => ['deepseek/deepseek-v4-flash', 'moonshotai/kimi-k3', 'qwen/qwen3.8-max', 'z-ai/glm-5.3'],
  // A key containing "bad" is rejected so the failure path can be seen.
  test_provider_connection: (args) => String((args as { apiKey?: string })?.apiKey ?? '').includes('bad')
    ? { ok: false, reason: 'auth', status: 401 }
    : { ok: true, models: ['deepseek/deepseek-v4-flash', 'moonshotai/kimi-k3', 'qwen/qwen3.8-max', 'z-ai/glm-5.3'] },
  get_whisper_runtimes: () => [{ variant: 'vulkan', path: '/mock/bin/whisper-cli', is_active: true }],
  detect_tool_support: () => ({ supportsTools: true, source: 'mock' }),
  get_reasoning_capabilities: () => ({ supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'mock' }),
  count_tokens: () => 0,
  build_context_budget: () => ({}),

  'agente_start_session': (args) => {
    const mode = (args as { runtimeMode?: 'full' | 'supervised' | 'plan' } | undefined)?.runtimeMode;
    if (mode === 'plan' || mode === 'supervised' || mode === 'full') runtimeMode = mode;
    return { sessionId: `sess-${Date.now()}`, resumed: false };
  },
  'agente_prompt': (args) => {
    void scriptAgentRun(String((args as { chatId?: string } | undefined)?.chatId ?? ''));
    return { ok: true };
  },
  'agente_steer': () => ({ ok: true }),
  'agente_follow_up': () => ({ ok: true }),
  'agente_abort': () => ({ ok: true }),
  'agente_compact': () => ({ ok: true }),
  'agente_set_model': () => ({ ok: true }),
  'agente_set_runtime_mode': (args) => {
    const mode = (args as { mode?: 'full' | 'supervised' | 'plan' } | undefined)?.mode;
    if (mode === 'plan' || mode === 'supervised' || mode === 'full') runtimeMode = mode;
    return { ok: true };
  },
  'agente_respond_approval': (args) => {
    const { chatId, decision } = (args ?? {}) as { chatId?: string; decision?: 'allow' | 'deny' };
    void finishApprovedRun(String(chatId ?? ''), decision === 'deny' ? 'deny' : 'allow');
    return { ok: true };
  },
  'agente_list_checkpoints': () => [{ turnIndex: 1, createdAt: Date.now(), fileCount: 1, additions: 1, deletions: 1, files: ['src/index.ts'] }],
  'agente_rollback': () => ({ ok: true, restored: 1, files: ['src/index.ts'] })
};

function installMockElectron(): void {
  if (window.electronAPI) return;
  window.electronAPI = {
    isElectron: true,
    platform: 'linux',
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = handlers[channel];
      if (handler) return Promise.resolve(handler(args[0] as Record<string, unknown> | undefined));
      // Unknown channels resolve benignly so boot never crashes in the harness.
      console.warn(`[mock-electron] unhandled channel: ${channel}`);
      return Promise.resolve(null);
    },
    on: (channel: string, callback: Listener) => {
      let set = eventListeners.get(channel);
      if (!set) {
        set = new Set();
        eventListeners.set(channel, set);
      }
      set.add(callback);
      return () => set!.delete(callback);
    },
    once: (channel: string, callback: Listener) => {
      const wrapped: Listener = (payload) => {
        eventListeners.get(channel)?.delete(wrapped);
        callback(payload);
      };
      let set = eventListeners.get(channel);
      if (!set) {
        set = new Set();
        eventListeners.set(channel, set);
      }
      set.add(wrapped);
      return () => set!.delete(wrapped);
    },
    windowMinimize: () => Promise.resolve(),
    windowToggleMaximize: () => Promise.resolve(),
    windowIsMaximized: () => Promise.resolve(false),
    windowClose: () => Promise.resolve(),
    windowRequestClose: () => Promise.resolve({ closed: true, prompted: false }),
    windowSetActiveWork: () => Promise.resolve()
  } as unknown as Window['electronAPI'];
  console.info('[mock-electron] scripted bridge installed (?mock=1)');
}

installMockElectron();

// Side-effect-only module: `main.ts` imports it for the `?mock=1` harness and
// never reads a symbol from it. The empty export keeps TypeScript treating the
// file as a module (see `main.ts` dynamic import) without exposing dead API.
export {};
