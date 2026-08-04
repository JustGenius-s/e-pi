import { app } from "electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import type { PiRuntimeState, ResizeTerminalRequest } from "../../../src/types/contracts";
import { debugLog } from "./debug-log";

type DataListener = (data: string) => void;
type StateListener = (state: PiRuntimeState) => void;

function resolvePiEntry(): string {
  const indexPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return join(dirname(indexPath), "cli.js");
}

function resolveBridgePath(): string {
  const packagedPath = join(process.resourcesPath, "e-pi-bridge.ts");
  if (app.isPackaged && existsSync(packagedPath)) return packagedPath;
  return join(app.getAppPath(), "resources", "e-pi-bridge.ts");
}

function copyState(state: PiRuntimeState): PiRuntimeState {
  return { ...state };
}

interface StartRequest {
  sessionPath: string;
  cwd: string;
}

export class PiRuntime {
  #process: IPty | undefined;
  #state: PiRuntimeState = { status: "idle" };
  #dataListeners = new Set<DataListener>();
  #stateListeners = new Set<StateListener>();
  #stopPromise: Promise<void> | undefined;
  #resolveStop: (() => void) | undefined;
  /**
   * Serializes start() calls. Rapid session switches must never interleave:
   * two concurrent starts would both stop the same old process, spawn two pi
   * processes, and leave #process pointing at the wrong one — later prompts
   * would then be written into the wrong session file.
   */
  #startChain: Promise<void> = Promise.resolve();
  #latestStart: StartRequest | undefined;
  /** Processes whose shutdown has been initiated; their trailing output must not reach the terminal. */
  #dying = new WeakSet<IPty>();

  get state(): PiRuntimeState {
    return copyState(this.#state);
  }

  onData(listener: DataListener): () => void {
    this.#dataListeners.add(listener);
    return () => this.#dataListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.#stateListeners.add(listener);
    listener(this.state);
    return () => this.#stateListeners.delete(listener);
  }

  async start(sessionPath: string, cwd: string): Promise<void> {
    debugLog("[runtime] start() begin", { sessionPath, cwd });
    this.#latestStart = { sessionPath, cwd };
    const requested = this.#latestStart;
    const run = this.#startChain.then(async () => {
      // A newer start() was requested while we were queued; it will take over.
      if (this.#latestStart !== requested) {
        debugLog("[runtime] start() SUPERSEDED while queued", { sessionPath });
        return;
      }
      await this.stop();
      // A newer start() arrived while we waited for the old process to exit.
      if (this.#latestStart !== requested) {
        debugLog("[runtime] start() SUPERSEDED after stop", { sessionPath });
        return;
      }
      await this.#launch(requested.sessionPath, requested.cwd);
    });
    this.#startChain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
    debugLog("[runtime] start() done", { sessionPath });
  }

  async #launch(sessionPath: string, cwd: string): Promise<void> {
    debugLog("[runtime] #launch begin", { sessionPath, cwd });
    this.#setState({ status: "starting", sessionPath, cwd });

    try {
      const customNodeBinary = process.env.PI_NODE_BINARY?.trim();
      const nodeBinary = customNodeBinary || process.execPath;
      const args = [resolvePiEntry(), "--session", sessionPath, "--extension", resolveBridgePath()];
      debugLog("[runtime] spawning pi", { args, cwd });

      const child = spawn(nodeBinary, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 36,
        cwd,
        env: {
          ...process.env,
          ...(customNodeBinary ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          E_PI: "true",
        },
      });

      this.#process = child;
      this.#stopPromise = new Promise<void>((resolve) => {
        this.#resolveStop = resolve;
      });
      child.onData((data) => {
        // Stale/dying processes must not paint into the terminal of the
        // session that replaced them (e.g. pi prints a "To resume this
        // session" farewell on Ctrl-D which would otherwise show up, or a
        // large session is still streaming its initial render).
        if (this.#dying.has(child) || this.#process !== child) return;
        for (const listener of this.#dataListeners) listener(data);
      });
      child.onExit(({ exitCode, signal }) => {
        // A superseded process must not clobber the state of the current one.
        if (this.#process !== child) {
          debugLog("[runtime] onExit IGNORED (stale process)", { pid: child.pid, exitCode });
          return;
        }
        debugLog("[runtime] onExit", {
          pid: child.pid,
          exitCode,
          signal,
          status: this.#state.status,
        });
        this.#process = undefined;
        const wasStopping = this.#state.status === "stopping";
        this.#setState({
          ...this.#state,
          status: "exited",
          pid: undefined,
          exitCode,
          signal,
          error: wasStopping
            ? undefined
            : exitCode === 0
              ? undefined
              : `Pi exited with code ${exitCode}.`,
        });
        this.#resolveStop?.();
        this.#resolveStop = undefined;
        this.#stopPromise = undefined;
      });

      this.#setState({ status: "running", sessionPath, cwd, pid: child.pid });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog("[runtime] #launch FAILED", { sessionPath, message });
      this.#setState({ status: "error", sessionPath, cwd, error: message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (!child) {
      debugLog("[runtime] stop() no process");
      return;
    }
    debugLog("[runtime] stop() begin", { pid: child.pid, status: this.#state.status });
    if (this.#state.status !== "stopping") {
      this.#setState({ ...this.#state, status: "stopping" });
      this.#dying.add(child);
      debugLog("[runtime] stop() sending Ctrl-D", { pid: child.pid });
      child.write("\x04");
      setTimeout(() => {
        if (this.#process === child) {
          debugLog("[runtime] stop() kill fallback", { pid: child.pid });
          child.kill();
        }
      }, 1_500).unref();
    }
    await this.#stopPromise;
    debugLog("[runtime] stop() done");
  }

  write(data: string): void {
    if (this.#state.status !== "running") {
      debugLog("[runtime] write DROPPED (not running)", {
        status: this.#state.status,
        len: data.length,
      });
      return;
    }
    this.#process?.write(data);
  }

  submit(text: string): void {
    if (this.#state.status !== "running") {
      debugLog("[runtime] submit REJECTED (not running)", {
        status: this.#state.status,
        text: text.slice(0, 60),
      });
      throw new Error(`Pi is not ready (${this.#state.status}).`);
    }
    const normalized = text.replace(/\r\n/g, "\n");
    if (!normalized.trim()) return;
    debugLog("[runtime] submit", { pid: this.#process?.pid, text: normalized.slice(0, 60) });
    this.#process?.write(`\x1b[200~${normalized}\x1b[201~\r`);
  }

  interrupt(): void {
    if (this.#state.status !== "running") return;
    this.#process?.write("\x1b");
  }

  resize({ cols, rows }: ResizeTerminalRequest): void {
    if (!this.#process) return;
    this.#process.resize(Math.max(20, Math.floor(cols)), Math.max(8, Math.floor(rows)));
  }

  #setState(next: PiRuntimeState): void {
    this.#state = next;
    debugLog("[runtime] state", {
      status: next.status,
      sessionPath: next.sessionPath,
      pid: next.pid,
      cwd: next.cwd,
    });
    const snapshot = this.state;
    for (const listener of this.#stateListeners) listener(snapshot);
  }
}
