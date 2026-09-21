/**
 * DiceContext source-grep regression — pins the dice-tray public surface
 * (provider, hook, value shape, App-level integration) so a careless
 * refactor that drops one of them shows up in CI rather than at runtime.
 *
 * Pattern: read each source file once and assert textual presence of the
 * critical call lines. Same hardening pattern as tests/audio-engine-lifecycle.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DICE_CTX_PATH = resolve(process.cwd(), "src/ui/DiceContext.tsx");
const APP_PATH = resolve(process.cwd(), "src/ui/App.tsx");

function readDiceCtx(): string {
  return readFileSync(DICE_CTX_PATH, "utf8");
}

function readApp(): string {
  return readFileSync(APP_PATH, "utf8");
}

describe("DiceContext — provider / hook public surface", () => {
  it("exports useDice() that throws when used outside a DiceProvider", () => {
    // The hook must guard against a missing provider — a missing guard would
    // silently return null/undefined and crash downstream on `.session.x`.
    const source = readDiceCtx();
    expect(source).toMatch(/export\s+function\s+useDice\s*\(/);
    expect(source).toMatch(
      /if\s*\(\s*!ctx\s*\)\s*throw\s+new\s+Error\s*\(\s*["']DiceContext not initialized/i,
    );
  });

  it("exports a DiceProvider that accepts { doc, active, children }", () => {
    // The Provider's prop shape is the wiring contract — App.tsx depends on
    // it. A regression that drops or renames any prop would silently break
    // the dice tray with a TS-only error at the App.tsx call site.
    const source = readDiceCtx();
    expect(source).toMatch(/export\s+function\s+DiceProvider\s*\(/);
    expect(source).toMatch(/\bdoc:\s*ProjectDocument\b/);
    expect(source).toMatch(/\bactive\?\s*:\s*boolean\b/);
    expect(source).toMatch(/\bchildren:\s*React\.ReactNode\b/);
  });

  it("initialises the session through normalizeIntent → createDiceSession", () => {
    // Pin that the session starts from a normalized intent — bypassing the
    // normalizer would let a malformed seed reach the generator and
    // produce a non-reproducible first roll.
    const source = readDiceCtx();
    expect(source).toMatch(/useState/);
    expect(source).toMatch(/normalizeIntent\s*\(/);
    expect(source).toMatch(/createDiceSession\s*\(/);
  });

  it("exposes all critical session-mutation methods on the context value", () => {
    // Every method called from DicePanel.tsx must remain on the value
    // shape. A regression that drops one (e.g. rollFull, jump, apply)
    // would surface as "is not a function" at runtime.
    const source = readDiceCtx();
    for (const method of [
      "rollFull",
      "rollVary",
      "jump",
      "apply",
      "setMode",
      "setSeed",
      "setLength",
      "setEnergy",
      "setDensity",
      "toggleLockKey",
      "setGenre",
      "setStyle",
    ]) {
      expect(
        source,
        `DiceContextValue must expose ${method}() for the dice panel consumers`,
      ).toMatch(new RegExp(`\\b${method}\\s*:`));
    }
  });
});

describe("DiceProvider integration — App.tsx wiring", () => {
  it("App.tsx mounts DiceProvider with doc={doc} (not a stale snapshot)", () => {
    // A regression that passes a stale doc would let the dice tray preview
    // the wrong project after a hot-reload or a project switch.
    const app = readApp();
    expect(app).toMatch(/<DiceProvider[^>]*doc=\{doc\}/);
  });

  it("App.tsx activates the provider only when the dice tray is open", () => {
    // The provider must be ALWAYS mounted (so the dice session survives
    // panel open/close), but only ACTIVATED when the panel is visible —
    // an always-active provider reruns the generator pipeline on every
    // doc edit, which made edits feel frozen.
    const app = readApp();
    expect(app).toMatch(
      /<DiceProvider[^>]*active=\{dock\.slotA\s*===\s*["']dice["']\s*\|\|[\s\S]*?dock\.slotB\s*===\s*["']dice["']\s*\}/,
    );
  });

  it("App.tsx closes the DiceProvider tag with </DiceProvider>", () => {
    // An unclosed JSX tag would silently wrap the whole tree in dice
    // context, breaking performance for unrelated routes.
    const app = readApp();
    expect(app).toMatch(/<\/DiceProvider>/);
  });
});
