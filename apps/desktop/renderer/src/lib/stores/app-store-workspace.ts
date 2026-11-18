import type { WorkspaceContext, WorkspaceFile } from '$lib/types/chat';

const WORKSPACE_IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  'target'
]);

const WORKSPACE_TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'go', 'h', 'hpp', 'html', 'ini', 'java', 'js', 'json', 'jsonl',
  'jsx', 'log', 'md', 'mjs', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'toml', 'ts', 'tsx',
  'txt', 'xml', 'yaml', 'yml'
]);

const WORKSPACE_MAX_TEXT_CHARS = 120_000;

export function getWorkspacePath(file: File) {
  return file.webkitRelativePath || file.name;
}

export function shouldIgnoreWorkspacePath(relativePath: string) {
  const segments = relativePath.split('/').filter(Boolean);
  return segments.some((segment) => WORKSPACE_IGNORED_SEGMENTS.has(segment));
}

export function getWorkspaceExtension(relativePath: string) {
  const match = relativePath.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || 'text';
}

export function isSupportedWorkspaceFile(relativePath: string) {
  return WORKSPACE_TEXT_EXTENSIONS.has(getWorkspaceExtension(relativePath));
}

export function trimWorkspaceText(text: string) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= WORKSPACE_MAX_TEXT_CHARS) return normalized;
  return `${normalized.slice(0, WORKSPACE_MAX_TEXT_CHARS)}\n\n[truncated]`;
}

export function buildWorkspacePrompt(workspace: WorkspaceContext) {
  const visibleFiles = workspace.files
    .filter((file) => file.status === 'ready')
    .slice(0, 80)
    .map((file) => `- ${file.path}`);

  const summary = [
    `Root: ${workspace.rootName}`,
    `Indexed files: ${workspace.indexedCount}`,
    `Skipped files: ${workspace.skippedCount}`
  ].join('\n');

  return `${summary}\nFiles:\n${visibleFiles.join('\n')}`;
}

export function recalculateWorkspace(workspace: WorkspaceContext): WorkspaceContext {
  const indexedCount = workspace.files.filter((file) => file.status === 'ready' && !!file.docId).length;
  const skippedCount = workspace.files.length - indexedCount;
  return {
    ...workspace,
    fileCount: workspace.files.length,
    indexedCount,
    skippedCount
  };
}

function mapIndexedWorkspaceFiles(
  files: Array<{ path: string; name: string; size: number; type: string; status: WorkspaceFile['status']; doc_id?: string; reason?: string }>
): WorkspaceFile[] {
  return files.map((file) => ({
    path: file.path,
    name: file.name,
    size: file.size,
    type: file.type,
    status: file.status,
    docId: file.doc_id,
    reason: file.reason
  }));
}

export function buildWorkspaceFromIndexResult(
  result: {
    root_name: string;
    root_path?: string;
    file_count: number;
    indexed_count: number;
    skipped_count: number;
    files: Array<{ path: string; name: string; size: number; type: string; status: WorkspaceFile['status']; doc_id?: string; reason?: string }>;
  },
  attachedAt: number
): WorkspaceContext {
  return {
    rootName: result.root_name,
    rootPath: result.root_path,
    attachedAt,
    fileCount: result.file_count,
    indexedCount: result.indexed_count,
    skippedCount: result.skipped_count,
    files: mapIndexedWorkspaceFiles(result.files)
  };
}
