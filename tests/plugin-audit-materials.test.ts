import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { HostMaterial } from "../src/plugin-audit-materials";

/**
 * PLUGIN AUDIT MATERIAL CONTRACT (2026-10-25)
 *
 * The audit asks "is this effect actually processing in the host graph?" by
 * measuring it against a MATERIAL. A material that cannot excite the effect
 * reports a working effect as dead — and that is exactly what happened to
 * SPAN (`sirka`).
 *
 * THE FACT (measured, not assumed): the house template is a MONO mix. The drum
 * bus renders `side = 0` bit-exactly, and so does every melodic track, because
 * every source in the doc is a mono sample played down the middle. SPAN is a
 * per-band mid/side rescaler (`L' = M + w·S`), so with `S = 0` in every band
 * every width is a mathematical no-op — the processor's own header calls width
 * 1 a "mathematically neutral pass-through". The audit was right about the
 * signal and wrong about the effect.
 *
 * THE RULE: the material list ends with a SPREAD KIT — the same drum bus with
 * its pads panned, so the stereo imager sees side energy IN FRONT of the
 * insert chain. It ends with it because the order is the blast radius: an
 * effect that already processes on the mono drum bus keeps exactly the
 * measurement it had, and only the effects no mono material can excite ever
 * reach the stereo one.
 *
 * The rule lives in src/plugin-audit-materials.ts (Node-pure, so it can be
 * proven here without a browser). The probe that APPLIES it lives in
 * src/plugin-audit-checks.ts (it needs a real render, so it is pinned
 * structurally).
 *
 * Every structural check has a NEGATIVE CONTROL: the same detector is run
 * against a doctored copy of the source in scratch/ and has to report the
 * violation. A guard that cannot be shown to fail is not a guard.
 */

const ROOT = resolve(__dirname, "..");
const read = (relative: string) => readFileSync(resolve(ROOT, relative), "utf8");

/** Which audit source to check. Overridable so the guard can be falsified. */
const AUDIT_SOURCE = process.env.KYX_AUDIT_SOURCE ?? "src/plugin-audit-checks.ts";

/** Which gate module decides the harness fingerprint. */
const GATE_SOURCE = process.env.KYX_GATE_SOURCE ?? "scripts/lib/plugin-audit-gate.mjs";

/**
 * Which MATERIAL RULE to test.
 *
 * Overridable so the guard can be FALSIFIED against a doctored copy: point it
 * at a copy whose material list has no stereo material and the behavioural
 * specs below must fail.
 */
const MATERIALS_MODULE = process.env.KYX_MATERIALS_MODULE ?? "../src/plugin-audit-materials";

const {
  hostMaterials: shippedHostMaterials,
  spreadKitDoc: shippedSpreadKitDoc,
  materialDoc,
} = (await import(MATERIALS_MODULE)) as typeof import("../src/plugin-audit-materials");

const house = createProjectFromTemplate("house");

/**
 * The contract the material list has to satisfy.
 *
 * Written as a predicate over a material LIST, not over the implementation, so
 * the rule the audit used before the spread kit existed can be run through it
 * too — that is the negative control.
 */
function hasStereoMaterialLast(materials: HostMaterial[]): boolean {
  const stereo = materials.filter((m) => typeof m.prepare === "function");
  if (stereo.length !== 1) return false;
  const last = materials[materials.length - 1];
  if (last !== stereo[0]) return false;
  if (last.melodic) return false;
  // The stereo material has to sit on the drum bus — that is the track the
  // house template plays and the one the kit lives on.
  const drum = materials.find((m) => !m.melodic);
  return Boolean(drum) && drum!.trackId === last.trackId;
}

/**
 * The rule the audit used before: the drum bus and the melodic tracks, and
 * nothing else. A stereo imager had no material that could excite it.
 */
function oldHostMaterials(doc: ReturnType<typeof createProjectFromTemplate>): HostMaterial[] {
  const materials: HostMaterial[] = [];
  const drum = doc.tracks.find((t) => t.kind === "drum");
  if (!drum) throw new Error("house template lost its drum track");
  materials.push({ trackId: drum.id, label: `${drum.name} (drum bus)`, melodic: false });
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId) ?? doc.patterns[0];
  for (const trackId of Object.keys(pattern?.notes ?? {})) {
    if (trackId === drum.id) continue;
    const notes = pattern?.notes?.[trackId] ?? [];
    if (notes.length === 0) continue;
    const track = doc.tracks.find((t) => t.id === trackId);
    if (!track) continue;
    materials.push({ trackId, label: `${track.name} (melodic)`, melodic: true });
  }
  return materials;
}

