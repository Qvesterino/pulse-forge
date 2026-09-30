import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PreviewDeck } from "../src/audio-engine/previewDeck";
import type { PreviewDeckDeps } from "../src/audio-engine/previewDeck";
import { DECLICK_TAIL_SEC, declickFadeOut, resolveSlicePlayback } from "../src/audio-engine/declick";

/**
 * Wave 4c (AudioEngine decomposition) — PreviewDeck pins.
 *
 * The audition deck (pad/preset/slice/asset/buffer/synced previews + the
 * two voice sets) moved verbatim out of AudioEngine.ts. The de-click and
 * slice-resolution helpers it shares with the trigger path moved to
 * declick.ts (AudioEngine re-exports them — consumer imports unchanged).
 *
 * Facade law + the honest scope cut are the load-bearing invariants: the
 * deck never imports AudioEngine, and the graph-param previews (faders,
 * FX intent) deliberately STAY in the engine.
 */

const DECK = resolve(process.cwd(), "src/audio-engine/previewDeck.ts");
const ENGINE = resolve(process.cwd(), "src/audio-engine/AudioEngine.ts");

function makeDeps(overrides: Partial<PreviewDeckDeps> = {}): PreviewDeckDeps {
  return {
    ctx: () => null,
    doc: () => null,
    bank: () => null,
    masterInput: () => null,
    ensureContext: () => undefined,
    currentTime: () => 0,
    transportTickNow: () => 0,
    trigger: () => {},
    noteOn: () => {},
    missAsset: () => {},
    ...overrides,
  };
}

class FakeBufferSource {
  gainConnectedTo: unknown = null;
  started = false;
  stopped = false;
  disconnected = false;
  onended: (() => void) | null = null;
  buffer: unknown = null;
  playbackRate = { value: 1 };
  connect(dest: unknown) {
    this.gainConnectedTo = dest;
    return this;
  }
  disconnect() {
    this.disconnected = true;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

describe("PreviewDeck (Wave 4c)", () => {
  it("facade law: the deck never imports AudioEngine", () => {
    const src = readFileSync(DECK, "utf8");
    expect(/from\s+"\.\/AudioEngine"/.test(src)).toBe(false);
    expect(/from\s+"[^"]*audio-engine\/AudioEngine"/.test(src)).toBe(false);
  });

  it("honest scope: graph-param previews stay in the engine, not the deck", () => {
    const engine = readFileSync(ENGINE, "utf8");
    const deck = readFileSync(DECK, "utf8");
    for (const stays of [
      "previewTrackGain(",
      "previewFxParam(",
      "beginEffectIntentPreview(",
      "cancelEffectIntentPreview(",
    ]) {
      expect(engine.includes(stays), `engine must keep ${stays}`).toBe(true);
      expect(deck.includes(stays), `deck must NOT contain ${stays}`).toBe(false);
    }
  });

  it("preview routes through the engine's trigger with the +5 ms when", () => {
    const calls: Array<{ trackId: string; when: number; velocity: number }> = [];
    const deck = new PreviewDeck(
      makeDeps({
        currentTime: () => 10,
        trigger: (trackId, _pad, when, velocity) => {
          calls.push({ trackId, when, velocity });
        },
      }),
    );
    deck.preview({ id: "p", assetId: "a" } as never, "t1", 0.7);
    expect(calls).toEqual([{ trackId: "t1", when: 10.005, velocity: 0.7 }]);
  });

  it("previewAsset plays through the master bus and self-removes on ended", () => {
    const source = new FakeBufferSource();
    const master = { sink: true };
    let gainNode: { gain: { value: number }; connect: (d: unknown) => unknown; disconnect: () => void } | null = null;
    const fakeCtx = {
      currentTime: 5,
      createBufferSource: () => source,
      createGain: () => {
        gainNode = {
          gain: { value: 1 },
          connect: (d: unknown) => {
            expect(d).toBe(master);
            return gainNode;
          },
          disconnect: () => {},
        };
        return gainNode;
      },
    };
    const deck = new PreviewDeck(
      makeDeps({
        ctx: () => fakeCtx as unknown as BaseAudioContext,
        bank: () => ({ get: () => ({ duration: 1 }) }) as never,
        masterInput: () => master as never,
      }),
    );
    deck.previewAsset("factory.kick");
    expect(source.started).toBe(true);
    expect(gainNode!.gain.value).toBeCloseTo(0.9, 6);
    expect(deck.voiceCounts().samples).toBe(1);
    source.onended?.();
    expect(deck.voiceCounts().samples).toBe(0);
  });

  it("missing asset reports through missAsset (engine's missedAssets)", () => {
    const missed: string[] = [];
    const fakeCtx = {
      currentTime: 0,
      createBufferSource: () => new FakeBufferSource(),
      createGain: () => ({ gain: { value: 1 }, connect: () => {}, disconnect: () => {} }),
    };
    const deck = new PreviewDeck(
      makeDeps({
        ctx: () => fakeCtx as unknown as BaseAudioContext,
        masterInput: () => ({}) as never,
        bank: () => ({ get: () => null }) as never,
        missAsset: (id) => missed.push(id),
      }),
    );
    deck.previewAsset("factory.gone");
    expect(missed).toEqual(["factory.gone"]);
    expect(deck.voiceCounts().samples).toBe(0);
  });

  it("stopPreview de-clicks: cancel + setTargetAtTime + stop after 4 tails", () => {
    const source = new FakeBufferSource();
    const paramOps: string[] = [];
    const gainParam = {
      value: 0.9,
      cancelScheduledValues: () => paramOps.push("cancel"),
      setTargetAtTime: () => paramOps.push("glide"),
    };
    const fakeCtx = {
      currentTime: 7,
      createBufferSource: () => source,
      createGain: () => ({ gain: gainParam, connect: () => {}, disconnect: () => {} }),
    };
    const deck = new PreviewDeck(
      makeDeps({
        ctx: () => fakeCtx as unknown as BaseAudioContext,
        bank: () => ({ get: () => ({ duration: 1 }) }) as never,
        masterInput: () => ({}) as never,
      }),
    );
    deck.previewAsset("factory.kick");
    deck.stopPreview();
    expect(paramOps).toEqual(["cancel", "glide"]);
    expect(source.stopped).toBe(true);
    expect(deck.voiceCounts().samples).toBe(0);
    expect(DECLICK_TAIL_SEC).toBe(0.002);
  });

  it("declick helpers re-exported from AudioEngine keep their contracts", () => {
    // The re-export keeps consumer/test imports working; pin the math once here.
    expect(declickFadeOut(0, 1)).toBeCloseTo(DECLICK_TAIL_SEC, 9);
    expect(declickFadeOut(0.05, 1)).toBeCloseTo(0.05, 9);
    const slice = resolveSlicePlayback({ pitch: 12 } as never, 2);
    expect(slice.rate).toBeCloseTo(2, 9);
    const engineSrc = readFileSync(ENGINE, "utf8");
    expect(engineSrc).toMatch(/export \{ DECLICK_TAIL_SEC, declickFadeOut, resolveSlicePlayback \} from "\.\/declick"/);
  });
});
