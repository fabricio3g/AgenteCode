// The rules a new project folder and a clone URL must meet. Main enforces
// them before touching the disk (`main/project-setup.ts`); the Add project
// dialog checks the same rules as you type and says why in the user's
// language (`code.addProjectFlow.problem.*`), so nothing waits on a round trip.

/** Windows device names a folder can never take, on any platform (portable repos). */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export type FolderNameProblem = 'empty' | 'tooLong' | 'dots' | 'characters' | 'trailing' | 'reserved';
export type CloneUrlProblem = 'urlEmpty' | 'urlInvalid';

/** English for main's errors; the dialog translates the code instead. */
export const PROBLEM_TEXT: Record<FolderNameProblem | CloneUrlProblem, string> = {
  empty: 'Give the folder a name.',
  tooLong: 'That name is too long.',
  dots: 'Pick a different name.',
  characters: 'Folder names cannot contain < > : " / \\ | ? or *.',
  trailing: 'Folder names cannot end with a dot or a space.',
  reserved: 'That name is reserved on Windows.',
  urlEmpty: 'Paste the repository URL.',
  urlInvalid: 'Use an https://, ssh:// or git@host:owner/repo URL.'
};

/**
 * Why a name cannot be a folder, or null: no separators or characters Windows
 * refuses, no `.`/`..`, no trailing dot or space, no device names.
 */
export function folderNameProblem(name: string): FolderNameProblem | null {
  const text = name.trim();
  if (!text) return 'empty';
  if (text.length > 255) return 'tooLong';
  if (text === '.' || text === '..') return 'dots';
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(text)) return 'characters';
  if (/[. ]$/.test(text)) return 'trailing';
  if (RESERVED.test(text)) return 'reserved';
  return null;
}

/**
 * Only URLs git fetches over the network: `https://`, `http://`, `ssh://`,
 * `git://` and scp-style `git@host:owner/repo`. Local paths, `file://` and
 * transports such as `ext::` (which runs a command) are refused, as is
 * anything git could read as an option.
 */
export function cloneUrlProblem(url: string): CloneUrlProblem | null {
  const text = url.trim();
  if (!text) return 'urlEmpty';
  if (text.startsWith('-') || /\s/.test(text)) return 'urlInvalid';
  if (/^(https?|ssh|git):\/\/[^/\s]+\/.+/i.test(text)) return null;
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(text) && !text.includes('::')) return null;
  return 'urlInvalid';
}

/** The folder a clone lands in by default: the repository's name, `.git` dropped. */
export function repoNameFromUrl(url: string): string {
  const tail = url.trim().replace(/[/\\]+$/, '').split(/[/:]/).pop() ?? '';
  return tail.replace(/\.git$/i, '');
}
