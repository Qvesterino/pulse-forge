import { describe, it, expect } from "vitest";
import { isWebSpeechSupported, createWebSpeechCapture } from "../src/intent/stt-web-speech";

/**
 * WEB SPEECH API STT (W0.3) — browser-native speech recognition fallback.
 * In jsdom there's no SpeechRecognition, so `isWebSpeechSupported()` returns
 * false and `createWebSpeechCapture()` returns null. The real behavior is
 * Chromium-verified (the CI browser job covers it via the studio boot test).
 */
describe("stt-web-speech (W0.3)", () => {
  it("jsdom has no SpeechRecognition — supported() returns false", () => {
    expect(isWebSpeechSupported()).toBe(false);
  });

  it("createWebSpeechCapture returns null in unsupported environments", () => {
    expect(createWebSpeechCapture()).toBeNull();
  });

  it("the module exports the right shape (contract pin)", () => {
    expect(typeof isWebSpeechSupported).toBe("function");
    expect(typeof createWebSpeechCapture).toBe("function");
  });
});
