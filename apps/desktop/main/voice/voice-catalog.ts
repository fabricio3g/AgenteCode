// ── The voice model catalog ───────────────────────────────────────────────
// Every text-to-speech model the bundled audio.cpp can run, read from its own
// model specs (resources/bin/audio/<backend>/model_specs/*.json), so the list
// always matches the engine that ships: a new audio.cpp release brings its new
// models with it. Kokoro and Supertonic keep their hand-written entries
// (shared/voice-models.ts) for their voice and language lists.
//
// File sizes come from the Hugging Face repo listing, cached for a week; the
// catalog works without them (sizes are then unknown).

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getAppPaths } from '../paths.ts';
import { createLogger } from '../utils/logger.ts';
import { VOICE_MODELS, type VoiceModel } from '../../shared/voice-models.ts';

const log = createLogger('[VoiceCatalog]');
const SIZE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Specs that list `tts` though the engine refuses the task ("Chatterbox supports VoiceCloning and VoiceConversion"). */
const CLONE_ONLY_FAMILIES = new Set(['chatterbox']);

type Spec = {
  family: string;
  display_name: string;
  description?: string;
  category?: string;
  status?: string;
  tasks?: string[];
  languages?: string[];
  capabilities?: { tts?: string[]; clone?: string[] };
  package_defaults?: { download?: { repo?: string } };
  packages?: Array<{ id: string; default?: boolean; precision?: string; files?: string[]; strip_prefix?: string; display_name?: string; description?: string; download?: { repo?: string } }>;
  ui?: { recommended_package?: string; builtin_voices?: string[] };
  options?: { request?: Array<{ name?: string; required?: boolean }> };
};

let specCache: VoiceModel[] | null = null;

