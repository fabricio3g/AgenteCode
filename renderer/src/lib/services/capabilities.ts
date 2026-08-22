import type { DesktopCapabilities } from '$lib/types/bridge';
import { invoke } from '$lib/services/bridge';

export async function getDesktopCapabilities(): Promise<DesktopCapabilities> {
  return invoke<DesktopCapabilities>('get_desktop_capabilities');
}
