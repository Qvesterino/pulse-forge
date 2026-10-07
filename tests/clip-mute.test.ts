import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import { SCHEMA_VERSION } from "../src/project-model/schema";
import { audioClipsForPlayback } from "../src/project-model/audio-takes";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addArrangementClip,
  addAudioClip,
  buildClipClipboard,
  duplicateAudioClip,
  pasteClips,
  setAudioClipsMute,
  splitAudioClipAtTick,
  toggleAudioClipsMute,
} from "../src/commands/commands";
import { BAR_TICKS } from "../src/project-model/types";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * CLIP MUTE (B3) — clip-level mute as one choke point in
 * `audioClipsForPlayback`, so scheduler, offline render and the live-editing
 * resume cannot disagree.
 *
 *  MU1 muted clips never reach playback (the filter), unmuted do
 *  MU2 setAudioClipsMute mutes a whole selection as ONE undoable entry;
 *      unmute restores exactly; a no-op (state already matches) pushes no
 *      history entry
 *  MU3 mute survives persistence normalization (schema v14) and is
 *      ABSENT for unmuted clips — stored only when true
 *  MU4 split/duplicate/clipboard carry the flag; paste preserves it
 */

const BAR = BAR_TICKS;

const docWithTones = (): { doc: ProjectDocument; a: string; b: string } => {
  const base = createProjectFromTemplate("house");
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  let doc = addAudioClip(base, trackId, "buf-a", 0, 2).execute(base);
  doc = addAudioClip(doc, trackId, "buf-b", 4, 2).execute(doc);
  return {
    doc,
    a: (doc.arrangement.audioClips ?? []).find((c) => c.bufferId === "buf-a")!.id,
    b: (doc.arrangement.audioClips ?? []).find((c) => c.bufferId === "buf-b")!.id,
  };
};

const clips = (doc: ProjectDocument): AudioClip[] => doc.arrangement.audioClips ?? [];

describe("MU1 playback filter", () => {
  it("a muted clip never reaches playback; unmuting brings it back", () => {
    const { doc, a, b } = docWithTones();
    const store = new ProjectStore(doc);
    store.execute(setAudioClipsMute(store.doc, [a], true));
    expect(clips(store.doc).find((c) => c.id === a)!.muted).toBe(true);
    expect(audioClipsForPlayback(store.doc.arrangement).map((c) => c.id)).toEqual([b]);
    store.execute(setAudioClipsMute(store.doc, [a], false));
    expect(audioClipsForPlayback(store.doc.arrangement)).toHaveLength(2);
  });
});

describe("MU2 one-entry multi mute", () => {
  it("mutes both clips in one entry; undo restores exactly; redo re-mutes", () => {
    const { doc, a, b } = docWithTones();
    const store = new ProjectStore(doc);
    const baseline = store.doc;
    store.execute(setAudioClipsMute(store.doc, [a, b], true));
    expect(store.undoStackLength).toBe(1);
    expect(clips(store.doc).every((c) => c.muted === true)).toBe(true);
    store.undo();
    expect(store.doc).toEqual(baseline);
    store.redo();
    expect(clips(store.doc).every((c) => c.muted === true)).toBe(true);
    void a;
    void b;
  });

  it("toggleAudioClipsMute: null over a non-audio selection; toggle semantics; arrangement ids ignored", () => {
    const { doc, a, b } = docWithTones();
    let d2 = addArrangementClip(doc, doc.scenes[0]!.id, 12, 4).execute(doc);
    const arrId = d2.arrangement.clips[0]!.id;
    // No audio clips in the selection → null (no command, no history entry).
    expect(toggleAudioClipsMute(d2, [arrId])).toBeNull();
    expect(toggleAudioClipsMute(d2, ["dead-id"])).toBeNull();
    // Mixed selection: only the audio clip is routed.
    const muteCmd = toggleAudioClipsMute(d2, [a, arrId])!;
    expect(muteCmd.execute(d2).arrangement.audioClips?.find((c) => c.id === a)!.muted).toBe(true);
    // All-muted selection → unmute.
    const mutedDoc = muteCmd.execute(d2);
    const unmuteCmd = toggleAudioClipsMute(mutedDoc, [a, arrId])!;
    expect(unmuteCmd.execute(mutedDoc).arrangement.audioClips?.find((c) => c.id === a)!.muted).toBe(false);
    void b;
  });

  it("a mute that changes nothing pushes no history entry", () => {
    const { doc, a } = docWithTones();
    const store = new ProjectStore(doc);
    const before = store.undoStackLength;
    store.execute(setAudioClipsMute(store.doc, [a], false)); // already unmuted
    expect(store.undoStackLength).toBe(before);
  });
});

describe("MU3 persistence normalization", () => {
  it("muted survives normalizeProject; unmuted clips store no key; schema is v14", () => {
    expect(SCHEMA_VERSION).toBe(14);
    const base = createDefaultProject();
    const trackId = base.tracks[0]!.id;
    const doc = addAudioClip(base, trackId, "buf-1", 0, 2).execute(base);
    // Unmuted first: the key is dropped entirely (stored only when true).
    const unmuted = normalizeProject(doc);
    expect("muted" in clips(unmuted)[0]!).toBe(false);
    // A muted clip round-trips with the flag intact.
    const muted = { ...clips(doc)[0]!, muted: true };
    const normalized = normalizeProject({
      ...doc,
      arrangement: { ...doc.arrangement, audioClips: [muted] },
    } as ProjectDocument);
    expect(clips(normalized)[0]!.muted).toBe(true);
    expect("muted" in clips(normalized)[0]!).toBe(true);
  });
});

describe("MU4 edits carry the flag", () => {
  it("split fragments and duplicates inherit mute; clipboard paste preserves it", () => {
    const { doc, a, b } = docWithTones();
    const store = new ProjectStore(doc);
    store.execute(setAudioClipsMute(store.doc, [a], true));

    // Split a muted clip: fragments inherit it (the split fragment is the
    // whole B3 use case — mute one half of a phrase).
    store.execute(splitAudioClipAtTick(store.doc, a, BAR));
    const fragments = clips(store.doc).filter((c) => c.id !== b);
    expect(fragments).toHaveLength(2);
    expect(fragments.every((c) => c.muted === true)).toBe(true);

    // Duplicate inherits it too (lands exactly after the left fragment: bar 1).
    store.execute(duplicateAudioClip(store.doc, fragments[0]!.id));
    const dup = clips(store.doc).filter((c) => c.id !== b && c.id !== fragments[0]!.id && c.id !== fragments[1]!.id);
    expect(dup).toHaveLength(1);
    expect(dup[0]!.startBar).toBe(1);
    expect(dup[0]!.muted).toBe(true);

    // Copy → paste at the playhead keeps the clip muted.
    const payload = buildClipClipboard(store.doc, [fragments[0]!.id])!;
    store.execute(pasteClips(store.doc, payload, 8 * BAR));
    const pasted = clips(store.doc).filter((c) => c.startBar === 8);
    expect(pasted).toHaveLength(1);
    expect(pasted[0]!.muted).toBe(true);
  });
});
