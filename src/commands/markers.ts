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

/* ---------------- markers ---------------- */ export function addMarker(
  doc: ProjectDocument,
  partial: { tick: number; type?: Marker["type"]; name?: string; linkedClipId?: string; customId?: string },
): Command {
  const marker: Marker = {
    id: uid("marker"),
    name: partial.name?.trim() || `Marker ${doc.markers.length + 1}`,
    type: partial.type ?? "cue",
    tick: Math.max(0, Math.floor(partial.tick)),
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
  const clamped = Math.max(0, Math.floor(tick));
  const next = { ...doc, markers: doc.markers.map((m) => (m.id === markerId ? { ...m, tick: clamped } : m)) };
  return snapshot("moveMarker", "Move marker", doc, next);
}
export function setMarkerLinkedClip(doc: ProjectDocument, markerId: string, linkedClipId: string | null): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  const next = {
    ...doc,
    markers: doc.markers.map((m) => (m.id === markerId ? { ...m, linkedClipId: linkedClipId ?? undefined } : m)),
  };
  return snapshot("setMarkerLinkedClip", "Link marker to clip", doc, next);
}
