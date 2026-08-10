import type { RuntimeCapabilities } from '$lib/types/model-hub';

const BASE_ARCHITECTURES = ['llama', 'qwen35', 'ministral3', 'lfm2'];

export function runtimeCapabilitiesFromInstallations(
  runtimes: Array<{ name?: string; path?: string }> | null | undefined,
): RuntimeCapabilities | null {
  if (!runtimes?.length) return null;
  const builds = runtimes
    .map((runtime) => `${runtime.name || ''} ${runtime.path || ''}`.match(/\bb(\d{4,})\b/i)?.[1])
    .filter((build): build is string => Boolean(build))
    .map(Number);
  const buildNumber = builds.length ? Math.max(...builds) : undefined;
  return {
    version: buildNumber ? `b${buildNumber}` : undefined,
    build: buildNumber ? `b${buildNumber}` : 'custom',
    supportedArchitectures: [
      ...BASE_ARCHITECTURES,
      ...(buildNumber && buildNumber >= 10159 ? ['qwen36'] : []),
    ],
  };
}
