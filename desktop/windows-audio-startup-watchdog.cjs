"use strict";

const DEFAULT_TIMEOUT_MS = 7_000;
const EXIT_GRACE_MS = 100;

function stageFromSnapshot(snapshot) {
  const endpoint = typeof snapshot?.startupEndpoint === "string" ? snapshot.startupEndpoint : "";
  const phase = typeof snapshot?.startupStage === "string" ? snapshot.startupStage : "unknown";
  return `${endpoint ? `${endpoint}/` : ""}${phase}`;
}

function isNativeStartupPending(current, active) {
  return Boolean(current) && current === active && current.starting === true && current.stopping !== true;
}

/**
 * Bound a native startup that may be stuck inside a driver call. The utility
 * process owns one session, so terminating it is the recovery boundary.
 */
function scheduleNativeStartupWatchdog({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sessionId,
  isActive = () => true,
  readSnapshot,
  reportStage,
  onTimeout,
  postError,
  terminate,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Native startup watchdog timeout must be a positive integer");
  if (typeof readSnapshot !== "function" || typeof postError !== "function" || typeof terminate !== "function")
    throw new Error("Native startup watchdog requires snapshot, error and termination callbacks");

  let timedOut = false;
  const timer = setTimeout(() => {
    if (!isActive()) return;
    timedOut = true;
    try {
      onTimeout?.();
    } catch {
      /* Preserve bounded process recovery when local state cannot be updated. */
    }
    let stage = "unknown";
    try {
      stage = stageFromSnapshot(readSnapshot());
    } catch {
      /* Preserve bounded process recovery when native status is unavailable. */
    }
    const message = `WASAPI startup exceeded ${timeoutMs} ms at ${stage}; retry to start a fresh audio host`;
    try {
      reportStage?.(`native-start-timeout:${stage}`);
    } catch {
      /* Diagnostics are best effort. */
    }
    try {
      postError({ type: "error", sessionId, message });
    } catch {
      /* The renderer may already have closed its PCM port. */
    }
    setTimeout(() => terminate(1), EXIT_GRACE_MS);
  }, timeoutMs);

  return () => {
    if (!timedOut) clearTimeout(timer);
  };
}

module.exports = { DEFAULT_TIMEOUT_MS, isNativeStartupPending, scheduleNativeStartupWatchdog };
