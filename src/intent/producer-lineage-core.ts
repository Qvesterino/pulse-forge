/** Bounded, local-only snapshot contract for resumable Producer DNA branches. */
import { GENRES, type Genre } from "../ai/types";
import {
  PRODUCTION_PROFILES,
  type Pattern,
  type ProjectDocument,
  type ProductionProfile,
} from "../project-model/types";
import type { IntentRole, IntentSpec } from "./types";

export const PRODUCER_LINEAGE_SCHEMA_VERSION = 1 as const;
export const PRODUCER_LINEAGE_NODE_CAP = 48;
export const PRODUCER_LINEAGE_NODE_MAX_CHARS = 256_000;

export interface ProducerLineageIntentV1 {
  genre: Genre;
  style: string | null;
  productionProfile: ProductionProfile | null;
  mood: string | null;
  energy: number;
  density: number;
  complexity: number;
  variation: number;
  key: string | null;
  bpmRange: [number, number] | null;
  length: number;
  roles: IntentRole[];
  preserve: IntentRole[];
}

export interface ProducerLineagePatternV1 {
  id: string;
  name: "Saved take";
  stepCount: number;
  rows: Record<string, number[]>;
  notes: Pattern["notes"];
  stepMeta?: Pattern["stepMeta"];
  phrasePlan?: Pattern["phrasePlan"];
}

export interface ProducerLineageNodeV1 {
  schemaVersion: typeof PRODUCER_LINEAGE_SCHEMA_VERSION;
  id: string;
  projectKey: string;
  contentHash: string;
  parentContentHash: string | null;
  rootContentHash: string;
  candidateIndex: number;
  createdAt: number;
  intent: ProducerLineageIntentV1;
  pattern: ProducerLineagePatternV1;
}

export interface ProducerLineageDraft {
  projectKey: string;
  contentHash: string;
  parentContentHash: string | null;
  candidateIndex: number;
  intent: IntentSpec;
  pattern: Pattern;
  createdAt?: number;
}

export interface ProducerLineagePackV1 {
  schemaVersion: typeof PRODUCER_LINEAGE_SCHEMA_VERSION;
  exportedAt: number;
  nodes: ProducerLineageNodeV1[];
}

const HASH_RE = /^[a-f0-9]{8}$/i;
const ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const ROLE_SET = new Set<IntentRole>(["drums", "bass", "chords", "lead"]);
const PROFILE_SET = new Set<ProductionProfile>(PRODUCTION_PROFILES);
const GENRE_SET = new Set<Genre>(GENRES);
const TOKEN_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
const NOTE_LOCKS = new Set(["pitch", "gain", "pan", "cutoff", "sampleStart", "length", "ratio"]);
const STEP_META_KEYS = new Set(["probability", "ratchet", "microtiming", "amount", "locks"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function safeToken(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === "string" && TOKEN_RE.test(value) ? value : null;
}

function sanitizeLocks(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value) || Object.keys(value).length > NOTE_LOCKS.size) return undefined;
  const locks: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!NOTE_LOCKS.has(key) || !finiteInRange(raw, -100_000, 100_000)) return undefined;
    locks[key] = raw;
  }
  return Object.keys(locks).length > 0 ? locks : undefined;
}

