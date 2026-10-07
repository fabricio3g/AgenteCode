// ── The chat panel ────────────────────────────────────────────────────
// A small chat with sessions, answered by Agente Desktop: each conversation
// is a Home chat there (sidebar → Browser), so it can be continued in either
// place. The page the user is on rides along with each message unless they
// turn it off.
//
// Keys: Enter send · Shift+Enter newline · Esc stop / back · Alt+N new chat ·
// Alt+H history.

import { ext } from '../webext';
import type { BrowserChatSummary, ChatEvent, ChatRequest, PageContext } from '../../../shared/browser/chat-protocol';
import type { BridgeStatus, PanelIn, PanelOut } from './messages';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  from?: string;
  steps?: { label: string; status: string }[];
  pending?: boolean;
  failed?: boolean;
}

const ICON = 'icon-128.png';
const CURRENT_KEY = 'currentChat';
const svg = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const ICONS = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  send: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  open: svg('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>')
};

const state = {
  status: { state: 'connecting', app: false } as BridgeStatus,
  view: 'chat' as 'chat' | 'history',
  chatId: '' as string,
  title: '',
  turns: [] as Turn[],
  running: '' as string,
  includePage: true,
  page: null as PageContext | null,
  chats: [] as BrowserChatSummary[],
  allSites: true,
  draft: '',
  /** The request loading the open conversation, so its failure can be shown. */
  historyRequest: ''
};

const app = document.getElementById('app')!;
const port = ext.runtime.connect({ name: 'panel' });
const post = (message: PanelIn) => port.postMessage(message);
let pageWaiter: ((page: PageContext | null) => void) | null = null;

function request(body: ChatRequest): string {
  const id = crypto.randomUUID();
  post({ kind: 'chat', id, body });
  return id;
}

/** Ask the background for the active tab, with a short timeout. */
function currentPage(): Promise<PageContext | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pageWaiter = null;
      resolve(null);
    }, 1500);
    pageWaiter = (page) => {
      clearTimeout(timer);
      pageWaiter = null;
      resolve(page);
    };
    post({ kind: 'page' });
  });
}

// ── Markdown, small and safe: escape first, then a few constructs ─────
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function inline(text: string): string {
  return escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function markdown(text: string): string {
  const out: string[] = [];
  const blocks = text.split(/```/);
  blocks.forEach((block, index) => {
    if (index % 2 === 1) {
      out.push(`<pre><code>${escape(block.replace(/^[^\n]*\n/, ''))}</code></pre>`);
      return;
    }
    let list: string[] = [];
    let ordered = false;
    const flush = () => {
      if (list.length) out.push(`<${ordered ? 'ol' : 'ul'}>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      list = [];
    };
    for (const para of block.split(/\n{2,}/)) {
      for (const line of para.split('\n')) {
        const bullet = /^\s*[-*] (.*)/.exec(line);
        const numbered = /^\s*\d+\. (.*)/.exec(line);
        if (bullet || numbered) {
          if (list.length && ordered !== !!numbered) flush();
          ordered = !!numbered;
          list.push((bullet ?? numbered)![1]);
          continue;
        }
        flush();
        const heading = /^#{1,6} (.*)/.exec(line);
        if (heading) out.push(`<span class="h">${inline(heading[1])}</span>`);
        else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
      }
      flush();
    }
  });
  return out.join('');
}

// ── Rendering ─────────────────────────────────────────────────────────
function statusLine(): { dot: string; text?: string; action?: string } {
  const { state: s, app: desktop, error } = state.status;
  if (s === 'connected' && desktop) return { dot: 'ok' };
  if (s === 'connected') return { dot: 'warn', text: 'Agente Desktop is not open. Open it to chat — browser tools still work for sessions.' };
  if (s === 'connecting') return { dot: 'warn', text: 'Connecting to Agente…' };
  return { dot: '', text: error || 'Agente is not reachable. Open Agente Desktop, or run `agente bridge serve`.', action: 'Re-pair' };
}

