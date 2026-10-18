/**
 * Auditor-coverage gate — the machine-checked half of
 * `tests/referential-integrity.test.ts`.
 *
 * The referential auditor answers "does every reference in this document
 * resolve?". Its coverage is the part that rots: a new persisted field that
 * points at another entity is invisible to it until somebody remembers to add
 * it, and nothing fails in the meantime. This file makes the remembering
 * mechanical.
 *
 * HONEST SCOPE. The gate checks the BOOKKEEPING, not the judgement. A field is
 * acceptable when the auditor's source mentions it, or when it appears in
 * `EXEMPT` with a reason. The reason is a human's claim; this file only
 * enforces that the claim was written down and has not gone stale. A gate that
 * tried to re-derive the judgement would be a second, weaker auditor.
 *
 * What it DOES enforce, both directions:
 *   - a new reference field in a document-graph interface must be covered or
 *     exempted (fail on silence)
 *   - an exemption for a field that no longer exists must be deleted (fail on
 *     a stale entry, so the list cannot accumulate plausible dead text)
 *
 * This is the same shape as the drift gate's `countSpecFiles`: derive the claim
 * from the source instead of remembering a number.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TYPES = readFileSync("src/project-model/types.ts", "utf8");
const AUDITOR = readFileSync("tests/referential-integrity.test.ts", "utf8");

/**
 * The interfaces that make up the persisted mixer document graph. A field in
 * one of these can dangle; a field in `PatternAssist` or `ProjectLineage` is
 * provenance metadata and cannot.
 */
const DOCUMENT_GRAPH_INTERFACES = new Set([
  "ProjectDocument",
  "Scene",
  "Marker",
  "SceneAutomation",
  "ArrangementClip",
  "MidiClip",
  "ArrangementTransition",
  "AudioClip",
  "AudioTakeGroup",
  "ClipGroup",
  "AutomationTarget",
  "Lfo",
  "MacroMapping",
  "DrumNoteMapping",
  "MidiCcMapping",
  "MidiConfig",
  "ReturnTrack",
  "MasterConfig",
  "TrackInputInsert",
  "LiveSet",
  "LiveSetPad",
  // Provenance blocks: persisted on the document, but their ids point OUT of
  // it (at a generation run, at another saved project), so they are provenance
  // rather than graph edges — each one is exempted with that reason below.
  "PatternGeneration",
  "PatternAssist",
  "ProjectLineage",
]);

/** Reference fields deliberately NOT checked by the auditor, with the reason. */
const EXEMPT: Record<string, string> = {
  // Note there is no `id` entry, and that is deliberate rather than an
  // oversight: the extraction below matches capitalised `Id`/`Ids`, so a bare
  // lowercase `id` is never a "reference field" — it is the entity's OWN key.
  // Adding one would be a field faked into existence to satisfy a list. The
  // auditor checks those keys for UNIQUENESS per collection, which is the
  // property that actually breaks.
  paramId:
    "A parameter NAME inside a device, not an entity id. Resolving it needs the effect param catalog (targets.ts targetParamDef), which the auditor deliberately does not re-implement; the device itself is checked.",
  deviceId: "A Web MIDI device NAME from the browser's own enumeration, not an id into this document.",
  deliveryProfileId: "A closed union of literals (streaming|apple|loud|vinyl), validated by clamp, not a reference.",
  customId: "Marker export metadata echoed into the scorepack filename. Never resolved at runtime.",
  cueAssetId: "ArrangementTransition asset id, documented as 'metadata only in v1' in types.ts.",
  engineId: "Provenance label on generated patterns (PatternGeneration/PatternAssist), not a document entity.",
  grooveId: "Provenance label on a generated pattern, not a document entity.",
  sourcePatternId:
    "Provenance label recording which pattern a generation came from. Nullable and never dereferenced at playback.",
  parentId:
    "ProjectLineage family link. Provenance across project saves; the parent project is not part of this document.",
  rootId: "ProjectLineage family root. Same: provenance across saves, never dereferenced here.",
  presetId:
    "Points into the PRESET STORE (IndexedDB), not into this document. A document alone cannot resolve it; the preset repository owns that check.",
  bufferId:
    "Checked for shape only — an empty id would leave the clip with no source. Resolving it needs the audio-buffer store, which is not part of the document.",
};

