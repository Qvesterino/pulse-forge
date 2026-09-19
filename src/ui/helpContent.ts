/**
 * Help content — mouse & touch gestures, one source of truth for the help
 * overlay. The editors keep their own `title` tooltips; the entries below
 * mirror them (same wording where practical) so "?" documents what the UI
 * actually does. When a gesture changes here, change the tooltip too.
 */

export interface GestureEntry {
  area: string;
  /** Short name of the gesture, e.g. "Drag note vertically". */
  action: string;
  /** What it does / which modifier activates it. */
  detail: string;
}

export const GESTURES: GestureEntry[] = [
  // ── Jam / keys ───────────────────────────────────────────────────────────
  {
    area: "Jam",
    action: "A–K / W–P / ; keys",
    detail: "Play the selected instrument from the computer keyboard (sustains while held)",
  },
  { area: "Jam", action: "Z / X", detail: "Octave down / up for the melodic keys" },
  { area: "Jam", action: "1–8 (drum track)", detail: "Trigger drum pads — rebindable in the drum rack KEYS editor" },
  // ── Sequencer ────────────────────────────────────────────────────────────
  { area: "Sequencer", action: "Click step", detail: "Toggle the hit on/off" },
  { area: "Sequencer", action: "Drag step vertically", detail: "Velocity (up = louder)" },
  { area: "Sequencer", action: "Alt + drag step", detail: "Microtiming −1..1 (early/late)" },
  { area: "Sequencer", action: "Ctrl/Cmd + drag step", detail: "Probability 0..1 (hits fire randomly)" },
  { area: "Sequencer", action: "Shift + drag across steps", detail: "Multi-select steps for bulk p-lock edits" },
  {
    area: "Sequencer",
    action: "Right-click / long-press step",
    detail: "Open the p-lock editor (per-step pitch, gain, pan, cutoff…)",
  },
  { area: "Sequencer", action: "Drag the bottom amount bar", detail: "Amount 0..100 % — ghost vs accent hits" },
  // ── Piano roll ───────────────────────────────────────────────────────────
  { area: "Piano roll", action: "Click empty grid", detail: "Add a note (right-drag or Shift+drag = marquee select)" },
  { area: "Piano roll", action: "Drag note — top third", detail: "Move the note" },
  { area: "Piano roll", action: "Drag note — right edge", detail: "Resize (note length)" },
  {
    area: "Piano roll",
    action: "Middle + Alt / middle + Ctrl",
    detail: "Duplicate the note / change velocity while dragging",
  },
  { area: "Piano roll", action: "Velocity lane, drag vertically", detail: "Per-note velocity" },
  {
    area: "Piano roll",
    action: "With a note selected: S · Alt+S · L · Ctrl+B",
    detail: "Strum · slide · legato · duplicate",
  },
  // ── Values & dice ────────────────────────────────────────────────────────
  {
    area: "Values & dice",
    action: "Drag a number",
    detail: "Scrub the value; Enter types an exact value; double-click resets to default",
  },
  {
    area: "Values & dice",
    action: "Dice tray open: D · Shift+D",
    detail: "Roll full variation / small vary (only while the tray is visible)",
  },
  { area: "Values & dice", action: "Dice tray open: ← →", detail: "Walk the roll history" },
  { area: "Values & dice", action: "Dice locks", detail: "Locked stems survive the roll; Apply is one undo step" },
];

export const GESTURE_AREAS = [...new Set(GESTURES.map((g) => g.area))];

export function gesturesByArea(): Array<{ area: string; items: GestureEntry[] }> {
  return GESTURE_AREAS.map((area) => ({ area, items: GESTURES.filter((g) => g.area === area) }));
}

/** Case-insensitive match against every visible piece of a gesture. */
export function gestureMatches(gesture: GestureEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    gesture.area.toLowerCase().includes(q) ||
    gesture.action.toLowerCase().includes(q) ||
    gesture.detail.toLowerCase().includes(q)
  );
}
