import { app } from "electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import type { PiRuntimeState, ResizeTerminalRequest } from "../../../src/types/contracts";

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

export class PiRuntime {
  #process: IPty | undefined;
  #state: PiRuntimeState = { status: "idle" };
  #dataListeners = new Set<DataListener>();
  #stateListeners = new Set<StateListener>();
  #stopPromise: Promise<void> | undefined;
  #resolveStop: (() => void) | undefined;

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
    await this.stop();
    this.#setState({ status: "starting", sessionPath, cwd });

    try {
      const customNodeBinary = process.env.PI_NODE_BINARY?.trim();
      const nodeBinary = customNodeBinary || process.execPath;
      const args = [resolvePiEntry(), "--session", sessionPath, "--extension", resolveBridgePath()];

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
        for (const listener of this.#dataListeners) listener(data);
      });
      child.onExit(({ exitCode, signal }) => {
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
      this.#setState({ status: "error", sessionPath, cwd, error: message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (!child) return;
    if (this.#state.status !== "stopping") {
      this.#setState({ ...this.#state, status: "stopping" });
      child.write("\x04");
      setTimeout(() => {
        if (this.#process === child) child.kill();
      }, 1_500).unref();
    }
    await this.#stopPromise;
  }

  write(data: string): void {
    this.#process?.write(data);
  }

  submit(text: string): void {
    if (!this.#process) throw new Error("No Pi session is running.");
    const normalized = text.replace(/\r\n/g, "\n");
    if (!normalized.trim()) return;
    this.#process.write(`\x1b[200~${normalized}\x1b[201~\r`);
  }

  interrupt(): void {
    this.#process?.write("\x1b");
  }

  resize({ cols, rows }: ResizeTerminalRequest): void {
    if (!this.#process) return;
    this.#process.resize(Math.max(20, Math.floor(cols)), Math.max(8, Math.floor(rows)));
  }

  #setState(next: PiRuntimeState): void {
    this.#state = next;
    const snapshot = this.state;
    for (const listener of this.#stateListeners) listener(snapshot);
  }
}
