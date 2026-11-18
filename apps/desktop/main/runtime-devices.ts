/**
 * Which devices a llama-server build can offload to, as the build itself
 * says (`llama-server --list-devices`). This is the source of truth for "is
 * there a GPU": the OS probes (wmic, vulkaninfo, nvidia-smi) miss integrated
 * Radeon/Intel graphics and are absent on current Windows, and a build's
 * folder name says what it was compiled for, not what it can reach here.
 *
 * Only an answer is cached. A probe that timed out or failed is asked again
 * next time, instead of being remembered as "no GPU" until the file changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type ListedDevice = { id: string; backend: string; label: string };

const cache = new Map<string, ListedDevice[]>();

function cacheKey(binaryPath: string): string | null {
  try {
    const stat = fs.statSync(binaryPath);
    return `${binaryPath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** "Vulkan0: AMD Radeon(TM) Graphics (14026 MiB, 13324 MiB free)" → one device. */
function parseListDevices(output: string): ListedDevice[] {
  const devices: ListedDevice[] = [];
  for (const raw of String(output || '').split(/\r?\n/)) {
    const match = raw.trim().match(/^([A-Za-z]+)(\d+)\s*:\s*(.+)$/);
    if (!match) continue;
    devices.push({ id: `${match[1]}${match[2]}`, backend: match[1].toLowerCase(), label: match[3].trim() });
  }
  return devices;
}

/**
 * The build's offload devices, or `null` when the probe did not answer. The
 * probe runs from the build's own folder, where its backend libraries are, and
 * never from ours (a stray ggml-vulkan.dll next to the app made a CPU build
 * look like a Vulkan one).
 */
export function listDevices(binaryPath: string | null | undefined): ListedDevice[] | null {
  if (!binaryPath || !fs.existsSync(binaryPath)) return null;
  const key = cacheKey(binaryPath);
  if (key && cache.has(key)) return cache.get(key)!;
  const result = spawnSync(binaryPath, ['--list-devices'], {
    cwd: path.dirname(binaryPath),
    timeout: 10_000,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error || result.status !== 0) return null;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (!/available devices/i.test(output)) return null;
  const devices = parseListDevices(output).filter((device) => device.backend !== 'cpu');
  if (key) cache.set(key, devices);
  return devices;
}

/** Whether a build can offload to a GPU here. `null`: the probe did not answer. */
export function hasGpuDevice(binaryPath: string | null | undefined): boolean | null {
  const devices = listDevices(binaryPath);
  return devices === null ? null : devices.length > 0;
}