/** The drum pads the house pattern actually plays. */
function triggeredPads(doc: ReturnType<typeof createProjectFromTemplate>): string[] {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId) ?? doc.patterns[0];
  return Object.entries(pattern?.rows ?? {})
    .filter(([, steps]) => steps.some((v) => v > 0))
    .map(([padId]) => padId);
}

describe("plugin audit — the material must be able to excite the effect", () => {
  it("offers a stereo material, and offers it LAST", () => {
    const materials = shippedHostMaterials(house);
    expect(
      hasStereoMaterialLast(materials),
      `the material list has no stereo material at the end: ${materials.map((m) => m.label).join(", ")}`,
    ).toBe(true);
  });

  it("NEGATIVE CONTROL: the old mono-only rule does not satisfy the contract", () => {
    // Without this, the spec above could pass for the wrong reason (a typo in
    // the fixture, a doc whose drum track is missing, a predicate that always
    // returns true).
    expect(hasStereoMaterialLast(oldHostMaterials(house))).toBe(false);
  });

  it("keeps the drum bus first — the order is the blast radius", () => {
    // An effect that already processes on the drum bus must keep exactly the
    // measurement it had. If the spread kit came FIRST, every effect in the
    // audit would be re-measured on a different document.
    const materials = shippedHostMaterials(house);
    expect(materials[0].melodic).toBe(false);
    expect(materials[0].label).toContain("drum bus");
    expect(materials[0].prepare).toBeUndefined();
  });

  it("still offers the melodic tracks", () => {
    // A drum bus cannot excite every device — a pitch corrector has nothing
    // to correct in a kick. MEASURED: the chords track reads 0.108 on
    // pitchCorrect where the drum bus reads 8.5e-5.
    const melodic = shippedHostMaterials(house).filter((m) => m.melodic);
    expect(melodic.length).toBeGreaterThan(0);
    expect(melodic.map((m) => m.label).join(", ")).toContain("melodic");
  });

  it("spreads the pads the house pattern actually plays", () => {
    // A spread kit that pans pads nobody plays is a spread kit with no side
    // energy, and the whole point of the material is the side energy.
    const prepared = shippedSpreadKitDoc(house);
    const drum = prepared.tracks.find((t) => t.kind === "drum");
    if (!drum || drum.kind !== "drum") throw new Error("house template lost its drum track");
    const pans = new Map(drum.pads.map((p) => [p.id, p.pan]));
    const played = triggeredPads(house);
    expect(played.length).toBeGreaterThan(0);
    for (const padId of played) {
      expect(Math.abs(pans.get(padId) ?? 0)).toBeGreaterThan(0);
    }
  });

  it("does not mutate the shared base document", () => {
    // The base doc is shared by every material and by every effect. A material
    // that panned the shared kit would poison every measurement after it.
    const before = JSON.stringify(house);
    shippedSpreadKitDoc(house);
    expect(JSON.stringify(house)).toBe(before);
  });

  it("keeps the track and pad ids — the effect still lands on the drum bus", () => {
    const prepared = shippedSpreadKitDoc(house);
    expect(prepared.tracks.map((t) => t.id)).toEqual(house.tracks.map((t) => t.id));
    const drum = prepared.tracks.find((t) => t.kind === "drum");
    const baseDrum = house.tracks.find((t) => t.kind === "drum");
    if (!drum || !baseDrum || drum.kind !== "drum" || baseDrum.kind !== "drum") {
      throw new Error("house template lost its drum track");
    }
    expect(drum.pads.map((p) => p.id)).toEqual(baseDrum.pads.map((p) => p.id));
  });

  it("renders the mono materials on the shared document", () => {
    // The drum bus and the melodic tracks are the SAME document as the base —
    // changing that would re-measure 56 healthy effects on a different mix.
    for (const material of shippedHostMaterials(house)) {
      if (material.prepare) continue;
      expect(materialDoc(house, material)).toBe(house);
    }
  });

  it("renders the stereo material on the prepared document", () => {
    // THE rule: the probe must render the SPREAD kit, not the mono bus. A
    // `materialDoc` that ignored `prepare` would hand the imager the same
    // mono signal it always got, and the effect would keep reading dead.
    const stereo = shippedHostMaterials(house).find((m) => typeof m.prepare === "function");
    if (!stereo) throw new Error("the material list has no stereo material");
    const doc = materialDoc(house, stereo);
    expect(doc).not.toBe(house);
    const drum = doc.tracks.find((t) => t.kind === "drum");
    if (!drum || drum.kind !== "drum") throw new Error("house template lost its drum track");
    expect(drum.pads.some((p) => p.pan !== 0)).toBe(true);
  });
});

