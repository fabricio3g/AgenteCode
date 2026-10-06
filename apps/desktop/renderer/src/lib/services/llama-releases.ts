/**
 * Resolves llama.cpp runtime downloads from GitHub releases.
 *
 * Shared by the settings runtime panel and the onboarding runtime step — both
 * used to carry their own copy of this logic, with different (and both stale)
 * fallback tags and asset name patterns.
 */

export type RuntimePlatformInfo = {
  platform: string;
  arch: string;
  gpu_backend: string;
  has_gpu: boolean;
};

export type RuntimeBackend =
  | 'cpu' | 'metal' | 'cuda' | 'rocm' | 'vulkan' | 'sycl' | 'openvino' | 'opencl';

export type ReleaseAssetCompanion = {
  asset_name: string;
  download_url: string;
};

export type ReleaseAsset = {
  name: string;
  url: string;
  tag: string;
  label: string;
  variant: 'recommended' | 'gpu' | 'cpu';
  backend: RuntimeBackend;
  description: string;
  /**
   * Archives that must be extracted alongside the runtime for it to start.
   * Windows CUDA builds link against the CUDA runtime shipped in a separate
   * `cudart-*` asset; without it `llama-server.exe` fails to load.
   */
  companions: ReleaseAssetCompanion[];
};

export type ReleaseFetchResult = {
  tag: string;
  /** Assets worth surfacing by default — at most one per backend. */
  assets: ReleaseAsset[];
  /** Superseded builds (older CUDA versions, alternate SYCL precisions). */
  extras: ReleaseAsset[];
  /**
   * Why a known release is shown instead of the latest one ('' when the
   * latest matched). The UI words it; `latestTag` names the skipped release.
   */
  notice: '' | 'rate_limited' | 'no_match' | 'offline';
  latestTag?: string;
};

export const LLAMA_REPO = 'ggml-org/llama.cpp';

/** Used when the GitHub API is unreachable or rate-limited. */
export const FALLBACK_TAG = 'b10437';

const FALLBACK_ASSET_NAMES = [
  `llama-${FALLBACK_TAG}-bin-macos-arm64.tar.gz`,
  `llama-${FALLBACK_TAG}-bin-macos-x64.tar.gz`,
  `llama-${FALLBACK_TAG}-bin-ubuntu-x64.tar.gz`,
  `llama-${FALLBACK_TAG}-bin-ubuntu-arm64.tar.gz`,
  `llama-${FALLBACK_TAG}-bin-ubuntu-vulkan-x64.tar.gz`,
  `llama-${FALLBACK_TAG}-bin-ubuntu-vulkan-arm64.tar.gz`,
  `llama-${FALLBACK_TAG}-bin-win-cpu-x64.zip`,
  `llama-${FALLBACK_TAG}-bin-win-cpu-arm64.zip`,
  `llama-${FALLBACK_TAG}-bin-win-cuda-12.4-x64.zip`,
  `llama-${FALLBACK_TAG}-bin-win-cuda-13.3-x64.zip`,
  `llama-${FALLBACK_TAG}-bin-win-vulkan-x64.zip`,
  `llama-${FALLBACK_TAG}-bin-win-rocm-7.14-x64.zip`,
  `cudart-llama-bin-win-cuda-12.4-x64.zip`,
  `cudart-llama-bin-win-cuda-13.3-x64.zip`
];

const BACKEND_DESCRIPTIONS: Record<RuntimeBackend, string> = {
  metal: 'Apple Silicon / Metal GPU acceleration',
  cuda: 'NVIDIA GPU acceleration (CUDA)',
  rocm: 'AMD GPU acceleration (ROCm)',
  vulkan: 'GPU acceleration via Vulkan (AMD / Intel)',
  sycl: 'Intel GPU via SYCL — requires the oneAPI runtime',
  openvino: 'Intel OpenVINO — requires the OpenVINO runtime',
  opencl: 'GPU acceleration via OpenCL',
  cpu: 'CPU-only — works on all hardware'
};

/** Backends preferred over the detected one when it has no build, in order. */
const BACKEND_ORDER: RuntimeBackend[] = [
  'metal', 'cuda', 'rocm', 'vulkan', 'opencl', 'sycl', 'openvino', 'cpu'
];

function archiveExtension(name: string): string {
  if (name.endsWith('.tar.gz')) return '.tar.gz';
  if (name.endsWith('.tgz')) return '.tgz';
  if (name.endsWith('.zip')) return '.zip';
  return '';
}

function assetArch(name: string): 'x64' | 'arm64' | null {
  const stem = name.slice(0, name.length - archiveExtension(name).length);
  if (/-arm64$/.test(stem)) return 'arm64';
  if (/-x64$/.test(stem)) return 'x64';
  return null;
}

