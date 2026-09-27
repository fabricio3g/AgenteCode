#!/usr/bin/env node
/**
 * Live smoke: DeepSeek V4 Flash chat + thinking.
 * Requires DEEPSEEK_API_KEY in the environment. Never hardcode keys.
 *
 *   $env:DEEPSEEK_API_KEY="…"
 *   npx tsx scripts/smoke-deepseek-flash.mjs
 */
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || '';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const BASE = 'https://api.deepseek.com';

if (!API_KEY) {
  console.error('Missing DEEPSEEK_API_KEY in environment.');
  process.exit(1);
}

async function chat(body) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${json?.error?.message || text.slice(0, 300)}`);
  }
  return json;
}

function summarize(label, data) {
  const msg = data?.choices?.[0]?.message || {};
  const content = String(msg.content || '');
  const reasoning = String(msg.reasoning_content || msg.reasoning || '');
  console.log(`\n=== ${label} ===`);
  console.log(`model=${data?.model || MODEL}`);
  console.log(`contentLen=${content.length}`);
  console.log(`reasoningLen=${reasoning.length}`);
  console.log(`contentPreview=${content.slice(0, 160).replace(/\s+/g, ' ')}`);
  if (reasoning) console.log(`reasoningPreview=${reasoning.slice(0, 120).replace(/\s+/g, ' ')}`);
  if (!content.trim() && !reasoning.trim()) {
    throw new Error(`${label}: empty response`);
  }
}

async function main() {
  console.log(`DeepSeek smoke | model=${MODEL}`);

  const plain = await chat({
    model: MODEL,
    messages: [
      { role: 'system', content: 'Answer in one short sentence.' },
      { role: 'user', content: 'What is 2+2? Reply with only the number and a brief confirmation.' }
    ],
    stream: false,
    thinking: { type: 'disabled' }
  });
  summarize('chat (thinking off)', plain);

  const thinking = await chat({
    model: MODEL,
    messages: [
      { role: 'user', content: 'Which is larger, 9.11 or 9.8? Think carefully then answer in one sentence.' }
    ],
    stream: false,
    thinking: { type: 'enabled' },
    reasoning_effort: 'high'
  });
  summarize('chat (thinking high)', thinking);

  console.log('\nSmoke OK: deepseek-v4-flash reachable.');
}

main().catch((err) => {
  console.error('\nSmoke FAILED:', err?.message || err);
  process.exitCode = 1;
});
