/**
 * STATE MATRIX — what the shell is supposed to look like in each interaction
 * state, and what it actually looks like right now.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every measurement this project has taken was of the RESTING state: nothing
 * selected, nothing playing, nothing armed. That is the one state in which a
 * DAW does not reveal itself. The cost of that blind spot is already on the
 * record: wave 4 excluded `.track-tab`, `.row-pad`, `.track-header-name` and
 * `.pattern-chip` from the material family because the census samples the
 * first matching element — and their values turned out to be SELECTION
 * signals, each carrying an amber inset beside the highlight. The scope
 * decision was made from one sample of one state.
 *
 * THE SHAPE OF THE THING
 * ----------------------
 * ONE declaration, two consumers:
 *
 *   Diagnostics panel "STATE" tab   -> shows what the shell should look like,
 *                                       and whether it currently does
 *   scripts/state-matrix.mts        -> drives the states and asserts the same
 *
 * They cannot drift, because they read this file.
 *
 * PHASE A (this file, as it stands) is a MEASUREMENT TARGET CATALOG plus the
 * code that reads the live DOM. It declares no expectations yet, on purpose:
 * an expectation invented from one sample is the exact failure this project
 * already made once. Phase B fills in what each state SHOULD be, from the
 * phase A data, reviewed by a human.
 *
 * `readStateMatrix` is deliberately SELF-CONTAINED — no module-scope helpers,
 * no imports. A headless run has to serialise it into the page with
 * `page.evaluate(fn, roles)`, and Playwright stringifies the function: any
 * reference to a module-scope binding would be an undefined name in the page.
 */

/** What a matrix row is: a named role in the shell, and where it lives. */
export interface StateRole {
  /** Stable id — used in the JSON snapshot and in the panel's keys. */
  id: string;
  /** Human label. The panel shows this; the id is for machines. */
  label: string;
  /** Selector for the element that carries the role. */
  selector: string;
  /** Which part of the shell this belongs to, for the panel's grouping. */
  group: "SEQUENCER" | "DOCK" | "TRANSPORT" | "PATTERN BAR" | "CONTROLS" | "CHROME";
}

/**
 * The roles worth measuring. Chosen from what the census and the type probe
 * actually found, not from a wish list:
 *
 *  - the baseline control family (`.btn`, `.dock-tab`, `.preset-chip`) — these
 *    are the ones 59-material-bevel.css owns, so their reading is the direct
 *    check that the material layer applied.
 *  - the channel-name carriers (`.row-pad-name`, `.track-header-name`) — one
 *    role, two sizes, was the one real defect of wave 3.
 *  - the state-carrying surfaces (`.track-tab`, `.row-pad`, `.pattern-chip`) —
 *    these are the ones whose highlight turned out to be a selection signal.
 *  - the grid (`.step`) — 256 cells and 46% of the viewport, and the flattest
 *    large surface in the app.
 */
