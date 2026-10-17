import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyRenderStamp } from "../src/export/verifyRenderStamp";
import { buildRenderManifest, hashPcmChannels } from "../src/export/renderManifest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { SampleBank } from "../src/sample-library/factory";

/**
 * WAVE 2/C — REPRODUCE / VERIFY. Entered through the real runner; only the
 * offline renderer is mocked (jsdom has no OfflineAudioContext). The hash
 * comparison, the settings replay and the honest mismatch reporting are all
 * the production code.
 */

const renderProjectMock = vi.hoisted(() => vi.fn());

vi.mock("../src/rendering/renderer", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/rendering/renderer")>();
  return { ...mod, renderProject: renderProjectMock };
});

const CHANNELS = [new Float32Array([0.5, -0.5, 0.25]), new Float32Array([0.4, -0.4, 0.2])];

function fakeBuffer(channels: Float32Array[] = CHANNELS): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0]!.length,
    sampleRate: 48000,
    duration: 1,
    getChannelData: (channel: number) => channels[channel]!,
  } as unknown as AudioBuffer;
}

beforeEach(() => {
  renderProjectMock.mockReset();
  renderProjectMock.mockResolvedValue(fakeBuffer());
});

describe("verifyRenderStamp", () => {
  it("re-renders with the stamped settings and proves a bit-identical match", async () => {
    const doc = createProjectFromTemplate("house");
    const hash = await hashPcmChannels(CHANNELS);
    const manifest = buildRenderManifest({
      doc,
      scope: "master",
      mode: "song",
      sampleRate: 48000,
      bitDepth: 24,
      durationSec: 1,
      renderHash: hash,
      settings: { quality: "studio", masterProcessing: true, tailSeconds: 2 },
    });

    const outcome = await verifyRenderStamp({ manifest, doc, bank: {} as SampleBank });

    expect(outcome.status).toBe("match");
    expect(outcome.reRendered).toBe(true);
    expect(outcome.reRenderedHash).toBe(hash);
    // The reproduction recipe reached the renderer verbatim.
    expect(renderProjectMock).toHaveBeenCalledTimes(1);
    expect(renderProjectMock.mock.calls[0]![2]).toMatchObject({
      mode: "song",
      sampleRate: 48000,
      quality: "studio",
      masterProcessing: true,
      tailSeconds: 2,
    });
  });

  it("reports a mismatch when the project (or its settings) changed", async () => {
    const doc = createProjectFromTemplate("house");
    const manifest = buildRenderManifest({
      doc,
      scope: "master",
      mode: "song",
      sampleRate: 48000,
      bitDepth: 24,
      durationSec: 1,
      renderHash: "c".repeat(64),
      settings: { quality: "studio", masterProcessing: true },
    });

    const outcome = await verifyRenderStamp({ manifest, doc, bank: {} as SampleBank });

    expect(outcome.status).toBe("hash-mismatch");
    expect(outcome.reRendered).toBe(true);
    expect(outcome.detail).toContain("changed since this file was written");
  });

  it("does not waste a render on a different project", async () => {
    const doc = createProjectFromTemplate("house");
    const manifest = buildRenderManifest({
      doc: { ...doc, id: "some-other-project" },
      scope: "master",
      mode: "song",
      sampleRate: 48000,
      bitDepth: 24,
      durationSec: 1,
      renderHash: "d".repeat(64),
    });

    const outcome = await verifyRenderStamp({ manifest, doc, bank: {} as SampleBank });

    expect(outcome.status).toBe("project-mismatch");
    expect(outcome.reRendered).toBe(false);
    expect(renderProjectMock).not.toHaveBeenCalled();
  });

  it("falls back to mode + rate for manifests written without settings", async () => {
    const doc = createProjectFromTemplate("house");
    const hash = await hashPcmChannels(CHANNELS);
    const manifest = {
      ...buildRenderManifest({
        doc,
        scope: "master",
        mode: "song",
        sampleRate: 44100,
        bitDepth: 16,
        durationSec: 1,
        renderHash: hash,
      }),
      settings: undefined,
    };

    const outcome = await verifyRenderStamp({ manifest, doc, bank: {} as SampleBank });

    expect(outcome.status).toBe("match");
    const options = renderProjectMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(options.mode).toBe("song");
    expect(options.sampleRate).toBe(44100);
    expect(options.quality).toBeUndefined();
  });

  it("surfaces an aborted verification as an AbortError (the caller settles the job)", async () => {
    const doc = createProjectFromTemplate("house");
    const manifest = buildRenderManifest({
      doc,
      scope: "master",
      mode: "song",
      sampleRate: 48000,
      bitDepth: 24,
      durationSec: 1,
      renderHash: "e".repeat(64),
    });
    const controller = new AbortController();
    renderProjectMock.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("Export cancelled", "AbortError");
    });

    await expect(
      verifyRenderStamp({ manifest, doc, bank: {} as SampleBank, signal: controller.signal }),
    ).rejects.toThrow(/cancelled/i);
  });
});
