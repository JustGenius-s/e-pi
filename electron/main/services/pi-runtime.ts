import { existsSync, rmSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app } from "electron";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";

import type {
  ContextUsageState,
  ModelRef,
  PiActivityStatus,
  PiRuntimeState,
  ResizeTerminalRequest,
  SessionUsageState,
} from "../../../src/types/contracts";
import { debugLog } from "./debug-log";

type StateListener = (state: PiRuntimeState) => void;
type GlobalDataListener = (sessionPath: string, data: string) => void;

/** Matches the suffix the bridge extension writes next to each session file. */
const ACTIVITY_SUFFIX = ".e-pi-activity.json";
const READY_TIMEOUT_MS = 30_000;

function resolvePiEntry(): string {
  const indexPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return join(dirname(indexPath), "cli.js");
}

function resolveBridgePath(): string {
  const packagedPath = join(process.resourcesPath, "e-pi-bridge.ts");
  if (app.isPackaged && existsSync(packagedPath)) return packagedPath;
  return join(app.getAppPath(), "resources", "e-pi-bridge.ts");
}

/**
 * The binary that runs each session's pi process. Defaults to the bundled
 * sidecar Node (`resources/node/bin/node`) — a plain Node binary with no
 * app-bundle association. Spawning the Electron main binary
 * (`process.execPath`) instead makes macOS treat the child as an app-shaped
 * process it cannot register properly, so every new session pops a stray
 * generic "exec" icon in the Dock. `PI_NODE_BINARY` overrides the choice;
 * falls back to `process.execPath` when no Node sidecar is present.
 */
