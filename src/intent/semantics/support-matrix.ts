/**
 * SUPPORT MATRIX — what the deterministic intent engine can actually do, by
 * domain, derived from the same registries the parsers use.
 *
 * The matrix is not marketing copy: every parameter row comes from
 * `buildCapabilityMatrix()`, so a family that is not in the registry cannot
 * appear here, and a metric is reported exactly as the readback knows it.
 *
 * Domains:
 *   generation — prompt → constraints → generator/audition (probabilistic output)
 *   editing    — deterministic mutation of the project document
 *   mastering  — mix/loudness/tonal moves whose quality needs measurement + ear
 *
 * `ROUTE_DOMAINS` classifies EVERY RoutedIntent kind (the Record is
 * compile-time exhaustive), so a new route cannot ship without stating which
 * domain(s) it belongs to.
 */
import type { RoutedIntent } from "../route";
import { buildCapabilityMatrix } from "./param-registry";

export type IntentDomain = "generation" | "editing" | "mastering";

export const ROUTE_DOMAINS: Readonly<Record<RoutedIntent["kind"], readonly IntentDomain[]>> = {
  fader: ["editing", "mastering"],
  effectIntent: ["editing", "mastering"],
  paramIntent: ["editing", "mastering"],
  exact: ["editing"],
  compound: ["editing"],
  tempo: ["editing"],
  sendIntent: ["editing"],
  bypassIntent: ["editing"],
  preset: ["editing"],
  presetUnknown: [],
  sceneIntensity: ["editing"],
  clips: ["editing"],
  arrange: ["editing"],
  selectedStepAssist: ["editing"],
  selectedClipArrange: ["editing"],
  selectedRangeArrange: ["editing"],
  grooveIntent: ["editing"],
  sectionGrooveIntent: ["editing"],
  automationPlan: ["editing"],
  automateIntent: ["editing"],
  markerIntent: ["editing"],
  stepEditIntent: ["editing"],
  soundSwapIntent: ["editing"],
  undoIntent: ["editing"],
  // Session/read-only lanes: no domain mutation.
  select: [],
  transport: [],
  save: [],
  export: [],
  record: [],
  checkpointIntent: [],
  queryIntent: [],
  complaintIntent: [],
  clarify: [],
  // Generation lanes.
  pattern: ["generation"],
  revise: ["generation"],
  sectionFlow: ["generation"],
  sectionTransition: ["generation"],
  sectionProduction: ["generation", "mastering"],
  // Mix/mastering lanes.
  loudness: ["mastering"],
  mix: ["mastering"],
  production: ["editing", "mastering"],
};

export type SupportEvidence = "auto" | "manual-pending" | "generator" | "none";

export interface SupportRow {
  domains: readonly IntentDomain[];
  operation: string;
  target: string;
  units: readonly string[];
  evidence: SupportEvidence;
  status: "supported" | "clarify-only" | "unsupported";
  note: string;
}

const STATIC_ROWS: readonly SupportRow[] = [
  {
    domains: ["editing", "mastering"],
    operation: "fader",
    target: "family / pad / ordinal / master",
    units: ["normalized gain", "% of range"],
    evidence: "auto",
    status: "supported",
    note: "multiplicative factor; measured readback; one undo step",
  },
  {
    domains: ["editing"],
    operation: "fader.exact",
    target: "drums / bass / lead / chords / mix / master",
    units: ["dB"],
    evidence: "auto",
    status: "supported",
    note: "explicit dB delta/destination; exact values override modifiers",
  },
  {
    domains: ["editing", "mastering"],
    operation: "effect.primary",
    target: "family / ordinal",
    units: ["knob range", "%"],
    evidence: "auto",
    status: "supported",
    note: "add/remove/set/more/less; readback reports the actual knob",
  },
  {
    domains: ["editing"],
    operation: "exact",
    target: "tracks / pads / pattern / project",
    units: ["dB", "semitones", "bars", "BPM", "%"],
    evidence: "auto",
    status: "supported",
    note: "mute/solo/pan/gain/transpose/length/tempo/meter/swing",
  },
  {
    domains: ["editing"],
    operation: "compound",
    target: "all supported clauses",
    units: ["per clause"],
    evidence: "auto",
    status: "supported",
    note: "one undo group; every clause must validate",
  },
  {
    domains: ["editing"],
    operation: "arrangement",
    target: "clips / scenes / steps / markers / automation",
    units: ["bars", "steps", "beats"],
    evidence: "auto",
    status: "supported",
    note: "selection-scoped and named-scene lanes",
  },
  {
    domains: ["editing"],
    operation: "groove / preset / sound swap",
    target: "track family / instrument",
    units: ["preset", "swing %"],
    evidence: "auto",
    status: "supported",
    note: "canonical commands; no model in the path",
  },
  {
    domains: ["generation"],
    operation: "pattern / revise / section flow",
    target: "whole project / section",
    units: ["bars", "BPM", "genre"],
    evidence: "generator",
    status: "supported",
    note: "intent routes constraints; musical output is probabilistic and needs auditioning",
  },
  {
    domains: ["editing", "mastering"],
    operation: "section-relative reference",
    target: "chorus / drop / verse / intro",
    units: [],
    evidence: "none",
    status: "clarify-only",
    note: "a section is a time range, not a track family; it declines instead of changing the whole song",
  },
  {
    domains: ["mastering"],
    operation: "loudness",
    target: "master / mix",
    units: ["LUFS", "dB"],
    evidence: "auto",
    status: "supported",
    note: "measured loudness target and bounded trim",
  },
  {
    domains: ["mastering"],
    operation: "mix / production profile",
    target: "mix / track family",
    units: ["profile"],
    evidence: "manual-pending",
    status: "supported",
    note: "deterministic profile, but tonal/dynamics quality needs listening",
  },
  {
    domains: ["mastering"],
    operation: "mastering macros",
    target: "mastering suite (ZYVO)",
    units: ["dB", "pts"],
    evidence: "manual-pending",
    status: "supported",
    note: "bounded reversible macro plan; parser lives in the host",
  },
];

/** The generated inventory: parameter capabilities + static lanes. */
export function buildSupportMatrix(): SupportRow[] {
  const rows: SupportRow[] = [];
  for (const capability of buildCapabilityMatrix()) {
    if (capability.exposedBy !== "param") continue;
    rows.push({
      domains: ["editing", "mastering"],
      operation: `${capability.effectType}.${capability.paramId}`,
      target: "track family / ordinal",
      units: [capability.unit ?? "normalized"],
      evidence: capability.metric ? "auto" : "manual-pending",
      status: "supported",
      note: `role ${capability.role}; ${capability.domain} calibration; ${capability.primary ? "effect-owned" : "param-owned"}`,
    });
  }
  return [...STATIC_ROWS, ...rows];
}

export function domainsForRoute(kind: RoutedIntent["kind"]): readonly IntentDomain[] {
  return ROUTE_DOMAINS[kind];
}
