// Machine capability probes shared by the llama.cpp and whisper.cpp runtime
// resolvers.
//
// Both resolvers used to carry their own copy of "is there an NVIDIA GPU /
// is Vulkan usable here", written slightly differently each time, so the two
// engines could disagree about the hardware they were both about to target.
// They now ask the same question in the same way.

import { spawnSync } from 'node:child_process';

const PROBE_TIMEOUT_MS = 5000;

/** Runs a probe command and returns stdout, or null if it failed or is absent. */
function probeOutput(command: string, args: string[]): string | null {
  try {
    const result = spawnSync(command, args, {
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.status !== 0) return null;
    return String(result.stdout || '');
  } catch {
    return null;
  }
}

/** True when nvidia-smi lists at least one GPU. */
export function hasNvidiaGpu(): boolean {
  const out = probeOutput('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
  return out !== null && out.trim().length > 0;
}

/**
 * True when `vulkaninfo --summary` reports a device.
 *
 * The whisper resolver previously tested `stdout.includes('GPU')`, which only
 * matches the uppercase form; this accepts `gpu`/`device` either way, matching
 * what the llama resolver already used. Both forms appear in real
 * `vulkaninfo --summary` output ("Devices:" / "GPU:0"), so the narrower test
 * could report Vulkan as unavailable on a machine that had it.
 */
export function hasVulkanSupport(): boolean {
  const out = probeOutput('vulkaninfo', ['--summary']);
  return out !== null && /gpu|device/i.test(out);
}
