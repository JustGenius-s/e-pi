import type { FileEntry } from "../types/contracts";

/**
 * Lazy directory-tree node: a FileEntry plus expansion/lazy-load state.
 * `path` is always absolute.
 */
export interface TreeNode extends FileEntry {
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
  error?: string;
}

export function treeNode(entry: FileEntry): TreeNode {
  return { ...entry };
}

/** Immutably update the node at `path`: expand/collapse and optionally set children/loading/error. */
export function expandPath(
  node: TreeNode | undefined,
  path: string,
  expanded: boolean,
  loading = false,
  children?: TreeNode[],
  error?: string,
): TreeNode | undefined {
  if (!node) return node;
  if (node.path === path) {
    return {
      ...node,
      expanded,
      loading,
      error: error ?? node.error,
      children: children ?? node.children,
    };
  }
  if (!node.children) return node;
  return {
    ...node,
    children: node.children.flatMap((child) => {
      const updated = expandPath(child, path, expanded, loading, children, error);
      return updated ? [updated] : [];
    }),
  };
}

/** Immutably replace the children of the directory at `path` (watcher refresh). */
export function refreshDirChildren(node: TreeNode | undefined, path: string, children: TreeNode[]): TreeNode | undefined {
  if (!node) return node;
  if (node.path === path) {
    return { ...node, children, loading: false, error: undefined };
  }
  if (!node.children) return node;
  return {
    ...node,
    children: node.children.flatMap((child) => {
      const updated = refreshDirChildren(child, path, children);
      return updated ? [updated] : [];
    }),
  };
}

/** Find a node by absolute path. */
export function findNode(node: TreeNode | undefined, path: string): TreeNode | undefined {
  if (!node) return undefined;
  if (node.path === path) return node;
  if (!node.children) return undefined;
  for (const child of node.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return undefined;
}

/**
 * Multi-root (multi-repo) file tree support. A tree can have several roots,
 * one per repo folder; every path operation resolves against the root that
 * contains the target path.
 */

/** Index of the tree root containing `path`, or -1 when no root matches. */
export function rootIndexOf(roots: readonly TreeNode[], path: string): number {
  return roots.findIndex((root) => path === root.path || path.startsWith(`${root.path}/`));
}

/** Apply `update` to the root containing `path`; returns a copy (same contents) when unmatched. */
export function updateRoot(
  roots: readonly TreeNode[],
  path: string,
  update: (root: TreeNode) => TreeNode,
): TreeNode[] {
  const index = rootIndexOf(roots, path);
  const next = [...roots];
  if (index >= 0) next[index] = update(roots[index]);
  return next;
}

/** Find a node by absolute path across all roots. */
export function findNodeIn(roots: readonly TreeNode[], path: string): TreeNode | undefined {
  for (const root of roots) {
    const node = findNode(root, path);
    if (node) return node;
  }
  return undefined;
}

/**
 * Display path for a search hit: relative inside the repo, prefixed with the
 * repo basename when the tree shows multiple roots (both repos may contain
 * e.g. `src/`, so the repo name disambiguates).
 */
export function displayHitPath(path: string, root: string, multiRoot: boolean): string {
  if (!path.startsWith(`${root}/`)) return path; // outside the root: show as-is
  const rel = path.slice(root.length + 1);
  if (!multiRoot) return rel;
  const base = root.split("/").pop() || root;
  return `${base}/${rel}`;
}
