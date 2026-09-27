import fs from 'node:fs';
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

// ── Readable names and live figures (Linux) ──

/**
 * "Advanced Micro Devices, Inc. [AMD/ATI] Renoir [Radeon Vega Series / …] (rev c9)"
 * → "AMD Radeon Vega (Renoir)". lspci's raw line is what people saw before.
 */
export function prettyGpuName(raw: string): string {
  let text = String(raw || '').replace(/\(rev [^)]*\)/i, '').trim();
  const vendor = /nvidia/i.test(text) ? 'NVIDIA' : /\bamd\b|advanced micro|ati\b/i.test(text) ? 'AMD' : /intel/i.test(text) ? 'Intel' : '';
  text = text
    .replace(/^.*?\[AMD\/ATI\]\s*/i, '')
    .replace(/^(NVIDIA|Intel|Advanced Micro Devices)[^[\]]*?(Corporation|Inc\.?|, Inc\.)\s*/i, '')
    .trim();
  const bracket = text.match(/\[([^\]]+)\]/);
  const codename = text.replace(/\[[^\]]*\]/g, '').trim();
  const product = (bracket?.[1].split('/')[0] ?? '').trim().replace(/\s+Series$/i, '');
  if (!product) return [vendor, codename].filter(Boolean).join(' ') || String(raw || '').trim();
  return `${vendor && !product.toLowerCase().startsWith(vendor.toLowerCase()) ? `${vendor} ` : ''}${product}${codename ? ` (${codename})` : ''}`;
}

/** /proc/meminfo in bytes; MemAvailable is what can be used without swapping. */
export function parseMeminfo(text: string): { total: number; available: number } {
  const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm').exec(text)?.[1] || 0) * 1024;
  return { total: field('MemTotal'), available: field('MemAvailable') || field('MemFree') };
}

type SysfsGpu = { vendor: string; vramTotal: number; vramUsed: number; gttTotal: number };

/** Dedicated (or BIOS-reserved) memory as the amdgpu driver reports it. */
function readAmdgpuSysfs(): SysfsGpu | null {
  let best: SysfsGpu | null = null;
  let cards: string[] = [];
  try { cards = fs.readdirSync('/sys/class/drm').filter((name) => /^card\d+$/.test(name)); } catch { return null; }
  for (const card of cards) {
    const dir = `/sys/class/drm/${card}/device`;
    const read = (file: string) => { try { return fs.readFileSync(`${dir}/${file}`, 'utf8').trim(); } catch { return ''; } };
    const vramTotal = Number(read('mem_info_vram_total') || 0);
    if (!vramTotal) continue;
    const gpu = { vendor: read('vendor'), vramTotal, vramUsed: Number(read('mem_info_vram_used') || 0), gttTotal: Number(read('mem_info_gtt_total') || 0) };
    if (!best || gpu.vramTotal > best.vramTotal) best = gpu;
  }
  return best;
}

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 100) / 100;

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
      ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'],
      { timeout: 5000 }
    );
    const line = stdout.trim().split('\n')[0];
    if (line) {
      const [name, memMb, usedMb] = line.split(',').map(s => s.trim());
      return {
        gpu_name: name || 'NVIDIA GPU',
        vram_gb: Math.round((parseInt(memMb, 10) || 0) / 1024 * 100) / 100,
        vram_used_gb: Math.round((parseInt(usedMb, 10) || 0) / 1024 * 100) / 100,
        gpu_backend: 'cuda'
      };
    }
  } catch { /* not nvidia */ }

  // AMD (amdgpu): the driver reports real VRAM — on APUs, the memory the BIOS
  // reserves for the GPU — and live usage. Far better than an estimate.
  const sysfs = readAmdgpuSysfs();
  const lspciName = await lspciGpuName();
  if (sysfs) {
    return {
      gpu_name: (await vulkanDeviceName()) || prettyGpuName(lspciName) || 'AMD GPU',
      vram_gb: gb(sysfs.vramTotal),
      vram_used_gb: gb(sysfs.vramUsed),
      shared_gb: gb(sysfs.gttTotal),
      vram_estimated: false,
      gpu_backend: 'vulkan'
    };
  }

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
      const gpuName = nameMatch?.[1]?.trim() || prettyGpuName(lspciName) || 'Vulkan GPU';
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

  // lspci only: the name is known, the memory is not (shared, estimated below).
  if (lspciName) return { gpu_name: prettyGpuName(lspciName), vram_gb: 0, vram_estimated: true, gpu_backend: 'vulkan' };

  return { gpu_name: 'None', vram_gb: 0, vram_estimated: false, gpu_backend: 'cpu' };
}

async function lspciGpuName(): Promise<string> {
  try {
    const { stdout } = await execFile('lspci', [], { timeout: 5000 });
    const line = stdout.split('\n').find((l) => /VGA|3D|Display/i.test(l));
    if (!line) return '';
    const parts = line.split(':');
    return (parts.length >= 3 ? parts.slice(2).join(':') : parts.at(-1) || line).trim();
  } catch {
    return '';
  }
}

async function vulkanDeviceName(): Promise<string> {
  try {
    const { stdout } = await execFile('vulkaninfo', ['--summary'], { timeout: 7000, maxBuffer: 8 * 1024 * 1024 });
    const section = stdout.split(/\nGPU\d+:\n/).find((s) => /PHYSICAL_DEVICE_TYPE_(INTEGRATED|DISCRETE)_GPU/i.test(s) && !/llvmpipe/i.test(s));
    return section?.match(/deviceName\s*=\s*(.+)/i)?.[1]?.trim() || '';
  } catch {
    return '';
  }
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
  // Linux: MemAvailable (reclaimable cache counts as free), not MemFree.
  let totalRam = os.totalmem();
  let freeRam = os.freemem();
  if (PLATFORM === 'linux') {
    try {
      const mem = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (mem.total) { totalRam = mem.total; freeRam = mem.available; }
    } catch { /* keep os.* */ }
  }
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
    /** Live GPU memory in use, when the driver reports it. */
    vram_used_gb: typeof gpu.vram_used_gb === 'number' ? gpu.vram_used_gb : null,
    /** System memory the GPU can also borrow (integrated GPUs). */
    shared_gb: typeof gpu.shared_gb === 'number' ? gpu.shared_gb : null,
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
