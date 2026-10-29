import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { setTrackParams } from "../src/commands/project";
import { runAudibleVerification } from "../src/mcp/audible-verification";
import { clearAudibleVerification, getAudibleVerification } from "../src/analysis/audible-verification-store";
import type { ProjectDocument } from "../src/project-model/types";
import type { SampleBank } from "../src/sample-library/factory";
import type { RenderOptions } from "../src/rendering/renderer";

vi.mock("../src/rendering/track-renderer", () => ({
  renderTrack: vi.fn(async (doc: ProjectDocument, trackId: string, _bank: unknown, options: RenderOptions) => {
    const frames = options.sampleRate * 8;
    const data = new Float32Array(frames);
    const gain = doc.tracks.find((track) => track.id === trackId)?.gain ?? 1;
    for (let index = 0; index < frames; index += 1) {
      data[index] = Math.sin((2 * Math.PI * 220 * index) / options.sampleRate) * 0.5 * gain;
    }
    return {
      length: frames,
      sampleRate: options.sampleRate,
      numberOfChannels: 2,
      duration: frames / options.sampleRate,
      getChannelData: () => data,
    } as unknown as AudioBuffer;
  }),
}));
vi.mock("../src/rendering/renderer", () => ({
  renderProject: vi.fn(async (_doc: ProjectDocument, _bank: unknown, options: RenderOptions) => {
    const frames = options.sampleRate * 8;
    const data = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
      data[index] = Math.sin((2 * Math.PI * 220 * index) / options.sampleRate) * 0.5;
    }
    return {
      length: frames,
      sampleRate: options.sampleRate,
      numberOfChannels: 2,
      duration: frames / options.sampleRate,
      getChannelData: () => data,
    } as unknown as AudioBuffer;
  }),
}));

afterEach(() => clearAudibleVerification());

describe("audible verification orchestration", () => {
  it("captures a token, compares after a gain edit, and publishes the notice at the new revision", async () => {
    const doc = createProjectFromTemplate("house");
    const lead = doc.tracks.find((track) => track.kind === "instrument")!;
    const store = new ProjectStore(doc);
    const services = { store, bank: {} as SampleBank };

    const baseline = await runAudibleVerification(services, {
      op: "capture",
      trackId: lead.id,
      startBar: 1,
      bars: 2,
    });
    expect(baseline.token).toMatch(/^aud-/);
    expect(baseline.before.rmsDb).toBeLessThan(0);
    expect(baseline.before.contentHash).toContain(":");

    const gainBefore = store.getDoc().tracks.find((track) => track.id === lead.id)!.gain;
    store.execute(setTrackParams(store.getDoc(), lead.id, { gain: gainBefore * 0.25 }));
    const result = await runAudibleVerification(services, { op: "compare", token: baseline.token });

    expect(result.comparison?.verified).toBe(true);
    expect(result.comparison?.audibleChanged).toBe(true);
    expect(result.comparison?.verdict).toBe("changed");
    expect(Math.abs((result.comparison?.deltas.rmsDb ?? 0) + 12)).toBeLessThan(0.3);
    expect(result.revisionAfter).toBe(store.getRevision());

    const notice = getAudibleVerification();
    expect(notice).toMatchObject({
      docId: doc.id,
      revision: store.getRevision(),
      audibleChanged: true,
      verified: true,
    });
  });

  it("refuses a compare for an unknown token without publishing a notice", async () => {
    const doc = createProjectFromTemplate("house");
    const store = new ProjectStore(doc);
    const services = { store, bank: {} as SampleBank };
    await expect(runAudibleVerification(services, { op: "compare", token: "aud-nope" })).rejects.toThrow(
      /token is unknown/,
    );
    expect(getAudibleVerification()).toBeNull();
  });
});
