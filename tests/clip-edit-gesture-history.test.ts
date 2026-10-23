import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { addAudioClip, moveAudioClip, resizeAudioClip, trimAudioClipStart } from "../src/commands/commands";

/**
 * ONE GESTURE, ONE HISTORY ENTRY.
 *
 * The undo stack is the user's mental model of "what I just did". A drag that
 * writes twenty history entries makes Ctrl+Z a lie: the first press undoes
 * one frame of the gesture, not the gesture.
 *
 * The arrangement panel therefore PREVIEWS during the pointer move (a live
 * overlay, no document write) and COMMITS once on release. That is a
 * structural property of the panel, and a structural property needs a
 * structural guard: the preview handler must not reach the store.
 */

const PANEL_PATH = resolve(process.cwd(), "src/ui/ArrangementPanel.tsx");

/** Extract a `const name = (...) => { … }` body by brace matching. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} =`);
  expect(start, `${name} must exist in the arrangement panel`).toBeGreaterThan(-1);
  const arrow = source.indexOf("=>", start);
  const brace = source.indexOf("{", arrow);
  expect(brace, `${name} must have a block body`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(brace, i + 1);
    }
  }
  throw new Error(`${name} has no closing brace`);
}

describe("the drag preview must not write to the document", () => {
  const panel = readFileSync(PANEL_PATH, "utf8");

  /**
   * A COMMIT is a bare `execute(` — the store's write. A PREVIEW is
   * `someCommand(localDoc).execute(localDoc)`: it computes what the gesture
   * WOULD produce without touching the store. Only the first kind may create
   * a history entry, so only the first kind is forbidden in a move handler.
   */
  const COMMIT_CALL = /(?<![.\w])execute\s*\(/;

  it("the audio pointer-move handler never commits a command", () => {
    const body = functionBody(panel, "onAudioPointerMove");
    expect(body, "the drag preview must not execute a command").not.toMatch(COMMIT_CALL);
    expect(body, "the drag preview must not write the store").not.toMatch(/store\.execute\s*\(/);
  });

  it("the scene-clip pointer-move handler never commits a command either", () => {
    const body = functionBody(panel, "onClipPointerMove");
    expect(body, "the scene-clip drag preview must not execute a command").not.toMatch(COMMIT_CALL);
  });

  it("the gesture commits on release, not during the move", () => {
    // The commit lives in the pointer-up path — the ONE place a history entry
    // may be created for a drag.
    const up = functionBody(panel, "onAudioPointerUp");
    expect(up, "the pointer-up handler must commit the gesture").toMatch(COMMIT_CALL);
  });
});

describe("a committed gesture is one history entry", () => {
  it("a trim is ONE command — the length and the source move together", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4));
    const clipId = store.doc.arrangement.audioClips![0]!.id;
    const before = JSON.stringify(store.doc);
    // ONE command for the whole trim: the source offset and the new length
    // are the same gesture (two commands meant one Ctrl+Z undid only half).
    store.execute(trimAudioClipStart(store.doc, clipId, { startBar: 1, lengthBars: 3, trimStart: 0, offsetSec: 1 }));
    store.undo();
    expect(JSON.stringify(store.doc), "one undo must restore the whole trim").toBe(before);
  });

  it("a move is ONE history entry", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4));
    const clipId = store.doc.arrangement.audioClips![0]!.id;
    const before = JSON.stringify(store.doc);
    store.execute(moveAudioClip(store.doc, clipId, 2));
    store.undo();
    expect(JSON.stringify(store.doc)).toBe(before);
  });

  it("a resize is ONE history entry", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4));
    const clipId = store.doc.arrangement.audioClips![0]!.id;
    const before = JSON.stringify(store.doc);
    store.execute(resizeAudioClip(store.doc, clipId, 2));
    store.undo();
    expect(JSON.stringify(store.doc)).toBe(before);
  });

  it("undo past the beginning and redo past the end are safe no-ops", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4));
    const clipId = store.doc.arrangement.audioClips![0]!.id;
    store.undo();
    store.undo();
    store.undo();
    expect((store.doc.arrangement.audioClips ?? []).length, "undoing past the start must not resurrect the clip").toBe(
      0,
    );
    store.redo();
    store.redo();
    store.redo();
    expect((store.doc.arrangement.audioClips ?? []).length).toBe(1);
    expect(store.doc.arrangement.audioClips![0]!.id).toBe(clipId);
  });
});
