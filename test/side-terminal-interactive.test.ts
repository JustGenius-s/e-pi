import { describe, expect, it } from "vitest";

import { foregroundBasename, isInteractiveForeground } from "../electron/main/services/side-terminal-interactive";

describe("foregroundBasename", () => {
  it("strips paths and login-shell dashes", () => {
    expect(foregroundBasename("/bin/zsh")).toBe("zsh");
    expect(foregroundBasename("-zsh")).toBe("zsh");
    expect(foregroundBasename("vim")).toBe("vim");
    expect(foregroundBasename("/usr/bin/python3.11")).toBe("python3.11");
    expect(foregroundBasename("")).toBe("");
  });

  it("is case-insensitive", () => {
    expect(foregroundBasename("VIM")).toBe("vim");
  });
});

describe("isInteractiveForeground", () => {
  it("flags keystroke-driven programs", () => {
    for (const name of ["vim", "nvim", "ssh", "top", "htop", "fzf", "less", "man", "sudo", "tmux", "lazygit"]) {
      expect(isInteractiveForeground(name)).toBe(true);
    }
  });

  it("flags REPLs and database consoles", () => {
    for (const name of ["python", "node", "irb", "psql", "mysql", "sqlite3", "redis-cli", "mongosh"]) {
      expect(isInteractiveForeground(name)).toBe(true);
    }
  });

  it("matches versioned binaries by stem", () => {
    expect(isInteractiveForeground("python3.11")).toBe(true);
    expect(isInteractiveForeground("lua5.4")).toBe(true);
    expect(isInteractiveForeground("node22")).toBe(true);
  });

  it("leaves plain commands and shells in line-edit mode", () => {
    // sleep/npm builds/sim: long-running but not keystroke-driven — the editor
    // must stay enabled and typed lines act as type-ahead stdin.
    for (const name of [
      "sleep",
      "npm",
      "node_modules",
      "git",
      "ls",
      "grep",
      "curl",
      "make",
      "zsh",
      "bash",
      "sh",
      "fish",
    ]) {
      expect(isInteractiveForeground(name)).toBe(false);
    }
    expect(isInteractiveForeground("")).toBe(false);
  });

  it("does not over-match stems", () => {
    // "tops" is not "top"; "pythonic" is not "python".
    expect(isInteractiveForeground("tops")).toBe(false);
    expect(isInteractiveForeground("pythonic")).toBe(false);
  });
});
