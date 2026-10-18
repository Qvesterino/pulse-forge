import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import {
  decayPeaks,
  PEAK_DECAY,
  peakOf,
  resetPadChannelState,
  setPadPeak,
  setPinnedRates,
  setSixteenLevels,
  subscribePeaks,
  subscribePinnedRates,
  subscribeSixteenLevels,
  usePadPeak,
} from "../../src/ui/padChannelState";

/**
 * Shared pad-channel state — the single owner of what the rack header writes and
 * the sequencer row labels read.
 *
 * Two contracts are load-bearing and neither is visible from the UI:
 *
 *  1. SUBSCRIBE. The rack header and the rows are separate components, so a
 *     write in one is only usable if it notifies the other. A plain getter would
 *     leave the second surface rendering a stale value forever — which is
 *     exactly the "two lists that disagree" bug this module exists to remove.
 *  2. DECAY. The peak meter falls 0.88 per frame and drops below 0.02. The rack
 *     already did this with local state; the contract now is that the value is
 *     visible to a row BEFORE it is dropped, and that a decayed-out pad stops
 *     notifying entirely (otherwise a 60 fps re-render loop runs forever).
 */

function Meter({ padId }: { padId: string }) {
  return <span data-testid={`meter-${padId}`}>{usePadPeak(padId)}</span>;
}

describe("padChannelState · peaks", () => {
  it("notifies subscribers on a write so another surface can re-render", () => {
    resetPadChannelState();
    const listener = vi.fn();
    const unsubscribe = subscribePeaks(listener);

    act(() => setPadPeak("pad-a", 0.8));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(peakOf("pad-a")).toBe(0.8);
    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    resetPadChannelState();
    const listener = vi.fn();
    subscribePeaks(listener)();

    act(() => setPadPeak("pad-b", 0.5));

    expect(listener).not.toHaveBeenCalled();
  });

  it("decays by PEAK_DECAY per frame while a row can still read the value", () => {
    resetPadChannelState();
    act(() => setPadPeak("pad-c", 1));
    expect(decayPeaks()).toBe(true);
    expect(peakOf("pad-c")).toBeCloseTo(PEAK_DECAY, 6);
  });

  it("drops a pad under the floor and stops re-rendering once nothing is live", () => {
    resetPadChannelState();
    act(() => setPadPeak("pad-d", 0.03));
    // Live while the reading is above the floor: a row must be able to read the
    // value the frame BEFORE it disappears, not have it vanish under it.
    // 0.03 * 0.88^n stays above 0.02 for n = 1..3 and drops on the fourth frame.
    for (const expected of [0.03 * 0.88, 0.03 * 0.88 ** 2, 0.03 * 0.88 ** 3]) {
      expect(decayPeaks()).toBe(true);
      expect(peakOf("pad-d")).toBeCloseTo(expected, 6);
    }
    // The frame that takes it under the floor still notifies (the meter must go
    // dark) and only then does the record empty.
    expect(decayPeaks()).toBe(true);
    expect(peakOf("pad-d")).toBe(0);
    // Nothing live: no notify at all, so the meter cannot spin at 60 fps.
    expect(decayPeaks()).toBe(false);
  });

  it("re-renders only the row whose own peak moved", () => {
    resetPadChannelState();
    render(
      <>
        <Meter padId="pad-x" />
        <Meter padId="pad-y" />
      </>,
    );
    act(() => setPadPeak("pad-x", 0.9));
    expect(screen.getByTestId("meter-pad-x")).toHaveTextContent("0.9");
    expect(screen.getByTestId("meter-pad-y")).toHaveTextContent("0");
  });
});

describe("padChannelState · channel settings", () => {
  it("notifies on 16 LEVELS and on a pinned rate so header and rows agree", () => {
    resetPadChannelState();
    const levelsListener = vi.fn();
    const rateListener = vi.fn();
    const stopLevels = subscribeSixteenLevels(levelsListener);
    const stopRates = subscribePinnedRates(rateListener);

    act(() => setSixteenLevels(true));
    act(() => setPinnedRates((prev) => ({ ...prev, "pad-e": "1/16" })));

    expect(levelsListener).toHaveBeenCalledTimes(1);
    expect(rateListener).toHaveBeenCalledTimes(1);

    // Unchanged writes are silent — the row meter and the header must not
    // re-render 60 times a second for a value that did not move.
    act(() => setSixteenLevels(true));
    expect(levelsListener).toHaveBeenCalledTimes(1);

    stopLevels();
    stopRates();
    resetPadChannelState();
  });
});
