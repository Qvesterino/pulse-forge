/**
 * Collaboration validation tests.
 *
 * Tests that two Y.Doc instances sync correctly by simulating
 * what BroadcastChannel does — passing updates between Y.Docs directly.
 * This validates the CRDT architecture works before deploying a server.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDocStore } from "../src/collab/YDocStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { projectToYDoc, yDocToProject } from "../src/collab/YDocAdapter";

/** Simulate BroadcastChannel sync — apply source's full state to target. */
function syncDocs(source: Y.Doc, target: Y.Doc): void {
  const update = Y.encodeStateAsUpdate(source);
  Y.applyUpdate(target, update);
}

describe("Y.Doc CRDT sync", () => {
  it("two Y.Docs sync initial state", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const map1 = doc1.getMap("project");
    map1.set("name", "Test Project");
    map1.set("bpm", 120);
    syncDocs(doc1, doc2);
    const map2 = doc2.getMap("project");
    expect(map2.get("name")).toBe("Test Project");
    expect(map2.get("bpm")).toBe(120);
  });

  it("local edits propagate to other doc", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const map1 = doc1.getMap("project");
    const map2 = doc2.getMap("project");
    syncDocs(doc1, doc2);

    map1.set("bpm", 140);
    syncDocs(doc1, doc2);
    expect(map2.get("bpm")).toBe(140);

    map2.set("name", "Collab Project");
    syncDocs(doc2, doc1);
    expect(map1.get("name")).toBe("Collab Project");
  });

  it("concurrent edits to different fields merge correctly", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const map1 = doc1.getMap("project");
    const map2 = doc2.getMap("project");

    map1.set("name", "Original");
    syncDocs(doc1, doc2);

    map1.set("bpm", 140);
    map2.set("name", "Edited by Tab 2");

    syncDocs(doc1, doc2);
    syncDocs(doc2, doc1);

    const snap1 = yDocToProject(doc1.getMap("project"));
    const snap2 = yDocToProject(doc2.getMap("project"));
    expect(snap1.bpm).toBe(140);
    expect(snap1.name).toBe("Edited by Tab 2");
    expect(snap2.bpm).toBe(140);
    expect(snap2.name).toBe("Edited by Tab 2");
  });

  it("concurrent edits to same field — converges", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const map1 = doc1.getMap("project");
    const map2 = doc2.getMap("project");

    map1.set("bpm", 140);
    map2.set("bpm", 160);

    syncDocs(doc1, doc2);
    syncDocs(doc2, doc1);

    expect(map1.get("bpm")).toBe(map2.get("bpm"));
    expect([140, 160]).toContain(map1.get("bpm"));
  });

  it("nested Y.Map changes propagate", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const map1 = doc1.getMap("project");
    const tracks1 = new Y.Array<unknown>();
    map1.set("tracks", tracks1);
    const track1 = new Y.Map<unknown>();
    track1.set("id", "t1");
    track1.set("name", "Drums");
    tracks1.push([track1]);
    syncDocs(doc1, doc2);

    const map2 = doc2.getMap("project");
    const tracks2 = map2.get("tracks") as Y.Array<unknown>;
    expect(tracks2.length).toBe(1);
    expect((tracks2.get(0) as Y.Map<unknown>).get("name")).toBe("Drums");

    (tracks2.get(0) as Y.Map<unknown>).set("name", "Drums Renamed");
    syncDocs(doc2, doc1);

    const track1FromDoc1 = (map1.get("tracks") as Y.Array<unknown>).get(0) as Y.Map<unknown>;
    expect(track1FromDoc1.get("name")).toBe("Drums Renamed");
  });

  it("Y.Array operations merge correctly", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const map1 = doc1.getMap("project");
    const arr1 = new Y.Array<string>();
    map1.set("items", arr1);
    arr1.push(["a", "b"]);
    syncDocs(doc1, doc2);

    const map2 = doc2.getMap("project");
    const arr2 = map2.get("items") as Y.Array<string>;
    arr1.push(["c"]);
    arr2.push(["d"]);

    syncDocs(doc1, doc2);
    syncDocs(doc2, doc1);

    const items1 = (map1.get("items") as Y.Array<string>).toArray();
    const items2 = (map2.get("items") as Y.Array<string>).toArray();
    expect(items1.sort()).toEqual(["a", "b", "c", "d"]);
    expect(items2.sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("YDocStore collaboration", () => {
  it("two YDocStore instances share the same Y.Doc adapter", () => {
    const doc = createProjectFromTemplate("house");
    const yDoc1 = new Y.Doc();
    projectToYDoc(doc, yDoc1.getMap("project"));
    const store1 = new YDocStore(yDoc1);

    expect(store1.yDocRef).toBe(yDoc1);
    expect(store1.doc.bpm).toBe(doc.bpm);
  });

  it("undo/redo works independently", () => {
    const doc = createProjectFromTemplate("house");
    const originalBpm = doc.bpm;
    const yDoc = new Y.Doc();
    projectToYDoc(doc, yDoc.getMap("project"));
    const store = new YDocStore(yDoc);

    store.execute({
      type: "setBpm",
      label: "BPM 150",
      execute: (d) => ({ ...d, bpm: 150 }),
      undo: (d) => ({ ...d, bpm: originalBpm }),
    });
    expect(store.doc.bpm).toBe(150);
    store.undo();
    expect(store.doc.bpm).toBe(originalBpm);
    store.redo();
    expect(store.doc.bpm).toBe(150);
  });

  it("refreshSnapshot re-reads from Y.Doc", () => {
    const doc = createProjectFromTemplate("house");
    const yDoc = new Y.Doc();
    projectToYDoc(doc, yDoc.getMap("project"));
    const store = new YDocStore(yDoc);

    yDoc.getMap("project").set("bpm", 180);
    store.refreshSnapshot();
    expect(store.doc.bpm).toBe(180);
  });

  it("full round-trip: project → Y.Doc → sync → project", () => {
    const original = createProjectFromTemplate("scene-score");
    const yDoc1 = new Y.Doc();
    projectToYDoc(original, yDoc1.getMap("project"));
    const yDoc2 = new Y.Doc();
    syncDocs(yDoc1, yDoc2);
    const restored = yDocToProject(yDoc2.getMap("project"));

    expect(restored.name).toBe(original.name);
    expect(restored.tracks.length).toBe(original.tracks.length);
    expect(restored.patterns.length).toBe(original.patterns.length);
    expect(restored.scenes.length).toBe(original.scenes.length);
    expect(restored.arrangement.clips.length).toBe(original.arrangement.clips.length);
  });

  it("two YDocStore instances on shared Y.Doc see each other's changes", () => {
    const doc = createProjectFromTemplate("house");
    const yDoc = new Y.Doc();
    projectToYDoc(doc, yDoc.getMap("project"));

    const store1 = new YDocStore(yDoc);
    const store2 = new YDocStore(yDoc);

    // Store1 changes BPM
    store1.execute({ type: "setBpm", label: "BPM", execute: (d) => ({ ...d, bpm: 150 }), undo: (d) => d });
    // Both stores read from the same Y.Doc — should see the change
    expect(store1.doc.bpm).toBe(150);
    store2.refreshSnapshot();
    expect(store2.doc.bpm).toBe(150);

    // Store2 changes name
    store2.execute({
      type: "setProjectName",
      label: "Name",
      execute: (d) => ({ ...d, name: "Collab" }),
      undo: (d) => d,
    });
    expect(store2.doc.name).toBe("Collab");
    store1.refreshSnapshot();
    expect(store1.doc.name).toBe("Collab");
    // BPM should still be 150
    expect(store1.doc.bpm).toBe(150);
  });

  it("three stores on shared Y.Doc merge concurrent edits", () => {
    const doc = createProjectFromTemplate("house");
    const yDoc = new Y.Doc();
    projectToYDoc(doc, yDoc.getMap("project"));

    const stores = [0, 1, 2].map(() => new YDocStore(yDoc));

    stores[0].execute({ type: "setBpm", label: "BPM", execute: (d) => ({ ...d, bpm: 130 }), undo: (d) => d });
    stores[1].execute({
      type: "setProjectName",
      label: "Name",
      execute: (d) => ({ ...d, name: "Tab2" }),
      undo: (d) => d,
    });
    stores[2].execute({
      type: "setMasterConfig",
      label: "Master",
      execute: (d) => ({ ...d, master: { ...d.master, masterGain: 0.5 } }),
      undo: (d) => d,
    });

    // All three stores should see all changes after refreshSnapshot
    for (const s of stores) {
      s.refreshSnapshot();
      expect(s.doc.bpm).toBe(130);
      expect(s.doc.name).toBe("Tab2");
      expect(s.doc.master.masterGain).toBe(0.5);
    }
  });

  it("refreshSnapshot picks up external Y.Doc mutations", () => {
    const doc = createProjectFromTemplate("house");
    const yDoc = new Y.Doc();
    projectToYDoc(doc, yDoc.getMap("project"));
    const store = new YDocStore(yDoc);

    expect(store.doc.bpm).toBe(124);

    // External mutation (simulates y-websocket sync)
    yDoc.getMap("project").set("bpm", 200);
    store.refreshSnapshot();
    expect(store.doc.bpm).toBe(200);

    // Multiple external mutations. Out-of-range BPM is sanitized on read —
    // every other ingest path (schema load, import, setBpm) clamps to
    // 20..300, so collab reads must not smuggle in an unusable tempo.
    yDoc.getMap("project").set("name", "Remote Edit");
    yDoc.getMap("project").set("bpm", 999);
    store.refreshSnapshot();
    expect(store.doc.name).toBe("Remote Edit");
    expect(store.doc.bpm).toBe(300);
  });
});