export const STATE_ROLES: readonly StateRole[] = [
  { id: "channelNameRow", label: "Channel name (row)", selector: ".row-pad-name", group: "SEQUENCER" },
  {
    id: "channelNameHeader",
    label: "Channel name (track header)",
    selector: ".track-header-name",
    group: "SEQUENCER",
  },
  { id: "rowIndex", label: "Row index", selector: ".row-pad-index", group: "SEQUENCER" },
  { id: "stepCell", label: "Step cell", selector: ".step", group: "SEQUENCER" },
  { id: "rulerTick", label: "Ruler tick", selector: ".ruler-tick", group: "SEQUENCER" },
  { id: "trackTab", label: "Track tab", selector: ".track-tab", group: "SEQUENCER" },
  { id: "rowPad", label: "Channel row", selector: ".row-pad", group: "SEQUENCER" },
  { id: "dockTab", label: "Dock tab", selector: ".dock-tab", group: "DOCK" },
  { id: "patternChip", label: "Pattern chip", selector: ".pattern-chip", group: "DOCK" },
  { id: "btn", label: "Button", selector: ".btn", group: "CONTROLS" },
  { id: "btnSmall", label: "Small button", selector: ".btn-small", group: "CONTROLS" },
  { id: "presetChip", label: "Filter chip", selector: ".preset-chip", group: "CONTROLS" },
  { id: "transportBtn", label: "Transport button", selector: ".transport-cluster .btn", group: "TRANSPORT" },
  { id: "positionReadout", label: "Position readout", selector: ".position-display", group: "TRANSPORT" },
  { id: "patternBarLabel", label: "Toolbar group caption", selector: ".toolbar-label", group: "PATTERN BAR" },
  { id: "panelTitleTop", label: "Panel title (top level)", selector: "h2.panel-title", group: "CHROME" },
  { id: "panelTitleLocal", label: "Panel title (local section)", selector: "h3.panel-title", group: "CHROME" },
  { id: "statusbar", label: "Status bar", selector: ".statusbar", group: "CHROME" },
];

/**
 * An interaction state. `drivable` says whether a headless run can ENTER it
 * without faking it: the recorder may only claim a state it actually reached.
 *
 * `recording` is the transport's RECORD button — MIDI overdub into the
 * pattern, not microphone capture. It needs no permission dialog and is
 * therefore drivable. (Arrangement take recording, which DOES need a
 * microphone, is a different surface and is not in this matrix.)
 */
export interface StateDef {
  id: string;
  label: string;
  /** Plain-language description, shown in the panel. */
  description: string;
  /** Can a headless run enter this state without faking it? */
  drivable: boolean;
}

export const STATES: readonly StateDef[] = [
  {
    id: "idle",
    label: "Idle",
    description: "Studio open, nothing selected, transport stopped.",
    drivable: true,
  },
  {
    id: "selected",
    label: "Selected",
    description: "A channel is selected — the amber selection marks appear.",
    drivable: true,
  },
  {
    id: "playing",
    label: "Playing",
    description: "Transport running — the playhead moves and steps light up.",
    drivable: true,
  },
  {
    id: "hover",
    label: "Hover",
    description: "The pointer is over a control.",
    drivable: true,
  },
  {
    id: "focus",
    label: "Keyboard focus",
    description: "A control holds keyboard focus.",
    drivable: true,
  },
  {
    id: "recording",
    label: "Recording",
    description: "Transport is recording — MIDI overdub into the pattern.",
    drivable: true,
  },
];

/** One measured role in one state. */
export interface StateReading {
  roleId: string;
  /** How many elements the selector matched, and how many were visible. */
  matched: number;
  visible: number;
  /** Computed font size in px, or null when the role is not on screen. */
  fontSize: number | null;
  fontWeight: number | null;
  letterSpacing: string | null;
  /** Alpha of the 1px inset TOP highlight — the "catches the light" half. */
  topLight: number | null;
  /** Alpha of the 1px inset BOTTOM shadow — the "sits on something" half. */
  bottomLight: number | null;
  /** True when an inset carries a NON-grey colour: an amber selection mark. */
  hasAccent: boolean;
  /** The accent colour, when there is one. */
  accent: string | null;
  /** Background colour behind the text, for the contrast phase. */
  background: string | null;
  /** The element's own text colour. */
  color: string | null;
  /** The element's text, trimmed — what a human would read. */
  sample: string | null;
}

/**
 * Read every role out of the live DOM.
 *
 * SELF-CONTAINED ON PURPOSE. Playwright serialises this function's source into
 * the page, so it may not reference anything at module scope: the shadow
 * parser, the alpha reader and the accent test are all nested inside. A
 * version that called module-level helpers would throw `is not defined` in the
 * page and the gate would report a harness error instead of a measurement.
 *
 * The shadow shape is `<color> <x> <y> <blur> <spread> [inset]` — the browser
 * normalises it, and `inset` goes LAST. A parser that assumes "inset 0px 1px
 * 0" order matches nothing and reports "no bevel anywhere" while hundreds of
 * surfaces are carrying one. That mistake was made in this project and cost a
 * whole wave of wrong conclusions.
 */
