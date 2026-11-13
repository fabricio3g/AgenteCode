import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getAppPaths } from './paths.ts';
import { loadConfig, saveConfig } from './config.ts';
import { slugify } from './config.utils.ts';
import { readGgufContextLength, readGgufMetadataFields } from './runtime-config-resolver.ts';
import { resolveEffectiveTemplate, detectTemplateThinkingSupport, detectTemplateToolSupport } from './chat-templates.ts';
import { expandShards, SHARD_PATTERN } from './download-planning.ts';

type GgufMetadata = {
  architecture: string;
  context_length: number;
  context_length_source: string;
  parameter_count: number;
  block_count: number;
  size_label: string;
  quantization: string;
  head_count: number;
  head_count_kv: number;
  /** Layers with a KV cache (hybrid models have fewer than block_count). */
  kv_layer_count?: number;
  /** Non-zero only on MoE architectures. */
  expert_count: number;
  embedding_length: number;
  file_size_bytes: number;
  quantization_name: string;
  chat_template_uses_tools: boolean;
  chat_template_supports_thinking?: boolean;
  /** Where the effective template came from: gguf, sidecar, builtin, none. */
  chat_template_source?: string;
  /** Family id when a built-in fallback was applied. */
  chat_template_family?: string | null;
  has_mtp_layers?: boolean;
  is_mmproj?: boolean;
};

type LocalModel = {
  id: string;
  name: string;
  path: string;
  size_gb: number;
  modified: number;
  architecture?: string;
  parameter_count?: number;
  size_label?: string;
  quantization_name?: string;
  context_length?: number;
  block_count?: number;
  chat_template_uses_tools?: boolean;
};

type ModelIndexEntry = {
  id: string;
  name: string;
  path: string;
  size_gb: number;
  modified_time: number;
  architecture?: string;
  context_length?: number;
  parameter_count?: number;
  size_label?: string;
  quantization_name?: string;
  block_count?: number;
  chat_template_uses_tools?: boolean;
  indexed_at: number;
  cache_key: string;
};

function getModelsDir(): string {
  try {
    const cfg = loadConfig();
    return cfg?.llm?.local?.models_dir || getAppPaths().localModelsRoot;
  } catch {
    return getAppPaths().localModelsRoot;
  }
}

function isMmprojFile(fileName: string): boolean {
  return /(^|[-_.])mmproj[-_.].*\.gguf$/i.test(fileName) || /projector.*\.gguf$/i.test(fileName);
}

function collectGgufFilesRecursive(rootDir: string): string[] {
  const out: string[] = [];
  const stack = [rootDir];

  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.gguf')) continue;
      if (isMmprojFile(entry.name)) continue;
      const shard = entry.name.match(SHARD_PATTERN);
      if (shard && Number(shard[1]) !== 1) continue;
      out.push(fullPath);
    }
  }

  return out;
}

/** Imports stay where the user put them; discovery must include that registry. */
function collectModelFiles(modelsDir: string): string[] {
  const files = new Set(collectGgufFilesRecursive(modelsDir).map((file) => fs.realpathSync(file)));
  for (const model of loadConfig().llm?.local?.models || []) {
    const candidate = String(model.path || '');
    try {
      if (!/\.gguf$/i.test(candidate) || isMmprojFile(path.basename(candidate)) || !fs.statSync(candidate).isFile()) continue;
      const canonical = fs.realpathSync(candidate);
      const first = expandShards(canonical)[0];
      if (fs.existsSync(first)) files.add(fs.realpathSync(first));
    } catch { /* A disconnected drive does not prevent reading other models. */ }
  }
  return [...files];
}

const ggufMetaCache = new Map<string, GgufMetadata>();
const GGUF_META_CACHE_MAX = 500;
const GGUF_MAGIC = 0x46554747;

function getGgufMetaCacheKey(filePath: string, mtime: number): string {
  return `${filePath}:${mtime}`;
}

