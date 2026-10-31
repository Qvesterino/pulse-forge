import { describe, expect, it } from "vitest";
import { createInstrumentTrack } from "../src/commands/commands";
import { routeIntentText } from "../src/intent/route";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { createDefaultProject } from "../src/project-model/schema";
import { isFactoryPresetsWarm } from "../src/presets/factory-loader";
import { buildIntentProjectContext } from "../src/intent/model-context";
import { getEffectCatalogEntry, listEffectCatalogEntries, listInstrumentCatalogEntries } from "../src/plugin-catalog";
import { applyIntent } from "./helpers/intentProtocol";

function bassTrack(host: ReturnType<typeof createHeadlessMcpHost>) {
  const track = host.store.doc.tracks.find(
    (candidate) => candidate.kind === "instrument" && /bass|808/i.test(candidate.name),
  );
  if (track?.kind !== "instrument") throw new Error("house fixture has no bass instrument track");
  return track;
}

describe("KOREŇ flagship MCP and Intent control", () => {
  it("keeps an explicit KOREŇ edit routed as an effect when a genre is also named", async () => {
    const instruction = "Add KOREŇ to the bass in a drill beat";
    const host = createHeadlessMcpHost({ document: createDefaultProject() });

    expect(routeIntentText(instruction, host.store.doc).kind).toBe("effectIntent");

    const result = await applyIntent(host, instruction);
    expect(result.isError).not.toBe(true);
    expect(result.mutated).toBe(true);
    const bass = bassTrack(host);
    const grow = bass.effects.find((effect) => effect.type === "bassHarmonic");
    expect(grow).toBeDefined();
    // The knob landed on the bass track — the read-back names the track, and
    // the drive value is visible in the document it wrote.
    expect(grow?.params.drive ?? 0).toBeGreaterThan(0);
    expect(result.text).toContain(`track ${bass.name}`);
    expect(result.text).toContain("added bassHarmonic");

    host.store.undo();
    expect(host.store.doc.tracks.find((track) => track.id === bass.id)?.effects).not.toContainEqual(
      expect.objectContaining({ type: "bassHarmonic" }),
    );
  });

  it("discovers KOREŇ, writes one exact instance through the MCP tool, and reports committed state", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const bass = bassTrack(host);

    const catalog = await host.call("kyx_catalog", { subject: "effect", effect: "bassHarmonic" });
    expect(catalog.isError).not.toBe(true);
    expect(catalog.text).toContain("bassHarmonic — GROW");
    expect(catalog.text).toContain("drive");

    const inserted = await host.call("kyx_fx", {
      effect: "bassHarmonic",
      trackId: bass.id,
      action: "more",
    });
    expect(inserted.isError, inserted.text).not.toBe(true);
    expect(inserted.mutated).toBe(true);
    expect(host.store.doc.tracks.find((track) => track.id === bass.id)?.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "bassHarmonic" })]),
    );

    const listed = await host.call("kyx_plugin_param", {
      op: "list",
      trackId: bass.id,
      effect: "bassHarmonic",
    });
    expect(listed.isError).not.toBe(true);
    expect(listed).toMatchObject({
      mutated: false,
      data: { status: "listed", targetCount: 1, instances: [expect.objectContaining({ effect: "bassHarmonic" })] },
    });

    const set = await host.call("kyx_plugin_param", {
      op: "set",
      trackId: bass.id,
      effect: "bassHarmonic",
      param: "drive",
      value: 0.72,
    });
    expect(set).toMatchObject({
      mutated: true,
      data: {
        status: "updated",
        effect: "bassHarmonic",
        param: "drive",
        changes: [expect.objectContaining({ trackId: bass.id, value: 0.72, clamped: false, changed: true })],
        undoSteps: 1,
      },
    });
    expect(host.store.doc.tracks.find((track) => track.id === bass.id)?.effects[0]?.params.drive).toBe(0.72);

    const invalidEnum = await host.call("kyx_plugin_param", {
      op: "set",
      trackId: bass.id,
      effect: "bassHarmonic",
      param: "character",
      value: 0.5,
    });
    expect(invalidEnum.errorCode).toBe("INVALID_ARGUMENTS");
    expect(host.store.doc.tracks.find((track) => track.id === bass.id)?.effects[0]?.params.drive).toBe(0.72);

    host.store.undo();
    expect(host.store.doc.tracks.find((track) => track.id === bass.id)?.effects[0]?.params.drive).not.toBe(0.72);
    host.store.undo();
    expect(host.store.doc.tracks.find((track) => track.id === bass.id)?.effects).not.toContainEqual(
      expect.objectContaining({ type: "bassHarmonic" }),
    );
  });

  it("evaluates real plugin tasks against the shared catalog, intent context, readback, and undo", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const bass = bassTrack(host);

    const effects = await host.call("kyx_catalog", { subject: "effects" });
    const effectRows = (effects.data as { effects: Array<Record<string, unknown>> }).effects;
    expect(effectRows.map((row) => row.type)).toEqual(listEffectCatalogEntries().map((entry) => entry.type));
    expect(effectRows.map((row) => row.parameterCount)).toEqual(
      listEffectCatalogEntries().map((entry) => entry.parameters.length),
    );

    const instruments = await host.call("kyx_catalog", { subject: "instruments" });
    const instrumentRows = (instruments.data as { instruments: Array<Record<string, unknown>> }).instruments;
    expect(instrumentRows.map((row) => row.kind)).toEqual(listInstrumentCatalogEntries().map((entry) => entry.kind));
    expect(instrumentRows.map((row) => row.parameterCount)).toEqual(
      listInstrumentCatalogEntries().map((entry) => entry.parameters.length),
    );

    const reverbCatalog = await host.call("kyx_catalog", { subject: "effect", effect: "reverb" });
    const reverbData = (reverbCatalog.data as { effect: { parameters: unknown[] } }).effect;
    expect(reverbData.parameters).toEqual(getEffectCatalogEntry("reverb")!.parameters);

    for (const effect of ["reverb", "bassHarmonic"] as const) {
      const inserted = await host.call("kyx_fx", { effect, trackId: bass.id, action: "more" });
      expect(inserted.isError, `${effect}: ${inserted.text}`).not.toBe(true);
      expect(inserted.mutated, effect).toBe(true);
    }

    const bypass = await host.call("kyx_fx", { effect: "bassHarmonic", trackId: bass.id, action: "bypass" });
    expect(bypass.isError, bypass.text).not.toBe(true);
    expect(
      host.store.doc.tracks.find((track) => track.id === bass.id)?.effects.find((fx) => fx.type === "bassHarmonic")
        ?.bypassed,
    ).toBe(true);
    const enable = await host.call("kyx_fx", { effect: "bassHarmonic", trackId: bass.id, action: "enable" });
    expect(enable.isError, enable.text).not.toBe(true);
    expect(
      host.store.doc.tracks.find((track) => track.id === bass.id)?.effects.find((fx) => fx.type === "bassHarmonic")
        ?.bypassed,
    ).toBe(false);

    const beforeSet = await host.call("kyx_plugin_param", {
      op: "list",
      trackId: bass.id,
      effect: "reverb",
    });
    const reverbBefore = (
      beforeSet.data as { instances: Array<{ parameters: Array<{ id: string; value: number | null }> }> }
    ).instances[0]!.parameters.find((param) => param.id === "mix")!.value;
    const set = await host.call("kyx_plugin_param", {
      op: "set",
      trackId: bass.id,
      effect: "reverb",
      param: "mix",
      value: 0.72,
    });
    expect(set).toMatchObject({ mutated: true, data: { status: "updated", param: "mix", undoSteps: 1 } });

    const context = buildIntentProjectContext(host.store.doc, `make the reverb wetter on ${bass.name}`);
    const contextualBass = context?.tracks.find((track) => track.name === bass.name);
    expect(contextualBass?.effects.find((effect) => effect.type === "reverb")).toMatchObject({
      modelActionSupported: true,
      intentControls: expect.arrayContaining([expect.objectContaining({ role: "mix", paramId: "mix", value: 0.72 })]),
    });
    expect(contextualBass?.effects.find((effect) => effect.type === "bassHarmonic")).toMatchObject({
      modelActionSupported: false,
      intentControls: [],
    });
    expect(getEffectCatalogEntry("reverb")!.parameters.find((param) => param.id === "mix")!.default).toBeDefined();

    host.store.undo();
    const afterUndo = host.store.doc.tracks
      .find((track) => track.id === bass.id)
      ?.effects.find((fx) => fx.type === "reverb");
    expect(afterUndo?.params.mix).toBe(reverbBefore);
    host.store.undo();
    expect(
      host.store.doc.tracks.find((track) => track.id === bass.id)?.effects.find((fx) => fx.type === "bassHarmonic")
        ?.bypassed,
    ).toBe(true);
    host.store.undo();
    expect(
      host.store.doc.tracks.find((track) => track.id === bass.id)?.effects.find((fx) => fx.type === "bassHarmonic")
        ?.bypassed,
    ).toBe(false);
    host.store.undo();
    expect(host.store.doc.tracks.find((track) => track.id === bass.id)?.effects).not.toContainEqual(
      expect.objectContaining({ type: "bassHarmonic" }),
    );
    host.store.undo();
    expect(host.store.doc.tracks.find((track) => track.id === bass.id)?.effects).not.toContainEqual(
      expect.objectContaining({ type: "reverb" }),
    );
  });

  it("warms the lazy bank and verifies a KOPA preset on the first MCP Intent request", async () => {
    expect(isFactoryPresetsWarm()).toBe(false);
    const base = createDefaultProject();
    const withKopa = createInstrumentTrack(base, "kopa").execute(base);
    const host = createHeadlessMcpHost({ document: withKopa });

    const result = await applyIntent(host, "load the Trap Long preset on the drums");

    expect(isFactoryPresetsWarm()).toBe(true);
    expect(result.isError).not.toBe(true);
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("Trap Long");
    // The read-back names the track that took the preset and the preset id it
    // took — a receipt that said only "Trap Long" would not say WHERE it landed.
    expect(result.text).toContain("factory.kopa.trap.long");
    expect(result.text).toContain('"Kopa"');
    const kopa = host.store.doc.tracks.find((track) => track.kind === "instrument" && track.instrument === "kopa");
    expect(kopa?.kind).toBe("instrument");
    if (kopa?.kind !== "instrument") throw new Error("missing KOPA fixture track");
    expect(kopa.presetId).toContain("kopa");

    host.store.undo();
    const undone = host.store.doc.tracks.find((track) => track.id === kopa.id);
    expect(undone?.kind).toBe("instrument");
    if (undone?.kind !== "instrument") throw new Error("KOPA track disappeared after preset undo");
    expect(undone.presetId).toBeFalsy();
  });
});
