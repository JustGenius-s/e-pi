import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

import type { IPty } from "node-pty";
import * as pty from "node-pty";

import { debugLog } from "./debug-log";
import { isInteractiveForeground } from "./side-terminal-interactive";

interface SideTerminal {
  pty: IPty;
  cwd: string;
  /** Shell binary this pty was spawned with (used for foreground detection). */
  shell: string;
  /** Slave device path (/dev/ttysNNN) resolved after spawn; stty -f target. */
  tty?: string;
  /**
   * True while the renderer's overlay editor owns line editing. The pty's
   * echo/icanon flags are kept in sync: the editor mode needs a raw-ish tty
   * (no kernel echo — the overlay paints the glyphs), interactive mode needs
   * the kernel's canonical line discipline back.
   */
  editorMode: boolean;
}

interface SideTerminalStatus {
  cwd: string;
  foregroundProcess: string;
  interactive: boolean;
}

/** Resolve a pty's slave tty path via its shell's controlling terminal. */
function resolveTtyFor(id: string, terminal: SideTerminal): void {
  execFile("/bin/ps", ["-o", "tty=", "-p", String(terminal.pty.pid)], (error, stdout) => {
    const tty = stdout.trim();
    if (!error && tty && tty !== "??" && !tty.includes(" ")) {
      terminal.tty = `/dev/${tty}`;
      debugLog("[side-terminal] tty resolved", { id, tty: terminal.tty });
    }
  });
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
    // pty.process becomes undefined once the shell exits; the 400ms status
    // poll can land in that window before the exit handler drops the record.
    const rawProcess = terminal.pty.process;
    if (!rawProcess) return undefined;
    const processName = rawProcess.trim();
    const interactive = isInteractiveForeground(processName);
    const foregroundProcess = processName.split(/[\\/]/).pop()?.replace(/^-+/, "").trim() || processName;
    return { cwd: terminal.cwd, foregroundProcess, interactive };
  }

  spawn(cwd: string): string {
    const id = randomUUID();
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    // Spawn as a LOGIN shell so the full PATH chain runs: /etc/zprofile
    // (path_helper) and ~/.zprofile (brew shellenv) are skipped by plain
    // interactive shells, so an Electron-launched app would otherwise give
    // .zshrc a PATH without /opt/homebrew/bin — fnm/nvm/… then break. This
    // matches how Terminal.app spawns shells. On Windows there is no login
    // concept; keep the bare invocation.
    const args = process.platform === "win32" ? [] : ["-l"];
    const terminal = pty.spawn(shell, args, {
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
    const record: SideTerminal = { pty: terminal, cwd, shell, editorMode: false };
    this.#terminals.set(id, record);
    // node-pty doesn't expose the slave device path; resolve it from the
    // spawned shell's controlling terminal so stty can target it with -f.
    resolveTtyFor(id, record);
    debugLog("[side-terminal] spawned", { id, cwd });
    return id;
  }

  /**
   * Toggle the pty between the overlay editor's raw mode and the kernel's
   * canonical line discipline. The overlay paints typed glyphs itself, so
   * the tty must not also echo them (double characters, phantom cursor
   * moves); interactive programs (vim, ssh, fzf) expect the kernel's cooked
   * mode back. Best-effort: stty runs against the pty's controlling
   * terminal, so it only applies while this process group is in the
   * foreground — a background pty keeps its previous flags.
   */
  setEditorMode(id: string, active: boolean): void {
    const terminal = this.#terminals.get(id);
    if (!terminal || terminal.editorMode === active) return;
    terminal.editorMode = active;
    if (process.platform === "win32") return;
    if (!terminal.tty) resolveTtyFor(id, terminal);
    const apply = () => {
      if (!terminal.tty) {
        debugLog("[side-terminal] stty skipped, no tty", { id, active });
        return;
      }
      const flags = active ? "-echo -icanon min 1 time 0" : "sane";
      execFile("/bin/stty", ["-f", terminal.tty, ...flags.split(" ")], (error) => {
        if (error) debugLog("[side-terminal] stty failed", { id, active, error: String(error) });
        else debugLog("[side-terminal] stty applied", { id, active, tty: terminal.tty });
      });
    };
    // The tty path resolves asynchronously after spawn; retry briefly so an
    // early setEditorMode(true) right after spawn still lands.
    if (!terminal.tty) {
      let attempts = 0;
      const retry = () => {
        if (terminal.tty || attempts >= 10 || !this.#terminals.has(id)) {
          apply();
          return;
        }
        attempts += 1;
        resolveTtyFor(id, terminal);
        setTimeout(retry, 100);
      };
      retry();
      return;
    }
    apply();
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