function readGgufMetadata(filePath: string): GgufMetadata {
  const stat = fs.statSync(filePath);
  const cacheKey = getGgufMetaCacheKey(filePath, stat.mtimeMs);
  if (ggufMetaCache.has(cacheKey)) return ggufMetaCache.get(cacheKey)!;

  const fd = fs.openSync(filePath, 'r');
  try {
    const headerBuf = Buffer.alloc(24);
    if (fs.readSync(fd, headerBuf, 0, 24, 0) !== 24) throw new Error('GGUF header is incomplete. Finish downloading the model before importing it.');

    const magic = headerBuf.readUInt32LE(0);
    if (magic !== GGUF_MAGIC) {
      throw new Error('Not a GGUF file');
    }

    const version = headerBuf.readUInt32LE(4);
    if (version !== 2 && version !== 3) throw new Error(`Unsupported GGUF version ${version}. Use a GGUF v2 or v3 model.`);

    // Use the proper GGUF metadata parser
    const ggufContext = readGgufContextLength(filePath);
    const ggufFields = readGgufMetadataFields(filePath);
    const contextLength = ggufContext?.context_length || guessContextLength(path.basename(filePath));

    const fileName = path.basename(filePath);

    // The loader UI must show the capabilities of the template the server
    // will actually render with — the embedded one, a downloaded sidecar, or
    // the family/generic fallback — not just the raw GGUF flags, which are
    // absent on re-quants that still support thinking and tools.
    const effectiveTemplate = resolveEffectiveTemplate({
      modelPath: filePath,
      fields: ggufFields,
      ggufTemplate: ggufFields?.chat_template ?? null
    });
    const effectiveTools = detectTemplateToolSupport(effectiveTemplate.template);
    const effectiveThinking = detectTemplateThinkingSupport(effectiveTemplate.template);

    const result: GgufMetadata = {
      architecture: ggufFields?.architecture || guessArchitecture(fileName),
      context_length: contextLength,
      context_length_source: ggufContext ? 'gguf' : 'filename_guess',
      parameter_count: Number(ggufFields?.parameter_count || 0),
      block_count: Number(ggufFields?.block_count || 0),
      size_label: formatSizeLabel(stat.size),
      quantization: guessQuantization(fileName),
      head_count: Number(ggufFields?.head_count || 0),
      head_count_kv: Number(ggufFields?.head_count_kv || 0),
      kv_layer_count: Number(ggufFields?.kv_layer_count || 0) || undefined,
      expert_count: Number(ggufFields?.expert_count || 0),
      embedding_length: Number(ggufFields?.embedding_length || 0),
      file_size_bytes: stat.size,
      quantization_name: guessQuantization(fileName),
      chat_template_uses_tools: effectiveTools,
      chat_template_supports_thinking: effectiveThinking,
      chat_template_source: effectiveTemplate.source,
      chat_template_family: effectiveTemplate.family,
      has_mtp_layers: typeof ggufFields?.has_mtp_layers === 'boolean'
        ? ggufFields.has_mtp_layers
        : undefined,
      is_mmproj: guessIsMmproj(fileName, ggufFields?.architecture)
    };

    if (ggufMetaCache.size >= GGUF_META_CACHE_MAX) {
      const firstKey = ggufMetaCache.keys().next().value;
      if (firstKey) ggufMetaCache.delete(firstKey);
    }
    ggufMetaCache.set(cacheKey, result);
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

function guessArchitecture(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.includes('llama')) return 'llama';
  if (lower.includes('qwen')) return 'qwen2';
  if (lower.includes('mistral')) return 'mistral';
  if (lower.includes('gemma')) return 'gemma';
  if (lower.includes('phi')) return 'phi';
  return 'unknown';
}

function guessContextLength(fileName: string): number {
  const m = fileName.match(/(\d+)k/i);
  if (m) return parseInt(m[1], 10) * 1024;
  return 4096;
}

function guessQuantization(fileName: string): string {
  const m = fileName.match(/(Q\d+_K_[SMLX]|Q\d+_[01]|IQ\d+_[SMLX]{1,2}|F16|F32|BF16)/i);
  return m ? m[1].toUpperCase() : 'unknown';
}

function guessIsMmproj(fileName: string, architecture: string | null | undefined): boolean {
  const lower = String(fileName || '').toLowerCase();
  if (lower.includes('mmproj') || lower.includes('projector')) return true;
  if (architecture && /^clip$|vision/i.test(architecture)) return true;
  return false;
}

function formatSizeLabel(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}

export async function getLocalModels({ offset = 0, limit = 50, sort = 'modified', order = 'desc' } = {}): Promise<{ models: LocalModel[]; total: number; offset: number; limit: number }> {
  const modelsDir = getModelsDir();

  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  const allModels: LocalModel[] = [];
  const ggufFiles = collectModelFiles(modelsDir);
  const registered = new Map<string, string>();
  for (const model of loadConfig().llm?.local?.models || []) {
    try { registered.set(fs.realpathSync(model.path), model.id); } catch { /* Missing external file. */ }
  }

  for (const fullPath of ggufFiles) {
    const fileName = path.basename(fullPath);
    const stat = fs.statSync(fullPath);
    const relativePath = path.relative(modelsDir, fullPath);

    try {
      const meta = readGgufMetadata(fullPath);
      allModels.push({
        id: registered.get(fullPath) || slugify(relativePath.replace(/\.gguf$/i, '')),
        name: fileName,
        path: fullPath,
        size_gb: Math.round(stat.size / (1024 ** 3) * 100) / 100,
        modified: stat.mtimeMs,
        architecture: meta.architecture,
        parameter_count: meta.parameter_count,
        size_label: meta.size_label,
        quantization_name: meta.quantization_name,
        context_length: meta.context_length,
        block_count: meta.block_count,
        chat_template_uses_tools: meta.chat_template_uses_tools
      });
    } catch {
      allModels.push({
        id: registered.get(fullPath) || slugify(relativePath.replace(/\.gguf$/i, '')),
        name: fileName,
        path: fullPath,
        size_gb: Math.round(stat.size / (1024 ** 3) * 100) / 100,
        modified: stat.mtimeMs
      });
    }
  }

  allModels.sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case 'name':
        cmp = String(a.name || '').localeCompare(String(b.name || ''));
        break;
      case 'size':
        cmp = (b.size_gb || 0) - (a.size_gb || 0);
        break;
      case 'modified':
      default:
        cmp = (b.modified || 0) - (a.modified || 0);
    }
    return order === 'asc' ? -cmp : cmp;
  });

  const total = allModels.length;
  const paginated = allModels.slice(offset, offset + limit);

  return { models: paginated, total, offset, limit };
}

