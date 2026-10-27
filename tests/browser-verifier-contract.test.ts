import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * BROWSER VERIFIER CONTRACT (F-15 / F-16)
 *
 * `scripts/verify-browser.mjs` drives the real app in a real browser. That
 * only means something while it drives the UI **that exists**, and only while
 * the budget it waits with covers what it is waiting FOR. Two defects of that
 * kind were measured on this machine (2026-10-27, isolated worktree at HEAD):
 *
 *   - **F-15** — the add-effect step selected `.devices-add-effect`, a
 *     `<select>` the React tree no longer has. The plugin workflow it protects
 *     was therefore unverified in a real browser.
 *   - **F-16** — the app-boot step waited 5 s for the preset browser, but the
 *     PRESETS view is a `React.lazy` chunk: the wait had to cover a module
 *     boundary, not a network hiccup.
 *
 * F-16 turned out to be only HALF closed. The preset browser got its 15 s
 * budget; the other lazy panels kept the 5 s one — and the measurement caught
 * two of them: the app-boot flow's `.master-meter` (the Mixer is lazy) and
 * the plugin workflow's `.fx-device` (the EffectRack is lazy). Both failed
 * for the same reason the preset browser had failed, and both were reported
 * as "UI did not mount", which reads like a boot regression and is not one.
 *
 * Nothing connected the verifier to the React tree, so nothing stopped the
 * two from drifting apart again — and a verifier that silently measures a
 * vanished UI is worse than no verifier, because it reads as a product
 * failure.
 *
 * These are the teeth: they read BOTH sides — the script and the React
 * sources — so a selector that only exists in the script, or only in the
 * tree, is a red gate instead of a mystery.
 *
 * Falsified by reverting either repair in a scratch copy of the verifier:
 * the dead `<select>`, the 5 s lazy budget and the catch-all "UI did not
 * mount" message each turn this file red.
 */

const ROOT = resolve(__dirname, "..");
const VERIFIER = join(ROOT, "scripts", "verify-browser.mjs");

/** The class names the add-effect flow drives, and the dead one it must not. */
const ADD_EFFECT_SELECTORS = ["fx-add-trigger", "fx-add-popover", "fx-add-device"];
const DEAD_SELECTOR = "devices-add-effect";

/** The view the app-boot flow opens, and the lazy chunk it waits for. */
const PRESETS_VIEW = "PRESETS";
const PRESET_BROWSER = "preset-browser";

/** The floor a lazy-panel budget has to clear (the F-16 repair set 15 s). */
const LAZY_BUDGET_FLOOR_MS = 15_000;

/**
 * The waits that sit on a `React.lazy` boundary, and the component that owns
 * each one. The ownership is what makes the list a FACT and not a guess:
 *
 *   .master-meter / .master-headroom → MasterMeter.tsx → Mixer.tsx        (lazy)
 *   .export-panel                    → ExportPanel.tsx → App.tsx         (lazy)
 *   .sample-browser / .sample-fav    → SampleBrowser.tsx → BrowserStrip   (lazy)
 *   .preset-browser / .preset-fav    → PresetBrowser.tsx → SampleBrowser   (lazy)
 *   .arr-ruler                       → ArrangementPanel.tsx → App.tsx     (lazy)
 *   .devices-panel                   → EffectRack.tsx → App.tsx           (lazy)
 *   .fx-add-popover                  → FxAddPopover.tsx → EffectRack.tsx  (lazy)
 *   .fx-device                       → EffectRack.tsx → App.tsx           (lazy)
 *   .macro-card                      → ModPanel.tsx → App.tsx              (lazy)
 *
 * The EAGER controls (PatternBar, GenerateDialog, SceneLauncher, the
 * Sequencer's step editor) keep the 5 s window: a budget that covers a
 * module boundary is right for a lazy chunk and waste for a mounted element.
 */
const LAZY_WAIT_SELECTORS = [
  ".master-meter",
  ".master-headroom",
  '.export-panel[aria-label="Export"]',
  ".sample-browser",
  ".sample-fav",
  ".preset-browser",
  ".preset-fav",
  ".arr-ruler",
  ".devices-panel",
  ".fx-add-popover",
  ".fx-device",
  ".macro-card",
];

