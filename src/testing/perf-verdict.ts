/**
 * The perf gates' verdict helpers (release-gate hardening).
 *
 * WHY THIS MODULE EXISTS: the browser gate's budgets cannot be unit-tested in
 * jsdom (jsdom has no OfflineAudioContext), so the logic that DECIDES what a
 * measurement means lives here, pure and directly testable.
 * `src/browser-checks.ts` only wires it to the measurements.
 *
 * The problem these solve, in one line: on this repo the same code on the
 * same machine measured 4.05× apart in absolute time, so a gate that reads
 * milliseconds measures the weather — and a gate that reads a RATIO needs to
 * know whether the machine MOVED while it measured.
 */

/**
 * The bracket's own answer to "did the machine change while this workload ran?"
 *
 * `readings` are repeated measurements of the SAME workload — the single-track
 * baseline — taken around it. Their spread is the machine's instability
 * measured IN THE FORM OF THE WORKLOAD THE GATE ARBITRATES, which is the only
 * form that can answer for it: a foreign pure-JS spin runs on the harness
 * thread while the render path runs in the offline context and on the audio
 * thread, so it reports on a different subsystem and can call a measurable
 * render path unmeasurable (or the reverse).
 *
 * Measured on this repo: the same tree's single-track baseline moved 2268 ms
 * → 9133 ms (4.03×) BETWEEN RUNS. Inside one run the spread is far smaller —
 * 1.01× and 1.16× in the one run that carries both brackets — which is why
 * the verdict is built on the spread, not on the absolute cost.
 */
export function bracketSpread(readings: number[]): number {
  const max = Math.max(...readings);
  const min = Math.min(...readings);
  return max / Math.max(1, min);
}

/** What a measurement can be held to, once the machine's movement is known. */
export type DriftVerdict = {
  /** `pass` — even the least favourable reading is under the budget. */
  verdict: "pass" | "fail" | "informational";
  /** The most favourable reading of the same measurement. */
  best: number;
  /** The least favourable reading of the same measurement. */
  worst: number;
};

/**
 * A verdict a measurement can carry when the machine moved while it ran.
 *
 * The measurement is one number; the machine's own movement multiplies it by
 * at most `spread` in either direction, because the workload could have run
 * during the fast part of the window or the slow one. So the reading lives in
 * [measured / spread, measured × spread], and the budget is compared against
 * that BAND, not against the point estimate:
 *
 *   - the whole band under the budget → PASS, and the PASS is robust: even the
 *     least favourable reading of the same measurement passes.
 *   - the whole band over the budget  → FAIL, and the FAIL is robust: even the
 *     most favourable reading fails.
 *   - the budget cuts through the band → the machine's movement alone
 *     explains the difference. The number is REPORTED, not gated: a verdict
 *     nobody can act on must not be dressed up as one.
 */
export function driftAwareVerdict(measured: number, spread: number, budget: number): DriftVerdict {
  const band = Math.max(1, spread);
  const best = measured / band;
  const worst = measured * band;
  if (worst < budget) return { verdict: "pass", best, worst };
  if (best >= budget) return { verdict: "fail", best, worst };
  return { verdict: "informational", best, worst };
}

/**
 * The mean of the k heaviest samples.
 *
 * The single heaviest sample is a per-ITEM extreme, and per-item numbers on
 * this repo move by up to 2.6× between adjacent runs (the same template
 * measured 6642 ms and 17460 ms) — so a gate built on that one number fails
 * on noise. Measured over the 11 template sets in docs/audits (2026-10-29,
 * 2026-10-30): with ONE template 2.6× slower, "heaviest / average" lands in
 * 3.45×-4.91× — over the 3× budget in EVERY set, a false red every time —
 * while "mean of the three heaviest / average" lands in 1.99×-2.54×, under
 * the budget in every set. Without any burst its band is 1.51×-1.98×, tighter
 * than the single heaviest one's 1.57×-2.41×.
 *
 * Three is the smallest k that survives the burst in every measured set, and
 * it keeps the gate's teeth: a structural regression moves the heavy tail as
 * a group, not one sample.
 */
export function topKMean(times: number[], k: number): number {
  const sorted = [...times].sort((a, b) => b - a);
  const top = sorted.slice(0, Math.min(k, sorted.length));
  return top.reduce((a, b) => a + b, 0) / Math.max(1, top.length);
}
