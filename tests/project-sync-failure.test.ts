// Audit E-03: a failed project sync must not end in "exported".
//
// `setProject` swallows a thrown body so a hostile document cannot break the
// app. Before this wave the console was the only signal: the export rendered
// the HALF-BUILT graph, wrote the file and reported success.
//
// The teeth probe: drop the `lastProjectSyncFailure` assignment in the catch
// (or make `assertProjectGraphBuilt` return early) and the RED cases below go
// green again.

import { describe, expect, it } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { assertProjectGraphBuilt } from "../src/rendering/renderer";
import { createDefaultProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/** A document that throws on every read — the body cannot survive it. */
function hostileDocument(): ProjectDocument {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("hostile document");
      },
    },
  ) as unknown as ProjectDocument;
}

describe("project sync failure (audit E-03)", () => {
  it("RECORDS a failed project sync as a fact, not only as a console line", async () => {
    const engine = new AudioEngine();
    // The console is expected to carry the trace — the test must not fail on it.
    const consoleError = console.error;
    console.error = () => {};
    try {
      engine.setProject(hostileDocument());
      await engine.whenProjectSettled();
    } finally {
      console.error = consoleError;
    }

    expect(engine.projectSyncFailure).not.toBeNull();
    expect(engine.projectSyncFailure?.message).toContain("hostile document");
  });

  it("reports NO failure when the project synced", async () => {
    const engine = new AudioEngine();
    engine.setProject(createDefaultProject());
    await engine.whenProjectSettled();

    expect(engine.projectSyncFailure).toBeNull();
  });

  it("REFUSES the export when the graph could not be built", () => {
    let thrown: unknown = null;
    try {
      assertProjectGraphBuilt({ message: "effect factory exploded" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("effect factory exploded");
    expect(message).toContain("not written");
  });

  it("lets the export through when the graph is whole", () => {
    expect(() => assertProjectGraphBuilt(null)).not.toThrow();
  });
});
