// ── The explorer's tree ────────────────────────────────────────────────
// `agente_project_files` returns a flat, git-aware list of project-relative
// paths (the same list `@` mentions rank). The explorer only needs a shape:
// build it once per file list, then read rows out of it as folders open.

export interface TreeNode {
  name: string;
  /** Project-relative path, forward slashes, folders without a trailing slash. */
  path: string;
  dir: boolean;
  children: TreeNode[];
}

/** One painted row: the node, its indent and whether a folder is open. */
export interface TreeRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
}

/** Folders first, then files, both alphabetical, at every level. */
function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  for (const node of nodes) if (node.dir) sortTree(node.children);
}

export function buildTree(paths: readonly string[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();

  function ensureDir(path: string): TreeNode {
    const known = dirs.get(path);
    if (known) return known;
    const cut = path.lastIndexOf('/');
    const node: TreeNode = { name: cut < 0 ? path : path.slice(cut + 1), path, dir: true, children: [] };
    dirs.set(path, node);
    if (cut < 0) roots.push(node);
    else ensureDir(path.slice(0, cut)).children.push(node);
    return node;
  }

  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
    if (!path) continue;
    const cut = path.lastIndexOf('/');
    const name = cut < 0 ? path : path.slice(cut + 1);
    if (!name) continue;
    const node: TreeNode = { name, path, dir: false, children: [] };
    if (cut < 0) roots.push(node);
    else ensureDir(path.slice(0, cut)).children.push(node);
  }
  sortTree(roots);
  return roots;
}

/** The rows to paint: the tree walked as far as the open folders go. */
export function visibleRows(tree: readonly TreeNode[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (nodes: readonly TreeNode[], depth: number) => {
    for (const node of nodes) {
      const open = node.dir && expanded.has(node.path);
      rows.push({ node, depth, expanded: open });
      if (open) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}

/** Parent folder of a path, or null at the root. */
export function parentPath(path: string): string | null {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? null : path.slice(0, cut);
}

/** Every folder that has to be open for `path` to be reachable. */
export function ancestorDirs(path: string): string[] {
  const out: string[] = [];
  let cut = path.indexOf('/');
  while (cut >= 0) {
    out.push(path.slice(0, cut));
    cut = path.indexOf('/', cut + 1);
  }
  return out;
}

/** Where the caret moves when a folder opens with the right arrow. */
export function firstChildPath(node: TreeNode): string | null {
  return node.dir ? node.children[0]?.path ?? null : null;
}