function sanitizePattern(value: unknown): ProducerLineagePatternV1 | null {
  if (!isRecord(value)) return null;
  const stepCount = value.stepCount;
  if (
    typeof value.id !== "string" ||
    !ID_RE.test(value.id) ||
    !Number.isInteger(stepCount) ||
    (stepCount as number) < 1 ||
    (stepCount as number) > 4096 ||
    !isRecord(value.rows) ||
    Object.keys(value.rows).length > 128 ||
    !isRecord(value.notes) ||
    Object.keys(value.notes).length > 128
  ) {
    return null;
  }

  const rows: Record<string, number[]> = {};
  for (const [trackId, raw] of Object.entries(value.rows)) {
    if (!ID_RE.test(trackId) || !Array.isArray(raw) || raw.length > (stepCount as number)) return null;
    if (!raw.every((item) => finiteInRange(item, 0, 1))) return null;
    rows[trackId] = [...raw];
  }

  const notes: Pattern["notes"] = {};
  let totalNotes = 0;
  for (const [trackId, raw] of Object.entries(value.notes)) {
    if (!ID_RE.test(trackId) || !Array.isArray(raw)) return null;
    totalNotes += raw.length;
    if (totalNotes > 50_000) return null;
    const clean = [];
    for (const note of raw) {
      if (
        !isRecord(note) ||
        typeof note.id !== "string" ||
        !ID_RE.test(note.id) ||
        !finiteInRange(note.pitch, 0, 127) ||
        !finiteInRange(note.start, 0, 10_000_000) ||
        !finiteInRange(note.duration, 0.0001, 10_000_000) ||
        !finiteInRange(note.velocity, 0, 1) ||
        (note.slide !== undefined && typeof note.slide !== "boolean")
      ) {
        return null;
      }
      const locks = note.locks === undefined ? undefined : sanitizeLocks(note.locks);
      if (note.locks !== undefined && locks === undefined) return null;
      clean.push({
        id: note.id,
        pitch: note.pitch,
        start: note.start,
        duration: note.duration,
        velocity: note.velocity,
        ...(note.slide === true ? { slide: true } : {}),
        ...(locks ? { locks } : {}),
      });
    }
    notes[trackId] = clean;
  }

  let stepMeta: Pattern["stepMeta"];
  if (value.stepMeta !== undefined) {
    if (!isRecord(value.stepMeta) || Object.keys(value.stepMeta).length > 128) return null;
    stepMeta = {};
    for (const [trackId, rawSteps] of Object.entries(value.stepMeta)) {
      if (!ID_RE.test(trackId) || !isRecord(rawSteps) || Object.keys(rawSteps).length > 4096) return null;
      const steps: NonNullable<Pattern["stepMeta"]>[string] = {};
      for (const [rawStep, rawMeta] of Object.entries(rawSteps)) {
        const step = Number(rawStep);
        if (!Number.isInteger(step) || step < 0 || step >= (stepCount as number) || !isRecord(rawMeta)) return null;
        if (Object.keys(rawMeta).some((key) => !STEP_META_KEYS.has(key))) return null;
        const meta: NonNullable<Pattern["stepMeta"]>[string][number] = {};
        if (rawMeta.probability !== undefined) {
          if (!finiteInRange(rawMeta.probability, 0, 1)) return null;
          meta.probability = rawMeta.probability;
        }
        if (rawMeta.ratchet !== undefined) {
          if (!finiteInRange(rawMeta.ratchet, 1, 8) || !Number.isInteger(rawMeta.ratchet)) return null;
          meta.ratchet = rawMeta.ratchet;
        }
        if (rawMeta.microtiming !== undefined) {
          if (!finiteInRange(rawMeta.microtiming, -1, 1)) return null;
          meta.microtiming = rawMeta.microtiming;
        }
        if (rawMeta.amount !== undefined) {
          if (!finiteInRange(rawMeta.amount, 0, 1)) return null;
          meta.amount = rawMeta.amount;
        }
        if (rawMeta.locks !== undefined) {
          const locks = sanitizeLocks(rawMeta.locks);
          if (!locks) return null;
          meta.locks = locks;
        }
        steps[step] = meta;
      }
      stepMeta[trackId] = steps;
    }
  }

  let phrasePlan: Pattern["phrasePlan"];
  if (value.phrasePlan !== undefined) {
    if (!Array.isArray(value.phrasePlan) || value.phrasePlan.length > 128) return null;
    phrasePlan = [];
    for (const bar of value.phrasePlan) {
      if (
        !isRecord(bar) ||
        !Number.isInteger(bar.bar) ||
        (bar.bar as number) < 0 ||
        !Number.isInteger(bar.startStep) ||
        !Number.isInteger(bar.endStep) ||
        (bar.startStep as number) < 0 ||
        (bar.endStep as number) <= (bar.startStep as number) ||
        !["main", "variation", "drop", "fill", "outro"].includes(String(bar.section))
      ) {
        return null;
      }
      phrasePlan.push({
        bar: bar.bar as number,
        startStep: bar.startStep as number,
        endStep: bar.endStep as number,
        section: bar.section as NonNullable<Pattern["phrasePlan"]>[number]["section"],
      });
    }
  }

  return {
    id: value.id,
    name: "Saved take",
    stepCount: stepCount as number,
    rows,
    notes,
    ...(stepMeta ? { stepMeta } : {}),
    ...(phrasePlan ? { phrasePlan } : {}),
  };
}

