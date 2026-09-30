import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Wave 4b (AudioEngine decomposition) — MasterChain pins.
 *
 * The master output chain (input gain → tape → M/S → bass-mono → DC →
 * match EQ → tilt → glue → clipper → limiter + worklet splice + K-weight
 * sink) moved verbatim out of AudioEngine.ts into masterChain.ts. The
 * facade law is the load-bearing invariant: the collaborator must never
 * import AudioEngine, so the engine module graph stays acyclic toward its
 * domain owners (docs/AUDIOENGINE-DECOMPOSITION-PLAN.md §2).
 */

const CHAIN = resolve(process.cwd(), "src/audio-engine/masterChain.ts");
const ENGINE = resolve(process.cwd(), "src/audio-engine/AudioEngine.ts");

describe("MasterChain (Wave 4b)", () => {
  it("facade law: the chain never imports AudioEngine", () => {
    const src = readFileSync(CHAIN, "utf8");
    expect(/from\s+"\.\/AudioEngine"/.test(src)).toBe(false);
    expect(/from\s+"[^"]*audio-engine\/AudioEngine"/.test(src)).toBe(false);
  });

  it("the chain owns the moved methods verbatim (bodies intact)", () => {
    const src = readFileSync(CHAIN, "utf8");
    // Method inventory that moved: build, kw meter, config, worklet splice.
    for (const marker of [
      "build(): void {",
      "attachKwMeter(ctx: BaseAudioContext): void {",
      "upgradeKwMeter(): void {",
      "applyMasterConfig(config: MasterConfig): void {",
      "attachMasterWorklet(ctx: BaseAudioContext): void {",
      "upgradeMasterDynamics(): void {",
      "bypassForOfflineRender(): void {",
    ]) {
      expect(src.includes(marker), `missing: ${marker}`).toBe(true);
    }
    // The dBFS ceiling contract (lifecycle-audit regression) survived the move.
    expect(src).toMatch(/const ceilingDb\s*=\s*Math\.min\(0,\s*Math\.max\(-12,\s*config\.ceilingDb\)\)/);
    expect(src).not.toMatch(/Math\.pow\(10,\s*config\.ceilingDb\s*\/\s*20\)/);
  });

  it("the engine keeps the public surface as delegates (no master-device fields left)", () => {
    const src = readFileSync(ENGINE, "utf8");
    // The graph sink now lives on the collaborator.
    expect(src).toMatch(/private masterChain = new MasterChain\(/);
    expect(src).toMatch(
      /bypassMasterChainForOfflineRender\(\): void \{\s*\n\s*this\.masterChain\.bypassForOfflineRender\(\);/,
    );
    expect(src).toMatch(/getMasterTapNode\(\): AudioNode \| null \{\s*\n\s*return this\.masterChain\.stage\.limiter;/);
    // The moved device fields must be GONE from the facade.
    for (const gone of [
      "private masterLimiter:",
      "private masterGlue:",
      "private masterTiltLow:",
      "private masterMs:",
      "private masterBassMono:",
    ]) {
      expect(src.includes(gone), `stale facade field: ${gone}`).toBe(false);
    }
    // The offline-bypass guard error text is a pinned contract.
    expect(src).not.toMatch(/The offline master graph is not initialized/);
    const chain = readFileSync(CHAIN, "utf8");
    expect(chain).toMatch(/The offline master graph is not initialized/);
  });

  it("metering taps are handed to the rig (creation here, storage in MeteringRig)", () => {
    const src = readFileSync(CHAIN, "utf8");
    expect(src).toMatch(/this\.deps\.metering\.attachMasterTaps\(\{/);
    expect(src).toMatch(/this\.deps\.metering\.disconnectMasterTaps\(\)/);
    expect(src).toMatch(/this\.deps\.metering\.resetMeterHistory\(\)/);
  });

  it("liveContext guard is shared, not duplicated", () => {
    const engine = readFileSync(ENGINE, "utf8");
    const chain = readFileSync(CHAIN, "utf8");
    const defRe = /function isLiveAudioContext/;
    expect(defRe.test(engine)).toBe(false);
    expect(defRe.test(chain)).toBe(false);
    expect(readFileSync(resolve(process.cwd(), "src/audio-engine/liveContext.ts"), "utf8")).toMatch(defRe);
  });
});
