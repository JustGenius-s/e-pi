import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { net } from "electron";

import type { PiUpdateInfo } from "../../../src/types/contracts";

const REGISTRY_URL = "https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest";
const CHECK_TIMEOUT_MS = 10_000;
/** How long a successful check is kept before hitting the registry again. */
const CACHE_TTL_MS = 10 * 60 * 1000;

let cached: { at: number; latest: string | undefined } | undefined;

/** Compare dotted version strings; missing segments count as zero. */
function versionGt(a: string, b: string): boolean {
  const pa = a.split(".").map((part) => parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * Check the npm registry for the newest pi release. Cached briefly; failures
 * keep the previous result (or report no update) instead of throwing.
 */
export async function checkPiUpdate(): Promise<PiUpdateInfo> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return { current: PI_VERSION, latest: cached.latest };
  }
  try {
    const response = await net.fetch(REGISTRY_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`registry responded ${response.status}`);
    const data = (await response.json()) as { version?: string };
    const latest = typeof data.version === "string" && versionGt(data.version, PI_VERSION) ? data.version : undefined;
    cached = { at: now, latest };
  } catch {
    if (!cached) cached = { at: now, latest: undefined };
  }
  return { current: PI_VERSION, latest: cached.latest };
}