/** Every `*Id`/`*Ids` field declared in a document-graph interface. */
function referenceFields(): { iface: string; field: string }[] {
  const out: { iface: string; field: string }[] = [];
  let iface = "";
  for (const line of TYPES.split("\n")) {
    const declaration = line.match(/^export (?:interface|type) (\w+)/);
    if (declaration) {
      iface = declaration[1];
      continue;
    }
    if (!DOCUMENT_GRAPH_INTERFACES.has(iface)) continue;
    const field = line.match(/^\s{2}(\w*(?:Id|Ids))\??\s*:/);
    if (field) out.push({ iface, field: field[1] });
  }
  return out;
}

const fields = referenceFields();
const audited = new Set(fields.filter((f) => AUDITOR.includes(f.field)).map((f) => f.field));

/** EXEMPT keys that no longer name a real reference field. Named so it can be
 *  given a positive control in the test below, instead of being an inline
 *  filter whose "empty result" is indistinguishable from "no check happened". */
function staleExemptionKeys(exempt: Record<string, string>, real: Set<string>): string[] {
  return Object.keys(exempt).filter((key) => !real.has(key));
}

/** EXEMPT entries whose reason is too thin to be a justification. */
function blankReasonFields(exempt: Record<string, string>): string[] {
  return Object.entries(exempt)
    .filter(([, reason]) => reason.trim().length < 20)
    .map(([field]) => field);
}

describe("referential auditor coverage gate", () => {
  it("the extraction actually finds reference fields (a silent parser guards nothing)", () => {
    // Without this, a regex that stops matching turns every assertion below
    // into a vacuous pass — the gate would be green because it read nothing.
    expect(fields.length).toBeGreaterThan(15);
    expect(audited.size).toBeGreaterThan(8);
    // The spot-checks below, not the threshold above, are what stop a dead
    // regex: a threshold can always be lowered, but naming five fields that
    // MUST be extracted cannot.
    for (const must of ["activePatternId", "trackId", "patternId", "sceneId", "linkedClipId"]) {
      expect(audited.has(must), `${must} should be audited`).toBe(true);
      expect(
        fields.some((f) => f.field === must),
        `${must} should be extracted from types.ts`,
      ).toBe(true);
    }
  });

  it("every reference field in a document-graph interface is audited or exempted with a reason", () => {
    const uncovered = fields
      .filter((f) => !audited.has(f.field))
      .map((f) => `${f.iface}.${f.field}`)
      .filter((path) => {
        const field = path.split(".")[1];
        return !EXEMPT[field];
      });
    expect(uncovered, `Add these to auditReferences() or to EXEMPT with a reason: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("no exemption is stale — every EXEMPT key is still a real reference field", () => {
    const real = new Set(fields.map((f) => f.field));
    // Both halves pinned in ONE assertion on one call site. Two separate
    // assertions let `const stale = []` delete one half and leave the control
    // green — which is what falsification caught here: the positive control
    // proved the HELPER works, while nothing proved the TEST still USES it.
    const results = [staleExemptionKeys(EXEMPT, real), staleExemptionKeys({ ghostField: "why not" }, real)];
    expect(results[0], `Delete these stale exemptions: ${results[0].join(", ")}`).toEqual([]);
    expect(results, "the stale check must flag a fabricated bogus key, not only ever return empty").toEqual([
      [],
      ["ghostField"],
    ]);
  });

  it("every exemption carries a real reason (an empty string excuses nothing)", () => {
    // Same single-assertion structure as above, for the same reason.
    const blank = [blankReasonFields(EXEMPT), blankReasonFields({ fine: "a reason long enough to count", bad: "" })];
    expect(blank[0], `These exemptions have no usable reason: ${blank[0].join(", ")}`).toEqual([]);
    expect(blank, "the blank-reason check must flag an empty reason").toEqual([[], ["bad"]]);
  });

  it("the auditor really is independent — it imports no resolver from the code it checks", () => {
    // Sharing the resolver would let a defect hide inside a helper the checker
    // also uses. The auditor re-derives every answer from the raw document.
    for (const forbidden of ["isAutomationTargetValid", "targetParamDef", "sanitizeLfo", "sanitizeMacroMapping"]) {
      expect(AUDITOR.includes(forbidden), `auditor must not import ${forbidden}`).toBe(false);
    }
  });
});
