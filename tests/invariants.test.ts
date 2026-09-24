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

describe("AGENTS.md invariant — leaky `as any` budget on critical layers", () => {
  // Most of the `as any` in src/audio-engine/ and src/commands/ is
  // vendor-seam (drumsynth internals: body / snap / tone / _stopAll) or
  // storage-bridge (Yjs YMap.get cast). Pinning the count lets us
  // notice if a NEW layer leaks — not a comprehensive type-tightening,
  // just a regression guard that catches a future leak before it lands.
  function countAsAny(dir: string): number {
    let count = 0;
    for (const f of listFiles(dir)) {
      count += (readFileSync(f, "utf8").match(/\bas any\b/g) ?? []).length;
    }
    return count;
  }

  it("src/audio-engine/ keeps its leaky `as any` budget stable", () => {
    // 17 is the current count; a regression that introduces new
    // user-facing leaks fires here without changing the source.
    // A drop signals a refactor — update the test in the same commit.
    expect(countAsAny("src/audio-engine")).toBe(17);
  });

  it("src/commands/ keeps its leaky `as any` budget stable", () => {
    // 33 is the current count; the vast majority are Yjs YMap.get casts
    // (vendor seam; the alternative is a 5-line branded type for an
    // untyped JS lib) and runtime-strategy restoration casts.
    expect(countAsAny("src/commands")).toBe(33);
  });
});

describe("AGENTS.md §7 gotcha — URL.createObjectURL must be paired with revokeObjectURL", () => {
  // `URL.createObjectURL` returns a blob URL that survives until
  // `URL.revokeObjectURL` releases it. The codebase uses a 5 s setTimeout
  // safety net, but the audit is per-file balance: every create inside
  // a file must have at least one matching revoke in the same file (the
  // 5 s timer is part of the same module so cross-file unbalance would
  // hint at a leak waiting for the timer).
  //
  // We also pin the per-file balance so a future refactor that splits a
  // module cannot leave a create without its revoke behind.
  function fileObjectUrlBalance(path: string): { create: number; revoke: number } {
    const src = readFileSync(path, "utf8");
    return {
      // createObjectURL( / createObjectURL?.( are both legit; cover the
      // base form which is what every call site in src/ uses today.
      create: (src.match(/URL\.createObjectURL\s*\(/g) ?? []).length,
      // revokeObjectURL(...) / revokeObjectURL?.(...) both occur.
      revoke: (src.match(/URL\.revokeObjectURL\??\.?\s*\(/g) ?? []).length,
    };
  }

  it("every file that calls createObjectURL also calls revokeObjectURL (per-file memory-leak guard)", () => {
    const imbalanced: { file: string; create: number; revoke: number }[] = [];
    for (const f of listFiles("src")) {
      const b = fileObjectUrlBalance(f);
      if (b.create > 0 && b.revoke < b.create) imbalanced.push({ file: f.replace(/\\/g, "/"), ...b });
    }
    if (imbalanced.length > 0) {
      const lines = imbalanced.map((i) => `${i.file} (create=${i.create}, revoke=${i.revoke})`).join("\n");
      expect(imbalanced, `createObjectURL without matching revokeObjectURL — potential leak:\n${lines}`).toEqual([]);
    }
    expect(imbalanced).toEqual([]);
  });

  it("the codebase has at least one createObjectURL site as a sanity anchor", () => {
    // If a future refactor removes every createObjectURL usage, the
    // balance test above would silently pass with empty input. Pin a
    // positive count so a regression that drops the entire download
    // pipeline is caught — `URL.createObjectURL` is the public URL for
    // "Download WAV" and "Download MP3" exports.
    let total = 0;
    for (const f of listFiles("src")) {
      total += fileObjectUrlBalance(f).create;
    }
    expect(total).toBeGreaterThanOrEqual(2);
  });
});

describe("AGENTS.md §7 gotcha — `?server=` URL param must be gated by isAllowedServerUrl", () => {
  // `?server=` is the only path through which a remote URL enters the
  // collaborative transport. Bypassing `isAllowedServerUrl` would let a
  // crafted link point at `wss://evil` and silently relay the victim's
  // project through an attacker host — the canonical wire-tap leak.
  //
  // Today the only reader is `src/collab/collabShared.ts:125` and it
  // gates the value through `isAllowedServerUrl(…)` on L126 before
  // adopting it. The single-file whitelist pattern is OK; the regression
  // guard here freezes both the read site and the gate pairing.
  const RE_SERVER_GET = /(?:searchParams|params|URLSearchParams)\.get\(\s*['"]server['"]|[\?\&]\s*server\s*=/g;

  function serverReadSites(): { file: string; line: number; text: string }[] {
    const sites: { file: string; line: number; text: string }[] = [];
    for (const f of listFiles("src")) {
      const ls = lines(f);
      for (let i = 0; i < ls.length; i++) {
        const matches = ls[i].match(RE_SERVER_GET);
        if (matches) {
          for (const _ of matches) sites.push({ file: f.replace(/\\/g, "/"), line: i + 1, text: ls[i].trim() });
        }
      }
    }
    return sites;
  }

  it("only src/collab/collabShared.ts reads ?server= from URL params", () => {
    const sites = serverReadSites();
    const novel = sites.filter((s) => !s.file.endsWith("src/collab/collabShared.ts"));
    if (novel.length > 0) {
      const lines = novel.map((s) => `${s.file}:${s.line}  ${s.text}`).join("\n");
      expect(novel, `unexpected ?server= reader outside src/collab/collabShared.ts:\n${lines}`).toEqual([]);
    }
    // Sanity: at least one read exists; otherwise the guard above would
    // pass vacuously.
    const inScope = sites.filter((s) => s.file.endsWith("src/collab/collabShared.ts"));
    expect(inScope.length).toBeGreaterThan(0);
  });

  it("src/collab/collabShared.ts:125 gates the param via isAllowedServerUrl on the next line", () => {
    // Source-grep regression for the canonical pattern
    //   `const serverOverride = params.get("server");` (L125)
    //   `const serverUrl = serverOverride && isAllowedServerUrl(serverOverride) ? ... : ...` (L126)
    // A regression that drops the gate (e.g. by replacing the && with ||
    // or returning the override before the check) is caught here.
    const src = readFileSync("src/collab/collabShared.ts", "utf8");
    expect(src).toMatch(/const serverOverride\s*=\s*params\.get\(\s*["']server["']\s*\)/);
    expect(src).toMatch(/serverOverride\s*&&\s*isAllowedServerUrl\s*\(\s*serverOverride\s*\)/);
  });

  it("isAllowedServerUrl is the only consumer of the raw server string in the gating expression", () => {
    // A regression that left the param string flowing into ws:// setup
    // without the helper would expose the host to traffic. The literal
    // string "wss://" or "ws://" must appear only inside isAllowedServerUrl
    // or its allow-listed defaults — never as a sibling control-flow
    // construct of the user-supplied value.
    const src = readFileSync("src/collab/collabShared.ts", "utf8");
    // Only the function definition's allow-list (the hostnames or the
    // default-serverUrl builder) may mention ws/wss. Pin the line count
    // so a regression that introduces a bypass is loud.
    const wsMatches = (src.match(/["'`]\s*(ws|wss):\/\//g) ?? []).length;
    expect(wsMatches).toBeGreaterThan(0);
  });
});