/**
 * STEM MASTERING planner (the mastering-wave payoff, ADR 0020 lineage):
 * per-stem mastering shapes for the separated lanes (demucs contract:
 * vocals / drums / bass / other). Each stem gets its OWN ZENIT tuned to the
 * role — the shape a mastering engineer would dial per bus — applied through
 * the command layer as ONE snapshot. Pure and deterministic; the executor
 * (kyx_master op:stems) matches lanes by name and never guesses: a lane
 * without a stem role in its name is reported, not touched.
 */

export type StemRole = "vocals" | "drums" | "bass" | "other";

export interface StemMasteringStep {
  stem: StemRole;
  label: string;
  params: Record<string, number>;
  why: string;
}

export const STEM_ROLES: StemRole[] = ["vocals", "drums", "bass", "other"];

/** Match a lane name to its stem role (inflection-tolerant, word-bounded). */
export function stemRoleOf(name: string): StemRole | null {
  const lower = name.toLowerCase();
  if (/\bvocals?\b|\bvokal/.test(lower)) return "vocals";
  if (/\bdrums?\b|\bbicí?i?\b|\bbic/.test(lower)) return "drums";
  if (/\bbass\b|\bbas\b|\b808\b/.test(lower)) return "bass";
  if (/\bother\b|\bostatn/.test(lower)) return "other";
  return null;
}

const SHAPES: Record<StemRole, Omit<StemMasteringStep, "stem">> = {
  drums: {
    label: "Drums — punch bus",
    params: { limit: 0.45, glue: 0.35, drive: 0.15, ceiling: -1 },
    why: "transient-forward: limiting push with the glue opening room for hits",
  },
  bass: {
    label: "Bass — mono foundation",
    params: { bassMono: 150, ceiling: -1.5, glue: 0.25, limit: 0.2 },
    why: "foundation discipline: mono below 150 Hz, tighter ceiling, no width",
  },
  vocals: {
    label: "Vocals — presence bus",
    params: { eqHigh: 1, eqMid: 0.5, limit: 0.25, glue: 0.2, ceiling: -1 },
    why: "presence: gentle AIR and MID lift, light limiting so the voice breathes",
  },
  other: {
    label: "Other — space bus",
    params: { width: 1.25, eqHigh: 0.5, glue: 0.2, limit: 0.2, ceiling: -1 },
    why: "space keeper: widened field, soft ceiling",
  },
};

export function stemMasteringPlan(): StemMasteringStep[] {
  return STEM_ROLES.map((stem) => ({ stem, ...SHAPES[stem] }));
}
