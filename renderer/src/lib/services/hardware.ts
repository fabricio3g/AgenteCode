import type { HardwareInfo } from '$lib/types/bridge';
import { invoke } from './bridge';

export async function getHardwareLimits(): Promise<HardwareInfo> {
  return invoke<HardwareInfo>('get_hardware_limits');
}
