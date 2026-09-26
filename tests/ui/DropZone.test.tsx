import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { DropZone } from "../../src/ui/DropZone";
import { mockServices, renderWithContext } from "../helpers";
import type { Command } from "../../src/commands/types";

describe("DropZone", () => {
  function makeFile(name: string, type = "audio/wav", size = 1024): File {
    const bytes = new Uint8Array(size);
    return new File([bytes], name, { type });
  }

  function dropFiles(node: HTMLElement, files: File[]) {
    fireEvent.drop(node, {
      dataTransfer: { files },
    });
  }

  it("renders the drop zone button with the aria-label", () => {
    renderWithContext(<DropZone onImport={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Drop audio files here or click to browse/i })).toBeInTheDocument();
  });

  it("shows the active state when dragging files over", () => {
    const { container } = renderWithContext(<DropZone onImport={vi.fn()} />);
    const node = container.querySelector(".drop-zone") as HTMLElement;
    fireEvent.dragOver(node, { dataTransfer: { files: [] } });
    expect(node).toHaveClass("drop-zone-active");
  });

  it("shows 'unsupported format' error when a non-audio file is dropped", async () => {
    const { container } = renderWithContext(<DropZone onImport={vi.fn()} />);
    const node = container.querySelector(".drop-zone") as HTMLElement;
    dropFiles(node, [makeFile("foo.txt", "text/plain")]);
    // Wait for async error path
    await vi.waitFor(() => {
      expect(screen.getByText(/Unsupported format/i)).toBeInTheDocument();
    });
  });

  it("offers fitted timeline placement for a single loop with detected tempo", async () => {
    // 120 BPM click track: 25 ms decaying clicks every 0.5 s over 8 s.
    // The detector needs several usable onsets to report a steady pulse.
    const sr = 44100;
    const data = new Float32Array(sr * 8);
    for (let time = 0; time < 8; time += 0.5) {
      const start = Math.round(time * sr);
      for (let i = 0; i < Math.floor(sr * 0.025); i++) {
        data[start + i] = Math.sin((2 * Math.PI * 1000 * i) / sr) * Math.exp(-i / (sr * 0.004));
      }
    }
    const pulse = { duration: 8, sampleRate: sr, numberOfChannels: 1, getChannelData: () => data };
    const services = mockServices();
    Object.defineProperty(services.engine, "context", {
      value: { decodeAudioData: async () => pulse },
      configurable: true,
    });
    const { container } = renderWithContext(<DropZone onImport={vi.fn()} />, { services });
    dropFiles(container.querySelector(".drop-zone") as HTMLElement, [makeFile("loop.wav")]);
    await vi.waitFor(() => {
      expect(screen.getByText(/fitted clip/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Place on timeline"));
    const calls = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // ONE undoable command places a pitch-preserving fitted clip.
    const command = calls[calls.length - 1][0] as Command;
    const next = command.execute(services.store.getDoc());
    const clips = next.arrangement.audioClips ?? [];
    expect(clips).toHaveLength(1);
    expect(clips[0].stretchMode).toBe("stretch");
    expect(clips[0].stretchRate).toBeCloseTo(120 / next.bpm, 2);
    expect(Number.isInteger(clips[0].lengthBars)).toBe(true);
    const undone = command.undo(next);
    expect(undone.arrangement.audioClips ?? []).toHaveLength(0);
  });

  it("imports a valid audio file and calls onImport with an asset", async () => {
    const onImport = vi.fn();
    const { container } = renderWithContext(<DropZone onImport={onImport} />);
    const node = container.querySelector(".drop-zone") as HTMLElement;
    dropFiles(node, [makeFile("kick.wav")]);
    await vi.waitFor(() => {
      expect(onImport).toHaveBeenCalled();
    });
    const arg = onImport.mock.calls[0][0];
    expect(arg).toMatchObject({
      fileName: "kick.wav",
      name: "kick",
      category: "Custom",
    });
  });
});
