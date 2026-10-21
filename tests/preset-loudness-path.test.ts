import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WORKLET_PATH_INSTRUMENTS, isWorkletPathInstrument } from "../src/presets/loudnessPath";

/**
 * LOUDNESS PATH CONTRACT (2026-10-21)
 *
 * The loudness map ("how loud is this preset") and the drift gate ("does the
 * map still describe this preset?") measure the SAME quantity, and two numbers
 * are only comparable when they come from the SAME synthesis.
 *
 * WHAT WENT WRONG (measured, not assumed): KOPA ships through the event-queue
 * worklet, and the map was recorded through that path. The gate measured the
 * NATIVE FALLBACK instead — it never loaded the worklet into its
 * OfflineAudioContext — and compared the fallback with the map:
 *
 *   map vs worklet   0.04 LU   (all 16 KOPA presets)
 *   map vs fallback  6.2-12.5 LU LOUDER (all 16)
 *
 * So the gate reported drift that was not drift, and its advice ("run npm run
 * presets:loudness") would have baked the fallback's level into the map — a
 * sound the product never exports. The map was never stale.
 *
 * THE RULE: the list of worklet-path instruments has ONE owner
 * (src/presets/loudnessPath.ts). The map generator and the drift gate both
 * read it, and the gate arms the worklet and the offline event queue before it
 * measures.
 *
 * Every structural check has a NEGATIVE CONTROL: the same detector is run
 * against a doctored copy of the source in scratch/ and has to report the
 * violation. A guard that cannot be shown to fail is not a guard.
 */

const ROOT = resolve(__dirname, "..");
const read = (relative: string) => readFileSync(resolve(ROOT, relative), "utf8");

/** The drift gate. Overridable so the guard can be falsified. */
const GATE_SOURCE = process.env.KYX_LOUDNESS_GATE_SOURCE ?? "src/browser-checks.ts";

/** The map generator. Overridable so the guard can be falsified. */
const GENERATOR_SOURCE = process.env.KYX_LOUDNESS_GENERATOR_SOURCE ?? "scripts/measure-preset-loudness.mjs";

const gate = read(GATE_SOURCE);
const generator = read(GENERATOR_SOURCE);

describe("preset loudness — the map and the drift gate must measure the same synthesis", () => {
  it("KOPA is a worklet-path instrument", () => {
    // KOPA's event-queue worklet is ALSO the production offline renderer
    // (ADR 0035), so the map has to describe the worklet — "the sound users
    // export, not only its emergency fallback".
    expect(isWorkletPathInstrument("kopa")).toBe(true);
    expect(WORKLET_PATH_INSTRUMENTS).toContain("kopa");
  });

  it("a native-path instrument is not on the list", () => {
    // The list is a list of WORKLET-path instruments. An instrument whose
    // factory returns a native runtime (the 808, the keys, the sampler) is
    // measured the same way by both consumers, so it must not be here.
    for (const instrument of ["808", "sampler", "analog", "keys"]) {
      expect(isWorkletPathInstrument(instrument), instrument).toBe(false);
    }
  });
});

/**
 * The measurement happens in the browser, so it is pinned structurally. Each
 * check is a detector over the source text, and each detector is run against a
 * doctored copy to prove it can fail.
 */
interface Contract {
  name: string;
  holds: (source: string) => boolean;
  target: "gate" | "generator";
}

const CONTRACTS: Contract[] = [
  {
    name: "the map generator reads the shared worklet-path rule",
    target: "generator",
    holds: (s) => /loudnessPath\.isWorkletPathInstrument\(preset\.instrument\)/.test(s),
  },
  {
    name: "the drift gate reads the shared worklet-path rule",
    target: "gate",
    holds: (s) => /isWorkletPathInstrument\(preset\.instrument\)/.test(s),
  },
  {
    name: "the drift gate loads the worklet into the context it measures",
    target: "gate",
    holds: (s) => /loadInstrumentWorklet\(ctx, workletType\)/.test(s),
  },
  {
    name: "the drift gate refuses to measure the fallback when the worklet is missing",
    target: "gate",
    holds: (s) => /isWorkletReady\(workletType, ctx\)/.test(s) && /refusing to measure the fallback/.test(s),
  },
  {
    name: "the drift gate arms the offline event queue before it renders",
    target: "gate",
    holds: (s) => /runtime\.prepareOfflineRender\?\.\(\)/.test(s),
  },
];

const SOURCES = { gate, generator } as const;

/** Write a doctored copy to scratch/ (git-ignored) and return its text. */
function doctoredCopy(name: string, source: string, mutate: (s: string) => string): string {
  const dir = resolve(ROOT, "scratch");
  mkdirSync(dir, { recursive: true });
  const mutated = mutate(source);
  writeFileSync(resolve(dir, name), mutated, "utf8");
  return mutated;
}

describe("preset loudness — the path contract (structural)", () => {
  it("holds for the shipped sources", () => {
    const broken = CONTRACTS.filter((c) => !c.holds(SOURCES[c.target])).map((c) => c.name);
    expect(broken, `the loudness path lost: ${broken.join("; ")}`).toEqual([]);
  });

  it("NEGATIVE CONTROL: each contract can be broken, and the detector notices", () => {
    const mutations: { contract: string; mutate: (s: string) => string }[] = [
      {
        contract: "the map generator reads the shared worklet-path rule",
        mutate: (s) =>
          s.replace(/loudnessPath\.isWorkletPathInstrument\(preset\.instrument\)/g, 'preset.instrument === "kopa"'),
      },
      {
        contract: "the drift gate reads the shared worklet-path rule",
        // The mutation that brings the bug back: the gate measures the
        // fallback and calls the map stale.
        mutate: (s) => s.replace(/isWorkletPathInstrument\(preset\.instrument\)/g, "false"),
      },
      {
        contract: "the drift gate loads the worklet into the context it measures",
        mutate: (s) => s.replace(/loadInstrumentWorklet\(ctx, workletType\)/g, "void workletType"),
      },
      {
        contract: "the drift gate refuses to measure the fallback when the worklet is missing",
        mutate: (s) => s.replace(/isWorkletReady\(workletType, ctx\)/g, "true"),
      },
      {
        contract: "the drift gate arms the offline event queue before it renders",
        mutate: (s) => s.replace(/runtime\.prepareOfflineRender\?\.\(\)/g, "/* not armed */"),
      },
    ];
    for (const { contract, mutate } of mutations) {
      const rule = CONTRACTS.find((c) => c.name === contract)!;
      const mutated = doctoredCopy(
        `loudness-path-${contract.replace(/\W+/g, "-").slice(0, 60)}.txt`,
        SOURCES[rule.target],
        mutate,
      );
      expect(rule.holds(mutated), `the mutation for "${contract}" did not break its contract`).toBe(false);
    }
  });
});
