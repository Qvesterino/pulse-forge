import { normalizeProject } from "../project-model/schema";
import type { MasterConfig, ProjectDocument } from "../project-model/types";

export type MasteringABSlot = "A" | "B";

export interface MasteringSnapshot {
  id: string;
  capturedAt: string;
  config: MasterConfig;
}

export interface MasteringABSession {
  version: 1;
  projectId: string;
  a: MasteringSnapshot | null;
  b: MasteringSnapshot | null;
}

const EMPTY = (projectId: string): MasteringABSession => ({ version: 1, projectId, a: null, b: null });

function storageKey(projectId: string): string {
  return `kyx.mastering.ab.v1:${projectId}`;
}

function cloneConfig(config: MasterConfig): MasterConfig {
  return JSON.parse(JSON.stringify(config)) as MasterConfig;
}

function normalizeSnapshot(value: unknown, doc: ProjectDocument): MasteringSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<MasteringSnapshot>;
  if (typeof raw.id !== "string" || typeof raw.capturedAt !== "string" || !raw.config || typeof raw.config !== "object")
    return null;
  try {
    const normalized = normalizeProject({ ...doc, master: cloneConfig(raw.config as MasterConfig) });
    if (!Number.isFinite(normalized.master.masterGain) || !Number.isFinite(normalized.master.ceilingDb)) return null;
    return { id: raw.id, capturedAt: raw.capturedAt, config: cloneConfig(normalized.master) };
  } catch {
    return null;
  }
}

/** Load only validated, tab-local snapshots. Storage failure degrades to an empty session. */
export function loadMasteringABSession(doc: ProjectDocument): MasteringABSession {
  try {
    const rawText = globalThis.sessionStorage?.getItem(storageKey(doc.id));
    if (!rawText) return EMPTY(doc.id);
    const raw = JSON.parse(rawText) as Partial<MasteringABSession>;
    if (raw.version !== 1 || raw.projectId !== doc.id) return EMPTY(doc.id);
    return {
      version: 1,
      projectId: doc.id,
      a: normalizeSnapshot(raw.a, doc),
      b: normalizeSnapshot(raw.b, doc),
    };
  } catch {
    return EMPTY(doc.id);
  }
}

/** Persist session-local A/B snapshots; never writes to the project or collaboration store. */
export function saveMasteringABSession(session: MasteringABSession): boolean {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return false;
    storage.setItem(storageKey(session.projectId), JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function captureMasteringSnapshot(config: MasterConfig): MasteringSnapshot {
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return { id, capturedAt: new Date().toISOString(), config: cloneConfig(config) };
}

export function replaceSnapshot(
  session: MasteringABSession,
  slot: MasteringABSlot,
  snapshot: MasteringSnapshot | null,
): MasteringABSession {
  return { ...session, [slot.toLowerCase()]: snapshot } as MasteringABSession;
}