export async function getGgufMetadata(filePath: string): Promise<GgufMetadata> {
  try {
    return readGgufMetadata(filePath);
  } catch {
    const fileName = path.basename(filePath || '');
    let fileSize = 0;
    try {
      fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    } catch {
      fileSize = 0;
    }

    return {
      architecture: guessArchitecture(fileName),
      context_length: guessContextLength(fileName),
      context_length_source: 'filename_guess',
      parameter_count: 0,
      block_count: 0,
      size_label: formatSizeLabel(fileSize),
      quantization: guessQuantization(fileName),
      head_count: 0,
      head_count_kv: 0,
      expert_count: 0,
      embedding_length: 0,
      file_size_bytes: fileSize,
      quantization_name: guessQuantization(fileName),
      chat_template_uses_tools: false,
      is_mmproj: guessIsMmproj(fileName, null)
    };
  }
}

export async function deleteLocalModel(modelPath: string): Promise<void> {
  if (fs.existsSync(modelPath)) {
    fs.unlinkSync(modelPath);
  }
  const cfg = loadConfig();
  if (cfg.llm?.local?.models) {
    cfg.llm.local.models = cfg.llm.local.models.filter((model) => path.resolve(String(model.path || '')) !== path.resolve(modelPath));
    saveConfig(cfg);
  }
  await invalidateModelCache(modelPath);
}

export async function getModelsDirPath(): Promise<string> {
  return getModelsDir();
}

// Model index cache
let modelIndexCache: ModelIndexEntry[] = [];
let modelIndexSignature = '';

function buildModelIndexSignature(modelsDir: string): string {
  const ggufFiles = collectModelFiles(modelsDir);
  const signature = createHash('sha256').update(modelsDir);
  for (const fullPath of ggufFiles) {
    try {
      const stat = fs.statSync(fullPath);
      signature.update(`${fullPath}:${stat.mtimeMs}:${stat.size}\n`);
    } catch {
      // ignore unreadable entries in signature pass
    }
  }
  return signature.digest('hex');
}

export async function getIndexedModels(): Promise<ModelIndexEntry[]> {
  return modelIndexCache;
}

export async function refreshModelIndex({ force = false } = {}): Promise<number> {
  const modelsDir = getModelsDir();
  const signature = buildModelIndexSignature(modelsDir);
  if (!force && modelIndexCache.length && signature === modelIndexSignature) {
    return modelIndexCache.length;
  }

  const { models } = await getLocalModels({ limit: 10000 });
  modelIndexCache = models.map(m => ({
    id: m.id,
    name: m.name,
    path: m.path,
    size_gb: m.size_gb,
    modified_time: m.modified,
    architecture: m.architecture,
    context_length: m.context_length,
    parameter_count: m.parameter_count,
    size_label: m.size_label,
    quantization_name: m.quantization_name,
    block_count: m.block_count,
    chat_template_uses_tools: m.chat_template_uses_tools,
    indexed_at: Date.now(),
    cache_key: `${m.path}:${m.modified}`
  }));
  modelIndexSignature = signature;
  return modelIndexCache.length;
}

