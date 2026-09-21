/**
 * SpectralEditPanel — RX-style spectral editing for one audio clip.
 *
 * The component mixes:
 *  - two canvases (static spectrogram + drag overlay)
 *  - selection / gain / feather controls
 *  - APPLY which renders a new buffer, adds it to the bank, and rewires the
 *    clip's bufferId through an undoable command.
 *
 * Most of the audio math lives in `audio-engine/spectralEdit` and is tested
 * separately. Here we focus on UI behavior:
 *  - the panel renders and shows mono/stereo + duration
 *  - close button + backdrop click both call `onClose`
 *  - gain slider updates the readout (+/- sign)
 *  - feather select updates the value
 *  - drag on the overlay creates / clears a selection
 *  - APPLY without an audio context sets a status message and does not call
 *    `store.execute` (the cheap guard against apply-before-play)
 *  - ERASE NOISE does not throw when the spectrogram frames are not ready
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpectralEditPanel } from "../../src/ui/SpectralEditPanel";
import { mockServices, renderWithContext } from "../helpers";
import type { AudioClip } from "../../src/project-model/types";

function makeAudioBuffer(sampleRate = 44100, durationSec = 0.5): AudioBuffer {
  const length = Math.floor(sampleRate * durationSec);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  return {
    sampleRate,
    numberOfChannels: 1,
    length,
    duration: durationSec,
    getChannelData: () => data,
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
}

function makeClip(): AudioClip {
  return {
    id: "clip-1",
    trackId: "track-1",
    bufferId: "buf-original",
    startBar: 0,
    lengthBars: 1,
    offsetSec: 0,
    trimStart: 0,
    trimEnd: 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    stretchRate: 1,
    reverse: false,
  };
}

describe("SpectralEditPanel", () => {
  it("renders the panel with the duration in the header", () => {
    renderWithContext(<SpectralEditPanel clip={makeClip()} buffer={makeAudioBuffer()} onClose={() => {}} />);
    expect(screen.getByTestId("spectral-edit-panel")).toBeInTheDocument();
    expect(screen.getByText(/SPECTRAL EDIT/)).toBeInTheDocument();
    // 0.50s duration, MONO (1 channel)
    expect(screen.getByText(/0\.50s/)).toBeInTheDocument();
    expect(screen.getByText(/MONO/)).toBeInTheDocument();
  });

  it("renders STEREO when the buffer has 2 channels", () => {
    const buf = {
      ...makeAudioBuffer(),
      numberOfChannels: 2,
      getChannelData: (() => {
        const data = new Float32Array(22050);
        for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
        return () => data;
      })(),
    } as unknown as AudioBuffer;
    renderWithContext(<SpectralEditPanel clip={makeClip()} buffer={buf} onClose={() => {}} />);
    expect(screen.getByText(/STEREO/)).toBeInTheDocument();
  });

  it("calls onClose when the X button is clicked", async () => {
    const onClose = vi.fn();
    renderWithContext(<SpectralEditPanel clip={makeClip()} buffer={makeAudioBuffer()} onClose={onClose} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "✕" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the CLOSE button is clicked", async () => {
    const onClose = vi.fn();
    renderWithContext(<SpectralEditPanel clip={makeClip()} buffer={makeAudioBuffer()} onClose={onClose} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "CLOSE" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the backdrop is clicked (target === currentTarget)", () => {
    const onClose = vi.fn();
    renderWithContext(<SpectralEditPanel clip={makeClip()} buffer={makeAudioBuffer()} onClose={onClose} />);
    // Mouse down directly on the backdrop (the outermost div).
    const panel = screen.getByTestId("spectral-edit-panel");
    fireEvent.mouseDown(panel, { bubbles: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when a click starts inside the inner card", () => {
    const onClose = vi.fn();
    renderWithContext(<SpectralEditPanel clip={makeClip()} buffer={makeAudioBuffer()} onClose={onClose} />);
    // The header text is inside the inner card; mousedown on it must NOT
    // bubble out as a backdrop dismiss.
    fireEvent.mouseDown(screen.getByText(/SPECTRAL EDIT/), { bubbles: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("updates the gain readout with explicit + sign for positive dB", () => {
    // Native HTML range inputs need a direct change event with the target
    // value — userEvent.type/keyboard cannot synthesise a range change in
    // jsdom because there is no real focus + arrow-key handling.
    renderWithContext(<SpectralEditPanel clip={makeClip()} buffer={makeAudioBuffer()} onClose={() => {}} />);
    const slider = screen.getByRole("slider", { name: /GAIN/ }) as HTMLInputElement;
    expect(slider.value).toBe("-24");
    fireEvent.change(slider, { target: { value: "12" } });
    // "12 dB" → the readout formats positive values with explicit `+`.
    expect(screen.getByText("+12 dB")).toBeInTheDocument();
  });

  it("renders the feather select with the four preset millisecond values", () => {
    renderWithContext(<SpectralEditPanel clip={makeClip()} buffer={makeAudioBuffer()} onClose={() => {}} />);
    expect(screen.getByRole("option", { name: "10 ms" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "30 ms" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "60 ms" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "120 ms" })).toBeInTheDocument();
  });

  it("APPLY without an audio context sets a status and does not call store.execute", async () => {
    // The default mock has `getLiveAudioContext: () => null` (added in
    // tests/helpers) — apply short-circuits before the store mutation.
    const services = mockServices();
    renderWithContext(
      <SpectralEditPanel clip={makeClip()} buffer={makeAudioBuffer()} onClose={() => {}} />,
      { services },
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "APPLY" }));
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(screen.getByText(/Audio engine not running/)).toBeInTheDocument();
  });

  it("drag with tiny movement (<4px) clears the selection and sets status", () => {
    renderWithContext(<SpectralEditPanel clip={makeClip()} buffer={makeAudioBuffer()} onClose={() => {}} />);
    const overlay = screen.getByTestId("spectral-edit-overlay");
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 101, clientY: 51, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 101, clientY: 51, pointerId: 1 });
    expect(screen.getByText(/Selection cleared/)).toBeInTheDocument();
  });

  it("drag with substantial movement keeps the selection and sets the 'pick GAIN' status", () => {
    renderWithContext(<SpectralEditPanel clip={makeClip()} buffer={makeAudioBuffer()} onClose={() => {}} />);
    const overlay = screen.getByTestId("spectral-edit-overlay");
    fireEvent.pointerDown(overlay, { clientX: 50, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 250, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 250, clientY: 180, pointerId: 1 });
    expect(screen.getByText(/Pick GAIN, preview, then APPLY/)).toBeInTheDocument();
  });

  it("ERASE NOISE does not throw when the spectrogram frames are not ready", async () => {
    // framesRef is only populated after the static-spectrogram effect runs.
    // The button click is sync — racing with the effect would otherwise
    // crash on the unguarded `frames[0]`. Pin the defensive message.
    renderWithContext(<SpectralEditPanel clip={makeClip()} buffer={makeAudioBuffer()} onClose={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /ERASE NOISE/ }));
    // Either "still computing" or "no persistent noise" is acceptable; both
    // are the safe paths.
    const status = screen.getByText(/Spectrogram still computing|No persistent noise/);
    expect(status).toBeInTheDocument();
  });

  it("PLAY ORIG does not throw and does not require a selection", async () => {
    // Playing the original buffer is always available; it must not depend
    // on a selection. The mock engine's getLiveAudioContext returns null,
    // which makes playBuffer set the status — we just want to confirm the
    // button is wired and the click is handled without throwing.
    renderWithContext(<SpectralEditPanel clip={makeClip()} buffer={makeAudioBuffer()} onClose={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "PLAY ORIG" }));
    expect(screen.getByText(/Audio engine not running|APPLY renders/)).toBeInTheDocument();
  });
});