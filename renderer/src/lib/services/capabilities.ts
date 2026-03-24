import type { DesktopCapabilities } from '$lib/types/tauri';
import { invoke } from '$lib/services/tauri';

export async function getDesktopCapabilities(): Promise<DesktopCapabilities> {
  return invoke<DesktopCapabilities>('get_desktop_capabilities');
}
