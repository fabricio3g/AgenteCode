/**
 * Smoke: list models + context metadata for configured providers.
 *
 * Usage (from repo root):
 *   npx tsx scripts/smoke-provider-models.mjs
 *
 * Reads API keys from env if set:
 *   OPENAI_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY,
 *   GROQ_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY
 * Or from %APPDATA%/Chatea LM/secrets.json (keys never printed).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveProvider } from '../main/providers/registry.ts';

function loadSecrets() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'Chatea LM', 'secrets.json'),
    path.join(process.env.APPDATA || '', 'chatealm', 'secrets.json'),
    path.join(os.homedir(), '.chatealm', 'secrets.json')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch {
      // continue
    }
  }
  return {};
}

function loadConfig() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'Chatea LM', 'config.json'),
    path.join(process.env.APPDATA || '', 'chatealm', 'config.json')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      // continue
    }
  }
  return null;
}

function envKey(providerName) {
  const map = {
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    gemini: 'GEMINI_API_KEY',
    google: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    mistral: 'MISTRAL_API_KEY'
  };
  const envName = map[providerName];
  return envName ? process.env[envName] : undefined;
}

function secretKey(secrets, providerName) {
  if (!secrets || typeof secrets !== 'object') return '';
  // Common shapes: { openai: 'sk-...' } or { providers: { openai: { api_key } } }
  if (typeof secrets[providerName] === 'string') return secrets[providerName];
  if (secrets.providers?.[providerName]?.api_key) return secrets.providers[providerName].api_key;
  if (secrets.llm?.providers?.[providerName]?.api_key) return secrets.llm.providers[providerName].api_key;
  if (secrets.api_keys?.[providerName]) return secrets.api_keys[providerName];
  return '';
}

async function probeProvider(name, cfg, secrets) {
  const baseUrl = cfg?.base_url || '';
  const model = cfg?.model || '';
  const apiKey = envKey(name) || secretKey(secrets, name) || cfg?.api_key || '';
  const provider = resolveProvider(name, baseUrl);

  const row = {
    provider: name,
    resolved: provider.name,
    model: model || '(none)',
    hasKey: Boolean(apiKey),
    listCount: null,
    sampleIds: [],
    context_window: null,
    error: null
  };

  if (!apiKey && provider.name !== 'local') {
    row.error = 'no api key';
    return row;
  }

  try {
    const models = await provider.fetchModels(apiKey, baseUrl);
    row.listCount = Array.isArray(models) ? models.length : 0;
    row.sampleIds = (models || []).slice(0, 3);
  } catch (err) {
    row.error = `list: ${err?.message || err}`;
    return row;
  }

  if (model) {
    try {
      const meta = await provider.fetchModelMetadata(apiKey, baseUrl, model);
      row.context_window = meta?.context_window ?? null;
    } catch (err) {
      row.error = `meta: ${err?.message || err}`;
    }
  }

  return row;
}

async function main() {
  const config = loadConfig();
  const secrets = loadSecrets();
  const providers = config?.llm?.providers || {
    openai: { base_url: 'https://api.openai.com/v1' },
    openrouter: { base_url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
    deepseek: { base_url: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
    gemini: { base_url: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash' },
    groq: { base_url: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b' }
  };

  console.log('=== Provider model list + context smoke ===');
  console.log(`Config loaded: ${config ? 'yes' : 'no (defaults)'}`);
  console.log(`Secrets loaded: ${Object.keys(secrets || {}).length ? 'yes' : 'no'}`);
  console.log('');

  const names = Object.keys(providers);
  for (const name of names) {
    const row = await probeProvider(name, providers[name], secrets);
    console.log(
      [
        row.provider.padEnd(12),
        `list=${row.listCount ?? '-'}`.padEnd(12),
        `ctx=${row.context_window ?? '-'}`.padEnd(14),
        `model=${row.model}`,
        row.error ? `ERR ${row.error}` : 'ok',
        row.sampleIds.length ? `samples=${row.sampleIds.join(', ')}` : ''
      ].join('  ')
    );
  }

  const local = config?.llm?.local || {};
  console.log('');
  console.log('=== Local ===');
  console.log(`context_length config: ${local.context_length ?? '(unset)'}`);
  console.log(`model_path: ${local.model_path ? '[set]' : '(empty)'}`);
  console.log(`max_tokens: ${local.max_tokens ?? '(unset)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
