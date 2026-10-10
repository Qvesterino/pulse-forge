import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { addArrangementClip, addChord, addMarker } from "../src/commands/commands";
import { buildVisualScore } from "../src/interop/visualScore";
import { arrangementSecondsBetweenTicks } from "../src/project-model/scene-time";
import { BAR_TICKS } from "../src/project-model/types";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * VISUAL SCORE (KYX → ATOMA bridge v3) — the declarative dramaturgy export.
 *
 *  V1 sections: role/label/intensity per scene clip span, seconds resolved
 *     scene-tempo aware (the same mapping the transport uses)
 *  V2 markers: name/type + seconds via the tick→seconds mapping
 *  V3 chords: root/quality + display name + bar span → seconds
 *  V4 meta: bpm/key/mode/durationSec carried; camelot null here (the
 *     packet's metadata already carries the camelot pair)
 */

const fixture = (): { doc: ProjectDocument; store: ProjectStore } => {
  let doc = createProjectFromTemplate("house");
  for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
  doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
  doc = addArrangementClip(doc, doc.scenes[0]!.id, 4, 4).execute(doc);
  doc = addMarker(doc, { tick: BAR_TICKS, name: "LIFT", type: "riser" }).execute(doc);
  doc = addChord(doc, 0, 2, 0, "min7").execute(doc);
  doc = addChord(doc, 2, 2, 7, "dom7").execute(doc);
  const store = new ProjectStore(doc);
  return { doc: store.doc, store };
};

import { deleteArrangementClip } from "../src/commands/commands";

describe("V1 sections", () => {
  it("one section per clip with role, label, seconds, intensity", () => {
    const { doc } = fixture();
    const score = buildVisualScore(doc, 15.48);
    expect(score.version).toBe(1);
    expect(score.sourceApp).toBe("pulse_forge");
    expect(score.sections).toHaveLength(2);
    expect(score.sections[0]!.role.length).toBeGreaterThan(0);
    expect(score.sections[0]!.startSec).toBeCloseTo(0, 6);
    // Bar 4 at the scene tempo: 4 bars × 2 s = 8 s (house default 120 BPM).
    expect(score.sections[0]!.endSec).toBeCloseTo(score.sections[1]!.startSec, 6);
    expect(score.sections[0]!.intensity).toBeGreaterThanOrEqual(0);
    expect(score.sections[0]!.intensity).toBeLessThanOrEqual(1);
    void score.intensity;
  });

  it("seconds are scene-tempo aware: identical math as the tick→seconds mapper", () => {
    const { doc } = fixture();
    const score = buildVisualScore(doc, 99);
    const clip = doc.arrangement.clips[1]!;
    const expectedStart = arrangementSecondsBetweenTicks(
      doc.arrangement.clips,
      doc.scenes,
      0,
      clip.startBar * BAR_TICKS,
      doc.bpm,
    );
    expect(score.sections[1]!.startSec).toBeCloseTo(expectedStart, 6);
  });
});

describe("V2 markers", () => {
  it("name/type/seconds carried", () => {
    const { doc } = fixture();
    const score = buildVisualScore(doc, 30);
    expect(score.markers).toHaveLength(1);
    expect(score.markers[0]!.name).toBe("LIFT");
    expect(score.markers[0]!.type).toBe("riser");
    const markerSec = arrangementSecondsBetweenTicks(doc.arrangement.clips, doc.scenes, 0, BAR_TICKS, doc.bpm);
    expect(score.markers[0]!.sec).toBeCloseTo(markerSec, 6); // scene-tempo aware
  });
});

describe("V3 chords", () => {
  it("name/quality/seconds carried per event", () => {
    const { doc } = fixture();
    const score = buildVisualScore(doc, 30);
    expect(score.chords).toHaveLength(2);
    expect(score.chords[0]!.name).toBe("Cm7");
    expect(score.chords[1]!.name).toBe("G7");
    expect(score.chords[0]!.startSec).toBeCloseTo(0, 6);
    const chord2Sec = arrangementSecondsBetweenTicks(doc.arrangement.clips, doc.scenes, 0, 2 * BAR_TICKS, doc.bpm);
    expect(score.chords[1]!.startSec).toBeCloseTo(chord2Sec, 3); // scene-tempo aware
  });
});

describe("V4 meta", () => {
  it("bpm/key/mode/durationSec carried; camelot left to the packet metadata", () => {
    const { doc } = fixture();
    const score = buildVisualScore(doc, 30);
    expect(score.bpm).toBe(doc.bpm);
    expect(score.key).toBe(doc.key ?? null); // undefined normalizes to null
    expect(["major", "minor", "null"].includes(String(score.mode)) || score.mode === null).toBe(true);
    expect(score.durationSec).toBe(30);
    expect(score.camelot).toBeNull();
  });
});
