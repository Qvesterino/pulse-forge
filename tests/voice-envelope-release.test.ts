import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { INSTRUMENT_META, INSTRUMENT_ORDER, defaultInstrumentParams } from "../src/instruments/definitions";

/**
 * VOICE RELEASE ENVELOPE GATE (2026-10-24)
 *
 * A voice release must NOT discard the envelope's current level.
 *
 * Plain cancelScheduledValues() drops an in-flight ramp to the last
 * setValueAtTime() value — it does not hold the level the ramp had reached.
 * A note released while its attack is still running therefore snapped to the
 * envelope floor: a hard mute, not a fade. The Spectral Pad (0.6 s attack)
 * measured -68.5 dBFS on a 0.35 s note where the very same note held long
 * enough reached -16.6 dBFS. The audit reported a broken instrument, and the
 * instrument really was broken — an early release was inaudible.
 *
 * The release path now cancels with HOLD semantics (cancelAndHoldAtTime), so
 * the release continues from the real level. Panic/silence paths keep the
 * plain cancel on purpose: a panic must cut, not fade.
 *
 * The behavioural half of this contract lives in `src/browser-checks.ts`
 * ("Spectral Pad: release during the attack fades from the attack level") and
 * runs in the real-browser gate. These tests pin the mechanism, the shape of
 * every release path, and the audit fixture that exposed the defect.
 *
 * Every module under test is overridable through an env var so the guard can
 * be FALSIFIED against a doctored copy without editing production code. A
 * guard that cannot be shown to fail is not a guard.
 */

const ROOT = resolve(__dirname, "..");
const read = (relative: string) => readFileSync(resolve(ROOT, relative), "utf8");

/** Which instrument sources to check. */
const INSTRUMENT_DIR = process.env.KYX_INSTRUMENT_DIR ?? "src/instruments";

/** Which envelope module provides the hold helper. */
const ENVELOPE_MODULE = process.env.KYX_ENVELOPE_MODULE ?? "../src/instruments/envelope";

/** Which audition-fixture module provides the note-length rule. */
const AUDITION_MODULE = process.env.KYX_AUDITION_MODULE ?? "../src/plugin-audit-audition";

/** Source text of the envelope helper, for the structural pin. */
const ENVELOPE_SOURCE = process.env.KYX_ENVELOPE_SOURCE ?? "src/instruments/envelope.ts";

const { holdParamAt } = (await import(ENVELOPE_MODULE)) as typeof import("../src/instruments/envelope");
const { auditionNoteSec, AUDITION_NOTE_SEC } = (await import(AUDITION_MODULE)) as typeof import("../src/plugin-audit-audition");

function instrumentSources(): string[] {
  return readdirSync(resolve(ROOT, INSTRUMENT_DIR))
    .filter((name) => name.endsWith(".ts") && !name.endsWith("envelope.ts"))
    .map((name) => `${INSTRUMENT_DIR}/${name}`)
    .sort();
}

/**
 * The only arguments a bare cancelScheduledValues() may take in the
 * instrument sources:
 *   now / silenceNow — a panic or a hard mute: the cut must stay hard.
 *   glideStart / slideWhen — a pitch glide, not an envelope at all.
 *
 * Every other argument means a VOICE RELEASE, which must hold the level.
 */
const ALLOWED_BARE_CANCEL_ARGS = new Set(["now", "silenceNow", "glideStart", "slideWhen"]);

interface FakeParam {
  calls: string[];
  param: AudioParam;
}

function fakeParam(options: { hasHold?: boolean; holdThrows?: boolean } = {}): FakeParam {
  const calls: string[] = [];
  const param = {
    cancelScheduledValues(time: number) {
      calls.push(`cancel:${time}`);
      return param;
    },
  } as unknown as AudioParam;
  if (options.hasHold !== false) {
    (param as unknown as { cancelAndHoldAtTime: (t: number) => void }).cancelAndHoldAtTime = (time: number) => {
      calls.push(`hold:${time}`);
      if (options.holdThrows) throw new RangeError("unsupported timeline");
    };
  }
  return { calls, param };
}

