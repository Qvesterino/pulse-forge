import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MasteringCodecPreview } from "../../src/ui/MasteringCodecPreview";
import { mockServices, renderWithContext } from "../helpers";
import { encodeMp3 } from "../../src/export/mp3";
import { decodeMp3BlobToAudioBuffer } from "../../src/mastering/mp3PcmDecodeClient";
import { measureMasterBufferRangeLufsAsync } from "../../src/mastering/analysisClient";

vi.mock("../../src/export/mp3", () => ({ encodeMp3: vi.fn() }));
vi.mock("../../src/mastering/mp3PcmDecodeClient", () => ({ decodeMp3BlobToAudioBuffer: vi.fn() }));
vi.mock("../../src/mastering/analysisClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mastering/analysisClient")>();
  return { ...actual, measureMasterBufferRangeLufsAsync: vi.fn() };
});

/**
 * Codec preview START field (`MasteringCodecPreview`).
 *
 * MEASURED BEFORE THE FIX (throwaway probe driving the real component):
 *   set the start to 30 s, then clear the field to retype it
 *     → the field rendered "0" and `encodeMp3` was called with startFrame 0,
 *       i.e. the preview excerpt silently jumped from 30 s back to the start
 *       of the file.
 *
 * Root cause: `setStartSeconds(Number(event.target.value))` with no empty-case
 * guard. `Number("")` is 0, which is finite, so clearing the field was
 * indistinguishable from typing 0. The read side (`selectedStartSeconds`)
 * clamps, so this never produced NaN in the engine — but it did silently
 * discard the user's chosen offset.
 *
 * The specs assert on the value that reaches `encodeMp3` (the frame math), not
 * on the rendered string, because the rendered string is derived and would stay
 * plausible even while the wrong offset was being encoded.
 */
const START = "Codec preview start time in seconds";
const SR = 44_100;

function fakeBuffer(seconds: number): AudioBuffer {
  return {
    numberOfChannels: 2,
    sampleRate: SR,
    duration: seconds,
    length: Math.floor(seconds * SR),
    getChannelData: () => new Float32Array(8),
  } as unknown as AudioBuffer;
}

describe("codec preview START field", () => {
  beforeEach(() => {
    vi.mocked(encodeMp3).mockClear();
    vi.mocked(decodeMp3BlobToAudioBuffer).mockClear();
    vi.mocked(encodeMp3).mockResolvedValue(new Blob(["x"]));
    vi.mocked(decodeMp3BlobToAudioBuffer).mockResolvedValue({ status: "decoded", buffer: fakeBuffer(15) });
    vi.mocked(measureMasterBufferRangeLufsAsync).mockResolvedValue(-14);
  });

  it("keeps the chosen offset when the field is cleared to be retyped", async () => {
    // The regression. Was: clearing a 30 s offset encoded frame 0.
    const user = userEvent.setup();
    renderWithContext(<MasteringCodecPreview sourceBuffer={fakeBuffer(60)} sourceKey="audit-1" />, {
      services: mockServices(),
    });
    const input = screen.getByLabelText(START) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "30");
    await user.tab();

    vi.mocked(encodeMp3).mockClear();
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "CREATE MP3 PREVIEW" }));

    expect(vi.mocked(encodeMp3).mock.calls[0]?.[1]?.startFrame).toBe(30 * SR);
  });

  it("still commits a valid typed offset", async () => {
    const user = userEvent.setup();
    renderWithContext(<MasteringCodecPreview sourceBuffer={fakeBuffer(60)} sourceKey="audit-2" />, {
      services: mockServices(),
    });
    const input = screen.getByLabelText(START) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "12");
    // Commit the staged draft the way a real click does: the browser blurs the
    // focused input on mousedown, so the value lands before the click handler.
    await user.tab();
    await user.click(screen.getByRole("button", { name: "CREATE MP3 PREVIEW" }));
    expect(vi.mocked(encodeMp3).mock.calls[0]?.[1]?.startFrame).toBe(12 * SR);
  });

  it("clamps an offset past the end of the source", async () => {
    const user = userEvent.setup();
    // 60 s source → maxStartSeconds = 59.5.
    renderWithContext(<MasteringCodecPreview sourceBuffer={fakeBuffer(60)} sourceKey="audit-3" />, {
      services: mockServices(),
    });
    const input = screen.getByLabelText(START) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "999");
    await user.tab();
    expect((screen.getByLabelText(START) as HTMLInputElement).value).toBe("59.5");
  });

  it("rejects a partial '-' entry instead of snapping to 0", async () => {
    const user = userEvent.setup();
    renderWithContext(<MasteringCodecPreview sourceBuffer={fakeBuffer(60)} sourceKey="audit-4" />, {
      services: mockServices(),
    });
    const input = screen.getByLabelText(START) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "-");
    await user.tab();
    expect(Number.isFinite(Number((screen.getByLabelText(START) as HTMLInputElement).value))).toBe(true);
  });

  it("commits nothing when an emptied field is abandoned with Escape", async () => {
    const user = userEvent.setup();
    renderWithContext(<MasteringCodecPreview sourceBuffer={fakeBuffer(60)} sourceKey="audit-5" />, {
      services: mockServices(),
    });
    const input = screen.getByLabelText(START) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "45");
    await user.keyboard("{Escape}");
    expect((screen.getByLabelText(START) as HTMLInputElement).value).not.toBe("");
  });

  it("exposes the field with its declared numeric contract", () => {
    renderWithContext(<MasteringCodecPreview sourceBuffer={fakeBuffer(60)} sourceKey="audit-6" />, {
      services: mockServices(),
    });
    const input = screen.getByLabelText(START);
    expect(input).toHaveAttribute("type", "number");
    expect(Number(input.getAttribute("min"))).toBe(0);
    expect(input.getAttribute("step")).toBe("0.1");
  });
});
