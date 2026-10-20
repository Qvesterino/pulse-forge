import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EFFECT_META } from "../src/effects/definitions";
import type { FingerprintSweep } from "../src/plugin-audit-fingerprint";

/**
 * PLUGIN AUDIT HOST PROBE CONTRACT (2026-10-25)
 *
 * The audit answers "is this effect actually processing in the host graph?"
 * with a TIMBRE probe (the effect's own knob changes the sound) and a WIRING
 * probe (the mix class at max changes the sound). Both probes can report a
 * perfectly working effect as dead, and both did:
 *
 *   1. FINGERPRINT — the probe turns a knob into the state with the biggest
 *      change against the DEFAULT render. For a parameter whose default sits
 *      ON an extreme, that state is the one that switches the device OFF.
 *      MEASURED on pitchCorrect: `amount` defaults to 1 (full retune) and
 *      its minimum is 0 (NO retune) — the biggest change against the
 *      default AND a perfect passthrough. The probe read 6.9e-9 for that
 *      state while the same effect at its defaults read 0.108 on the same
 *      material.
 *
 *   2. MATERIAL — the probe fed every effect a DRUM bus. A pitch corrector
 *      has nothing to correct in a kick. MEASURED with the house kit's real
 *      drum samples: the drum bus moved the pitch corrector by 8.5e-5, the
 *      808 bass by 5.4e-9, and the melodic "Chords" track by 0.108.
 *
 * The rule lives in src/plugin-audit-fingerprint.ts (Node-pure, so it can be
 * proven here) and the material logic in src/plugin-audit-checks.ts (it needs
 * a real render, so it is pinned structurally).
 *
 * Every structural check has a NEGATIVE CONTROL: the same detector is run
 * against a doctored copy of the source in scratch/ and has to report the
 * violation. A guard that cannot be shown to fail is not a guard.
 */

const ROOT = resolve(__dirname, "..");
const read = (relative: string) => readFileSync(resolve(ROOT, relative), "utf8");

/** Which audit source to check. Overridable so the guard can be falsified. */
const AUDIT_SOURCE = process.env.KYX_AUDIT_SOURCE ?? "src/plugin-audit-checks.ts";

/** Which fingerprint rule to check. */
const FINGERPRINT_SOURCE = process.env.KYX_FINGERPRINT_SOURCE ?? "src/plugin-audit-fingerprint.ts";

/** Which gate module decides the harness fingerprint. */
const GATE_SOURCE = process.env.KYX_GATE_SOURCE ?? "scripts/lib/plugin-audit-gate.mjs";

/**
 * Which fingerprint RULE to test.
 *
 * Overridable so the guard can be FALSIFIED against a doctored copy: point it
 * at a copy whose dry-reference gate is gone and the behavioural specs below
 * must fail. A guard that cannot be shown to fail is not a guard.
 */
const FINGERPRINT_MODULE = process.env.KYX_FINGERPRINT_MODULE ?? "../src/plugin-audit-fingerprint";

const { MIX_CLASS_IDS, fingerprintOf } = (await import(
  FINGERPRINT_MODULE
)) as typeof import("../src/plugin-audit-fingerprint");

const audit = read(AUDIT_SOURCE);
const fingerprintSource = read(FINGERPRINT_SOURCE);
const gateSource = read(GATE_SOURCE);

/**
 * The pitchCorrect sweep as the baseline report recorded it, with the
 * dry-reference deltas measured on the house material.
 *
 * `amount` is the regression case: default 1 (full retune), minimum 0 (no
 * retune). The minimum is both the biggest change against the default and a
 * passthrough — the two conditions a fingerprint must satisfy pull in
 * opposite directions exactly here.
 */
