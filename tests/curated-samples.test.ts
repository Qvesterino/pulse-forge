import { describe, expect, it, vi } from "vitest";
import {
  CURATED_SAMPLES,
  SYNTHESIS_ONLY_ASSET_IDS,
  curatedReadyWithin,
  ensureCuratedLayer,
  loadCuratedLayer,
} from "../src/sample-library/curated";
import { SampleBank } from "../src/sample-library/factory";

/**
 * Curated factory layer (same-id override contract):
 * - a fetched file OVERRIDES the slot in the bank;
 * - a missing file (404) leaves the synthesized fallback in place — never throws;
 * - a failing decode is isolated per file;
 * - gain trim is applied;
 * - export paths await per-bank (memoized) with a bounded timeout.
 */

function fakeBuffer(channels = 1, length = 8): AudioBuffer {
  const data = { ch: [] as Float32Array[] };
  for (let c = 0; c < channels; c++) data.ch.push(new Float32Array(length).fill(0.25));
  return {
    numberOfChannels: channels,
    length,
    sampleRate: 44100,
    getChannelData: (ch: number) => data.ch[ch] ?? (data.ch[0] ??= new Float32Array(length)),
    duration: length / 44100,
  } as unknown as AudioBuffer;
}

const okResponse = (payload: ArrayBuffer) =>
  ({ ok: true, status: 200, arrayBuffer: async () => payload }) as unknown as Response;
const notFound = () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response;

function makeFetch(map: Record<string, "ok" | "404" | "decode-fail">, payloads: Record<string, ArrayBuffer> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const file = url.split("/").pop() ?? "";
    const mode = map[file] ?? "404";
    if (mode === "404") return notFound();
    return okResponse(payloads[file] ?? new ArrayBuffer(16));
  }) as unknown as typeof fetch;
}

const decodeOk = async () => fakeBuffer();

describe("loadCuratedLayer — same-id override with synthesized fallback", () => {
  it("overrides only the slots whose files exist; 404s keep the synth fallback", async () => {
    const bank = new SampleBank();
    bank.add("factory.kick.deep", fakeBuffer());
    bank.add("factory.tonal.keys", fakeBuffer());
    const kickDeep = bank.get("factory.kick.deep");
    const tonalKeys = bank.get("factory.tonal.keys");
    const files = Object.fromEntries(CURATED_SAMPLES.slice(0, 2).map((s) => [s.file, "ok" as const]));
    const result = await loadCuratedLayer(bank, { fetchImpl: makeFetch(files), decode: decodeOk });
    expect(result.loaded).toBe(2);
    expect(result.skipped.length).toBe(CURATED_SAMPLES.length - 2);
    // Overridden slots got a NEW buffer; 404 slots keep the synth fallback.
    expect(bank.get("factory.kick.deep")).not.toBe(kickDeep);
    expect(bank.get("factory.tonal.keys")).toBe(tonalKeys);
  });

  it("a decode failure is isolated — other files still land", async () => {
    const bank = new SampleBank();
    const files = Object.fromEntries(CURATED_SAMPLES.slice(0, 3).map((s) => [s.file, "ok" as const]));
    let call = 0;
    const decode = async () => {
      call += 1;
      if (call === 1) throw new Error("corrupt wav");
      return fakeBuffer();
    };
    const result = await loadCuratedLayer(bank, { fetchImpl: makeFetch(files), decode });
    expect(result.loaded).toBe(2);
    expect(result.failed).toHaveLength(1);
  });

  it("applies the gain trim on load", async () => {
    const bank = new SampleBank();
    // Patch one curated entry with gain 0.5 via a local list — use the public
    // loader with a one-file fetch map and verify through CURATED_SAMPLES
    // default (gain 1 keeps samples untouched; explicit gain scales them).
    const files = { [CURATED_SAMPLES[0].file]: "ok" as const };
    let seenPeak = 0;
    const decode = async () => {
      const buf = fakeBuffer();
      seenPeak = buf.getChannelData(0)[0];
      return buf;
    };
    await loadCuratedLayer(bank, { fetchImpl: makeFetch(files), decode });
    const stored = bank.get(CURATED_SAMPLES[0].id)!;
    const expected = (CURATED_SAMPLES[0].gain ?? 1) * seenPeak;
    expect(stored.getChannelData(0)[0]).toBeCloseTo(expected, 6);
  });

  it("ensureCuratedLayer memoizes per bank — a second await does not refetch", async () => {
    const bank = new SampleBank();
    const fetchImpl = makeFetch({ [CURATED_SAMPLES[0].file]: "ok" });
    await ensureCuratedLayer(bank, { fetchImpl, decode: decodeOk });
    const callsAfterFirst = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await ensureCuratedLayer(bank, { fetchImpl, decode: decodeOk });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
    // A DIFFERENT bank (embed/export build their own) loads independently.
    const bank2 = new SampleBank();
    await ensureCuratedLayer(bank2, { fetchImpl, decode: decodeOk });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("curatedReadyWithin resolves after the layer (or the timeout) without hanging", async () => {
    const bank = new SampleBank();
    // All files 404 → the layer promise resolves immediately with 0 loaded.
    const started = Date.now();
    await curatedReadyWithin(bank, 2000);
    expect(Date.now() - started).toBeLessThan(1500);
    // A slow layer is cut off by the timeout — must not hang the render path.
    const slowBank = new SampleBank();
    ensureCuratedLayer(slowBank, {
      fetchImpl: (async () =>
        await new Promise<Response>((resolve) =>
          setTimeout(() => resolve(notFound()), 10_000),
        )) as unknown as typeof fetch,
      decode: decodeOk,
    });
    const slow = curatedReadyWithin(slowBank, 50);
    await expect(slow).resolves.toBeUndefined();
  });
});

describe("curated coverage — full-kit contract", () => {
  it("CURATED_SAMPLES covers every curated asset exactly once and leaves only the mallets synthesis-only", async () => {
    const { FACTORY_ASSETS } = await import("../src/sample-library/manifest");
    const ids = CURATED_SAMPLES.map((sample) => sample.id);
    expect(new Set(ids).size).toBe(ids.length);
    const assetIds = FACTORY_ASSETS.map((asset) => asset.id).sort();
    const synthOnly = new Set<string>(SYNTHESIS_ONLY_ASSET_IDS);
    const curatedIds = [...ids].sort();
    expect(assetIds.filter((id) => !curatedIds.includes(id))).toEqual([...synthOnly].sort());
    expect(curatedIds).toEqual(assetIds.filter((id) => !synthOnly.has(id)));
  });

  it("every curated file exists on disk", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    for (const sample of CURATED_SAMPLES) {
      const file = path.resolve(__dirname, "..", "public", "samples", sample.file);
      expect(() => readFileSync(file), `${sample.file} missing`).not.toThrow();
    }
  });
});
