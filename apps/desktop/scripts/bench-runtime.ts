/** Real Rust-daemon benchmark. No credentials or transcript are logged. */
import { AgenteClient } from '../main/agente-client.ts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const socket = process.env.AGENTE_PERF_SOCKET;
if (!socket) throw new Error('Set AGENTE_PERF_SOCKET to a running test daemon socket.');
const client = await AgenteClient.connect(socket);
const report: Record<string, unknown> = {};
try {
  for (const method of ['initialize', 'session.list', 'providers.status']) {
    const samples: number[] = [];
    for (let index = 0; index < 10; index++) {
      const start = performance.now();
      await client.request(method);
      samples.push(performance.now() - start);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    report[method] = { firstMs: samples[0], medianMs: sorted[5], maxMs: sorted[9] };
  }
  // Live calls are opt-in and use exactly the requested, already connected model.
  const provider = process.env.AGENTE_PERF_PROVIDER;
  const model = process.env.AGENTE_PERF_MODEL;
  if (provider && model) {
    const sessionId = randomUUID();
    const project = await mkdtemp(join(tmpdir(), 'agente-perf-'));
    await writeFile(join(project, 'fixture.txt'), 'PERF_OK\n');
    const turns: unknown[] = [];
    try {
      for (let index = 0; index < 3; index++) {
        const start = performance.now();
        const stats: Record<string, any> = { iteration: index + 1, provider, model, calls: [], tools: [] };
        let settle!: () => void;
        const outcome = new Promise<void>(resolve => { settle = resolve; });
        const off = client.onNotification((method, raw: any) => {
          if (raw.session_id !== sessionId) return;
          const ms = performance.now() - start;
          if (method === 'turn.outcome') {
            stats.totalMs = ms; stats.status = raw.status; settle(); return;
          }
          const event = raw.event;
          if (!event) return;
          if (event.type === 'assistant_delta') stats.firstTextMs ??= ms;
          if (event.type === 'reasoning_delta') stats.firstReasoningMs ??= ms;
          if (event.type === 'call_usage') stats.calls.push({ ms, usage: event.usage });
          if (event.type === 'tool_proposed') stats.tools.push({ name: event.name ?? event.tool, startMs: ms });
          if (event.type === 'tool_result' && stats.tools.length) stats.tools.at(-1).endMs = ms;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await client.request<{ turn_id: string }>('turn.start', {
            session_id: sessionId, project_dir: project, provider, model, thinking_level: 'auto', mode: 'plan',
            prompt: { role: 'user', content: 'Read fixture.txt using read_file. Then reply with only PERF_OK. Do not do any other work.' }
          });
          stats.acceptedMs = performance.now() - start;
          timer = setTimeout(() => { stats.timedOut = true; void client.request('turn.cancel', { turn_id: response.turn_id }); }, 60_000);
          await outcome;
        } finally { clearTimeout(timer); off(); }
        turns.push(stats);
        if (stats.timedOut || stats.status !== 'completed') break;
      }
    } finally {
      await client.request('session.delete', { session_id: sessionId });
      await rm(project, { recursive: true, force: true });
    }
    report.turns = turns;
  }
  const output = process.env.AGENTE_PERF_OUTPUT;
  if (output) await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { client.close(); }
