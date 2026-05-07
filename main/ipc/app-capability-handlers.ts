import type { IpcMain } from 'electron';

type AppCapabilityDeps = {
  ipcMain: IpcMain;
  getHardwareLimits: () => unknown;
  loadConfig: () => unknown;
  getSystemInfo: () => Promise<{
    os_platform: string;
    os_arch: string;
    gpu_backend: string;
    vram_gb: number;
  }>;
};

export function registerAppCapabilityHandlers({
  ipcMain,
  getHardwareLimits,
  loadConfig,
  getSystemInfo,
}: AppCapabilityDeps): void {
  ipcMain.handle('get_hardware_limits', () => getHardwareLimits());

  ipcMain.handle('is_first_run', () => {
    const cfg = loadConfig() as { onboarding?: { completed?: boolean } };
    return !cfg?.onboarding?.completed;
  });

  ipcMain.handle('get_runtime_recommendations', async () => {
    const info = await getSystemInfo();
    const platform = info.os_platform;
    const arch = info.os_arch;
    let osLabel = 'linux';
    if (platform === 'darwin') osLabel = 'macos';
    else if (platform === 'win32') osLabel = 'windows';

    return {
      platform: osLabel,
      arch: arch === 'arm64' ? 'arm64' : 'x64',
      gpu_backend: info.gpu_backend,
      has_gpu: info.vram_gb > 0,
      recommended_variant: info.gpu_backend === 'cuda'
        ? 'cuda'
        : info.gpu_backend === 'metal'
          ? 'metal'
          : info.gpu_backend === 'vulkan'
            ? 'vulkan'
            : 'cpu',
    };
  });

  ipcMain.handle('get_desktop_capabilities', () => ({
    platform: process.platform,
    desktop_shell: true,
    local_runtime: true,
    local_tts: true,
    audio_recording: true,
    rag_indexing: true,
    web_search: true,
    sandbox_exec: true,
  }));
}