describe("voice release envelope contract", () => {
  it("cancels with HOLD semantics so an in-flight ramp is not dropped", () => {
    const { calls, param } = fakeParam();
    holdParamAt(param, 0.4);
    expect(calls).toEqual(["hold:0.4"]);
  });

  it("falls back to the plain cancel when the engine rejects the hold", () => {
    const { calls, param } = fakeParam({ holdThrows: true });
    holdParamAt(param, 0.4);
    expect(calls).toEqual(["hold:0.4", "cancel:0.4"]);
  });

  it("uses the plain cancel on engines without cancelAndHoldAtTime", () => {
    const { calls, param } = fakeParam({ hasHold: false });
    holdParamAt(param, 0.4);
    expect(calls).toEqual(["cancel:0.4"]);
  });

  it("clamps a negative cancel time instead of throwing into the audio path", () => {
    const { calls, param } = fakeParam();
    holdParamAt(param, -1);
    expect(calls).toEqual(["hold:0"]);
  });

  it("NEGATIVE: the plain cancel drops the ramp — the behaviour the fix removed", () => {
    // A plain cancelScheduledValues() is what the release path used to do: the
    // param falls back to the last setValueAtTime() value instead of holding
    // the ramp's level. The hold variant must NOT be equivalent to it.
    const plain = fakeParam({ hasHold: false });
    const held = fakeParam();
    holdParamAt(plain.param, 0.4);
    holdParamAt(held.param, 0.4);
    expect(plain.calls).not.toEqual(held.calls);
  });

  it("no instrument voice release uses a bare cancelScheduledValues", () => {
    const offenders: string[] = [];
    for (const file of instrumentSources()) {
      const source = read(file);
      for (const match of source.matchAll(/cancelScheduledValues\(\s*([A-Za-z0-9_.]+)\s*\)/g)) {
        if (!ALLOWED_BARE_CANCEL_ARGS.has(match[1])) {
          offenders.push(`${file}: cancelScheduledValues(${match[1]})`);
        }
      }
    }
    expect(offenders, "a voice release must cancel with HOLD semantics (holdParamAt)").toEqual([]);
  });

  it("every hold is paired with a release — a hold without one is a stuck note", () => {
    const stuck: string[] = [];
    for (const file of instrumentSources()) {
      const lines = read(file).split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("holdParamAt(")) return;
        const window = lines.slice(index + 1, index + 6).join("\n");
        if (!window.includes("setTargetAtTime")) stuck.push(`${file}:${index + 1}`);
      });
    }
    expect(stuck, "holdParamAt without a following release leaves the note hanging").toEqual([]);
  });

  it("the envelope helper implements the hold, not a plain cancel", () => {
    const source = read(ENVELOPE_SOURCE);
    expect(source).toContain("cancelAndHoldAtTime");
    expect(source).toContain("export function holdParamAt");
  });
});

describe("plugin audit audition fixture", () => {
  it("holds the audition note at least as long as the instrument's default attack", () => {
    const tooShort: string[] = [];
    for (const kind of INSTRUMENT_ORDER) {
      const defaults = defaultInstrumentParams(kind);
      const attack = Math.max(0, defaults.attack ?? 0);
      if (auditionNoteSec(defaults) < attack) tooShort.push(`${kind}: attack=${attack}`);
    }
    expect(tooShort, "an instrument whose attack outlives the audition tap is measured mid-attack").toEqual([]);
  });

  it("leaves the fixture untouched for the instruments whose attack is short", () => {
    const changed: string[] = [];
    for (const kind of INSTRUMENT_ORDER) {
      const defaults = defaultInstrumentParams(kind);
      const attack = Math.max(0, defaults.attack ?? 0);
      if (attack < AUDITION_NOTE_SEC && auditionNoteSec(defaults) !== AUDITION_NOTE_SEC) changed.push(kind);
    }
    expect(changed, "the fixture must not move for instruments the tap already covers").toEqual([]);
  });

  it("holds the two long-attack pads long enough to hear them", () => {
    expect(auditionNoteSec(defaultInstrumentParams("spectral"))).toBeGreaterThanOrEqual(0.6);
    expect(auditionNoteSec(defaultInstrumentParams("texture"))).toBeGreaterThanOrEqual(0.5);
  });

  it("the instrument registry really declares the attack the fixture reads", () => {
    // If the attack parameter were renamed, the fixture would silently fall
    // back to the tap length and the two pads would go back to being
    // reported as broken instruments.
    expect(INSTRUMENT_META.spectral.params.some((p) => p.id === "attack")).toBe(true);
    expect(INSTRUMENT_META.texture.params.some((p) => p.id === "attack")).toBe(true);
  });
});
