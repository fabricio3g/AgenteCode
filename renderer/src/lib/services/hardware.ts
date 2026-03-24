import type { HardwareInfo } from '$lib/types/tauri';
import { invoke } from './tauri';

export async function getHardwareLimits(): Promise<HardwareInfo> {
  return invoke<HardwareInfo>('get_hardware_limits');
}
