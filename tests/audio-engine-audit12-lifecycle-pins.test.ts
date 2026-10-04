import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Audio Engine audit 12 — lifecycle leak + containment pins.
 *
 * 1. Envelope-follower upstream edge: `follower.dispose()` (envfollower-node)
 *    only disconnects the follower's OUTGOING edges. The detector tap
 *    `source.input → follower.input` is owned by AutomationBridge and must be
 *    dropped explicitly on dispose, or every follower recreation (any
 *    attack/release/sensitivity edit changes the signature and disposes the
 *    old runtime) leaves another inbound edge pinning a retired worklet node
 *    to the live source channel. Sibling wrappers (compressor, sidechain,
 *    vocoder) already track their upstream feed this way.
 *
 * 2. FX runtime dispose containment: the instrument teardown path already
 *    wraps each `runtime.dispose()` in try/catch; the FX chain paths (track /
 *    return / group / rebuild / context swap) did not. A throwing third-party
 *    runtime aborted the remaining teardown and could take down the whole
 *    context swap. All five sites must contain per-runtime failures.
 */

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("audit 12 — env follower upstream edge teardown", () => {
  it("disposeLfoRuntime drops the tracked source → follower edge before disposing", () => {
    const bridge = read("src/audio-engine/automationBridge.ts");
    // The runtime state must track the source node (not just rely on
    // follower.dispose(), which only severs outgoing edges).
    expect(bridge).toMatch(/followerSource\?:\s*AudioNode\s*\|\s*null/);
    expect(bridge).toMatch(/state\.followerSource\.disconnect\(state\.follower\.input\)/);
    // The wiring path must record the exact source input it tapped.
    expect(bridge).toMatch(/followerSource:\s*sourceNodes\.input/);
  });
});

describe("audit 12 — FX runtime dispose containment", () => {
  it("every FX dispose site contains per-runtime throws", () => {
    const engine = read("src/audio-engine/AudioEngine.ts");
    // The track/return/group teardown + chain rebuild + useContext swap all
    // iterate runtimes; none of these loops may let one dispose() abort the
    // rest. Count the contained blocks — there are 4 distinct
    // `for (const rt of ...` teardowns in AudioEngine.ts.
    const contained = engine.match(
      /for \(const rt of [\s\S]{0,120}?\)\s*\{\s*try\s*\{\s*rt\.dispose\(\);\s*\}\s*catch\s*\{/g,
    );
    expect(contained?.length ?? 0, "all FX runtime dispose loops must be contained").toBeGreaterThanOrEqual(4);
    // And the unguarded form must be gone everywhere.
    expect(engine).not.toMatch(/for \(const rt of [^)]*\) rt\.dispose\(\);/);
  });
});
