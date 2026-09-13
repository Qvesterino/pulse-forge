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
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";
import {
  bandEqMagnitudeDb,
  biquadMagnitudeDb,
  crossoverBandMagnitudeDb,
  type BandEqCurveParams,
} from "../src/ui/fxeqCurve";

// ── canvas geometry shared by the drag tests ─────────────────────────────
// The panel maps 20 Hz … 20 kHz logarithmically across the canvas width.
const RECT = { left: 0, top: 0, width: 1000, height: 100, x: 0, y: 0, right: 1000, bottom: 100 };
const LOG_SPAN = Math.log(20000 / 20);
const BLOCK = 128;
const xOf = (freqHz: number): number => (Math.log(freqHz / 20) / LOG_SPAN) * RECT.width;

function fxEqDoc(paramsOverride: Record<string, number> = {}) {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((t) => t.kind === "instrument")!;
  track.effects = [
    {
      id: "fx-eq",
      type: "fxeq" as const,
      bypassed: false,
      params: {
        bandCount: 4,
        crossoverFreq2: 400,
        crossoverFreq3: 1200,
        crossoverFreq4: 4000,
        "band1.delayEnabled": 1,
        "band1.modEnabled": 1,
        ...paramsOverride,
      },
    },
  ];
  return { doc, track };
}

