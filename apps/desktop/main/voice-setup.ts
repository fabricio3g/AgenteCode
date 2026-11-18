/**
 * One-step voice setup: the first tap on the mic installs what dictation
 * needs — the official whisper.cpp build for this OS (MIT) and the selected
 * Whisper model (MIT) — with progress, instead of sending the user to
 * Settings to hunt for runtimes.
 *
 * GPU comes for free where possible: Windows + NVIDIA gets the CUDA build;
 * elsewhere whisper-server borrows the llama.cpp GPU backend (whisper-server.ts).
 */

import { APP_USER_AGENT } from '../shared/brand.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { loadConfig, saveConfig, WHISPER_QUALITY_CATALOG } from './config.ts';
import { getAppPaths } from './paths.ts';
import { trackDownload } from './model-download.ts';
import { downloadWhisperRuntime } from './whisper-download.ts';
import { resolveWhisperBinary } from './whisper-resolver.ts';
import { hasNvidiaGpu } from './gpu-probe.ts';
import { checkLocalWhisperModel } from './stt-engine.ts';
import { stopWhisperServer } from './whisper-server.ts';

const RELEASES_URL = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=10';
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

type Release = { tag_name: string; assets: Array<{ name: string; browser_download_url: string; size: number }> };

/** The release asset names to try for this machine, best first. */
function assetCandidates(): RegExp[] {
  const arm = process.arch === 'arm64';
  if (process.platform === 'linux') return [arm ? /^whisper-bin-ubuntu-arm64\.tar\.gz$/ : /^whisper-bin-ubuntu-x64\.tar\.gz$/];
  if (process.platform === 'win32') {
    if (arm) return [/^whisper-bin-win-cpu-arm64\.zip$/];
    return hasNvidiaGpu()
      ? [/^whisper-cublas-12[\d.]*-bin-x64\.zip$/, /^whisper-bin-x64\.zip$/]
      : [/^whisper-bin-x64\.zip$/];
  }
  return []; // macOS releases ship an xcframework, not command-line tools.
}

function modelTarget(quality: string): { url: string; file: string; bytes: number } | null {
  const catalog = WHISPER_QUALITY_CATALOG[quality as keyof typeof WHISPER_QUALITY_CATALOG];
  if (!catalog) return null;
  const paths = getAppPaths();
  return {
    url: `${MODEL_BASE_URL}/${catalog.file}`,
    file: path.join(paths.speechModelsRoot, 'whisper', catalog.file),
    bytes: MODEL_SIZES[catalog.file] || 0
  };
}

/** Approximate sizes, for the "Setting up voice (190 MB)" line. */
const MODEL_SIZES: Record<string, number> = {
  'ggml-tiny-q5_1.bin': 32e6,
  'ggml-base-q5_1.bin': 60e6,
  'ggml-small-q5_1.bin': 190e6,
  'ggml-medium-q5_0.bin': 539e6,
  'ggml-large-v3-turbo-q5_0.bin': 574e6
};

export type VoiceSetupPlan = {
  supported: boolean;
  needsRuntime: boolean;
  needsModel: boolean;
  quality: string;
  /** Rough download size in bytes. */
  bytes: number;
};

/** The old default. Never downloaded, it is replaced by the lighter first-run model. */
const LEGACY_DEFAULT = 'medium_q5';
const FIRST_RUN_QUALITY = 'small_q5';

function effectiveQuality(): string {
  const configured = String(loadConfig().stt?.whisper_quality || FIRST_RUN_QUALITY);
  if (configured !== LEGACY_DEFAULT) return configured;
  return checkLocalWhisperModel(LEGACY_DEFAULT).available ? configured : FIRST_RUN_QUALITY;
}

export function voiceSetupPlan(requested?: string): VoiceSetupPlan {
  const quality = requested && modelTarget(requested) ? requested : effectiveQuality();
  const model = modelTarget(quality);
  const needsRuntime = !resolveWhisperBinary();
  // Anywhere the engine looks counts, not only the download target.
  const needsModel = !!model && !checkLocalWhisperModel(quality).available;
  const supported = !needsRuntime || assetCandidates().length > 0;
  return {
    supported,
    needsRuntime,
    needsModel,
    quality,
    bytes: (needsModel ? model?.bytes || 0 : 0) + (needsRuntime ? 12e6 : 0)
  };
}

type WhisperAsset = { url: string; name: string; tag: string; bytes: number };

/** Recent whisper.cpp releases that publish a build for this machine, newest first. */
export async function listWhisperReleases(): Promise<WhisperAsset[]> {
  const patterns = assetCandidates();
  if (!patterns.length) return [];
  const res = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': APP_USER_AGENT } });
  if (!res.ok) throw new Error(`Could not list whisper.cpp releases (HTTP ${res.status})`);
  const releases = await res.json() as Release[];
  const found: WhisperAsset[] = [];
  for (const release of releases) {
    for (const pattern of patterns) {
      const asset = release.assets.find((a) => pattern.test(a.name));
      if (asset) {
        found.push({ url: asset.browser_download_url, name: asset.name, tag: release.tag_name, bytes: asset.size });
        break;
      }
    }
  }
  return found;
}

