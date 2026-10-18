import { describe, expect, it } from "vitest";
import { executeMcpTool, type McpFxMeterSnapshot, type McpToolContext } from "../src/mcp/tools";
import { mcpFxMetersFromServices } from "../src/mcp/meters";
import { createDefaultProject } from "../src/project-model/schema";
import { MASTER_EFFECT_OWNER_ID } from "../src/project-model/types";
import type { Services } from "../src/services";

/**
 * kyx_meter scope:"fx" — the closed loop for an EFFECT change.
 *
 * After an agent applies KOREŇ it must be able to READ what the effect did
 * (tracked f0, +dB harmonics, key scaler) instead of assuming. These specs pin:
 * the tool renders known telemetry by name, unknown frames as bounded
 * scalars, a bypassed/degraded insert as "no telemetry" (never a fake zero),
 * and an honest refusal when no live engine exists. The helper is pinned too:
 * it walks tracks, returns AND the master chain, and it degrades one broken
 * runtime without blinding the rest.
 */

function makeCtx(fxMeters?: () => McpFxMeterSnapshot | null): McpToolContext {
  const doc = createDefaultProject();
  return {
    getDoc: () => doc,
    execute: () => undefined,
    undo: () => undefined,
    redo: () => undefined,
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play() {}, stop() {}, pause() {}, setLoop() {}, setMetronome() {} },
    ...(fxMeters ? { fxMeters } : {}),
  };
}

function snapshot(): McpFxMeterSnapshot {
  return {
    effects: [
      {
        ownerId: "track-1",
        ownerName: "Bass",
        fxId: "fx-grow",
        type: "bassHarmonic",
        name: "GROW",
        bypassed: false,
        meters: {
          type: "koren",
          f0: 54.94,
          clarity: 0.93,
          harm: 12.4,
          key: 1.42,
          hint: 1,
          partials: new Float32Array(15),
        },
      },
      {
        ownerId: "track-2",
        ownerName: "Drums",
        fxId: "fx-zenit",
        type: "limiter",
        name: "ZENIT",
        bypassed: false,
        meters: null,
        gainReduction: [
          { label: "Transient", gainReductionDb: 2.4 },
          { label: "Release", gainReductionDb: 1.1 },
        ],
      },
      {
        ownerId: "return-1",
        ownerName: "Reverb",
        fxId: "fx-drift",
        type: "ozvena",
        name: "DRIFT",
        bypassed: true,
        meters: null,
      },
      {
        ownerId: MASTER_EFFECT_OWNER_ID,
        ownerName: "master",
        fxId: "fx-prism",
        type: "fxeq",
        name: "PRISM",
        bypassed: false,
        meters: { bandPeaks: new Float32Array(16), gainReductionDb: 0.6 },
      },
    ],
  };
}

