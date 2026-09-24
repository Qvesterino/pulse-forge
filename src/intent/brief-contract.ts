/**
 * BRIEF CONTRACT (Fáza 1 — AI-first producer roadmap).
 *
 * Compiles the raw parser output (`ParsedIntent`) plus optional context
 * (producer session, project document) into a short, correctable
 * "this is what I understood" summary — POVINNÉ / PREFERENCIE / ZÁKAZY /
 * ZACHOVAŤ / NEISTÉ — BEFORE any generation runs.
 *
 * Rules (from the roadmap):
 *   - a low-confidence reading is NEVER presented as a fact (confidence +
 *     origin travel with every statement, "NEISTÉ" is a first-class section);
 *   - the keyword parser stays the cheap deterministic authority — the
 *     contract is derived, never authoritative on its own;
 *   - unknown items may carry a suggested `patch` (session continuation or
 *     an explicit fix) the user accepts with one click instead of rewriting
 *     the prompt;
 *   - pure and deterministic: same parsed brief + context → same contract.
 *
 * TRANSIENT layer by design: nothing here is serialized into the project —
 * enforcement travels through the normalized IntentSpec (bpmRange/key/
 * roles/preserve), so the project schema is untouched.
 */
import { DEFAULT_GENERATE_OPTIONS, GENRES } from "../ai/types";
import { isMusicalKey, type ProjectDocument } from "../project-model/types";
import type { ProducerSessionState } from "./producer-session";
import type { ParsedIntent } from "./text-parser";
import type { IntentInput, IntentRole } from "./types";

export type BriefSection = "hard" | "preference" | "prohibition" | "preserve" | "unknown";
export type BriefOrigin = "prompt" | "session" | "project" | "default";
export type BriefConfidence = "parsed" | "inferred" | "unknown";

export interface BriefStatement {
  /** Stable id — UI keys and tests anchor on it. */
  id: string;
  section: BriefSection;
  /** UI-ready SK label stating the understanding. */
  label: string;
  origin: BriefOrigin;
  confidence: BriefConfidence;
  /**
   * Machine-actionable equivalent, already reflected in the spec for parsed
   * facts (null) or offered as a one-click fix for unknown/inferred ones.
   */
  patch: IntentInput | null;
  /** Set on preserve statements — the chip can un-protect this role. */
  role?: IntentRole;
}

export interface BriefContract {
  statements: readonly BriefStatement[];
}

/** Section → UI header. */
export const BRIEF_SECTION_LABELS: Readonly<Record<BriefSection, string>> = {
  hard: "POVINNÉ",
  preference: "PREFERENCIE",
  prohibition: "ZÁKAZY",
  preserve: "ZACHOVAŤ",
  unknown: "NEISTÉ",
};

const ROLE_LABEL_ACC: Readonly<Record<IntentRole, string>> = {
  drums: "bicie",
  bass: "basu",
  chords: "akordy",
  lead: "lead",
};

const ALL_ROLES: readonly IntentRole[] = ["drums", "bass", "chords", "lead"];

export interface BriefContractContext {
  project?: ProjectDocument | null;
  session?: ProducerSessionState | null;
  /** Default generation set when the brief names no roles (panel default). */
  defaultRoles?: readonly IntentRole[];
}

const clampBpm = (value: number): number => Math.max(40, Math.min(240, value));

