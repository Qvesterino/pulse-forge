import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dbToLinearGain, mix01ToPercent100 } from "../src/effects/scale-bridges";
import { fromDb } from "../src/audio-engine/metering";

/**
 * R-09 — the amplitude conversion has ONE owner, and the percent bridges
 * live in the scale-bridge registry, not inline in the node wrappers.
 *
 * `dbToLinearGain` (effects/scale-bridges) is the single dB→linear
 * implementation for first-party signal-gain paths. The engine, command,
 * worklet-wrapper and effect-root files below read it; a new inline
 * `Math.pow(10, x / 20)` in the scanned directories fails the scan guard,
 * and so does a hand-rolled `× 100` percent bridge in a node wrapper (the
 * crossing must be a registered bridge — the coherence test verifies it).
 *
 * Scopes are principled, not exhaustive: UI/analysis/mastering/reference
 * files DISPLAY or MEASURE dB and their arithmetic is inherent to that
 * domain; the vendored cores are mirrored upstream; instrument DSP
 * internals (kopa/tsar/choral/dymka) own their filter-coefficient math.
 */

const SCAN_DIRS = ["src/audio-engine", "src/audio-worklets", "src/commands", "src/ai/bridge", "src/effects"];

/** Files inside the scan scope where an inline `Math.pow(10, …)` is legitimate, with the reason. */
const INLINE_EXEMPT: Array<[string, string]> = [
  ["src/effects/scale-bridges.ts", "THE owner"],
  ["src/audio-engine/metering.ts", "BS.1770 loudness sums are power-domain /10; the /20 owner is delegated"],
  ["src/audio-engine/kweighting.ts", "BS.1770 gated loudness sums are power-domain /10"],
  ["src/effects/eqCurve.ts", "the A = 10^(gdb/40) shelf prototype coefficient is RBJ/cookbook math"],
  ["src/audio-worklets/compressor-node.ts", "imports the owner; any residual pow is the /10-domain meter tap"],
  ["src/ai/bridge/compressorSlots.ts", "the match is inside a doc COMMENT citing the formula"],
];

function* filesOf(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* filesOf(full);
      continue;
    }
    if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".d.ts")) yield full;
  }
}

describe("the amplitude conversion and the percent bridges have one owner", () => {
  it("scan guard: no inline dB→linear conversion in the signal-gain directories", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of filesOf(dir)) {
        const norm = file.replace(/\\/g, "/");
        if (norm.includes("-core/")) continue; // vendored, mirrored upstream
        if (INLINE_EXEMPT.some(([f]) => norm.endsWith(f))) continue;
        const text = readFileSync(file, "utf-8");
        if (/Math\.pow\(10,\s*[^)]*\/\s*20\s*\)/.test(text)) offenders.push(norm);
      }
    }
    expect(offenders.join("; "), "a new inline dB→linear conversion must go through effects/scale-bridges").toBe("");
  });

  it("scan guard: node wrappers bridge percent through the registry, not inline ×100", () => {
    const offenders: string[] = [];
    for (const file of filesOf("src/effects")) {
      const norm = file.replace(/\\/g, "/");
      if (!norm.endsWith("Node.ts")) continue;
      const text = readFileSync(file, "utf-8");
      // The old inline shape: `id === "global.x" ? v * 100 : v`.
      if (/\?\s*[a-z0-9.]+\s*\*\s*100\s*:/.test(text)) offenders.push(norm);
    }
    expect(offenders.join("; "), "a percent crossing must be a registered scale bridge (mix01ToPercent100)").toBe("");
  });

  it("the public delegates agree with the owner (identity, not copies)", () => {
    // metering.fromDb is the engine's public name for the same conversion.
    for (const db of [-24, -6, -0.3, 0, 3, 12, 24]) {
      expect(fromDb(db)).toBe(dbToLinearGain(db));
    }
    // The registry's flagship bridges still map 0..1 → 0..100 (the nodes
    // and the coherence sweep both rely on it).
    expect(mix01ToPercent100(0)).toBe(0);
    expect(mix01ToPercent100(1)).toBe(100);
  });
});