function specsDir(): string | null {
  const root = path.join(getAppPaths().nativeBinRoot, 'audio');
  for (const backend of ['vulkan', 'cpu']) {
    const dir = path.join(root, backend, 'model_specs');
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

type Package = NonNullable<Spec['packages']>[number];

/** GGUF packages only: `native` ones are safetensors trees the engine converts, not something to download here. */
const isGguf = (pkg: Package) => pkg.precision !== 'native' && !!pkg.files?.some((file) => file.endsWith('.gguf'));
/** The package id without the family prefix: `qwen3_tts_0_6b_base_q8_0` → `0_6b_base_q8_0`. */
const packageRest = (spec: Spec, pkg: Package) => pkg.id.startsWith(`${spec.family}_`) ? pkg.id.slice(spec.family.length + 1) : pkg.id;

/**
 * Parts some specs list beside the model, not something that speaks: F5's
 * standalone vocoder, AuK's VAE and the Qwen it loads through a `qwen_gguf` option.
 */
function isComponent(spec: Spec, pkg: Package): boolean {
  if (/\bvocoder\b|\bVAE\b/i.test(pkg.display_name ?? '')) return true;
  return JSON.stringify(spec).includes(`"${packageRest(spec, pkg).split('_')[0]}_gguf"`);
}

/** `qwen3_tts_0_6b_base_q8_0` → `0.6b base · Q8_0`; `orig` packages read `original`. */
function variantLabel(spec: Spec, pkg: Package): string {
  const precision = pkg.precision && pkg.precision !== 'native' ? pkg.precision : '';
  const rest = precision ? packageRest(spec, pkg).replace(new RegExp(`(^|_)${precision}(?=_|$)`), '') : packageRest(spec, pkg);
  const words = rest.replace(/(\d)_(\d)/g, '$1.$2').split('_').filter(Boolean).join(' ');
  return [words, precision === 'orig' ? 'original' : precision.toUpperCase()].filter(Boolean).join(' · ');
}

/**
 * The spec's other GGUF packages as entries of their own (id = package id), so
 * download, load and delete work unchanged; a low-memory machine can take the
 * Q4 or the 0.6B where the recommended package is too heavy.
 */
function variantsOf(primary: VoiceModel, spec: Spec): VoiceModel[] {
  return (spec.packages ?? [])
    .filter((pkg) => isGguf(pkg) && !isComponent(spec, pkg) && pkg.id !== primary.id && !pkg.files!.includes(primary.file))
    .map((pkg) => {
      const files = pkg.files!.filter(Boolean);
      return {
        ...primary,
        id: pkg.id,
        repo: pkg.download?.repo || primary.repo,
        file: files[0],
        files: files.length > 1 ? files : undefined,
        stripPrefix: pkg.strip_prefix,
        sizeMb: 0,
        featured: false,
        variantOf: primary.id,
        variant: variantLabel(spec, pkg)
      };
    });
}

/** A spec as a catalog entry, or null when it is not a usable text-to-speech model. */
function fromSpec(spec: Spec): VoiceModel | null {
  if (spec.category !== 'tts' && !spec.tasks?.includes('tts')) return null;
  const packages = spec.packages ?? [];
  const chosen = packages.find((p) => p.id === spec.ui?.recommended_package)
    ?? packages.find((p) => p.default)
    ?? packages[0];
  const files = (chosen?.files ?? []).filter(Boolean);
  if (!files.length) return null;
  const voices = (spec.ui?.builtin_voices ?? []).map((id) => ({ id, label: id, language: '*' }));
  const caps = spec.capabilities?.tts ?? [];
  const canClone = caps.includes('speaker_reference') || !!spec.capabilities?.clone?.includes('speaker_reference');
  // Loaded as `tts`, a clone-only model fails the whole server's start.
  const cloneOnly = canClone && (!spec.tasks?.includes('tts') || CLONE_ONLY_FAMILIES.has(spec.family));
  return {
    id: spec.family,
    family: spec.family,
    title: spec.display_name,
    license: '',
    repo: spec.package_defaults?.download?.repo || 'audio-cpp/audio.cpp-gguf',
    file: files[0],
    files: files.length > 1 ? files : undefined,
    stripPrefix: chosen?.strip_prefix,
    sizeMb: 0,
    languages: spec.languages?.length ? spec.languages : ['en'],
    voices,
    espeakLanguages: [],
    description: spec.description,
    status: spec.status,
    needsReference: (cloneOnly || caps.includes('speaker_reference')) && !voices.length,
    canClone,
    variant: chosen ? variantLabel(spec, chosen) : undefined,
    needsTranscript: canClone && !!spec.options?.request?.some((option) => option.name === 'reference_text' && option.required),
    serverTask: cloneOnly ? 'clon' : 'tts'
  };
}

/** Every text-to-speech model, featured ones first. Read once per process. */
export function voiceCatalog(): VoiceModel[] {
  if (specCache) return specCache;
  const featured = VOICE_MODELS.map((model) => ({ ...model }));
  const featuredVariants: VoiceModel[] = [];
  const fromSpecs: VoiceModel[] = [];
  const dir = specsDir();
  if (dir) {
    for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
      try {
        const spec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Spec;
        // Featured models keep their hand-written entry (voices, languages);
        // the spec still supplies their other packages.
        const hand = featured.find((model) => model.family === spec.family);
        if (hand) {
          const own = spec.packages?.find((pkg) => pkg.files?.includes(hand.file));
          if (own) hand.variant = variantLabel(spec, own);
          featuredVariants.push(...variantsOf(hand, spec));
          continue;
        }
        const model = fromSpec(spec);
        if (model) fromSpecs.push(model, ...variantsOf(model, spec));
      } catch (error) {
        log.warn(`skipped ${name}:`, error);
      }
    }
  }
  specCache = [...featured, ...featuredVariants, ...fromSpecs];
  return specCache;
}

export function findVoiceModel(id: string | undefined): VoiceModel | undefined {
  return id ? voiceCatalog().find((model) => model.id === id) : undefined;
}

// ── Sizes ──────────────────────────────────────────────────────────────────

let sizes: Record<string, number> | null = null;

function sizeCachePath(): string {
  return path.join(app.getPath('userData'), 'voice-catalog-sizes.json');
}

/** Bytes per repo file (`repo:path`), from Hugging Face, cached for a week. */
async function repoSizes(repos: string[]): Promise<Record<string, number>> {
  if (sizes) return sizes;
  try {
    const cached = JSON.parse(fs.readFileSync(sizeCachePath(), 'utf8')) as { at: number; sizes: Record<string, number> };
    if (Date.now() - cached.at < SIZE_TTL_MS) return (sizes = cached.sizes);
  } catch { /* first run */ }
  const found: Record<string, number> = {};
  for (const repo of repos) {
    try {
      const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      for (const entry of await res.json() as Array<{ type: string; path: string; size?: number; lfs?: { size?: number } }>) {
        if (entry.type === 'file') found[`${repo}:${entry.path}`] = entry.lfs?.size ?? entry.size ?? 0;
      }
    } catch (error) {
      log.warn(`sizes for ${repo} unavailable:`, error);
    }
  }
  if (Object.keys(found).length) {
    try { fs.writeFileSync(sizeCachePath(), JSON.stringify({ at: Date.now(), sizes: found })); } catch { /* read-only profile */ }
  }
  return (sizes = found);
}

/** The catalog with sizes filled in (MB, summed over a model's files). */
export async function voiceCatalogWithSizes(): Promise<VoiceModel[]> {
  const catalog = voiceCatalog();
  const known = await repoSizes([...new Set(catalog.map((model) => model.repo))]);
  return catalog.map((model) => {
    if (model.sizeMb) return model;
    const files = model.files?.length ? model.files : [model.file];
    const bytes = files.reduce((sum, file) => sum + (known[`${model.repo}:${file}`] ?? 0), 0);
    return bytes ? { ...model, sizeMb: Math.round(bytes / 1e6) } : model;
  });
}
