import os from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const PLATFORM = process.platform;
const ARCH = process.arch;

// ── Physical core detection (per-platform) ──

async function detectPhysicalCores() {
  try {
    if (PLATFORM === 'darwin') {
      const { stdout } = await execFile('sysctl', ['-n', 'hw.physicalcpu'], { timeout: 3000 });
      return Math.max(1, parseInt(stdout.trim(), 10) || 0);
    }
    if (PLATFORM === 'linux') {
      const { stdout } = await execFile('lscpu', ['-b', '-p=Core'], { timeout: 3000 });
      const cores = new Set();
      for (const line of stdout.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        cores.add(line.trim());
      }
      return Math.max(1, cores.size);
    }
    if (PLATFORM === 'win32') {
      const { stdout } = await execFile('wmic', ['cpu', 'get', 'NumberOfCores', '/format:value'], { timeout: 5000 });
      const match = stdout.match(/NumberOfCores\s*=\s*(\d+)/);
      return Math.max(1, parseInt(match?.[1], 10) || 0);
    }
  } catch {
    // Fallback
  }
  return Math.max(1, Math.floor(os.cpus().length / 2));
}

// ── GPU detection (per-platform) ──

async function detectGpu() {
  if (PLATFORM === 'linux') return detectGpuLinux();
  if (PLATFORM === 'darwin') return detectGpuMac();
  if (PLATFORM === 'win32') return detectGpuWindows();
  return { gpu_name: 'None', vram_gb: 0, gpu_backend: 'cpu' };
}

async function detectGpuLinux() {
  // Try nvidia-smi first
  try {
    const { stdout } = await execFile('nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000 }
    );
    const line = stdout.trim().split('\n')[0];
    if (line) {
      const [name, memMb] = line.split(',').map(s => s.trim());
      return {
        gpu_name: name || 'NVIDIA GPU',
        vram_gb: Math.round((parseInt(memMb, 10) || 0) / 1024 * 100) / 100,
        gpu_backend: 'cuda'
      };
    }
  } catch { /* not nvidia */ }

  // Try Vulkan summary (works well for AMD/Intel on Linux)
  try {
    const { stdout } = await execFile('vulkaninfo', ['--summary'], { timeout: 7000, maxBuffer: 8 * 1024 * 1024 });
    const gpuSection = stdout
      .split(/\nGPU\d+:\n/)
      .map(s => s.trim())
      .find(s => /deviceType\s*=\s*PHYSICAL_DEVICE_TYPE_(INTEGRATED|DISCRETE)_GPU/i.test(s) && !/llvmpipe/i.test(s));

    if (gpuSection) {
      const nameMatch = gpuSection.match(/deviceName\s*=\s*(.+)/i);
      const typeMatch = gpuSection.match(/deviceType\s*=\s*(.+)/i);
      const gpuName = nameMatch?.[1]?.trim() || 'Vulkan GPU';
      const isIntegrated = /INTEGRATED_GPU/i.test(typeMatch?.[1] || '');
      const vramGb = await detectVulkanDeviceLocalMemoryGb();
      return {
        gpu_name: gpuName,
        vram_gb: vramGb,
        vram_estimated: isIntegrated || vramGb <= 0,
        gpu_backend: 'vulkan'
      };
    }
  } catch { /* no vulkaninfo */ }

  // Try lspci for AMD/Intel
  try {
    const { stdout } = await execFile('lspci', [], { timeout: 5000 });
    const vgaLine = stdout.split('\n').find(l => /VGA|3D|Display/i.test(l));
    if (vgaLine) {
      const parts = vgaLine.split(':');
      const gpuName = (parts.length >= 3 ? parts.slice(2).join(':') : parts.at(-1) || vgaLine).trim();
      let gpuBackend = 'vulkan';
      if (/amd|radeon/i.test(gpuName)) gpuBackend = 'vulkan';
      else if (/intel/i.test(gpuName)) gpuBackend = 'vulkan';
      return { gpu_name: gpuName, vram_gb: 0, vram_estimated: true, gpu_backend: gpuBackend };
    }
  } catch { /* no lspci */ }

  return { gpu_name: 'None', vram_gb: 0, vram_estimated: false, gpu_backend: 'cpu' };
}

async function detectVulkanDeviceLocalMemoryGb() {
  try {
    const { stdout } = await execFile('vulkaninfo', [], { timeout: 12000, maxBuffer: 50 * 1024 * 1024 });
    const regex = /size\s*=\s*\d+[^\n]*\(([\d.]+)\s+GiB\)[\s\S]{0,220}?MEMORY_HEAP_DEVICE_LOCAL_BIT/g;
    let maxGiB = 0;
    let match;
    while ((match = regex.exec(stdout)) !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > maxGiB) maxGiB = value;
    }
    return Math.round(maxGiB * 100) / 100;
  } catch {
    return 0;
  }
}

