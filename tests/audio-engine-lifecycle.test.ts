import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Source-grep regression tests for `AudioEngine.ts`.
 *
 * The engine is a 138 KB Web Audio graph that depends on a real
 * `BaseAudioContext` (jsdom provides none) and dozens of plugin
 * worklets. Behavioural unit tests would require either a headless
 * Chromium harness or a sprawling mock — both out of scope for a
 * hardening pass that should not redesign the subsystem.
 *
 * These tests pin the structural fixes from the Master DAW Hardening
 * pass (lifecyle / resource-leak audits) so a future refactor that
 * drops them shows up in CI, not in a postmortem. Each test reads
 * `src/audio-engine/AudioEngine.ts` directly and asserts that a
 * specific call site exists in the expected function.
 *
 * Pattern: read the file once per test, then assert on the textual
 * presence of a few key call lines. This is intentionally brittle —
 * the point is to catch a careless removal of the hardening code.
 */

const AUDIO_ENGINE_PATH = resolve(process.cwd(), "src/audio-engine/AudioEngine.ts");

function readEngine(): string {
  return readFileSync(AUDIO_ENGINE_PATH, "utf8");
}

function sliceFunction(source: string, signature: RegExp): string {
  // Extract the body of a method whose definition matches `signature`
  // (e.g. `/useContext\s*\(/` or `/panic\(\)\s*:\s*void\s*\{/`). We
  // deliberately require the method-defining signature — a bare
  // `panic(` would also match `runtime.panic()` invocations and pull
  // the wrong span. We then walk braces at the source level (ignoring
  // strings and comments is intentionally out of scope; the methods
  // we target have well-behaved bodies in this codebase).
  const start = source.search(signature);
  if (start < 0) return "";
  // Find the first `{` AFTER the signature — that's the method body.
  const openBrace = source.indexOf("{", start);
  if (openBrace < 0) return "";
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

describe("AudioEngine — lifecycle hardening (source-grep)", () => {
  it("useContext() disposes the previous context's runtimes, LFOs and graph state", () => {
    // Defect 1.1 (lifecycle audit): the only path that fully discards
    // the engine's prior graph state was also leaking every
    // per-track/per-return/per-group EffectRuntime plus every LFO
    // oscillator. The fix iterates the three node maps and the LFO
    // map BEFORE calling buildMaster(). Pin the call order here.
    const body = sliceFunction(readEngine(), /useContext\s*\(/);
    expect(body, "useContext not found in AudioEngine.ts").not.toBe("");
    const idxDispose = body.indexOf("disposeTrackNodes(");
    const idxBuildMaster = body.indexOf("buildMaster(");
    expect(idxDispose, "useContext must call disposeTrackNodes to clear prior EffectRuntimes").toBeGreaterThan(-1);
    expect(idxBuildMaster, "useContext must call buildMaster to rebuild the master chain").toBeGreaterThan(-1);
    // Dispose must run BEFORE buildMaster — otherwise the old runtimes
    // would still be wired into the old master and the new master
    // would briefly double the graph.
    expect(idxDispose, "useContext must dispose prior runtimes before buildMaster()").toBeLessThan(idxBuildMaster);
    // LFOs are part of the prior state and must be cleared too —
    // otherwise the LFO oscillator keeps modulating the (now stale)
    // target AudioParam.
    expect(body).toMatch(/this\.lfos\.clear\(\)/);
  });

  it("useContext() and ensureContext() register an onstatechange observer", () => {
    // Defect 1.2 (lifecycle audit): without an onstatechange listener
    // the engine never learns the AudioContext woke back up after a
    // tab-switch / screen-lock / OS-sleep. Both the freshly-created
    // context path (ensureContext) and the swap path (useContext)
    // must wire the observer.
    const engine = readEngine();
    const useContext = sliceFunction(engine, /useContext\s*\(/);
    const ensureContext = sliceFunction(engine, /ensureContext\s*\(/);
    expect(useContext).toMatch(/onstatechange\s*=/);
    expect(ensureContext).toMatch(/onstatechange\s*=/);
    // The observer must short-circuit when the engine has been re-bound
    // to a different context in the meantime, otherwise a stale context
    // can drive a fresh engine.
    expect(useContext).toMatch(/this\.ctx\s*===\s*ctx/);
  });

  it("panic() disposes LFO + follower state in BOTH the live-context and no-context paths", () => {
    // Defect 6.1 (resource-leak audit): panic() previously cleared
    // voices, frozen buffers and instrument runtimes, but never the
    // LFO/follower modulators. After a panic the user could still
    // hear "wet FX keeps going" because the LFO oscillator was
    // driving the FX AudioParam. The fix disposes the LFO state
    // BEFORE the instrument panic call, in both branches (live ctx
    // and the early-return when no context is bound).
    const body = sliceFunction(readEngine(), /panic\(\)\s*:\s*void\s*\{/);
    expect(body, "panic() not found in AudioEngine.ts").not.toBe("");
    // LFO dispose must appear at least twice — once in the
    // `if (!ctx) { ... }` branch and once after the live-context
    // branch opens.
    const disposeMatches = body.match(/disposeLfoRuntime\(/g) ?? [];
    expect(
      disposeMatches.length,
      "panic() must call disposeLfoRuntime in both no-ctx and live-ctx branches",
    ).toBeGreaterThanOrEqual(2);
    // The early-return path also clears voices, frozenBuffers and
    // instruments — the no-ctx panic was previously a no-op.
    const earlyReturn = body.indexOf("if (!ctx)");
    const earlyReturnEnd = body.indexOf("return;", earlyReturn);
    const earlyReturnBlock = body.slice(earlyReturn, earlyReturnEnd);
    expect(earlyReturnBlock).toMatch(/this\.voices\.clear\(\)/);
    expect(earlyReturnBlock).toMatch(/this\.lfos\.clear\(\)/);
  });

  it("useContext() clears voices, previewVoices, frozenBuffers and instrument runtimes", () => {
    // Defect A04.D1 (web audio graph lifecycle audit): the original
    // useContext() disposed the per-track EffectRuntimes and the LFO
    // state, but left `voices`, `previewVoices`, `frozenBuffers` and
    // the per-track instrument runtimes intact. After a context swap
    // (offline render → live context, or live → offline) those
    // AudioNodes still referenced the old context (memory leak) and
    // their `onended` callbacks could delete a fresh voice from the
    // matching Set when the old source finally finished (cross-context
    // identity corruption). The fix iterates each set/map, stops the
    // live source, and disconnects the gain before clearing.
    const body = sliceFunction(readEngine(), /useContext\s*\(/);
    expect(body, "useContext not found in AudioEngine.ts").not.toBe("");
    // The cleanup must clear all four collections. Check for the
    // .clear() calls specifically — a future refactor that drops one
    // of them will surface as a missing `.clear(` substring here.
    for (const cleared of [
      "this.voices.clear()",
      "this.previewVoices.clear()",
      "this.frozenBuffers.clear()",
      "this.frozenBufferIds.clear()",
    ]) {
      expect(body, `useContext() must call ${cleared} to discard old-context nodes`).toMatch(cleared);
    }
    // And panic the per-track instrument runtimes so a swapped context
    // doesn't keep the old AudioWorkletNode running.
    expect(body, "useContext() must panic per-track instrument runtimes before the swap").toMatch(
      /state\.runtime\.panic\(\)/,
    );
    // The voice cleanup must call .stop() AND .disconnect() on the
    // gain so the source's onended callback (which still mutates the
    // voices Set via `voices.delete(voice)`) cannot silently drop a
    // voice that belongs to the new context.
    const voiceBlock = body.slice(
      body.indexOf("for (const voice of this.voices)"),
      body.indexOf("this.voices.clear()"),
    );
    expect(voiceBlock).toMatch(/voice\.source\.stop\(\)/);
    expect(voiceBlock).toMatch(/voice\.gain\.disconnect\(\)/);
  });

  it("ensureContext() swallows a rejected resume() (recovery-path hardening)", () => {
    // Recovery-path audit: ctx.resume() rejects with NotAllowedError when
    // the browser has not granted user activation — the exact scenario
    // this best-effort resume targets (visibilitychange, first click on a
    // suspended context). An unguarded `void ctx.resume()` produced an
    // unhandled rejection on every suspended ensureContext() call.
    const body = sliceFunction(readEngine(), /ensureContext\s*\(/);
    expect(body, "ensureContext not found in AudioEngine.ts").not.toBe("");
    expect(body, "ensureContext() must catch a rejected resume()").toMatch(
      /ctx\.resume\(\)\.catch\(\(\)\s*=>\s*\{\}\)/,
    );
  });

  it("applyMasterConfig() passes the master ceiling to the native limiter in dBFS", () => {
    // DynamicsCompressorNode.threshold is a dBFS AudioParam. A regression to
    // the old linear-amplitude conversion makes negative ceilings invalid,
    // causes browser warnings, and silently changes the limiter's behaviour.
    const body = sliceFunction(readEngine(), /private\s+applyMasterConfig\s*\([^)]*\)\s*:\s*void\s*\{/);
    expect(body, "applyMasterConfig not found in AudioEngine.ts").not.toBe("");
    expect(body).toMatch(/const ceilingDb\s*=\s*Math\.min\(0,\s*Math\.max\(-12,\s*config\.ceilingDb\)\)/);
    expect(body).toMatch(/this\.masterLimiter\.threshold\.value\s*=\s*ceilingDb/);
    expect(body).not.toMatch(/Math\.pow\(10,\s*config\.ceilingDb\s*\/\s*20\)/);
  });
});