function resolveNodeBinary(): string {
  const custom = process.env.PI_NODE_BINARY?.trim();
  if (custom) return custom;
  const candidates = [
    // Packaged: E-Pi.app/Contents/Resources/node/bin/node
    join(process.resourcesPath, "node", "bin", "node"),
    // Dev: <repo>/resources/node/bin/node
    join(app.getAppPath(), "resources", "node", "bin", "node"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

function copyState(state: PiRuntimeState): PiRuntimeState {
  return { ...state };
}

/**
 * One live pi process, bound to one session file. Sessions are fully
 * independent: switching the visible session never stops another session's
 * process, so agent runs continue in the background.
 */
interface Instance {
  sessionPath: string;
  cwd: string;
  generation: number;
  state: PiRuntimeState;
  process?: IPty;
  stopPromise?: Promise<void>;
  resolveStop?: (() => void) | undefined;
  /** Shutdown initiated; trailing output of the dying process must not reach the terminal. */
  dying: boolean;
  /** Watches the bridge's activity sidecar while the process is alive. */
  watchActivity?: FSWatcher;
}

/**
 * Pool of per-session pi processes. `start(sessionPath)` lazily spawns (or
 * reuses) the process for that session and never touches any other session,
 * so multiple sessions can run concurrently.
 */
export class PiRuntime {
  #instances = new Map<string, Instance>();
  #stateListeners = new Set<StateListener>();
  #globalDataListeners = new Set<GlobalDataListener>();
  #activeSessionPath: string | undefined;
  /** Serializes lifecycle operations (start/stop) per session. */
  #chains = new Map<string, Promise<void>>();

  get activeSessionPath(): string | undefined {
    return this.#activeSessionPath;
  }

  getStates(): Record<string, PiRuntimeState> {
    const result: Record<string, PiRuntimeState> = {};
    for (const instance of this.#instances.values()) {
      result[instance.sessionPath] = copyState(instance.state);
    }
    return result;
  }

  isRunning(sessionPath: string): boolean {
    const instance = this.#instances.get(sessionPath);
    return (
      instance !== undefined &&
      instance.process !== undefined &&
      (instance.state.status === "running" || instance.state.status === "starting")
    );
  }

  onState(listener: StateListener): () => void {
    this.#stateListeners.add(listener);
    for (const instance of this.#instances.values()) listener(copyState(instance.state));
    return () => this.#stateListeners.delete(listener);
  }

  /** Restore which session is considered active (e.g. after background ops). */
  setActiveSession(sessionPath: string | undefined): void {
    this.#activeSessionPath = sessionPath;
  }

  /** Forward every session's output to a single listener (used to bridge IPC). */
  onGlobalData(listener: GlobalDataListener): () => void {
    this.#globalDataListeners.add(listener);
    return () => this.#globalDataListeners.delete(listener);
  }

  async start(sessionPath: string, cwd: string): Promise<void> {
    debugLog("[runtime] start() begin", { sessionPath, cwd });
    this.#activeSessionPath = sessionPath;
    await this.#chain(sessionPath, () => this.#ensureRunning(sessionPath, cwd));
    debugLog("[runtime] start() done", { sessionPath });
  }

  /** Stop one session's process, or all sessions when `sessionPath` is omitted. */
  async stop(sessionPath?: string): Promise<void> {
    if (sessionPath) {
      await this.#chain(sessionPath, async () => {
        const instance = this.#instances.get(sessionPath);
        if (!instance) return;
        if (this.#activeSessionPath === sessionPath) this.#activeSessionPath = undefined;
        await this.#stopInstance(instance);
      });
      return;
    }
    await Promise.all([...this.#instances.keys()].map((path) => this.stop(path)));
  }

  /** Forget a session entirely (e.g. after it was archived). */
  forget(sessionPath: string): void {
    if (!this.#instances.delete(sessionPath)) return;
    if (this.#activeSessionPath === sessionPath) this.#activeSessionPath = undefined;
  }

  /** Stop and restart every live session (e.g. after auth/config changes). */
  async reloadAll(): Promise<void> {
    const active = this.#activeSessionPath;
    const live = [...this.#instances.values()].filter(
      (instance) =>
        instance.process !== undefined && (instance.state.status === "running" || instance.state.status === "starting"),
    );
    await Promise.all(live.map((instance) => this.stop(instance.sessionPath)));
    await Promise.all(live.map((instance) => this.start(instance.sessionPath, instance.cwd)));
    if (active) this.#activeSessionPath = active;
  }

  write(sessionPath: string, data: string): void {
    const instance = this.#instances.get(sessionPath);
    // Interactive prompts (e.g. the project-trust selector) appear while the
    // runtime is still "starting" — before the bridge sidecar reports ready —
    // so forward input as soon as the pty process exists.
    if (
      !instance ||
      instance.process === undefined ||
      (instance.state.status !== "starting" && instance.state.status !== "running")
    ) {
      debugLog("[runtime] write DROPPED", {
        sessionPath,
        status: instance?.state.status,
        len: data.length,
      });
      return;
    }
    instance.process.write(data);
  }

  submit(sessionPath: string, text: string): void {
    const instance = this.#instances.get(sessionPath);
    if (!instance || instance.state.status !== "running") {
      debugLog("[runtime] submit REJECTED (not running)", {
        sessionPath,
        status: instance?.state.status,
        text: text.slice(0, 60),
      });
      throw new Error(`Pi is not ready (${instance?.state.status ?? "idle"}).`);
    }
    const normalized = text.replace(/\r\n/g, "\n");
    if (!normalized.trim()) return;
    debugLog("[runtime] submit", {
      sessionPath,
      pid: instance.process?.pid,
      text: normalized.slice(0, 60),
    });
    instance.process?.write(`\x1b[200~${normalized}\x1b[201~\r`);
  }

  interrupt(sessionPath: string): void {
    const instance = this.#instances.get(sessionPath);
    if (!instance || instance.process === undefined) return;
    if (instance.state.status !== "starting" && instance.state.status !== "running") return;
    instance.process.write("\x1b");
  }

  resize(sessionPath: string, { cols, rows }: ResizeTerminalRequest): void {
    const instance = this.#instances.get(sessionPath);
    if (!instance?.process) return;
    instance.process.resize(Math.max(20, Math.floor(cols)), Math.max(8, Math.floor(rows)));
  }

  #placeholder(sessionPath: string, cwd: string): Instance {
    return {
      sessionPath,
      cwd,
      generation: 0,
      state: { status: "idle", sessionPath, cwd, generation: 0 },
      dying: false,
    };
  }

  #chain(sessionPath: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#chains.get(sessionPath) ?? Promise.resolve();
    const run = previous.then(operation);
    this.#chains.set(
      sessionPath,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async #ensureRunning(sessionPath: string, cwd: string): Promise<void> {
    let instance = this.#instances.get(sessionPath);
    if (!instance) {
      instance = this.#placeholder(sessionPath, cwd);
      this.#instances.set(sessionPath, instance);
    }
    // A placeholder may not know the session's real cwd yet; the caller does.
    instance.cwd = cwd;
    if (
      instance.process !== undefined &&
      (instance.state.status === "running" ||
        instance.state.status === "starting" ||
        instance.state.status === "stopping")
    ) {
      // Already live, or winding down (a newer start queued behind this one
      // will relaunch after stop completes).
      return;
    }
    await this.#launch(instance);
  }

  async #launch(instance: Instance): Promise<void> {
    const { sessionPath, cwd } = instance;
    instance.generation += 1;
    const generation = instance.generation;
    this.#setState(instance, { status: "starting", sessionPath, cwd, generation });

    // Drop any stale activity sidecar from a previous run so a crashed
    // "busy" never bleeds into the fresh process.
    rmSync(join(dirname(sessionPath), `${basename(sessionPath)}${ACTIVITY_SUFFIX}`), {
      force: true,
    });

    try {
      const nodeBinary = resolveNodeBinary();
      const args = [resolvePiEntry(), "--session", sessionPath, "--extension", resolveBridgePath()];
      debugLog("[runtime] spawning pi", { nodeBinary, args, cwd, sessionPath });

      const child = spawn(nodeBinary, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 36,
        cwd,
        env: {
          ...process.env,
          // The Electron binary only runs as plain Node when this is set;
          // the bundled sidecar Node is already plain Node.
          ...(nodeBinary === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          E_PI: "true",
        },
      });

      instance.process = child;
      instance.stopPromise = new Promise<void>((resolve) => {
        instance.resolveStop = resolve;
      });
      child.onData((data) => {
        // A dying process must not paint into the terminal (e.g. pi prints a
        // "To resume this session" farewell on Ctrl-D).
        if (instance.dying) return;
        for (const listener of this.#globalDataListeners) listener(sessionPath, data);
      });
      child.onExit(({ exitCode, signal }) => {
        debugLog("[runtime] onExit", {
          sessionPath,
          pid: child.pid,
          exitCode,
          signal,
          status: instance.state.status,
        });
        instance.process = undefined;
        instance.watchActivity?.close();
        instance.watchActivity = undefined;
        const wasStopping = instance.state.status === "stopping";
        this.#setState(instance, {
          ...instance.state,
          status: "exited",
          cwd,
          pid: undefined,
          activity: undefined,
          exitCode,
          signal,
          error: wasStopping ? undefined : exitCode === 0 ? undefined : `Pi exited with code ${exitCode}.`,
        });
        instance.resolveStop?.();
        instance.resolveStop = undefined;
        instance.stopPromise = undefined;
      });

      this.#watchActivity(instance);
      await this.#waitUntilReady(instance, child);
      this.#setState(instance, {
        ...instance.state,
        status: "running",
        sessionPath,
        cwd,
        generation,
        pid: child.pid,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog("[runtime] #launch FAILED", { sessionPath, message });
      const child = instance.process;
      if (child) {
        instance.dying = true;
        child.kill();
        await instance.stopPromise;
        instance.dying = false;
      }
      this.#setState(instance, {
        status: "error",
        sessionPath,
        cwd,
        generation,
        error: message,
      });
      throw error;
    }
  }

  async #waitUntilReady(instance: Instance, child: IPty): Promise<void> {
    const activityPath = join(dirname(instance.sessionPath), `${basename(instance.sessionPath)}${ACTIVITY_SUFFIX}`);
    await new Promise<void>((resolve, reject) => {
      let reading = false;
      let timeout: NodeJS.Timeout | undefined;
      let stopOutput: { dispose: () => void } | undefined;
      const finish = (error?: Error): void => {
        stopOutput?.dispose();
        clearInterval(interval);
        if (timeout) clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const check = (): void => {
        if (instance.process !== child) {
          finish(new Error("Pi exited before its terminal was ready."));
          return;
        }
        if (reading) return;
        reading = true;
        void readFile(activityPath, "utf8")
          .then((raw) => {
            const status = (JSON.parse(raw) as { status?: unknown }).status;
            if (status === "busy" || status === "idle") finish();
          })
          .catch(() => undefined)
          .finally(() => {
            reading = false;
          });
      };
      const interval = setInterval(check, 25);
      // Re-arm the deadline on output: interactive prompts (e.g. the project
      // trust selector) render frames long before the bridge sidecar reports
      // ready, so a hard timeout would kill the process while the user is
      // still deciding.
      stopOutput = child.onData((data) => {
        if (data.length === 0) return;
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => finish(new Error("Pi terminal did not become ready in time.")), READY_TIMEOUT_MS);
      });
      timeout = setTimeout(() => finish(new Error("Pi terminal did not become ready in time.")), READY_TIMEOUT_MS);
      check();
    });
    debugLog("[runtime] terminal ready", { sessionPath: instance.sessionPath, pid: child.pid });
  }

  /**
   * Track the bridge's session-state sidecar (`<session>.e-pi-activity.json`).
   * It reports agent activity and the model currently selected by this process.
   */
  #watchActivity(instance: Instance): void {
    const activityName = `${basename(instance.sessionPath)}${ACTIVITY_SUFFIX}`;
    const activityPath = join(dirname(instance.sessionPath), activityName);
    let reading = false;
    const refresh = (): void => {
      if (reading) return;
      reading = true;
      void readFile(activityPath, "utf8")
        .then((raw) => {
          const parsed = JSON.parse(raw) as {
            status?: unknown;
            model?: { provider?: unknown; id?: unknown };
            context?: { tokens?: unknown; contextWindow?: unknown; percent?: unknown };
            usage?: {
              input?: unknown;
              output?: unknown;
              cacheRead?: unknown;
              cacheWrite?: unknown;
              cost?: unknown;
            };
            cacheHitRate?: unknown;
            speed?: unknown;
          };
          const activity =
            parsed.status === "busy" || parsed.status === "idle" ? (parsed.status as PiActivityStatus) : undefined;
          const model: ModelRef | undefined =
            typeof parsed.model?.provider === "string" && typeof parsed.model.id === "string"
              ? { provider: parsed.model.provider, id: parsed.model.id }
              : undefined;
          const context: ContextUsageState | undefined =
            typeof parsed.context?.contextWindow === "number"
              ? {
                  tokens: typeof parsed.context.tokens === "number" ? parsed.context.tokens : null,
                  contextWindow: parsed.context.contextWindow,
                  percent: typeof parsed.context.percent === "number" ? parsed.context.percent : null,
                }
              : undefined;
          const u = parsed.usage;
          const usage: SessionUsageState | undefined =
            u !== undefined &&
            typeof u.input === "number" &&
            typeof u.output === "number" &&
            typeof u.cacheRead === "number" &&
            typeof u.cacheWrite === "number" &&
            typeof u.cost === "number"
              ? {
                  input: u.input,
                  output: u.output,
                  cacheRead: u.cacheRead,
                  cacheWrite: u.cacheWrite,
                  cost: u.cost,
                }
              : undefined;
          const cacheHitRate = typeof parsed.cacheHitRate === "number" ? parsed.cacheHitRate : undefined;
          const speed = typeof parsed.speed === "number" && Number.isFinite(parsed.speed) ? parsed.speed : undefined;
          const signature = JSON.stringify({ activity, model, context, usage, cacheHitRate, speed });
          const previous = JSON.stringify({
            activity: instance.state.activity,
            model: instance.state.model,
            context: instance.state.context,
            usage: instance.state.usage,
            cacheHitRate: instance.state.cacheHitRate,
            speed: instance.state.speed,
          });
          if (signature !== previous) {
            // Keep the last known value when the sidecar lacks one (e.g. during
            // a mid-session rewrite) to avoid flicker in the renderer.
            this.#setState(instance, {
              ...instance.state,
              activity,
              model: model ?? instance.state.model,
              context: context ?? instance.state.context,
              usage: usage ?? instance.state.usage,
              cacheHitRate: cacheHitRate ?? instance.state.cacheHitRate,
              speed: speed ?? instance.state.speed,
            });
          }
        })
        .catch(() => {
          // Sidecar not written yet or already removed; keep the last value.
        })
        .finally(() => {
          reading = false;
        });
    };
    try {
      instance.watchActivity = watch(dirname(instance.sessionPath), (_event, filename) => {
        if (filename === null || String(filename) === activityName) refresh();
      });
      // The sidecar may already exist from a previous run of the same process;
      // pick up its current value immediately.
      refresh();
    } catch {
      // Directory watch unsupported; activity stays undefined (static dot).
    }
  }

  async #stopInstance(instance: Instance): Promise<void> {
    const child = instance.process;
    if (!child) {
      debugLog("[runtime] stop() no process", { sessionPath: instance.sessionPath });
      return;
    }
    debugLog("[runtime] stop() begin", {
      sessionPath: instance.sessionPath,
      pid: child.pid,
      status: instance.state.status,
    });
    if (instance.state.status !== "stopping") {
      this.#setState(instance, { ...instance.state, status: "stopping" });
      instance.dying = true;
      debugLog("[runtime] stop() sending Ctrl-D", { sessionPath: instance.sessionPath });
      child.write("\x04");
      setTimeout(() => {
        if (instance.process === child) {
          debugLog("[runtime] stop() kill fallback", { sessionPath: instance.sessionPath });
          child.kill();
        }
      }, 1_500).unref();
    }
    await instance.stopPromise;
    instance.dying = false;
    debugLog("[runtime] stop() done", { sessionPath: instance.sessionPath });
  }

  #setState(instance: Instance, next: PiRuntimeState): void {
    instance.state = next;
    debugLog("[runtime] state", {
      status: next.status,
      sessionPath: next.sessionPath,
      pid: next.pid,
      cwd: next.cwd,
      generation: next.generation,
    });
    const snapshot = copyState(next);
    for (const listener of this.#stateListeners) listener(snapshot);
  }
}
