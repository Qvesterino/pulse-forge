import { describe, expect, it } from "vitest";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { addAutomationLane, addAutomationRamp } from "../src/commands/automation";
import { addEffectToTracks } from "../src/commands/commands";
import {
  formatAutomationWarning,
  paramAutomationControls,
  type ParamAutomationControl,
} from "../src/intent/param-intent";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * E5 (MUG-02) — the DIRECT param tools must disclose automation masking.
 *
 * The intent layer has disclosed automation-controlled writes since efbdd944
 * ("base value stored; automation still controls the effective value"). The
 * absolute-set tools (kyx_plugin_param, kyx_instrument_param) had the same
 * silent class: a landed base value under a live lane is not the change the
 * ask asked for, and per ADR 0067 the lane outranks the static value while
 * it runs. These specs pin the disclosure on both tools through the real
 * headless host — lane present → disclosure with the lane's identity;
 * lane EMPTY → no disclosure (nothing animates the param); a different param
 * on the same instance → clean; and the exported control scan both tools
 * share with the intent layer.
 */

function docWithAutomatedFx(): { doc: ProjectDocument; trackId: string; fxId: string } {
  const base = testDoc();
  const trackId = base.tracks.find((track) => track.kind === "instrument")!.id;
  const withFx = addEffectToTracks(base, [trackId], "delay").execute(base);
  const track = withFx.tracks.find((candidate) => candidate.id === trackId);
  if (!track || !("effects" in track)) throw new Error("instrument track expected");
  const fxId = track.effects.find((fx) => fx.type === "delay")!.id;
  const doc = addAutomationRamp(withFx, { kind: "fxParam", trackId, fxId, paramId: "mix" }, 0, 0.2, 960, 0.8).execute(
    withFx,
  );
  return { doc, trackId, fxId };
}

describe("direct param tools disclose automation masking (E5)", () => {
  it("kyx_plugin_param set under a live lane names the lane and the sources", async () => {
    const { doc, trackId } = docWithAutomatedFx();
    const host = createHeadlessMcpHost({ document: doc });
    const result = await host.call("kyx_plugin_param", {
      op: "set",
      trackId,
      effect: "delay",
      param: "mix",
      value: 0.5,
    });

    expect(result.isError).not.toBe(true);
    expect(result.text).toContain("base value stored");
    expect(result.text).toContain("automation still controls the effective value");
    expect(result.text).toContain("edit a lane with kyx_automation");
    const data = result.data as {
      automationControlled?: boolean;
      automation?: Array<ParamAutomationControl>;
    };
    expect(data.automationControlled).toBe(true);
    expect(data.automation?.[0]?.source).toBe("project lane");
    expect(data.automation?.[0]?.paramId).toBe("mix");
    expect(data.automation?.[0]?.trackName).toBe(doc.tracks.find((t) => t.id === trackId)?.name);
  });

  it("an EMPTY lane animates nothing — the set lands without disclosure", async () => {
    const base = testDoc();
    const trackId = base.tracks.find((track) => track.kind === "instrument")!.id;
    const withFx = addEffectToTracks(base, [trackId], "delay").execute(base);
    const track = withFx.tracks.find((candidate) => candidate.id === trackId);
    if (!track || !("effects" in track)) throw new Error("instrument track expected");
    const fxId = track.effects.find((fx) => fx.type === "delay")!.id;
    const doc = addAutomationLane(withFx, { kind: "fxParam", trackId, fxId, paramId: "mix" }).execute(withFx);

    const host = createHeadlessMcpHost({ document: doc });
    const result = await host.call("kyx_plugin_param", {
      op: "set",
      trackId,
      effect: "delay",
      param: "mix",
      value: 0.5,
    });

    expect(result.isError).not.toBe(true);
    expect(result.text).not.toContain("automation still controls");
    expect((result.data as { automationControlled?: boolean }).automationControlled).toBeUndefined();
  });

  it("a different param on the SAME instance stays clean", async () => {
    const { doc, trackId } = docWithAutomatedFx();
    const host = createHeadlessMcpHost({ document: doc });
    const result = await host.call("kyx_plugin_param", {
      op: "set",
      trackId,
      effect: "delay",
      param: "feedback",
      value: 0.5,
    });

    expect(result.isError).not.toBe(true);
    expect(result.text).not.toContain("automation still controls");
  });

  it("kyx_instrument_param under an instParam lane discloses with the instrument family", async () => {
    const base = testDoc();
    const trackId = base.tracks.find((track) => track.kind === "instrument")!.id;
    const host = createHeadlessMcpHost({ document: base });

    // Discover a settable param through the tool's OWN list contract instead
    // of hard-coding an instrument's knob names.
    const listed = await host.call("kyx_instrument_param", { trackId, op: "list" });
    expect(listed.isError).not.toBe(true);
    const params = (
      listed.data as {
        parameters?: Array<{ id: string; min: number; max: number; default: number; step?: number | null }>;
      }
    ).parameters;
    const param = params?.find((candidate) => candidate.max > candidate.min);
    expect(param).toBeTruthy();
    if (!param) return;

    const withRamp = addAutomationRamp(
      base,
      { kind: "instParam", trackId, paramId: param.id },
      0,
      param.min + (param.max - param.min) * 0.25,
      960,
      param.min + (param.max - param.min) * 0.75,
    ).execute(base);
    const maskedHost = createHeadlessMcpHost({ document: withRamp });

    const track = withRamp.tracks.find((candidate) => candidate.id === trackId);
    if (track?.kind !== "instrument") throw new Error("instrument track expected");
    const current = track.params[param.id] ?? param.default;
    const span = param.max - param.min;
    const step = typeof param.step === "number" && param.step > 0 ? param.step : span / 10;
    let value = current + step * 3;
    if (value > param.max) value = current - step * 3;

    const result = await maskedHost.call("kyx_instrument_param", { trackId, op: "set", param: param.id, value });
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain("automation still controls the effective value");
    const data = result.data as { automationControlled?: boolean; automation?: Array<ParamAutomationControl> };
    expect(data.automationControlled).toBe(true);
    expect(data.automation?.[0]?.effectType).toBe("instrument");
    expect(data.automation?.[0]?.paramId).toBe(param.id);
  });

  it("the exported control scan and warning sentence match the intent layer's story", () => {
    const { doc, trackId, fxId } = docWithAutomatedFx();
    const controls = paramAutomationControls(
      doc,
      { kind: "fxParam", trackId, fxId, paramId: "mix" },
      "Bass",
      "delay",
      "mix",
    );
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({ source: "project lane", paramId: "mix", trackName: "Bass" });

    const warning = formatAutomationWarning(controls, (value) => String(Math.round(value * 100) / 100));
    expect(warning).toContain("automation controls the effective value");
    expect(warning).toContain("edit a lane with kyx_automation");
    expect(formatAutomationWarning([], (value) => String(value))).toBeUndefined();
  });
});