export async function invalidateModelCache(modelPath: string): Promise<void> {
  modelIndexCache = modelIndexCache.filter(m => m.path !== modelPath);
  modelIndexSignature = '';
}

/**
 * Import an existing GGUF file from an arbitrary path into the app's model registry.
 * If copy_to_managed is true, copies the file to the managed models directory first.
 */
export async function importLocalModel({ filePath, copy_to_managed = false }: { filePath: string; copy_to_managed?: boolean }): Promise<{ success: boolean; model: Record<string, unknown> }> {
  if (!filePath || typeof filePath !== 'string') throw new Error('filePath is required');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!filePath.toLowerCase().endsWith('.gguf')) throw new Error('File must be a .gguf model');
  if (!fs.statSync(filePath).isFile()) throw new Error('Select a GGUF file, not a folder.');

  filePath = fs.realpathSync(filePath);
  const shards = expandShards(filePath);
  const missing = shards.filter((shard) => !fs.existsSync(shard));
  if (missing.length) throw new Error(`Split GGUF is incomplete. Put all shards in the same folder. Missing: ${missing.map((file) => path.basename(file)).join(', ')}`);
  for (const shard of shards) readGgufMetadata(shard);
  filePath = shards[0];
  const metadata = readGgufMetadata(filePath);
  if (metadata.is_mmproj) throw new Error('This GGUF is a vision projector. Choose the language model, then attach its projector in load settings.');

  const cfg = loadConfig();
  let finalPath = filePath;

  if (copy_to_managed) {
    const modelsDir = getModelsDir();
    fs.mkdirSync(modelsDir, { recursive: true });
    const target = path.join(modelsDir, path.basename(filePath));
    // Never overwrite another model with the same filename during import.
    for (const shard of shards) {
      const destination = path.join(modelsDir, path.basename(shard));
      if (fs.existsSync(destination) && fs.realpathSync(destination) !== fs.realpathSync(shard)) {
        throw new Error(`A model named ${path.basename(shard)} is already in the model folder. Rename it or import without copying.`);
      }
    }
    for (const shard of shards) {
      const destination = path.join(modelsDir, path.basename(shard));
      if (path.resolve(shard) !== path.resolve(destination)) await fs.promises.copyFile(shard, destination);
    }
    finalPath = target;
  }

  const existingRecord = cfg.llm?.local?.models?.find((model) => path.resolve(String(model.path || '')) === path.resolve(finalPath));
  const baseId = slugify(path.basename(finalPath, path.extname(finalPath)));
  const collision = cfg.llm?.local?.models?.some((model) => model.id === baseId && path.resolve(String(model.path || '')) !== path.resolve(finalPath));
  const id = existingRecord?.id || (collision ? `${baseId}-${createHash('sha256').update(finalPath).digest('hex').slice(0, 8)}` : baseId);
  const stat = fs.statSync(finalPath);
  const meta = readGgufMetadata(finalPath);

  const record = {
    id,
    name: path.basename(finalPath),
    filename: path.basename(finalPath),
    path: finalPath,
    source: 'import',
    size_bytes: stat.size,
    sha256: '',
    architecture: meta?.architecture || guessArchitecture(path.basename(finalPath)),
    context_length: meta?.context_length || guessContextLength(path.basename(finalPath)),
    quantization_name: meta?.quantization_name || guessQuantization(path.basename(finalPath)),
    size_label: formatSizeLabel(stat.size),
    modified: stat.mtimeMs
  };

  if (!cfg.llm) cfg.llm = {};
  if (!cfg.llm.local) cfg.llm.local = {};
  if (!cfg.llm.local.models) cfg.llm.local.models = [];

  const existing = cfg.llm.local.models.findIndex((m: { id: string }) => m.id === id);
  if (existing >= 0) cfg.llm.local.models[existing] = record;
  else cfg.llm.local.models.push(record);

  if (!cfg.llm.local.active_model_id) cfg.llm.local.active_model_id = id;
  if (!cfg.llm.local.default_model_id) cfg.llm.local.default_model_id = id;

  saveConfig(cfg);
  await refreshModelIndex();

  return { success: true, model: record };
}