const PITCH_CORRECT_SWEEP: FingerprintSweep = {
  type: "pitchCorrect",
  params: [
    {
      id: "amount",
      delta: 0.08568352699979966,
      bestExtreme: "min",
      extremes: [
        { extreme: "min", value: 0, delta: 0.08568352699979966, dryDelta: 1.06e-5 },
        { extreme: "max", value: 1, delta: 0, dryDelta: 0.07892127389698846 },
      ],
    },
    {
      id: "speed",
      delta: 0.08792514022811561,
      bestExtreme: "min",
      extremes: [
        { extreme: "min", value: 0, delta: 0.08792514022811561, dryDelta: 0.07892127389698846 },
        { extreme: "max", value: 1, delta: 0, dryDelta: 0.07892127389698846 },
      ],
    },
    {
      id: "root",
      delta: 0.07947605230516241,
      bestExtreme: "max",
      extremes: [
        { extreme: "min", value: 0, delta: 0, dryDelta: 0.07892127389698846 },
        { extreme: "max", value: 11, delta: 0.07947605230516241, dryDelta: 0.07892127389698846 },
      ],
    },
    {
      id: "scaleMode",
      delta: 0.07947605230516241,
      bestExtreme: "max",
      extremes: [
        { extreme: "min", value: 0, delta: 0, dryDelta: 0.07892127389698846 },
        { extreme: "max", value: 2, delta: 0.07947605230516241, dryDelta: 0.07892127389698846 },
      ],
    },
    {
      id: "mix",
      delta: 0.08568352699979966,
      bestExtreme: "min",
      extremes: [
        { extreme: "min", value: 0, delta: 0.08568352699979966, dryDelta: 0.07892127389698846 },
        { extreme: "max", value: 1, delta: 0, dryDelta: 0.07892127389698846 },
      ],
    },
  ],
};

/** The rule the audit used before: the biggest change against the default, nothing else. */
function oldFingerprintRule(sweep: FingerprintSweep): { id: string; value: number }[] {
  return [...sweep.params]
    .filter((p) => !MIX_CLASS_IDS.has(p.id))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 2)
    .map((p) => {
      const def = EFFECT_META[sweep.type].params.find((d) => d.id === p.id)!;
      return { id: p.id, value: p.bestExtreme === "min" ? def.min : def.max };
    });
}

/** The dry-reference delta of a fingerprint state, as the sweep measured it. */
function dryDeltaOf(sweep: FingerprintSweep, id: string, value: number): number | undefined {
  for (const p of sweep.params) {
    for (const e of p.extremes ?? []) {
      if (p.id === id && e.value === value) return e.dryDelta;
    }
  }
  return undefined;
}

describe("plugin audit — the fingerprint must be a state the effect still processes in", () => {
  it("never picks a passthrough state", () => {
    // The whole point: `amount=0` is the biggest change against the default
    // and a perfect passthrough. A fingerprint that lands there measures the
    // dry signal against the dry signal.
    expect(fingerprintOf(PITCH_CORRECT_SWEEP)).not.toContainEqual({ id: "amount", value: 0 });
  });

  it("NEGATIVE CONTROL: the old rule really did pick that passthrough state", () => {
    // Without this, the test above could pass for the wrong reason (a typo in
    // the fixture, a param renamed, a filter that dropped everything).
    expect(oldFingerprintRule(PITCH_CORRECT_SWEEP)).toContainEqual({ id: "amount", value: 0 });
  });

  it("only picks states that still change the signal", () => {
    for (const state of fingerprintOf(PITCH_CORRECT_SWEEP)) {
      const dryDelta = dryDeltaOf(PITCH_CORRECT_SWEEP, state.id, state.value);
      expect(dryDelta, `fingerprint state ${state.id}=${state.value} has no measured dry delta`).toBeDefined();
      expect(dryDelta!, `fingerprint state ${state.id}=${state.value} is a passthrough`).toBeGreaterThan(0.005);
    }
  });

  it("keeps the mix class out of the timbre fingerprint", () => {
    // A dry/wet control "only changes the level" — it answers the wiring
    // question, not the timbre one.
    for (const state of fingerprintOf(PITCH_CORRECT_SWEEP)) {
      expect(MIX_CLASS_IDS.has(state.id)).toBe(false);
    }
  });

  it("still returns a state when nothing is engaged", () => {
    // A sweep whose every extreme is a passthrough must not leave the probe
    // without a knob to turn.
    const dead: FingerprintSweep = {
      type: "pitchCorrect",
      params: [
        {
          id: "amount",
          delta: 0.2,
          bestExtreme: "min",
          extremes: [{ extreme: "min", value: 0, delta: 0.2, dryDelta: 0 }],
        },
      ],
    };
    expect(fingerprintOf(dead).length).toBeGreaterThan(0);
  });

  it("keeps the hand-declared overrides", () => {
    // reverseSwell needs `engaged` AND a short `time` — no automatic ranking
    // finds that pair.
    expect(fingerprintOf({ type: "reverseSwell", params: [] })).toEqual([
      { id: "engaged", value: 1 },
      { id: "time", value: 0.25 },
    ]);
  });
});

