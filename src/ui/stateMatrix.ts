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

  // ---- contrast (phase D) ----------------------------------------------------
  /**
   * WCAG contrast of the element's own text colour against the background
   * BEHIND it — not against the token it was declared with.
   *
   * The difference matters: `--text-faint` on the app background is one
   * number, and the same token over a translucent panel over a lit step is
   * another. `26-settings-glass.css` says so itself: its 4.86:1 holds "against
   * the app background", and "against a LIGHT backdrop the composite would
   * fall below AA". That second case was never measured. This is the phase D
   * reading: the background is composited from the real ancestor chain.
   */
  contrast: number | null;
  /** The composited background behind the element. */
  compositedBackground: string | null;
  /**
   * False when the background could NOT be resolved from the DOM — an ancestor
   * paints a gradient, so the colour under the text depends on where in the
   * gradient it lands. Reported, never guessed.
   */
  backgroundResolved: boolean;
  /** Why the background could not be resolved. */
  backgroundNote: string | null;
  /** The AA floor that applies at this size: 4.5 for normal text, 3 for large. */
  contrastFloor: number;
  /** Whether the text counts as large under WCAG (>=24px, or >=18.66px bold). */
  largeText: boolean;
  /**
   * True when the role's element is INSIDE the viewport.
   *
   * "Visible" (a height, not `display: none`) is not the same thing: the
   * inspector's `<h3 class="panel-title">TRACK MIX</h3>` sits at y = 1092 in a
   * 900px-tall window — rendered, measurable, and off screen. A contrast
   * rule cannot be exercised on text nobody can see, and a rule that claims
   * otherwise is a rule that lies about its own coverage.
   */
  onScreen: boolean;
  /**
   * The pixel measurement, when one was taken for this role.
   *
   * The static `contrast` above composites solid background-colours only. For
   * a role that paints a gradient, the static reading is UNRESOLVED and this
   * is the real answer. `null` means "no pixel measurement was taken", which
   * is different from "the measurement found nothing".
   */
  pixelContrast: PixelContrast | null;

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

  // ---- focus rings -----------------------------------------------------------
  /**
   * The focus ring in this shell is an OUTLINE, not a shadow:
   *
   *   outline: 2px solid color-mix(in srgb, var(--accent) 84%, #fff);
   *
   * A reader that only looks at box-shadow and border cannot see it at all —
   * which is why the first "focus" recording was pixel-identical to "idle".
   * The outline is counted over the whole set, because the focused element is
   * ONE of many and the first element of the set is usually not the one.
   */
  /** How many visible elements carry a visible outline. */
  outlineCount: number;
  /** The normalised colour of the first visible outline. */
  outlineAccent: string | null;
  /** The outline width in px of the first visible outline. */
  outlineWidth: number | null;

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
    if (!shadow || shadow === "none")
      return [] as {
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

  /**
   * Composite the background BEHIND an element.
   *
   * Walks the ancestor chain and layers the background-colours source-over,
   * which is what the browser does, and stops at the first opaque layer.
   *
   * A layer with a background-IMAGE is NOT resolvable this way: the colour
   * under the text depends on where in the gradient the text lands. That is
   * REPORTED as unresolved, not guessed — a guessed background is how a
   * contrast number becomes a fiction.
   */
  const compositeBackground = (el: Element) => {
    const layers: { r: number; g: number; b: number; a: number }[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        const cls = (node.getAttribute("class") || "").split(/\s+/)[0] || node.tagName.toLowerCase();
        return { color: null, resolved: false, note: `${cls} paints a background-image` };
      }
      const bg = rgbOf(cs.backgroundColor);
      if (bg && bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 0.999) break;
      }
    }
    // Layer from the bottom up — source-over.
    let base = { r: 0, g: 0, b: 0, a: 0 };
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const L = layers[i];
      const a = L.a + base.a * (1 - L.a);
      if (a <= 0) continue;
      base = {
        r: (L.r * L.a + base.r * base.a * (1 - L.a)) / a,
        g: (L.g * L.a + base.g * base.a * (1 - L.a)) / a,
        b: (L.b * L.a + base.b * base.a * (1 - L.a)) / a,
        a,
      };
    }
    if (base.a < 0.999) {
      // Nothing opaque behind it: the browser canvas shows through.
      const k = base.a;
      base = { r: 255 * (1 - k) + base.r * k, g: 255 * (1 - k) + base.g * k, b: 255 * (1 - k) + base.b * k, a: 1 };
    }
    return {
      color: `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`,
      resolved: true,
      note: null,
    };
  };

  /** WCAG relative luminance. */
  const relLuminance = (r: number, g: number, b: number) => {
    const ch = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };

  /** WCAG contrast ratio between two colours. */
  const contrastRatio = (fg: string | null | undefined, bg: string | null | undefined): number | null => {
    const f = rgbOf(fg);
    const b = rgbOf(bg);
    if (!f || !b) return null;
    // A translucent text colour is composited over the background first.
    const fr = f.a >= 0.999 ? f.r : f.r * f.a + b.r * (1 - f.a);
    const fg2 = f.a >= 0.999 ? f.g : f.g * f.a + b.g * (1 - f.a);
    const fb = f.a >= 0.999 ? f.b : f.b * f.a + b.b * (1 - f.a);
    const l1 = relLuminance(fr, fg2, fb);
    const l2 = relLuminance(b.r, b.g, b.b);
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
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

    // The focus ring is an OUTLINE. It is invisible to a box-shadow reader.
    const outlineWidth = parseFloat(cs.outlineWidth);
    const hasOutline = cs.outlineStyle !== "none" && Number.isFinite(outlineWidth) && outlineWidth > 0;
    const outlineAccent = hasOutline ? normalizeColor(cs.outlineColor) : null;

    return {
      cs,
      topLight,
      bottomLight,
      accent,
      borderAccent,
      ring,
      hasOutline,
      outlineAccent,
      outlineWidth: hasOutline ? outlineWidth : null,
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
      contrast: null,
      compositedBackground: null,
      backgroundResolved: false,
      backgroundNote: null,
      contrastFloor: 4.5,
      largeText: false,
      onScreen: false,
      pixelContrast: null,
      accentCount: 0,
      accentColors: [],
      accentIndexes: [],
      accentSample: null,
      ringCount: 0,
      outlineCount: 0,
      outlineAccent: null,
      outlineWidth: null,
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
    let outlineCount = 0;
    let outlineAccent: string | null = null;
    let outlineWidth: number | null = null;
    inspected.forEach((info, index) => {
      if (info.ring) ringCount += 1;
      if (info.hasOutline) {
        outlineCount += 1;
        if (outlineAccent === null) outlineAccent = info.outlineAccent;
        if (outlineWidth === null) outlineWidth = info.outlineWidth;
      }
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
    reading.outlineCount = outlineCount;
    reading.outlineAccent = outlineAccent;
    reading.outlineWidth = outlineWidth;
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

    // ---- phase D: the contrast this text actually has ------------------------
    // Only the FIRST visible element: the contrast is a property of the role
    // as the reading describes it, and the distribution counts are a separate
    // question.
    const backdrop = compositeBackground(el);
    reading.compositedBackground = backdrop.color;
    reading.backgroundResolved = backdrop.resolved;
    reading.backgroundNote = backdrop.note;
    reading.contrast = backdrop.resolved ? contrastRatio(info.color, backdrop.color) : null;
    // WCAG "large text": >=24px, or >=18.66px when bold.
    reading.largeText =
      reading.fontSize !== null &&
      (reading.fontSize >= 24 || (reading.fontSize >= 18.66 && (reading.fontWeight ?? 400) >= 700));
    reading.contrastFloor = reading.largeText ? 3 : 4.5;
    // Is the element actually inside the viewport? "Has a height" is not the
    // same question — see `onScreen`.
    const rect = el.getBoundingClientRect();
    reading.onScreen =
      rect.bottom > 0 && rect.right > 0 && rect.top < (window.innerHeight || 0) && rect.left < (window.innerWidth || 0);
    return reading;
  });
}

/**
 * What the PIXEL measurement found for one role.
 *
 * The static reader can only composite solid background-colours. Nine roles
 * paint a gradient, and for those the colour under the text depends on where
 * in the gradient the text lands. The pixel measurement answers that for
 * real: it compares a screenshot with the text and one with the text made
 * transparent, so the second screenshot's pixels ARE the background under the
 * glyphs.
 */
export interface PixelContrast {
  /** Which role this measurement belongs to. */
  id: string;
  /** The WORST contrast over the text pixels — WCAG asks for the worst case. */
  minContrast: number | null;
  /** Mean over the text pixels. Informational only; a mean hides a gradient. */
  meanContrast: number | null;
  /** How many pixels were counted as painted text. */
  textPixels: number;
  /** The background colour at the worst text pixel. */
  worstBackground: string | null;
  /**
   * The TEXT colour that produced the worst pixel.
   *
   * Without it the number is unreadable: a role can hold several text
   * colours at once (a `.row-pad` holds a 13px name and an 8px index), and
   * "4.45:1" says nothing about WHICH text failed.
   */
  worstTextColor: string | null;
  /** The text colours the pixels were matched against. */
  textColors: string[];
  /**
   * How many DISTINCT (background, text colour) surfaces the text appears on.
   *
   * One means a single flat surface. Many means the text spans a gradient or
   * several chips — and then the worst one is a real reading, not a sliver.
   */
  surfaces: number;
  /**
   * How many text pixels sat on the WORST surface.
   *
   * This is what separates "the text is unreadable here" from "one pixel of a
   * glyph grazed a 1px highlight". A sliver has a count of 1–2; a surface the
   * text is genuinely read against has dozens.
   */
  worstSurfacePixels: number;
  /** Where the worst pixel was, relative to the role's box. */
  worstPixel: { x: number; y: number } | null;
  /**
   * The worst contrast among the surfaces that carry only a STRAY share of
   * the text — a glyph grazing a 1px highlight, a moving meter edge.
   *
   * Reported, not gated: one pixel is a rendering detail, not a surface the
   * text is read against. A gate that fired on these would cry wolf on every
   * run and be switched off within a week.
   */
  sliverContrast: number | null;
  /** How many pixels the sliver covered. */
  sliverPixels: number;
  /**
   * The worst surface that carries a DOMINANT share of the text (at least
   * 10%), or null when the text is spread so thin that no surface dominates.
   *
   * This is the surface the text is actually read against. The overall worst
   * surface may be one pixel — a glyph edge grazing a 1px highlight — and that
   * is a rendering detail, not a surface.
   */
  dominantContrast: number | null;
  /** The background colour of that dominant surface. */
  dominantBackground: string | null;
  /** How many text pixels sit on the dominant surface. */
  dominantPixels: number;
  /**
   * How MANY of the role's text pixels fall below the AA floor (4.5:1).
   *
   * The minimum alone cannot tell "this text is unreadable" from "one glyph
   * edge grazed a highlight". The share can: 100% of the index on a 4.45:1
   * surface is a defect, and 2.5% of a status bar whose top row grazes a
   * 1px highlight is not.
   */
  belowFloorPixels: number;
  /** The same thing as a fraction of the role's text pixels. */
  belowFloorShare: number;
  /** The minimum pixel count a surface needs to count as a real surface. */
  minSurfacePixels: number;
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

/**
 * WHAT A STATE SHOULD LOOK LIKE — the declaration.
 *
 * Written FROM the phase A data, not before it. That order is the whole point:
 * wave 4 pinned a material value to one sample of one state and shipped a
 * wrong conclusion, and the plan's own rule is that a declaration is only
 * allowed after a measurement, reviewed by a human.
 *
 * WHAT IS DECLARED, AND WHAT IS NOT
 * ----------------------------------
 * Only SHELL RULES. A rule that depends on the CONTENT of the open project is
 * not a rule about the shell and does not belong here. Two examples of what
 * this table therefore does NOT say:
 *
 *   "the track header turns green while playing" — FALSE as a shell rule. It
 *   turns green when THAT TRACK IS SOUNDING; a silent track stays amber. The
 *   phase A run measured green because the House template's drum track was
 *   sounding. Declaring it would pin a project fact to a shell rule.
 *
 *   "the playhead rings exactly 32 cells" — FALSE as a number. The grid
 *   animates `box-shadow`, so the column the playhead left keeps a fading
 *   ring: 31 in one run, 32 in the next. Ranges, not exact counts, wherever
 *   the CSS transitions.
 */
export interface StateExpectation {
  /** Which interaction state this row is about. */
  state: string;
  /** Which role in the matrix. */
  role: string;
  /** What that role should look like in that state. */
  expect: {
    /** Exact number of visible elements matching the role. */
    visible?: number;
    /** Elements carrying a chromatic INSET mark (engraved). */
    insetMarks?: { min?: number; max?: number };
    /** Elements carrying a chromatic BORDER mark (outlined). */
    borderMarks?: { min?: number; max?: number };
    /** Elements carrying a chromatic RING (the playhead). */
    rings?: { min?: number; max?: number };
    /** Elements carrying a focus outline. */
    outlines?: { min?: number; max?: number };
    /** The exact normalised colour of the inset mark. */
    insetColour?: string;
    /** The exact normalised colour of the border mark. */
    borderColour?: string;
    /** The mark must sit on a DIFFERENT element than it did in `idle`. */
    markMovedFromIdle?: boolean;
    /** The role's text must differ from `idle` (the transport advanced). */
    textChangedFromIdle?: boolean;
  };
  /** Why this expectation exists. Shown in the panel; read by humans. */
  because: string;
}

/**
 * THE TABLE. Every row is a shell rule, every row says why.
 *
 * The reader is `scripts/state-matrix.mts --gate`; the second reader will be
 * the Diagnostics panel's STATE tab. They cannot drift, because they read
 * this array.
 */
export const STATE_EXPECTATIONS: readonly StateExpectation[] = [
  // ---- idle: the resting shell ------------------------------------------------
  {
    state: "idle",
    role: "rowPad",
    expect: { insetMarks: { min: 1, max: 1 }, insetColour: "rgb(245, 158, 11)" },
    because:
      "the resting shell marks the selected channel with an amber underline — exactly one, never zero, never two",
  },
  {
    state: "idle",
    role: "stepPlayhead",
    expect: { visible: 0 },
    because: "no cell may carry the playhead class while the transport is stopped",
  },
  {
    state: "idle",
    role: "stepCell",
    expect: { rings: { max: 0 } },
    because: "no cell may wear a ring while the transport is stopped",
  },
  {
    state: "idle",
    role: "rulerTick",
    expect: { borderMarks: { max: 0 } },
    because: "no ruler tick is 'current' while the transport is stopped",
  },
  {
    state: "idle",
    role: "transportBtn",
    expect: { outlines: { max: 0 } },
    because: "no focus ring at rest — a ring is a keyboard signal, not a resting state",
  },

  // ---- selected: the selection moved ------------------------------------------
  {
    state: "selected",
    role: "rowPad",
    expect: { insetMarks: { min: 1, max: 1 }, markMovedFromIdle: true },
    because:
      "selecting another channel MOVES the amber underline — still exactly one mark, but on a different row. " +
      "A selection that did not move would look identical to idle, and that is what the first recorder measured.",
  },

  // ---- playing: the transport runs --------------------------------------------
  {
    state: "playing",
    role: "stepPlayhead",
    expect: { visible: 16 },
    because: "the transport marks exactly ONE column of cells — 16 rows, one column",
  },
  {
    state: "playing",
    role: "stepCell",
    expect: { rings: { min: 1 } },
    because:
      "the playhead column is ringed. A MINIMUM, not an exact count: the grid animates box-shadow, so the column " +
      "the playhead just left keeps a fading ring and the count moves with the frame (31 measured, 32 measured).",
  },
  {
    state: "playing",
    role: "rulerTick",
    expect: { borderMarks: { min: 1, max: 1 } },
    because: "the ruler marks the current step — exactly one tick",
  },
  {
    state: "playing",
    role: "positionReadout",
    expect: { textChangedFromIdle: true },
    because: "the position readout ADVANCES — a running transport that does not move is not running",
  },
  {
    state: "playing",
    role: "transportBtn",
    expect: { borderMarks: { min: 1 } },
    because: "the running transport button is marked, so the transport state is visible on the transport itself",
  },

  // ---- hover: the pointer is on a control -------------------------------------
  {
    state: "hover",
    role: "transportBtn",
    expect: { borderMarks: { min: 1 } },
    because: "the hovered control gets a brighter edge — hover must be visible without a click",
  },
  {
    state: "hover",
    role: "stepPlayhead",
    expect: { visible: 0 },
    because: "hovering is not playback — the playhead must not appear",
  },

  // ---- focus: the keyboard is here --------------------------------------------
  {
    state: "focus",
    role: "transportBtn",
    expect: { outlines: { min: 1, max: 1 } },
    because:
      "keyboard focus paints exactly ONE ring. It is an OUTLINE, not a shadow, so a reader that only looks at " +
      "box-shadow sees nothing at all here.",
  },
  {
    state: "focus",
    role: "stepPlayhead",
    expect: { visible: 0 },
    because: "focus is not playback — the playhead must not appear",
  },

  // ---- recording: MIDI overdub is armed ----------------------------------------
  {
    state: "recording",
    role: "transportBtn",
    expect: { borderMarks: { min: 2 } },
    because:
      "two transport buttons are marked while armed: the running transport and the record button itself. " +
      "One mark would mean the arming is not visible on the transport.",
  },
  {
    state: "recording",
    role: "stepPlayhead",
    expect: { visible: 16 },
    because: "arming the overdub starts the transport, so the playhead column is marked",
  },
];

/** The verdict for one expectation, with the reasons it failed. */
export interface ExpectationResult {
  state: string;
  role: string;
  ok: boolean;
  /** One line per broken rule. Empty when the expectation held. */
  failures: string[];
  /** The rationale, carried through so a failing gate explains itself. */
  because: string;
}

const inRange = (value: number, range: { min?: number; max?: number }): boolean => {
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
};

/**
 * Check one expectation against one reading.
 *
 * PURE — no DOM, no browser. That is deliberate: the gate runs in a headless
 * page, and the panel runs in the app, and a rule that can only be checked in
 * one of them is a rule that is only half enforced.
 *
 * `idle` is the reference reading for the two cross-state rules ("the mark
 * MOVED", "the text CHANGED"). They are cross-state by nature: "the selection
 * moved" is a statement about the difference between two snapshots, not about
 * one of them.
 */
export function evaluateExpectation(
  expectation: StateExpectation,
  reading: StateReading | undefined,
  idle: StateReading | undefined,
): ExpectationResult {
  const failures: string[] = [];
  const { expect: want } = expectation;

  if (!reading) {
    return {
      state: expectation.state,
      role: expectation.role,
      ok: false,
      failures: ["the role was not read at all"],
      because: expectation.because,
    };
  }

  if (want.visible !== undefined && reading.visible !== want.visible) {
    failures.push(`visible ${reading.visible}, expected ${want.visible}`);
  }
  if (want.insetMarks && !inRange(reading.accentCount, want.insetMarks)) {
    failures.push(`${reading.accentCount} inset marks, expected ${JSON.stringify(want.insetMarks)}`);
  }
  if (want.borderMarks && !inRange(reading.borderAccentCount, want.borderMarks)) {
    failures.push(`${reading.borderAccentCount} border marks, expected ${JSON.stringify(want.borderMarks)}`);
  }
  if (want.rings && !inRange(reading.ringCount, want.rings)) {
    failures.push(`${reading.ringCount} rings, expected ${JSON.stringify(want.rings)}`);
  }
  if (want.outlines && !inRange(reading.outlineCount, want.outlines)) {
    failures.push(`${reading.outlineCount} outlines, expected ${JSON.stringify(want.outlines)}`);
  }
  if (want.insetColour !== undefined && reading.accent !== want.insetColour) {
    failures.push(`inset colour ${reading.accent ?? "none"}, expected ${want.insetColour}`);
  }
  if (want.borderColour !== undefined && reading.borderAccent !== want.borderColour) {
    failures.push(`border colour ${reading.borderAccent ?? "none"}, expected ${want.borderColour}`);
  }
  if (want.markMovedFromIdle) {
    const before = idle?.accentSample ?? null;
    const after = reading.accentSample ?? null;
    if (!after || !before || after === before) {
      failures.push(`the mark did not move (idle "${before}", now "${after}")`);
    }
  }
  if (want.textChangedFromIdle) {
    const before = idle?.sample ?? null;
    const after = reading.sample ?? null;
    if (!after || !before || after === before) {
      failures.push(`the text did not change (idle "${before}", now "${after}")`);
    }
  }

  return {
    state: expectation.state,
    role: expectation.role,
    ok: failures.length === 0,
    failures,
    because: expectation.because,
  };
}

/* =============================================================================
 * PHASE D — CONTRAST
 * ========================================================================== */

/**
 * WHAT A ROLE'S TEXT MUST REACH — the contrast declaration.
 *
 * The floor comes from WCAG 2.2 SC 1.4.3 (Contrast Minimum), NOT from what the
 * shell happens to measure: 4.5:1 for normal text, 3:1 for large text (>=24px,
 * or >=18.66px when bold). A declaration that pinned the MEASURED value would
 * be a tautology — it would pass for anything, including a colour nobody can
 * read. The measured value is the EVIDENCE; the floor is the standard.
 *
 * The floor is per ROLE, not per state: a role's text must be legible in
 * every state where the role is on screen. A state is not a licence to be
 * less legible — a selected row is not a dimmer row, and a playing row is
 * not a dimmer row.
 */
export interface ContrastExpectation {
  /** The role. */
  role: string;
  /**
   * The minimum contrast the role's text must reach, in EVERY state where the
   * role is on screen.
   */
  min: number;
  /** Why this role, and why this floor. */
  because: string;
}

/**
 * THE TABLE. One row per role that carries text, and every row says why.
 *
 * The roles that carry NO text on screen (a step cell, a playhead cell) are
 * not here: WCAG 1.4.3 is about text, and a rule about a surface that holds
 * no text is a rule with nothing to check.
 */
export const CONTRAST_EXPECTATIONS: readonly ContrastExpectation[] = [
  {
    role: "rowIndex",
    min: 4.5,
    because:
      "the 1-based row number is 8px metadata on the sequencer's RAISED row surface, and on a selected row it " +
      "sits inside the amber pulse. It measured 4.45:1 on the plain row and 3.09:1 on the pulse — both under AA, " +
      "and the digits 1, 3, 4 and 5 were hard to make out in the screenshot. 60-contrast-legibility.css raised it.",
  },
  {
    role: "channelNameRow",
    min: 4.5,
    because:
      "the channel name in the sequencer row is the shell's primary label — it carries the identity of the track",
  },
  {
    role: "channelNameHeader",
    min: 4.5,
    because:
      "the channel name in the track header is the same name at the same size; one may not be dimmer than the other",
  },
  {
    role: "rowPad",
    min: 4.5,
    because: "the row is the unit a user reads the sequencer by — its name and its index both have to be legible",
  },
  {
    role: "rulerTick",
    min: 4.5,
    because: "the ruler tick labels the step under the pointer; a tick nobody can read cannot be aimed at",
  },
  {
    role: "trackTab",
    min: 4.5,
    because:
      "the track tab names a channel in the header rack — the shell already puts bright silver on silver glass here",
  },
  {
    role: "dockTab",
    min: 4.5,
    because:
      "the dock tab row is the primary navigation of the bottom half of the studio. Its label measured 2.03:1 on the " +
      "silver sweep's light end, and the ACTIVE tab's amber 3.55:1 — and the amber is the selection signal, so the " +
      "surface had to move instead. 60-contrast-legibility.css dimmed the sweep and gave the label the shell's silver.",
  },
  {
    role: "patternChip",
    min: 4.5,
    because: "the pattern chip is amber on a silver sweep, and the amber is how a user finds the pattern they are in",
  },
  {
    role: "btn",
    min: 4.5,
    because: "a button's label is the button; a control that cannot be read cannot be used",
  },
  {
    role: "btnSmall",
    min: 4.5,
    because: "the small buttons (mute, solo) are the fastest gesture in the sequencer, and 10px is already small",
  },
  {
    role: "presetChip",
    min: 4.5,
    because: "the filter chip names the filter that is applied — the user has to know what they are hearing",
  },
  {
    role: "transportBtn",
    min: 4.5,
    because: "the transport is the one control group that must be readable at a glance, in every state",
  },
  {
    role: "positionReadout",
    min: 4.5,
    because: "the position readout is the only place the musical position is shown in digits",
  },
  {
    role: "patternBarLabel",
    min: 4.5,
    because: "the toolbar caption groups the controls under it; an unreadable caption is an unlabelled group",
  },
  {
    role: "panelTitleLocal",
    min: 4.5,
    because: "a local section title is the only thing that says which section of the panel you are in",
  },
  {
    role: "statusbar",
    min: 4.5,
    because: "the status bar is where the engine's state is reported; if it cannot be read, it is not reporting",
  },
];

/** The verdict for one contrast expectation, with the reasons it failed. */
export interface ContrastResult {
  role: string;
  state: string;
  ok: boolean;
  /** The measured contrast, or null when it could not be measured at all. */
  measured: number | null;
  /** Where the number came from. */
  source: "pixel" | "static" | "none";
  /** One line per broken rule. Empty when the expectation held. */
  failures: string[];
  /** The rationale, carried through so a failing gate explains itself. */
  because: string;
}

/**
 * How much of a role's text may fall below the floor.
 *
 * TEN PERCENT — and the same number the measurement uses to decide what
 * counts as a DOMINANT surface. One threshold, used twice.
 *
 * It is not a fudge factor, it is the gap the measurement shows:
 *
 *   0 %   the roles that are simply fine
 *   2.5 % the NOISE FLOOR — the top row of a glyph grazing a 1px top-light,
 *         a moving meter edge. Measured on the status bar and the pattern
 *         chip, both of which read perfectly well.
 *   18 %  the smallest REAL defect — the dock tab label, 23 of its 125 text
 *         pixels on a 2.03:1 surface.
 *   100 % the 8px row index, entirely on a 4.45:1 surface.
 */
export const MAX_BELOW_FLOOR_SHARE = 0.1;

/**
 * Check one contrast expectation against one reading.
 *
 * PURE — no DOM, no browser, like `evaluateExpectation`. The gate and the
 * panel both call this, so they cannot reach different verdicts from the same
 * reading.
 *
 * TWO checks, and both have to hold:
 *
 *   1. The STATIC reading, where the background is a solid colour. This is
 *      the check the Diagnostics panel can make on its own, so it is made
 *      here too — a rule the panel cannot check is a rule that is only half
 *      enforced.
 *   2. The PIXEL reading, where there is one. It is the real surface under
 *      the glyphs, gradient included, and it is judged on the SHARE of the
 *      text below the floor rather than on the worst pixel.
 */
export function evaluateContrast(
  expectation: ContrastExpectation,
  reading: StateReading | undefined,
  state: string,
): ContrastResult {
  const base = { role: expectation.role, state, because: expectation.because };
  if (!reading) {
    return { ...base, ok: false, measured: null, source: "none", failures: ["the role was not read at all"] };
  }
  const failures: string[] = [];

  // 1. The static reading — the composited background, where it is solid.
  if (reading.contrast !== null && reading.contrast < expectation.min) {
    failures.push(`static ${reading.contrast}:1 measured, ${expectation.min}:1 required`);
  }

  // 2. The pixel reading — the real surface under the glyphs.
  const pixel = reading.pixelContrast;
  if (pixel && pixel.minContrast !== null) {
    // 2a. The DOMINANT surface — the one the text is read against.
    if (pixel.dominantContrast !== null && pixel.dominantContrast < expectation.min) {
      failures.push(
        `the dominant surface reads ${pixel.dominantContrast}:1, ${expectation.min}:1 required ` +
          `(${pixel.dominantPixels} of ${pixel.textPixels} pixels on ${pixel.dominantBackground})`,
      );
    }
    // 2b. The SHARE — no tenth of the text may be illegible.
    if (pixel.belowFloorShare > MAX_BELOW_FLOOR_SHARE) {
      failures.push(
        `${Math.round(pixel.belowFloorShare * 1000) / 10}% of the text is below ${expectation.min}:1 ` +
          `(worst ${pixel.minContrast}:1 on ${pixel.worstBackground})`,
      );
    }
  } else if (reading.contrast === null) {
    return {
      ...base,
      ok: false,
      measured: null,
      source: "none",
      failures: ["the contrast could not be measured — the surface under this text is unknown"],
    };
  }

  const measured = pixel?.dominantContrast ?? pixel?.minContrast ?? reading.contrast;
  const source: ContrastResult["source"] =
    pixel?.minContrast != null ? "pixel" : reading.contrast !== null ? "static" : "none";
  return { ...base, ok: failures.length === 0, measured, source, failures };
}
