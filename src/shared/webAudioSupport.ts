/**
 * Boot-time Web Audio capability probe — the studio's one hard dependency.
 *
 * The AudioEngine cannot function without `AudioContext` (live playback) and
 * `OfflineAudioContext` (export/render), so a browser lacking either cannot
 * boot the studio at all. The static check here decides whether to boot;
 * environments that expose the globals but fail at construction (iOS Low
 * Power Mode blocks Web Audio at the OS level) are routed to the same
 * friendly screen by the boot-error filter in main.tsx.
 */

export interface WebAudioSupport {
  ok: boolean;
  /** Human-readable names of what is missing (for the guidance screen). */
  missing: string[];
}

export function detectWebAudioSupport(): WebAudioSupport {
  const missing: string[] = [];
  const scope = globalThis as Record<string, unknown>;
  if (typeof scope.AudioContext !== "function") missing.push("AudioContext");
  if (typeof scope.OfflineAudioContext !== "function") missing.push("OfflineAudioContext");
  return { ok: missing.length === 0, missing };
}

/** Classify a boot failure: did the engine die because Web Audio is blocked
 *  or missing (old browser, restricted mode, iOS Low Power Mode) rather than
 *  because of an app bug? Those get the guidance screen, not a stack trace. */
export function isWebAudioBootFailure(error: unknown): boolean {
  return /AudioContext|OfflineAudioContext|AudioWorklet|audio worklet/i.test(String(error));
}
