import type { AgentArtifact } from '$lib/types/chat';
import { isHiddenArtifactFile } from '$lib/utils/artifact-files';
import { normalizeArtifact } from '$lib/services/artifact-model';

export interface ArtifactDraft {
  original: AgentArtifact;
  current: AgentArtifact;
}

function cleanPath(path: string): string {
  return String(path || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

export function validateArtifactPath(path: string): string {
  const normalized = cleanPath(path);
  if (!normalized) throw new Error('A file or folder name is required.');
  if (normalized.startsWith('__')) throw new Error('Names beginning with "__" are reserved for artifact metadata.');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Artifact paths cannot contain empty, ".", or ".." segments.');
  if (parts.some((part) => /[\0<>:"|?*]/.test(part))) throw new Error('Artifact paths contain unsupported characters.');
  return normalized;
}

export function createArtifactDraft(artifact: AgentArtifact): ArtifactDraft {
  const original = normalizeArtifact(artifact);
  return { original, current: structuredClone(original) };
}

export function updateDraftFile(artifact: AgentArtifact, path: string, content: string): AgentArtifact {
  const normalizedPath = validateArtifactPath(path);
  if (!(normalizedPath in artifact.files)) throw new Error(`File does not exist: ${normalizedPath}`);
  return normalizeArtifact({ ...artifact, files: { ...artifact.files, [normalizedPath]: content } });
}

export function createDraftFile(artifact: AgentArtifact, path: string, content = ''): AgentArtifact {
  const normalizedPath = validateArtifactPath(path);
  if (normalizedPath in artifact.files) throw new Error(`File already exists: ${normalizedPath}`);
  return normalizeArtifact({ ...artifact, files: { ...artifact.files, [normalizedPath]: content } });
}

export function renameDraftPath(artifact: AgentArtifact, from: string, to: string): AgentArtifact {
  const source = validateArtifactPath(from);
  const target = validateArtifactPath(to);
  if (source === target) return normalizeArtifact(artifact);

  const affected = Object.keys(artifact.files).filter((path) => path === source || path.startsWith(`${source}/`));
  if (!affected.length) throw new Error(`Path does not exist: ${source}`);
  const unaffected = new Set(Object.keys(artifact.files).filter((path) => !affected.includes(path)));
  const remapped = affected.map((path) => [path, target + path.slice(source.length)] as const);
  const collision = remapped.find(([, next]) => unaffected.has(next));
  if (collision) throw new Error(`Path already exists: ${collision[1]}`);

  const files = { ...artifact.files };
  for (const path of affected) delete files[path];
  for (const [previous, next] of remapped) files[next] = artifact.files[previous];
  const entryPath = artifact.manifest?.entryPath;
  return normalizeArtifact({
    ...artifact,
    files,
    manifest: artifact.manifest
      ? { ...artifact.manifest, entryPath: entryPath && (entryPath === source || entryPath.startsWith(`${source}/`)) ? target + entryPath.slice(source.length) : entryPath }
      : artifact.manifest
  });
}

export function deleteDraftPath(artifact: AgentArtifact, path: string): AgentArtifact {
  const target = validateArtifactPath(path);
  const affected = Object.keys(artifact.files).filter((key) => key === target || key.startsWith(`${target}/`));
  if (!affected.length) throw new Error(`Path does not exist: ${target}`);
  const files = { ...artifact.files };
  for (const key of affected) delete files[key];
  return normalizeArtifact({ ...artifact, files });
}

export function visibleDraftFiles(artifact: AgentArtifact): Array<[string, string]> {
  return Object.entries(artifact.files).filter(([path]) => !isHiddenArtifactFile(path)).sort(([a], [b]) => a.localeCompare(b));
}

export function isArtifactDraftDirty(draft: ArtifactDraft): boolean {
  return JSON.stringify(draft.current) !== JSON.stringify(draft.original);
}
