/**
 * FREEZE STALENESS (Wave 2/D).
 *
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------
 * A frozen track plays a rendered buffer while the document keeps accepting
 * edits. Today those edits are silently inaudible: you move a note, turn an
 * FX knob, change an instrument — and the track keeps playing the frozen
 * render, with nothing on screen saying so. Export does NOT share that
 * behavior (`renderer.ts` strips frozen state before rendering), so a frozen
 * track with edits makes the export ≠ what you hear. That is a live/export
 * parity break the user cannot see.
 *
 * WHAT THIS MODULE PROVIDES
 * -------------------------
 * A signature of "everything the render would consume": the document with
 * every `frozen` field stripped (exactly what the offline renderer does),
 * serialized canonically (sorted keys, so an unrelated reorder of properties
 * cannot produce a false "stale") and hashed (SHA-256 where WebCrypto
 * exists).
 *
 * The signature is remembered per frozen bufferId — in memory for the live
 * session and, when the caller passes it, persisted alongside the buffer
 * bytes so staleness survives a reload. A buffer with NO remembered
 * signature reports "unknown" — an honest admission, never a guess.
 */

import type { ProjectDocument } from "../project-model/types";
import { sha256Hex } from "../export/renderManifest";

/**
 * Canonical JSON: object keys sorted, arrays in order, `undefined` omitted.
 * `JSON.stringify` alone is not canonical — property insertion order leaks
 * into the output, and an unrelated reorder would read as "stale".
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

// One hash per document version, shared by every frozen strip that asks.
// ProjectStore replaces the doc object on each command, so identity is a
// correct cache key; the WeakMap lets old versions be collected.
const signatureByDoc = new WeakMap<ProjectDocument, Promise<string | null>>();

/**
 * Signature of the document as the RENDER sees it. `null` = WebCrypto is
 * unavailable (insecure context), in which case staleness is unknowable.
 */
export function freezeSignature(doc: ProjectDocument): Promise<string | null> {
  const cached = signatureByDoc.get(doc);
  if (cached != null) return cached;
  const pending = (async () => {
    try {
      // Freeze signatures are only needed when a track is frozen or its
      // staleness is inspected. Keep the full offline renderer out of the
      // studio boot graph until one of those paths is actually used.
      const { unfreezeDoc } = await import("./renderer");
      const canonical = canonicalJson(unfreezeDoc(doc));
      return await sha256Hex(new TextEncoder().encode(canonical));
    } catch {
      return null;
    }
  })();
  signatureByDoc.set(doc, pending);
  return pending;
}

// ── remembered signatures (bufferId → document signature) ─────────────────

const remembered = new Map<string, string>();

export function rememberFreezeSignature(bufferId: string, signature: string): void {
  remembered.set(bufferId, signature);
}

export function forgetFreezeSignature(bufferId: string): void {
  remembered.delete(bufferId);
}

/** Signature remembered for this buffer, or null when never recorded here. */
export function peekFreezeSignature(bufferId: string): string | null {
  return remembered.get(bufferId) ?? null;
}

/** Load persisted signatures at project open (never materializes audio). */
export async function hydrateFreezeSignatures(repo: {
  listSignatures(): Promise<Array<{ id: string; signature: string }>>;
}): Promise<number> {
  try {
    const rows = await repo.listSignatures();
    for (const row of rows) {
      if (typeof row.id === "string" && typeof row.signature === "string" && row.signature !== "") {
        remembered.set(row.id, row.signature);
      }
    }
    return rows.length;
  } catch {
    return 0;
  }
}

/** Test/teardown hook — the registry is per-window by design. */
export function clearFreezeSignatures(): void {
  remembered.clear();
}

export type FreezeStaleness = "fresh" | "stale" | "unknown";

/**
 * Is the buffer still what this project would render?
 *
 * - "fresh"   — the signature matches the current document.
 * - "stale"   — the document changed since the render; live playback is
 *               playing the OLD render while the export re-renders.
 * - "unknown" — no remembered signature (pre-Wave-2 buffer, reload without
 *               persisted signature, or WebCrypto unavailable). Never a guess.
 */
export async function freezeStaleness(doc: ProjectDocument, bufferId: string): Promise<FreezeStaleness> {
  const stored = remembered.get(bufferId);
  if (stored == null) return "unknown";
  const current = await freezeSignature(doc);
  if (current == null) return "unknown";
  return current === stored ? "fresh" : "stale";
}
