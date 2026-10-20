import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  addAudioClip,
  buildClipClipboard,
  cutClips,
  duplicateClips,
  pasteClips,
} from "../src/commands/commands";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * CLIPBOARD — undo fidelity under concurrent edits.
 *
 * Measured 2026-10-20 (edit-tools audit): `cutClips`, `pasteClips` and
 * `duplicateClips` were the last three clipboard commands still pinning
 * WHOLE DOCUMENTS:
 *
 *   return { type: "cutClips", execute: () => next, undo: () => doc };
 *
 * `src/commands/docDelta.ts` documents that exact pattern as a defect
 * family that was already fixed everywhere else:
 *
 *   "`snapshot()`-style commands used to pin BOTH whole documents
 *    (`execute: () => next, undo: () => prev`). That made every dispatch
 *    a wholesale replacement: an async dispatch (e.g. the freeze render)
 *    silently reverted anything that changed between command creation and
 *    execution, and the undo stack kept whole document chains alive."
 *
 * Two measurable consequences:
 *
 *   1. ASYNC REVERT — a change that lands between command creation and
 *      execution is silently discarded, because `execute()` returns the
 *      STALE document computed at creation time.
 *
 *   2. UNDO WIPES UNRELATED EDITS — `undo()` returns the whole
 *      pre-command document, so one Ctrl+Z destroys every edit made
 *      after the cut.
 *
 * The fix is `snapshot()` from `src/commands/core.ts`: it captures the
 * id-anchored CHANGE, and the delta is applied to whatever document is
 * current at execution time.
 */

const audioClipsOf = (doc: ProjectDocument): AudioClip[] => doc.arrangement.audioClips ?? [];

const hasBuffer = (doc: ProjectDocument, bufferId: string): boolean =>
  audioClipsOf(doc).some((c) => c.bufferId === bufferId);

const docWithTones = (): { doc: ProjectDocument; trackId: string; a: string } => {
  const base = createProjectFromTemplate("house");
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  const doc = addAudioClip(base, trackId, "buf-a", 0, 2).execute(base);
  return { doc, trackId, a: audioClipsOf(doc)[0]!.id };
};

describe("clipboard commands survive concurrent edits (audit 2026-10-20)", () => {
  it("cutClips: a clip added between command creation and execution is NOT discarded", () => {
    const { doc, trackId, a } = docWithTones();

    // The command is created …
    const command = cutClips(doc, [a]);

    // … and THEN an unrelated clip lands (an async render, a collab merge,
    // a collaborator's edit). The cut is dispatched after that.
    const concurrent = addAudioClip(doc, trackId, "buf-concurrent", 8, 2).execute(doc);
    expect(hasBuffer(concurrent, "buf-concurrent")).toBe(true);

    const after = command.execute(concurrent);

    // The cut happened …
    expect(hasBuffer(after, "buf-a")).toBe(false);
    // … and the concurrent clip SURVIVED it.
    expect(
      hasBuffer(after, "buf-concurrent"),
      "cutClips reverted a concurrent edit: the command pinned the whole document instead of the change",
    ).toBe(true);
  });

  it("cutClips: undo does not wipe edits made after the cut", () => {
    const { doc, trackId, a } = docWithTones();

    const command = cutClips(doc, [a]);
    const after = command.execute(doc);
    // The user keeps working.
    const withMore = addAudioClip(after, trackId, "buf-later", 8, 2).execute(after);
    expect(hasBuffer(withMore, "buf-later")).toBe(true);

    const undone = command.undo(withMore);

    // The cut is undone …
    expect(hasBuffer(undone, "buf-a")).toBe(true);
    // … WITHOUT destroying the later edit.
    expect(
      hasBuffer(undone, "buf-later"),
      "undoing a cut wiped an unrelated later edit: undo pinned the whole document instead of the change",
    ).toBe(true);
  });

  it("pasteClips: a clip added between command creation and execution is NOT discarded", () => {
    const { doc, trackId, a } = docWithTones();
    const clipboard = buildClipClipboard(doc, [a])!;

    const command = pasteClips(doc, clipboard, 16);

    const concurrent = addAudioClip(doc, trackId, "buf-concurrent", 8, 2).execute(doc);
    const after = command.execute(concurrent);

    expect(after.arrangement.audioClips!.length).toBeGreaterThan(
      audioClipsOf(concurrent).length,
    );
    expect(
      hasBuffer(after, "buf-concurrent"),
      "pasteClips reverted a concurrent edit: the command pinned the whole document instead of the change",
    ).toBe(true);
  });

  it("pasteClips: undo does not wipe edits made after the paste", () => {
    const { doc, trackId, a } = docWithTones();
    const clipboard = buildClipClipboard(doc, [a])!;

    const command = pasteClips(doc, clipboard, 16);
    const after = command.execute(doc);
    const withMore = addAudioClip(after, trackId, "buf-later", 8, 2).execute(after);

    const undone = command.undo(withMore);

    expect(
      hasBuffer(undone, "buf-later"),
      "undoing a paste wiped an unrelated later edit: undo pinned the whole document instead of the change",
    ).toBe(true);
  });

  it("duplicateClips: a clip added between command creation and execution is NOT discarded", () => {
    const { doc, trackId, a } = docWithTones();

    const command = duplicateClips(doc, [a]);
    expect(command).not.toBeNull();

    const concurrent = addAudioClip(doc, trackId, "buf-concurrent", 8, 2).execute(doc);
    const after = command!.execute(concurrent);

    expect(
      hasBuffer(after, "buf-concurrent"),
      "duplicateClips reverted a concurrent edit: the command pinned the whole document instead of the change",
    ).toBe(true);
  });
});