/**
 * The probe applies the material rule in the browser, so it is pinned
 * structurally. Each check is a detector over the source text, and each
 * detector is run against a doctored copy to prove it can fail.
 */
interface Contract {
  name: string;
  holds: (source: string) => boolean;
  target: "audit" | "gate";
}

/**
 * The body of the host probe — the function that renders one material.
 *
 * Scoped because the interaction block further down the file legitimately
 * builds its stores from the base doc; a detector over the whole file would
 * have to know about that, and a detector that has to know about everything
 * eventually stops knowing about anything.
 */
function probeBody(source: string): string {
  const start = source.indexOf("async function probeHostMaterial");
  if (start < 0) return "";
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? source.length : end);
}

const CONTRACTS: Contract[] = [
  {
    name: "the host probe asks the material rule for its document",
    target: "audit",
    holds: (s) => /materialDoc\(base,\s*material\)/.test(s),
  },
  {
    name: "the host probe builds its stores from the prepared document",
    target: "audit",
    holds: (s) => {
      // Scoped to the probe: the interaction block below it legitimately
      // builds stores from the base doc.
      const body = probeBody(s);
      return /new ProjectStore\(doc\)/.test(body) && !/new ProjectStore\(base\)/.test(body);
    },
  },
  {
    name: "the material rule belongs to the harness fingerprint",
    target: "gate",
    holds: (s) => /plugin-audit-materials/.test(s),
  },
];

const SOURCES = { audit: read(AUDIT_SOURCE), gate: read(GATE_SOURCE) } as const;

/** Write a doctored copy to scratch/ (git-ignored) and return its text. */
function doctoredCopy(name: string, source: string, mutate: (s: string) => string): string {
  const dir = resolve(ROOT, "scratch");
  mkdirSync(dir, { recursive: true });
  const mutated = mutate(source);
  writeFileSync(resolve(dir, name), mutated, "utf8");
  return mutated;
}

describe("plugin audit — the material contract (structural)", () => {
  it("holds for the shipped sources", () => {
    const broken = CONTRACTS.filter((c) => !c.holds(SOURCES[c.target])).map((c) => c.name);
    expect(broken, `the audit host probe lost: ${broken.join("; ")}`).toEqual([]);
  });

  it("NEGATIVE CONTROL: each contract can be broken, and the detector notices", () => {
    const mutations: { contract: string; mutate: (s: string) => string }[] = [
      {
        contract: "the host probe asks the material rule for its document",
        mutate: (s) => s.replace(/materialDoc\(base,\s*material\)/g, "base"),
      },
      {
        contract: "the host probe builds its stores from the prepared document",
        mutate: (s) => s.replace(/new ProjectStore\(doc\)/g, "new ProjectStore(base)"),
      },
      {
        contract: "the material rule belongs to the harness fingerprint",
        mutate: (s) => s.replace(/plugin-audit-materials/g, "plugin-audit-other"),
      },
    ];
    for (const { contract, mutate } of mutations) {
      const rule = CONTRACTS.find((c) => c.name === contract)!;
      const mutated = doctoredCopy(
        `material-contract-${contract.replace(/\W+/g, "-").slice(0, 60)}.txt`,
        SOURCES[rule.target],
        mutate,
      );
      expect(rule.holds(mutated), `the mutation for "${contract}" did not break its contract`).toBe(false);
    }
  });
});
