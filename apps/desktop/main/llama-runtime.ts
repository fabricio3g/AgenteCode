import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type LlamaRuntimeCapabilities = {
  version: string;
  supportedFlags: Set<string>;
};

const capabilitiesCache = new Map<string, LlamaRuntimeCapabilities>();

function cacheKeyForBinary(binaryPath: string): string {
  try {
    const stat = fs.statSync(binaryPath);
    return `${binaryPath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return binaryPath;
  }
}

export function isLlamaServerBinary(binaryPath: string): boolean {
  const name = path.basename(String(binaryPath || '')).toLowerCase();
  return name === 'llama-server' || name === 'llama-server.exe';
}

function commandOutput(binaryPath: string, args: string[]): string {
  const result = spawnSync(binaryPath, args, {
    timeout: 10_000,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (!output) throw new Error(`No output from ${path.basename(binaryPath)} ${args.join(' ')}`);
  return output;
}

export function inspectLlamaServer(binaryPath: string): LlamaRuntimeCapabilities {
  if (!isLlamaServerBinary(binaryPath)) {
    throw new Error('Selected runtime is not llama-server. Select a llama-server binary, not llama-cli.');
  }
  const cacheKey = cacheKeyForBinary(binaryPath);
  const cached = capabilitiesCache.get(cacheKey);
  if (cached) return cached;

  const help = commandOutput(binaryPath, ['--help']);
  const version = commandOutput(binaryPath, ['--version']).split(/\r?\n/, 1)[0] || 'unknown';
  const supportedFlags = new Set<string>();
  for (const match of help.matchAll(/(?:^|[\s,])(-{1,2}[a-z][\w-]*)(?=[\s,=\[]|$)/gim)) {
    supportedFlags.add(match[1]);
  }
  if (!supportedFlags.has('--model') || !supportedFlags.has('--port')) {
    throw new Error('Selected llama-server does not expose the required server flags. Install a current llama.cpp runtime.');
  }
  const capabilities = { version, supportedFlags };
  capabilitiesCache.set(cacheKey, capabilities);
  return capabilities;
}

export function supportsLlamaFlag(capabilities: LlamaRuntimeCapabilities | null | undefined, flag: string): boolean {
  return !capabilities || capabilities.supportedFlags.has(flag);
}
