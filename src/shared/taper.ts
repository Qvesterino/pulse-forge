/**
 * Slider taper math (pure — unit-tested).
 *
 * Linear is identity; log maps the 0..1 drag ratio onto min..max
 * geometrically (midpoint = geometric mean), so a 20 Hz–20 kHz knob puts
 * 632 Hz in the middle instead of 10 kHz. Log requires min > 0 and max > min,
 * otherwise it falls back to linear.
 *
 * This lives in `src/shared/` and NOT in `src/ui/controls.tsx` because the
 * DOM-free domain modules need it too: the TSAR ORBIT surface maps a 2-D pad
 * position onto a parameter's range, and a Hz-domain parameter (cutoff, Q)
 * must spend its travel musically there as well. Importing it from the UI
 * module would drag React into a pure module.
 *
 * `src/ui/controls.tsx` re-exports both names, so every existing import site
 * keeps working unchanged.
 */
export type SliderTaper = "linear" | "log";

export function taperToRatio(min: number, max: number, value: number, taper: SliderTaper = "linear"): number {
  if (taper !== "log" || !(min > 0) || !(max > min)) {
    return (value - min) / (max - min);
  }
  return Math.log(value / min) / Math.log(max / min);
}

export function ratioToTaper(min: number, max: number, ratio: number, taper: SliderTaper = "linear"): number {
  const r = Math.min(1, Math.max(0, ratio));
  if (taper !== "log" || !(min > 0) || !(max > min)) {
    return min + r * (max - min);
  }
  return min * Math.pow(max / min, r);
}
