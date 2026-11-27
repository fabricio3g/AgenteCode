import { VISUALIZATION_DEMO } from './mock-visualizations';
// Dev-only browser harness (?mock=1): installs a scripted window.electronAPI
// so the renderer can be exercised in a plain browser without Electron.
// Never imported unless the query flag is present (see src/main.ts).

import type { BrowserPanelState } from '$lib/services/browser';
import { CHAT_STATE_KEY } from '$lib/utils/storage';
import { KICKOFF_PPTX, REAL_DOCX, REAL_PPTX, REAL_XLSX, SAMPLE_DOCX, SAMPLE_XLSX } from './mock-office-files';

import readerPdf from '$lib/features/chat/viewers/__fixtures__/reader.pdf?url';
const PDF_FIXTURE = `data:application/pdf;base64,${btoa(String.fromCharCode(...new Uint8Array(await (await fetch(readerPdf)).arrayBuffer())))}`;

type Listener = (payload: unknown) => void;

// `?chat=<id>` boots straight into one fixture conversation instead of whatever
// the profile last had open. Runs before the store reads its navigation state.
// `&space=code` opens a Code conversation (its own space), home otherwise.
const bootParams = new URLSearchParams(location.search);
const requestedChat = bootParams.get('chat');
if (requestedChat) {
  const space = bootParams.get('space') === 'code' ? 'code' : 'home';
  try {
    localStorage.setItem(`${CHAT_STATE_KEY}.navigation`, JSON.stringify({
      currentChatId: requestedChat,
      activeSpace: space,
      currentChatIdBySpace: { home: space === 'home' ? requestedChat : null, code: space === 'code' ? requestedChat : null, roleplay: null, design: null }
    }));
  } catch {
    /* private mode: the default fixture still loads */
  }
}

