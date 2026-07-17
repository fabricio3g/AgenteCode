/**
 * Standalone micro-benchmark for composer routing + tool-pair sanitization.
 * Does not need Vitest; run from repo root:
 *   node scripts/bench-agent-stability.mjs
 *
 * Note: duplicates heuristic logic lightly so it can run without TS path aliases.
 */

function resolveComposerRoute(prompt, opts = {}) {
  const p = String(prompt || '').trim();
  const lower = p.toLowerCase();
  if (opts.searchMode && opts.searchMode !== 'chat') return 'tools';
  if (opts.contextMode === 'work') return 'agent';
  if (opts.hasAttachments) return 'tools';
  if (!p) return 'conversation';
  if (/\b(create|build|write|generate|make)\b.+\b(file|docx|xlsx|pdf|pptx|slides?|spreadsheet|document|app|website|page)\b/i.test(p)
    || /\b(fix|debug|refactor|implement)\b/i.test(p)) return 'agent';
  if (/\b(weather|forecast|temperature)\b/i.test(p)
    || /\b(convert|exchange|fx)\b/i.test(p)
    || /\b(stock|ticker|btc|eth|aapl|price of)\b/i.test(lower)
    || /\b(search|latest|today|news|current)\b/i.test(p)) return 'tools';
  if (p.length < 80 && /^(hi|hello|hey|thanks|ok)\b/i.test(p)) return 'conversation';
  return 'conversation';
}

function ensureToolCallPairs(messages, mode = 'fill') {
  const out = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (msg.role !== 'assistant' || !toolCalls.length) {
      if (msg.role === 'tool') {
        let j = out.length - 1;
        while (j >= 0 && out[j].role === 'tool') j -= 1;
        const parent = j >= 0 ? out[j] : null;
        const parentIds = new Set(
          parent?.role === 'assistant' && Array.isArray(parent.tool_calls)
            ? parent.tool_calls.map((c) => c.id)
            : []
        );
        if (msg.tool_call_id && parentIds.has(msg.tool_call_id)) out.push(msg);
        i += 1;
        continue;
      }
      out.push(msg);
      i += 1;
      continue;
    }
    const following = [];
    let k = i + 1;
    while (k < messages.length && messages[k].role === 'tool') {
      following.push(messages[k]);
      k += 1;
    }
    const present = new Set(following.map((m) => m.tool_call_id).filter(Boolean));
    const missing = toolCalls.filter((tc) => tc.id && !present.has(tc.id));
    if (missing.length && mode === 'strip') {
      const { tool_calls, ...rest } = msg;
      out.push({ ...rest, content: rest.content ?? '' });
      i = k;
      continue;
    }
    out.push(msg);
    out.push(...following);
    if (missing.length && mode === 'fill') {
      for (const tc of missing) {
        out.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function?.name || 'tool',
          content: JSON.stringify({ error: 'Tool result unavailable', cancelled: true })
        });
      }
    }
    i = k;
  }
  messages.length = 0;
  messages.push(...out);
}

function bench(name, iterations, fn) {
  for (let i = 0; i < 100; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const totalMs = performance.now() - t0;
  return {
    name,
    iterations,
    totalMs,
    perOpUs: (totalMs * 1000) / iterations,
    opsPerSec: iterations / (totalMs / 1000)
  };
}

function makeBrokenPairs(n) {
  const msgs = [{ role: 'user', content: 'go' }];
  for (let i = 0; i < n; i++) {
    const id = `c${i}`;
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'get_weather', arguments: '{}' } }]
    });
    if (i % 2 === 0) {
      msgs.push({ role: 'tool', content: '{}', tool_call_id: id, name: 'get_weather' });
    }
  }
  return msgs;
}

const prompts = [
  'hi', 'weather in Madrid', 'convert 100 USD to EUR', 'AAPL price',
  'create a spreadsheet', 'explain gravity', 'latest news'
];

const results = [
  bench('resolveComposerRoute', 100_000, () => {
    resolveComposerRoute(prompts[Math.floor(Math.random() * prompts.length)]);
  }),
  bench('ensureToolCallPairs', 10_000, () => {
    const m = makeBrokenPairs(15);
    ensureToolCallPairs(m, 'fill');
  })
];

// Correctness sample
const sample = makeBrokenPairs(5);
const beforeTools = sample.filter((m) => m.role === 'tool').length;
ensureToolCallPairs(sample, 'fill');
const afterTools = sample.filter((m) => m.role === 'tool').length;

console.log('\n=== Standalone agent stability bench ===');
console.log(`Pair fill correctness: tools before=${beforeTools} after=${afterTools} (expect after >= before)`);
for (const r of results) {
  console.log(
    `${r.name.padEnd(24)} ${String(r.iterations).padStart(8)} iters  ` +
      `${r.totalMs.toFixed(1).padStart(7)} ms  ` +
      `${r.perOpUs.toFixed(2).padStart(8)} µs/op  ` +
      `${Math.round(r.opsPerSec).toLocaleString().padStart(10)} ops/s`
  );
}
console.log('========================================\n');

if (afterTools < 5) {
  console.error('FAIL: pair fill did not restore enough tool messages');
  process.exit(1);
}
console.log('OK');
