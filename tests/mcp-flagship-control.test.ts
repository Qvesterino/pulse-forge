import { describe, expect, it } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { createDefaultProject } from "../src/project-model/schema";

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

    const result = await host.call("kyx_intent", { instruction });
    expect(result.isError).not.toBe(true);
    expect(result.mutated).toBe(true);
    const bass = bassTrack(host);
    const grow = bass.effects.find((effect) => effect.type === "bassHarmonic");
    expect(grow).toBeDefined();
    expect(result.text).toContain(`drive `);
    expect(result.text).toContain(`on ${bass.name}`);

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
    expect(inserted.isError).not.toBe(true);
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
});