const browserOwners = new Map<string, BrowserPanelState>();
let browserTabSequence = 0;
function browserState(args?: Record<string, unknown>): BrowserPanelState {
  const scope = String(args?.scope ?? 'unassigned');
  let state = browserOwners.get(scope);
  if (!state) { state = { scope, tabs: [], activeTabId: null, visible: false, agentDriving: false, takeover: false }; browserOwners.set(scope, state); }
  return state;
}
function pushBrowser(state: BrowserPanelState) { emit('browser_panel_state', { ...state, tabs: [...state.tabs] }); }

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
    messages: [
      { id: 'm1', role: 'user', content: 'Refactor the auth flow', createdAt: Date.now() - 172_800_000 },
      {
        id: 'm2', role: 'assistant', content: 'The session check now lives in one place and both routes use it.', done: true, createdAt: Date.now() - 172_700_000,
        agentSteps: [{ id: 'auth-edit', type: 'editing', toolName: 'edit_file', label: 'Edit', status: 'done', diffStats: [
          { path: 'src/auth/session.ts', kind: 'created', additions: 64, deletions: 0 },
          { path: 'src/routes/login.ts', kind: 'modified', additions: 12, deletions: 31 },
          { path: 'src/routes/account.ts', kind: 'modified', additions: 9, deletions: 27 },
          { path: 'src/auth/legacy-check.ts', kind: 'deleted', additions: 0, deletions: 48 },
          { path: 'tests/auth/session.test.ts', kind: 'created', additions: 85, deletions: 0 }
        ] }]
      }
    ]
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
savedSessions.push({
  id: 'chat-visualizations', title: 'Visualization studio', contextMode: 'home',
  createdAt: Date.now() - 600_000, updatedAt: Date.now() - 600_000, folderId: null, draft: '', projectId: null,
  messages: [{ id: 'viz-demo', role: 'assistant', content: 'An interactive chart catalog, with illustrative sample data.', done: true, createdAt: Date.now() - 600_000, artifacts: VISUALIZATION_DEMO }]
});

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
    html: '<div class="fx-card"><div class="fx-label">Pro</div><div class="fx-value">$12 <span class="fx-small fx-muted">/month</span></div></div>'
  }),
  inlineArtifact('html_card', 'widget.json', {
    title: 'Mortgage calculator',
    html: `<div class="fx-stack">
  <div class="fx-metrics">
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
    { id: 's1', role: 'assistant', content: 'Here they are.', createdAt: Date.now() - 1_790_000, artifacts: showcaseArtifacts,
      agentSteps: [{ id: 'sc-edit', type: 'editing', toolName: 'edit_file', label: 'Edit', status: 'done', diffStats: [
        { path: 'redesign/build.mjs', kind: 'created', additions: 78, deletions: 0, after: "import { icons } from './icons.mjs';" },
        { path: 'redesign/icons.mjs', kind: 'created', additions: 575, deletions: 0, after: 'export const icons = {};' },
        { path: 'redesign/motions.mjs', kind: 'modified', additions: 59, deletions: 12, after: 'export const motions = {};' },
        { path: 'redesign/index.html', kind: 'created', additions: 796, deletions: 0, after: '<!doctype html>' }
      ] }] }
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

// Reader fixtures: docked preview, attachment dialog and several compact tabs.
savedSessions.push({
  id: 'chat-readers', title: 'Document reader checks', createdAt: Date.now(), updatedAt: Date.now(), folderId: null, draft: '', contextMode: 'home', projectId: null,
  messages: [{ id: 'reader-upload', role: 'user', content: 'Read these documents.', createdAt: Date.now(), attachments: [
    { id: 'pdf-attachment', name: 'reader.pdf', type: 'application/pdf', kind: 'document', status: 'ready', size: 10000, data: PDF_FIXTURE },
    { id: 'docx-attachment', name: 'board-report.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document', status: 'ready', size: 10000, data: REAL_DOCX },
    { id: 'xlsx-attachment', name: 'operating-model.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'document', status: 'ready', size: 10000, data: REAL_XLSX },
    { id: 'pptx-attachment', name: 'business-review.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'document', status: 'ready', size: 10000, data: REAL_PPTX }
  ] }, { id: 'reader-docs', role: 'assistant', content: 'A PDF with 16 pages, mixed page sizes and selectable text.', createdAt: Date.now(),
    artifacts: [officeArtifact('Continuous PDF reader', 'reader.pdf', 'document', PDF_FIXTURE), {
      title: 'Reading notes', files: { 'notes.md': '# Reading notes\n\nQuiet controls give the document more room.\n\n## Pages\nSearch this document with Ctrl+F.', 'notes.txt': 'Quiet controls give the document more room.\n'.repeat(80) },
      manifest: { schemaVersion: 1, kind: 'document', presentation: 'document', entryPath: 'notes.md', status: 'ready' }
    }] }]
});

// Typography fixture: one turn that exercises every markdown block the chat can
// render, so the reading column, code chrome, tables and lists can be checked in
// one screen. Open it with `?mock=1&chat=chat-typography`.
const TYPOGRAPHY_SAMPLE = `# Retry budget

The retry budget is now bounded by wall-clock time instead of attempt count, so a request that keeps failing against a slow upstream no longer holds a connection for the whole attempt ladder: the scheduler reclaims the slot as soon as the deadline passes, and the caller gets the last error instead of waiting for a retry that was never going to fit inside the budget it was given.

This paragraph arrives hard-wrapped by the model at
eighty columns, so it shows whether soft line breaks
reflow into the reading column or stay where the
model put them.

## What changed

- **Deadline first.** \`retry.deadlineMs\` caps the whole ladder, so three attempts of five seconds cannot become a fifteen second stall.
- **Jittered backoff**, capped at two seconds:
  - base delay 120ms
  - multiplier 1.8
  - full jitter
- Per-host concurrency stays at four, unchanged.

1. Drain in-flight requests.
2. Rebuild the ladder from the new budget.
3. Replay the queue in priority order.

- [x] Deadline plumbed through the scheduler
- [ ] Retire the attempt-count guard

> Retries are a budget, not a count. Spending time is what costs the user.

---

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| \`deadlineMs\` | number | 15000 | Wall-clock cap for the whole ladder, measured from the first attempt |
| \`maxAttempts\` | number | 5 | Kept for compatibility; the deadline wins whenever both are set |
| \`baseDelayMs\` | number | 120 | First backoff step, before jitter |

| Host | Requests | Failures | p95 |
| ---: | ---: | ---: | ---: |
| api.example.com | 1204 | 3 | 218ms |
| cdn.example.com | 8891 | 0 | 41ms |
| search.example.com | 512 | 17 | 902ms |

The migration notes live at [the runbook](https://example.com/docs/runbooks/retry-budget-migration?section=rollout&revision=2026-03-14) and the ladder itself is \`src/net/retry/ladder.ts\`, whose installed path is /opt/agente/runtimes/current/lib/net/retry/ladder.ts.

\`\`\`ts
export function ladder(budget: Budget): Step[] {
  const steps: Step[] = [];
  let delay = budget.baseDelayMs;
  while (steps.length < budget.maxAttempts && budget.remaining() > delay) {
    steps.push({ delay, jitter: 'full' });
    delay = Math.min(delay * 1.8, 2_000);
  }
  return steps;
}
\`\`\`

\`\`\`bash
agente run --profile slow-upstream --deadline-ms 15000
\`\`\`

Follow [the migration guide](https://example.com/docs/migration) before flipping the flag in production.

Inline \`deadlineMs\`, ~~attempt counts~~, **wall-clock budgets** and *jitter* all render here.

$$\\text{budget} = \\min(\\text{deadline},\\ \\sum_i \\text{delay}_i)$$

#### Migration notes

![Agente icon](/app-icon.png)
`;

savedSessions.unshift({
  id: 'chat-typography',
  title: 'Retry budget typography',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  folderId: null,
  draft: '',
  contextMode: 'home',
  projectId: null,
  messages: [
    {
      id: 'typo-user',
      role: 'user',
      content: 'Show me the retry budget change. I want the deadline, the new backoff shape and the numbers we measured against each host, with the migration notes underneath.',
      createdAt: Date.now() - 60_000
    },
    { id: 'typo-assistant', role: 'assistant', content: TYPOGRAPHY_SAMPLE, createdAt: Date.now() - 59_000 }
  ]
});

/**
 * Subagent fixture: a finished child with a long answer (the clamp), one still
 * running (the tail), and one that failed (the error state).
 */
const SUBAGENT_LONG_TEXT = `## Findings

The transcript walks its content twice per frame: once to measure the block and once to paint it, and nothing is kept between deltas, so every flush re-parses the answer the model just grew by a few characters.\n\nThe cheap fix is the one already in the renderer: keep the settled prefix in its own element and let only the tail re-render, which is what the streaming split does for the main reply.\n\nSecond finding: the card scrolled inside the transcript instead of letting the transcript scroll it, so a long answer arrived in a 320px window with a second scrollbar of its own.\n\nThird: the reply was forwarded twice, once as deltas and once as the finished message, so the card printed the whole thing twice, run together with no separator between the copies.\n\n`;

const childSpend = (costUsd: number, promptTokens: number) => ({ costUsd, estimated: false, unpriced: false, promptTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });

// Every step kind in one run, so the live work layouts can be compared side by
// side (`?mock=1&space=code&chat=chat-layouts`).
savedSessions.push({
  id: 'chat-layouts',
  title: 'Work layouts',
  createdAt: Date.now() - 40_000,
  updatedAt: Date.now() - 40_000,
  folderId: null,
  draft: '',
  contextMode: 'code',
  projectId: 'proj-1',
  messages: [
    { id: 'wl-user', role: 'user', content: 'Find where the session expiry is checked and make it configurable.', createdAt: Date.now() - 40_000 },
    {
      id: 'wl-assistant', role: 'assistant', done: true, createdAt: Date.now() - 39_000,
      content: 'Expiry is now read from `auth.sessionTtl`, defaulting to 30 minutes; the tests pass.',
      agentSteps: [
        { id: 'wl-1', type: 'searching', label: 'Search', toolName: 'grep', status: 'done', detail: 'sessionExpiry', output: 'src/auth/session.ts:14\nsrc/routes/login.ts:40', startedAt: Date.now() - 39_000, durationMs: 120 },
        { id: 'wl-2', type: 'reading', label: 'Read', toolName: 'read', status: 'done', detail: 'src/auth/session.ts', output: 'export const SESSION_TTL = 30 * 60_000;', startedAt: Date.now() - 38_800, durationMs: 30 },
        { id: 'wl-3', type: 'reading', label: 'List', toolName: 'list_dir', status: 'done', detail: 'src/config', output: 'index.ts\nschema.ts', startedAt: Date.now() - 38_700, durationMs: 20 },
        { id: 'wl-4', type: 'searching', label: 'Search the web', toolName: 'web_search', status: 'done', detail: 'OWASP session timeout guidance', output: 'Session Management Cheat Sheet https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html\nSet-Cookie expiry https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie\nIdle timeout guidance https://pages.nist.gov/800-63-3/sp800-63b.html', startedAt: Date.now() - 38_600, durationMs: 1_400 },
        { id: 'wl-5', type: 'editing', label: 'Edit', toolName: 'edit_file', status: 'done', detail: 'src/auth/session.ts', diffStats: [{ path: 'src/auth/session.ts', kind: 'modified', additions: 6, deletions: 2, patch: '--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -12,4 +12,8 @@\n-export const SESSION_TTL = 30 * 60_000;\n+import { config } from \'../config\';\n+\n+export const SESSION_TTL = config.auth.sessionTtl ?? 30 * 60_000;\n' }], startedAt: Date.now() - 37_000, durationMs: 60 },
        { id: 'wl-6', type: 'executing', label: 'Run', toolName: 'bash', status: 'error', detail: 'npm test -- auth', output: '1 failing: expected 1800000 to equal 900000', startedAt: Date.now() - 36_900, durationMs: 4_100 },
        { id: 'wl-7', type: 'editing', label: 'Edit', toolName: 'edit_file', status: 'done', detail: 'tests/auth/session.test.ts', diffStats: [{ path: 'tests/auth/session.test.ts', kind: 'modified', additions: 3, deletions: 1 }], startedAt: Date.now() - 32_000, durationMs: 40 },
        { id: 'wl-8', type: 'executing', label: 'Run', toolName: 'bash', status: 'done', detail: 'npm test -- auth', output: '12 passing', startedAt: Date.now() - 31_900, durationMs: 3_800 }
      ]
    }
  ]
});

savedSessions.push({
  id: 'chat-subagents',
  title: 'Subagent cards',
  createdAt: Date.now() - 30_000,
  updatedAt: Date.now() - 30_000,
  folderId: null,
  draft: '',
  contextMode: 'code',
  projectId: 'proj-1',
  pendingPrompts: new URLSearchParams(window.location.search).has('queue') ? [
    { id: 'queue-one', content: 'Revisa el resultado y ejecuta las pruebas' },
    { id: 'queue-two', content: 'Resume los cambios cuando termines' }
  ] : [],
  messages: [
    ...(bootParams.has('dial') ? Array.from({ length: 8 }, (_, index) => ({
      id: `dial-${index}`, role: index % 2 ? 'assistant' : 'user',
      content: `${index % 2 ? 'Checked' : 'Please inspect'} step ${index + 1}. ${'A longer conversation makes the navigation dial scrollable. '.repeat(8)}`,
      createdAt: Date.now() - 100_000 + index * 1000, done: true
    })) : []),
    { id: 'sub-user', role: 'user', content: 'Map how the transcript renders and where it re-parses per delta.', createdAt: Date.now() - 30_000 },
    {
      id: 'sub-assistant',
      role: 'assistant',
      content: 'Two subagents reported back; the third is still running.',
      createdAt: Date.now() - 29_000,
      agentSteps: [
        { id: 'sub-s1', type: 'reading', label: 'Read', toolName: 'read', status: 'done', detail: 'renderer/src/lib/features/code/CodeTranscript.svelte', startedAt: Date.now() - 29_000, durationMs: 40 },
        { id: 'sub-s2', type: 'tool', label: 'Task', toolName: 'task', status: 'done', detail: 'Map transcript rendering', subagentType: 'explore', subagentId: 'child-done', startedAt: Date.now() - 28_900, durationMs: 134_000 },
        { id: 'sub-s3', type: 'executing', label: 'Run', toolName: 'bash', status: 'done', detail: 'npm run check', startedAt: Date.now() - 28_800, durationMs: 9_200, output: 'svelte-check found 0 errors and 0 warnings' }
      ],
      metadata: {
        codeUsage: { promptTokens: 720_982, completionTokens: 1_200, totalTokens: 722_182, contextWindow: 1_000_000,
          breakdown: { system: 18_000, messages: 238_000, toolResults: 410_000, tools: 32_000, overhead: 22_982, reserve: 100_000, window: 1_100_000 } },
        codeTimeline: [{ kind: 'step', id: 'sub-s1' }, { kind: 'step', id: 'sub-s2' }, { kind: 'step', id: 'sub-s3' }],
        codeChildren: [
          {
            id: 'child-done', kind: 'explore', description: 'Map transcript rendering', status: 'done',
            text: SUBAGENT_LONG_TEXT,
            summary: 'The reply paints once per frame and caches nothing between deltas.',
            tools: [
              { id: 'sub-t1', name: 'grep', output: 'thread/Thread.svelte:318\nRichContent.svelte:71', status: 'done' },
              { id: 'sub-t2', name: 'read_file', output: 'The settled prefix is written once; only the tail re-renders.', status: 'done' }
            ],
            spend: childSpend(0.012, 18_400),
            model: 'anthropic/claude-sonnet-4'
          },
          {
            id: 'child-running', kind: 'general-purpose', description: 'Patch the delta path', status: 'running',
            text: 'Reading the streaming split, then the reveal buffer that feeds it. ', tools: [], spend: childSpend(0.004, 5_100),
            model: 'deepseek/deepseek-v4-flash'
          },
          {
            id: 'child-error', kind: 'explore', description: 'Survey the terminal renderer', status: 'error',
            text: '', summary: 'Stopped before it finished.', tools: [], spend: childSpend(0, 0)
          }
        ]
      }
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

  // A task list, so the plan card has something to draw.
  const todos = (current: number) => ['Read the entry point', 'Find the boot call', 'Add a verbose flag to boot()', 'Wire the flag through the CLI', 'Update the README', 'Run the tests']
    .map((content, index) => ({ content, status: index < current ? 'completed' : index === current ? 'in_progress' : 'pending' }));
  await wait(150);
  send({ type: 'tool_start', toolCallId: 'tc-todo-1', toolName: 'todo_write', args: {} });
  send({ type: 'todo_update', todos: todos(0) });
  send({ type: 'tool_end', toolCallId: 'tc-todo-1', result: 'ok', isError: false });

  await wait(150);
  send({ type: 'tool_start', toolCallId: 'tc-read-1', toolName: 'read', args: { path: 'src/index.ts' } });
  await wait(400);
  send({ type: 'tool_end', toolCallId: 'tc-read-1', result: '1  import { boot } from "./app";\n2  boot();', isError: false });
  send({ type: 'tool_start', toolCallId: 'tc-todo-2', toolName: 'todo_write', args: {} });
  send({ type: 'todo_update', todos: todos(2) });
  send({ type: 'tool_end', toolCallId: 'tc-todo-2', result: 'ok', isError: false });

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

const browserHandlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
  browser_get_state: (args) => browserState(args),
  browser_select_scope: (args) => browserState(args),
  browser_open_tab: (args) => {
    const state = browserState(args);
    const tab = { id: `btab-${++browserTabSequence}`, url: String(args?.url ?? ''), title: args?.url ? 'Example Domain' : '', preset: 'desktop' as const };
    state.tabs.push(tab); state.activeTabId = tab.id; state.visible = true;
    pushBrowser(state); return tab;
  },
  browser_list_tabs: (args) => browserState(args).tabs,
  browser_set_active: (args) => { const state = browserState(args); state.activeTabId = String(args?.tabId); pushBrowser(state); },
  browser_close_tab: (args) => {
    const state = browserState(args); state.tabs = state.tabs.filter((tab) => tab.id !== (args?.tabId ?? state.activeTabId));
    state.activeTabId = state.tabs.at(-1)?.id ?? null; state.visible = !!state.tabs.length; pushBrowser(state);
  },
  browser_pick_element: () => [{ selector: 'button#buy', tag: 'button', role: '', text: 'Buy now', attributes: { type: 'button' }, outerHTML: '<button id="buy" type="button">Buy now</button>', rect: { x: 10, y: 10, width: 90, height: 32 }, url: 'https://example.com/page', title: 'Example' }],
  browser_pick_cancel: () => undefined,
  browser_panel_presentation: () => ({ image: null }),
  browser_panel_visible: (args) => { const state = browserState(args); state.visible = !!args?.visible; pushBrowser(state); return { ok: true }; },
  browser_takeover: (args) => { const state = browserState(args); state.takeover = !!args?.on; pushBrowser(state); },
  browser_viewport: (args) => { const state = browserState(args); const tab = state.tabs.find((tab) => tab.id === (args?.tabId ?? state.activeTabId)); if (tab) tab.preset = args?.preset as typeof tab.preset; pushBrowser(state); },
  browser_navigate: (args) => { const state = browserState(args); const tab = state.tabs.find((tab) => tab.id === (args?.tabId ?? state.activeTabId)); if (tab) tab.url = String(args?.url); pushBrowser(state); },
  link_preview: (args) => {
    const raw = String(args?.url ?? '');
    try {
      const u = new URL(raw);
      return { url: u.toString(), host: u.hostname, title: u.hostname, description: 'Mock preview' };
    } catch {
      return { url: raw, host: '', title: '', description: '', error: 'Invalid URL' };
    }
  },

};

const designWorkspaces = new Map<string, Record<string, string>>();
function designWorkspace(chatId: string): Record<string, string> {
  let files = designWorkspaces.get(chatId);
  if (!files) {
    files = {
      'tokens.css': ':root{--bg:#f7f6f3;--surface:#fff;--text:#1d1d1b;--muted:#6b6a65;--accent:#3b5bdb;--radius:14px;--space:16px;--duration-fast:150ms;--duration-base:250ms;--duration-slow:400ms;--ease-out:cubic-bezier(0.2,0,0,1)}\n@media (prefers-color-scheme:dark){:root{--bg:#161614;--surface:#1f1f1c;--text:#f1f0ec;--muted:#9a988f;--accent:#8aa2ff}}',
      'index.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"><style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--text)}main{max-width:720px;margin:0 auto;padding:calc(var(--space)*4) var(--space)}h1{font-size:2.25rem;letter-spacing:-.02em;margin:0 0 var(--space)}p{color:var(--muted)}a{display:inline-block;margin-top:var(--space);padding:12px 20px;border-radius:var(--radius);background:var(--accent);color:#fff;text-decoration:none}@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@media (prefers-reduced-motion:no-preference){h1{animation:rise var(--duration-slow) var(--ease-out) both}p{animation:rise var(--duration-base) var(--ease-out) 120ms both}a{transition:transform var(--duration-fast) var(--ease-out)}a:hover{transform:translateY(-2px)}}</style></head><body><main><h1>A calmer way to plan</h1><p>This is a sample page in the mock workspace.</p><a href="#">Get started</a></main></body></html>'
    };
    designWorkspaces.set(chatId, files);
  }
  return files;
}

interface MockSystem { id: string; name: string; description: string; createdAt: number; updatedAt: number; origin: 'design' | 'folder'; files: Record<string, string> }
const mockSystems: MockSystem[] = [{
  id: 'mock-calm', name: 'Calm studio', description: 'Quiet neutrals, one blue accent', createdAt: Date.now(), updatedAt: Date.now(), origin: 'folder',
  files: {
    'tokens.css': ':root{--bg:#f7f6f3;--surface:#fff;--text:#1d1d1b;--muted:#6b6a65;--accent:#3b5bdb;--radius:14px;--space:16px}',
    'DESIGN.md': '# Calm studio\n\nOne accent colour. Generous space. Soft edges, no heavy borders.',
    'components.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"><style>body{margin:0;padding:24px;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--text)}button{padding:10px 18px;border:0;border-radius:var(--radius);background:var(--accent);color:#fff}</style></head><body><h1>Calm studio</h1><p>Type, colour and components.</p><button>Continue</button></body></html>'
  }
}];
const designLinks = new Map<string, string>();

const mockGoals = new Map<string, { objective: string; status: 'active' | 'completed' }>();
const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
  agente_goal_get: (args) => mockGoals.get(String(args?.sessionId)) ?? null,
  agente_goal_set: (args) => {
    const goal = { objective: String(args?.objective ?? ''), status: args?.status === 'completed' ? 'completed' as const : 'active' as const };
    mockGoals.set(String(args?.sessionId), goal);
    return goal;
  },
  agente_goal_clear: (args) => { mockGoals.delete(String(args?.sessionId)); return { ok: true }; },
  'search:get-catalog': () => [
    { id: 'duckduckgo', label: 'DuckDuckGo', category: 'general', transport: 'html', stability: 'stable', requires: [], supports_safe_search: true, timeout_ms: 8000, recommended: true },
    { id: 'wikipedia', label: 'Wikipedia', category: 'research', transport: 'json', stability: 'stable', requires: [], supports_safe_search: false, timeout_ms: 8000, recommended: true },
    { id: 'arxiv', label: 'arXiv', category: 'research', transport: 'xml', stability: 'stable', requires: [], supports_safe_search: false, timeout_ms: 8000, recommended: false },
    { id: 'searxng', label: 'SearXNG', category: 'self_hosted', transport: 'json', stability: 'beta', requires: ['base_url'], supports_safe_search: true, timeout_ms: 8000, recommended: false },
    { id: 'brave', label: 'Brave Search', category: 'api', transport: 'json', stability: 'stable', requires: ['api_key'], supports_safe_search: true, timeout_ms: 8000, recommended: false }
  ],
  ...browserHandlers,
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

  // `&noprojects` is a first run in Code: no projects and no Code conversations.
  chat_db_load_all: () => (bootParams.has('noprojects') ? savedSessions.filter((entry) => (entry as { contextMode?: string }).contextMode !== 'code') : savedSessions),
  chat_db_save_draft: (args) => {
    const draft = args as { chatId: string; draft: string; codeAgent?: unknown; pendingPrompts?: unknown; updatedAt: number };
    const session = savedSessions.find((entry) => (entry as { id?: string }).id === draft.chatId) as Record<string, unknown> | undefined;
    if (!session) return false;
    Object.assign(session, { draft: draft.draft, codeAgent: draft.codeAgent, pendingPrompts: draft.pendingPrompts, updatedAt: draft.updatedAt });
    return true;
  },
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
  chat_db_load_code_projects: () => (bootParams.has('noprojects') ? [] : savedProjects),
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
  browse_folders: (args) => {
    const home = '/home/demo';
    const path = String((args as { path?: string } | undefined)?.path || home);
    const tree: Record<string, Array<[string, boolean]>> = {
      [home]: [['Code', false], ['Desktop', false], ['Documents', false], ['Downloads', false], ['Music', false], ['Pictures', false]],
      [`${home}/Code`]: [['agente', true], ['dotfiles', true], ['website', true], ['experiments', false], ['notes', false]]
    };
    const parent = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
    return {
      path, parent, home, sep: '/',
      places: [{ name: 'Home', path: home }, { name: 'Desktop', path: `${home}/Desktop` }, { name: 'Documents', path: `${home}/Documents` }, { name: 'Downloads', path: `${home}/Downloads` }, { name: 'Code', path: `${home}/Code` }],
      folders: (tree[path] ?? []).map(([name, isProject]) => ({ name, path: `${path}/${name}`, isProject })).sort((a, b) => Number(b.isProject) - Number(a.isProject))
    };
  },
  create_project_folder: (args) => {
    const { parent, name } = args as { parent: string; name: string };
    return { path: `${parent}/${name}`, gitInitialized: true };
  },
  clone_project_repo: async (args) => {
    const { url, parent, name } = args as { url: string; parent: string; name?: string };
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (url.includes('fail')) throw new Error('Repository not found.');
    const repo = name || url.replace(/\/+$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '');
    return { path: `${parent}/${repo}` };
  },
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
  // A small tree with the shapes that matter: nested folders, a couple of the
  // files the Changes pane lists, and files deep enough to scroll.
  agente_project_files: () => [
    '.gitignore',
    'README.md',
    'package.json',
    'src/App.svelte',
    'src/main.ts',
    'src/lib/api.ts',
    'src/lib/stores/app.svelte.ts',
    'src/lib/components/Chat.svelte',
    'src/lib/components/ui/Button.svelte',
    'src/lib/features/code/CodeSurface.svelte',
    'src/lib/features/code/workspace/ChangesPane.svelte',
    'tests/unit/api.test.ts',
    'tests/unit/components.test.ts',
    'vite.config.ts'
  ],
  agente_reveal_path: () => ({ ok: true }),
  agente_trash_path: () => ({ ok: true }),
  // The project dialogs read this for their skills, agents and commands lists.
  agente_project_info: () => ({
    skills: [{ name: 'find-skills', description: 'Discover installable agent skills.' }],
    commands: [{ name: 'init', description: 'Write an AGENTS.md for this project.' }],
    agents: [
      { name: 'general-purpose', description: 'Multi-step work that spans many files.', builtin: true },
      { name: 'explore', description: 'Read-only survey of an unfamiliar area.', builtin: true },
      { name: 'plan', description: 'A structured implementation plan.', builtin: true }
    ]
  }),
  agente_runtime_settings: () => ({
    smart_compaction: true,
    compaction_model: null,
    max_parallel_subagents: 8,
    subagents: {
      orchestrator_picks: true,
      models: [
        { name: 'scout', provider: 'openrouter', model: 'qwen/qwen3-coder:free', use_for: 'Fast codebase searches and reading docs. Never edits.' },
        { name: 'builder', provider: 'deepseek', model: 'deepseek-pro', use_for: 'Multi-file edits and refactors that need care.' }
      ],
      default_model: 'scout'
    },
    allow_media: ['image', 'audio', 'video']
  }),
  agente_subagent_settings: () => ({ ok: true }),
  agente_board: (args?: Record<string, unknown>) => ({
    enabled: args?.action !== 'disable',
    cards: [
      { id: 'c1', title: 'Map the parser', role: 'Code mapper', capability: 'read-only', model: 'scout', prompt: '', status: 'done', result: 'Parser lives in src/parser; three entry points.' },
      { id: 'c2', title: 'Refactor tokenizer', role: 'Refactorer', capability: 'read-write', model: 'builder', prompt: '', status: 'working', depends_on: ['c1'], owns: ['src/parser/lexer.rs'], child_id: 'child-2' },
      { id: 'c3', title: 'Speed up AST walk', role: 'Performance engineer', capability: 'read-write', model: 'builder', prompt: '', status: 'review', depends_on: ['c1'], owns: ['src/parser/ast.rs'], result: 'Walk is 2.1× faster; tests pass.' },
      { id: 'c4', title: 'Write parser tests', role: 'Test writer', capability: 'read-write', model: 'scout', prompt: '', status: 'backlog', depends_on: ['c2', 'c3'], owns: ['tests/parser.rs'] },
      { id: 'c5', title: 'Update docs', role: 'Docs writer', capability: 'read-write', model: 'scout', prompt: '', status: 'failed', owns: ['docs/parser.md'], result: 'Rate limited by OpenRouter.' }
    ]
  }),
  agente_git_branches: () => ({
    source: 'git',
    current: 'main',
    detached: false,
    dirty: true,
    branches: [
      { name: 'main', commit: 'a1b2c3d', current: true, upstream: 'origin/main', ahead: 0, behind: 2 },
      { name: 'feat/desktop-panels', commit: 'e4f5a6b', current: false, ahead: 3, behind: 0 },
      { name: 'fix/sidebar-width', commit: 'c7d8e9f', current: false, ahead: 0, behind: 0 }
    ]
  }),
  agente_mcp_status: () => [
    { name: 'web', target: 'agente bridge', remote: false, status: 'ready', error: null, tools: 14 },
    { name: 'github', target: 'https://api.githubcopilot.com/mcp/', remote: true, status: 'failed', error: '401 Unauthorized', tools: 0 }
  ],
  agente_git_pull_request: () => ({
    source: 'git', branch: 'main', base: 'main', ahead: 0, compareUrl: null,
    pr: { number: 42, title: 'Session column and subagent pill', url: 'https://github.com/example/demo-app/pull/42', state: 'OPEN', draft: false, checks: 'pending' }
  }),
  agente_git_switch_branch: (args) => ({ ok: true, branch: String((args as { name?: string })?.name ?? 'main') }),
  agente_open_in_editor: () => ({ ok: true, editor: 'code' }),
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
  voice_models_status: () => ({ version: 'v0.8.2', backends: ['cpu', 'vulkan'], downloadable: ['cpu', 'vulkan'], backend: 'cpu', threads: 8, cores: 12, running: false, installed: ['kokoro-82m'], espeak: true, binaryPath: '/opt/agente/bin/audio/cpu/audiocpp_server', port: null, specs: 6, modelsDir: '~/.agente/models/voices' }),
  voice_engine_restart: () => undefined,
  voice_engine_download: () => ({ version: 'v0.8.2', path: '/opt/agente/engines/audio.cpp/vulkan/audiocpp_server' }),
  voice_clone_pick: () => null,
  voice_clone_read: () => null,
  voice_clone_save: (args) => ({ id: `mock-${Date.now()}`, name: String(args?.name ?? ''), file: '/tmp/mock.wav', transcript: args?.transcript, seconds: args?.seconds }),
  voice_clone_delete: () => true,
  voice_catalog: async () => {
    const { VOICE_MODELS } = await import('../../../shared/voice-models');
    const extra = (id: string, title: string, sizeMb: number, status: string, languages: string[], description: string, needsReference = false) => ({
      id, family: id, title, license: '', repo: 'audio-cpp/audio.cpp-gguf', file: `${title}-GGUF/${id}.gguf`, sizeMb, languages, voices: [], espeakLanguages: [], description, status, needsReference
    });
    return [
      ...VOICE_MODELS,
      extra('chatterbox', 'Chatterbox', 2088, 'supported', ['en', 'es', 'fr', 'de'], 'Expressive multilingual speech with emotion exaggeration control.'),
      extra('kitten_tts', 'KittenTTS Mini 0.8', 302, 'community', ['en'], 'Tiny English speech model with eight built-in voices.'),
      extra('qwen3_tts', 'Qwen3-TTS', 1991, 'supported', ['en', 'zh', 'es', 'ja'], 'Natural multilingual speech from the Qwen team.'),
      extra('cosyvoice3', 'CosyVoice3', 2258, 'supported', ['en', 'zh'], 'Zero-shot voice cloning from a short reference clip.', true),
      extra('fish_audio', 'Fish Audio S2 Pro', 6318, 'supported', ['en'], 'Large high-fidelity English speech model.'),
      extra('dramabox', 'DramaBox', 18943, 'experimental', ['en'], 'Long-form dramatic narration.', true)
    ];
  },
  get_engine_overview: () => ({
    llama: { builds: [{ id: 'b11400-vulkan', tag: 'b11400', variant: 'vulkan', path: '/opt/llama/b11400', selected: true, bytes: 120e6, modified: Date.now() }] },
    whisper: { builds: [{ id: 'b5130', tag: 'b5130', variant: 'cpu', path: '/opt/whisper', selected: true, bytes: 40e6, modified: Date.now() }], gpu: { source: 'none', backend: null }, server: false },
    storage: { root: '/home/me/.config/Agente', total: 2.9e9, categories: { chat: 1.78e9, speech: 238e6, voices: 479e6, engines: 198e6, other: 32e6 } }
  }),
  check_whisper_update: () => null,
  // A key containing "bad" is rejected so the failure path can be seen.
  test_provider_connection: (args) => String((args as { apiKey?: string })?.apiKey ?? '').includes('bad')
    ? { ok: false, reason: 'auth', status: 401 }
    : { ok: true, models: ['deepseek/deepseek-v4-flash', 'moonshotai/kimi-k3', 'qwen/qwen3.8-max', 'z-ai/glm-5.3'] },
  get_whisper_runtimes: () => [{ variant: 'vulkan', path: '/mock/bin/whisper-cli', is_active: true }],
  detect_tool_support: () => ({ supportsTools: true, source: 'mock' }),
  list_provider_specs: () => [
    { id: 'opencode-go', name: 'OpenCode Go', group: 'cloud', base_url: 'https://opencode.ai/zen/go/v1', api_format: 'openai', order: 10, models: 'openai_models', key_url: 'https://opencode.ai/auth', docs_url: 'https://opencode.ai/docs/go/' },
    { id: 'opencode', name: 'OpenCode', group: 'cloud', base_url: 'https://opencode.ai/zen/v1', api_format: 'openai', order: 11, models: 'catalog', key_url: 'https://opencode.ai/auth', docs_url: 'https://opencode.ai/docs/zen/' },
    { id: 'openrouter', name: 'OpenRouter', group: 'cloud', base_url: 'https://openrouter.ai/api/v1', api_format: 'openai', order: 20, models: 'openrouter', key_url: 'https://openrouter.ai/settings/keys', docs_url: 'https://openrouter.ai/docs/quickstart' },
    { id: 'deepseek', name: 'DeepSeek', group: 'cloud', base_url: 'https://api.deepseek.com', api_format: 'openai', order: 30, models: 'catalog', key_url: 'https://platform.deepseek.com/api_keys' },
    { id: 'minimax', name: 'MiniMax', group: 'cloud', base_url: 'https://api.minimax.io/anthropic/v1', api_format: 'anthropic', openai_compatible_url: 'https://api.minimax.io/v1', order: 40, models: 'openai_models', key_url: 'https://platform.minimax.io/user-center/basic-information/interface-key' },
    { id: 'glm', name: 'GLM (Z.AI API)', group: 'cloud', base_url: 'https://api.z.ai/api/paas/v4', api_format: 'openai', order: 50, models: 'catalog', key_url: 'https://z.ai/manage-apikey/apikey-list' },
    { id: 'lmstudio', name: 'LM Studio (local)', group: 'local', base_url: 'http://localhost:1234/v1', api_format: 'openai', order: 60, models: 'openai_models' },
    { id: 'ollama', name: 'Ollama (local)', group: 'local', base_url: 'http://localhost:11434/v1', api_format: 'openai', order: 70, models: 'openai_models' },
    { id: 'llamacpp', name: 'llama.cpp (local)', group: 'local', base_url: 'http://127.0.0.1:8080/v1', api_format: 'openai', aliases: ['local'], order: 80, models: 'llamacpp' },
    { id: 'custom', name: 'Custom / Other', group: 'local', base_url: 'http://127.0.0.1:8080/v1', api_format: 'openai', order: 90, models: 'openai_models' }
  ],
  files_list: () => [],
  get_model_card: (args?: Record<string, unknown>) => {
    const model = String(args?.model ?? '');
    const cards: Record<string, unknown> = {
      'deepseek/deepseek-v4-flash': { context: 131072, output: 16384, cost: { input: 0.14, output: 0.28, cacheRead: 0.014 }, inputs: ['text'], tools: true, reasoning: true },
      'moonshotai/kimi-k3': { context: 262144, output: 32768, cost: { input: 0.6, output: 2.5, cacheRead: 0.15 }, inputs: ['text', 'image'], tools: true, reasoning: true },
      'qwen/qwen3.8-max': { context: 1000000, output: 65536, cost: { input: 1.2, output: 6, cacheRead: null }, inputs: ['text', 'image', 'video'], tools: true, reasoning: true },
      'z-ai/glm-5.3': { context: 131072, output: null, cost: { input: 0.3, output: 1.1, cacheRead: null }, inputs: ['text'], tools: true, reasoning: false }
    };
    return cards[model] ?? { context: null, output: null, cost: null, inputs: [], tools: false, reasoning: false };
  },
  get_reasoning_capabilities: () => ({ supported: true, levels: ['off', 'low', 'medium', 'high', 'max'], source: 'catalog', default: 'medium', budgets: { low: 2048, medium: 8192, high: 24576 } }),
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
  'agente_model_inputs': () => ['text', 'image'],
  // Design space: one in-memory workspace per chat, seeded with a small page so the canvas has something to show.
  // Home-runtime turns (Home, Design): a canned streamed reply so a turn completes without the Rust core.
  'home_runtime_start': (args) => {
    const runId = String(args?.runId ?? '');
    const sessionId = String(args?.sessionId ?? `mock-session-${Date.now()}`);
    const reply = 'This is the mock reply: the desktop runtime is not running, so nothing was generated.';
    const send = (payload: Record<string, unknown>, delay: number) => setTimeout(() => emit('home_runtime_event', { runId, ...payload }), delay);
    const envelope = (event: Record<string, unknown>) => ({ type: 'event', envelope: { event } });
    send(envelope({ type: 'assistant_delta', text: reply.slice(0, 40) }), 60);
    send(envelope({ type: 'assistant_delta', text: reply.slice(40) }), 120);
    send({ type: 'outcome', outcome: { status: 'completed' }, snapshot: { revision: 1 } }, 180);
    return { sessionId, turnId: `mock-turn-${Date.now()}`, contextWindow: 128000 };
  },
  'home_runtime_cancel': () => ({ ok: true }),
  'home_runtime_result': () => ({ ok: true }),
  'design_tool': (args) => {
    const { chatId, name, args: toolArgs = {} } = (args ?? {}) as { chatId?: string; name?: string; args?: Record<string, unknown> };
    const files = designWorkspace(String(chatId ?? ''));
    const path = String(toolArgs.path ?? '');
    if (name === 'design_list') return { ok: true, content: Object.keys(files).map((file) => `${file} (${files[file].length} bytes)`).join('\n') };
    if (name === 'design_read') return path in files ? { ok: true, content: files[path] } : { ok: false, content: `No such file: ${path}` };
    if (name === 'design_write') { files[path] = String(toolArgs.content ?? ''); emit('design_changed', { chatId, paths: [path] }); return { ok: true, content: `Wrote ${path}.`, changed: [path] }; }
    if (name === 'design_edit' && path in files) { files[path] = files[path].replace(String(toolArgs.old_text ?? ''), String(toolArgs.new_text ?? '')); emit('design_changed', { chatId, paths: [path] }); return { ok: true, content: `Edited ${path}.`, changed: [path] }; }
    return { ok: false, content: `Unknown design tool: ${String(name)}` };
  },
  'design_files': (args) => {
    const files = designWorkspace(String((args as { chatId?: string } | undefined)?.chatId ?? ''));
    const html = Object.keys(files).filter((file) => file.endsWith('.html'));
    return {
      files: { ...files },
      pages: html.filter((file) => !file.startsWith('variants/')),
      variants: html.filter((file) => file.startsWith('variants/')).map((file) => ({ name: file.split('/')[1], entry: file }))
    };
  },
  'design_render': () => ({ ok: false, error: 'Rendering needs the desktop app.', width: 1440, height: 900, consoleErrors: [] }),
  'design_manage': (args) => {
    const MOCK_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const request = (args ?? {}) as { action?: string; chatId?: string; name?: string };
    if (request.action === 'add_reference') {
      // The browser mock keeps no bytes: the reference appears in the listing as a placeholder.
      const path = `references/${String(request.name ?? 'image').replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'image'}.png`;
      designWorkspace(String(request.chatId ?? ''))[path] = MOCK_PIXEL;
      return { path, existed: false };
    }
    if (request.action === 'remove_reference') {
      const { path } = request as { path?: string };
      delete designWorkspace(String(request.chatId ?? ''))[String(path)];
      return { path };
    }
    if (request.action === 'set_flows') {
      const { links } = request as { links?: unknown[] };
      designWorkspace(String(request.chatId ?? ''))['flows.json'] = JSON.stringify({ links }, null, 2);
      return { path: 'flows.json', links };
    }
    if (request.action === 'pick_references') return { added: [], failed: 0 };
    if (request.action === 'export_png' || request.action === 'export_pdf') return { saved: false };
    return request.action === 'versions' ? [] : null;
  },
  // One pixel: a valid PNG, so a vision path has real bytes to attach in the browser mock.
  'design_view': (args) => {
    const { path } = (args ?? {}) as { path?: string };
    return { path: path ?? 'references/image.png', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', bytes: 68 };
  },
  'design_reference': (args) => {
    const { url, saveScreenshot, saveAsSystem, image } = (args ?? {}) as { url?: string; saveScreenshot?: boolean; saveAsSystem?: string; image?: boolean };
    if (!/^https?:\/\/[^/\s@]+/i.test(String(url ?? ''))) {
      return { ok: false, error: 'Only public http(s) pages can be read: no localhost, private network addresses or credentials in the URL.', text: '' };
    }
    const host = String(url).replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./, '').toLowerCase();
    const stem = host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
    const saved = saveScreenshot ? `references/${stem}-1.png` : undefined;
    if (saved) designWorkspace(String((args as { chatId?: string }).chatId ?? ''))[saved] = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    let system: { id: string; name: string } | undefined;
    if (saveAsSystem) {
      const name = String(saveAsSystem).trim() || 'Reference';
      system = { id: `mock-reference-${mockSystems.length + 1}`, name };
      mockSystems.push({
        id: system.id, name, description: `Read from ${String(url)} by design_reference.`, createdAt: Date.now(), updatedAt: Date.now(), origin: 'design',
        files: { 'tokens.css': ':root {\n  --bg: #ffffff;\n  --text: #111827;\n  --accent: #2563eb;\n  --border: #e5e7eb;\n}\n', 'DESIGN.md': `# Reference: ${host}\n` }
      });
    }
    const text = [
      `Reference: ${String(url)} — "Mock page" at 1440px wide (412 elements read).`,
      'Palette: text #111827, background #ffffff, surface #f5f5f4, muted #6b7280, accent #2563eb, border #e5e7eb.',
      'Fonts: body "Inter", headings "Playfair Display"; in use: Inter (380), Playfair Display (24).',
      'Type: h1 56px/700/1.1; h2 40px/700/1.2; h3 24px/600/1.3; body 16px/400/1.6; small 14px/400/1.5; button 15px/600/1.2.',
      'Spacing (px): 4, 8, 12, 16, 24, 32, 48, 64.',
      'Radii: 6px, 12px, 999px. Shadows: 0 1px 2px rgba(0, 0, 0, 0.05).',
      'Layout: content about 1200px wide; grids of 3 and 2 columns; 5 sections, navigation, footer.',
      ...(saved ? [`Saved: ${saved}.`] : []),
      ...(system ? [`Design system: saved as "${system.name}". Apply it from the systems list to reuse these tokens.`] : []),
      'Borrow the structure and principles, not the logo, copy or imagery.'
    ].join('\n');
    return { ok: true, text, ...(image ? { image: { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', mimeType: 'image/png' } } : {}), ...(saved ? { saved } : {}), ...(system ? { system } : {}) };
  },
  'design_handoff': (args) => {
    const { action } = (args ?? {}) as { action?: string };
    return action === 'deliver' ? { slug: 'mock-design', dir: '/mock/project/.agente/designs/mock-design', files: 0 } : { saved: false };
  },
  // Design systems: an in-memory library seeded with one system, so the chip, picker and dialog have something to show.
  'design_systems': (args) => {
    const request = (args ?? {}) as { action?: string; id?: string; chatId?: string; name?: string; description?: string };
    const summaryOf = (system: MockSystem) => ({ id: system.id, name: system.name, description: system.description, createdAt: system.createdAt, updatedAt: system.updatedAt, origin: system.origin, hasTokens: 'tokens.css' in system.files, hasSpecimen: 'components.html' in system.files });
    const find = (id?: string) => mockSystems.find((system) => system.id === id);
    const sorted = () => [...mockSystems].sort((a, b) => b.updatedAt - a.updatedAt).map(summaryOf);
    switch (request.action) {
      case 'list': return sorted();
      case 'get': {
        const system = find(request.id);
        if (!system) throw new Error('Unknown design system.');
        return { ...summaryOf(system), files: { files: { ...system.files }, pages: Object.keys(system.files).filter((file) => file.endsWith('.html')), variants: [] } };
      }
      case 'create': {
        const files = designWorkspace(String(request.chatId ?? ''));
        const system: MockSystem = { id: `mock-${mockSystems.length + 1}`, name: String(request.name ?? 'System'), description: String(request.description ?? ''), createdAt: Date.now(), updatedAt: Date.now(), origin: 'design', files: { ...files } };
        mockSystems.push(system);
        return summaryOf(system);
      }
      case 'rename': {
        const system = find(request.id);
        if (system) { system.name = String(request.name ?? system.name); system.updatedAt = Date.now(); }
        return system ? summaryOf(system) : null;
      }
      case 'delete': {
        const index = mockSystems.findIndex((system) => system.id === request.id);
        if (index >= 0) mockSystems.splice(index, 1);
        return { deleted: true };
      }
      case 'apply': {
        const system = find(request.id);
        if (!system || !request.chatId) throw new Error('Unknown design system.');
        const files = designWorkspace(request.chatId);
        const paths = Object.keys(system.files).filter((file) => file.endsWith('.css') || file.endsWith('.md') || file.endsWith('.html'));
        for (const file of paths) files[file] = system.files[file];
        designLinks.set(request.chatId, system.id);
        emit('design_changed', { chatId: request.chatId, paths });
        return { before: null, paths };
      }
      case 'unlink': designLinks.delete(String(request.chatId)); return { ok: true };
      case 'current': { const system = find(designLinks.get(String(request.chatId))); return system ? summaryOf(system) : null; }
      case 'brief': {
        const system = find(designLinks.get(String(request.chatId)));
        return system ? { name: system.name, designMd: system.files['DESIGN.md'] ?? '', tokens: system.files['tokens.css'] ?? '' } : null;
      }
      case 'import': return null;
      default: throw new Error('Unknown design system action.');
    }
  },
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
    const { chatId, decision } = (args ?? {}) as { chatId?: string; decision?: 'allow' | 'allow_all' | 'deny' };
    void finishApprovedRun(String(chatId ?? ''), decision === 'deny' ? 'deny' : 'allow');
    return { ok: true };
  },
  'agente_respond_input': () => ({ ok: true }),
  'agente_drivers_list': () => ({
    drivers: [
      {
        instance_id: 'agente',
        driver_kind: 'agente',
        label: 'Agente Core',
        builtin: true,
        enabled: true,
        status: 'ready',
        capabilities: {
          approvals: true,
          attachments: ['image', 'audio', 'video', 'pdf'],
          compact: true,
          cost: true,
          fork: true,
          mcp_injection: true,
          models: true,
          modes: ['plan', 'build', 'auto'],
          native_plan_cards: true,
          resume: true,
          rewind_conversation: true,
          session_import: true,
          steer: true,
          thinking: true,
          usage: true
        }
      }
    ]
  }),
  'agente_drivers_probe': () => ({ drivers: [] }),
  'agente_drivers_save': (args) => ({ driver: { ...(args as Record<string, unknown>) } }),
  'agente_drivers_delete': () => ({ deleted: true }),
  'agente_worktree_list': () => ({ worktrees: [] }),
  'agente_set_worktree': () => ({ ok: true }),
  'agente_orchestrator_status': () => ({ enabled: false }),
  'agente_orchestrator_tasks': () => ({ tasks: [] }),
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
    windowSetTitlebarOverlay: () => Promise.resolve(false),
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