function render() {
  if (state.status.state === 'unpaired' || state.status.state === 'refused') return renderPair();
  if (state.view === 'history') return renderHistory();
  renderChat();
}

function renderPair() {
  app.innerHTML = `
    <div class="pair">
      <img src="../${ICON}" alt="" />
      <h1>Connect to Agente</h1>
      <ol>
        <li>Run <code>agente bridge install</code> once, and keep Agente Desktop open.</li>
        <li>Run <code>agente bridge status</code> and paste the pairing code here.</li>
      </ol>
      <input id="code" placeholder="7391.abc123…" autocomplete="off" spellcheck="false" />
      <button class="primary" id="connect">Connect</button>
      ${state.status.error ? `<p class="error">${escape(state.status.error)}</p>` : ''}
    </div>`;
  const input = app.querySelector<HTMLInputElement>('#code')!;
  const connect = () => input.value.trim() && post({ kind: 'pair', code: input.value.trim() });
  app.querySelector('#connect')!.addEventListener('click', connect);
  input.addEventListener('keydown', (event) => event.key === 'Enter' && connect());
  input.focus();
}

function renderHistory() {
  app.innerHTML = `
    <div class="bar">
      <button class="icon-btn" id="back" title="Back (Esc)">${ICONS.back}</button>
      <div class="title">Conversations</div>
      <button class="icon-btn" id="new" title="New chat (Alt+N)">${ICONS.plus}</button>
    </div>
    <div class="sheet">
      ${state.chats.length
        ? state.chats.map((chat) => `
          <button class="row${chat.id === state.chatId ? ' active' : ''}" data-id="${escape(chat.id)}">
            <span class="name">${escape(chat.title || 'Untitled')}</span>
            <span class="meta">${escape(when(chat.updatedAt))}${chat.url ? ` · ${escape(host(chat.url))}` : ''}</span>
          </button>`).join('')
        : '<p class="empty">No browser conversations yet.</p>'}
    </div>`;
  app.querySelector('#back')!.addEventListener('click', () => show('chat'));
  app.querySelector('#new')!.addEventListener('click', newChat);
  for (const row of app.querySelectorAll<HTMLElement>('.row')) {
    row.addEventListener('click', () => openChat(row.dataset.id!));
  }
  app.querySelector<HTMLElement>('.row')?.focus();
}

function renderChat() {
  const line = statusLine();
  const log = state.turns.length
    ? state.turns.map(renderTurn).join('')
    : `<div class="empty"><img src="../${ICON}" alt="" /><p>Ask about this page, or have Agente draft a doc, a sheet or a reply. Conversations are kept in Agente Desktop.</p></div>`;
  const pageLabel = state.page ? state.page.title || host(state.page.url) : 'No page';
  app.innerHTML = `
    <div class="bar">
      <span class="dot ${line.dot}" title="${escape(line.text || 'Connected to Agente Desktop')}"></span>
      <div class="title">${escape(state.title || 'New chat')}</div>
      ${state.chatId ? `<button class="icon-btn" id="reveal" title="Open in Agente Desktop">${ICONS.open}</button>` : ''}
      <button class="icon-btn" id="history" title="Conversations (Alt+H)">${ICONS.history}</button>
      <button class="icon-btn" id="new" title="New chat (Alt+N)">${ICONS.plus}</button>
    </div>
    ${line.text ? `<div class="notice">${escape(line.text)}${line.action ? ` <button id="repair">${line.action}</button>` : ''}</div>` : ''}
    ${!state.allSites ? '<div class="notice">Agente needs access to your sites to read and act on pages.<button id="grant">Allow</button></div>' : ''}
    <div class="log" id="log">${log}</div>
    <div class="composer">
      <textarea id="input" rows="1" placeholder="${state.running ? 'Agente is answering…' : 'Ask Agente…'}">${escape(state.draft)}</textarea>
      <div class="composer-row">
        <button class="chip${state.includePage && state.page ? ' on' : ''}" id="page" title="${state.includePage ? 'This page is sent with your message — click to leave it out' : 'Click to send this page with your message'}" ${state.page ? '' : 'disabled'}>
          ${ICONS.globe}<span>${escape(pageLabel)}</span>
        </button>
        <span class="spacer"></span>
        ${state.running
          ? `<button class="send" id="stop" title="Stop (Esc)">${ICONS.stop}</button>`
          : `<button class="send" id="send" title="Send (Enter)" ${state.draft.trim() ? '' : 'disabled'}>${ICONS.send}</button>`}
      </div>
    </div>`;
  const input = app.querySelector<HTMLTextAreaElement>('#input')!;
  const send = app.querySelector<HTMLButtonElement>('#send');
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  };
  input.addEventListener('input', () => {
    state.draft = input.value;
    if (send) send.disabled = !input.value.trim();
    grow();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });
  grow();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  send?.addEventListener('click', () => void submit());
  app.querySelector('#stop')?.addEventListener('click', stop);
  app.querySelector('#new')!.addEventListener('click', newChat);
  app.querySelector('#history')!.addEventListener('click', () => show('history'));
  app.querySelector('#reveal')?.addEventListener('click', () => request({ type: 'reveal', chatId: state.chatId }));
  app.querySelector('#repair')?.addEventListener('click', () => post({ kind: 'unpair' }));
  app.querySelector('#grant')?.addEventListener('click', grant);
  app.querySelector('#page')!.addEventListener('click', () => {
    state.includePage = !state.includePage;
    render();
  });
  const logEl = app.querySelector('#log')!;
  logEl.scrollTop = logEl.scrollHeight;
}

