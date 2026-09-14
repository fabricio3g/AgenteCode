import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isLlamaServerBinary, supportsLlamaFlag } from '../../main/llama-runtime.ts';
import { normalizeOpenAiBaseUrl } from '../../main/providers/helpers.ts';
import { buildLlamaArgs } from '../../main/process-manager.ts';
import { parsePrometheusMetrics } from '../../main/llm-runner.ts';
import { resolveLlamaSessionKey, startLlamaSession, endLlamaSession } from '../../main/llama-session.ts';

describe('llama.cpp runtime compatibility', () => {
  it('only accepts llama-server as an HTTP runtime', () => {
    assert.equal(isLlamaServerBinary('C:/tools/llama-server.exe'), true);
    assert.equal(isLlamaServerBinary('/opt/llama-server'), true);
    assert.equal(isLlamaServerBinary('/opt/llama-cli'), false);
    assert.equal(isLlamaServerBinary('/opt/server'), false);
  });

  it('normalizes pasted OpenAI chat endpoints to their API root', () => {
    assert.equal(normalizeOpenAiBaseUrl('http://localhost:8080/v1/chat/completions/'), 'http://localhost:8080/v1');
    assert.equal(normalizeOpenAiBaseUrl('http://localhost:8080/v1/'), 'http://localhost:8080/v1');
  });

  it('uses current load-mode flags and skips unsupported flags', () => {
    const capabilities = {
      supportedFlags: new Set([
        '--load-mode', '--spec-type', '--no-webui', '--flash-attn', '--reasoning'
      ])
    };
    const args = buildLlamaArgs({
      model_path: '',
      port: 11435,
      backend_mode: 'cpu',
      context_length: 4096,
      mmap: false,
      keep_in_memory: true,
      speculative_decoding: true,
      speculative_ngram: 64,
      disable_thinking: true
    }, process.execPath, null, capabilities);

    assert.deepEqual(args.slice(args.indexOf('--load-mode'), args.indexOf('--load-mode') + 2), ['--load-mode', 'mlock']);
    assert.equal(args.includes('--mlock'), false);
    assert.equal(args.includes('--no-mmap'), false);
    assert.equal(args.includes('--ngram-cache-size'), false);
    assert.equal(args.includes('--spec-type'), true);
    assert.equal(args.includes('--reasoning'), true);
  });

  it('treats unknown capability data conservatively only when supplied', () => {
    assert.equal(supportsLlamaFlag(null, '--anything'), true);
    assert.equal(supportsLlamaFlag({ supportedFlags: new Set() }, '--anything'), false);
  });

  it('maps every mmap/mlock combination onto a real --load-mode value', () => {
    const capabilities = { supportedFlags: new Set(['--load-mode']) };
    const modeFor = (mmap, keep_in_memory) => {
      const args = buildLlamaArgs(
        { model_path: '', port: 11435, backend_mode: 'cpu', mmap, keep_in_memory },
        process.execPath, null, capabilities
      );
      return args[args.indexOf('--load-mode') + 1];
    };

    assert.equal(modeFor(true, true), 'mmap+mlock');
    assert.equal(modeFor(false, true), 'mlock');
    assert.equal(modeFor(true, false), 'mmap');
    assert.equal(modeFor(false, false), 'none');
  });

  it('falls back to the deprecated flags when --load-mode is unavailable', () => {
    const capabilities = { supportedFlags: new Set(['--mlock', '--no-mmap']) };
    const args = buildLlamaArgs(
      { model_path: '', port: 11435, backend_mode: 'cpu', mmap: false, keep_in_memory: true },
      process.execPath, null, capabilities
    );

    assert.equal(args.includes('--load-mode'), false);
    assert.equal(args.includes('--no-mmap'), true);
    assert.equal(args.includes('--mlock'), true);
  });

  it('leaves sizing to llama.cpp unless the user chose a value', () => {
    const capabilities = { supportedFlags: new Set(['--fit']) };
    const auto = buildLlamaArgs(
      { model_path: '', port: 11435, backend_mode: 'vulkan' },
      process.execPath, null, capabilities
    );

    assert.equal(auto.includes('--ctx-size'), false);
    assert.equal(auto.includes('--batch-size'), false);
    assert.equal(auto.includes('--ubatch-size'), false);
    assert.equal(auto.includes('--threads'), false);
    assert.deepEqual(auto.slice(auto.indexOf('--fit'), auto.indexOf('--fit') + 2), ['--fit', 'on']);

    const chosen = buildLlamaArgs(
      {
        model_path: '', port: 11435, backend_mode: 'vulkan',
        context_length: 8192, gpu_offload: 20, batch_size: 1024, ubatch_size: 256, cpu_threads: 6
      },
      process.execPath, null, capabilities
    );

    assert.deepEqual(chosen.slice(chosen.indexOf('--ctx-size'), chosen.indexOf('--ctx-size') + 2), ['--ctx-size', '8192']);
    assert.deepEqual(chosen.slice(chosen.indexOf('--batch-size'), chosen.indexOf('--batch-size') + 2), ['--batch-size', '1024']);
    assert.deepEqual(chosen.slice(chosen.indexOf('--ubatch-size'), chosen.indexOf('--ubatch-size') + 2), ['--ubatch-size', '256']);
    assert.deepEqual(chosen.slice(chosen.indexOf('--threads'), chosen.indexOf('--threads') + 2), ['--threads', '6']);
  });

  it('pins layers to 0 on a CPU-only backend so auto-fit cannot offload', () => {
    const args = buildLlamaArgs(
      { model_path: '', port: 11435, backend_mode: 'cpu' },
      process.execPath, null, { supportedFlags: new Set(['--fit']) }
    );

    assert.deepEqual(args.slice(args.indexOf('--n-gpu-layers'), args.indexOf('--n-gpu-layers') + 2), ['--n-gpu-layers', '0']);
  });

  it('emits KV-offload, parallel and MoE flags only when they change behaviour', () => {
    const supportedFlags = new Set(['--no-kv-offload', '--cpu-moe', '--n-cpu-moe', '--context-shift']);
    const build = (config) => buildLlamaArgs(
      { model_path: '', port: 11435, backend_mode: 'cpu', ...config },
      process.execPath, null, { supportedFlags }
    );

    // Upstream defaults: offload on, slots auto, context shift off.
    const defaults = build({});
    assert.equal(defaults.includes('--no-kv-offload'), false);
    assert.equal(defaults.includes('--parallel'), false);
    assert.equal(defaults.includes('--context-shift'), false);

    // `offload_kv_cache` is the key the renderer actually sends.
    assert.equal(build({ offload_kv_cache: false }).includes('--no-kv-offload'), true);
    assert.equal(build({ offload_kv_cache: true }).includes('--no-kv-offload'), false);
    assert.equal(build({ parallel: 1 }).includes('--parallel'), false);
    assert.equal(build({ parallel: 4 }).includes('--parallel'), true);
    assert.equal(build({ context_shift: true }).includes('--context-shift'), true);

    // The partial form wins over the blanket one; they cannot both be passed.
    const partial = build({ cpu_moe: true, n_cpu_moe: 12 });
    assert.equal(partial.includes('--cpu-moe'), false);
    assert.deepEqual(partial.slice(partial.indexOf('--n-cpu-moe'), partial.indexOf('--n-cpu-moe') + 2), ['--n-cpu-moe', '12']);
    assert.equal(build({ cpu_moe: true }).includes('--cpu-moe'), true);
  });

  it('omits every modern flag the installed runtime does not advertise', () => {
    const args = buildLlamaArgs(
      {
        model_path: '', port: 11435, backend_mode: 'cpu',
        offload_kv_cache: false, cpu_moe: true, n_cpu_moe: 8, context_shift: true,
        cache_ram_mb: 4096, cache_reuse: 256, swa_full: true, split_mode: 'row',
        api_key: 'secret', keep_in_memory: true, disable_thinking: true
      },
      process.execPath, null, { supportedFlags: new Set() }
    );

    for (const flag of [
      '--no-kv-offload', '--cpu-moe', '--n-cpu-moe', '--context-shift', '--cache-ram',
      '--cache-reuse', '--swa-full', '--split-mode', '--api-key', '--metrics',
      '--load-mode', '--mlock', '--fit', '--flash-attn', '--no-webui', '--reasoning',
      '--jinja'
    ]) {
      assert.equal(args.includes(flag), false, `${flag} should not be passed to a runtime that lacks it`);
    }
    assert.equal(args.includes('secret'), false);
  });

  it('reads llama.cpp /metrics in Prometheus text format', () => {
    const metrics = parsePrometheusMetrics([
      '# HELP llamacpp:predicted_tokens_seconds Average generation throughput in tokens/s.',
      '# TYPE llamacpp:predicted_tokens_seconds gauge',
      'llamacpp:predicted_tokens_seconds 42.5',
      'llamacpp:n_tokens_max 8192',
      'llamacpp:requests_processing{model="a"} 2',
      'llamacpp:prompt_seconds_total 1.25e+01',
      'malformed line without value',
      ''
    ].join('\n'));

    assert.equal(metrics['llamacpp:predicted_tokens_seconds'], 42.5);
    assert.equal(metrics['llamacpp:n_tokens_max'], 8192);
    // Labels are stripped rather than making the line unparseable.
    assert.equal(metrics['llamacpp:requests_processing'], 2);
    assert.equal(metrics['llamacpp:prompt_seconds_total'], 12.5);
    assert.equal(Object.keys(metrics).length, 4);
  });

  it('hands the session key only to the loopback port it launched', () => {
    endLlamaSession();
    assert.equal(resolveLlamaSessionKey('http://127.0.0.1:11435/v1'), '');

    const key = startLlamaSession(11435);
    assert.equal(resolveLlamaSessionKey('http://127.0.0.1:11435/v1'), key);
    assert.equal(resolveLlamaSessionKey('http://localhost:11435/v1'), key);
    // A different port, or anything off-box, must never see the key.
    assert.equal(resolveLlamaSessionKey('http://127.0.0.1:11436/v1'), '');
    assert.equal(resolveLlamaSessionKey('https://api.openai.com/v1'), '');
    assert.equal(resolveLlamaSessionKey('not a url'), '');

    endLlamaSession();
    assert.equal(resolveLlamaSessionKey('http://127.0.0.1:11435/v1'), '');
  });

  it('never enables POST /props while turning on the metrics endpoint', () => {
    const args = buildLlamaArgs(
      { model_path: '', port: 11435, backend_mode: 'cpu' },
      process.execPath, null, { supportedFlags: new Set(['--metrics', '--props']) }
    );

    assert.equal(args.includes('--metrics'), true);
    assert.equal(args.includes('--props'), false);
  });

  it('passes --jinja only to runtimes that advertise it (tool calls need it)', () => {
    const build = (supportedFlags) => buildLlamaArgs(
      { model_path: '', port: 11435, backend_mode: 'cpu' },
      process.execPath, null, { supportedFlags: new Set(supportedFlags) }
    );

    // Without the flag the server 400s any request carrying tools
    // ("tools param requires --jinja flag").
    assert.equal(build(['--jinja']).includes('--jinja'), true);
    assert.equal(build([]).includes('--jinja'), false);
  });

  it('maps the tri-state thinking mode onto --reasoning (legacy boolean still works)', () => {
    const build = (config) => buildLlamaArgs(
      { model_path: '', port: 11435, backend_mode: 'cpu', ...config },
      process.execPath, null, { supportedFlags: new Set(['--reasoning']) }
    );

    // Auto (and absent) omit the flag so the server detects from the template.
    assert.deepEqual(build({ thinking_mode: 'auto' }).filter((a) => a === '--reasoning'), []);
    assert.deepEqual(build({}).filter((a) => a === '--reasoning'), []);
    assert.deepEqual(
      build({ thinking_mode: 'off' }).slice(
        build({ thinking_mode: 'off' }).indexOf('--reasoning'),
        build({ thinking_mode: 'off' }).indexOf('--reasoning') + 2
      ),
      ['--reasoning', 'off']
    );
    const on = build({ thinking_mode: 'on' });
    assert.deepEqual(on.slice(on.indexOf('--reasoning'), on.indexOf('--reasoning') + 2), ['--reasoning', 'on']);
    // Legacy `disable_thinking: true` still means off.
    const legacy = build({ disable_thinking: true });
    assert.deepEqual(
      legacy.slice(legacy.indexOf('--reasoning'), legacy.indexOf('--reasoning') + 2),
      ['--reasoning', 'off']
    );
  });
});
