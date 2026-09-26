import { describe, expect, it } from 'vitest';
import { selectRuntimeAssets, toDownloadPayload, type RuntimePlatformInfo } from './llama-releases';

/** Captured from the ggml-org/llama.cpp b10437 release manifest. */
const B10437_ASSETS = [
  'llama-b10437-bin-macos-arm64.tar.gz',
  'llama-b10437-bin-macos-x64.tar.gz',
  'llama-b10437-xcframework.zip',
  'llama-b10437-bin-ubuntu-x64.tar.gz',
  'llama-b10437-bin-ubuntu-arm64.tar.gz',
  'llama-b10437-bin-ubuntu-s390x.tar.gz',
  'llama-b10437-bin-ubuntu-vulkan-x64.tar.gz',
  'llama-b10437-bin-ubuntu-vulkan-arm64.tar.gz',
  'llama-b10437-bin-ubuntu-openvino-2026.2.1-x64.tar.gz',
  'llama-b10437-bin-ubuntu-sycl-fp32-x64.tar.gz',
  'llama-b10437-bin-ubuntu-sycl-fp16-x64.tar.gz',
  'llama-b10437-bin-android-arm64.tar.gz',
  'llama-b10437-bin-win-cpu-x64.zip',
  'llama-b10437-bin-win-cpu-arm64.zip',
  'llama-b10437-bin-win-opencl-adreno-arm64.zip',
  'llama-b10437-bin-win-cuda-12.4-x64.zip',
  'llama-b10437-bin-win-cuda-13.3-x64.zip',
  'llama-b10437-bin-win-cuda-13.4-arm64.zip',
  'llama-b10437-bin-win-vulkan-x64.zip',
  'llama-b10437-bin-win-openvino-2026.2.1-x64.zip',
  'llama-b10437-bin-win-sycl-x64.zip',
  'llama-b10437-bin-win-rocm-7.14-x64.zip',
  'llama-b10437-ui.tar.gz',
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.3-x64.zip',
  'cudart-llama-bin-win-cuda-13.4-arm64.zip'
].map((name) => ({ name, url: `https://example.test/${name}` }));

function select(platform: Partial<RuntimePlatformInfo>) {
  return selectRuntimeAssets(B10437_ASSETS, 'b10437', {
    platform: 'linux',
    arch: 'x64',
    gpu_backend: 'cpu',
    has_gpu: false,
    ...platform
  });
}