function assetBackend(name: string, os: string): RuntimeBackend {
  if (/-cuda-/.test(name)) return 'cuda';
  if (/-rocm-/.test(name) || /hipblas/.test(name)) return 'rocm';
  if (/-vulkan-/.test(name)) return 'vulkan';
  if (/-sycl-/.test(name) || /-sycl$/.test(name)) return 'sycl';
  if (/-openvino-/.test(name)) return 'openvino';
  if (/-opencl-/.test(name)) return 'opencl';
  if (os === 'macos') return 'metal';
  return 'cpu';
}

/** `llama-b10437-bin-win-cuda-12.4-x64.zip` → `12.4`. */
function cudaVersion(name: string): string {
  return name.match(/-cuda-(\d+(?:\.\d+)*)-/)?.[1] || '';
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function normalizeBackendName(value: string): RuntimeBackend | null {
  const raw = String(value || '').toLowerCase().trim();
  if (raw === 'hip') return 'rocm';
  if (raw === 'mtl') return 'metal';
  if (BACKEND_ORDER.includes(raw as RuntimeBackend)) return raw as RuntimeBackend;
  return null;
}

function assetLabel(name: string): string {
  return name
    .replace(/^llama-[^-]+-bin-/, '')
    .replace(/\.(?:zip|tar\.gz|tgz)$/, '');
}

/**
 * Picks the runtime archives that match the running machine.
 *
 * Pure so it can be tested against a captured release manifest — see
 * `llama-releases.spec.ts`.
 */
export function selectRuntimeAssets(
  releaseAssets: { name: string; url: string }[],
  tag: string,
  platformInfo: RuntimePlatformInfo
): { assets: ReleaseAsset[]; extras: ReleaseAsset[] } {
  const os = String(platformInfo.platform || '').toLowerCase();
  const arch = String(platformInfo.arch || '').toLowerCase();
  const detectedBackend = normalizeBackendName(platformInfo.gpu_backend);

  const byName = new Map(releaseAssets.map((a) => [a.name.toLowerCase(), a]));
  const candidates: ReleaseAsset[] = [];

  for (const asset of releaseAssets) {
    const name = asset.name.toLowerCase();

    // `cudart-*` archives are companions, never a runtime on their own.
    if (name.startsWith('cudart-')) continue;
    // Skips `-ui.tar.gz` and `xcframework.zip`, which carry no llama-server.
    if (!name.includes('-bin-')) continue;
    if (!archiveExtension(name)) continue;
    if (name.includes('-bin-android-') || name.includes('s390x') || name.includes('-rpc-')) continue;

    const matchesOs =
      (os === 'linux' && (name.includes('-bin-ubuntu-') || name.includes('-bin-linux-'))) ||
      (os === 'macos' && name.includes('-bin-macos-')) ||
      (os === 'windows' && name.includes('-bin-win-'));
    if (!matchesOs) continue;

    const builtArch = assetArch(name);
    if (builtArch && arch && builtArch !== arch) continue;

    const backend = assetBackend(name, os);
    const companions: ReleaseAssetCompanion[] = [];

    if (os === 'windows' && backend === 'cuda') {
      const version = cudaVersion(name);
      const cudart = byName.get(`cudart-llama-bin-win-cuda-${version}-${builtArch}.zip`);
      // A CUDA build without its runtime archive will not start. Rather than
      // offer a broken download, drop it from the list entirely.
      if (!cudart) continue;
      companions.push({ asset_name: cudart.name, download_url: cudart.url });
    }

    candidates.push({
      name: asset.name,
      url: asset.url,
      tag,
      label: assetLabel(asset.name),
      variant: 'cpu',
      backend,
      description: BACKEND_DESCRIPTIONS[backend],
      companions
    });
  }

  // One entry per backend: newest CUDA wins, everything else keeps the first
  // match. Superseded builds stay reachable through `extras`.
  const primary = new Map<RuntimeBackend, ReleaseAsset>();
  const extras: ReleaseAsset[] = [];

  for (const candidate of candidates) {
    const held = primary.get(candidate.backend);
    if (!held) {
      primary.set(candidate.backend, candidate);
      continue;
    }
    if (candidate.backend === 'cuda') {
      const isNewer = compareVersions(cudaVersion(candidate.name), cudaVersion(held.name)) > 0;
      if (isNewer) {
        primary.set(candidate.backend, candidate);
        extras.push(held);
        continue;
      }
    }
    extras.push(candidate);
  }

  const assets = [...primary.values()];

  // Exactly one recommendation: the detected GPU backend if we built for it,
  // otherwise the best available in preference order.
  const bestAvailable = BACKEND_ORDER.map((backend) => assets.find((a) => a.backend === backend))
    .find(Boolean);
  let recommended: ReleaseAsset | undefined;
  if (platformInfo.has_gpu && detectedBackend) {
    recommended = assets.find((a) => a.backend === detectedBackend);
  } else if (!platformInfo.has_gpu) {
    recommended = assets.find((a) => a.backend === 'cpu');
  }
  recommended ||= bestAvailable;

  for (const asset of assets) {
    if (asset === recommended) asset.variant = 'recommended';
    else if (asset.backend === 'cpu') asset.variant = 'cpu';
    else asset.variant = 'gpu';
  }

  const rank = (asset: ReleaseAsset) =>
    asset.variant === 'recommended' ? -1 : BACKEND_ORDER.indexOf(asset.backend);
  assets.sort((a, b) => rank(a) - rank(b));

  return { assets, extras };
}

/**
 * Flattens an asset into the download IPC payload.
 *
 * Assets are held in Svelte `$state`, so their fields are reactive Proxies.
 * Electron's IPC uses structured clone, which rejects a Proxy outright ("An
 * object could not be cloned"), so every value is rebuilt as a plain primitive
 * here rather than passed through.
 */
export function toDownloadPayload(asset: ReleaseAsset): {
  download_url: string;
  asset_name: string;
  release_tag: string;
  companions: ReleaseAssetCompanion[];
} {
  return {
    download_url: String(asset.url),
    asset_name: String(asset.name),
    release_tag: String(asset.tag),
    companions: (asset.companions || []).map((companion) => ({
      asset_name: String(companion.asset_name),
      download_url: String(companion.download_url)
    }))
  };
}

export function buildFallbackAssets(platformInfo: RuntimePlatformInfo): ReleaseAsset[] {
  const base = `https://github.com/${LLAMA_REPO}/releases/download/${FALLBACK_TAG}`;
  const manifest = FALLBACK_ASSET_NAMES.map((name) => ({ name, url: `${base}/${name}` }));
  return selectRuntimeAssets(manifest, FALLBACK_TAG, platformInfo).assets;
}

/** Recent llama.cpp releases with a build for this machine, newest first, for a version picker. */
export async function fetchLlamaReleaseList(platformInfo: RuntimePlatformInfo, limit = 8): Promise<Array<{ tag: string; asset: ReleaseAsset }>> {
  const res = await fetch(`https://api.github.com/repos/${LLAMA_REPO}/releases?per_page=20`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'AgenteDesktop' }
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const releases = await res.json() as Array<{ tag_name: string; draft?: boolean; assets: { name: string; browser_download_url: string }[] }>;
  const list: Array<{ tag: string; asset: ReleaseAsset }> = [];
  for (const release of releases) {
    if (release.draft) continue;
    const manifest = (release.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url }));
    const { assets } = selectRuntimeAssets(manifest, release.tag_name, platformInfo);
    const asset = assets.find((a) => a.variant === 'recommended') ?? assets[0];
    if (asset) list.push({ tag: release.tag_name, asset });
    if (list.length >= limit) break;
  }
  return list;
}

