import { describe, expect, it, beforeEach, vi } from "vitest";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { separateStemsForAgent, type SeparateStemsResult } from "../src/mcp/stem-separate";
import { setStemModelFlag } from "../src/analysis/stem-model/gate";
import type { ProjectDocument } from "../src/project-model/types";
import { createProjectFromTemplate } from "../src/project-model/templates";

/**
 * kyx_separate — the separation step of the agent loop. The pinned
 * contract: honest refusals without a live session, the hpss tier's three
 * lanes registered in the bank under stem.<id>.<role> ids, the model tier
 * refusing while its owner flag is off (an agent never downloads the
 * model), and the read-back carrying the exact kyx_master op:stems import
 * call. Report-only: no MCP call of this tool ever mutates the document.
 */

/** jsdom has no AudioBuffer — a minimal stand-in with real storage. */
class FakeAudioBuffer {
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  private channel: Float32Array;
  constructor(options: { length: number; numberOfChannels: number; sampleRate: number }) {
    this.length = options.length;
    this.numberOfChannels = options.numberOfChannels;
    this.sampleRate = options.sampleRate;
    this.channel = new Float32Array(options.length);
  }
  copyToChannel(source: Float32Array, channel: number): void {
    if (channel !== 0) throw new Error(`channel ${channel} unsupported`);
    this.channel.set(source);
  }
  getChannelData(): Float32Array {
    return this.channel;
  }
}

vi.stubGlobal("AudioBuffer", FakeAudioBuffer);

const SR = 22050;

/** 2.5 s of tonal material with percussive clicks — enough for the HPSS split. */
function tonalWithClicks(): Float32Array {
  const n = Math.round(2.5 * SR);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 110 * i) / SR);
  for (let click = 0; click < 5; click++) {
    const start = Math.round(click * 0.5 * SR);
    for (let i = 0; i < 400 && start + i < n; i++)
      pcm[start + i]! += 0.6 * Math.exp(-i / 60) * Math.sin((2 * Math.PI * 900 * i) / SR);
  }
  return pcm;
}

function fakeServices() {
  const bank = new Map<string, FakeAudioBuffer>();
  const samples = new Map<string, Float32Array>([["user.song", tonalWithClicks()]]);
  const services = {
    bank: {
      add: (id: string, buffer: FakeAudioBuffer) => void bank.set(id, buffer),
      get: (id: string) => bank.get(id) ?? null,
    },
    userSamples: {
      loadAudio: async (id: string) => {
        const pcm = samples.get(id);
        if (!pcm) return null;
        // Encode as raw bytes the loader treats as an ArrayBuffer payload —
        // the real loader decodes; this fake hands the PCM through a
        // WAV-less path by returning it via the bank-first route instead.
        return null;
      },
    },
  };
  // Pre-register in the bank: loadUserSampleMono's common path is a bank hit.
  const sourceBuffer = new FakeAudioBuffer({ length: tonalWithClicks().length, numberOfChannels: 1, sampleRate: SR });
  sourceBuffer.copyToChannel(tonalWithClicks(), 0);
  services.bank.add("user.song", sourceBuffer as unknown as AudioBuffer);
  return { services, bank };
}

function makeCtx(
  doc: ProjectDocument,
  outcome?: { ok: true; result: SeparateStemsResult } | { ok: false; error: string },
): McpToolContext {
  const base = {
    getDoc: () => doc,
    execute: () => undefined,
    undo: () => undefined,
    redo: () => undefined,
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: {
      play: () => undefined,
      stop: () => undefined,
      pause: () => undefined,
      setLoop: () => undefined,
      setMetronome: () => undefined,
    },
  } as unknown as McpToolContext;
  if (outcome) {
    (base as { separateStems: unknown }).separateStems = async () => outcome;
  }
  return base;
}

beforeEach(() => {
  setStemModelFlag(false);
});

describe("kyx_separate — agent surface", () => {
  it("refuses honestly without a live session (headless), nothing mutates", async () => {
    const doc = createProjectFromTemplate("house");
    const result = await executeMcpTool(makeCtx(doc), "kyx_separate", { sourceId: "user.song" });
    expect(result.mutated).toBe(false);
    expect(result.text).toMatch(/live session with the sample bank/i);
  });

  it("refuses without sourceId and reports the default tier", async () => {
    const doc = createProjectFromTemplate("house");
    const { services } = fakeServices();
    const ctx = makeCtx(doc);
    (ctx as { separateStems: unknown }).separateStems = (input: { sourceId: string; tier?: string }) =>
      separateStemsForAgent(services, input.sourceId, { tier: input.tier as "hpss" });
    const result = await executeMcpTool(ctx, "kyx_separate", {});
    expect(result.mutated).toBe(false);
    expect(result.text).toMatch(/needs sourceId/i);
  });

  it("hpss tier registers three lanes in the bank and hands over the import call", async () => {
    const doc = createProjectFromTemplate("house");
    const { services, bank } = fakeServices();
    const ctx = makeCtx(doc);
    (ctx as { separateStems: unknown }).separateStems = (input: { sourceId: string; tier?: "hpss" | "model" }) =>
      separateStemsForAgent(services, input.sourceId, { tier: input.tier });
    const result = await executeMcpTool(ctx, "kyx_separate", { sourceId: "user.song" });
    expect(result.mutated).toBe(false);
    const data = result.data as SeparateStemsResult;
    expect(data.tier).toBe("hpss");
    expect(data.stems.map((stem) => stem.role).sort()).toEqual(["bass", "drums", "other"]);
    for (const stem of data.stems) {
      expect(bank.get(stem.bufferId)).toBeTruthy();
      expect(stem.bufferId).toMatch(/^stem\.user\.song\./);
      expect(stem.durationSec).toBeGreaterThan(2);
    }
    expect(result.text).toMatch(/kyx_master op:"stems" import:/);
    expect(result.text).toMatch(/vocals stay inside 'other'/);
  });

  it("an unknown source refuses and registers nothing", async () => {
    const doc = createProjectFromTemplate("house");
    const { services, bank } = fakeServices();
    const outcome = await separateStemsForAgent(services, "user.nope", { tier: "hpss" });
    expect(outcome.ok).toBe(false);
    expect(bank.size).toBe(1); // only the pre-registered source, no stems
  });

  it("the model tier is owner-gated: flag off → refusal naming the flag, no fallback", async () => {
    const doc = createProjectFromTemplate("house");
    const { services, bank } = fakeServices();
    const outcome = await separateStemsForAgent(services, "user.song", { tier: "model" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/pf:stem-model is OFF/);
    expect(bank.size).toBe(1);
  });
});
