import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R-05 — the intent bar's failure surface is UNIFORM: every applier call
 * site lives inside `routeAndExecute`'s dispatch, whose boundary catch
 * surfaces ANY applier throw through `setError`. No branch can be a silent
 * no-op: the click handler cannot lose an error, whatever branch throws.
 *
 * The per-branch try/catch blocks (the D1 fix era) are belt; the boundary
 * catch is braces. This guard pins the braces: a refactor that moves the
 * dispatch, drops the boundary catch, or adds an applier OUTSIDE the
 * boundary fails here — proven by an in-spec mutation (the guard's own
 * detection is run against the file with the boundary removed and must go
 * red), so the guard cannot pass vacuously.
 */

const FILE = join(process.cwd(), "src", "ui", "IntentPanel.tsx");

interface BoundaryCheck {
  ok: boolean;
  reason: string;
}

function checkBoundary(text: string): BoundaryCheck {
  const start = text.indexOf("const routeAndExecute = async");
  if (start < 0) return { ok: false, reason: "routeAndExecute not found" };
  const finMarker = "} finally {\n      setRouteBusy(false);";
  const fin = text.indexOf(finMarker, start);
  if (fin < 0) return { ok: false, reason: "the dispatch finally (setRouteBusy(false)) not found" };
  const catchIdx = text.lastIndexOf("} catch (err) {", fin);
  if (catchIdx < start) return { ok: false, reason: "no boundary catch before the dispatch finally" };
  if (!text.slice(catchIdx, fin).includes("setError(")) {
    return { ok: false, reason: "the boundary catch does not surface through setError" };
  }
  const dispatch = text.slice(start, catchIdx);
  if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(dispatch)) {
    return { ok: false, reason: "an empty catch block swallows inside the dispatch" };
  }
  const appliersInside = new Set(dispatch.match(/apply[A-Z][a-zA-Z]*Intent\(/g) ?? []);
  if (appliersInside.size === 0) return { ok: false, reason: "no applier call sites inside the dispatch" };
  const outside = (text.slice(0, start) + text.slice(fin)).match(/apply[A-Z][a-zA-Z]*Intent\(/g) ?? [];
  // The GENERATE flow applies the artist-mix profile outside the route
  // dispatch on purpose (applyGenerationResult + applyMixIntent fold into one
  // undo frame inside generate()) — that path is not the intent bar.
  const allowedOutside = new Set(["applyMixIntent("]);
  const strangers = outside.filter((site) => !allowedOutside.has(site));
  if (strangers.length > 0) {
    return { ok: false, reason: `applier(s) outside the boundary catch: ${[...new Set(strangers)].join(", ")}` };
  }
  return { ok: true, reason: "" };
}

describe("the intent bar's failure surface is uniform", () => {
  it("the dispatch boundary catch surfaces every applier throw through setError", () => {
    const text = readFileSync(FILE, "utf-8");
    const result = checkBoundary(text);
    expect(result.ok, result.reason).toBe(true);
  });

  it("teeth: with the boundary catch removed, the same detection goes red", () => {
    const text = readFileSync(FILE, "utf-8");
    const start = text.indexOf("const routeAndExecute = async");
    const finMarker = "} finally {\n      setRouteBusy(false);";
    const fin = text.indexOf(finMarker, start);
    const catchIdx = text.lastIndexOf("} catch (err) {", fin);
    expect(catchIdx).toBeGreaterThan(start);
    // Mutate: replace the boundary catch with a silent swallow — the exact
    // regression the guard exists to catch.
    const mutated = text.slice(0, catchIdx) + "} catch (err) {\n      // swallowed\n" + text.slice(fin);
    const result = checkBoundary(mutated);
    expect(result.ok, "the guard MUST fail when the boundary stops surfacing").toBe(false);
  });
});