export async function fetchLlamaReleaseAssets(
  platformInfo: RuntimePlatformInfo
): Promise<ReleaseFetchResult> {
  const fallback = (notice: ReleaseFetchResult['notice'], latestTag?: string): ReleaseFetchResult => ({
    tag: FALLBACK_TAG,
    assets: buildFallbackAssets(platformInfo),
    extras: [],
    notice,
    ...(latestTag ? { latestTag } : {})
  });

  try {
    // Not /releases/latest: GitHub's "latest" can be a tag with no builds
    // (v0.5.0), which used to pin everyone to the old fallback build.
    const res = await fetch(`https://api.github.com/repos/${LLAMA_REPO}/releases?per_page=15`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'AgenteDesktop'
      }
    });

    if (res.status === 403 || res.status === 429) {
      return fallback('rate_limited');
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);

    const releases = await res.json() as Array<{
      tag_name: string;
      draft?: boolean;
      prerelease?: boolean;
      assets: { name: string; browser_download_url: string }[];
    }>;
    // llama.cpp flags every b-build as a pre-release; only drafts are unfinished.
    for (const release of releases) {
      if (release.draft) continue;
      const manifest = (release.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url }));
      const { assets, extras } = selectRuntimeAssets(manifest, release.tag_name, platformInfo);
      if (assets.length) return { tag: release.tag_name, assets, extras, notice: '' };
    }
    return fallback('no_match', releases[0]?.tag_name);
  } catch {
    return fallback('offline');
  }
}
