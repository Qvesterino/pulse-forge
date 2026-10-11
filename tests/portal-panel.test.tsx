import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { mockServices, renderWithContext } from "./helpers";
import type { PortalMeterFrame } from "../src/audio-worklets/portal-node";
import { PORTAL_BANDS } from "../src/audio-worklets/portal-node";
import { PortalPanel } from "../src/ui/PortalPanel";
import {
  PORTAL_AXIS_MAX_HZ,
  PORTAL_AXIS_MIN_HZ,
  PORTAL_BAND_COUNT,
  bandHz,
  formatAxisHz,
  hzToBand,
  hzToX,
} from "../src/ui/portalSpectrum";

/**
 * PORTAL panel — it must draw the PROCESSOR's spectrum, not a picture of its
 * settings.
 *
 * The failure this file exists for is not a crash. It is a panel that looks
 * alive while lying:
 *
 *   - a panel that re-derives a spectrum host-side from FOCUS / MIX / FEEDBACK
 *     shows a clean hump at FOCUS on a resonator that never rang, and a flat
 *     line on a delay quietly pouring out repeats;
 *   - a panel that accepts a half-valid frame draws a device quieter or
 *     brighter than the one actually running;
 *   - a panel that flattens `mix = 0` into a drawn line reports a silent
 *     device that is in fact passing audio through untouched.
 *
 * jsdom has no 2D context, so the strokes themselves cannot be asserted here.
 * What IS asserted is everything around them: which frame the panel accepts,
 * what it says when there is nothing true to say, and that its geometry comes
 * from the telemetry contract rather than from the parameters.
 */

/** A frame whose every band is 0 except one — a trace that cannot be faked. */
function singleBandFrame(band: number, value: number, extra: Partial<PortalMeterFrame> = {}): PortalMeterFrame {
  const bandsIn = new Uint8Array(PORTAL_BANDS);
  const bandsOut = new Uint8Array(PORTAL_BANDS);
  bandsIn[band] = value;
  bandsOut[band] = value;
  return {
    peak: 0.5,
    activity: 0.1,
    delaySec: 0.25,
    frames: 100,
    shiftSemitones: 0,
    bandsIn,
    bandsOut,
    ...extra,
  };
}

type PanelProps = Parameters<typeof PortalPanel>[0];

/** Mount the panel on a real services context whose meter API is stubbed. */
function mountPanel(frame: unknown, params: Record<string, number> = {}, degraded = false) {
  const meterCalls: boolean[] = [];
  // The stub must exist BEFORE render: the panel turns metering on in an effect
  // that runs on mount, so an engine patched afterwards is never seen. A test
  // that patched late would report "metering never enabled" for a panel that
  // enables it perfectly well.
  const services = mockServices();
  const engine = services.engine as unknown as {
    getFxMeters?: (trackId: string, fxId: string) => unknown;
    setFxMetersEnabled?: (trackId: string, fxId: string, enabled: boolean) => void;
  };
  engine.getFxMeters = () => frame;
  engine.setFxMetersEnabled = (_t: string, _f: string, enabled: boolean) => {
    meterCalls.push(enabled);
  };
  const utils = renderWithContext(<PortalPanel trackId={"t1"} fxId={"fx1"} params={params} degraded={degraded} />, {
    services,
  });
  return { ...utils, meterCalls };
}

/** The panel polls at 66 ms; give it two ticks before reading the DOM. */
const settle = () => waitFor(() => {}, { timeout: 10 }).then(() => new Promise((r) => setTimeout(r, 200)));

