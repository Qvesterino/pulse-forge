import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Audit 15 re-run (Performance) — regression pins.
 *
 * Evidence-based pass: budget headroom is consumed by concurrent-session
 * content waves (presets/artists), not by dead weight; the audit found no
 * high-value optimization in the audited hot paths, so this file pins the
 * structures that keep them cheap:
 *  - the shared single-bus RAF loop (meters/anims must not spawn per-component
 *    requestAnimationFrame loops),
 *  - the ArrangementPanel clip-sort memo (re-sorted per playhead tick used to
 *    be a measured hot spot),
 *  - the HUM feature riding lazy chunks (panel lives in the piano-roll chunk,
 *    the pitch tracker is a dedicated worker, zero cost when the feature is
 *    not opened).
 */

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("audit 15 — performance pins", () => {
  it("RAF stays a single shared bus (no per-component animation loops)", () => {
    const bus = read("src/services/rafLoop.ts");
    expect(bus).toContain("export function registerRaf");
    expect(bus).toContain("export function unregisterRaf");
    const meter = read("src/ui/Meter.tsx");
    expect(meter).toContain("registerRaf(meterId");
    expect(meter).toContain("unregisterRaf(meterId)");
  });

  it("ArrangementPanel keeps the clip/audioClip sort memos (per-tick re-sort regression)", () => {
    const src = read("src/ui/ArrangementPanel.tsx");
    expect(src).toContain("useMemo(() => [...arrangement.clips].sort((a, b) => a.startBar - b.startBar)");
    expect(src).toContain("const audioClips = useMemo(");
  });

  it("the HUM feature stays off the boot path (lazy chunk + worker)", () => {
    const pianoRoll = read("src/ui/PianoRoll.tsx");
    expect(pianoRoll).toContain('from "./HumToMelody"');
    // The tracker is a dedicated worker, not main-thread DSP.
    const client = read("src/audio-workers/pitch-tracker-client.ts");
    expect(client).toContain('new Worker(new URL("./pitch-tracker.ts", import.meta.url), { type: "module" })');
  });
});