function sanitizeIntent(value: unknown): ProducerLineageIntentV1 | null {
  if (!isRecord(value)) return null;
  const genre = value.genre;
  const profile = value.productionProfile;
  const roles = value.roles;
  const preserve = value.preserve;
  const bpmRange = value.bpmRange;
  const key = value.key;
  if (
    typeof genre !== "string" ||
    !GENRE_SET.has(genre as Genre) ||
    !(profile === null || (typeof profile === "string" && PROFILE_SET.has(profile as ProductionProfile))) ||
    !(key === null || (typeof key === "string" && /^[A-G](?:#|b)?(?:\s+(?:major|minor))?$/.test(key))) ||
    !finiteInRange(value.energy, 0, 1) ||
    !finiteInRange(value.density, 0, 1) ||
    !finiteInRange(value.complexity, 0, 1) ||
    !finiteInRange(value.variation, 0, 1) ||
    !Number.isInteger(value.length) ||
    (value.length as number) < 16 ||
    (value.length as number) > 256 ||
    !Array.isArray(roles) ||
    roles.length > 4 ||
    !roles.every((role) => typeof role === "string" && ROLE_SET.has(role as IntentRole)) ||
    !Array.isArray(preserve) ||
    preserve.length > 4 ||
    !preserve.every((role) => typeof role === "string" && ROLE_SET.has(role as IntentRole)) ||
    !(
      bpmRange === null ||
      (Array.isArray(bpmRange) &&
        bpmRange.length === 2 &&
        finiteInRange(bpmRange[0], 20, 400) &&
        finiteInRange(bpmRange[1], 20, 400) &&
        bpmRange[0] <= bpmRange[1])
    )
  ) {
    return null;
  }
  return {
    genre: genre as Genre,
    style: safeToken(value.style),
    productionProfile: profile as ProductionProfile | null,
    mood: safeToken(value.mood),
    energy: value.energy,
    density: value.density,
    complexity: value.complexity,
    variation: value.variation,
    key: key as string | null,
    bpmRange: bpmRange === null ? null : [bpmRange[0] as number, bpmRange[1] as number],
    length: value.length as number,
    roles: [...new Set(roles as IntentRole[])],
    preserve: [...new Set(preserve as IntentRole[])],
  };
}

/** Rebuild a privacy-bounded, known-field-only lineage node from untrusted input. */
export function sanitizeProducerLineageNode(value: unknown): ProducerLineageNodeV1 | null {
  if (!isRecord(value)) return null;
  const nodeId = value.id;
  const projectKey = value.projectKey;
  const contentHash = value.contentHash;
  const parentContentHash = value.parentContentHash;
  const rootContentHash = value.rootContentHash;
  const candidateIndex = value.candidateIndex;
  const createdAt = value.createdAt;
  if (
    value.schemaVersion !== PRODUCER_LINEAGE_SCHEMA_VERSION ||
    typeof nodeId !== "string" ||
    !ID_RE.test(nodeId) ||
    typeof projectKey !== "string" ||
    !HASH_RE.test(projectKey) ||
    typeof contentHash !== "string" ||
    !HASH_RE.test(contentHash) ||
    !(parentContentHash === null || (typeof parentContentHash === "string" && HASH_RE.test(parentContentHash))) ||
    typeof rootContentHash !== "string" ||
    !HASH_RE.test(rootContentHash) ||
    !Number.isInteger(candidateIndex) ||
    (candidateIndex as number) < 0 ||
    (candidateIndex as number) > 31 ||
    !finiteInRange(createdAt, 0, 8_640_000_000_000_000)
  ) {
    return null;
  }
  const intent = sanitizeIntent(value.intent);
  const pattern = sanitizePattern(value.pattern);
  if (!intent || !pattern || (parentContentHash === null && rootContentHash !== contentHash)) return null;
  const node: ProducerLineageNodeV1 = {
    schemaVersion: PRODUCER_LINEAGE_SCHEMA_VERSION,
    id: nodeId,
    projectKey,
    contentHash,
    parentContentHash,
    rootContentHash,
    candidateIndex: candidateIndex as number,
    createdAt,
    intent,
    pattern,
  };
  try {
    return JSON.stringify(node).length <= PRODUCER_LINEAGE_NODE_MAX_CHARS ? node : null;
  } catch {
    return null;
  }
}

/** Create a snapshot while deliberately excluding raw prompt, seed and project names. */
export function createProducerLineageNode(
  draft: ProducerLineageDraft,
  rootContentHash = draft.parentContentHash ?? draft.contentHash,
): ProducerLineageNodeV1 | null {
  const intent = draft.intent;
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `lineage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return sanitizeProducerLineageNode({
    schemaVersion: PRODUCER_LINEAGE_SCHEMA_VERSION,
    id,
    projectKey: draft.projectKey,
    contentHash: draft.contentHash,
    parentContentHash: draft.parentContentHash,
    rootContentHash,
    candidateIndex: draft.candidateIndex,
    createdAt: draft.createdAt ?? Date.now(),
    intent: {
      genre: intent.genre,
      style: intent.style,
      productionProfile: intent.productionProfile ?? null,
      mood: intent.mood,
      energy: intent.energy,
      density: intent.density,
      complexity: intent.complexity,
      variation: intent.variation,
      key: intent.key,
      bpmRange: intent.bpmRange,
      length: intent.length,
      roles: [...intent.roles],
      preserve: [...(intent.preserve ?? [])],
    },
    pattern: {
      id: draft.pattern.id,
      name: "Saved take",
      stepCount: draft.pattern.stepCount,
      rows: draft.pattern.rows,
      notes: draft.pattern.notes,
      ...(draft.pattern.stepMeta ? { stepMeta: draft.pattern.stepMeta } : {}),
      ...(draft.pattern.phrasePlan ? { phrasePlan: draft.pattern.phrasePlan } : {}),
    },
  });
}

export function isValidProducerLineagePack(value: unknown): value is ProducerLineagePackV1 {
  if (!isRecord(value) || value.schemaVersion !== PRODUCER_LINEAGE_SCHEMA_VERSION) return false;
  if (!finiteInRange(value.exportedAt, 0, 8_640_000_000_000_000) || !Array.isArray(value.nodes)) return false;
  if (value.nodes.length > PRODUCER_LINEAGE_NODE_CAP) return false;
  const ids = new Set<string>();
  return value.nodes.every((raw) => {
    const node = sanitizeProducerLineageNode(raw);
    if (!node || ids.has(node.id)) return false;
    ids.add(node.id);
    return true;
  });
}

export function projectKeyForLineage(project: string | Pick<ProjectDocument, "id" | "tracks">): string {
  const identity =
    typeof project === "string"
      ? project
      : JSON.stringify([
          project.id,
          project.tracks.map((track) => [
            track.kind,
            track.id,
            ...(track.kind === "drum" ? [track.pads.map((pad) => pad.id)] : []),
          ]),
        ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index++) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
