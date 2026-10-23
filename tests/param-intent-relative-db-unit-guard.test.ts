import { describe, expect, it } from "vitest";
import { parseParamIntent, paramMovePreview } from "../src/intent/param-intent";

/**
 * A RELATIVE dB ask belongs only on a dB knob.
 *
 * The absolute path already declined a dB ask on a unitless knob
 * (toParamUnit returns NaN). The relative path did not: it treated the dB
 * NUMBER as a percentage of the knob's range, so "by 2 db more saturation
 * mix" became a 100 %-of-range jump - mix 0.40 -> 1.00, i.e. the whole
 * effect at 100 % wet, from a two-decibel request.
 *
 * The fix declines the ask instead (the generic layer then owns it), which
 * is the same contract the absolute path already had.
 */

describe("a relative dB ask belongs only on a dB knob", () => {
  it("does not scale a unitless knob by the dB number", () => {
    // saturation.mix is 0..1 with NO dB unit - a dB ask has no meaning here.
    // Before the guard this parsed into a 100 %-of-range move: mix 0.40 -> 1.00.
    const intent = parseParamIntent("by 2 db more saturation mix on the 808");
    expect(intent).toBeNull();
  });

  it("keeps the relative dB move on a dB knob", () => {
    const intent = parseParamIntent("lower the compressor threshold by 2 db on the drums");
    expect(intent).not.toBeNull();
    expect(intent!.mode).toBe("less");
    expect(intent!.percent).toBeCloseTo((2 / 60) * 100, 6);
    // threshold is -60..0 dB: 2 dB below -18 is -20.
    expect(paramMovePreview(intent!, -18)!.next).toBeCloseTo(-20, 6);
  });

  it("keeps the relative PERCENT move on a unitless knob", () => {
    const intent = parseParamIntent("by 10 % more saturation mix on the 808");
    expect(intent).not.toBeNull();
    expect(intent!.mode).toBe("more");
    expect(intent!.percent).toBe(10);
    expect(paramMovePreview(intent!, 0.4)!.next).toBeCloseTo(0.5, 6);
  });
});