export function readStateMatrix(roles: readonly StateRole[]): StateReading[] {
  const parseShadow = (shadow: string | null | undefined) => {
    if (!shadow || shadow === "none") return [] as {
      color: string;
      x: number;
      y: number;
      inset: boolean;
    }[];
    const out: { color: string; x: number; y: number; inset: boolean }[] = [];
    for (const chunk of shadow.split(/,(?![^(]*\))/)) {
      const color = chunk.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)|#[0-9a-f]{3,8}/i)?.[0];
      if (!color) continue;
      const lengths = [...chunk.matchAll(/(-?\d*\.?\d+)px/g)].map((m) => parseFloat(m[1]));
      if (lengths.length < 2) continue;
      out.push({ color, x: lengths[0] ?? 0, y: lengths[1] ?? 0, inset: /\binset\b/.test(chunk) });
    }
    return out;
  };

  const alphaOf = (color: string | null | undefined): number | null => {
    if (!color) return null;
    const m = /rgba?\(([^)]+)\)/i.exec(color);
    if (!m) return null;
    const parts = m[1].split(",").map((x) => parseFloat(x.trim()));
    if (parts.length < 4) return 1;
    return Number.isFinite(parts[3]) ? parts[3] : null;
  };

  const isAccent = (color: string | null | undefined): boolean => {
    if (!color) return false;
    const m = /rgba?\(([^)]+)\)/i.exec(color);
    if (!m) return false;
    const parts = m[1].split(",").map((x) => parseFloat(x.trim()));
    if (parts.length < 3) return false;
    const max = Math.max(parts[0], parts[1], parts[2]);
    const min = Math.min(parts[0], parts[1], parts[2]);
    // A grey has no channel spread. 5/255 is below what the eye resolves.
    return max - min > 5;
  };

  const scope = document.querySelector(".app") ?? document.body;
  const visibleOf = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    return el.getBoundingClientRect().height > 0;
  };

  return roles.map((role) => {
    const nodes = [...scope.querySelectorAll(role.selector)];
    const visible = nodes.filter(visibleOf);
    const el = visible[0] ?? nodes[0] ?? null;
    const reading: StateReading = {
      roleId: role.id,
      matched: nodes.length,
      visible: visible.length,
      fontSize: null,
      fontWeight: null,
      letterSpacing: null,
      topLight: null,
      bottomLight: null,
      hasAccent: false,
      accent: null,
      background: null,
      color: null,
      sample: null,
    };
    if (!el) return reading;

    const cs = getComputedStyle(el);
    reading.fontSize = Math.round(parseFloat(cs.fontSize) * 10) / 10;
    reading.fontWeight = parseFloat(cs.fontWeight);
    reading.letterSpacing = cs.letterSpacing;
    reading.background = cs.backgroundColor;
    reading.color = cs.color;
    reading.sample = (el.textContent || "").trim().slice(0, 24) || null;

    for (const part of parseShadow(cs.boxShadow)) {
      if (!part.inset) continue;
      if (Math.round(part.y) === -1) reading.bottomLight = alphaOf(part.color);
      else if (Math.round(part.y) === 1 && Math.round(part.x) === 0) reading.topLight = alphaOf(part.color);
      if (isAccent(part.color)) {
        reading.hasAccent = true;
        reading.accent = part.color;
      }
    }
    return reading;
  });
}

/** A snapshot of one state: the readings plus the state's identity. */
export interface StateSnapshot {
  state: string;
  label: string;
  /** False when the run could not actually enter this state. */
  entered: boolean;
  /** Why it could not be entered, when it could not. */
  note?: string;
  readings: StateReading[];
}