function barsLabel(steps: number): string {
  const bars = steps / 16;
  if (bars === 1) return "1 takt";
  if (bars < 5) return `${bars} takty`;
  return `${bars} taktov`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)} %`;
}

/**
 * Compile the parsed brief into the confirmable contract. Missing
 * `parsed` (empty prompt) yields only the default/unknown skeleton — the
 * generation path is never blocked by a missing reading.
 */
export function compileBriefContract(parsed: ParsedIntent | null, context: BriefContractContext = {}): BriefContract {
  const statements: BriefStatement[] = [];
  const input = parsed?.input ?? {};
  const detected = parsed?.detected ?? [];
  const session = context.session ?? null;

  // ── HARD — exact requirements the brief stated ──────────────────────────
  const sessionBpm = session?.decisions.bpm ? Number(session.decisions.bpm.value) : NaN;
  if (input.bpmRange) {
    const [lo, hi] = input.bpmRange;
    statements.push({
      id: "bpm",
      section: "hard",
      label: lo === hi ? `${lo} BPM` : `${lo}–${hi} BPM`,
      origin: "prompt",
      confidence: "parsed",
      patch: null,
    });
  } else if (Number.isFinite(sessionBpm)) {
    statements.push({
      id: "bpm",
      section: "unknown",
      label: `tempo nebolo zadané — návrh: ${sessionBpm} BPM (z tejto session)`,
      origin: "session",
      confidence: "inferred",
      patch: { bpmRange: [clampBpm(sessionBpm - 4), clampBpm(sessionBpm + 4)] },
    });
  } else {
    statements.push({
      id: "bpm",
      section: "unknown",
      label: "tempo nebolo zadané (zvolí groove)",
      origin: "default",
      confidence: "unknown",
      patch: null,
    });
  }

  const sessionKey = session?.decisions.key?.value;
  if (input.key) {
    statements.push({
      id: "key",
      section: "hard",
      label: `tónina ${input.key}`,
      origin: "prompt",
      confidence: "parsed",
      patch: null,
    });
  } else if (sessionKey && isMusicalKey(sessionKey)) {
    statements.push({
      id: "key",
      section: "unknown",
      label: `tónina nebola zadaná — návrh: ${sessionKey} (z tejto session)`,
      origin: "session",
      confidence: "inferred",
      patch: { key: sessionKey },
    });
  } else {
    statements.push({
      id: "key",
      section: "unknown",
      label: "tónina nebola zadaná",
      origin: "default",
      confidence: "unknown",
      patch: null,
    });
  }

  if (input.length) {
    statements.push({
      id: "length",
      section: "hard",
      label: barsLabel(input.length),
      origin: "prompt",
      confidence: "parsed",
      patch: null,
    });
  } else {
    statements.push({
      id: "length",
      section: "unknown",
      label: "dĺžka nebola zadaná — štandard 8 taktov",
      origin: "default",
      confidence: "unknown",
      patch: null,
    });
  }

  // ── PREFERENCES ─────────────────────────────────────────────────────────
  const sessionGenre = session?.decisions.genre?.value;
  if (input.genre) {
    statements.push({
      id: "genre",
      section: "preference",
      label: `žáner: ${input.genre}`,
      origin: "prompt",
      confidence: "parsed",
      patch: null,
    });
  } else if (sessionGenre && GENRES.includes(sessionGenre as (typeof GENRES)[number])) {
    statements.push({
      id: "genre",
      section: "preference",
      label: `žáner nebol zadaný — návrh: ${sessionGenre} (z tejto session)`,
      origin: "session",
      confidence: "inferred",
      patch: { genre: sessionGenre as IntentInput["genre"] },
    });
  } else {
    statements.push({
      id: "genre",
      section: "preference",
      label: `žáner: ${DEFAULT_GENERATE_OPTIONS.genre} (predvolené)`,
      origin: "default",
      confidence: "inferred",
      patch: null,
    });
  }

  if (input.style) {
    statements.push({
      id: "style",
      section: "preference",
      label: `štýl: ${input.style}`,
      origin: "prompt",
      confidence: "parsed",
      patch: null,
    });
  }
  if (input.mood) {
    statements.push({
      id: "mood",
      section: "preference",
      label: `nálada: ${input.mood}`,
      origin: "prompt",
      confidence: "parsed",
      patch: null,
    });
  }

  const character: string[] = [];
  if (typeof input.energy === "number") character.push(`energia ${percent(input.energy)}`);
  if (typeof input.density === "number") character.push(`hustota ${percent(input.density)}`);
  if (typeof input.complexity === "number") character.push(`zložitosť ${percent(input.complexity)}`);
  if (typeof input.variation === "number") character.push(`variácia ${percent(input.variation)}`);
  if (character.length > 0) {
    statements.push({
      id: "character",
      section: "preference",
      label: character.join(" · "),
      origin: "prompt",
      confidence: "parsed",
      patch: null,
    });
  }

  if (input.fx) {
    statements.push({
      id: "fx",
      section: "preference",
      label: "FX úpravy idú s generovaním",
      origin: "prompt",
      confidence: "parsed",
      patch: null,
    });
  }

  // ── GENERATION SET + ZÁKAZY + ZACHOVAŤ ─────────────────────────────────
  const preserved: readonly IntentRole[] = input.preserve ?? [];
  const generationRoles = (input.roles ?? context.defaultRoles ?? ALL_ROLES).filter(
    (role) => !preserved.includes(role),
  );
  if (generationRoles.length > 0) {
    statements.push({
      id: "roles",
      section: "hard",
      label: `generovať: ${generationRoles.map((role) => ROLE_LABEL_ACC[role]).join(", ")}`,
      origin: input.roles ? "prompt" : "default",
      confidence: input.roles ? "parsed" : "inferred",
      patch: null,
    });
  }

  if (detected.includes("no drums")) {
    statements.push({
      id: "no-drums",
      section: "prohibition",
      label: "žiadne bicie — negenerovať ani nenahrádzať",
      origin: "prompt",
      confidence: "parsed",
      patch: null,
    });
  }
  if (detected.includes("no bass")) {
    statements.push({
      id: "no-bass",
      section: "prohibition",
      label: "žiadna basa — negenerovať ani nenahrádzať",
      origin: "prompt",
      confidence: "parsed",
      patch: null,
    });
  }

  for (const role of preserved) {
    const project = context.project ?? null;
    const hasTracks = project
      ? role === "drums"
        ? project.tracks.some((track) => track.kind === "drum")
        : project.tracks.some((track) => track.kind === "instrument")
      : true;
    statements.push({
      id: `preserve-${role}`,
      section: "preserve",
      label: hasTracks
        ? `ponechám existujúce: ${ROLE_LABEL_ACC[role]}`
        : `ponechám existujúce: ${ROLE_LABEL_ACC[role]} (track v projekte chýba)`,
      origin: "prompt",
      confidence: hasTracks ? "parsed" : "inferred",
      patch: null,
      role,
    });
  }

  return { statements };
}

/**
 * Reverse of a preserve statement — the chip's × un-protects the role and
 * returns it to the generation set in one patch. `defaultRoles` must match
 * the caller's no-roles default (panel passes its own).
 */
export function unprotectRole(
  input: IntentInput,
  role: IntentRole,
  defaultRoles: readonly IntentRole[] = ALL_ROLES,
): IntentInput {
  const preserve = (input.preserve ?? []).filter((item) => item !== role);
  const roles = [...new Set([...(input.roles ?? defaultRoles), role])];
  const patch: IntentInput = { roles };
  if (preserve.length > 0) patch.preserve = preserve;
  return patch;
}
