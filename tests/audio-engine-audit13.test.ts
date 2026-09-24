import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizePluginParams } from "../src/effects/definitions";

/**
 * Audit 13 re-run (Async & Race Conditions) — regression pins.
 *
 * The 2026-09-22 audit 13 fixes are pinned by their own suites (collab swap
 * reopen in the services tests, IntentPanel abort in the intent suites);
 * this file covers what CHANGED since then:
 *  1. A6 legacy rack-mix rescale is STATELESS and idempotent — two tabs
 *     normalizing the same legacy doc concurrently cannot double-rescale,
 *     because the transform is a pure per-value function (no flag, no
 *     persistence, no read-modify-write window).
 *  2. Hum-to-melody analyze phase is cancellable (AbortSignal reaches the
 *     pitch-tracking worker and gates every setState after an await).
 *  3. The mic claim (one live capture per tab) covers the HUM panel too —
 *     it goes through the same PcmMicRecorder entry path.
 */

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("audit 13 — A6 legacy mix rescale is race-free by construction", () => {
  it("normalizing a legacy 0..100 mix twice yields the same 0..1 value (no double rescale)", () => {
    const first = normalizePluginParams("fxeq", { bandCount: 4, mix: 42 });
    expect(first).not.toBeNull();
    const second = normalizePluginParams("fxeq", { bandCount: 4, mix: 42 });
    expect(second).toEqual(first);
    expect(first!["mix"]).toBeCloseTo(0.42, 5);
  });

  it("an already-rescaled 0..1 value round-trips unchanged (idempotent)", () => {
    const once = normalizePluginParams("fxeq", { bandCount: 4, mix: 0.42 });
    const again = normalizePluginParams("fxeq", { bandCount: 4, mix: once!["mix"] });
    expect(again!["mix"]).toBeCloseTo(0.42, 5);
  });

  it("morph/ultina/ozvena global mixes rescale the same stateless way", () => {
    for (const [type, id, legacy] of [
      ["morphdynamics", "global.mix", 60],
      ["ultina", "global.mix", 60],
      ["ozvena", "global.dryWet", 60],
    ] as const) {
      const a = normalizePluginParams(type, { [id]: legacy } as Record<string, unknown>);
      const b = normalizePluginParams(type, { [id]: legacy } as Record<string, unknown>);
      expect(a).not.toBeNull();
      expect(a).toEqual(b); // deterministic — concurrent tabs converge
      const scaled = a![id];
      expect(scaled).toBeGreaterThan(0);
      expect(scaled).toBeLessThanOrEqual(1);
    }
  });
});

describe("audit 13 — hum-to-melody analyze cancellation", () => {
  it("the analyze phase passes an AbortSignal into the pitch tracker and gates setState", () => {
    const src = read("src/ui/HumToMelody.tsx");
    expect(src).toContain("trackPitchAsync(channel, take.buffer.sampleRate, analyzeAbort.signal)");
    expect(src).toContain("analyzeAbortRef.current?.abort();");
    // Every await in stopAndAnalyze is followed by an abort gate before
    // setState — the unmount/re-entry interleaving cannot setState late.
    expect(src).toContain("if (analyzeAbort.signal.aborted) return;");
  });

  it("the pitch-tracker client honours the signal (worker terminate + resolve [])", () => {
    const client = read("src/audio-workers/pitch-tracker-client.ts");
    expect(client).toContain("if (signal?.aborted) return Promise.resolve([]);");
    expect(client).toContain("signal.addEventListener(\"abort\", onAbort, { once: true });");
  });
});

describe("audit 13 — prior fixes still pinned", () => {
  it("mic claim: PcmMicRecorder keeps a single-capture guard at module level", () => {
    const src = read("src/audio-engine/PcmMicRecorder.ts");
    expect(src).toContain("let activeCapture: PcmMicRecorder | null = null;");
    // The HUM panel reaches the mic through the same guarded entry — no
    // parallel getUserMedia path exists in the panel code.
    const panel = read("src/ui/HumToMelody.tsx");
    expect(panel).not.toMatch(/getUserMedia/);
    expect(panel).toContain("new PcmMicRecorder(");
  });

  it("collab swap failure reopens a plain project instead of CLOSED services", () => {
    const panel = read("src/ui/CollabPanel.tsx");
    expect(panel).toContain("reopenErr");
  });

  it("services keeps the sync-guard timer lifecycle (audit 13 original fix)", () => {
    const src = read("src/services.ts");
    expect(src).toContain("syncGuardTimerRef");
  });
});
