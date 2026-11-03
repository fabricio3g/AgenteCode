/** Hardware telemetry for the agent. These figures are informational; Blender is not throttled by them. */
export interface BlenderHardwareInfo {
  totalMemoryGB: number;
  availableMemoryGB: number;
  logicalCores: number;
}

export function blenderHardwareInfo(total: number, available: number, cores: number): BlenderHardwareInfo {
  const toGb = (bytes: number) => Math.round(bytes / 1024 ** 3 * 10) / 10;
  return {
    totalMemoryGB: toGb(total),
    availableMemoryGB: toGb(available),
    logicalCores: cores,
  };
}
