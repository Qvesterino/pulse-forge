/**
 * Markers: place, rename, retype, move and clip-link a cue.
 *
 * Markers are navigation, not arrangement content. The model deliberately does not clamp their
 * ticks to the project length on every command — see `markerClampPatch` in ./docOps, which owns
 * the one place where a marker may shrink onto a shorter project, and only inside the command
 * delta so undo restores the original ticks.
 */
import type { Command } from "./types";
import type { Marker, ProjectDocument } from "../project-model/types";
import { uid } from "../shared/ids";
import { snapshot } from "./core";

/**
 * A marker link must name a live clip in EITHER clip system — a dangling id
 * survives every save (the schema deliberately keeps any string) and silently
 * points nowhere. Commands validate against the doc they execute on, so a
 * composed flow that creates the clip first is unaffected.
 */
const clipExists = (doc: ProjectDocument, clipId: string): boolean =>
  doc.arrangement.clips.some((c) => c.id === clipId) || (doc.arrangement.audioClips ?? []).some((c) => c.id === clipId);

/* ---------------- markers ---------------- */ export function addMarker(
  doc: ProjectDocument,
  partial: { tick: number; type?: Marker["type"]; name?: string; linkedClipId?: string; customId?: string },
): Command {
  if (partial.linkedClipId !== undefined && !clipExists(doc, partial.linkedClipId)) {
    throw new Error(`Cannot link a marker to unknown clip ${partial.linkedClipId}`);
  }
  const marker: Marker = {
    id: uid("marker"),
    name: partial.name?.trim() || `Marker ${doc.markers.length + 1}`,
    type: partial.type ?? "cue",
    tick: Number.isFinite(partial.tick) ? Math.max(0, Math.floor(partial.tick)) : 0,
    linkedClipId: partial.linkedClipId,
    customId: partial.customId,
  };
  const next: ProjectDocument = { ...doc, markers: [...doc.markers, marker] };
  return snapshot("addMarker", `Add marker ${marker.name}`, doc, next);
}
export function removeMarker(doc: ProjectDocument, markerId: string): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  const next: ProjectDocument = { ...doc, markers: doc.markers.filter((m) => m.id !== markerId) };
  return snapshot("removeMarker", `Remove marker ${target.name}`, doc, next);
}
export function renameMarker(doc: ProjectDocument, markerId: string, name: string): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  const trimmed = name.trim() || target.name;
  const next = { ...doc, markers: doc.markers.map((m) => (m.id === markerId ? { ...m, name: trimmed } : m)) };
  return snapshot("renameMarker", `Rename marker to ${trimmed}`, doc, next);
}
export function setMarkerType(doc: ProjectDocument, markerId: string, type: Marker["type"]): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  const next = { ...doc, markers: doc.markers.map((m) => (m.id === markerId ? { ...m, type } : m)) };
  return snapshot("setMarkerType", `Marker type to ${type}`, doc, next);
}
export function moveMarker(doc: ProjectDocument, markerId: string, tick: number): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  // Math.max(0, Math.floor(NaN)) is NaN — the marker would teleport to tick 0
  // at the next normalize (sanitizeMarkers maps NaN→0). Refuse the move
  // instead, same contract as moveAudioClip's NaN no-op.
  if (!Number.isFinite(tick)) return snapshot("moveMarker", "Move marker (no-op)", doc, doc);
  const clamped = Math.max(0, Math.floor(tick));
  const next = { ...doc, markers: doc.markers.map((m) => (m.id === markerId ? { ...m, tick: clamped } : m)) };
  return snapshot("moveMarker", "Move marker", doc, next);
}
export function setMarkerLinkedClip(doc: ProjectDocument, markerId: string, linkedClipId: string | null): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  if (linkedClipId !== null && !clipExists(doc, linkedClipId)) {
    throw new Error(`Cannot link marker ${markerId} to unknown clip ${linkedClipId}`);
  }
  const next = {
    ...doc,
    markers: doc.markers.map((m) => (m.id === markerId ? { ...m, linkedClipId: linkedClipId ?? undefined } : m)),
  };
  return snapshot("setMarkerLinkedClip", "Link marker to clip", doc, next);
}
