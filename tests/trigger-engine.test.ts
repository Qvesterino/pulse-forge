import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Wave 4f (FINAL AudioEngine decomposition) — TriggerEngine pins.
 *
 * The realtime performance path moved verbatim out of AudioEngine.ts:
 * drum/synth voices, instrument noteOn (ratio p-locks, FL slides), AudioClips
 * (stretch + repitch-warp), choke with the 64-voice retirement cap, MPE/
 * MIDI poly writes. Load-bearing invariants: the facade law, the voice
 * accounting (single set, single retirement policy), the one-writer
 * discipline on the engine's one-shot tracker (markers/clicks stay
 * engine-side), and the audit-03 capability contract on noteOn.
 */

const ENGINE = resolve(process.cwd(), "src/audio-engine/AudioEngine.ts");
const TRIGGER = resolve(process.cwd(), "src/audio-engine/triggerEngine.ts");

describe("TriggerEngine (Wave 4f — final)", () => {
  it("facade law: never imports AudioEngine", () => {
    const src = readFileSync(TRIGGER, "utf8");
    expect(/from\s+"\.\/AudioEngine"/.test(src)).toBe(false);
    expect(/from\s+"[^"]*audio-engine\/AudioEngine"/.test(src)).toBe(false);
  });

  it("owns the moved realtime path verbatim (method inventory)", () => {
    const src = readFileSync(TRIGGER, "utf8");
    for (const marker of [
      "noteOn(\n    trackId: string,",
      "triggerAudioClip(",
      "trigger(\n    trackId: string,\n    pad: DrumPad,",
      "private attachPadMod(",
      "private addDrumVoice(voice: TriggerVoice): void {",
      "private triggerSynth(",
      "private choke(trackId: string, chokeGroup: number, when: number): void {",
      "setMidiPitchBend(trackId: string, semitones: number): void {",
      "polyTimbre(trackId: string, pitch: number, timbre: number): void {",
      "polyPressure(trackId: string, pitch: number, pressure: number): void {",
      "noteOff(trackId: string, pitch: number, when: number): void {",
      "private ensureSynthNoise(): AudioBuffer | null {",
    ]) {
      expect(src.includes(marker), `missing: ${marker}`).toBe(true);
    }
  });

  it("audit-03 capability contract moved WITH noteOn (if/else, never the void ?? fallback)", () => {
    const src = readFileSync(TRIGGER, "utf8");
    const start = src.indexOf("needsRatioLock) {", src.indexOf("noteOn("));
    const body = src.slice(start, start + 2600);
    expect(body).not.toMatch(/setParameterAt\?\([\s\S]*?\?\?/);
    expect(body.match(/if \(.*runtime\.setParameterAt\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("voice accounting: one set, 64-voice retirement cap, choke reads the same set", () => {
    const src = readFileSync(TRIGGER, "utf8");
    expect(src).toMatch(/private voices = new Set<TriggerVoice>\(\);/);
    expect(src).toMatch(/MAX_ACTIVE_DRUM_VOICES = 64/);
    // choke iterates a defensive snapshot (defect 6.2) and cuts at the hit time
    expect(src).toMatch(/for \(const voice of \[\.\.\.this\.voices\]\)/);
    expect(src).toMatch(/const cutAt = Number\.isFinite\(when\) \? Math\.max\(when, .*currentTime/);
  });

  it("engine keeps the exact surface as delegates (no stale voice state)", () => {
    const src = readFileSync(ENGINE, "utf8");
    for (const marker of [
      "this.triggerEngine.noteOn(",
      "this.triggerEngine.triggerAudioClip(clip, when, durationSec, resumeOffsetSec);",
      "this.triggerEngine.trigger(trackId, pad, when, velocity, locks, sampleId);",
      "this.triggerEngine.panicVoices(now);",
      "this.triggerEngine.hardClearVoices();",
      "this.triggerEngine.disposeVoicesForContextSwap();",
      "activeVoices: this.triggerEngine.voiceCount,",
    ]) {
      expect(src.includes(marker), `missing: ${marker}`).toBe(true);
    }
    for (const gone of [
      "private voices = new Set",
      "private synthNoise: AudioBuffer | null",
      "private triggerSynth(",
      "private choke(trackId: string",
      "private attachPadMod(",
    ]) {
      expect(src.includes(gone), `stale engine member: ${gone}`).toBe(false);
    }
    // one-shot tracking stays ENGINE-side (markers/clicks use it), the engine
    // hands the tracker to the collaborator through deps. The live-editing
    // wave (ADR 0024) added the per-source clip metadata side table for
    // orphan cancellation, so the handoff grew releaseOneShot + clipMeta.
    expect(src).toMatch(/trackOneShot: \(source, clipMeta\) => \{/);
    expect(src).toMatch(/releaseOneShot: \(source\) => \{/);
  });

  it("frozen guards route through the shared WarpManager instance", () => {
    const src = readFileSync(TRIGGER, "utf8");
    expect(src.match(/this\.warp\.isFrozen\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("pure helpers moved with their only consumers (computeStretchedBuffer)", () => {
    const src = readFileSync(TRIGGER, "utf8");
    expect(src).toMatch(/function computeStretchedBuffer\(/);
    const engine = readFileSync(ENGINE, "utf8");
    expect(engine.includes("function computeStretchedBuffer(")).toBe(false);
  });
});
