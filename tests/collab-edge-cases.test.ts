/**
 * Collab transport state validation — the network boundary between peers.
 *
 * `isSharedTransportState` is the single source of truth that filters
 * awareness messages before they reach Transport. A bug here would let
 * NaN/Infinity/negative values poison the scheduler's tick math, which
 * the transportSync tests already pin — this file adds adversarial coverage
 * for the validator itself.
 */
import { describe, expect, it } from "vitest";
import {
  isSharedTransportState,
  shouldStartRemoteScheduler,
  type SharedTransportState,
} from "../src/collab/transportSync";

const valid: SharedTransportState = {
  playing: true,
  anchorWall: 1000,
  anchorTick: 480,
  bpm: 120,
  by: "peer-A",
  at: Date.now(),
};

describe("isSharedTransportState — adversarial inputs", () => {
  it("accepts a canonical well-formed state", () => {
    expect(isSharedTransportState(valid)).toBe(true);
  });

  it("rejects null and undefined", () => {
    expect(isSharedTransportState(null)).toBe(false);
    expect(isSharedTransportState(undefined)).toBe(false);
  });

  it("rejects non-objects (strings, numbers, booleans)", () => {
    expect(isSharedTransportState("foo")).toBe(false);
    expect(isSharedTransportState(42)).toBe(false);
    expect(isSharedTransportState(true)).toBe(false);
    expect(isSharedTransportState([])).toBe(false);
  });

  it("rejects playing = non-boolean (truthy/falsy values)", () => {
    // A peer that sends { playing: 1 } or { playing: "yes" } must be
    // rejected — the receiver would treat it as a truthy non-boolean and
    // either silently coerce or fail in the audio scheduler.
    expect(isSharedTransportState({ ...valid, playing: 1 })).toBe(false);
    expect(isSharedTransportState({ ...valid, playing: "yes" })).toBe(false);
    expect(isSharedTransportState({ ...valid, playing: null })).toBe(false);
    expect(isSharedTransportState({ ...valid, playing: undefined })).toBe(false);
  });

  it("rejects non-finite anchorWall (NaN, Infinity, -Infinity)", () => {
    expect(isSharedTransportState({ ...valid, anchorWall: NaN })).toBe(false);
    expect(isSharedTransportState({ ...valid, anchorWall: Infinity })).toBe(false);
    expect(isSharedTransportState({ ...valid, anchorWall: -Infinity })).toBe(false);
  });

  it("rejects negative or non-finite anchorTick", () => {
    // Negative anchorTick would compute a "time machine" transport that
    // schedules events before the audio context was created — a hard crash.
    expect(isSharedTransportState({ ...valid, anchorTick: -1 })).toBe(false);
    expect(isSharedTransportState({ ...valid, anchorTick: NaN })).toBe(false);
    expect(isSharedTransportState({ ...valid, anchorTick: Infinity })).toBe(false);
  });

  it("rejects out-of-range BPM (below 20 or above 300)", () => {
    // The transport clamps to [1, 999] but at the validator level we
    // reject anything outside the musical range — the broadcast layer
    // should never carry extreme values that would force the receiver
    // to silently renormalize.
    expect(isSharedTransportState({ ...valid, bpm: 19 })).toBe(false);
    expect(isSharedTransportState({ ...valid, bpm: 301 })).toBe(false);
    expect(isSharedTransportState({ ...valid, bpm: 0 })).toBe(false);
    expect(isSharedTransportState({ ...valid, bpm: NaN })).toBe(false);
    expect(isSharedTransportState({ ...valid, bpm: Infinity })).toBe(false);
  });

  it("rejects empty or missing 'by' (echo suppression would break)", () => {
    // The 'by' field is the originator's clientId — used for echo
    // suppression. An empty string would let a peer echo its own state
    // back to itself in a loop.
    expect(isSharedTransportState({ ...valid, by: "" })).toBe(false);
    expect(isSharedTransportState({ ...valid, by: undefined as unknown as string })).toBe(false);
  });

  it("rejects the canonical boundary BPMs that are inside the [20, 300] range", () => {
    // The validator accepts the inclusive ends (20 and 300), so test that
    // a regression that flips the comparison (< vs <=) is caught.
    expect(isSharedTransportState({ ...valid, bpm: 20 })).toBe(true);
    expect(isSharedTransportState({ ...valid, bpm: 300 })).toBe(true);
  });
});

describe("shouldStartRemoteScheduler — play-edge detection", () => {
  it("returns true only on a false → true play edge", () => {
    // The remote scheduler should wake up ONLY when a peer started playing
    // — a paused → paused pair must NOT spawn a duplicate scheduler, and
    // a playing → playing pair (e.g. echo from a slow network) must not
    // either. A regression that flips the polarity would silently double-
    // schedule the same events.
    expect(shouldStartRemoteScheduler(false, true)).toBe(true);
    expect(shouldStartRemoteScheduler(true, false)).toBe(false);
    expect(shouldStartRemoteScheduler(true, true)).toBe(false);
    expect(shouldStartRemoteScheduler(false, false)).toBe(false);
  });

  it("is robust against a stop-then-immediate-start race (false → false → true within one tick)", () => {
    // A user clicks stop and play in quick succession. The first pulse
    // (false → false) does nothing, the second (false → true) starts the
    // remote scheduler. Pin the truth table across the full edge matrix.
    expect(shouldStartRemoteScheduler(false, false)).toBe(false);
    expect(shouldStartRemoteScheduler(false, true)).toBe(true);
  });
});

describe("isSharedTransportState — extra-fields tolerance", () => {
  it("accepts extra unknown fields (forward compatibility)", () => {
    // Future versions of the schema may add fields. A peer on an older
    // schema receives the new payload and must not reject it.
    const extended = { ...valid, futureField: "ignored", anotherField: 42 };
    expect(isSharedTransportState(extended)).toBe(true);
  });

  it("rejects when a required field has wrong type (string instead of number)", () => {
    expect(isSharedTransportState({ ...valid, anchorWall: "1000" })).toBe(false);
    expect(isSharedTransportState({ ...valid, at: "1234567890" })).toBe(false);
  });
});