/**
 * The material and the dry reference are measured in the browser, so they are
 * pinned structurally. Each check is a detector over the source text, and
 * each detector is run against a doctored copy to prove it can fail.
 */
interface Contract {
  name: string;
  holds: (source: string) => boolean;
  /** The source this contract is checked against. */
  target: "audit" | "fingerprint" | "gate";
}

const CONTRACTS: Contract[] = [
  {
    name: "the sweep measures every stimulus against its own dry reference",
    target: "audit",
    holds: (s) => /renderDry\(dynamicsSignal\)/.test(s) && /renderDry\(broadbandSignal\)/.test(s),
  },
  {
    name: "the fingerprint rule filters passthrough states by the dry delta",
    target: "fingerprint",
    holds: (s) => /dryDelta\s*>\s*HOST_EPS/.test(s),
  },
  {
    name: "the host test can put the effect on more than the drum bus",
    target: "audit",
    holds: (s) => /function hostMaterials/.test(s) && /melodic: true/.test(s),
  },
  {
    name: "the host test falls back to another material when one does not engage",
    target: "audit",
    holds: (s) => /candidate\.engages/.test(s),
  },
  {
    name: "the report records the material and the state the verdict came from",
    target: "audit",
    holds: (s) => /hostMaterial\??:/.test(s) && /hostState\??:/.test(s),
  },
  {
    name: "the fingerprint rule belongs to the harness fingerprint",
    target: "gate",
    holds: (s) => /plugin-audit-fingerprint/.test(s),
  },
];

const SOURCES = { audit, fingerprint: fingerprintSource, gate: gateSource } as const;

/** Write a doctored copy to scratch/ (git-ignored) and return its text. */
function doctoredCopy(name: string, source: string, mutate: (s: string) => string): string {
  const dir = resolve(ROOT, "scratch");
  mkdirSync(dir, { recursive: true });
  const mutated = mutate(source);
  writeFileSync(resolve(dir, name), mutated, "utf8");
  return mutated;
}

describe("plugin audit — the host probe contract (structural)", () => {
  it("holds for the shipped sources", () => {
    const broken = CONTRACTS.filter((c) => !c.holds(SOURCES[c.target])).map((c) => c.name);
    expect(broken, `the audit host probe lost: ${broken.join("; ")}`).toEqual([]);
  });

  it("NEGATIVE CONTROL: each contract can be broken, and the detector notices", () => {
    // One mutation per contract. If a mutation does not break its contract,
    // the contract is not actually testing anything.
    const mutations: { contract: string; mutate: (s: string) => string }[] = [
      {
        contract: "the sweep measures every stimulus against its own dry reference",
        mutate: (s) =>
          s
            .replace(/renderDry\(dynamicsSignal\)/g, "dryOf(dynamicsSignal)")
            .replace(/renderDry\(broadbandSignal\)/g, "dryOf(broadbandSignal)"),
      },
      {
        contract: "the fingerprint rule filters passthrough states by the dry delta",
        mutate: (s) => s.replace(/c\.dryDelta\s*>\s*HOST_EPS/g, "c.dryDelta >= 0"),
      },
      {
        contract: "the host test can put the effect on more than the drum bus",
        mutate: (s) => s.replace(/melodic: true/g, "melodic: false"),
      },
      {
        contract: "the host test falls back to another material when one does not engage",
        mutate: (s) => s.replace(/candidate\.engages/g, "false"),
      },
      {
        contract: "the report records the material and the state the verdict came from",
        mutate: (s) => s.replace(/hostMaterial\??:/g, "hiddenMaterial?:").replace(/hostState\??:/g, "hiddenState?:"),
      },
      {
        contract: "the fingerprint rule belongs to the harness fingerprint",
        mutate: (s) => s.replace(/plugin-audit-fingerprint/g, "plugin-audit-other"),
      },
    ];
    for (const { contract, mutate } of mutations) {
      const rule = CONTRACTS.find((c) => c.name === contract)!;
      const mutated = doctoredCopy(
        `contract-${contract.replace(/\W+/g, "-").slice(0, 60)}.txt`,
        SOURCES[rule.target],
        mutate,
      );
      expect(rule.holds(mutated), `the mutation for "${contract}" did not break its contract`).toBe(false);
    }
  });
});
