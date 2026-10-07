import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import { SCHEMA_VERSION } from "../src/project-model/schema";
import { audioClipsForPlayback } from "../src/project-model/audio-takes";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addAudioClip,
  buildClipClipboard,
  duplicateAudioClip,
  pasteClips,
  setAudioClipsMute,
  splitAudioClipAtTick,
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
    const muted = { ...clips(doc)[0]!, muted: true };
    const normalized = normalizeProject({
      ...doc,
      arrangement: { ...doc.arrangement, audioClips: [muted] },
    } as ProjectDocument);
    expect(clips(normalized)[0]!.muted).toBe(true);
    // Unmuted: the key is dropped entirely (stored only when true).
    expect("muted" in clips(normalized)[0]!).toBe(false);
    const unmuted = normalizeProject(doc);
    expect("muted" in clips(unmuted)[0]!).toBe(false);
  });
});

describe("MU4 edits carry the flag", () => {
  it("split fragments and duplicates inherit mute; clipboard paste preserves it", () => {
    const { doc, a } = docWithTones();
    const store = new ProjectStore(doc);
    store.execute(setAudioClipsMute(store.doc, [a], true));

    // Split a muted clip: fragments inherit it (the split fragment is the
    // whole B3 use case — mute one half of a phrase).
    store.execute(splitAudioClipAtTick(store.doc, a, BAR));
    const fragments = clips(store.doc);
    expect(fragments).toHaveLength(2);
    expect(fragments.every((c) => c.muted === true)).toBe(true);

    // Duplicate inherits it too.
    store.execute(duplicateAudioClip(store.doc, fragments[0]!.id));
    expect(clips(store.doc).find((c) => c.startBar === 2)!.muted).toBe(true);

    // Copy → paste at the playhead keeps the clip muted.
    const payload = buildClipClipboard(store.doc, [fragments[0]!.id])!;
    store.execute(pasteClips(store.doc, payload, 8 * BAR));
    const pasted = clips(store.doc).filter((c) => c.startBar === 8);
    expect(pasted).toHaveLength(1);
    expect(pasted[0]!.muted).toBe(true);
  });
});
