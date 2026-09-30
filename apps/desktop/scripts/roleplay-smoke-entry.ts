// Credentials stay in Electron; the renderer test exercises the production turn pipeline.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { app, safeStorage } from 'electron';
import Database from 'better-sqlite3';
import { resolveProvider } from '../main/providers/registry';
import { keyringAppName } from '../main/data-folder';

app.setName('Agente');
app.disableHardwareAcceleration();
const root = process.env.AGENTE_HOME || path.join(app.getPath('appData'), 'Agente');
app.setName(keyringAppName(root, 'chatealm') || 'chatealm');
app.setPath('userData', root);

async function main() {
  await app.whenReady();
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  if (config.llm?.backend_mode !== 'api') throw new Error('This probe requires the configured API backend.');
  const providerName = config.llm.provider;
  const route = config.llm.providers?.[providerName];
  if (!route?.model || !route?.base_url) throw new Error('The selected provider has no model or endpoint.');
  const secrets = JSON.parse(fs.readFileSync(path.join(root, 'secrets.json'), 'utf8'));
  const stored = secrets[`llm.providers.${providerName}.api_key`] || route.api_key;
  if (!stored) throw new Error('The selected provider has no saved credential.');
  let apiKey = stored;
  if (safeStorage.isEncryptionAvailable()) {
    try { apiKey = safeStorage.decryptString(Buffer.from(stored, 'base64')); } catch { /* Plaintext credentials are valid too. */ }
  }
  const database = new Database(path.join(root, 'cache', 'chat-history.db'), { readonly: true });
  const cards = database.prepare('SELECT id, name, data FROM characters').all().map((row) => ({ ...JSON.parse(row.data), id: row.id, name: row.name }));
  database.close();
  const adapter = resolveProvider(providerName, route.base_url);
  const token = crypto.randomUUID();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end('{}'); return; }
    try {
      if (request.url === '/context') {
        response.end(JSON.stringify({ provider: providerName, model: route.model, cards }));
        return;
      }
      const buffers = [];
      for await (const chunk of request) buffers.push(chunk);
      const params = JSON.parse(Buffer.concat(buffers).toString());
      const result = await adapter.complete({ ...params, apiKey, baseUrl: route.base_url, model: route.model,
        temperature: params.temperature ?? route.temperature ?? 0.7,
        max_tokens: params.max_tokens || route.max_tokens || 4096, signal: AbortSignal.timeout(180000) });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  console.log(`Live Roleplay probe: ${providerName} / ${route.model}. Credentials remain in Electron.`);
  const project = process.env.ROLEPLAY_PROJECT_ROOT!;
  const child = spawn('npm', ['exec', '--', 'vitest', 'run', 'src/lib/features/roleplay/roleplay-live.spec.ts'], {
    cwd: path.join(project, 'renderer'), stdio: 'inherit', env: { ...process.env,
      ROLEPLAY_LIVE_URL: `http://127.0.0.1:${address.port}`, ROLEPLAY_LIVE_TOKEN: token }
  });
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => resolve(code ?? 1)); });
  } finally { server.close(); }
}

main().catch((error) => { console.error('Roleplay probe failed:', error.message); process.exitCode = 1; }).finally(() => app.exit(process.exitCode || 0));
