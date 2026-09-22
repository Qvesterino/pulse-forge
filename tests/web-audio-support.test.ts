import { afterEach, describe, expect, it } from "vitest";

import { detectWebAudioSupport, isWebAudioBootFailure } from "../src/shared/webAudioSupport";

/**
 * Boot-time Web Audio capability probe. The guidance screen in main.tsx is
 * gated on this — the detector must be exact in both directions: a capable
 * browser must boot (no false positive), a browser without the globals must
 * get the guidance screen (no raw crash half-way through engine boot).
 */
describe("webAudioSupport capability probe", () => {
  const original = {
    AudioContext: globalThis.AudioContext,
    OfflineAudioContext: globalThis.OfflineAudioContext,
  };

  afterEach(() => {
    if (original.AudioContext === undefined) delete (globalThis as { AudioContext?: unknown }).AudioContext;
    else (globalThis as { AudioContext?: unknown }).AudioContext = original.AudioContext;
    if (original.OfflineAudioContext === undefined)
      delete (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext;
    else (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext = original.OfflineAudioContext;
  });

  it("reports ok when both audio globals are real constructors", () => {
    (globalThis as { AudioContext?: unknown }).AudioContext = class FakeAudioContext {};
    (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext = class FakeOfflineAudioContext {};
    const support = detectWebAudioSupport();
    expect(support.ok).toBe(true);
    expect(support.missing).toEqual([]);
  });

  it("names every missing global when the environment has no media stack", () => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    delete (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext;
    const support = detectWebAudioSupport();
    expect(support.ok).toBe(false);
    expect(support.missing).toEqual(["AudioContext", "OfflineAudioContext"]);
  });

  it("rejects non-constructor stand-ins (a property that is merely defined)", () => {
    (globalThis as { AudioContext?: unknown }).AudioContext = undefined;
    (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext = 42;
    const support = detectWebAudioSupport();
    expect(support.ok).toBe(false);
    expect(support.missing).toEqual(["AudioContext", "OfflineAudioContext"]);
  });

  it("classifies engine boot failures as audio-capability problems", () => {
    expect(isWebAudioBootFailure(new ReferenceError("Can't find variable: OfflineAudioContext"))).toBe(true);
    expect(isWebAudioBootFailure(new Error("AudioContext is not supported in this environment"))).toBe(true);
    expect(isWebAudioBootFailure(new Error("audioWorklet.addModule failed: module not found"))).toBe(true);
    // App bugs must keep the raw error screen.
    expect(isWebAudioBootFailure(new TypeError("Cannot read properties of undefined (reading 'tracks')"))).toBe(false);
    expect(isWebAudioBootFailure("quota exceeded")).toBe(false);
  });
});
