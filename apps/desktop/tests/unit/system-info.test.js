import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMeminfo, prettyGpuName } from '../../main/system-info.ts';

test('turns lspci lines into readable GPU names', () => {
  assert.equal(prettyGpuName('Advanced Micro Devices, Inc. [AMD/ATI] Renoir [Radeon Vega Series / Radeon Vega Mobile Series] (rev c9)'), 'AMD Radeon Vega (Renoir)');
  assert.equal(prettyGpuName('NVIDIA Corporation GA106 [GeForce RTX 3060 Lite Hash Rate] (rev a1)'), 'NVIDIA GeForce RTX 3060 Lite Hash Rate (GA106)');
  assert.equal(prettyGpuName('Intel Corporation Alder Lake-P GT2 [Iris Xe Graphics] (rev 0c)'), 'Intel Iris Xe Graphics (Alder Lake-P GT2)');
});

test('reads available memory, not just free memory', () => {
  const mem = parseMeminfo('MemTotal:       11606124 kB\nMemFree:         2435800 kB\nMemAvailable:    6008272 kB\n');
  assert.equal(mem.total, 11606124 * 1024);
  assert.equal(mem.available, 6008272 * 1024);
});
