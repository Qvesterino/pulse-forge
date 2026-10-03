import { describe, expect, it } from "vitest";
import { scheduleVoiceModMatrix, type ModVoiceOpts } from "../src/instruments/modmatrix";
import { GraphAudioContext } from "./helpers/graphAudioContext";

/**
 * AUDIT 2026-10-03 — why the 2026-09-27 report lists the mod-matrix params as
 * dead on 11 of 22 instruments.
 *
 * `src/plugin-audit-checks.ts` sweeps one parameter at a time with every sibling
 * at its default:
 *
 *     rendered = await render({ ...defaults, [p.id]: value });
 *
 * and calls a parameter "dead" when that render moves the metric by < 2%.
 * For `modASrc` / `modADst` / `modLfoRate` that sweep CANNOT move anything, and
 * not because the parameters are unwired:
 *
 *   `scheduleVoiceModMatrix` allocates the source buses only when a slot has a
 *   non-zero AMOUNT. Both amounts default to 0, so a sweep of `modASrc` alone
 *   returns the dormant stub — the LFO that `modLfoRate` would retune is never
 *   created. The handle's own `setParameter` agrees: it only wakes the graph
 *   when `modAAmt` or `modBAmt` is non-zero.
 *
 * The report therefore attributes 11×3 = 33 "inert parameters" to instruments
 * whose mod matrix is working exactly as designed. This test pins the mechanism
 * structurally, which needs no audio: the number of allocated nodes is the
 * observable.
 */

const OPTS: ModVoiceOpts = {
  when: 0,
  stopTime: 2,
  velocity: 0.9,
  attack: 0.01,
  off: 1,
  release: 0.2,
};

const DEFAULTS = { modASrc: 0, modADst: 0, modAAmt: 0, modBSrc: 0, modBDst: 1, modBAmt: 0, modLfoRate: 0.3 };

function build(params: Record<string, number>) {
  const ctx = new GraphAudioContext();
  const handle = scheduleVoiceModMatrix(ctx as never, { ...DEFAULTS, ...params }, { ...OPTS });
  return { ctx, handle };
}

describe("AUDIT: mod-matrix params are inert by construction while their amounts are 0", () => {
  it("an all-defaults voice allocates only the dormant amp node", () => {
    const { ctx, handle } = build({});
    // The inactive branch: one neutral amp gain, no source buses, no LFO.
    expect(ctx.nodes.map((n) => n.kind)).toEqual(["gain"]);
    expect(handle).not.toBeNull();
  });

  it("sweeping modASrc / modADst / modLfoRate alone allocates nothing and moves nothing", () => {
    // These are exactly the three params the report calls inert on 11 instruments.
    const baseline = build({}).ctx.nodes.length;
    for (const id of ["modASrc", "modADst", "modLfoRate"]) {
      for (const value of [0, 1, 2, 3]) {
        const { ctx, handle } = build({ [id]: value });
        expect(ctx.nodes.length, `${id}=${value} must not build a mod graph`).toBe(baseline);
        // And the live write path refuses to wake it while the amounts are 0.
        expect(() => handle?.setParameter(id, value, 0)).not.toThrow();
        expect(ctx.nodes.length, `${id}=${value} via setParameter must not build a mod graph`).toBe(baseline);
      }
    }
  });

  it("a non-zero amount DOES build the graph — so the params are wired, just unreachable alone", () => {
    const dormant = build({}).ctx.nodes.length;
    const routed = build({ modAAmt: 0.8 });
    expect(routed.ctx.nodes.length).toBeGreaterThan(dormant);
    // Source buses for all four sources, plus the LFO that modLfoRate retunes.
    expect(routed.ctx.nodes.some((n) => n.kind === "oscillator")).toBe(true);
  });

  it("a live amount write on a dormant voice builds the graph (the documented wake path)", () => {
    const { ctx, handle } = build({});
    const dormant = ctx.nodes.length;
    handle?.setParameter("modAAmt", 0.5, 0);
    expect(ctx.nodes.length, "modAAmt alone must wake the dormant voice").toBeGreaterThan(dormant);
  });
});
