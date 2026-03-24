import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export async function getHardwareLimits() {
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const cpus = os.cpus();
  const cpuModel = cpus.length ? cpus[0].model : 'Unknown';
  const cpuThreads = cpus.length;

  // Physical cores estimation (threads / 2 for HT/SMT)
  const physicalCores = Math.max(1, Math.floor(cpuThreads / 2));

  // GPU detection
  let gpuName = 'None';
  let vramGb = 0;
  let gpuBackend = 'cpu';

  // Try nvidia-smi
  try {
    const nvidiaOut = execFileSync('nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
    ).toString().trim();
    if (nvidiaOut) {
      const [name, memMb] = nvidiaOut.split(',').map(s => s.trim());
      gpuName = name || 'NVIDIA GPU';
      vramGb = Math.round((parseInt(memMb, 10) || 0) / 1024 * 100) / 100;
      gpuBackend = 'cuda';
    }
  } catch {
    // Try lspci for AMD/Intel
    try {
      const lspci = execFileSync('lspci', [], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
      }).toString();
      const vgaLine = lspci.split('\n').find(l => /VGA|3D|Display/i.test(l));
      if (vgaLine) {
        gpuName = vgaLine.replace(/^[^:]+:\s*/, '').trim();
        if (/amd|radeon/i.test(gpuName)) gpuBackend = 'vulkan';
        else if (/intel/i.test(gpuName)) gpuBackend = 'vulkan';
      }
    } catch {
      // No GPU detection available
    }
  }

  return {
    total_ram_gb: Math.round(totalRam / (1024 ** 3) * 100) / 100,
    free_ram_gb: Math.round(freeRam / (1024 ** 3) * 100) / 100,
    physical_cores: physicalCores,
    cpu_threads: cpuThreads,
    cpu_model: cpuModel,
    vram_gb: vramGb,
    gpu_name: gpuName,
    gpu_backend: gpuBackend
  };
}