describe("PORTAL panel", () => {
  it("releases metering on unmount, so a closed panel costs no audio-thread work", async () => {
    const { unmount, meterCalls } = mountPanel(null, { mode: 0, mix: 0.5 });
    await settle();
    expect(meterCalls, "metering must be turned on while the panel is open").toContain(true);
    unmount();
    expect(meterCalls[meterCalls.length - 1], "metering must be turned off on unmount").toBe(false);
  });

  it("says BYPASSED at mix = 0 instead of drawing a silent device", async () => {
    mountPanel(null, { mode: 0, mix: 0 });
    // mix = 0 short-circuits the STFT by design, so no frame can ever arrive.
    await settle();
    expect(screen.getByText(/BYPASSED/i)).toBeTruthy();
  });

  it("says FALLBACK when the module never loaded", async () => {
    mountPanel(null, { mode: 0, mix: 0.5 }, true);
    await settle();
    expect(screen.getByText(/FALLBACK/i)).toBeTruthy();
  });

  it("says waiting when telemetry is enabled but no frame has landed", async () => {
    mountPanel(null, { mode: 0, mix: 0.5 });
    await settle();
    expect(screen.getByText(/waiting for telemetry/i)).toBeTruthy();
  });

  it("refuses a half-valid frame rather than half-drawing it", async () => {
    // bandsOut missing would leave the input line drawn and the effect
    // invisible — the exact half-truth this panel must not tell.
    mountPanel(
      { peak: 0.5, activity: 0.1, delaySec: 0.25, frames: 10, bandsIn: new Uint8Array(PORTAL_BANDS) },
      {
        mode: 0,
        mix: 0.5,
      },
    );
    await settle();
    expect(screen.getByText(/waiting for telemetry/i)).toBeTruthy();
  });

  it("refuses a wrong-length trace instead of reading past the end", async () => {
    const short = singleBandFrame(20, 200);
    mountPanel({ ...short, bandsOut: new Uint8Array(PORTAL_BANDS - 1) }, { mode: 0, mix: 0.5 });
    await settle();
    expect(screen.getByText(/waiting for telemetry/i)).toBeTruthy();
  });

  it("names the live MODE once a real frame arrives", async () => {
    mountPanel(singleBandFrame(30, 200), { mode: 1, mix: 0.5 });
    await settle();
    expect(screen.getByText(/RESONATOR/)).toBeTruthy();
    expect(screen.queryByText(/waiting for telemetry/i)).toBeNull();
  });

  it("reports the delay length from the telemetry, not from the TIME param", async () => {
    // TIME is 2000 ms in the rack here; the processor reported 0.25 s. A panel
    // that formatted the param would print "2.000 s" and disagree with the
    // audio it is describing.
    mountPanel(singleBandFrame(30, 200, { delaySec: 0.25 }), { mode: 0, time: 2000, mix: 0.5 });
    await settle();
    expect(screen.getByText("0.250 s")).toBeTruthy();
  });

  it("labels both traces with which is which", () => {
    mountPanel(singleBandFrame(30, 200), { mode: 0, mix: 0.5 });
    expect(screen.getByText(/IN — analysed/)).toBeTruthy();
    expect(screen.getByText(/OUT — after the mode/)).toBeTruthy();
  });
});

describe("PORTAL band geometry is one contract, not two implementations", () => {
  it("uses the processor's band count", () => {
    expect(PORTAL_BAND_COUNT).toBe(PORTAL_BANDS);
  });

  it("round-trips a frequency through the band it lands in", () => {
    for (const hz of [20, 55, 220, 440, 900, 1000, 4000, 16000, 24000]) {
      const band = Math.round(hzToBand(hz));
      const centre = bandHz(band);
      const ratio = centre / hz;
      // One band is a fixed log width, so a frequency may sit at most half a
      // band from its centre; 0.85..1.18 is that width with margin.
      expect(ratio, `${hz} Hz must land in a band that contains it`).toBeGreaterThan(0.85);
      expect(ratio, `${hz} Hz must land in a band that contains it`).toBeLessThan(1.18);
    }
  });

  it("clamps outside the displayed range instead of throwing", () => {
    expect(hzToX(1, 100)).toBe(0);
    expect(hzToX(1_000_000, 100)).toBe(100);
    expect(bandHz(-5)).toBeGreaterThanOrEqual(PORTAL_AXIS_MIN_HZ * 0.9);
    expect(bandHz(9999)).toBeLessThanOrEqual(PORTAL_AXIS_MAX_HZ * 1.05);
  });

  it("formats axis labels compactly", () => {
    expect(formatAxisHz(440)).toBe("440");
    expect(formatAxisHz(1000)).toBe("1.0k");
    expect(formatAxisHz(20000)).toBe("20k");
  });
});

// The props type is exported for the mount helper above; referencing it keeps
// the helper honest if the panel's prop contract changes.
export type { PanelProps };
