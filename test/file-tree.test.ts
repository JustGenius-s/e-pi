import { describe, expect, it } from "vitest";

import {
  displayHitPath,
  expandPath,
  findNodeIn,
  refreshDirChildren,
  rootIndexOf,
  treeNode,
  updateRoot,
  type TreeNode,
} from "../src/lib/file-tree";

const REPO_A = "/work/repo-a";
const REPO_B = "/work/repo-b";

function dirNode(path: string, children: TreeNode[] = []): TreeNode {
  return { name: path.split("/").pop()!, path, type: "dir", children };
}

function fileNode(path: string): TreeNode {
  return { name: path.split("/").pop()!, path, type: "file", size: 1 };
}

function roots(): TreeNode[] {
  return [
    dirNode(REPO_A, [fileNode(`${REPO_A}/README.md`), dirNode(`${REPO_A}/src`, [fileNode(`${REPO_A}/src/main.ts`)])]),
    dirNode(REPO_B, [fileNode(`${REPO_B}/package.json`)]),
  ];
}

describe("rootIndexOf", () => {
  it("finds the root by exact path or prefix", () => {
    const tree = roots();
    expect(rootIndexOf(tree, REPO_A)).toBe(0);
    expect(rootIndexOf(tree, `${REPO_A}/src/main.ts`)).toBe(0);
    expect(rootIndexOf(tree, `${REPO_B}/package.json`)).toBe(1);
  });

  it("does not match a sibling with a shared prefix", () => {
    const tree = [dirNode("/work/repo-a"), dirNode("/work/repo-abc")];
    expect(rootIndexOf(tree, "/work/repo-abc/x.ts")).toBe(1);
    expect(rootIndexOf(tree, "/work/repo-a/x.ts")).toBe(0);
  });

  it("returns -1 for paths outside every root", () => {
    expect(rootIndexOf(roots(), "/elsewhere/file.ts")).toBe(-1);
  });
});

describe("updateRoot", () => {
  it("applies the update to the root containing the path only", () => {
    const tree = roots();
    const next = updateRoot(tree, `${REPO_B}/package.json`, (root) => ({ ...root, name: "renamed" }));
    expect(next[0]).toBe(tree[0]); // repo-a untouched (same reference)
    expect(next[1].name).toBe("renamed");
    expect(next[1].children).toEqual(tree[1].children);
  });

  it("returns a copy unchanged when the path matches no root", () => {
    const tree = roots();
    const next = updateRoot(tree, "/elsewhere/x", (root) => ({ ...root, name: "nope" }));
    expect(next).toEqual(tree);
  });
});

describe("findNodeIn", () => {
  it("finds nodes across roots", () => {
    const tree = roots();
    expect(findNodeIn(tree, `${REPO_B}/package.json`)?.name).toBe("package.json");
    expect(findNodeIn(tree, `${REPO_A}/src/main.ts`)?.name).toBe("main.ts");
  });

  it("returns undefined for missing paths", () => {
    expect(findNodeIn(roots(), `${REPO_B}/nope.ts`)).toBeUndefined();
  });
});

describe("expandPath across roots", () => {
  it("expands a path inside one root without touching the other", () => {
    const tree = roots();
    const next = updateRoot(tree, `${REPO_B}/package.json`, (root) =>
      expandPath(root, `${REPO_B}/package.json`, true)!,
    );
    // repo-a tree unchanged (deep equal), repo-b now expanded
    expect(next[0]).toEqual(tree[0]);
    expect(findNodeIn(next, `${REPO_B}/package.json`)?.expanded).toBe(true);
  });
});

describe("refreshDirChildren across roots", () => {
  it("replaces children within the matching root only", () => {
    const tree = roots();
    const fresh = [fileNode(`${REPO_A}/NEW.md`)];
    const next = updateRoot(tree, `${REPO_A}/src`, (root) =>
      refreshDirChildren(root, `${REPO_A}/src`, fresh)!,
    );
    const srcA = findNodeIn(next, `${REPO_A}/src`);
    expect(srcA?.children?.map((child) => child.path)).toEqual([`${REPO_A}/NEW.md`]);
    expect(findNodeIn(next, `${REPO_B}/package.json`)).toBeDefined(); // repo-b intact
  });
});

describe("displayHitPath", () => {
  it("shows a bare relative path for a single-root tree", () => {
    expect(displayHitPath(`${REPO_A}/src/main.ts`, REPO_A, false)).toBe("src/main.ts");
  });

  it("prefixes the repo basename in a multi-root tree", () => {
    expect(displayHitPath(`${REPO_A}/src/main.ts`, REPO_A, true)).toBe("repo-a/src/main.ts");
  });

  it("falls back to the full path when outside the root", () => {
    expect(displayHitPath("/elsewhere/x.ts", REPO_A, true)).toBe("/elsewhere/x.ts");
  });
});

describe("treeNode", () => {
  it("copies FileEntry fields into a TreeNode", () => {
    const node = treeNode({ name: "a.ts", path: "/x/a.ts", type: "file", size: 42 });
    expect(node).toMatchObject({ name: "a.ts", path: "/x/a.ts", type: "file", size: 42 });
  });
});
