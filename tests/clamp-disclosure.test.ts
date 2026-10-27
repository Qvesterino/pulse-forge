/**
 * F-12 — the disclosure of a value the domain had to change.
 *
 * The doctrine: a value the user (or an agent) set is either honoured, or the
 * change is disclosed. Before this wave, a command whose label said "Set PRISM
 * Cutoff" could write a different value than the one that was asked for, and
 * nothing said so — the toast carried the label only.
 *
 * Two producers, one channel:
 *
 * - the COMMAND layer, which knows both the requested value and the range it
 *   had to land in (`Command.clamps`), and
 * - the NORMALISER, whose repairs the store reads from the document it holds
 *   on both sides of `normalizeProject` (`src/store/clampRepairs.ts`).
 *
 * Both land in `Command.detail` — the mechanism the toast already renders.
 */
import { describe, expect, it } from "vitest";
import { EFFECT_META, clampEffectParam } from "../src/effects/definitions";
import { INSTRUMENT_META } from "../src/instruments/definitions";
import { createDefaultProject } from "../src/project-model/schema";
import { addEffect, createInstrumentTrack } from "../src/commands/tracks";
import { setEffectParam } from "../src/commands/effectParams";
import { setInstrumentParam } from "../src/commands/instrument";
import { setMasterConfig } from "../src/commands/master";
import { addAutomationLane, addAutomationPoint } from "../src/commands/automation";
import { ProjectStore } from "../src/store/ProjectStore";
import { type ClampEvent } from "../src/shared/clamp-report";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";

/** A project with one instrument track carrying one EQ instance. */
function fixture() {
  const base = createDefaultProject();
  const withTrack = createInstrumentTrack(base, "kopa").execute(base);
  const track = withTrack.tracks.find(
    (candidate) => candidate.kind === "instrument" && candidate.instrument === "kopa",
  )!;
  const withFx = addEffect(withTrack, track.id, "eq").execute(withTrack);
  const fx = withFx.tracks.find((candidate) => candidate.id === track.id)!.effects[0]!;
  const def = EFFECT_META.eq.params.find((param) => param.min < param.max && param.kind !== "toggle")!;
  return { doc: withFx, trackId: track.id, trackName: track.name, fxId: fx.id, def };
}

describe("F-12 — a clamped value is disclosed", () => {
  it("the clamp helper reports what it changed — and stays silent for a legal value", () => {
    const events: ClampEvent[] = [];
    const def = EFFECT_META.eq.params.find((param) => param.min < param.max && param.kind !== "toggle")!;
    const applied = clampEffectParam("eq", def.id, def.max + 1000, (event) => events.push(event));

    expect(applied).toBe(def.max);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "value",
      target: `effect:eq.${def.id}`,
      requested: def.max + 1000,
      applied: def.max,
      min: def.min,
      max: def.max,
    });

    const legal: ClampEvent[] = [];
    clampEffectParam("eq", def.id, (def.min + def.max) / 2, (event) => legal.push(event));
    expect(legal).toHaveLength(0);
  });

  it("an out-of-range parameter write carries the disclosure on the command", () => {
    const { doc, trackId, fxId, def } = fixture();
    const command = setEffectParam(doc, trackId, fxId, def.id, def.max + 999);

    expect(command.clamps).toHaveLength(1);
    expect(command.clamps![0]).toMatchObject({
      kind: "value",
      requested: def.max + 999,
      applied: def.max,
    });
  });

  it("the store folds the disclosure into the toast detail — and a legal write stays silent", () => {
    const { doc, trackId, fxId, def } = fixture();
    const store = new ProjectStore(doc);

    store.execute(setEffectParam(store.doc, trackId, fxId, def.id, def.max + 999));
    const detail = store.lastCommandDetail;
    expect(detail).toContain("clamped");
    expect(detail).toContain(String(def.max + 999));
    expect(detail).toContain(String(def.max));

    // A legal write is not an event: the toast must stay quiet.
    store.execute(setEffectParam(store.doc, trackId, fxId, def.id, def.min));
    expect(store.lastCommandDetail).toBeNull();
  });

  it("the normaliser's footprint on a command is disclosed (the master family clamps there)", () => {
    const { doc } = fixture();
    const store = new ProjectStore(doc);

    // setMasterConfig does NOT clamp — normalizeProject does, after the apply.
    store.execute(setMasterConfig(store.doc, { limiterLookaheadMs: 999 }));

    const detail = store.lastCommandDetail;
    expect(detail).toContain("limiter lookahead");
    expect(detail).toContain("999");
    expect(detail).toContain("20");
  });

  it("a legal master write leaves no footprint and no disclosure", () => {
    const { doc } = fixture();
    const store = new ProjectStore(doc);

    store.execute(setMasterConfig(store.doc, { limiterLookaheadMs: 8 }));
    expect(store.lastCommandDetail).toBeNull();
  });

  it("the instrument path discloses, and the value that lands is the clamped one", () => {
    const { doc, trackId } = fixture();
    const store = new ProjectStore(doc);
    const param = INSTRUMENT_META.kopa.params.find((candidate) => candidate.min < candidate.max)!;

    store.execute(setInstrumentParam(store.doc, trackId, param.id, param.max + 999));
    const detail = store.lastCommandDetail;
    expect(detail).toContain("clamped");
    expect(detail).toContain(String(param.max + 999));
    expect(detail).toContain(String(param.max));

    // The disclosure is not decoration: the clamped value is what landed.
    const landed = store.doc.tracks.find((candidate) => candidate.id === trackId);
    expect(landed?.kind).toBe("instrument");
    if (landed?.kind !== "instrument") throw new Error("expected an instrument track");
    expect(landed.params[param.id]).toBe(param.max);
  });

  it("the automation path discloses and names the parameter it moved", () => {
    const { doc, trackId, trackName } = fixture();
    const store = new ProjectStore(doc);

    const lane = addAutomationLane(store.doc, { kind: "trackGain", trackId });
    store.execute(lane);
    const laneId = store.doc.automation[store.doc.automation.length - 1]!.id;

    store.execute(addAutomationPoint(store.doc, laneId, 960, 99));

    const detail = store.lastCommandDetail;
    expect(detail).toContain("clamped");
    expect(detail).toContain("99");
    expect(detail).toContain("1.5");
    expect(detail).toContain(trackName);
  });

  it("the MCP answer states the clamp, so the agent learns what LANDED", async () => {
    const base = createDefaultProject();
    const withTrack = createInstrumentTrack(base, "kopa").execute(base);
    const track = withTrack.tracks.find(
      (candidate) => candidate.kind === "instrument" && candidate.instrument === "kopa",
    )!;
    const withFx = addEffect(withTrack, track.id, "zenit").execute(withTrack);
    const host = createHeadlessMcpHost({ document: withFx });

    const result = await host.call("kyx_master", { op: "trim", trackId: track.id, trimDb: 999 });

    expect(result.isError).not.toBe(true);
    expect(result.mutated).toBe(true);
    // The disclosure names the parameter and both values.
    expect(result.text).toContain("clamped");
    expect(result.text).toContain("999");
    expect(result.text).toContain("12");
  });
});
