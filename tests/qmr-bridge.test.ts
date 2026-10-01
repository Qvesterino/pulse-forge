import { describe, it, expect, afterEach } from "vitest";
import { startQmrBridge, QMR_KYX_MANIFEST, QMR_APP_ID, type QmrRuntimeContract } from "../src/interop/qmrBridge";
import { executeMcpTool, MCP_TOOLS } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";
import type { Services } from "../src/services";

/**
 * QMR BRIDGE — KYX as a QMR organ. The manifest declares Audio Canvas as
 * the PRIMARY handoff (the packet-verified H53 edge) and customCommands
 * mapped onto REAL MCP tools; the runtime contract exposes
 * window.qvesterQmr.executeCommand routing kyx.<tool> through the
 * validated MCP tool layer.
 */

function fakeServices(): { services: Services; store: ProjectStore } {
  useDeterministicIds();
  resetDeterministicIds();
  const base = createProjectFromTemplate("house");
  const store = new ProjectStore({ ...base, arrangement: { ...base.arrangement, clips: [] }, markers: [], scenes: [] });
  const services = {
    store,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
  } as unknown as Services;
  return { services, store };
}

afterEach(() => {
  delete (window as unknown as { qvesterQmr?: unknown }).qvesterQmr;
});

describe("qmr bridge — manifest", () => {
  it("declares Audio Canvas as the PRIMARY handoff (the H53 edge)", () => {
    expect(QMR_KYX_MANIFEST.appId).toBe(QMR_APP_ID);
    expect(QMR_APP_ID).toBe("pulse_forge");
    const primary = QMR_KYX_MANIFEST.handoffOut.find((handoff) => handoff.primary);
    expect(primary?.targetApp).toBe("audio_canvas");
    expect(primary?.intent).toBe("send_beat_to_audio_canvas");
  });

  it("every customCommand type maps onto a REAL MCP tool (no bypass surface)", () => {
    const toolNames = new Set(MCP_TOOLS.map((tool) => tool.name));
    expect(QMR_KYX_MANIFEST.customCommands.length).toBeGreaterThan(3);
    for (const command of QMR_KYX_MANIFEST.customCommands) {
      expect(command.type).toMatch(/^kyx\./);
      expect(toolNames.has(`kyx_${command.type.slice(4)}`)).toBe(true);
    }
    // and nothing the manifest promises is missing from the tool layer
    for (const promised of ["kyx.state", "kyx.song", "kyx.mix", "kyx.arrange", "kyx.transport", "kyx.undo"]) {
      expect(QMR_KYX_MANIFEST.customCommands.some((command) => command.type === promised)).toBe(true);
    }
  });
});

describe("qmr bridge — runtime contract", () => {
  it("startQmrBridge exposes window.qvesterQmr; stop clears it", () => {
    const { services } = fakeServices();
    const stop = startQmrBridge(services);
    const runtime = (window as unknown as { qvesterQmr?: QmrRuntimeContract }).qvesterQmr;
    expect(runtime?.appId).toBe("pulse_forge");
    expect(runtime?.manifest.customCommands.length).toBeGreaterThan(0);
    stop();
    expect((window as unknown as { qvesterQmr?: unknown }).qvesterQmr).toBeUndefined();
  });

  it("executeCommand routes kyx.<tool> through the MCP layer (real read-back, real undo)", async () => {
    const { services, store } = fakeServices();
    const stop = startQmrBridge(services);
    const runtime =
      (window as unknown as { qvesterQmr?: QmrRuntimeContract }).qvestErQmr ??
      (window as unknown as { qvesterQmr: QmrRuntimeContract }).qvesterQmr;

    const state = await runtime.executeCommand("kyx.state", { subject: "tempo" });
    expect(state.mutated).toBe(false);
    expect(state.text).toContain("BPM");

    const generated = await runtime.executeCommand("kyx.generate", { genre: "techno", seed: "qmr" });
    expect(generated.mutated).toBe(true);
    expect(store.doc.bpm).toBeGreaterThan(0);

    const undone = await runtime.executeCommand("kyx.undo", { action: "undo" });
    expect(undone.mutated).toBe(true);
    stop();
  });

  it("unknown and non-kyx command types are honest isError refusals", async () => {
    const { services } = fakeServices();
    const stop = startQmrBridge(services);
    const runtime = (window as unknown as { qvesterQmr: QmrRuntimeContract }).qvesterQmr;
    const unknown = await runtime.executeCommand("kyx.quantum", {});
    expect(unknown.isError).toBe(true);
    const foreign = await runtime.executeCommand("shell.navigate", {});
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain("unknown QMR command");
    stop();
  });

  it("requestHandoff refuses honestly outside the Qvester shell", async () => {
    const { services } = fakeServices();
    const stop = startQmrBridge(services);
    const runtime = (window as unknown as { qvesterQmr: QmrRuntimeContract }).qvesterQmr;
    // headless jsdom is not the mounted shell — the same-origin medium check
    // must refuse rather than render + persist into nowhere
    const outcome = await runtime.requestHandoff();
    expect("error" in outcome ? outcome.error : "").toContain("not mounted");
    stop();
  });
});

describe("qmr bridge — parity with the MCP surface", () => {
  it("the bridge executes through the same layer (spot-check one real mutation)", async () => {
    const { services, store } = fakeServices();
    const stop = startQmrBridge(services);
    const runtime = (window as unknown as { qvesterQmr: QmrRuntimeContract }).qvesterQmr;
    // the same args through executeMcpTool must produce the same doc effect
    const viaBridge = await runtime.executeCommand("kyx.mix", { genre: "techno", energy: 0.8 });
    expect(viaBridge.mutated).toBe(true);
    const drumFx = store.doc.tracks.find((t) => t.kind === "drum")?.effects.length ?? 0;
    expect(drumFx).toBeGreaterThan(0);
    // parity: the sync tool agrees
    const store2 = new ProjectStore({
      ...createProjectFromTemplate("house"),
      arrangement: { ...createProjectFromTemplate("house").arrangement, clips: [] },
      markers: [],
      scenes: [],
    });
    executeMcpTool(
      {
        getDoc: () => store2.doc,
        execute: (c) => store2.execute(c),
        undo: () => store2.undo(),
        redo: () => store2.redo(),
        undoStackLength: () => store2.undoStackLength,
        historyLabels: () => [],
        isMicRecordingActive: () => false,
        transport: { play() {}, stop() {}, pause() {}, setLoop() {}, setMetronome() {} },
      },
      "kyx_mix",
      { genre: "techno", energy: 0.8 },
    );
    expect(store2.doc.tracks.find((t) => t.kind === "drum")?.effects.length).toBe(drumFx);
    stop();
  });
});
