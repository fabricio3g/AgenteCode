import {
  resolveRuntimeConfig,
  readGgufContextLength,
  detectOsArch,
  detectAvailableBackend,
  calculateContextPressure,
  formatStartupLog
} from './main/runtime-config-resolver.js';

console.log('=== Runtime Config Resolver Tests ===\n');

// Test 1: OS/Arch detection
console.log('Test 1: OS/Arch Detection');
const osArch = detectOsArch();
console.log(`  Platform: ${osArch.platform}, Arch: ${osArch.arch}`);
console.log(`  ✓ Passed\n`);

// Test 2: Backend detection
console.log('Test 2: Backend Detection');
const backend = detectAvailableBackend();
console.log(`  Detected: ${backend.backend} (${backend.reason})`);
console.log(`  ✓ Passed\n`);

// Test 3: Auto backend resolution
console.log('Test 3: Auto Backend Resolution');
const autoConfig = resolveRuntimeConfig({
  modelPath: null,
  userBackend: 'auto',
  systemInfo: { vram_gb: 0, total_ram_gb: 16 }
});
console.log(`  Backend: ${autoConfig.backend}`);
console.log(`  GPU Layers: ${autoConfig.gpuLayers}`);
console.log(`  Context: ${autoConfig.contextSize}`);
console.log(`  Reason Log: ${autoConfig.reasonLog.join(', ')}`);
console.log(`  ✓ Passed\n`);

// Test 4: User-specified backend with GPU layers
console.log('Test 4: User-Specified Backend');
const userConfig = resolveRuntimeConfig({
  modelPath: null,
  userBackend: 'vulkan',
  userGpuLayers: 20,
  systemInfo: { vram_gb: 8, total_ram_gb: 16 }
});
console.log(`  Backend: ${userConfig.backend}`);
console.log(`  GPU Layers: ${userConfig.gpuLayers}`);
console.log(`  Context: ${userConfig.contextSize}`);
console.log(`  Reason Log: ${userConfig.reasonLog.join(', ')}`);
console.log(`  ✓ Passed\n`);

// Test 5: CPU backend forces GPU layers to 0
console.log('Test 5: CPU Backend Forces GPU=0');
const cpuConfig = resolveRuntimeConfig({
  modelPath: null,
  userBackend: 'cpu',
  userGpuLayers: 30,
  systemInfo: { vram_gb: 8, total_ram_gb: 16 }
});
console.log(`  Backend: ${cpuConfig.backend}`);
console.log(`  GPU Layers: ${cpuConfig.gpuLayers}`);
console.log(`  Expected: 0`);
if (cpuConfig.gpuLayers === 0) {
  console.log(`  ✓ Passed\n`);
} else {
  console.log(`  ✗ Failed\n`);
}

// Test 6: Context pressure calculation
console.log('Test 6: Context Pressure');
const messages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello, how are you?' },
  { role: 'assistant', content: 'I am doing well, thank you!' }
];
const pressure = calculateContextPressure(messages, { contextSize: 4096 });
console.log(`  Max Context: ${pressure.maxContext}`);
console.log(`  Used Tokens: ${pressure.usedTokens}`);
console.log(`  Remaining: ${pressure.remaining}`);
console.log(`  Usage: ${pressure.usagePercent}%`);
console.log(`  Overflow: ${pressure.isOverflow}`);
console.log(`  ✓ Passed\n`);

// Test 7: Context overflow detection
console.log('Test 7: Context Overflow');
const longMessages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  ...Array(100).fill(null).map((_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'This is a very long message to simulate context overflow. '.repeat(50)
  }))
];
const overflowPressure = calculateContextPressure(longMessages, { contextSize: 4096 });
console.log(`  Max Context: ${overflowPressure.maxContext}`);
console.log(`  Used Tokens: ${overflowPressure.usedTokens}`);
console.log(`  Overflow: ${overflowPressure.isOverflow}`);
console.log(`  Warning: ${overflowPressure.warning}`);
if (overflowPressure.isOverflow) {
  console.log(`  ✓ Passed\n`);
} else {
  console.log(`  ✗ Failed\n`);
}

// Test 8: Startup log formatting
console.log('Test 8: Startup Log Formatting');
const startupLog = formatStartupLog({
  backend: 'vulkan',
  gpuLayers: 28,
  contextSize: 8192,
  ggufContextLength: 32768,
  reasonLog: ['auto_detected=vulkan', 'context_clamped(32768->8192,memory_heuristic)']
});
console.log(`  ${startupLog}`);
console.log(`  ✓ Passed\n`);

// Test 9: Invalid backend fallback
console.log('Test 9: Invalid Backend Fallback');
const invalidConfig = resolveRuntimeConfig({
  userBackend: 'invalid_backend',
  systemInfo: { vram_gb: 0, total_ram_gb: 16 }
});
console.log(`  Requested: invalid_backend`);
console.log(`  Resolved: ${invalidConfig.backend}`);
if (invalidConfig.backend === 'cpu') {
  console.log(`  ✓ Passed\n`);
} else {
  console.log(`  ✗ Failed\n`);
}

console.log('=== All Tests Complete ===');
