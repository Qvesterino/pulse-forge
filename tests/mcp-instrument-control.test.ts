import { describe, expect, it } from "vitest";
import { createInstrumentTrack } from "../src/commands/commands";
import { routeIntentText } from "../src/intent/route";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { MCP_TOOLS } from "../src/mcp/tools";
import { createDefaultProject } from "../src/project-model/schema";
import { INSTRUMENT_DEFS, INSTRUMENT_ORDER } from "../src/instruments/registry";
import type { InstrumentKind } from "../src/project-model/types";
import { applyIntent } from "./helpers/intentProtocol";

function documentWithInstrument(kind: InstrumentKind) {
  const doc = createDefaultProject();
  return createInstrumentTrack(doc, kind).execute(doc);
}

describe("flagship instrument intent and MCP control", () => {
  it("advertises every registered instrument and detailed KOPA/TSAR knob contracts", async () => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "kyx_tracks");
    expect((tool?.inputSchema.properties.instrument as { enum?: string[] }).enum).toEqual(INSTRUMENT_ORDER);
    const paramTool = MCP_TOOLS.find((candidate) => candidate.name === "kyx_instrument_param");
    expect(paramTool?.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining(["status", "trackId", "instrument", "parameters", "change", "undoSteps"]),
    });

    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const inventory = await host.call("kyx_catalog", { subject: "instruments" });
    expect(inventory.isError).not.toBe(true);
    const listed = inventory.data as {
      instruments: Array<{ kind: string; name: string; parameterCount: number }>;
    };
    expect(listed.instruments.map((instrument) => instrument.kind)).toEqual(INSTRUMENT_ORDER);

    for (const kind of ["kopa", "tsar"] as const) {
      const detail = await host.call("kyx_catalog", { subject: "instrument", instrument: kind });
      expect(detail.isError).not.toBe(true);
      expect(detail.text).toContain("kyx_instrument_param");
      const data = detail.data as {
        instrument: { kind: string; name: string; parameterCount: number; parameters: Array<{ id: string }> };
      };
      const expectedParams = INSTRUMENT_DEFS[kind].params.filter((param) => param.deprecated !== true);
      expect(data.instrument.kind).toBe(kind);
      expect(data.instrument.name).toBe(INSTRUMENT_DEFS[kind].name);
      expect(data.instrument.parameterCount).toBe(expectedParams.length);
      expect(data.instrument.parameters.map((param) => param.id)).toEqual(expectedParams.map((param) => param.id));

      const added = await host.call("kyx_tracks", { op: "addInstrument", instrument: kind });
      expect(added.mutated).toBe(true);
      expect(host.store.doc.tracks.at(-1)).toMatchObject({ kind: "instrument", instrument: kind });
    }
  }, 15_000);

  it("routes explicit KOPA and TSAR track creation through deterministic intent", async () => {
    for (const instrument of ["kopa", "tsar"] as const) {
      expect(routeIntentText(`add a ${instrument} track`, createDefaultProject()).kind).toBe("exact");
      const host = createHeadlessMcpHost({ document: createDefaultProject() });
      const result = await applyIntent(host, `add a ${instrument} track`);

      expect(result.isError).not.toBe(true);
      expect(result.mutated).toBe(true);
      expect(host.store.doc.tracks.at(-1)).toMatchObject({ kind: "instrument", instrument });
      host.store.undo();
      expect(
        host.store.doc.tracks.some((track) => track.kind === "instrument" && track.instrument === instrument),
      ).toBe(false);
    }
  });

  it("lists, clamps and undoably sets one exact KOPA/TSAR track parameter", async () => {
    for (const kind of ["kopa", "tsar"] as const) {
      const host = createHeadlessMcpHost({ document: documentWithInstrument(kind) });
      const track = host.store.doc.tracks.find(
        (candidate) => candidate.kind === "instrument" && candidate.instrument === kind,
      );
      expect(track?.kind).toBe("instrument");
      if (track?.kind !== "instrument") throw new Error(`missing ${kind} fixture track`);

      const param = INSTRUMENT_DEFS[kind].params.find(
        (candidate) =>
          candidate.deprecated !== true &&
          candidate.options == null &&
          candidate.step == null &&
          candidate.max > candidate.min,
      );
      expect(param).toBeDefined();
      if (param == null) throw new Error(`${kind} has no continuous parameter fixture`);
      const beforeValue = track.params[param.id] ?? param.default;

      const listed = await host.call("kyx_instrument_param", { op: "list", trackId: track.id });
      expect(listed).toMatchObject({ mutated: false, data: { status: "listed", instrument: kind, undoSteps: 0 } });
      expect(listed.data).toMatchObject({
        parameters: expect.arrayContaining([
          expect.objectContaining({ id: param.id, value: beforeValue, min: param.min, max: param.max }),
        ]),
      });

      const set = await host.call("kyx_instrument_param", {
        op: "set",
        trackId: track.id,
        param: param.id,
        value: param.max + (param.max - param.min),
      });
      expect(set).toMatchObject({
        mutated: true,
        data: {
          status: "updated",
          instrument: kind,
          change: { param: param.id, beforeValue, value: param.max, clamped: true, changed: true },
          undoSteps: 1,
        },
      });
      expect(host.store.doc.tracks.find((candidate) => candidate.id === track.id)).toMatchObject({
        kind: "instrument",
        params: { [param.id]: param.max },
      });

      const noOp = await host.call("kyx_instrument_param", {
        op: "set",
        trackId: track.id,
        param: param.id,
        value: param.max,
      });
      expect(noOp).toMatchObject({ mutated: false, data: { status: "no_change", undoSteps: 0 } });

      host.store.undo();
      expect(host.store.doc.tracks.find((candidate) => candidate.id === track.id)).toMatchObject({
        kind: "instrument",
        params: { [param.id]: beforeValue },
      });
    }
  });

  it("rejects unknown, enum and off-grid instrument values without mutation", async () => {
    const host = createHeadlessMcpHost({ document: documentWithInstrument("kopa") });
    const track = host.store.doc.tracks.find(
      (candidate) => candidate.kind === "instrument" && candidate.instrument === "kopa",
    );
    expect(track?.kind).toBe("instrument");
    if (track?.kind !== "instrument") throw new Error("missing KOPA fixture track");
    const before = host.store.doc;
    const optionParam = INSTRUMENT_DEFS.kopa.params.find((param) => param.options != null && param.options.length > 1)!;
    const steppedParam = INSTRUMENT_DEFS.kopa.params.find((param) => param.step != null && param.options == null)!;

    const unknown = await host.call("kyx_instrument_param", {
      op: "set",
      trackId: track.id,
      param: "notAParam",
      value: 1,
    });
    expect(unknown.errorCode).toBe("UNKNOWN_TARGET");
    expect(host.store.doc).toBe(before);

    const invalidOption = await host.call("kyx_instrument_param", {
      op: "set",
      trackId: track.id,
      param: optionParam.id,
      value: optionParam.options![0]!.value + 0.5,
    });
    expect(invalidOption.errorCode).toBe("INVALID_ARGUMENTS");
    expect(host.store.doc).toBe(before);

    const invalidStep = await host.call("kyx_instrument_param", {
      op: "set",
      trackId: track.id,
      param: steppedParam.id,
      value: steppedParam.min + steppedParam.step! / 2,
    });
    expect(invalidStep.errorCode).toBe("INVALID_ARGUMENTS");
    expect(host.store.doc).toBe(before);
    expect(host.store.undoStackLength).toBe(0);
  });
});
