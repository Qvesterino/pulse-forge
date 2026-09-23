/**
 * Architectural invariants from AGENTS.md §3 — source-grep regression
 * guards that catch any new violation at the lint-test boundary.
 *
 * Invariant #7:  "The audio context is shared across projects.
 *                 `useContext(ctx)` is the only path that creates
 *                 `AudioNode`s on a context."
 *
 * Invariant #10: "No innerHTML, no dangerouslySetInnerHTML, no eval, no
 *                 `new Function` anywhere in `src/`."
 *
 * Performance: every file under `src/` is read once, lazily, the first
 * time it is referenced and cached for the rest of the suite. With ~250
 * TypeScript files this brings the invariant walk from O(suite²) reads
 * down to O(suite + files).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_EXT = [".ts", ".tsx"];

const cache = new Map<string, string[]>();
function lines(path: string): string[] {
  let v = cache.get(path);
  if (!v) {
    v = readFileSync(path, "utf8").split(/\r?\n/);
    cache.set(path, v);
  }
  return v;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (SRC_EXT.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const AUDIO_NODE_FACTORIES = [
  "createGain",
  "createBufferSource",
  "createBuffer",
  "createOscillator",
  "createDelay",
  "createAnalyser",
  "createBiquadFilter",
  "createWaveShaper",
  "createDynamicsCompressor",
  "createStereoPanner",
  "createConvolver",
  "createPeriodicWave",
  "createChannelMerger",
  "createChannelSplitter",
  "createMediaStreamSource",
  "createMediaStreamDestination",
  "createScriptProcessor",
] as const;
const AUDIO_NODE_RE = new RegExp(`\\bctx\\.(${AUDIO_NODE_FACTORIES.join("|")})\\s*\\(`);

interface Hit {
  file: string;
  line: number;
  factory: string;
  text: string;
}

function audioNodeHits(dir: string): Hit[] {
  const hits: Hit[] = [];
  for (const f of listFiles(dir)) {
    const rel = f.replace(/\\/g, "/");
    lines(f).forEach((text, i) => {
      const m = text.match(AUDIO_NODE_RE);
      if (m) hits.push({ file: rel, line: i + 1, factory: m[1], text: text.trim() });
    });
  }
  return hits;
}

describe("AGENTS.md invariant #7 — AudioNode creation outside AudioEngine.useContext", () => {
  it("the audio worklet directory owns at least one AudioNode creation (sanity anchor)", () => {
    // AudioWorklet processors run outside the React tree and therefore
    // build their own voice graph — that is the deliberate carve-out the
    // invariant makes for `src/audio-worklets/`.
    const hits = audioNodeHits("src/audio-worklets");
    expect(hits.length, "expected at least one AudioNode creation under src/audio-worklets").toBeGreaterThan(0);
  });

  it("src/audio-engine/AudioEngine.ts and src/audio-engine/* own all canonical AudioNode creation", () => {
    // The engine is the only legitimate factory for AudioNodes on a
    // shared context. If a new entry point appears, AUDIO_NODE_FACTORIES
    // is updated and the engineer confirms routing via useContext.
    const files = listFiles("src/audio-engine");
    let total = 0;
    const seen = new Set<string>();
    for (const f of files) {
      for (const text of lines(f)) {
        const m = text.match(AUDIO_NODE_RE);
        if (m) {
          total++;
          seen.add(m[1]);
        }
      }
    }
    expect(total).toBeGreaterThan(0);
    for (const f of seen) expect(AUDIO_NODE_FACTORIES).toContain(f);
  });

  it("src/ui/* never creates AudioNodes directly — whitelist of 3 known pre-refactor sites", () => {
    // The whitelist below captures the CURRENT violation count for the
    // SpectralEditPanel helper that calls `ctx.createBuffer(source)`
    // directly via `services.engine.getLiveAudioContext()`. The intent
    // is for this list to SHRINK to zero as the panel migrates to
    // `engine.useContext(ctx, …)` — until then the test is the regression
    // guard that catches any *new* direct creation (a fourth site) before
    // it lands on main.
    const hits = audioNodeHits("src/ui");
    const knownSites = new Set([
      "src/ui/SpectralEditPanel.tsx:197",
      "src/ui/SpectralEditPanel.tsx:230",
      "src/ui/SpectralEditPanel.tsx:267",
    ]);
    const known: string[] = [];
    const novel: Hit[] = [];
    for (const h of hits) {
      const tag = `${h.file}:${h.line}`;
      if (knownSites.has(tag)) known.push(tag);
      else novel.push(h);
    }
    expect(known.length, "expected three known sites still present").toBe(3);
    expect(novel, "new AudioNode creation in src/ui outside AudioEngine.useContext").toEqual([]);
  });

  it("src/intent/audition.ts has a single known AudioNode site (playAuditionBuffer via playbackContext)", () => {
    // AI audition pipeline owns its own private context for candidate
    // preview; the standard pattern is for it to live behind a dedicated
    // playbackContext() helper (which already wraps engine.ensureContext
    // semantics). One site is the current contract.
    const hits = audioNodeHits("src/intent");
    const knownSites = new Set(["src/intent/audition.ts:104"]);
    const known: string[] = [];
    const novel: Hit[] = [];
    for (const h of hits) {
      const tag = `${h.file}:${h.line}`;
      if (knownSites.has(tag)) known.push(tag);
      else novel.push(h);
    }
    expect(known.length, "expected one known site in audition.ts").toBe(1);
    expect(novel, "new AudioNode creation in src/intent outside the audition pipeline").toEqual([]);
  });

  // Comprehensive cross-module invariant #7 guard. Modules in this list
  // have no legitimate reason to construct AudioNodes — anything that
  // appears here is by definition an invariant violation. The carve-outs
  // (audio-engine, audio-worklets, vendor DSP cores, offline-render
  // exporters, the intent audition pipeline) are explicitly allowed; UI
  // AudioNode creation is captured by the whitelist test above.
  // `src/intent` is handled by a dedicated test below because the
  // audition pipeline owns one known site.
  const AUDIO_NODE_FREE_DIRS = [
    "src/ai",
    "src/persistence",
    "src/midi",
    "src/collab",
    "src/generative",
    "src/analysis",
    "src/services",
    "src/project-model",
    "src/scheduler",
    "src/transport",
    "src/store",
  ];
  for (const dir of AUDIO_NODE_FREE_DIRS) {
    it(`no AudioNode factory calls under ${dir}/`, () => {
      const hits = audioNodeHits(dir);
      if (hits.length > 0) {
        const lines = hits.map((h) => `${h.file}:${h.line} [${h.factory}]  ${h.text}`).join("\n");
        expect(hits, `invariant #7 violations under ${dir}:\n${lines}`).toEqual([]);
      }
      expect(hits).toEqual([]);
    });
  }
});

describe("AGENTS.md invariant #9 — no Rust / WASM DSP path in the realtime layer", () => {
  // ADR 0005 keeps WASM as a future option. Today the realtime boundary
  // is AudioWorklet; the only WASM in the shipped app is non-DSP
  // (LAME mp3 encode lives under src/export/, not in audio-engine/ or
  // audio-worklets/). Pin the carve-out so a regression that imports a
  // WASM DSP kernel into the realtime layer is caught immediately.
  const WASM_FACTORIES = ["WebAssembly.compile", "WebAssembly.instantiate", "WebAssembly.compileStreaming", "WebAssembly.instantiateStreaming"];
  const WASM_DSP_IMPORT_RE = /import\s+(?:type\s+)?\w+\s+from\s+["'][^"']*\.wasm["']/;
  const REALTIME_DIRS = ["src/audio-engine", "src/audio-worklets"];

  function audioWasmHits(): { file: string; line: number; text: string; rule: string }[] {
    const out: { file: string; line: number; text: string; rule: string }[] = [];
    for (const dir of REALTIME_DIRS) {
      for (const f of listFiles(dir)) {
        const rel = f.replace(/\\/g, "/");
        const ls = lines(f);
        for (let i = 0; i < ls.length; i++) {
          const text = ls[i];
          for (const factory of WASM_FACTORIES) {
            if (text.includes(factory)) {
              out.push({ file: rel, line: i + 1, text: text.trim(), rule: factory });
            }
          }
          if (WASM_DSP_IMPORT_RE.test(text)) {
            out.push({ file: rel, line: i + 1, text: text.trim(), rule: "import .wasm" });
          }
        }
      }
    }
    return out;
  }

  it("no WebAssembly DSP path is linked from src/audio-engine or src/audio-worklets", () => {
    const violations = audioWasmHits();
    if (violations.length > 0) {
      const lines = violations.map((v) => `${v.file}:${v.line} [${v.rule}]  ${v.text}`).join("\n");
      expect(violations, `invariant #9 violations:\n${lines}`).toEqual([]);
    }
    expect(violations).toEqual([]);
  });
});

describe("AGENTS.md invariant #10 — no innerHTML / eval / new Function in src/", () => {
  const VIOLATION_RULES: [RegExp, string][] = [
    [/dangerouslySetInnerHTML\b/, "dangerouslySetInnerHTML"],
    [/\binnerHTML\b/, "innerHTML"],
    [/\beval\s*\(/, "eval("],
    [/\bnew\s+Function\s*\(/, "new Function("],
  ];

  function findViolations(): { file: string; line: number; rule: string; text: string }[] {
    const out: { file: string; line: number; rule: string; text: string }[] = [];
    for (const f of listFiles("src")) {
      const rel = f.replace(/\\/g, "/");
      const ls = lines(f);
      for (let i = 0; i < ls.length; i++) {
        const text = ls[i];
        for (const [re, rule] of VIOLATION_RULES) {
          if (re.test(text)) out.push({ file: rel, line: i + 1, rule, text: text.trim() });
        }
      }
    }
    return out;
  }

  it("no dangerous DOM or runtime-eval escape hatches anywhere in src/", () => {
    const violations = findViolations();
    if (violations.length > 0) {
      // Render a triage list in the failure message so the regression is
      // immediately fixable instead of buried in a stack trace.
      const lines = violations.map((v) => `${v.file}:${v.line} [${v.rule}]  ${v.text}`).join("\n");
      expect(violations, `invariant #10 violations:\n${lines}`).toEqual([]);
    }
    expect(violations).toEqual([]);
  });
});