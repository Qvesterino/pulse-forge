import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { buildTempoMap, collectClipWindows } from "../src/rendering/renderer";
import { buildMarkersJson, scorepackTempo } from "../src/export/scorepack";
import { addArrangementClip, setBpm } from "../src/commands/commands";
import { ticksPerBar } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * THE SCOREPACK'S JSON MUST SPEAK THE SAME TEMPO AS ITS WAV.
 *
 * The scorepack ships a rendered master WAV AND JSON manifests (markers,
 * automation) that carry the same events in seconds. The WAV is rendered on
 * the piecewise tempo map — every window runs at its scene's BPM — while the
 * manifests converted ticks with the PROJECT bpm only. With a scene tempo
 * lane in the project, a marker landed at a different second in markers.json
 * than at in the audio the user receives: the delivered data contradicted
 * itself.
 *
 * The test compares the scorepack's own tempo function with the renderer's
 * own tempo map — the two must be the same map — and then checks that the
 * markers the scorepack writes use it.
 */

/** The bar the fixture's scene clip starts at (far enough to be free). */
const CLIP_BAR = 32;
/** The bar the probe marker sits in (inside the clip, so inside the scene's tempo). */
const MARKER_BAR = 33;

function withSceneTempo(): ProjectDocument {
  const base = createProjectFromTemplate("house");
  const scene = base.scenes[0];
  if (!scene) throw new Error("the house template must seed a scene");
  const withSceneBpm: ProjectDocument = {
    ...base,
    scenes: base.scenes.map((s) => (s.id === scene.id ? { ...s, bpm: 140 } : s)),
  };
  const withClip = addArrangementClip(withSceneBpm, scene.id, CLIP_BAR, 4).execute(withSceneBpm);
  return setBpm(withClip, 120).execute(withClip);
}

/** The probe marker's tick, in the document's bar unit. */
function markerTick(doc: ProjectDocument): number {
  return MARKER_BAR * ticksPerBar(doc);
}

describe("the scorepack's tempo is the render's tempo", () => {
  it("the scorepack uses the same tempo map as the renderer", () => {
    const doc = withSceneTempo();
    const rendererMap = buildTempoMap(doc, collectClipWindows(doc, "song"));
    const scorepackAt = scorepackTempo(doc);
    const tick = markerTick(doc);

    expect(scorepackAt(tick), "the marker must map to the same second in both").toBeCloseTo(
      rendererMap.timeAt(tick),
      12,
    );
  });

  it("a marker inside a scene-tempo clip is NOT placed at the project tempo", () => {
    const doc = withSceneTempo();
    const tick = markerTick(doc);
    const projectTempoSeconds = tick * (60 / (doc.bpm * 480));
    const scorepackSeconds = scorepackTempo(doc)(tick);

    expect(projectTempoSeconds, "the fixture must actually differ from the project tempo").not.toBeCloseTo(
      scorepackSeconds,
      6,
    );
  });

  it("the markers the scorepack writes use the tempo map", () => {
    const doc = withSceneTempo();
    const tick = markerTick(doc);
    const docWithMarker: ProjectDocument = {
      ...doc,
      markers: [...doc.markers, { id: "m-probe", name: "probe", type: "cue", tick } as never],
    };

    const rows = buildMarkersJson(docWithMarker, scorepackTempo(docWithMarker));
    const row = rows.find((entry) => entry.id === "m-probe");
    expect(row, "the marker must be in the manifest").toBeDefined();
    expect(row!.seconds as number).toBeCloseTo(scorepackTempo(docWithMarker)(tick), 12);
  });
});
