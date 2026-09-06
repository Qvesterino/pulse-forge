import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDocStore } from "../src/collab/YDocStore";
import { setBpm, setProjectName } from "../src/commands/commands";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { randomRoomId, collabParamsFromSearch, shareUrl } from "../src/collab/CollabSession";

describe("YDocStore — command execution", () => {
  it("executes commands through the CRDT (fallback diff path)", () => {
    const store = YDocStore.fromDocument(createProjectFromTemplate("house"));
    store.execute(setBpm(store.doc, 145));
    expect(store.doc.bpm).toBe(145);
    // The Y.Doc itself carries the change (what gets synced).
    expect(store.yDocRef.getMap("project").get("bpm")).toBe(145);
  });

  it("undo reverts local edits and redo restores them", () => {
    const store = YDocStore.fromDocument(createProjectFromTemplate("house"));
    const original = store.doc.bpm;
    store.execute(setBpm(store.doc, 150));
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(store.doc.bpm).toBe(original);
    store.redo();
    expect(store.doc.bpm).toBe(150);
  });

  it("records real command labels in history (undo panel parity)", () => {
    const store = YDocStore.fromDocument(createProjectFromTemplate("house"));
    store.execute(setBpm(store.doc, 130));
    store.execute(setProjectName(store.doc, "Jam Mix"));
    const labels = store.history.map((h) => h.label);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(store.lastCommandLabel).toMatch(/Jam Mix/);
  });

  it("remote updates are NOT undoable locally (undo stays user-scoped)", () => {
    const local = YDocStore.fromDocument(createProjectFromTemplate("house"));
    // Simulate a remote peer: a different Y.Doc synced in with a foreign origin.
    const remote = new Y.Doc();
    const remoteMap = remote.getMap("project");
    // Build a full doc state from the local one, tweak it, and apply as "remote".
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local.yDocRef));
    remoteMap.set("bpm", 999);
    Y.applyUpdate(local.yDocRef, Y.encodeStateAsUpdate(remote));

    // The remote change arrived (sanitized: out-of-range BPM clamps to the
    // supported 20..300 range, matching every other ingest path)…
    expect(local.doc.bpm).toBe(300);
    // …but never entered the local undo stack.
    expect(local.canUndo).toBe(false);
  });

  it("concurrent stores converge (CRDT merge)", () => {
    const a = YDocStore.fromDocument(createProjectFromTemplate("house"));
    const b = new YDocStore(new Y.Doc());
    // b starts empty, syncs from a, then both edit independently.
    Y.applyUpdate(b.yDocRef, Y.encodeStateAsUpdate(a.yDocRef));
    a.execute(setProjectName(a.doc, "From A"));
    b.execute(setBpm(b.doc, 111));
    // Exchange updates both ways (last-writer-wins per key on the map).
    Y.applyUpdate(a.yDocRef, Y.encodeStateAsUpdate(b.yDocRef));
    Y.applyUpdate(b.yDocRef, Y.encodeStateAsUpdate(a.yDocRef));
    expect(a.doc.bpm).toBe(b.doc.bpm);
    expect(a.doc.name).toBe(b.doc.name);
  });
});

describe("collab helpers", () => {
  it("randomRoomId is 6 chars from the lookalike-free alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const id = randomRoomId();
      expect(id).toMatch(/^[a-z0-9]{6}$/);
      expect(id).not.toMatch(/[ilo01]/);
    }
  });

  it("collabParamsFromSearch: null without a room, defaults the server", () => {
    expect(collabParamsFromSearch("")).toBeNull();
    expect(collabParamsFromSearch("?foo=1")).toBeNull();
    expect(collabParamsFromSearch("?collab=k3x9qz")).toEqual({
      roomId: "k3x9qz",
      serverUrl: collabParamsFromSearch("?collab=x")!.serverUrl,
    });
  });

  it("collabParamsFromSearch: a ?server= override may never redirect off the app origin (security)", () => {
    // A crafted collab link pointing the victim's live sync at an attacker
    // relay must fall back to the default server. (Self-hosted relays on
    // other hosts remain available via the CollabPanel input, which passes
    // the server explicitly — this gate only covers URL-provided values.)
    const malicious = [
      "ws%3A%2F%2Fevil%3A8080", // ws://evil:8080
      "wss%3A%2F%2Fevil.example", // wss://evil.example
      "https%3A%2F%2Fevil.example", // wrong scheme
      "javascript%3Aalert(1)", // nonsense scheme
      "%3A%2F%2F", // unparseable
    ];
    for (const server of malicious) {
      const parsed = collabParamsFromSearch(`?collab=k3x9qz&server=${server}`);
      expect(parsed).not.toBeNull();
      expect(parsed!.serverUrl).toBe(collabParamsFromSearch("?collab=x")!.serverUrl);
    }
    // Same-host override (dev relay scenario) is still honoured.
    const sameHost = collabParamsFromSearch(
      `?collab=k3x9qz&server=${encodeURIComponent(`ws://${location.hostname}:1234`)}`,
    );
    expect(sameHost!.serverUrl).toBe(`ws://${location.hostname}:1234`);
  });

  it("shareUrl encodes the room (and the server only when custom)", () => {
    const defaultServer = collabParamsFromSearch("?collab=x")!.serverUrl;
    const plain = shareUrl("abc123", defaultServer, "https://forge.app/");
    expect(plain).toBe("https://forge.app/?collab=abc123");
    const custom = shareUrl("abc123", "ws://custom:9", "https://forge.app/");
    expect(custom).toBe("https://forge.app/?collab=abc123&server=ws%3A%2F%2Fcustom%3A9");
  });
});
