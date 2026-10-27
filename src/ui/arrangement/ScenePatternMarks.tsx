import { memo } from "react";
import { sceneClipLengthTicks, scenePatternMarks } from "./scenePatternResolver";
import type { ArrangementClip, ProjectDocument } from "../../project-model/types";

/**
 * THE SCENE REGION'S PICTURE.
 *
 * A scene region used to be a labelled box: it played a whole scene — drums,
 * melody, an intensity curve — and it showed none of it. This draws what the
 * region plays, INSIDE the region, as the arrangement lane's other lanes do.
 *
 * Two bands, one above the other, both measured from the region's own start:
 *
 *   - the MELODY band: one small bar per note, placed at the note's pitch and
 *     as wide as the note sounds;
 *   - the DRUM band: one tick per hit, placed at the hit's tick.
 *
 * The picture is not a second opinion about the music — it is the SAME events
 * the audio plays, resolved by the same calls (`scenePatternResolver`), so it
 * cannot drift from the sound. What the user sees in the region is what the
 * region plays.
 *
 * THE PICTURE IS DECORATIVE. It is `aria-hidden` and it takes no pointer
 * events: the clip's own gestures (move, resize, trim, select) belong to the
 * clip, and a picture that swallowed them would be a regression.
 */
export const ScenePatternMarks = memo(function ScenePatternMarks({
  doc,
  clip,
}: {
  doc: ProjectDocument;
  clip: ArrangementClip;
}) {
  const lengthTicks = sceneClipLengthTicks(doc, clip);
  const marks = scenePatternMarks(doc, clip);
  if (lengthTicks <= 0) return null;
  // A dense pattern in a long region would draw thousands of nodes; the
  // picture is a glance, not an inventory.
  const notes = marks.notes.length > MAX_MARKS ? marks.notes.slice(0, MAX_MARKS) : marks.notes;
  const drums = marks.drums.length > MAX_MARKS ? marks.drums.slice(0, MAX_MARKS) : marks.drums;
  if (notes.length === 0 && drums.length === 0) return null;

  // The vertical axis is the melody's pitch. The band is a few pixels tall,
  // so the scale is the range the region's own notes span — a fixed 0..127
  // scale would pile every note onto one line and say nothing.
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const note of notes) {
    if (note.pitch < lowest) lowest = note.pitch;
    if (note.pitch > highest) highest = note.pitch;
  }
  const span = highest > lowest ? highest - lowest : 12;

  const noteMarks = notes.map((note) => {
    const offset = clampTo(note.offsetTicks, 0, lengthTicks);
    const sounding = Math.max(1, Math.min(note.durationTicks, lengthTicks - offset));
    return (
      <i
        key={note.key}
        className="arr-scene-note-mark"
        data-pitch={note.pitch}
        style={{
          left: `${(offset / lengthTicks) * 100}%`,
          width: `${Math.max(0.5, (sounding / lengthTicks) * 100)}%`,
          top: `${100 - ((note.pitch - lowest) / span) * 100}%`,
          opacity: 0.4 + 0.6 * clampTo(note.velocity, 0, 1),
        }}
      />
    );
  });

  const drumMarks = drums.map((drum) => {
    const offset = clampTo(drum.offsetTicks, 0, lengthTicks);
    return (
      <i
        key={drum.key}
        className="arr-scene-drum-mark"
        style={{
          left: `${(offset / lengthTicks) * 100}%`,
          opacity: 0.35 + 0.65 * clampTo(drum.velocity, 0, 1),
        }}
      />
    );
  });

  return (
    <div className="arr-scene-marks" aria-hidden="true">
      <div className="arr-scene-note-band">{noteMarks}</div>
      <div className="arr-scene-drum-band">{drumMarks}</div>
    </div>
  );
});

/** The picture never draws more than this many marks of one kind. */
const MAX_MARKS = 256;

function clampTo(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
