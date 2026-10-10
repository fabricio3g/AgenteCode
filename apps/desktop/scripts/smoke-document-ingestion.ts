/** Live free-model -> production document generators -> re-ingestion check.
 * Run: TSX_TSCONFIG_PATH=renderer/tsconfig.json node --import tsx scripts/smoke-document-ingestion.ts
 * Uses OPENROUTER_API_KEY, app plaintext config, or OpenCode's configured key.
 * No private uploads are sent: every input is a synthetic fixture created here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { INGESTED_DOCUMENT_GUIDANCE } from '../shared/document-ingestion.ts';
import { extractIngestionText } from '../main/document-ingestion.ts';
import { convertFileToMarkdown } from '../main/document-markdown.ts';
import { generateDocx, generateXlsx } from '../main/generated-documents.ts';

function configuredKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const appRoot = process.env.AGENTE_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Agente');
  for (const file of [path.join(appRoot, 'secrets.json'), path.join(appRoot, 'config.json'), path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const key = raw['llm.providers.openrouter.api_key'] || raw?.llm?.providers?.openrouter?.api_key || raw?.openrouter?.key;
      if (typeof key === 'string' && key.startsWith('sk-or-')) return key;
    } catch { /* Try the next configured store; never log secret content. */ }
  }
  throw new Error('No readable OpenRouter key found in the environment, app config or OpenCode credentials.');
}

async function api(route: string, key: string, body?: unknown) {
  const response = await fetch(`https://openrouter.ai/api/v1/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Agente ingestion test' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}: ${result.error?.message || response.statusText}`);
  return result;
}

async function run() {
  const output = process.env.AGENTE_INGEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'agente-ingest-smoke-'));
  fs.mkdirSync(output, { recursive: true });
  const inputs = path.join(output, 'inputs'); fs.mkdirSync(inputs, { recursive: true });
  fs.writeFileSync(path.join(inputs, 'operations.html'), '<html><body><h1>Operations</h1><p>Project Lantern delivered 250 units in September. The documented risk is supplier delays. No October forecast is available.</p></body></html>');
  fs.writeFileSync(path.join(inputs, 'meeting.md'), '## Transcript 00:00:30\n\nThe meeting approved an October supplier review. This is a synthetic transcript fixture, not a live Whisper recording.');
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('September');
  sheet.addRow(['Metric', 'USD']); sheet.addRow(['Revenue', 12750]); sheet.addRow(['Costs', 4750]);
  await book.xlsx.writeFile(path.join(inputs, 'financials.xlsx'));
  const sources = [];
  for (const name of ['operations.html', 'meeting.md', 'financials.xlsx']) {
    const result = await extractIngestionText(path.join(inputs, name));
    sources.push({ name, text: result.text, method: result.method, warning: result.warning });
  }

  // Create a browser DOM for the same renderer artifact functions used by Electron.
  const { JSDOM } = await import('../renderer/node_modules/jsdom/lib/api.js');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, DOMParser: dom.window.DOMParser });
  const [{ getArtifactDefinitionByToolName, parseArtifactToolArgs }, { createWorkProductArtifactFiles }] = await Promise.all([
    import('../renderer/src/lib/services/artifact-registry.ts'), import('../renderer/src/lib/services/generated-documents.ts'),
  ]);
  (dom.window as any).electronAPI = { isElectron: true, invoke: async (command: string, args: { data: Record<string, unknown> }) => {
    if (command === 'generate_docx') return generateDocx(args.data);
    if (command === 'generate_xlsx') return generateXlsx(args.data);
    throw new Error(`Unexpected generation command: ${command}`);
  } };

  const key = configuredKey();
  const catalog = (await api('models', key)).data;
  const model = process.env.OPENROUTER_MODEL || 'openrouter/free';
  const entry = catalog.find((item: any) => item.id === model);
  if (!entry || Number(entry.pricing?.prompt) !== 0 || Number(entry.pricing?.completion) !== 0 ||
      !(model === 'openrouter/free' || model.endsWith(':free'))) {
    throw new Error('Smoke tests require a currently listed free model with zero prompt/completion prices; paid fallback is disabled.');
  }
  const definition = getArtifactDefinitionByToolName('create_work_product')!;
  const response = await api('chat/completions', key, {
    model, stream: false, max_tokens: 4000,
    provider: { require_parameters: true },
    messages: [
      { role: 'system', content: `${INGESTED_DOCUMENT_GUIDANCE}\nThe document reader has already returned the complete synthetic sources below. Call create_work_product with an executive summary, meaningful analysis, sources cited by filename/location and limitations. Request md, html, docx and xlsx. Include a financial table preserving numeric USD values for Revenue, Costs and Profit. Calculate profit as revenue minus costs. State the missing forecast; do not invent one. Keep prose concise.` },
      { role: 'user', content: `Create a management report and workbook from these complete ingestions:\n${JSON.stringify(sources)}` },
    ], tools: [definition.toolDefinition], tool_choice: { type: 'function', function: { name: 'create_work_product' } },
  });
  assert.equal(Number(response.usage?.cost || 0), 0, 'the provider must charge zero for the test');
  const call = response.choices?.[0]?.message?.tool_calls?.find((item: any) => item.function?.name === 'create_work_product');
  assert.ok(call, 'the model must call the deliverable tool');
  const parsed = parseArtifactToolArgs('create_work_product', JSON.parse(call.function.arguments));
  assert.ok(parsed.success, parsed.success ? '' : parsed.error);
  if (!parsed.success) return;
  const spec = parsed.data;
  assert.deepEqual(new Set(spec.formats as string[]), new Set(['md', 'html', 'docx', 'xlsx']));
  const content = JSON.stringify(spec).replace(/,/g, '');
  for (const fact of ['12750', '4750', '8000', '250']) assert.ok(content.includes(fact), `Missing/incorrect source fact ${fact}`);
  for (const source of sources) assert.ok(content.includes(source.name), `Missing source attribution: ${source.name}`);
  assert.ok(Array.isArray(spec.limitations) && spec.limitations.length, 'report must acknowledge missing evidence');
  const generated = await createWorkProductArtifactFiles({ ...spec, path: 'lantern-report' });
  for (const file of generated.files) {
    const filename = path.join(output, path.basename(file.path));
    fs.writeFileSync(filename, Buffer.from(file.dataUrl.slice(file.dataUrl.indexOf(',') + 1), 'base64'));
    const { markdown } = await convertFileToMarkdown(filename);
    const plain = markdown.replace(/,/g, '');
    for (const fact of ['12750', '4750', '8000']) assert.ok(plain.includes(fact), `${file.path} lost ${fact} during generation/re-ingestion`);
    assert.ok(plain.includes('financials.xlsx'), `${file.path} lost its sources`);
  }
  fs.writeFileSync(path.join(output, 'report-spec.json'), JSON.stringify(spec, null, 2));
  fs.writeFileSync(path.join(output, 'test-result.json'), JSON.stringify({ requestedModel: model, actualModel: response.model, cost: response.usage?.cost ?? null,
    files: generated.files.map((file) => file.path), warnings: generated.warnings, sourceCount: sources.length, factsVerified: true }, null, 2));
  dom.window.close();
  console.log(JSON.stringify({ status: 'passed', model: response.model, cost: response.usage?.cost ?? null, output, files: generated.files.map((file) => file.path) }));
}

run().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