function mountedPanel(servicesOverride?: Partial<Services>, paramsOverride?: Record<string, number>) {
  const { doc, track } = fxEqDoc(paramsOverride);
  const base = mockServices(doc);
  const services = {
    ...base,
    ...servicesOverride,
    engine: { ...base.engine, ...(servicesOverride?.engine ?? {}) },
    store: { ...base.store, ...(servicesOverride?.store ?? {}) },
  } as typeof base;
  const utils = renderWithContext(<EffectRack track={track} />, { services });
  // utils already carries `services` (renderWithContext returns it).
  return { doc, track, ...utils };
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

  it("draws the selected band's LR crossover window around its own split", () => {
    const splits = [1000];
    expect(crossoverBandMagnitudeDb(0, splits, 4, 100, SR)).toBeCloseTo(0, 2);
    expect(crossoverBandMagnitudeDb(0, splits, 4, 1000, SR)).toBeCloseTo(-6.02, 2);
    expect(crossoverBandMagnitudeDb(1, splits, 4, 1000, SR)).toBeCloseTo(-6.02, 2);
    expect(crossoverBandMagnitudeDb(1, splits, 4, 10000, SR)).toBeCloseTo(0, 2);
  });

  it("stopband steepness follows the slope: LR8 falls ~2x LR4 per octave", () => {
    const splits = [1200];
    // 4800 Hz is 2 octaves above the split: LR4 ≈ −6 − 48 ≈ −54 dB,
    // LR8 ≈ −6 − 96 ≈ −102 dB (biquadMagnitudeDb floors at −180).
    const lr4 = crossoverBandMagnitudeDb(0, splits, 4, 4800, SR);
    const lr8 = crossoverBandMagnitudeDb(0, splits, 8, 4800, SR);
    expect(lr4).toBeLessThan(-45);
    expect(lr8).toBeLessThan(lr4 - 30);
  });

  it("the LR2 skirt runs at 12 dB per octave (with the polarity flip intact)", () => {
    const splits = [1200];
    // Magnitude ignores the LR2 HP polarity flip — the flip only restores
    // the flat SUM, the skirt shape stays a 12 dB/oct lowpass.
    expect(crossoverBandMagnitudeDb(0, splits, 2, 1200, SR)).toBeCloseTo(-6.02, 2);
    // 4800 Hz = 2 octaves above: ≈ −6 − 24 ≈ −30 dB.
    const deep = crossoverBandMagnitudeDb(0, splits, 2, 4800, SR);
    expect(deep).toBeLessThan(-24);
    expect(deep).toBeGreaterThan(-40);
  });

  it("window prediction matches the DSP's soloed band output", () => {
    // Solo the low band of a 2-band LR4 split and feed a 4 kHz tone: the
    // measured band gain must land on the curve's prediction.
    const predicted = crossoverBandMagnitudeDb(0, [800], 4, 4000, SR);
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({
      bandCount: 2,
      crossoverFreq2: 800,
      limiterEnabled: 0,
      globalMix: 100,
      "band1.solo": 1,
    });
    let acc = 0;
    let count = 0;
    for (let i = 0; i < 48; i++) {
      const ch = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let s = 0; s < BLOCK; s++) {
        ch[0][s] = 0.5 * Math.sin((2 * Math.PI * 4000 * (i * BLOCK + s)) / SR);
        ch[1][s] = ch[0][s];
      }
      proc.process(ch, BLOCK);
      if (i >= 16) {
        let sum = 0;
        for (let s = 0; s < BLOCK; s++) sum += ch[0][s] * ch[0][s];
        acc += sum / BLOCK;
        count++;
      }
    }
    const measuredDb = 20 * Math.log10(Math.sqrt(acc / count) / (0.5 / Math.SQRT2));
    expect(Math.abs(measuredDb - predicted)).toBeLessThan(2);
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
    const { services, doc } = mountedPanel();
    const map = await screen.findByRole("img", { name: "PRISM band map" }, { timeout: 10_000 });
    vi.spyOn(map, "getBoundingClientRect").mockReturnValue(RECT as DOMRect);

    // Drag split 2 (400 Hz) far right, past split 3 (1200 Hz): the schema
    // max for crossoverFreq2 (800 Hz) must win over the pointer position.
    fireEvent.pointerDown(map, { clientX: xOf(400), pointerId: 1 });
    fireEvent.pointerMove(map, { clientX: RECT.width - 5, pointerId: 1 }); // ~19 kHz
    fireEvent.pointerUp(map, { clientX: RECT.width - 5, pointerId: 1 });

    const calls = vi.mocked(services.store.execute).mock.calls;
    const command = calls
      .map((c) => c[0] as { label?: string; execute: (d: unknown) => unknown })
      .find((c) => c.label === "PRISM crossoverFreq2");
    expect(command, "drag commit command missing").toBeTruthy();
    // Commands are immutable AND bound to the doc they were built against
    // (track ids are per-template-instance): execute returns the NEXT doc.
    const next = command!.execute(doc) as ReturnType<typeof fxEqDoc>["doc"];
    const fx = next.tracks.find((t) => t.kind === "instrument")!.effects.find((f) => f.id === "fx-eq");
    expect(fx?.params.crossoverFreq2).toBe(800);
  });

  it("uses the processor's effective monotonic splits for hit testing", async () => {
    const { services } = mountedPanel(undefined, {
      crossoverFreq2: 700,
      crossoverFreq3: 300,
      crossoverFreq4: 4000,
    });
    const map = await screen.findByRole("img", { name: "PRISM band map" }, { timeout: 10_000 });
    vi.spyOn(map, "getBoundingClientRect").mockReturnValue(RECT as DOMRect);

    // The raw second split is 300 Hz, but the DSP's monotonic forward pass
    // makes it 740 Hz (700 + the 40 Hz minimum gap). The UI must grab the
    // effective line, not the stale raw document coordinate.
    fireEvent.pointerDown(map, { clientX: xOf(740), pointerId: 1 });
    fireEvent.pointerMove(map, { clientX: xOf(740), pointerId: 1 });
    fireEvent.pointerUp(map, { clientX: xOf(740), pointerId: 1 });

    const command = vi
      .mocked(services.store.execute)
      .mock.calls.map((call) => call[0] as { label?: string })
      .find((candidate) => candidate.label === "PRISM crossoverFreq3");
    expect(command).toBeDefined();
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

describe("fxeq panel — tempo-sync controls", () => {
  it("renders DLY and MOD tempo sync as musical division selects", async () => {
    const { services } = mountedPanel();
    await screen.findByRole("img", { name: "PRISM band map" }, { timeout: 10_000 });
    const syncs = screen.getAllByRole("combobox", { name: "Tempo Sync" });
    expect(syncs).toHaveLength(2);
    for (const select of syncs) {
      expect(Array.from((select as HTMLSelectElement).options).map((option) => option.text)).toEqual([
        "Free",
        "1/1",
        "1/2",
        "1/4",
        "1/8",
        "1/16",
        "1/8T",
        "1/8.",
        "1/4T",
      ]);
    }

    // MODULE_ORDER renders MOD before DLY; the second control is the DLY
    // sync enum whose command label is asserted below.
    fireEvent.change(syncs[1], { target: { value: "4" } });
    const command = vi
      .mocked(services.store.execute)
      .mock.calls.map((call) => call[0] as { label?: string })
      .find((candidate) => candidate.label === "PRISM band1.delaySyncMode");
    expect(command).toBeDefined();
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