async function detectGpuMac() {
  try {
    const { stdout } = await execFile('system_profiler', ['SPDisplaysDataType'], { timeout: 8000 });
    const nameMatch = stdout.match(/Chipset Model:\s*(.+)/) || stdout.match(/Chip:\s*(.+)/);
    const vramMatch = stdout.match(/VRAM \(Total\):\s*(\d+)\s*MB/) || stdout.match(/Metal Performance:\s*(.+)/);
    const gpuName = nameMatch?.[1]?.trim() || 'Apple GPU';
    let vramGb = 0;
    if (vramMatch) {
      vramGb = Math.round((parseInt(vramMatch[1], 10) || 0) / 1024 * 100) / 100;
    }
    // Apple Silicon shares system RAM — Metal is always available
    const isMetal = /metal/i.test(stdout) || /apple/i.test(gpuName) || /m[1-4]/i.test(gpuName);
    return {
      gpu_name: gpuName,
      vram_gb: vramGb,
      gpu_backend: isMetal ? 'metal' : 'cpu'
    };
  } catch {
    return { gpu_name: 'None', vram_gb: 0, gpu_backend: 'cpu' };
  }
}

async function detectGpuWindows() {
  // Try nvidia-smi first
  try {
    const { stdout } = await execFile('nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000 }
    );
    const line = stdout.trim().split('\n')[0];
    if (line) {
      const [name, memMb] = line.split(',').map(s => s.trim());
      return {
        gpu_name: name || 'NVIDIA GPU',
        vram_gb: Math.round((parseInt(memMb, 10) || 0) / 1024 * 100) / 100,
        gpu_backend: 'cuda'
      };
    }
  } catch { /* not nvidia */ }

  // Try wmic for other GPUs
  try {
    const { stdout } = await execFile('wmic', ['path', 'win32_videocontroller', 'get', 'name,adapterram', '/format:value'], { timeout: 5000 });
    const nameMatch = stdout.match(/Name\s*=\s*(.+)/);
    const ramMatch = stdout.match(/AdapterRAM\s*=\s*(\d+)/);
    if (nameMatch) {
      const gpuName = nameMatch[1].trim();
      const vramBytes = parseInt(ramMatch?.[1], 10) || 0;
      let gpuBackend = 'vulkan';
      if (/nvidia/i.test(gpuName)) gpuBackend = 'cuda';
      return {
        gpu_name: gpuName,
        vram_gb: Math.round(vramBytes / (1024 ** 3) * 100) / 100,
        gpu_backend: gpuBackend
      };
    }
  } catch { /* no wmic */ }

  return { gpu_name: 'None', vram_gb: 0, gpu_backend: 'cpu' };
}

// ── Public API ──

export async function getSystemInfo() {
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const cpus = os.cpus();
  const cpuModel = cpus.length ? cpus[0].model : 'Unknown';
  const cpuThreads = cpus.length;

  const [physicalCores, gpu] = await Promise.all([
    detectPhysicalCores(),
    detectGpu()
  ]);

  let vramGb = Number(gpu.vram_gb || 0);
  let vramEstimated = !!gpu.vram_estimated;
  const totalGb = totalRam / (1024 ** 3);

  // On integrated GPUs Linux often reports 0 dedicated VRAM. Give a practical
  // shared-memory estimate so recommendations and UI are useful.
  if (PLATFORM === 'linux' && gpu.gpu_backend === 'vulkan' && vramGb <= 0) {
    vramGb = Math.max(1, Math.min(8, totalGb * 0.35));
    vramGb = Math.round(vramGb * 100) / 100;
    vramEstimated = true;
  }

  if (vramEstimated && vramGb > 0) {
    const estimatedCapGb = Math.max(1, Math.min(8, totalGb * 0.35));
    vramGb = Math.min(vramGb, estimatedCapGb);
    vramGb = Math.round(vramGb * 100) / 100;
  }

  return {
    total_ram_gb: Math.round(totalRam / (1024 ** 3) * 100) / 100,
    free_ram_gb: Math.round(freeRam / (1024 ** 3) * 100) / 100,
    physical_cores: physicalCores,
    cpu_threads: cpuThreads,
    cpu_model: cpuModel,
    vram_gb: vramGb,
    vram_estimated: vramEstimated,
    gpu_name: gpu.gpu_name,
    gpu_backend: gpu.gpu_backend,
    os_platform: PLATFORM,
    os_arch: ARCH
  };
}

/** Backward-compatible alias consumed by ipc-handlers and llm-runner */
export async function getHardwareLimits() {
  return getSystemInfo();
}
