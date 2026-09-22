/**
 * Sequencer ruler math (Audit 02 — transport) — pure, unit-tested.
 *
 * The ruler element is `position: sticky` VERTICALLY only, so horizontally
 * it scrolls WITH the grid content: `clientX - rulerRect.left` is already a
 * content coordinate. Adding `scroller.scrollLeft` here double-counted the
 * scroll — with a 64-step pattern scrolled to step 40, a click on the
 * visible step-41 tick sought to ~step 80 (clamped to the last step) and
 * loop drags painted a region offset by the same amount.
 */
export function rulerStepFromX(
  clientX: number,
  rulerRectLeft: number,
  stridePx: number,
  labelGapPx: number,
  stepCount: number,
): number | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(stridePx) || stridePx <= 0 || stepCount <= 0) return null;
  const contentX = clientX - rulerRectLeft;
  const step = Math.floor((contentX - labelGapPx) / stridePx);
  return Math.max(0, Math.min(stepCount - 1, step));
}
