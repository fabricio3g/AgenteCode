import type { DesktopCapabilities } from '$lib/types/bridge';
import { getDesktopCapabilities } from '$lib/services/capabilities';
import { isElectron } from '$lib/services/bridge';

class CapabilitiesStore {
  desktop = $state<DesktopCapabilities | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  get hasDesktopRuntime(): boolean {
    return !!this.desktop?.local_runtime;
  }

  get hasVoiceStack(): boolean {
    return !!this.desktop?.audio_recording && !!this.desktop?.local_tts;
  }

  async refresh() {
    if (!isElectron()) {
      this.desktop = null;
      return;
    }

    this.loading = true;
    this.error = null;

    try {
      this.desktop = await getDesktopCapabilities();
    } catch (error) {
      this.error = String((error as Error)?.message || error || 'Failed to load desktop capabilities');
    } finally {
      this.loading = false;
    }
  }
}

export const capabilitiesStore = new CapabilitiesStore();
