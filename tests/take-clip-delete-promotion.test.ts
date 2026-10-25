import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc } from "./fixtures/doc";
import { addAudioTakeClip, deleteAudioClip } from "../src/commands/audioClips";

/**
 * F-07 half 1 — deleting the ACTIVE take's last clip must not silently
 * promote an alternate take OUTSIDE the undo delta.
 *
 * The MCP deleteTake op refuses the active comp (an explicit policy), but
 * the UI and the generic clip-delete path allowed the delete and let the
 * post-apply normalizer re-derive activeTakeId OUTSIDE the captured delta:
 * Ctrl+Z restored the clip while the promoted take stayed active — the
 * audible mix had changed with no word to anyone. The re-derivation now
 * happens INSIDE deleteAudioClip with the normalizer's own rule, so the
 * promotion is undoable and labeled.
 */

function setupTwoTakes() {
  const store = new ProjectStore(testDoc());
  const trackId = store.doc.tracks.find((track) => track.kind === "instrument")!.id;
  store.execute(addAudioTakeClip(store.doc, "group-1", "take-1", trackId, "factory.kick", 0, 4));
  store.execute(addAudioTakeClip(store.doc, "group-1", "take-2", trackId, "factory.kick", 0, 4));
  return { store, trackId };
}

const activeTakeOf = (doc: ReturnType<ProjectStore["getDoc"]>, groupId = "group-1"): string | undefined =>
  doc.arrangement.takeGroups?.find((item) => item.id === groupId)?.activeTakeId;

describe("deleting the active take's clip promotes INSIDE the undo delta", () => {
  it("the promotion happens and is named in the command label", () => {
    const { store } = setupTwoTakes();
    const clip = store.doc.arrangement.audioClips!.find(
      (candidate) => candidate.takeGroupId === "group-1" && candidate.takeId === "take-1",
    )!;
    const command = deleteAudioClip(store.doc, clip.id);
    store.execute(command);

    // An audible take remains — the group survives with the other take active.
    expect(activeTakeOf(store.doc)).toBe("take-2");
    expect(command.label).toMatch(/active take promoted/i);
  });

  it("undo restores the ORIGINAL active take with the clip", () => {
    const { store } = setupTwoTakes();
    const baseline = store.doc;
    const clip = store.doc.arrangement.audioClips!.find(
      (candidate) => candidate.takeGroupId === "group-1" && candidate.takeId === "take-1",
    )!;
    store.execute(deleteAudioClip(store.doc, clip.id));
    store.undo();

    expect(store.doc).toEqual(baseline);
    expect(activeTakeOf(store.doc)).toBe("take-1");
  });

  it("a non-active take's clip deletes without touching the active take", () => {
    const { store } = setupTwoTakes();
    const clip = store.doc.arrangement.audioClips!.find(
      (candidate) => candidate.takeGroupId === "group-1" && candidate.takeId === "take-2",
    )!;
    store.execute(deleteAudioClip(store.doc, clip.id));

    expect(activeTakeOf(store.doc)).toBe("take-1");
    expect(store.doc.arrangement.audioClips!.some((candidate) => candidate.takeGroupId === "group-1")).toBe(true);
  });

  it("deleting ONE of several clips of the active take keeps the active take", () => {
    const { store, trackId } = setupTwoTakes();
    store.execute(addAudioTakeClip(store.doc, "group-1", "take-1", trackId, "factory.kick", 4, 4));
    const secondClip = store.doc.arrangement.audioClips!.find(
      (candidate) => candidate.takeGroupId === "group-1" && candidate.takeId === "take-1" && candidate.startBar === 4,
    )!;
    store.execute(deleteAudioClip(store.doc, secondClip.id));

    expect(activeTakeOf(store.doc)).toBe("take-1");
    expect(
      store.doc.arrangement.audioClips!.some(
        (candidate) => candidate.takeGroupId === "group-1" && candidate.takeId === "take-1",
      ),
    ).toBe(true);
  });
});
