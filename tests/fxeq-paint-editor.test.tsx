/**
 * PRISM paint-editor regressions: the crossover split drag (live preview +
 * single doc commit + neighbour clamping), the EQ response overlay math,
 * and per-instance band selection persistence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { EffectRack } from "../src/ui/EffectRack";
import { renderWithContext, mockServices } from "./helpers";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  bandEqMagnitudeDb,
  biquadMagnitudeDb,
  type BandEqCurveParams,
} from "../src/ui/fxeqCurve";

// ── canvas geometry shared by the drag tests ─────────────────────────────
// The panel maps 20 Hz … 20 kHz logarithmically across the canvas width.
const RECT = { left: 0, top: 0, width: 1000, height: 100, x: 0, y: 0, right: 1000, bottom: 100 };
const LOG_SPAN = Math.log(20000 / 20);
const xOf = (freqHz: number): number => (Math.log(freqHz / 20) / LOG_SPAN) * RECT.width;
const freqOf = (clientX: number): number => 20 * Math.exp((clientX / RECT.width) * LOG_SPAN);

function fxEqDoc() {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((t) => t.kind === "instrument")!;
  track.effects = [
    {
      id: "fx-eq",
      type: "fxeq" as const,
      bypassed: false,
      params: { bandCount: 4, crossoverFreq2: 400, crossoverFreq3: 1200, crossoverFreq4: 4000 },
    },
  ];
  return { doc, track };
}

function mountedPanel(servicesOverride?: Partial<Services>) {
  const { doc, track } = fxEqDoc();
  const base = mockServices(doc);
  const services = {
    ...base,
    ...servicesOverride,
    engine: { ...base.engine, ...(servicesOverride?.engine ?? {}) },
    store: { ...base.store, ...(servicesOverride?.store ?? {}) },
  } as typeof base;
  const utils = renderWithContext(<EffectRack track={track} />, { services });
  return { services, doc, track, ...utils };
}

type Services = ReturnType<typeof mockServices>;

beforeEach(() => {
  window.localStorage.clear();
});

describe("fxeq panel — EQ response overlay math", () => {
  const EQ: BandEqCurveParams = {
    enabled: 1,
    lowFreq: 120,
    lowGainDb: 12,
    peak1Freq: 800,
    peak1GainDb: 6,
    peak1Q: 0.7,
    peak2Freq: 3500,
    peak2GainDb: 0,
    peak2Q: 0.7,
    highFreq: 8000,
    highGainDb: 9,
    };
  const SR = 48000;

  it("a flat (identity) biquad section measures 0 dB", () => {
    const flat = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    expect(biquadMagnitudeDb(flat, 100, SR)).toBeCloseTo(0, 9);
    expect(biquadMagnitudeDb(flat, 1370, SR)).toBeCloseTo(0, 9);
  });

  it("the low shelf reaches its gain well below its corner and fades above", () => {
    const lowOnly: BandEqCurveParams = { ...EQ, peak1GainDb: 0, highGainDb: 0 };
    expect(bandEqMagnitudeDb(lowOnly, 40, SR)).toBeGreaterThan(11.4);
    expect(bandEqMagnitudeDb(lowOnly, 4000, SR)).toBeLessThan(0.5);
  });

  it("the high shelf reaches its gain well above its corner", () => {
    const highOnly: BandEqCurveParams = { ...EQ, lowGainDb: 0, peak1GainDb: 0 };
    expect(bandEqMagnitudeDb(highOnly, 15000, SR)).toBeGreaterThan(8.4);
    expect(bandEqMagnitudeDb(highOnly, 500, SR)).toBeLessThan(0.5);
  });

  it("a peaking section peaks at its center frequency", () => {
    const peakOnly: BandEqCurveParams = { ...EQ, lowGainDb: 0, highGainDb: 0, peak2GainDb: 0 };
    expect(bandEqMagnitudeDb(peakOnly, 800, SR)).toBeCloseTo(6, 1);
  });

  it("sections sum: low + high corners both show their boost", () => {
    expect(bandEqMagnitudeDb(EQ, 40, SR)).toBeGreaterThan(11);
    expect(bandEqMagnitudeDb(EQ, 15000, SR)).toBeGreaterThan(8);
  });

  it("a disabled EQ is flat — matching the DSP's true no-op", () => {
    expect(bandEqMagnitudeDb({ ...EQ, enabled: 0 }, 40, SR)).toBe(0);
    expect(bandEqMagnitudeDb({ ...EQ, enabled: 0 }, 8000, SR)).toBe(0);
  });
});

describe("fxeq panel — crossover split drag", () => {
  it("drags a split: live preview during the move, ONE document commit on release", async () => {
    const previewFxParam = vi.fn();
    const { services } = mountedPanel({
      engine: { previewFxParam } as never,
    });
    const map = await screen.findByRole("img", { name: "PRISM band map" }, { timeout: 10_000 });
    const rectSpy = vi.spyOn(map, "getBoundingClientRect").mockReturnValue(RECT as DOMRect);

    // Grab the first split (default 400 Hz) and drag it right.
    fireEvent.pointerDown(map, { clientX: xOf(400), pointerId: 1 });
    fireEvent.pointerMove(map, { clientX: xOf(700), pointerId: 1 });
    fireEvent.pointerMove(map, { clientX: xOf(900), pointerId: 1 });
    // Live previews carry the param id and a value on every move.
    expect(previewFxParam).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "crossoverFreq2",
      expect.anything(),
    );
    expect(previewFxParam.mock.calls.length).toBeGreaterThanOrEqual(2);

    // No document write until release.
    const executeBefore = vi.mocked(services.store.execute).mock.calls.length;
    fireEvent.pointerUp(map, { clientX: xOf(900), pointerId: 1 });
    expect(vi.mocked(services.store.execute).mock.calls.length).toBe(executeBefore + 1);
    rectSpy.mockRestore();
  });

  it("commits the dragged value clamped against the schema range", async () => {
    const { services } = mountedPanel();
    const map = await screen.findByRole("img", { name: "PRISM band map" }, { timeout: 10_000 });
    vi.spyOn(map, "getBoundingClientRect").mockReturnValue(RECT as DOMRect);

    // Drag split 2 (400 Hz) far right, past split 3 (1200 Hz): the schema
    // max for crossoverFreq2 (800 Hz) must win over the pointer position.
    fireEvent.pointerDown(map, { clientX: xOf(400), pointerId: 1 });
    fireEvent.pointerMove(map, { clientX: RECT.width - 5, pointerId: 1 }); // ≈19 kHz
    fireEvent.pointerUp(map, { clientX: RECT.width - 5, pointerId: 1 });

    const calls = vi.mocked(services.store.execute).mock.calls;
    const command = calls[calls.length - 1]?.[0] as {
      execute: (doc: ReturnType<typeof fxEqDoc>["doc"]) => ReturnType<typeof fxEqDoc>["doc"];
    };
    expect(command).toBeTruthy();
    // Commands are immutable: execute returns the NEXT document.
    const next = command.execute(fxEqDoc().doc);
    const fx = next.tracks
      .find((t) => t.kind === "instrument")!
      .effects.find((f) => f.id === "fx-eq");
    expect(fx?.params.crossoverFreq2).toBe(800);
  });

  it("a click (no handle grab) still selects the band under the pointer", async () => {
    mountedPanel();
    const map = await screen.findByRole("img", { name: "PRISM band map" }, { timeout: 10_000 });
    vi.spyOn(map, "getBoundingClientRect").mockReturnValue(RECT as DOMRect);
    // 1000 Hz lives in band 2 (split 400…1200).
    fireEvent.click(map, { clientX: xOf(1000) });
    expect(screen.getByRole("button", { name: "B2" })).toHaveAttribute("aria-pressed", "true");
  });

  it("a handle grab without movement does not change the band selection", async () => {
    mountedPanel();
    const map = await screen.findByRole("img", { name: "PRISM band map" }, { timeout: 10_000 });
    vi.spyOn(map, "getBoundingClientRect").mockReturnValue(RECT as DOMRect);
    fireEvent.pointerDown(map, { clientX: xOf(400), pointerId: 1 });
    fireEvent.pointerUp(map, { clientX: xOf(400), pointerId: 1 });
    expect(screen.getByRole("button", { name: "B1" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("fxeq panel — band selection persistence", () => {
  it("remembers the selected band per instance across remounts", async () => {
    const first = mountedPanel();
    const b2 = await screen.findByRole("button", { name: "B2" }, { timeout: 10_000 });
    fireEvent.click(b2);
    expect(screen.getByRole("button", { name: "B2" })).toHaveAttribute("aria-pressed", "true");
    first.unmount();

    // Fresh mount (same fxId) restores the selection.
    mountedPanel();
    const map2 = await screen.findByRole("img", { name: "PRISM band map" }, { timeout: 10_000 });
    void map2;
    expect(screen.getByRole("button", { name: "B2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "B1" })).toHaveAttribute("aria-pressed", "false");
  });
});
