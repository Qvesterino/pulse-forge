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
  {
    id: "stepPlayhead",
    label: "Step cell (playhead column)",
    selector: ".step.playhead",
    group: "SEQUENCER",
  },
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
    description: "Transport running — the position readout advances and the playhead column is ringed.",
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
    label: "Recording (armed)",
    description:
      "MIDI overdub is ARMED — the record button is lit and the OVERDUB/REPLACE mode selector is present. " +
      "This is a MIDI overdub into the pattern, NOT microphone capture.",
    drivable: true,
  },
];

/**
 * One measured role in one state.
 *
 * FIRST-ELEMENT FIELDS vs DISTRIBUTION FIELDS
 * ---------------------------------------------
 * `fontSize`, `topLight`, `background`… describe ONE element: the first
 * visible match. That is the right granularity for a role carried by a single
 * element — a readout, a chip, a title.
 *
 * It is the WRONG granularity for a role carried by MANY elements whose state
 * sits on one of them. The sequencer has 256 step cells and 16 channel rows.
 * The playhead rings one COLUMN of cells; the selection underlines one ROW.
 * Sampling the first cell and the first row therefore reports the same thing
 * in every state: the first cell is never in the playhead column, and the
 * first row is the selected one in all of them.
 *
 * That is not a small detail — it is the reason the first run of this
 * recorder reported six states whose readings were byte-identical while the
 * screenshots clearly differed. The distribution fields exist so that a state
 * whose signal is spread over a set can still be seen:
 *
 *   accentCount   how many elements carry a chromatic mark
 *   ringCount     how many carry a chromatic RING — the playhead's signature
 *   accentIndexes WHICH ones carry it, so a MOVED selection is provable
 *   accentSample  the text of the first marked element — which one is marked
 *   accentColors  the distinct mark colours, so "amber vs green" is readable
 */
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
  /** True when a mark carries a CHROMATIC colour: an amber selection mark. */
  hasAccent: boolean;
  /** The accent colour, when there is one. */
  accent: string | null;
  /** Background colour behind the text, for the contrast phase. */
  background: string | null;
  /** The element's own text colour. */
  color: string | null;
  /** The element's text, trimmed — what a human would read. */
  sample: string | null;

  // ---- distribution over the VISIBLE matches -------------------------------
  /** How many visible elements carry a chromatic mark. */
  accentCount: number;
  /** Distinct mark colours across the visible elements, sorted. */
  accentColors: string[];
  /** Indexes (into the visible matches) of marked elements, capped at 24. */
  accentIndexes: number[];
  /** Text of the first marked element — WHICH one is marked. */
  accentSample: string | null;
  /**
   * How many carry a chromatic RING (a zero-offset inset) — the playhead.
   *
   * NOT A STABLE COUNT. The grid animates `box-shadow`, so the column the
   * playhead just left keeps a fading ring while the new column fades in.
   * Measured: 31 rings in one run, 32 in the next — the trail's radius and
   * alpha depend on where the frame landed in the transition. A declaration
   * that pins this number exactly would be flaky by construction.
   *
   * The STABLE measure of "the transport is running" is the `stepPlayhead`
   * role — the count of cells carrying the `.playhead` class, which is one
   * column, exactly.
   */
  ringCount: number;

  // ---- border marks (kept separate from inset marks) ------------------------
  /**
   * A BORDER mark is a different gesture from an INSET mark: the active
   * pattern chip is outlined, the selected channel row is underlined. Phase B
   * has to be able to say WHICH gesture each state uses, so the two are
   * measured separately instead of being merged into one "accent" field.
   */
  /** The first element's chromatic border colour, if any. */
  borderAccent: string | null;
  /** How many visible elements carry a chromatic border. */
  borderAccentCount: number;
  /** Text of the first element with a chromatic border — which one is marked. */
  borderAccentSample: string | null;
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
      const color = chunk.match(/rgba?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)|#[0-9a-f]{3,8}/i)?.[0];
      if (!color) continue;
      const lengths = [...chunk.matchAll(/(-?\d*\.?\d+)px/g)].map((m) => parseFloat(m[1]));
      if (lengths.length < 2) continue;
      out.push({ color, x: lengths[0] ?? 0, y: lengths[1] ?? 0, inset: /\binset\b/.test(chunk) });
    }
    return out;
  };

  /**
   * Split a colour's component list into numbers.
   *
   * The two formats split DIFFERENTLY, and that difference is the bug this
   * whole parser was rewritten for:
   *
   *   rgb(245, 158, 11, 0.5)          -> comma separated
   *   color(srgb 0.985 0.855 0.636)   -> SPACE separated
   *
   * Splitting `color(srgb ...)` on commas produced ONE number, the "three
   * components are present" check failed, and every surface whose mark came
   * from a `color-mix()` read as UNMARKED — the 256 step cells and the active
   * pattern chip, both of which visibly glow. A parser that silently returns
   * null is a parser that reports "no accent anywhere" over a screen full of
   * accents.
   */
  const nums = (raw: string): number[] =>
    raw
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((token) => {
        const pct = token.endsWith("%");
        const value = parseFloat(pct ? token.slice(0, -1) : token);
        return pct ? value / 100 : value;
      });

  /**
   * OKLab -> sRGB. Standard OKLab matrices (Ottosson).
   *
   * The shell contains 192 `oklab(...)` colours — Chromium's serialisation of
   * `color-mix(in oklab, ...)`. The playhead's own ring is one of them:
   *
   *   oklab(0.768595 0.0561345 0.154817 / 0.424728) 0px 0px 0px 0.816785px inset
   *
   * A parser that only understood `rgb()`/`color(srgb ...)` silently DROPPED
   * that shadow, and with it the one mark that says "the transport is running".
   * Converting to sRGB keeps every colour in ONE space, so the accent test is
   * the same rule for every format.
   */
  const oklabToRgb = (L: number, A: number, B: number, alpha: number) => {
    const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
    const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
    const s_ = L - 0.0894841775 * A - 1.291485548 * B;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    const linR = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const linG = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const linB = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
    const gamma = (x: number) => {
      // Out-of-gamut results can go negative; clamp before the gamma curve.
      const c = x < 0 ? 0 : x > 1 ? 1 : x;
      const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
      return Math.max(0, Math.min(255, v * 255));
    };
    return { r: gamma(linR), g: gamma(linG), b: gamma(linB), a: alpha };
  };

  /**
   * Parse a computed colour into 0-255 channels.
   *
   * FOUR FORMATS occur in this shell, measured: 10813 `rgb`, 1683 `rgba`,
   * 1160 `color(srgb ...)` and 192 `oklab(...)`.
   *
   *   rgb(245, 158, 11)              comma separated, 0-255
   *   rgba(245, 158, 11, 0.5)        comma separated, 0-255 + alpha
   *   color(srgb 0.960 0.619 0.043)  SPACE separated, 0-1
   *   oklab(0.768 0.056 0.154)       SPACE separated, OKLab
   */
  const rgbOf = (color: string | null | undefined) => {
    if (!color) return null;
    const t = color.trim();

    const rgbMatch = /^rgba?\(([^)]*)\)$/i.exec(t);
    if (rgbMatch) {
      const parts = nums(rgbMatch[1]);
      if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
        return {
          r: parts[0],
          g: parts[1],
          b: parts[2],
          a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1,
        };
      }
      return null;
    }

    const srgbMatch = /^color\(\s*srgb(?:-linear)?\s+([^)]*)\)$/i.exec(t);
    if (srgbMatch) {
      const parts = nums(srgbMatch[1]);
      if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
        // color(srgb) components are 0..1.
        return {
          r: parts[0] * 255,
          g: parts[1] * 255,
          b: parts[2] * 255,
          a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1,
        };
      }
      return null;
    }

    // `oklab(...)` and `color(oklab ...)` — both forms occur.
    const oklabAt = t.toLowerCase().indexOf("oklab");
    if (oklabAt >= 0) {
      const open = t.indexOf("(", oklabAt);
      const close = t.indexOf(")", open);
      if (open >= 0 && close > open) {
        const parts = nums(t.slice(open + 1, close));
        if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
          return oklabToRgb(parts[0], parts[1], parts[2], parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1);
        }
      }
    }

    return null;
  };

  const alphaOf = (color: string | null | undefined): number | null => {
    const c = rgbOf(color);
    return c ? c.a : null;
  };

  /**
   * Normalise a colour to ONE sRGB string, so two marks can be compared even
   * when the browser serialised them differently.
   *
   * The playhead ring arrives as `oklab(...)` and the selection underline as
   * `rgb(245, 158, 11)`. Those are the SAME amber, but as raw strings they
   * are different tokens — and a matrix whose job is to compare colours
   * across states cannot carry four different spellings of "amber".
   */
  const normalizeColor = (color: string | null | undefined): string | null => {
    const c = rgbOf(color);
    if (!c) return null;
    const r = Math.round(c.r);
    const g = Math.round(c.g);
    const b = Math.round(c.b);
    if (c.a < 0.999) return `rgba(${r}, ${g}, ${b}, ${Math.round(c.a * 1000) / 1000})`;
    return `rgb(${r}, ${g}, ${b})`;
  };

  /**
   * A CHROMATIC colour is one the eye reads as a HUE.
   *
   * The first version asked only "do the channels differ by more than 5/255?".
   * That PASSED `rgba(18, 22, 27, 0.28)` — the neutral dark bottom bevel every
   * `.track-tab` carries — so half the shell reported a coloured accent that
   * is not there, and the `trackTab` role claimed an amber mark in every
   * state. HSL saturation separates them cleanly:
   *
   *   rgba(18, 22, 27, 0.28)   s = 0.20   neutral dark bevel   -> NOT a mark
   *   rgb(74, 222, 128)        s = 0.69   play green           -> mark
   *   rgb(245, 158, 11)        s = 0.92   amber                -> mark
   *   rgb(217, 219, 225)       s = 0.12   grey text            -> NOT a mark
   *
   * An INVISIBLE mark is not a mark: a colour at alpha 0 is not on screen.
   */
  const isAccent = (color: string | null | undefined): boolean => {
    const c = rgbOf(color);
    if (!c) return false;
    if (c.a < 0.05) return false;
    const max = Math.max(c.r, c.g, c.b) / 255;
    const min = Math.min(c.r, c.g, c.b) / 255;
    if (max - min < 8 / 255) return false;
    const l = (max + min) / 2;
    const s = l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
    return s >= 0.35;
  };

  const scope = document.querySelector(".app") ?? document.body;
  const visibleOf = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    return el.getBoundingClientRect().height > 0;
  };

  /**
   * Inspect ONE element: its two edge lights, its INSET mark, its BORDER mark
   * and whether it wears a ring.
   *
   * INSET AND BORDER ARE SEPARATE MARKS, deliberately. The selection underline
   * on `.row-pad` is an inset; the active `.pattern-chip` is an outline. They
   * are different gestures in the design language, and the matrix exists to
   * keep them apart — merging them into one "accent" field would hide exactly
   * the distinction Phase B has to declare.
   */
  const inspect = (el: Element) => {
    const cs = getComputedStyle(el);
    let topLight: number | null = null;
    let bottomLight: number | null = null;
    let accent: string | null = null;
    let ring = false;

    for (const part of parseShadow(cs.boxShadow)) {
      if (!part.inset) continue;
      if (Math.round(part.y) === -1) bottomLight = alphaOf(part.color);
      else if (Math.round(part.y) === 1 && Math.round(part.x) === 0) topLight = alphaOf(part.color);
      // A RING is a ZERO-OFFSET inset — `inset 0 0 0 1px`. That is how the
      // playhead marks its column: neither a top light nor a bottom shadow,
      // so it used to fall through every branch and the state was invisible.
      if (Math.round(part.x) === 0 && Math.round(part.y) === 0 && isAccent(part.color)) ring = true;
      if (!accent && isAccent(part.color)) accent = normalizeColor(part.color);
    }

    let borderAccent: string | null = null;
    for (const side of [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor]) {
      if (isAccent(side)) {
        borderAccent = normalizeColor(side);
        break;
      }
    }

    return {
      cs,
      topLight,
      bottomLight,
      accent,
      borderAccent,
      ring,
      background: cs.backgroundColor,
      color: cs.color,
      sample: (el.textContent || "").trim().slice(0, 24) || null,
    };
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
      accentCount: 0,
      accentColors: [],
      accentIndexes: [],
      accentSample: null,
      ringCount: 0,
      borderAccent: null,
      borderAccentCount: 0,
      borderAccentSample: null,
    };

    // The distribution is computed over the VISIBLE matches: a hidden element
    // cannot carry a mark a user can see.
    const inspected = visible.map((node) => inspect(node));
    const accentColors = new Set<string>();
    const accentIndexes: number[] = [];
    let accentCount = 0;
    let ringCount = 0;
    let accentSample: string | null = null;
    let borderAccentCount = 0;
    let borderAccentSample: string | null = null;
    inspected.forEach((info, index) => {
      if (info.ring) ringCount += 1;
      if (info.borderAccent) {
        borderAccentCount += 1;
        if (borderAccentSample === null) borderAccentSample = info.sample;
      }
      if (!info.accent) return;
      accentCount += 1;
      accentColors.add(info.accent);
      if (accentSample === null) accentSample = info.sample;
      if (accentIndexes.length < 24) accentIndexes.push(index);
    });
    reading.accentCount = accentCount;
    reading.accentColors = [...accentColors].sort();
    reading.accentIndexes = accentIndexes;
    reading.accentSample = accentSample;
    reading.ringCount = ringCount;
    reading.borderAccentCount = borderAccentCount;
    reading.borderAccentSample = borderAccentSample;

    if (!el) return reading;
    const info = inspected[0] ?? inspect(el);
    reading.fontSize = Math.round(parseFloat(info.cs.fontSize) * 10) / 10;
    reading.fontWeight = parseFloat(info.cs.fontWeight);
    reading.letterSpacing = info.cs.letterSpacing;
    reading.topLight = info.topLight;
    reading.bottomLight = info.bottomLight;
    reading.hasAccent = info.accent !== null;
    reading.accent = info.accent;
    reading.borderAccent = info.borderAccent;
    reading.background = info.background;
    reading.color = info.color;
    reading.sample = info.sample;
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
