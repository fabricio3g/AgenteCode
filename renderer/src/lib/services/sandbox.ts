import type { SandboxExecResult } from '$lib/types/tauri';
import { invoke } from './tauri';

export async function sandboxExec(args: {
  project_name: string;
  files: Record<string, string>;
  command: string;
  args?: string[];
  shell?: boolean;
  timeout_ms?: number;
}): Promise<SandboxExecResult> {
  return invoke<SandboxExecResult>('sandbox_exec', {
    projectName: args.project_name,
    files: args.files,
    command: args.command,
    args: args.args ?? [],
    shell: args.shell,
    timeoutMs: args.timeout_ms
  });
}
