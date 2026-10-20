import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The plugin audit measures things. These tests pin the MEASUREMENT contract
 * itself, because a wrong measurement is worse than no measurement: it reports
 * a healthy plugin as broken and, worse, a broken plugin as healthy.
 *
 * Every guard here was written because the audit got it wrong at least once.
 */

const ROOT = resolve(__dirname, "..");
const read = (relative: string) => readFileSync(resolve(ROOT, relative), "utf8");

/**
 * Which audit source to check. Overridable so the guard can be FALSIFIED
 * without editing production code: point it at a doctored copy and the
 * matching assertion must fail. A guard that cannot be shown to fail is not
 * a guard.
 */
const AUDIT_SOURCE = process.env.KYX_AUDIT_SOURCE ?? "src/plugin-audit-checks.ts";

const registry = read("src/instruments/registry.ts");
const audit = read(AUDIT_SOURCE);

/**
 * Instruments whose ONLY sound source is the track sample. Auditioning one of
 * these without a sample measures digital silence and reports a working
 * instrument as broken — the `choral` bug.
 */
const SAMPLE_ONLY = ["sampler", "granular", "vocalchop", "clav", "texture", "choral"];

/**
 * Instruments that read a sample but SYNTHESIZE without one. They are audible
 * either way, so auditioning them with a sample is not what makes them sound
 * — and adding them to the set would hide a real silence behind a sample.
 */
const HYBRID = ["tsar", "wavetable"];

/**
 * Instrument definitions are `const name: InstrumentDefinition = { kind: "x", … }`
 * blocks in one file. Split the file on `kind: "…"` and keep the text up to
 * the next definition, so each block is attributable to one instrument.
 */
function instrumentBlocks(source: string): Map<string, string> {
  const marker = /\n\s*kind:\s*"([a-z0-9]+)",/g;
  const hits = [...source.matchAll(marker)];
  const blocks = new Map<string, string>();
  for (let i = 0; i < hits.length; i++) {
    const kind = hits[i][1];
    const start = hits[i].index ?? 0;
    const end = i + 1 < hits.length ? (hits[i + 1].index ?? source.length) : source.length;
    blocks.set(kind, source.slice(start, end));
  }
  return blocks;
}

/** Instruments the registry declares with a `kind`, for a sanity floor. */
function registryKinds(): string[] {
  return [...instrumentBlocks(registry).keys()].sort();
}

/** The set the audit uses to decide "this instrument needs a sample to sound". */
function sampleDrivenSet(): Set<string> {
  const match = audit.match(/SAMPLE_DRIVEN_INSTRUMENTS = new Set\(\[([^\]]*)\]/);
  expect(match, "SAMPLE_DRIVEN_INSTRUMENTS must still exist in the audit").toBeTruthy();
  const raw = match?.[1] ?? "";
  return new Set([...raw.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]));
}

describe("plugin audit — sample-driven instruments", () => {
  it("auditions every sample-ONLY instrument WITH a sample", () => {
    // THE CHORAL BUG: `choral`'s worklet is a grain engine over the uploaded
    // source (ChoralProcessor.streamSample returns 0 with no PCM). It was
    // missing from the set, so the audit played it with no source, measured
    // digital silence, and reported a perfectly working instrument as broken.
    // Measured with a sample it is -6.9 dBFS with 12/12 params wired.
    const declared = sampleDrivenSet();
    const missing = SAMPLE_ONLY.filter((kind) => !declared.has(kind));
    expect(missing, `sample-only instruments the audit plays with no sample: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps the hybrid instruments out of the sample-driven set", () => {
    // tsar and wavetable read a sample but synthesize without one. Auditioning
    // them with a sample would let a real silence hide behind it.
    const declared = sampleDrivenSet();
    const wrong = HYBRID.filter((kind) => declared.has(kind));
    expect(wrong, `hybrid instruments must not be declared sample-driven: ${wrong.join(", ")}`).toEqual([]);
  });

  it("every sample-only instrument can actually reach a sample buffer", () => {
    // The DSP of some of these lives in its own module (choralNode.ts,
    // granularNode.ts, wtvoiceNode.ts), so the registry block alone is not the
    // whole story.
    const modules = ["registry.ts", "choralNode.ts", "granularNode.ts", "wtvoiceNode.ts", "tsarNode.ts", "kopaNode.ts"];
    const corpus = modules.map((file) => read(`src/instruments/${file}`)).join("\n");
    for (const kind of SAMPLE_ONLY) {
      expect(corpus, `no module in src/instruments reads a sample for ${kind}`).toMatch(/getSample/);
    }
  });

  it("the sample-only list names instruments that exist", () => {
    // A typo in the list would silently exempt a real instrument from the
    // audition, so the list is checked against the registry itself.
    const kinds = registryKinds();
    for (const kind of [...SAMPLE_ONLY, ...HYBRID]) {
      expect(kinds, `${kind} is listed but the registry has no such instrument`).toContain(kind);
    }
  });
});

describe("plugin audit — the host probe answers the question it declares", () => {
  it("keeps a mix-class wiring probe in the host test", () => {
    // `fingerprintOf` skips mix-class params on purpose (a dry/wet control
    // "only changes the level"), which makes it useless for the WIRING
    // question `hostProcesses` claims to answer. rezonans measured 5.9e-9
    // under its fingerprint and 7.2e-2 under mix, on the same document.
    expect(audit).toContain("hostMixDelta");
    expect(audit).toMatch(/hostProcesses:\s*hostDelta\.delta > HOST_EPS \|\| \(hostMixDelta \?\? 0\) > HOST_EPS/);
  });

  it("keeps an envelope term in the delta, because amplitude metrics are blind to a time reversal", () => {
    // reverseSwell's whole output lands in the first eighth of the buffer:
    // the amplitude stats reported 5.8e-11 for a 3.0e-3 signal. A per-segment
    // RMS envelope sees it (2.5e-2). Per-segment cross-correlation was
    // measured and rejected — it is blind to reverb (ratio 0.73).
    expect(audit).toContain("envelopeDelta");
    expect(audit).toContain('["env", relEnv]');
  });
});

describe("plugin audit — dead and gated are different columns", () => {
  it("reports gated parameters apart from dead ones", () => {
    // reverseSwell.engaged defaults to 0, so time/reach/curve/tone/level/mix
    // measured EXACTLY 0 at the defaults and are GATED, not dead. A work list
    // that calls them dead sends the next agent to wire up what already works.
    expect(audit).toContain("gatedParams");
    expect(audit).toContain("gatedDelta");
  });

  it("still separates the host exemption from an unexplained zero", () => {
    // vocoder and sidechain have no modulator/key track in the house doc, so
    // a zero host delta is the CORRECT output. Summing it with a real
    // failure overstated the defect count by a third.
    expect(audit).toContain("hostExemptReason");
  });
});