/** The build to install: the given release, else the newest one with a build for this machine. */
export async function findWhisperRuntimeAsset(tag?: string): Promise<WhisperAsset | null> {
  const releases = await listWhisperReleases();
  return (tag ? releases.find((release) => release.tag === tag) : releases[0]) ?? null;
}

let inFlight: Promise<VoiceSetupPlan> | null = null;

/**
 * Install whatever is missing. Progress goes to the renderer as
 * `voice-setup-progress`. A second call (a double tap on the mic) joins the
 * one in progress: two downloads into one file corrupt the model.
 */
export function setupVoice(win: BrowserWindow | null = null, quality?: string): Promise<VoiceSetupPlan> {
  inFlight ??= runSetup(win, quality).finally(() => { inFlight = null; });
  return inFlight;
}

async function runSetup(win: BrowserWindow | null, quality?: string): Promise<VoiceSetupPlan> {
  const plan = voiceSetupPlan(quality);
  const emit = (phase: 'runtime' | 'model' | 'done', progress: number) => {
    try { win?.webContents?.send('voice-setup-progress', { phase, progress }); } catch { /* window closed */ }
  };
  if (!plan.supported) throw new Error('On-device dictation is not available for this system yet. Add a speech-to-text API key in Settings → Voice.');

  if (plan.needsRuntime) {
    emit('runtime', 0);
    const asset = await findWhisperRuntimeAsset();
    if (!asset) throw new Error('No whisper.cpp build was found for this system.');
    await downloadWhisperRuntime({ download_url: asset.url, asset_name: asset.name, release_tag: asset.tag });
    emit('runtime', 100);
  }

  const model = modelTarget(plan.quality);
  if (plan.needsModel && model) {
    fs.mkdirSync(path.dirname(model.file), { recursive: true });
    // Partials left by an interrupted run are never resumed: clear them.
    for (const name of fs.readdirSync(path.dirname(model.file))) {
      if (name.startsWith(path.basename(model.file) + '.') && name.endsWith('.part')) fs.rmSync(path.join(path.dirname(model.file), name), { force: true });
    }
    const partial = `${model.file}.${process.pid}-${Date.now()}.part`;
    try {
      // "ggml-large-v3-turbo-q5_0.bin" → "Whisper large-v3-turbo"
      const label = `Whisper ${path.basename(model.file).replace(/^ggml-/, '').replace(/-q\d.*$/, '')}`;
      await trackDownload({ url: model.url, dest: partial, label, category: 'speech' }, (fraction) => emit('model', Math.round(fraction * 100)));
      fs.renameSync(partial, model.file);
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    }
  }

  // Only now does the new model become the one in use: a cancelled download
  // leaves dictation on the model that works.
  const cfg = loadConfig();
  if (cfg.stt?.whisper_quality !== plan.quality) saveConfig({ ...cfg, stt: { ...cfg.stt, whisper_quality: plan.quality } });
  stopWhisperServer(); // the next dictation loads the chosen model
  emit('done', 100);
  return voiceSetupPlan(plan.quality);
}

// ── Speech models: the three choices in Settings → Voice and the mic ──────

/** Fast · Balanced · Best — all Whisper (MIT), all multilingual. */
const SPEECH_TIERS = [
  { tier: 'fast', quality: 'base_q5' },
  { tier: 'balanced', quality: 'small_q5', recommended: true },
  { tier: 'best', quality: 'large_v3_turbo_q5' }
] as const;

export type SpeechModel = {
  tier: string;
  quality: string;
  recommended: boolean;
  bytes: number;
  installed: boolean;
  inUse: boolean;
  /** Only files the app downloaded into its own folder can be removed here. */
  removable: boolean;
};

export function listSpeechModels(): SpeechModel[] {
  const current = effectiveQuality();
  const speechDir = getAppPaths().speechModelsRoot;
  return SPEECH_TIERS.map(({ tier, quality, ...rest }) => {
    const found = checkLocalWhisperModel(quality);
    return {
      tier,
      quality,
      recommended: 'recommended' in rest,
      bytes: modelTarget(quality)?.bytes ?? 0,
      installed: found.available,
      inUse: found.available && quality === current,
      removable: found.available && found.modelPath.startsWith(speechDir + path.sep)
    };
  });
}

export function useSpeechModel(quality: string): SpeechModel[] {
  if (!checkLocalWhisperModel(quality).available) throw new Error('Download this model first.');
  const cfg = loadConfig();
  saveConfig({ ...cfg, stt: { ...cfg.stt, whisper_quality: quality } });
  stopWhisperServer();
  return listSpeechModels();
}

export function removeSpeechModel(quality: string): SpeechModel[] {
  const found = checkLocalWhisperModel(quality);
  const speechDir = getAppPaths().speechModelsRoot;
  if (found.available && found.modelPath.startsWith(speechDir + path.sep)) {
    if (quality === effectiveQuality()) stopWhisperServer();
    fs.rmSync(found.modelPath, { force: true });
  }
  return listSpeechModels();
}
