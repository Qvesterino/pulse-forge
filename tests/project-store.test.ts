import { describe, expect, it } from "vitest";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import { setBpm, setProjectName, createPattern, setStepVelocityCommand } from "../src/commands/commands";
import { getDrumTrack } from "../src/project-model/types";
import { ProjectStore } from "../src/store/ProjectStore";

describe("ProjectStore — history shape", () => {
  it("starts with empty undo and redo stacks and saved status", () => {
    const store = new ProjectStore(createDefaultProject());
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
    expect(store.lastCommandLabel).toBeNull();
    expect(store.saveStatus).toBe("saved");
  });

  it("exposes the label of the most recent executed command", () => {
    const store = new ProjectStore(createDefaultProject());
    store.execute(setBpm(store.doc, 130));
    expect(store.lastCommandLabel).toMatch(/130/);
  });

  it("clears the redo stack when a new command is executed after undo", () => {
    const store = new ProjectStore(createDefaultProject());
    store.execute(setBpm(store.doc, 130));
    store.execute(setProjectName(store.doc, "A"));
    store.undo();
    store.undo();
    expect(store.canRedo).toBe(true);
    store.execute(setBpm(store.doc, 150));
    expect(store.canRedo).toBe(false);
  });

  it("undoes a sequence of commands in reverse order", () => {
    const store = new ProjectStore(createDefaultProject());
    store.execute(setBpm(store.doc, 130));
    store.execute(setProjectName(store.doc, "Two"));
    expect(store.doc.bpm).toBe(130);
    expect(store.doc.name).toBe("Two");
    store.undo();
    expect(store.doc.name).toBe("Untitled Beat");
    expect(store.doc.bpm).toBe(130);
    store.undo();
    expect(store.doc.bpm).toBe(124);
  });

  it("redoes commands in forward order", () => {
    const store = new ProjectStore(createDefaultProject());
    store.execute(setBpm(store.doc, 130));
    store.execute(setProjectName(store.doc, "Two"));
    store.undo();
    store.undo();
    expect(store.doc.bpm).toBe(124);
    expect(store.doc.name).toBe("Untitled Beat");
    store.redo();
    expect(store.doc.bpm).toBe(130);
    expect(store.doc.name).toBe("Untitled Beat");
    store.redo();
    expect(store.doc.name).toBe("Two");
  });

  it("caps the undo stack at 256 entries", () => {
    const store = new ProjectStore(createDefaultProject());
    for (let i = 0; i < 300; i++) {
      store.execute(setBpm(store.doc, 100 + (i % 50)));
    }
    expect(store.canUndo).toBe(true);
    // Drain undo and confirm we only have 256 steps of history.
    let undos = 0;
    while (store.canUndo) {
      store.undo();
      undos++;
    }
    expect(undos).toBe(256);
  });

  it("marks the document dirty after any mutation", () => {
    const store = new ProjectStore(createDefaultProject());
    expect(store.saveStatus).toBe("saved");
    store.execute(setBpm(store.doc, 128));
    expect(store.saveStatus).toBe("dirty");
    store.undo();
    expect(store.saveStatus).toBe("dirty");
  });
});

describe("ProjectStore — replaceDoc", () => {
  it("resets both undo and redo stacks", () => {
    const store = new ProjectStore(createDefaultProject());
    store.execute(setBpm(store.doc, 130));
    store.execute(setProjectName(store.doc, "Two"));
    store.undo();
    expect(store.canRedo).toBe(true);
    store.replaceDoc(createDefaultProject());
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
    expect(store.lastCommandLabel).toBeNull();
  });

  it("emits a notification to subscribers", () => {
    const store = new ProjectStore(createDefaultProject());
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.replaceDoc(createDefaultProject());
    expect(notifications).toBe(1);
  });

  it("applies normalization on a freshly replaced document", () => {
    const store = new ProjectStore(createDefaultProject());
    const doc = createDefaultProject();
    const broken = { ...doc, bpm: 5000 } as typeof doc;
    const fixed = normalizeProject(broken);
    store.replaceDoc(fixed);
    expect(store.doc.bpm).toBeLessThanOrEqual(300);
  });
});

describe("ProjectStore — subscribers", () => {
  it("notifies once per mutation", () => {
    const store = new ProjectStore(createDefaultProject());
    let count = 0;
    store.subscribe(() => count++);
    store.execute(setBpm(store.doc, 130));
    store.undo();
    store.redo();
    expect(count).toBe(3);
  });

  it("stops notifying after unsubscribe", () => {
    const store = new ProjectStore(createDefaultProject());
    let count = 0;
    const unsubscribe = store.subscribe(() => count++);
    store.execute(setBpm(store.doc, 130));
    expect(count).toBe(1);
    unsubscribe();
    store.execute(setBpm(store.doc, 100));
    expect(count).toBe(1);
  });

  it("supports multiple independent subscribers", () => {
    const store = new ProjectStore(createDefaultProject());
    let aCount = 0;
    let bCount = 0;
    store.subscribe(() => aCount++);
    store.subscribe(() => bCount++);
    store.execute(setBpm(store.doc, 130));
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
  });
});

describe("ProjectStore — fast in-place operations", () => {
  it("a step toggle round-trips with the same step state after multiple undos", () => {
    const store = new ProjectStore(createDefaultProject());
    const pad = getDrumTrack(store.doc).pads[0];
    const initial = store.doc.patterns[0].rows[pad.id][0];
    store.execute(setStepVelocityCommand(store.doc, pad.id, 0, 0.9));
    expect(store.doc.patterns[0].rows[pad.id][0]).toBe(0.9);
    store.execute(createPattern(store.doc));
    store.undo();
    store.undo();
    expect(store.doc.patterns[0].rows[pad.id][0]).toBe(initial);
  });
});
