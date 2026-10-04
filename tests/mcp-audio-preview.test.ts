import { describe, expect, it, vi } from "vitest";
import { addArrangementClip, createScene } from "../src/commands/commands";
import type { AudioClip } from "../src/project-model/types";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createMcpPreviewDocument, mcpRenderAudioPreview } from "../src/mcp/audio-preview";
import { renderProject } from "../src/rendering/renderer";
import type { Services } from "../src/services";

vi.mock("../src/rendering/renderer", () => ({ renderProject: vi.fn() }));

function arrangementDoc() {
  let doc = createProjectFromTemplate("house");
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [], audioClips: [] } };
  doc = createScene(doc, "Preview A").execute(doc);
  const firstScene = doc.scenes[doc.scenes.length - 1];
  doc = addArrangementClip(doc, firstScene.id, 0, 4).execute(doc);
  doc = createScene(doc, "Preview B").execute(doc);
  const secondScene = doc.scenes[doc.scenes.length - 1];
  doc = addArrangementClip(doc, secondScene.id, 4, 4).execute(doc);
  const clips: AudioClip[] = [
    {
      id: "audio-inside",
      trackId: doc.tracks[0].id,
      bufferId: "test-buffer",
      startBar: 1,
      lengthBars: 4,
      offsetSec: 0,
      trimStart: 0,
      trimEnd: 1,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      stretchRate: 1,
      reverse: false,
    },
    {
      id: "audio-outside",
      trackId: doc.tracks[0].id,
      bufferId: "test-buffer",
      startBar: 4,
      lengthBars: 2,
      offsetSec: 0,
      trimStart: 0,
      trimEnd: 1,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      stretchRate: 1,
      reverse: false,
    },
  ];
  return { ...doc, arrangement: { ...doc.arrangement, audioClips: clips } };
}

describe("MCP audio preview project bounds", () => {
  it("keeps only the opening bars and shortens clips at the boundary without mutating source", () => {
    const source = arrangementDoc();
    const preview = createMcpPreviewDocument(source, 2);

    expect(preview.arrangement.clips).toHaveLength(1);
    expect(preview.arrangement.clips[0]).toMatchObject({ startBar: 0, lengthBars: 2 });
    expect(preview.arrangement.audioClips).toHaveLength(1);
    expect(preview.arrangement.audioClips?.[0]).toMatchObject({ startBar: 1, lengthBars: 1 });
    expect(source.arrangement.clips[0]).toMatchObject({ startBar: 0, lengthBars: 4 });
    expect(source.arrangement.audioClips?.[0]).toMatchObject({ startBar: 1, lengthBars: 4 });
  });

  it("bounds a pattern-only preview without truncating the live pattern", () => {
    const source = createProjectFromTemplate("house");
    const active = source.patterns.find((pattern) => pattern.id === source.activePatternId)!;
    const longPattern = { ...active, stepCount: 64 };
    const longProject = {
      ...source,
      arrangement: { ...source.arrangement, clips: [], audioClips: [] },
      patterns: source.patterns.map((pattern) => (pattern.id === active.id ? longPattern : pattern)),
    };

    const preview = createMcpPreviewDocument(longProject, 2);
    expect(preview.patterns.find((pattern) => pattern.id === active.id)?.stepCount).toBe(32);
    expect(longProject.patterns.find((pattern) => pattern.id === active.id)?.stepCount).toBe(64);
  });

  it("rejects unbounded bar counts", () => {
    expect(() => createMcpPreviewDocument(arrangementDoc(), 5)).toThrow("from 1 to 4");
  });

  it("renders a valid PCM WAV attachment from the bounded document", async () => {
    const source = arrangementDoc();
    const channels = [Float32Array.of(0.25, -0.25), Float32Array.of(0.5, -0.5)];
    const audioBuffer = {
      sampleRate: 22050,
      length: 2,
      numberOfChannels: 2,
      duration: 2 / 22050,
      getChannelData: (channel: number) => channels[channel],
    } as AudioBuffer;
    vi.mocked(renderProject).mockResolvedValue(audioBuffer);
    const services = {
      store: { getDoc: () => source },
      bank: {},
    } as unknown as Services;

    const result = await mcpRenderAudioPreview(services, { bars: 2 });
    const wavBytes = Uint8Array.from(atob(result.audio.data), (char) => char.charCodeAt(0));
    expect(String.fromCharCode(...wavBytes.subarray(0, 4))).toBe("RIFF");
    expect(result.audio.mimeType).toBe("audio/wav");
    expect(result.byteLength).toBe(wavBytes.length);
    expect(renderProject).toHaveBeenCalledWith(
      expect.objectContaining({
        arrangement: expect.objectContaining({ clips: [expect.objectContaining({ lengthBars: 2 })] }),
      }),
      services.bank,
      expect.objectContaining({ mode: "song", sampleRate: 22050, arrangementOnly: true }),
    );
  });
});