describe("kyx_meter scope:fx — the effect closed loop", () => {
  it("renders KOREŇ's telemetry by name (f0, clarity, harmonics, key, hint)", async () => {
    const result = await executeMcpTool(makeCtx(snapshot), "kyx_meter", { scope: "fx" });
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain("Bass / GROW (bassHarmonic, id=fx-grow)");
    expect(result.text).toContain("f0 54.9 Hz");
    expect(result.text).toContain("clarity 0.93");
    expect(result.text).toContain("+12.4 dB harmonics");
    expect(result.text).toContain("key ×1.42");
    expect(result.text).toContain("HINT");
    // The machine-readable snapshot rides along for in-process consumers.
    expect((result.data as McpFxMeterSnapshot).effects).toHaveLength(4);
  });

  it("reports dynamics gain reduction, bypass honestly, and generic frames as bounded scalars", async () => {
    const result = await executeMcpTool(makeCtx(snapshot), "kyx_meter", { scope: "fx" });
    // ZENIT: the composite dynamics readings, not a fake single number.
    expect(result.text).toContain("Transient 2.4 dB / Release 1.1 dB");
    // A bypassed insert with no runtime says so instead of printing zeros.
    expect(result.text).toContain("Reverb / DRIFT (ozvena, id=fx-drift) · BYPASSED: no telemetry");
    // PRISM's frame is unknown to this renderer, so it prints scalars/lengths.
    expect(result.text).toMatch(/master \/ PRISM \(fxeq, id=fx-prism\): .*gainReductionDb 0\.6/);
    expect(result.text).toContain("bandPeaks[16]");
  });

  it("never crashes on hostile frames and never invents meaning", async () => {
    const hostile: McpFxMeterSnapshot = {
      effects: [
        {
          ownerId: "t",
          ownerName: "T",
          fxId: "f",
          type: "rezonans",
          name: "REZONANS",
          bypassed: false,
          // NaN / Infinity / functions / a huge string must all be skipped.
          meters: { f0: Number.NaN, clarity: Number.POSITIVE_INFINITY, fn: () => 1, big: "x".repeat(5000), ok: 3 },
        },
      ],
    };
    const result = await executeMcpTool(
      makeCtx(() => hostile),
      "kyx_meter",
      { scope: "fx" },
    );
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain("ok 3");
    expect(result.text).not.toContain("NaN");
    expect(result.text).not.toContain("Infinity");
    expect(result.text.length).toBeLessThan(600);
  });

  it("refuses honestly without a live engine hook or context", async () => {
    const noHook = await executeMcpTool(makeCtx(), "kyx_meter", { scope: "fx" });
    expect(noHook.isError).toBe(true);
    expect(noHook.text).toContain("not available over this MCP transport");

    const noEngine = await executeMcpTool(
      makeCtx(() => null),
      "kyx_meter",
      { scope: "fx" },
    );
    expect(noEngine.isError).toBe(true);
    expect(noEngine.text).toContain("engine is not running");
  });

  it("says so when nothing is inserted", async () => {
    const result = await executeMcpTool(
      makeCtx(() => ({ effects: [] })),
      "kyx_meter",
      { scope: "fx" },
    );
    expect(result.text).toContain("no effects inserted");
  });
});

describe("mcpFxMetersFromServices — walks every insert host", () => {
  function servicesWith(engine: Record<string, unknown>): Services {
    const doc = createDefaultProject();
    const fx = (id: string, type: string) => ({ id, type, params: {}, bypassed: false });
    doc.tracks[0]!.effects = [fx("fx-track", "bassHarmonic") as never];
    doc.returns = [{ id: "ret-1", kind: "return", name: "Verb", gain: 1, effects: [fx("fx-ret", "ozvena") as never] }];
    doc.master.effects = [fx("fx-master", "fxeq") as never];
    return { store: { getDoc: () => doc }, engine } as unknown as Services;
  }

  it("reads track, return and master inserts (master owner id is `master`)", () => {
    const calls: string[] = [];
    const services = servicesWith({
      getLiveAudioContext: () => ({}),
      getFxMeters: (trackId: string, fxId: string) => {
        calls.push(`${trackId}:${fxId}`);
        return fxId === "fx-track" ? { f0: 55, harm: 9 } : null;
      },
      getFxGainReductionBreakdown: () => null,
    });
    const snapshot = mcpFxMetersFromServices(services)!;
    const doc = services.store.getDoc();
    expect(snapshot.effects.map((effect) => `${effect.ownerId}:${effect.fxId}`)).toEqual([
      `${doc.tracks[0]!.id}:fx-track`,
      "ret-1:fx-ret",
      `${MASTER_EFFECT_OWNER_ID}:fx-master`,
    ]);
    expect(snapshot.effects[0]!.name).toBe("GROW");
    expect(calls).toHaveLength(3);
  });

  it("degrades ONE throwing runtime without blinding the rest", () => {
    const services = servicesWith({
      getLiveAudioContext: () => ({}),
      getFxMeters: (_trackId: string, fxId: string) => {
        if (fxId === "fx-track") throw new Error("runtime disposed");
        return fxId === "fx-master" ? { bandPeaks: new Float32Array(4), gainReductionDb: 0 } : null;
      },
      getFxGainReductionBreakdown: () => null,
    });
    const snapshot = mcpFxMetersFromServices(services)!;
    expect(snapshot.effects).toHaveLength(3);
    expect(snapshot.effects[0]!.meters).toBeNull();
    expect(snapshot.effects[2]!.meters).not.toBeNull();
  });

  it("returns null without a live audio context (honest refusal)", () => {
    expect(mcpFxMetersFromServices(servicesWith({ getLiveAudioContext: () => null }))).toBeNull();
  });
});
