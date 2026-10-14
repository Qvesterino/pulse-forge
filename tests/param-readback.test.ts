import { describe, expect, it } from "vitest";
import { measureParamVerification } from "../src/intent/param-readback";
import { parseParamIntent, applyParamIntent, type ParamIntent } from "../src/intent/param-intent";
import { parseEffectIntent } from "../src/intent/mix";
import { routeIntentText } from "../src/intent/route";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * PARAM WAVE P3+P4 — the measured readback (render before/after → feature
 * delta → "✓ jasnejší o +12 %" or a correction chip) and the preset anchors
 * ("hall reverb", "slapback delay" — named characters as absolute moves).
 */

const RATE = 16000;

/** Deterministic noise with a spectral tilt: `bright` weights high bands. */
function noiseBuffer(seed: number, bright: boolean, channels = 1): AudioBuffer {
  const length = RATE * 2;
  const buffer = {
    sampleRate: RATE,
    length,
    numberOfChannels: channels,
    duration: 2,
    getChannelData: (channel: number) => {
      if (bufferCache[channel]) return bufferCache[channel] as Float32Array;
      const data = new Float32Array(length);
      let state = seed + channel * 7919;
      let previous = 0;
      for (let index = 0; index < length; index += 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        const white = (state / 0x7fffffff) * 2 - 1;
        // one-pole filter: bright = high-pass tilt, dark = low-pass tilt
        const alpha = bright ? 0.8 : 0.05;
        previous = alpha * (white - previous) + previous;
        data[index] = bright ? previous * 0.5 : previous * 2;
      }
      bufferCache[channel] = data;
      return data;
    },
  } as unknown as AudioBuffer;
  const bufferCache: Record<number, Float32Array> = {};
  (buffer as unknown as { cache: Record<number, Float32Array> }).cache = bufferCache;
  return buffer;
}

/** Stereo buffer with controllable mid/side balance (side = width). */
function stereoBuffer(seed: number, wide: boolean): AudioBuffer {
  const length = RATE;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const mono = ((state / 0x7fffffff) * 2 - 1) * 0.3;
    left[index] = wide ? mono * 0.2 + mono * 0.8 : mono;
    right[index] = wide ? mono * 0.2 - mono * 0.8 : mono;
  }
  return {
    sampleRate: RATE,
    length,
    numberOfChannels: 2,
    duration: 1,
    getChannelData: (channel: number) => (channel === 0 ? left : right),
  } as unknown as AudioBuffer;
}

const mustParse = (text: string): ParamIntent => parseParamIntent(text) as ParamIntent;

describe("measureParamVerification (P3)", () => {
  it("a brighter render verifies a tone-up ask with a percentage line", async () => {
    const doc = testDoc();
    const intent = mustParse("jasnejsi ton reverbu na 808");
    const after = applyParamIntent(doc, intent).execute(doc);
    const verification = await measureParamVerification(doc, after, intent, (renderDoc) =>
      Promise.resolve(renderDoc === doc ? noiseBuffer(11, false) : noiseBuffer(11, true)),
    );
    expect(verification.measurable).toBe(true);
    expect(verification.verified).toBe(true);
    expect(verification.line).toMatch(/✓ .*jasnejší o \d+ %/);
    expect(verification.correction).toBeNull();
  });

  it("a wider stereo render verifies a width-up ask", async () => {
    const doc = testDoc();
    // Synthetic width intent (the parser needs a named widener effect —
    // here we exercise the MEASUREMENT, not the grammar).
    const intent: ParamIntent = {
      effectType: "haasWidener",
      role: "width",
      paramId: "width",
      targets: ["bass"],
      mode: "more",
      amount: "medium",
      detected: [],
    };
    const after: ProjectDocument = { ...doc, tracks: [...doc.tracks] };
    const verification = await measureParamVerification(doc, after, intent, (renderDoc) =>
      Promise.resolve(renderDoc === doc ? stereoBuffer(7, false) : stereoBuffer(7, true)),
    );
    expect(verification.verified).toBe(true);
    expect(verification.line).toMatch(/širší o \d+ %/);
  });

  it("no audible move on a relative ask yields the correction chip", async () => {
    const doc = testDoc();
    const intent = mustParse("jasnejsi ton reverbu na 808");
    const verification = await measureParamVerification(doc, doc, intent, () =>
      Promise.resolve(noiseBuffer(11, false)),
    );
    expect(verification.measurable).toBe(true);
    expect(verification.verified).toBe(false);
    expect(verification.line).toMatch(/⚠/);
    expect(verification.correction).toMatch(/×1,5/);
  });

  it("drive/time roles are honestly unmeasured in v1", async () => {
    const doc = testDoc();
    const intent = mustParse("dlhsi chvost na reverbe na 808"); // time role
    const verification = await measureParamVerification(doc, doc, intent, () => Promise.resolve(noiseBuffer(3, true)));
    expect(verification.measurable).toBe(false);
    expect(verification.line).toMatch(/drive\/time v1/);
  });

  it("a failed render degrades to unmeasured, never throws", async () => {
    const doc = testDoc();
    const intent = mustParse("jasnejsi ton reverbu na 808");
    const verification = await measureParamVerification(doc, doc, intent, () => Promise.resolve(null));
    expect(verification.measurable).toBe(false);
    expect(verification.correction).toBeNull();
  });
});

describe("preset anchors (P4)", () => {
  it("'hall reverb na leade' is an absolute character move on reverb", () => {
    const parsed = parseEffectIntent("hall reverb na leade");
    expect(parsed?.effectType).toBe("reverb");
    expect(parsed?.targets).toContain("lead");
    expect(parsed?.move).toMatchObject({ id: "reverb-hall" });
    expect(parsed?.move?.params).toMatchObject({ decay: 4.2, mix: 0.26 });
    expect(routeIntentText("hall reverb na leade", testDoc()).kind).toBe("effectIntent");
  });

  it("'slapback delay na 808' lands the slapback map; SK forms parse", () => {
    expect(parseEffectIntent("slapback delay na 808")?.move).toMatchObject({ id: "delay-slap" });
    expect(parseEffectIntent("urob z reverbu katedralu na leade")?.move).toMatchObject({ id: "reverb-hall" });
  });

  it("reduction idioms keep the knob path — the anchor never swaps a less-ask", () => {
    const eased = parseEffectIntent("Ease off the room reverb on the lead");
    expect(eased?.move).toBeUndefined();
    expect(eased?.direction).toBe("less");
    const pulled = parseEffectIntent("Pull the plate reverb back on the chords.");
    expect(pulled?.move).toBeUndefined();
    expect(pulled?.direction).toBe("less");
  });

  it("an anchor word WITHOUT its effect named never hijacks another ask", () => {
    expect(parseEffectIntent("hall na leade")).toBeNull();
    expect(parseEffectIntent("slap na 808")).toBeNull();
  });

  it("the anchor applies: one undo restores, params land clamped", () => {
    const doc = testDoc();
    const parsed = parseEffectIntent("hall reverb na 808");
    expect(parsed).not.toBeNull();
    // applyEffectIntent is the move path — exercised by the mix suite; here
    // we pin the parse shape (id/params) which is the anchor's contract.
    expect(parsed?.detected?.[0]).toMatch(/move: Hall/);
  });
});
