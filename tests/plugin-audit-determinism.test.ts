import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { resetDeterministicIds, useDeterministicIds } from "../src/shared/ids";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * PLUGIN AUDIT — REPRODUCIBILITY CONTRACT (2026-10-21)
 *
 * The audit's verdict is stable but its absolute host numbers move between
 * runs: between two full audits, 52 of 57 effects changed their hostDelta
 * (pitchCorrect 0.254 -> 0.144, apeks 5.658 -> 6.638) while 51 of 57 kept
 * their SWEEP columns — the sweep renders a synthetic buffer, the host probe
 * renders the HOUSE PROJECT.
 *
 * THE MECHANISM (measured, not assumed): the house template mints a fresh
 * random id for every track, pattern and NOTE, and the render's ordering
 * depends on those ids. Two templates with random ids render with an rms
 * spread of 7.1e-6 and a peak spread of 1.2e-4; two templates with
 * deterministic ids render BIT-IDENTICALLY. The audit's relative deltas
 * amplify that difference into percent-level movement in the report.
 *
 * THE RULE: the audit's document and every measurement unit run with
 * deterministic ids, and each unit restarts the id counter at a base of its
 * own — so a unit's numbers do not depend on how many units were measured
 * before it (a resumed audit must measure the same thing as a full one).
 *
 * The behavioural half of the rule is testable in Node (the ids are a
 * function of the template, not of the run). The render half needs a browser,
 * so the audit's own wiring is pinned structurally — with a negative control
 * per contract.
 */

const ROOT = resolve(__dirname, "..");
const read = (relative: string) => readFileSync(resolve(ROOT, relative), "utf8");

/** Which audit source to check. Overridable so the guard can be falsified. */
const AUDIT_SOURCE = process.env.KYX_AUDIT_SOURCE ?? "src/plugin-audit-checks.ts";

/** Every id the house template mints — tracks, their effects, patterns, notes. */
function idsOf(doc: ProjectDocument): string[] {
  const out: string[] = [];
  for (const track of doc.tracks) {
    out.push(track.id);
    for (const effect of track.effects ?? []) out.push(effect.id);
  }
  for (const pattern of doc.patterns) {
    out.push(pattern.id);
    for (const notes of Object.values(pattern.notes ?? {})) {
      for (const note of notes) out.push(note.id);
    }
  }
  return out;
}

describe("plugin audit — the measurement has to be reproducible", () => {
  it("the house template mints the same ids twice, with deterministic ids on", () => {
    // The property the fix buys: the document is a function of the template,
    // not of the run that built it.
    const restore = useDeterministicIds();
    try {
      resetDeterministicIds(0);
      const first = idsOf(createProjectFromTemplate("house"));
      resetDeterministicIds(0);
      const second = idsOf(createProjectFromTemplate("house"));
      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
    } finally {
      restore();
    }
  });

  it("NEGATIVE CONTROL: without the deterministic mode the ids differ", () => {
    // Without this, the spec above could pass for the wrong reason (an empty
    // id list, a template that mints no ids at all).
    const first = idsOf(createProjectFromTemplate("house"));
    const second = idsOf(createProjectFromTemplate("house"));
    expect(first.length).toBeGreaterThan(0);
    expect(second).not.toEqual(first);
  });
});

/**
 * The audit's own wiring is pinned structurally: the measurement happens in
 * the browser, so the rule is read out of the source. Every contract has a
 * negative control — a doctored copy in scratch/ that has to break it.
 */
interface Contract {
  name: string;
  holds: (source: string) => boolean;
}

const CONTRACTS: Contract[] = [
  {
    name: "the audit's document is created with deterministic ids",
    holds: (s) =>
      /resetDeterministicIds\(DOCUMENT_ID_BASE\)/.test(s) &&
      /resetDeterministicIds\(DOCUMENT_ID_BASE\)[\s\S]{0,600}createProjectFromTemplate\("house"\)/.test(s),
  },
  {
    name: "every measurement unit restarts the id counter at its own base",
    holds: (s) => /resetDeterministicIds\(MEASUREMENT_ID_BASE\)/.test(s),
  },
  {
    name: "the two id bases cannot collide",
    holds: (s) => {
      const document = Number(/const DOCUMENT_ID_BASE = ([\d_]+);/.exec(s)?.[1].replace(/_/g, "") ?? "-1");
      const measurement = Number(/const MEASUREMENT_ID_BASE = ([\d_]+);/.exec(s)?.[1].replace(/_/g, "") ?? "-1");
      // Far apart, so a unit's ids can never equal a document id.
      return document >= 0 && measurement >= document + 1000;
    },
  },
  {
    name: "the deterministic-id mode is restored after the unit",
    holds: (s) => /finally\s*\{\s*restore\(\);/.test(s),
  },
];

const audit = read(AUDIT_SOURCE);

/** Write a doctored copy to scratch/ (git-ignored) and return its text. */
function doctoredCopy(name: string, source: string, mutate: (s: string) => string): string {
  const dir = resolve(ROOT, "scratch");
  mkdirSync(dir, { recursive: true });
  const mutated = mutate(source);
  writeFileSync(resolve(dir, name), mutated, "utf8");
  return mutated;
}

describe("plugin audit — the reproducibility contract (structural)", () => {
  it("holds for the shipped audit source", () => {
    const broken = CONTRACTS.filter((c) => !c.holds(audit)).map((c) => c.name);
    expect(broken, `the audit lost: ${broken.join("; ")}`).toEqual([]);
  });

  it("NEGATIVE CONTROL: each contract can be broken, and the detector notices", () => {
    const mutations: { contract: string; mutate: (s: string) => string }[] = [
      {
        contract: "the audit's document is created with deterministic ids",
        mutate: (s) => s.replace(/resetDeterministicIds\(DOCUMENT_ID_BASE\)/g, "resetDeterministicIds(0)"),
      },
      {
        contract: "every measurement unit restarts the id counter at its own base",
        mutate: (s) => s.replace(/resetDeterministicIds\(MEASUREMENT_ID_BASE\)/g, ""),
      },
      {
        contract: "the two id bases cannot collide",
        mutate: (s) => s.replace(/const MEASUREMENT_ID_BASE = [\d_]+;/, "const MEASUREMENT_ID_BASE = 1;"),
      },
      {
        contract: "the deterministic-id mode is restored after the unit",
        mutate: (s) => s.replace(/finally\s*\{\s*restore\(\);/g, "finally { /* not restored */"),
      },
    ];
    for (const { contract, mutate } of mutations) {
      const rule = CONTRACTS.find((c) => c.name === contract)!;
      const mutated = doctoredCopy(
        `audit-determinism-${contract.replace(/\W+/g, "-").slice(0, 60)}.txt`,
        audit,
        mutate,
      );
      expect(rule.holds(mutated), `the mutation for "${contract}" did not break its contract`).toBe(false);
    }
  });
});