describe('llama.cpp release asset selection', () => {
  it('recommends exactly one build, matching the detected GPU backend', () => {
    for (const platform of [
      { platform: 'windows', arch: 'x64', gpu_backend: 'cuda', has_gpu: true },
      { platform: 'windows', arch: 'x64', gpu_backend: 'rocm', has_gpu: true },
      { platform: 'linux', arch: 'x64', gpu_backend: 'vulkan', has_gpu: true },
      { platform: 'macos', arch: 'arm64', gpu_backend: 'metal', has_gpu: true },
      { platform: 'linux', arch: 'arm64', gpu_backend: 'cpu', has_gpu: false }
    ]) {
      const { assets } = select(platform);
      const recommended = assets.filter((a) => a.variant === 'recommended');
      expect(recommended, `${platform.platform}/${platform.gpu_backend}`).toHaveLength(1);
      if (platform.has_gpu) {
        expect(recommended[0].backend).toBe(platform.gpu_backend);
      }
    }
  });

  it('pairs Windows CUDA builds with their cudart runtime archive', () => {
    const { assets } = select({ platform: 'windows', arch: 'x64', gpu_backend: 'cuda', has_gpu: true });
    const cuda = assets.find((a) => a.backend === 'cuda');

    expect(cuda?.name).toBe('llama-b10437-bin-win-cuda-13.3-x64.zip');
    expect(cuda?.companions).toEqual([
      {
        asset_name: 'cudart-llama-bin-win-cuda-13.3-x64.zip',
        download_url: 'https://example.test/cudart-llama-bin-win-cuda-13.3-x64.zip'
      }
    ]);
  });

  it('offers the newest CUDA build and keeps older ones as extras', () => {
    const { assets, extras } = select({ platform: 'windows', arch: 'x64', gpu_backend: 'cuda', has_gpu: true });

    expect(assets.filter((a) => a.backend === 'cuda')).toHaveLength(1);
    expect(extras.map((a) => a.name)).toContain('llama-b10437-bin-win-cuda-12.4-x64.zip');
  });

  it('never offers a Windows CUDA build without its runtime', () => {
    const withoutCudart = B10437_ASSETS.filter((a) => !a.name.startsWith('cudart-'));
    const { assets, extras } = selectRuntimeAssets(withoutCudart, 'b10437', {
      platform: 'windows', arch: 'x64', gpu_backend: 'cuda', has_gpu: true
    });

    expect([...assets, ...extras].some((a) => a.backend === 'cuda')).toBe(false);
    // Falls back to another GPU build rather than recommending nothing usable.
    expect(assets.find((a) => a.variant === 'recommended')?.backend).toBe('rocm');
  });

  it('builds a download payload that survives structured clone', () => {
    const { assets } = select({ platform: 'windows', arch: 'x64', gpu_backend: 'cuda', has_gpu: true });
    const cuda = assets.find((a) => a.backend === 'cuda')!;

    // Assets live in Svelte $state, so components hand us reactive Proxies.
    // Electron IPC clones its payload and throws on a Proxy, so the payload
    // builder has to rebuild plain values rather than forward them.
    const proxied = new Proxy(cuda, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        return typeof value === 'object' && value !== null ? new Proxy(value, {}) : value;
      }
    });

    const payload = toDownloadPayload(proxied);

    expect(() => structuredClone(payload)).not.toThrow();
    expect(payload.asset_name).toBe('llama-b10437-bin-win-cuda-13.3-x64.zip');
    expect(payload.release_tag).toBe('b10437');
    expect(payload.companions).toEqual([
      {
        asset_name: 'cudart-llama-bin-win-cuda-13.3-x64.zip',
        download_url: 'https://example.test/cudart-llama-bin-win-cuda-13.3-x64.zip'
      }
    ]);
  });

  it('builds a cloneable payload for assets with no companions', () => {
    const { assets } = select({ platform: 'linux', arch: 'x64', gpu_backend: 'vulkan', has_gpu: true });
    const payload = toDownloadPayload(assets.find((a) => a.backend === 'vulkan')!);

    expect(payload.companions).toEqual([]);
    expect(() => structuredClone(payload)).not.toThrow();
  });

  it('excludes assets that carry no llama-server for this machine', () => {
    const names = Object.values(
      ['windows', 'linux', 'macos'].flatMap((platform) =>
        (['x64', 'arm64'] as const).flatMap((arch) => {
          const { assets, extras } = select({ platform, arch });
          return [...assets, ...extras].map((a) => a.name);
        })
      )
    );

    expect(names).not.toContain('llama-b10437-ui.tar.gz');
    expect(names).not.toContain('llama-b10437-xcframework.zip');
    expect(names).not.toContain('llama-b10437-bin-ubuntu-s390x.tar.gz');
    expect(names).not.toContain('llama-b10437-bin-android-arm64.tar.gz');
    expect(names.some((n) => n.startsWith('cudart-'))).toBe(false);
  });

  it('keeps a build per architecture without cross-matching', () => {
    const x64 = select({ platform: 'windows', arch: 'x64' });
    const arm64 = select({ platform: 'windows', arch: 'arm64' });

    expect(x64.assets.every((a) => !a.name.includes('arm64'))).toBe(true);
    expect(arm64.assets.every((a) => !a.name.includes('-x64'))).toBe(true);
    expect(arm64.assets.map((a) => a.backend)).toContain('opencl');
  });

  it('surfaces SYCL and OpenVINO builds instead of dropping them', () => {
    const { assets, extras } = select({ platform: 'linux', arch: 'x64' });
    const backends = [...assets, ...extras].map((a) => a.backend);

    expect(backends).toContain('sycl');
    expect(backends).toContain('openvino');
    // Both need a vendor runtime installed, so neither is ever the default.
    expect(assets.find((a) => a.variant === 'recommended')?.backend).toBe('cpu');
  });
});

describe('fetchLlamaReleaseAssets', () => {
  it('skips a newest release with no builds instead of falling back to the pinned one', async () => {
    const { fetchLlamaReleaseAssets } = await import('./llama-releases');
    const releases = [
      { tag_name: 'v0.5.0', assets: [] },
      { tag_name: 'b11192', prerelease: true, assets: [{ name: 'llama-b11192-bin-ubuntu-vulkan-x64.tar.gz', browser_download_url: 'https://x.test/v.tgz' }, { name: 'llama-b11192-bin-ubuntu-x64.tar.gz', browser_download_url: 'https://x.test/c.tgz' }] }
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(releases), { status: 200 })) as typeof fetch;
    try {
      const result = await fetchLlamaReleaseAssets({ platform: 'linux', arch: 'x64', gpu_backend: 'vulkan', has_gpu: true });
      expect(result.tag).toBe('b11192');
      expect(result.notice).toBe('');
      expect(result.assets.some((asset) => asset.name.includes('vulkan'))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
