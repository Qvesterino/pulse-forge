/**
 * Regression coverage for the `safeApplyAudioParam` defensive helper. The
 * helper is the shared `Number.isFinite` guard added to every AudioWorklet
 * effect-node wrapper during the FázA §6 hardening pass — see
 * `src/audio-worklets/safeAudioParam.ts`. Without this layer a corrupt
 * stored value (`NaN`, `+Infinity`, `-Infinity`) reaches Web Audio's
 * AudioParam and the spec REQUIRES the runtime to throw `TypeError`,
 * which previously aborted the per-track fx chain build (`AudioEngine
 * .syncFxParams`) and left the track silent instead of falling back to
 * the AudioParam default.
 *
 * The tests use a minimal hand-rolled fake of `AudioWorkletNode`
 * carrying only the contract we depend on: `parameters.get(id)` returns
 * an `AudioParam`-like with `.value` and `.setValueAtTime(value, time)`
 * that THROW on non-finite values, exactly as a real Chromium
 * AudioParam does. Every wrapper that adopts `safeApplyAudioParam`
 * inherits this guarantee transitively, so this single test asserts the
 * full surface area of the fix.
 */
import { describe, expect, it, vi } from "vitest";
import { safeApplyAudioParam } from "../src/audio-worklets/safeAudioParam";

interface FakeAudioParam {
  value: number;
  setValueAtTime(value: number, time: number): void;
}

/** Throwing AudioParam stand-in that mirrors the Web Audio spec. */
function makeStrictParam(): FakeAudioParam {
  return {
    set value(v: number) {
      // Spec: AudioParam setter throws on non-finite values.
      if (!Number.isFinite(v)) throw new TypeError(`non-finite AudioParam value: ${v}`);
      this._value = v;
    },
    setValueAtTime(v: number, _time: number) {
      if (!Number.isFinite(v)) throw new TypeError(`non-finite AudioParam value: ${v}`);
      this._value = v;
    },
    get value(): number {
      return this._value;
    },
    _value: 0,
  } as unknown as FakeAudioParam;
}

/** Minimal AudioWorkletNode stub that returns the supplied param by id. */
function makeNode(param: FakeAudioParam | null, id = "drive"): unknown {
  return {
    parameters: {
      get: (k: string) => (k === id ? param : null),
    },
  };
}

describe("safeApplyAudioParam (FázA §6 defensive layer)", () => {
  it("drops NaN, +Infinity and −Infinity — the Web Audio AudioParam writes do not throw", () => {
    const p = makeStrictParam();
    const node = makeNode(p, "drive");
    // None of these may throw. The internal _value must remain at the
    // AudioParam's prepared default (0) — the helper must NOT forward the
    // corrupted write.
    expect(() => safeApplyAudioParam(node as never, "drive", NaN, 0)).not.toThrow();
    expect(() => safeApplyAudioParam(node as never, "drive", Infinity, 0)).not.toThrow();
    expect(() => safeApplyAudioParam(node as never, "drive", -Infinity, 0)).not.toThrow();
    expect(p.value).toBe(0);
  });

  it("drops non-finite writes whether scheduled or instant", () => {
    const p = makeStrictParam();
    const node = makeNode(p, "mix");
    // `when` undefined → instant `.value = v` path.
    expect(() => safeApplyAudioParam(node as never, "mix", NaN)).not.toThrow();
    // `when` provided → `setValueAtTime` path.
    expect(() => safeApplyAudioParam(node as never, "mix", Infinity, 1.5)).not.toThrow();
    expect(p.value).toBe(0);
  });

  it("forwards finite values unchanged (regression guard for the helper itself)", () => {
    const p = makeStrictParam();
    const node = makeNode(p, "drive");
    safeApplyAudioParam(node as never, "drive", 0.42, 0);
    expect(p.value).toBe(0.42);

    const p2 = makeStrictParam();
    const node2 = makeNode(p2, "drive");
    safeApplyAudioParam(node2 as never, "drive", -1, 0.5);
    expect(p2.value).toBe(-1);
  });

  it("silently ignores unknown parameter ids (no error, no AudioParam touch)", () => {
    const p = makeStrictParam();
    const node = makeNode(p, "drive"); // "missing" is NOT registered
    expect(() => safeApplyAudioParam(node as never, "missing", NaN, 0)).not.toThrow();
    expect(p.value).toBe(0);
  });

  it("does not swallow real AudioParam errors — finite values must reach the AudioParam", () => {
    const underlying = vi.fn();
    const p: FakeAudioParam = {
      value: 0,
      setValueAtTime: (v, t) => underlying(v, t),
    };
    underlying.mockImplementation(() => {
      throw new Error("real audio graph exploded");
    });
    const node = makeNode(p, "drive");
    // A real downstream failure must still surface — the guard only
    // guards non-finite, not the contract between this helper and Web Audio.
    expect(() => safeApplyAudioParam(node as never, "drive", 0.5, 1.0)).toThrow(
      "real audio graph exploded",
    );
  });
});
