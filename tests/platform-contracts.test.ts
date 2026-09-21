import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assetUrl, configureAssetBase } from "../src/shared/assetUrls";
import { decodeAudioData, setAudioDecoder, type AudioDecoder } from "../src/services/audio-decode";

/**
 * GOAL 03 — platform contract behavior pins. The contracts must be
 * zero-behavior-change by default and injectable on non-web hosts.
 */

describe("asset URL contract", () => {
  it("passes root-absolute paths through verbatim by default", () => {
    expect(assetUrl("/core-worklet.js")).toBe("/core-worklet.js");
    expect(assetUrl("/models/semantic/manifest.json")).toBe("/models/semantic/manifest.json");
  });

  it("prefixes a configured base (subpath hosting / CDN) and normalizes trailing slashes", () => {
    configureAssetBase("/studio/");
    expect(assetUrl("/core-worklet.js")).toBe("/studio/core-worklet.js");
    configureAssetBase("https://cdn.example.com/kyx");
    expect(assetUrl("/models/x.onnx")).toBe("https://cdn.example.com/kyx/models/x.onnx");
  });

  it("empty base restores verbatim pass-through (host reset)", () => {
    configureAssetBase("");
    expect(assetUrl("/models/x.onnx")).toBe("/models/x.onnx");
  });
});

describe("audio decode contract", () => {
  it("prefers the injected platform decoder", async () => {
    const marker = { channels: 1 } as unknown as AudioBuffer;
    const calls: Array<[ArrayBuffer, number]> = [];
    const decoder: AudioDecoder = (bytes, sampleRate) => {
      calls.push([bytes, sampleRate]);
      return Promise.resolve(marker);
    };
    setAudioDecoder(decoder);
    const bytes = new ArrayBuffer(8);
    await expect(decodeAudioData(bytes, 48_000)).resolves.toBe(marker);
    expect(calls).toEqual([[bytes, 48_000]]);
    setAudioDecoder(null);
  });

  it("rejects with a clear error when no decoder exists and none is injected", async () => {
    // vitest/jsdom has no OfflineAudioContext — the default web path is the
    // same reject-on-missing-platform behavior the repos had before.
    await expect(decodeAudioData(new ArrayBuffer(4))).rejects.toThrow(/no audio decoder/i);
  });
});

describe("persistence contracts file hygiene", () => {
  it("contracts.ts is type-only (no runtime imports, no browser access)", () => {
    const source = readFileSync(resolve(process.cwd(), "src/persistence/contracts.ts"), "utf8");
    const importLines = source.match(/^import[^\n]*$/gm) ?? [];
    for (const line of importLines) {
      expect(line, "contracts must import types only").toMatch(/^import type/);
    }
    expect(source).not.toMatch(/localStorage|indexedDB|fetch\(/);
  });
});
