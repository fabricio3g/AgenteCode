import { describe, expect, it } from 'vitest';
import { runtimeCapabilitiesFromInstallations } from './runtime-capabilities';

describe('runtimeCapabilitiesFromInstallations', () => {
  it('reports the newest installed build and its architecture set', () => {
    const capabilities = runtimeCapabilitiesFromInstallations([
      { path: '/runtimes/llama-b9800/bin/llama-server' },
      { name: 'llama-b10159-vulkan' },
    ]);
    expect(capabilities?.version).toBe('b10159');
    expect(capabilities?.supportedArchitectures).toContain('qwen36');
  });

  it('keeps custom builds identifiable without claiming newest architecture support', () => {
    const capabilities = runtimeCapabilitiesFromInstallations([{ path: '/custom/llama-server' }]);
    expect(capabilities?.build).toBe('custom');
    expect(capabilities?.supportedArchitectures).not.toContain('qwen36');
    expect(runtimeCapabilitiesFromInstallations([])).toBeNull();
  });
});
