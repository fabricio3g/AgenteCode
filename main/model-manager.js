import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './index.js';
import { slugify, loadConfig } from './config.js';
import { readGgufContextLength, readGgufMetadataFields } from './runtime-config-resolver.js';

function getModelsDir() {
  try {
    const cfg = loadConfig();
    return cfg?.llm?.local?.models_dir || getAppPaths().localModelsRoot;
  } catch {
    return getAppPaths().localModelsRoot;
  }
}

function isMmprojFile(fileName) {
  return /(^|[-_.])mmproj[-_.].*\.gguf$/i.test(fileName) || /projector.*\.gguf$/i.test(fileName);
}

function collectGgufFilesRecursive(rootDir) {
  const out = [];
  const stack = [rootDir];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
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
      out.push(fullPath);
    }
  }

  return out;
}

const ggufMetaCache = new Map();
const GGUF_META_CACHE_MAX = 500;
const GGUF_MAGIC = 0x46554747;

function getGgufMetaCacheKey(filePath, mtime) {
  return `${filePath}:${mtime}`;
}

function readGgufMetadata(filePath) {
  const stat = fs.statSync(filePath);
  const cacheKey = getGgufMetaCacheKey(filePath, stat.mtimeMs);
  if (ggufMetaCache.has(cacheKey)) return ggufMetaCache.get(cacheKey);

  const fd = fs.openSync(filePath, 'r');
  try {
    const headerBuf = Buffer.alloc(24);
    fs.readSync(fd, headerBuf, 0, 24, 0);

    const magic = headerBuf.readUInt32LE(0);
    if (magic !== GGUF_MAGIC) {
      throw new Error('Not a GGUF file');
    }

    const version = headerBuf.readUInt32LE(4);
    const tensorCount = Number(headerBuf.readBigUInt64LE(8));
    const metadataKvCount = Number(headerBuf.readBigUInt64LE(16));

    // Use the proper GGUF metadata parser
    const ggufContext = readGgufContextLength(filePath);
    const ggufFields = readGgufMetadataFields(filePath);
    const contextLength = ggufContext?.context_length || guessContextLength(path.basename(filePath));

    const fileName = path.basename(filePath);

    const result = {
      architecture: ggufFields?.architecture || guessArchitecture(fileName),
      context_length: contextLength,
      context_length_source: ggufContext ? 'gguf' : 'filename_guess',
      parameter_count: Number(ggufFields?.parameter_count || 0),
      block_count: Number(ggufFields?.block_count || 0),
      size_label: formatSizeLabel(stat.size),
      quantization: guessQuantization(fileName),
      head_count: Number(ggufFields?.head_count || 0),
      head_count_kv: Number(ggufFields?.head_count_kv || 0),
      embedding_length: Number(ggufFields?.embedding_length || 0),
      file_size_bytes: stat.size,
      quantization_name: guessQuantization(fileName),
      chat_template_uses_tools: typeof ggufFields?.chat_template_uses_tools === 'boolean'
        ? ggufFields.chat_template_uses_tools
        : false
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

function guessArchitecture(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.includes('llama')) return 'llama';
  if (lower.includes('qwen')) return 'qwen2';
  if (lower.includes('mistral')) return 'mistral';
  if (lower.includes('gemma')) return 'gemma';
  if (lower.includes('phi')) return 'phi';
  return 'unknown';
}

function guessContextLength(fileName) {
  const m = fileName.match(/(\d+)k/i);
  if (m) return parseInt(m[1], 10) * 1024;
  return 4096;
}

function guessQuantization(fileName) {
  const m = fileName.match(/(Q\d+_K_[SMLX]|Q\d+_[01]|IQ\d+_[SMLX]{1,2}|F16|F32|BF16)/i);
  return m ? m[1].toUpperCase() : 'unknown';
}

function formatSizeLabel(bytes) {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}

export async function getLocalModels({ offset = 0, limit = 50, sort = 'modified', order = 'desc' } = {}) {
  const modelsDir = getModelsDir();

  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
    return { models: [], total: 0, offset, limit };
  }

  const allModels = [];
  const ggufFiles = collectGgufFilesRecursive(modelsDir);

  for (const fullPath of ggufFiles) {
    const fileName = path.basename(fullPath);
    const stat = fs.statSync(fullPath);
    const relativePath = path.relative(modelsDir, fullPath);

    try {
      const meta = readGgufMetadata(fullPath);
      allModels.push({
        id: slugify(relativePath.replace(/\.gguf$/i, '')),
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
        id: slugify(relativePath.replace(/\.gguf$/i, '')),
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

export async function getGgufMetadata(filePath) {
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
      embedding_length: 0,
      file_size_bytes: fileSize,
      quantization_name: guessQuantization(fileName),
      chat_template_uses_tools: false
    };
  }
}

export async function deleteLocalModel(modelPath) {
  if (fs.existsSync(modelPath)) {
    fs.unlinkSync(modelPath);
  }
}

export async function getModelsDirPath() {
  return getModelsDir();
}

// Model index cache
let modelIndexCache = [];
let modelIndexSignature = '';

function buildModelIndexSignature(modelsDir) {
  const ggufFiles = collectGgufFilesRecursive(modelsDir);
  let newestMtime = 0;
  let totalSize = 0;
  for (const fullPath of ggufFiles) {
    try {
      const stat = fs.statSync(fullPath);
      newestMtime = Math.max(newestMtime, Number(stat.mtimeMs || 0));
      totalSize += Number(stat.size || 0);
    } catch {
      // ignore unreadable entries in signature pass
    }
  }
  return `${modelsDir}:${ggufFiles.length}:${Math.floor(newestMtime)}:${Math.floor(totalSize / 1024)}`;
}

export async function getIndexedModels() {
  return modelIndexCache;
}

export async function refreshModelIndex({ force = false } = {}) {
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

export async function invalidateModelCache(modelPath) {
  modelIndexCache = modelIndexCache.filter(m => m.path !== modelPath);
  modelIndexSignature = '';
}

/**
 * Import an existing GGUF file from an arbitrary path into the app's model registry.
 * If copy_to_managed is true, copies the file to the managed models directory first.
 */
export async function importLocalModel({ filePath, copy_to_managed = false }) {
  const { loadConfig, saveConfig, slugify } = await import('./config.js');
  if (!filePath || typeof filePath !== 'string') throw new Error('filePath is required');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!filePath.toLowerCase().endsWith('.gguf')) throw new Error('File must be a .gguf model');

  const cfg = loadConfig();
  let finalPath = filePath;

  if (copy_to_managed) {
    const modelsDir = getModelsDir();
    fs.mkdirSync(modelsDir, { recursive: true });
    const target = path.join(modelsDir, path.basename(filePath));
    if (filePath !== target) fs.copyFileSync(filePath, target);
    finalPath = target;
  }

  const id = slugify(path.basename(finalPath, path.extname(finalPath)));
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

  const existing = cfg.llm.local.models.findIndex(m => m.id === id);
  if (existing >= 0) cfg.llm.local.models[existing] = record;
  else cfg.llm.local.models.push(record);

  if (!cfg.llm.local.active_model_id) cfg.llm.local.active_model_id = id;
  if (!cfg.llm.local.default_model_id) cfg.llm.local.default_model_id = id;

  saveConfig(cfg);
  await refreshModelIndex();

  return { success: true, model: record };
}
