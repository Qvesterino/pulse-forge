import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * QUICK BOUNCE — the shared render + encode + download pipeline behind the
 * in-app "export wav/mp3" intent AND the MCP kyx_export tool. The heavy
 * pieces (renderer, LAME) are mocked: this pins the CONTRACT — right
 * pipeline per format, right filenames, honest completion report — not the
 * DSP (that's the renderer/export suites' job).
 */

const renderProject = vi.fn();
const encodeMp3 = vi.fn();
const encodeWavAsync = vi.fn();
const downloadBlob = vi.fn();
const downloadWav = vi.fn();

vi.mock("../src/rendering/renderer", () => ({ renderProject: (...args: unknown[]) => renderProject(...args) }));
vi.mock("../src/export/mp3", () => ({ encodeMp3: (...args: unknown[]) => encodeMp3(...args) }));
vi.mock("../src/rendering/wav", () => ({
  sanitizeFilename: (name: string) => name.replace(/[^a-z0-9-_ ]/gi, "").trim() || "project",
  encodeWavAsync: (...args: unknown[]) => encodeWavAsync(...args),
  downloadWav: (...args: unknown[]) => downloadWav(...args),
}));
vi.mock("../src/export/download", () => ({ downloadBlob: (...args: unknown[]) => downloadBlob(...args) }));

import { quickBounceDownload } from "../src/export/quick-bounce";
import type { ProjectDocument } from "../src/project-model/types";
import type { SampleBank } from "../src/sample-library/factory";

function fakeDoc(name: string): ProjectDocument {
  return { name } as unknown as ProjectDocument;
}

const bank = {} as SampleBank;
const buffer = { duration: 12.34 };

beforeEach(() => {
  vi.clearAllMocks();
  renderProject.mockResolvedValue(buffer);
});

describe("quick bounce (shared export pipeline)", () => {
  it("mp3: renders the song, encodes 320 kbps, downloads <name>-320.mp3, reports", async () => {
    encodeMp3.mockResolvedValue({ size: 1_500_000 });
    const report = await quickBounceDownload(fakeDoc("My Beat"), bank, { format: "mp3" });
    expect(renderProject).toHaveBeenCalledWith(expect.anything(), bank, { mode: "song", sampleRate: 44100 });
    expect(encodeMp3).toHaveBeenCalledWith(buffer, { kbps: 320 });
    expect(downloadBlob).toHaveBeenCalledWith(expect.anything(), "My Beat-320.mp3");
    expect(report).toContain("MP3 exported");
    expect(report).toContain("320 kbps");
  });

  it("wav: 16-bit encode, downloads <name>-master.wav, reports", async () => {
    encodeWavAsync.mockResolvedValue({ byteLength: 2_000_000 });
    const report = await quickBounceDownload(fakeDoc("My Beat"), bank, { format: "wav" });
    expect(encodeWavAsync).toHaveBeenCalledWith(buffer, 16, {});
    expect(downloadWav).toHaveBeenCalledWith({ byteLength: 2_000_000 }, "My Beat-16bit.wav");
    expect(report).toContain("WAV exported");
    expect(report).toContain("16-bit");
  });

  it("render failures reject (the caller reports the honest error)", async () => {
    renderProject.mockRejectedValue(new Error("no audio context"));
    await expect(quickBounceDownload(fakeDoc("x"), bank, { format: "wav" })).rejects.toThrow("no audio context");
  });
});