function renderTurn(turn: Turn): string {
  if (turn.role === 'user') {
    return `<div class="prompt">${turn.from ? `<span class="from">${ICONS.globe.replace('<svg', '<svg width="10" height="10"')} ${escape(turn.from)}</span>` : ''}${escape(turn.text)}</div>`;
  }
  const steps = turn.steps?.length
    ? `<div class="steps">${turn.steps.map((step) => `<span class="step ${step.status}">${escape(step.label)}</span>`).join('')}</div>`
    : '';
  if (turn.failed) return `<div class="answer">${steps}<div class="failed">${escape(turn.text)}</div></div>`;
  const body = turn.text ? markdown(turn.text) : turn.pending ? '<span class="thinking">Working</span>' : '';
  return `<div class="answer">${steps}${body}</div>`;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function when(ts: number): string {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return new Date(ts).toLocaleDateString();
}

// ── Actions ───────────────────────────────────────────────────────────
async function submit() {
  const text = state.draft.trim();
  if (!text || state.running) return;
  const page = state.includePage ? await currentPage() : null;
  state.draft = '';
  state.turns.push({ role: 'user', text, from: page ? page.title || host(page.url) : undefined });
  state.turns.push({ role: 'assistant', text: '', steps: [], pending: true });
  state.running = request({ type: 'send', chatId: state.chatId || undefined, text, ...(page ? { page } : {}) });
  render();
}

function stop() {
  if (state.running && state.chatId) request({ type: 'stop', chatId: state.chatId });
}

function newChat() {
  state.chatId = '';
  state.title = '';
  state.turns = [];
  state.running = '';
  void ext.storage.local.remove(CURRENT_KEY);
  show('chat');
}

function openChat(chatId: string) {
  state.chatId = chatId;
  state.turns = [];
  state.running = '';
  void ext.storage.local.set({ [CURRENT_KEY]: chatId });
  state.historyRequest = request({ type: 'history', chatId });
  show('chat');
}

function show(view: 'chat' | 'history') {
  state.view = view;
  if (view === 'history') request({ type: 'list' });
  render();
}

async function grant() {
  const granted = await ext.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
  state.allSites = !!granted;
  render();
}

function lastAnswer(): Turn | undefined {
  const last = state.turns[state.turns.length - 1];
  return last?.role === 'assistant' ? last : undefined;
}

function onChatEvent(id: string, body: ChatEvent) {
  switch (body.type) {
    case 'started':
      if (id !== state.running) return;
      state.chatId = body.chatId;
      state.title = body.title;
      void ext.storage.local.set({ [CURRENT_KEY]: body.chatId });
      break;
    case 'text': {
      const answer = id === state.running ? lastAnswer() : undefined;
      if (!answer) return;
      answer.text = body.text;
      break;
    }
    case 'step': {
      const answer = id === state.running ? lastAnswer() : undefined;
      if (!answer) return;
      const steps = (answer.steps ??= []);
      const existing = steps.find((step) => step.label === body.label && step.status !== 'done');
      if (existing) existing.status = body.status;
      else steps.push({ label: body.label, status: body.status });
      break;
    }
    case 'done': {
      if (id !== state.running) return;
      const answer = lastAnswer();
      if (answer) answer.pending = false;
      state.running = '';
      // Desktop names the conversation after the first exchange.
      request({ type: 'list' });
      break;
    }
    case 'error': {
      if (id === state.running) {
        const answer = lastAnswer();
        if (answer) Object.assign(answer, { text: body.message, pending: false, failed: true });
        state.running = '';
      } else if (id === state.historyRequest) {
        // The stored conversation is gone (deleted in Desktop): start fresh.
        state.chatId = '';
        state.title = '';
        void ext.storage.local.remove(CURRENT_KEY);
      } else {
        return;
      }
      break;
    }
    case 'list':
      state.chats = body.chats;
      state.title = body.chats.find((chat) => chat.id === state.chatId)?.title ?? state.title;
      break;
    case 'history':
      if (body.chatId !== state.chatId) return;
      state.title = body.title;
      state.turns = body.messages.map((message) => ({ role: message.role, text: message.text }));
      break;
    case 'ok':
      return;
  }
  // Streaming text only touches the transcript; keep the composer's caret.
  if (state.view === 'chat' && body.type === 'text') {
    const log = app.querySelector('#log');
    const answers = log?.querySelectorAll('.answer');
    const node = answers?.[answers.length - 1];
    const answer = lastAnswer();
    if (node && answer) {
      const steps = node.querySelector('.steps')?.outerHTML ?? '';
      node.innerHTML = steps + markdown(answer.text);
      const nearBottom = log!.scrollHeight - log!.scrollTop - log!.clientHeight < 80;
      if (nearBottom) log!.scrollTop = log!.scrollHeight;
      return;
    }
  }
  render();
}

port.onMessage.addListener((message: PanelOut) => {
  if (message.kind === 'status') {
    const hadDesktop = state.status.state === 'connected' && state.status.app;
    state.status = message.status;
    render();
    // Desktop just became reachable: reload the conversation the panel was on.
    if (!hadDesktop && message.status.state === 'connected' && message.status.app && state.chatId && !state.turns.length) {
      state.historyRequest = request({ type: 'history', chatId: state.chatId });
    }
  } else if (message.kind === 'chat') {
    onChatEvent(message.id, message.body);
  } else if (message.kind === 'page') {
    pageWaiter?.(message.page);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.altKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    newChat();
  } else if (event.altKey && event.key.toLowerCase() === 'h') {
    event.preventDefault();
    show(state.view === 'history' ? 'chat' : 'history');
  } else if (event.key === 'Escape') {
    if (state.view === 'history') show('chat');
    else stop();
  }
});

// Keep the page chip on the tab the user is looking at.
async function refreshPage() {
  const page = await currentPage();
  const changed = page?.url !== state.page?.url || page?.title !== state.page?.title;
  state.page = page;
  if (changed && state.view === 'chat' && state.status.state !== 'unpaired') render();
}
ext.tabs.onActivated.addListener(() => void refreshPage());
ext.tabs.onUpdated.addListener((_id: number, info: { status?: string; title?: string }) => {
  if (info.status === 'complete' || info.title) void refreshPage();
});

async function init() {
  state.allSites = await ext.permissions.contains({ origins: ['<all_urls>'] }).catch(() => true);
  const stored = await ext.storage.local.get(CURRENT_KEY);
  state.chatId = typeof stored?.[CURRENT_KEY] === 'string' ? stored[CURRENT_KEY] : '';
  post({ kind: 'hello' });
  render();
  void refreshPage();
}

void init();
