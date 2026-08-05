import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitService } from "../electron/main/services/git-service";

function run(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

describe("GitService", () => {
  let repo: string;
  let service: GitService;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "e-pi-git-test-"));
    run(repo, "init", "-q", "-b", "main");
    run(repo, "config", "user.email", "test@test.co");
    run(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "a.txt"), "one\n");
    run(repo, "add", "a.txt");
    run(repo, "commit", "-qm", "init");
    service = new GitService();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports a clean repo", async () => {
    const status = await service.status(repo);
    expect(status.branch).toBe("main");
    expect(status.files).toEqual([]);
    expect(status.stagedCount).toBe(0);
  });

  it("parses mixed staged/unstaged/untracked states", async () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n"); // unstaged modification
    writeFileSync(join(repo, "b.txt"), "bee\n");
    run(repo, "add", "b.txt"); // staged new file
    writeFileSync(join(repo, "new.txt"), "new\n"); // untracked

    const status = await service.status(repo);
    expect(status.files).toHaveLength(3);
    const byPath = new Map(status.files.map((file) => [file.workPath, file]));
    expect(byPath.get("a.txt")).toMatchObject({ staged: false, untracked: false, status: " M" });
    expect(byPath.get("b.txt")).toMatchObject({ staged: true, untracked: false, status: "A " });
    expect(byPath.get("new.txt")).toMatchObject({ staged: false, untracked: true, status: "??" });
    expect(status.stagedCount).toBe(1);
    expect(status.unstagedCount).toBe(1);
    expect(status.untrackedCount).toBe(1);
  });

  it("expands untracked directories into files", async () => {
    mkdirSync(join(repo, "dir with space"), { recursive: true });
    writeFileSync(join(repo, "dir with space", "c.txt"), "c\n");
    const status = await service.status(repo);
    expect(status.files.map((file) => file.workPath)).toEqual(["dir with space/c.txt"]);
    expect(status.untrackedCount).toBe(1);

    const diff = await service.diff(repo, "dir with space/c.txt");
    expect(diff.diff).toContain("+c");
  });

  it("detects renames and keeps the new path for operations", async () => {
    run(repo, "mv", "a.txt", "renamed.txt");
    const status = await service.status(repo);
    expect(status.files).toHaveLength(1);
    expect(status.files[0]!.staged).toBe(true);
    expect(status.files[0]!.workPath).toBe("renamed.txt");
    expect(status.files[0]!.path).toBe("a.txt -> renamed.txt");
  });

  it("returns a diff for modified and untracked files", async () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "new.txt"), "hello\n");

    const modified = await service.diff(repo, "a.txt");
    expect(modified.diff).toContain("+two");

    const untracked = await service.diff(repo, "new.txt");
    expect(untracked.diff).toContain("+hello");
  });

  it("stages and unstages files", async () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    let result = await service.stage(repo, ["a.txt"]);
    expect(result.ok).toBe(true);
    expect((await service.status(repo)).files[0]!.staged).toBe(true);

    result = await service.unstage(repo, ["a.txt"]);
    expect(result.ok).toBe(true);
    expect((await service.status(repo)).files[0]!.staged).toBe(false);
  });

  it("stages everything when given no paths", async () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "new.txt"), "hello\n");
    const result = await service.stage(repo, []);
    expect(result.ok).toBe(true);
    const status = await service.status(repo);
    expect(status.files).toHaveLength(2);
    expect(status.files.every((file) => file.staged)).toBe(true);
  });

  it("commits a multi-line message", async () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    await service.stage(repo, ["a.txt"]);
    const result = await service.commit(repo, "feat: add two\n\n- second line\n");
    expect(result.ok).toBe(true);
    expect(run(repo, "log", "-1", "--format=%s")).toBe("feat: add two");
    expect(await service.status(repo)).toMatchObject({ files: [] });
  });

  it("rejects an empty commit message", async () => {
    const result = await service.commit(repo, "   ");
    expect(result.ok).toBe(false);
  });

  it("pushes to a remote and sets upstream on first push", async () => {
    const remote = mkdtempSync(join(tmpdir(), "e-pi-git-remote-"));
    try {
      execFileSync("git", ["init", "-q", "--bare", remote], { encoding: "utf8" });
      run(repo, "remote", "add", "origin", remote);
      writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
      await service.stage(repo, []);
      await service.commit(repo, "feat: two");

      const first = await service.push(repo);
      expect(first.ok).toBe(true);
      const status = await service.status(repo);
      expect(status.upstream).toBe("origin/main");

      const second = await service.push(repo);
      expect(second.ok).toBe(true);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("fails outside a git repository", async () => {
    await expect(service.status("/")).rejects.toThrow("Not a git repository");
  });
});
