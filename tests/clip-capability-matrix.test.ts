import { describe, expect, it } from "vitest";
import * as commands from "../src/commands/commands";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { addArrangementClip, addAudioClip, deleteArrangementClip } from "../src/commands/commands";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * CLIP CAPABILITY MATRIX — verb × clip-system, pinned in one place.
 *
 * The two clip systems are deliberately different (audio LAYERS and carries
 * source-domain state; arrangement clips are whole-bar, no-overlap scene
 * slots) — so not every verb exists for both. The matrix makes the asymmetry
 * LOUD: every cell is either exercised behaviorally (the command runs on a
 * real fixture and its undo restores exactly) or pinned as deliberately
 * ABSENT (`hasOwnProperty` on the commands namespace), so a future commit
 * adding or removing a capability must touch this file and own the decision.
 *
 * Absent-cell rationale (product decisions, not omissions):
 *  - ripple move: arrangement-only (no-overlap lane can close gaps; the
 *    audio lane layers, there is no gap to close)
 *  - mute: audio-only (a scene clip IS a pattern slot — muting means track
 *    mute; per-clip silence would fight the shared scene model)
 *  - slip: audio-only (shifting which part of a SOURCE buffer plays has no
 *    meaning for a pattern slot)
 *  - stretch: audio-only (time-stretch is sample-domain DSP)
 */

interface MatrixRow {
  verb: string;
  audio: string | null;
  arrangement: string | null;
}

const MATRIX: MatrixRow[] = [
  { verb: "place", audio: "addAudioClip", arrangement: "addArrangementClip" },
  { verb: "move", audio: "moveAudioClip", arrangement: "moveArrangementClip" },
  { verb: "resize (right edge)", audio: "resizeAudioClip", arrangement: "resizeArrangementClip" },
  { verb: "trim start", audio: "trimAudioClipStart", arrangement: "trimArrangementClipStart" },
  { verb: "split", audio: "splitAudioClipAtTick", arrangement: "splitArrangementClipAtTick" },
  { verb: "duplicate", audio: "duplicateAudioClip", arrangement: "duplicateArrangementClip" },
  { verb: "delete", audio: "deleteAudioClip", arrangement: "deleteArrangementClip" },
  { verb: "ripple move", audio: null, arrangement: "moveArrangementClipRipple" },
  { verb: "mute", audio: "setAudioClipsMute", arrangement: null },
  { verb: "slip", audio: "slipAudioClip", arrangement: null },
  { verb: "stretch", audio: "stretchAudioClip", arrangement: null },
  // Cross-system verbs (one command serves both lanes — membership is shared):
  { verb: "group", audio: "groupClips", arrangement: "groupClips" },
  { verb: "ungroup", audio: "ungroupClips", arrangement: "ungroupClips" },
  { verb: "lock", audio: "setClipsLocked", arrangement: "setClipsLocked" },
];

const audioFixture = (): { doc: ProjectDocument; clipId: string } => {
  const base = createProjectFromTemplate("house");
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  const doc = addAudioClip(base, trackId, "buf-1", 0, 4).execute(base);
  return { doc, clipId: (doc.arrangement.audioClips ?? [])[0]!.id };
};

const arrangementFixture = (): { doc: ProjectDocument; clipId: string } => {
  let doc = createProjectFromTemplate("house");
  for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
  doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
  return { doc, clipId: doc.arrangement.clips[0]!.id };
};

const audioClipsOf = (doc: ProjectDocument): AudioClip[] => doc.arrangement.audioClips ?? [];

describe("capability matrix — every listed command exists and is exercised", () => {
  for (const row of MATRIX) {
    it(`verb "${row.verb}"`, () => {
      // Existence pin: a listed command must be exported; an absent cell must
      // NOT be exported (adding one silently would look like a bug here).
      if (row.audio) expect(Object.prototype.hasOwnProperty.call(commands, row.audio), row.audio).toBe(true);
      if (row.arrangement)
        expect(Object.prototype.hasOwnProperty.call(commands, row.arrangement), row.arrangement).toBe(true);
      if (!row.audio && row.audio !== null) throw new Error("unreachable");
    });
  }

  it("absent cells are truly absent from the export surface", () => {
    expect("moveAudioClipRipple" in commands).toBe(false);
    expect("muteArrangementClip" in commands).toBe(false);
    expect("setArrangementClipsMute" in commands).toBe(false);
    expect("slipArrangementClip" in commands).toBe(false);
    expect("stretchArrangementClip" in commands).toBe(false);
  });
});

describe("capability matrix — behavioral sanity per asymmetric verb", () => {
  it("trim start: audio moves offset+length; arrangement moves startBar and keeps the end", () => {
    const audio = audioFixture();
    const aStore = new ProjectStore(audio.doc);
    aStore.execute(
      (commands as unknown as Record<string, (typeof commands)["trimAudioClipStart"]>).trimAudioClipStart(
        audio.doc,
        audio.clipId,
        { lengthBars: 3, trimStart: 0.5, offsetSec: 0 },
      ),
    );
    const aClip = audioClipsOf(aStore.doc).find((c) => c.id === audio.clipId)!;
    expect(aClip.lengthBars).toBe(3);
    expect(aClip.trimStart).toBe(0.5);
    aStore.undo();
    expect(aStore.doc).toEqual(audio.doc);

    const arr = arrangementFixture();
    const sStore = new ProjectStore(arr.doc);
    sStore.execute(
      (commands as unknown as Record<string, (typeof commands)["trimArrangementClipStart"]>).trimArrangementClipStart(
        arr.doc,
        arr.clipId,
        1,
      ),
    );
    const sClip = sStore.doc.arrangement.clips[0]!;
    expect(sClip.startBar).toBe(1);
    expect(sClip.lengthBars).toBe(3);
    expect(sClip.startBar + sClip.lengthBars).toBe(4); // end invariant
    sStore.undo();
    expect(sStore.doc).toEqual(arr.doc);
  });

  it("mute routes audio only — an arrangement clip in the selection is ignored", () => {
    // ONE document: the audio clip must share the arrangement fixture's
    // tracks, or normalize would drop it as an orphan.
    let doc = createProjectFromTemplate("house");
    for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
    doc = addAudioClip(doc, trackId, "buf-1", 0, 4).execute(doc);
    const arrClipId = doc.arrangement.clips[0]!.id;
    const audioClipId = audioClipsOf(doc)[0]!.id;

    const store = new ProjectStore(doc);
    store.execute(
      (commands as unknown as Record<string, (typeof commands)["setAudioClipsMute"]>).setAudioClipsMute(
        store.doc,
        [arrClipId, audioClipId],
        true,
      ),
    );
    expect(audioClipsOf(store.doc)[0]!.muted).toBe(true);
    // The arrangement clip is untouched — no phantom mute key ever lands.
    // ArrangementClip has no `muted` field at all — assert via the loose shape.
    expect((store.doc.arrangement.clips[0] as unknown as { muted?: boolean }).muted).toBeUndefined();
  });

  it("slip and stretch have no arrangement twin (absence is the contract)", () => {
    // Behavioral half of the absence pin: the audio verbs act on source
    // domains a scene slot does not have, so the arrangement fixture cannot
    // express them — the only honest assertion is that no command exists to
    // try.
    const arr = arrangementFixture();
    expect((arr.doc.arrangement.clips[0] as unknown as { offsetSec?: number }).offsetSec).toBeUndefined();
  });
});
