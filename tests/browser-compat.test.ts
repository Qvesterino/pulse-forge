import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Source-grep regression tests for browser-compatibility hardening.
 *
 * The DAW targets Chromium, Edge, Firefox and Safari. Web Audio feature
 * surface differs across those engines (AudioWorklet on iOS Safari landed
 * in 14.5, OfflineAudioContext construction can throw inside a worker,
 * AudioContext itself is missing in some sandboxed iframes). The fix is
 * to feature-detect at every construction site — `typeof X !== "undefined"`
 * for globals, `instanceof` for prototype checks, and `ctx.audioWorklet`
 * for the worklet submodule. These tests pin the structural hardening
 * from the Master DAW Browser Compatibility audit so a careless removal
 * shows up in CI.
 */

const RENDERER_PATH = resolve(process.cwd(), "src/rendering/renderer.ts");
const EMBED_PATH = resolve(process.cwd(), "src/embed/EmbedApp.tsx");
const LOADER_PATH = resolve(process.cwd(), "src/audio-worklets/loader.ts");
const AUDIO_ENGINE_PATH = resolve(process.cwd(), "src/audio-engine/AudioEngine.ts");

function readSrc(path: string): string {
  return readFileSync(path, "utf8");
}

describe("browser compatibility — feature detection", () => {
  it("renderProject() rejects when OfflineAudioContext is missing", () => {
    // Defect A06.D2 (browser compatibility audit): the export
    // pipeline (bounce, freeze, WAV/MP3/stem export) calls
    // `new OfflineAudioContext(...)` directly. A worker / sandboxed
    // iframe / future engine that omits the global would throw
    // ReferenceError and surface as a generic render failure. The
    // fix feature-detects before construction and throws a named
    // error so the UI can branch on its message.
    const src = readSrc(RENDERER_PATH);
    // The detection must happen BEFORE the `new OfflineAudioContext`
    // call site — otherwise the error is unreachable. Pin the order
    // by searching for the feature-detect substring before the
    // construction line.
    const detectIdx = src.search(/typeof\s+OfflineAudioContext\s*===\s*["']undefined["']/);
    // Match only the actual construction call site (preceded by
    // whitespace, an `=` or `(`) — a comment that mentions
    // `new OfflineAudioContext(...)` for documentation would
    // otherwise appear earlier than the real call.
    const constructIdx = src.search(/(?:^|[\s=(])\s*new\s+OfflineAudioContext\s*\(/m);
    expect(detectIdx, "renderProject() must feature-detect OfflineAudioContext before constructing it").toBeGreaterThan(
      -1,
    );
    expect(constructIdx, "renderProject() must construct OfflineAudioContext").toBeGreaterThan(-1);
    expect(detectIdx, "feature detection must run BEFORE the OfflineAudioContext construction call site").toBeLessThan(
      constructIdx,
    );
    // The error must be a named, machine-readable message so the
    // export UI can branch on it.
    expect(src).toMatch(/OfflineAudioContext is not available/);
  });

  it("EmbedApp feature-detects AudioContext before constructing it", () => {
    // Defect A06.D1 (browser compatibility audit): the embedded beat
    // player constructed `new AudioContext()` directly. A server-side
    // render or sandboxed iframe without the global would throw a
    // ReferenceError on the play button click. The fix feature-detects
    // and routes through the existing `phase: "error"` UI path.
    const src = readSrc(EMBED_PATH);
    expect(src).toMatch(/typeof\s+AudioContext\s*===\s*["']undefined["']/);
    // The unsupported branch must NOT throw — it must either return
    // early or surface a user-friendly error. The presence of the
    // "AudioContext" phrase in a user-facing message confirms the
    // graceful path.
    expect(src).toMatch(/AudioContext.*preview is disabled/);
  });

  it("worklet loader refuses to load into contexts without audioWorklet", () => {
    // Existing hardening: loadCoreWorklets / loadPluginWorklet short-
    // circuit when `ctx.audioWorklet` is undefined (jsdom, sandboxed
    // iframes, future engines). Pin the gate so a refactor that
    // drops it falls back to throwing on addModule() instead.
    const src = readSrc(LOADER_PATH);
    expect(src).toMatch(/!\s*ctx\??\.audioWorklet/);
  });

  it("AudioEngine's lifecycle path only attaches onstatechange when supported", () => {
    // Safari / iOS older revisions did not expose `onstatechange` as
    // a settable property (only as an event target via addEventListener).
    // The fix in useContext checks `typeof (ctx).onstatechange !==
    // "undefined"` before assigning. ensureContext routes new and recovered
    // contexts through useContext(), so the guard has one source of truth and
    // remains forward- and backward-compatible without a user-agent sniff.
    const src = readSrc(AUDIO_ENGINE_PATH);
    const useContext = src.slice(src.indexOf("useContext("));
    const ensureContext = src.slice(src.indexOf("ensureContext("));
    expect(useContext).toMatch(/typeof\s+\(ctx as AudioContext\)\.onstatechange\s*!==\s*["']undefined["']/);
    expect(ensureContext).toMatch(/this\.useContext\(ctx\)/);
  });

  it("does not rely on user-agent sniffing for any Web Audio decision", () => {
    // Defect A06.D3 (browser compatibility audit): the project must
    // feature-detect, not sniff the user-agent string, to decide
    // which Web Audio APIs to use. Pin by asserting no `navigator.
    // userAgent` / `navigator.userAgentData` references appear in
    // the audio-engine surface. Tests and dev-only tooling may use
    // UA inspection; production audio paths must not.
    const audioSrc = readSrc(AUDIO_ENGINE_PATH);
    const rendererSrc = readSrc(RENDERER_PATH);
    const embedSrc = readSrc(EMBED_PATH);
    for (const [name, src] of [
      ["AudioEngine.ts", audioSrc],
      ["renderer.ts", rendererSrc],
      ["EmbedApp.tsx", embedSrc],
    ] as const) {
      expect(
        src.toLowerCase().includes("useragent"),
        `${name} must not reference navigator.userAgent (feature-detect instead)`,
      ).toBe(false);
    }
  });
});
