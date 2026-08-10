import { randomUUID } from "node:crypto";

import type { IPty } from "node-pty";
import * as pty from "node-pty";

import { debugLog } from "./debug-log";
import { isInteractiveForeground } from "./side-terminal-interactive";

interface SideTerminal {
  pty: IPty;
  cwd: string;
  /** Shell binary this pty was spawned with (used for foreground detection). */
  shell: string;
}

interface SideTerminalStatus {
  cwd: string;
  foregroundProcess: string;
  interactive: boolean;
}

/**
 * Sidebar terminals: one independent shell per panel instance, kept alive
 * until the panel view closes (or the app quits). Output is forwarded to the
 * renderer via a data listener; input flows back through write().
 */
export class SideTerminalService {
  readonly #terminals = new Map<string, SideTerminal>();
  #listener: ((id: string, data: string) => void) | undefined;

  onData(listener: (id: string, data: string) => void): void {
    this.#listener = listener;
  }

  getStatus(id: string): SideTerminalStatus | undefined {
    const terminal = this.#terminals.get(id);
    if (!terminal) return undefined;
    // pty.process resolves the FOREGROUND process group of the terminal
    // (tcgetpgrp → p_comm on macOS, /proc/<pgrp>/cmdline on Linux), so while a
    // program like vim/ssh owns the tty this reports its name. Only known
    // keystroke-driven programs flip the renderer into raw-input mode — a
    // long-running plain command (sleep, a build) must not.
    const processName = terminal.pty.process.trim();
    const interactive = isInteractiveForeground(processName);
    const foregroundProcess = processName.split(/[\\/]/).pop()?.replace(/^-+/, "").trim() || processName;
    return { cwd: terminal.cwd, foregroundProcess, interactive };
  }

  spawn(cwd: string): string {
    const id = randomUUID();
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    const terminal = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: cwd || process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" },
    });
    terminal.onData((data) => {
      this.#listener?.(id, data);
    });
    terminal.onExit(({ exitCode }) => {
      debugLog("[side-terminal] exit", { id, exitCode });
      this.#terminals.delete(id);
    });
    this.#terminals.set(id, { pty: terminal, cwd, shell });
    debugLog("[side-terminal] spawned", { id, cwd });
    return id;
  }

  write(id: string, data: string): void {
    this.#terminals.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.#terminals.get(id);
    if (!terminal) return;
    try {
      terminal.pty.resize(cols, rows);
    } catch {
      // Terminal may already be gone.
    }
  }

  kill(id: string): void {
    const terminal = this.#terminals.get(id);
    if (!terminal) return;
    try {
      terminal.pty.kill();
    } catch {
      // Already dead.
    }
    this.#terminals.delete(id);
  }

  killAll(): void {
    for (const id of [...this.#terminals.keys()]) this.kill(id);
  }
}
