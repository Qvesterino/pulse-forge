
/* ---------------- metadata & scorepack ---------------- */

export function setProjectKey(doc: ProjectDocument, key: MusicalKey | null): Command {
  const prev = doc.key;
  const next: ProjectDocument = key
    ? { ...doc, key }
    : (() => {
        const { key: _drop, ...rest } = doc;
        return rest as ProjectDocument;
      })();
  return {
    type: "setProjectKey",
    label: key ? `Set project key to ${key}` : "Clear project key",
    execute: () => next,
    undo: (d) =>
      prev
        ? { ...d, key: prev }
        : (() => {
            const { key: _drop, ...rest } = d;
            return rest as ProjectDocument;
          })(),
  };
}

export function setProjectTags(doc: ProjectDocument, tags: string[]): Command {
  const prev = doc.tags;
  const cleaned = tags.map((t) => t.trim()).filter((t) => t.length > 0);
  return {
    type: "setProjectTags",
    label: "Edit project tags",
    execute: (d) => ({ ...d, tags: cleaned }),
    undo: (d) =>
      prev
        ? { ...d, tags: prev }
        : (() => {
            const { tags: _drop, ...rest } = d;
            return rest as ProjectDocument;
          })(),
  };
}

/* ---------------- markers ---------------- */

export function addMarker(
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
  const next = {
    ...doc,
    markers: doc.markers.map((m) => (m.id === markerId ? { ...m, name: trimmed } : m)),
  };
  return snapshot("renameMarker", `Rename marker to ${trimmed}`, doc, next);
}

export function setMarkerType(doc: ProjectDocument, markerId: string, type: Marker["type"]): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  const next = {
    ...doc,
    markers: doc.markers.map((m) => (m.id === markerId ? { ...m, type } : m)),
  };
  return snapshot("setMarkerType", `Marker type → ${type}`, doc, next);
}

export function moveMarker(doc: ProjectDocument, markerId: string, tick: number): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  const clamped = Math.max(0, Math.floor(tick));
  const next = {
    ...doc,
    markers: doc.markers.map((m) => (m.id === markerId ? { ...m, tick: clamped } : m)),
  };
  return snapshot("moveMarker", "Move marker", doc, next);
}

export function setMarkerLinkedClip(doc: ProjectDocument, markerId: string, linkedClipId: string | null): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  const next = {
    ...doc,
    markers: doc.markers.map((m) =>
      m.id === markerId ? { ...m, linkedClipId: linkedClipId ?? undefined } : m,
    ),
  };
  return snapshot("setMarkerLinkedClip", "Link marker to clip", doc, next);
}

/* ---------------- scenes (intensity / loop) ---------------- */

export function setSceneIntensity(doc: ProjectDocument, sceneId: string, intensity: number): Command {
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const clamped = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0.7));
  const next = {
    ...doc,
    scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, intensity: clamped } : s)),
  };
  return snapshot("setSceneIntensity", `Scene intensity → ${clamped.toFixed(2)}`, doc, next);
}

export function setSceneIntensityCurve(doc: ProjectDocument, sceneId: string, curve: IntensityPoint[]): Command {
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const cleaned = curve
    .map((p) => ({
      offset: Math.max(0, Math.floor(p.offset)),
      value: Math.min(1, Math.max(0, Number.isFinite(p.value) ? p.value : 0)),
    }))
    .sort((a, b) => a.offset - b.offset);
  const next = {
    ...doc,
    scenes: doc.scenes.map((s) =>
      s.id === sceneId
        ? { ...s, intensityCurve: cleaned.length > 0 ? cleaned : undefined }
        : s,
    ),
  };
  return snapshot("setSceneIntensityCurve", "Scene intensity curve", doc, next);
}

export function setSceneLoop(doc: ProjectDocument, sceneId: string, loop: boolean): Command {
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const next = {
    ...doc,
    scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, loop } : s)),
  };
  return snapshot("setSceneLoop", loop ? "Loop scene" : "Unloop scene", doc, next);
}

export function setArrangementClipLoop(doc: ProjectDocument, clipId: string, loop: boolean): Command {
  const target = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!target) throw new Error(`Clip ${clipId} not found`);
  const next = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: doc.arrangement.clips.map((c) => (c.id === clipId ? { ...c, loop } : c)),
    },
  };
  return snapshot("setArrangementClipLoop", loop ? "Loop clip" : "Unloop clip", doc, next);
}

/* ---------------- scene automation ---------------- */

export function addSceneAutomation(doc: ProjectDocument, sceneId: string, target: AutomationTarget): Command {
  if (!doc.scenes.some((s) => s.id === sceneId)) throw new Error(`Scene ${sceneId} not found`);
  const lane: SceneAutomation = { id: uid("sceneAuto"), sceneId, target, points: [{ tick: 0, value: 0 }] };
  const next = { ...doc, sceneAutomation: [...doc.sceneAutomation, lane] };
  return snapshot("addSceneAutomation", "Add scene lane", doc, next);
}

export function removeSceneAutomation(doc: ProjectDocument, laneId: string): Command {
  const target = doc.sceneAutomation.find((l) => l.id === laneId);
  if (!target) throw new Error(`Scene lane ${laneId} not found`);
  const next = { ...doc, sceneAutomation: doc.sceneAutomation.filter((l) => l.id !== laneId) };
  return snapshot("removeSceneAutomation", "Remove scene lane", doc, next);
}

export function addSceneAutomationPoint(doc: ProjectDocument, laneId: string, tick: number, value: number): Command {
  const lane = doc.sceneAutomation.find((l) => l.id === laneId);
  if (!lane) throw new Error(`Scene lane ${laneId} not found`);
  const next = {
    ...doc,
    sceneAutomation: doc.sceneAutomation.map((l) =>
      l.id === laneId
        ? {
            ...l,
            points: [...l.points, { tick: Math.max(0, Math.floor(tick)), value }].sort(
              (a, b) => a.tick - b.tick,
            ),
          }
        : l,
    ),
  };
  return snapshot("addSceneAutomationPoint", "Add scene point", doc, next);
}

export function moveSceneAutomationPoint(
  doc: ProjectDocument,
  laneId: string,
  index: number,
  delta: { tick?: number; value?: number },
): Command {
  const lane = doc.sceneAutomation.find((l) => l.id === laneId);
  if (!lane) throw new Error(`Scene lane ${laneId} not found`);
  if (index < 0 || index >= lane.points.length) throw new Error("Scene point out of range");
  const next = {
    ...doc,
    sceneAutomation: doc.sceneAutomation.map((l) => {
      if (l.id !== laneId) return l;
      const points = [...l.points];
      const p = points[index];
      points[index] = {
        tick: delta.tick !== undefined ? Math.max(0, Math.floor(delta.tick)) : p.tick,
        value: delta.value !== undefined ? delta.value : p.value,
      };
      points.sort((a, b) => a.tick - b.tick);
      return { ...l, points };
    }),
  };
  return snapshot("moveSceneAutomationPoint", "Move scene point", doc, next);
}

export function removeSceneAutomationPoint(doc: ProjectDocument, laneId: string, index: number): Command {
  const lane = doc.sceneAutomation.find((l) => l.id === laneId);
  if (!lane) throw new Error(`Scene lane ${laneId} not found`);
  if (index < 0 || index >= lane.points.length) throw new Error("Scene point out of range");
  const next = {
    ...doc,
    sceneAutomation: doc.sceneAutomation.map((l) =>
      l.id === laneId ? { ...l, points: l.points.filter((_, i) => i !== index) } : l,
    ),
  };
  return snapshot("removeSceneAutomationPoint", "Remove scene point", doc, next);
}