const readVerifier = (): string => readFileSync(VERIFIER, "utf8");

/**
 * The code the verifier actually executes — comments removed.
 *
 * The dead selector is NAMED in a comment (the note that says why the flow
 * changed), and a comment is not a call. Asserting on the raw source would
 * flag the explanation as the defect.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** Every source file of the React tree the verifier drives. */
function uiSourceText(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) parts.push(readFileSync(path, "utf8"));
    }
  };
  walk(join(ROOT, "src", "ui"));
  return parts.join("\n");
}

/** The timeout argument of every `waitForSelector` for one exact selector. */
function timeoutsFor(source: string, selector: string): string[] {
  const found: string[] = [];
  for (const quote of ['"', "'"]) {
    const needle = `waitForSelector(${quote}${selector}${quote}`;
    let index = source.indexOf(needle);
    while (index !== -1) {
      const rest = source.slice(index, index + 240);
      const match = rest.match(/timeout:\s*([^,}\s]+)/);
      found.push(match ? match[1] : "NONE");
      index = source.indexOf(needle, index + 1);
    }
  }
  return found;
}

describe("browser verifier contract", () => {
  it("the add-effect flow drives the live popover", () => {
    const verifier = readVerifier();
    for (const selector of ADD_EFFECT_SELECTORS) {
      expect(verifier, `the verifier must drive .${selector}`).toContain(`.${selector}`);
    }
  });

  it("the add-effect flow does not drive the dead <select> again", () => {
    // Naming the dead selector in a comment is how the removal is explained.
    // SELECTING it is how the gate broke. Only the second one is the defect.
    expect(stripComments(readVerifier())).not.toContain(DEAD_SELECTOR);
  });

  it("the dead <select> is gone from the React tree too", () => {
    // Both sides have to agree: the UI dropped the control, so the verifier
    // must have found another way in.
    expect(uiSourceText()).not.toContain(DEAD_SELECTOR);
  });

  it("every selector the add-effect flow drives exists in the React tree", () => {
    const ui = uiSourceText();
    for (const selector of ADD_EFFECT_SELECTORS) {
      expect(ui, `.${selector} must exist in src/ui — the verifier drives the real tree`).toContain(selector);
    }
  });

  it("the app-boot flow opens the PRESETS view of the browser strip", () => {
    const verifier = readVerifier();
    // The views are explicit tabs; nothing auto-switches to PRESETS when a
    // track is selected, so the flow has to click the tab itself.
    expect(verifier).toMatch(new RegExp(`aria-pressed[^\\n]*${PRESETS_VIEW}`));
    expect(uiSourceText()).toContain(PRESET_BROWSER);
  });

  it("the lazy-panel budget clears the module boundary", () => {
    const verifier = readVerifier();
    const match = verifier.match(/const LAZY_PANEL_TIMEOUT_MS = ([0-9_]+);/);
    expect(match, "the verifier needs ONE owner for the lazy-panel budget").not.toBeNull();
    expect(Number(match![1].replace(/_/g, ""))).toBeGreaterThanOrEqual(LAZY_BUDGET_FLOOR_MS);
  });

  it("every lazy-panel wait uses that budget", () => {
    const code = stripComments(readVerifier());
    for (const selector of LAZY_WAIT_SELECTORS) {
      const timeouts = timeoutsFor(code, selector);
      expect(timeouts.length, `the verifier must wait for ${selector}`).toBeGreaterThan(0);
      for (const timeout of timeouts) {
        expect(
          timeout,
          `${selector} sits on a React.lazy boundary — a 5 s budget measures the network, not the app`,
        ).toBe("LAZY_PANEL_TIMEOUT_MS");
      }
    }
  });

  it("the gates name the step that failed", () => {
    const code = stripComments(readVerifier());
    // Every app-boot failure used to be reported as "UI did not mount", which
    // is what a lazy-chunk timeout READ like. The app was mounted; the panel
    // was not. A gate that names its step says what actually failed.
    expect(code).not.toContain("UI did not mount");
    expect(code).toMatch(/bootStep/);
    expect(code).toMatch(/pluginStep/);
  });
});
