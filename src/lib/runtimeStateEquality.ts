import type { PiRuntimeState } from "../types/contracts";

/**
 * Shallow structural equality for `PiRuntimeState` updates pushed from the
 * main process. The sidecar watch re-emits state on every poll even when the
 * values did not change; replacing the state object unconditionally would
 * re-render the whole App tree (Composer, SessionSidebar, ...) on every
 * poll. Bailing out here keeps the object identity stable so memoized
 * components skip re-rendering.
 *
 * Deliberately field-by-field, never JSON.stringify: stringify allocates
 * and its key ordering is not guaranteed to be stable.
 */
export function isSameRuntimeState(a: PiRuntimeState, b: PiRuntimeState): boolean {
  return (
    a.status === b.status &&
    a.sessionPath === b.sessionPath &&
    a.cwd === b.cwd &&
    a.generation === b.generation &&
    a.activity === b.activity &&
    sameWaitingUser(a.waitingUser, b.waitingUser) &&
    sameModelRef(a.model, b.model) &&
    a.thinkingLevel === b.thinkingLevel &&
    sameStringArray(a.supportedThinkingLevels, b.supportedThinkingLevels) &&
    sameContextUsage(a.context, b.context) &&
    sameSessionUsage(a.usage, b.usage) &&
    a.cacheHitRate === b.cacheHitRate &&
    a.speed === b.speed &&
    a.pid === b.pid &&
    a.exitCode === b.exitCode &&
    a.signal === b.signal &&
    a.error === b.error
  );
}

function sameWaitingUser(a: PiRuntimeState["waitingUser"], b: PiRuntimeState["waitingUser"]): boolean {
  if (a === b) return true;
  // `undefined` (never waited) and `null` (waited, then cleared) are
  // semantically different even though both are falsy.
  if (a == null || b == null) return false;
  return a.kind === b.kind && a.detail === b.detail;
}

function sameModelRef(a: PiRuntimeState["model"], b: PiRuntimeState["model"]): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return a.provider === b.provider && a.id === b.id;
}

function sameStringArray(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameContextUsage(a: PiRuntimeState["context"], b: PiRuntimeState["context"]): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return a.tokens === b.tokens && a.contextWindow === b.contextWindow && a.percent === b.percent;
}

function sameSessionUsage(a: PiRuntimeState["usage"], b: PiRuntimeState["usage"]): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.cost === b.cost
  );
}
