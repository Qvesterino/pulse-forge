import { describe, expect, it, vi } from "vitest";
import {
  CURATED_MAX_TOTAL_BYTES,
  CURATED_SAMPLES,
  curatedReadyWithin,
  ensureCuratedLayer,
  loadCuratedLayer,
} from "../src/sample-library/curated";
import { SampleBank } from "../src/sample-library/factory";
import { configureAssetBase } from "../src/shared/assetUrls";

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

  it("loads the base asset when a filtered audit requests one of its round-robin variants", async () => {
    const bank = new SampleBank();
    const baseId = "factory.snare.main";
    const requestedUrls: string[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadCuratedLayer(bank, {
        ids: [`${baseId}.rr2`],
        fetchImpl: (async (input: RequestInfo | URL) => {
          requestedUrls.push(String(input));
          return okResponse(new ArrayBuffer(16));
        }) as typeof fetch,
        decode: decodeOk,
      });
    } finally {
      warning.mockRestore();
    }

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain("factory.snare.main.wav");
    expect(bank.has(baseId)).toBe(true);
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
    // Timeout headroom only: this spec deliberately waits ~2 s for the
    // curated layer inside the test, which crowds the 5 s default when the
    // FULL suite saturates the machine.
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
  }, 15000);

  it("loads curated WAVs through the configured application mount", async () => {
    const requestedUrls: string[] = [];
    configureAssetBase("/kyx/");
    try {
      await loadCuratedLayer(new SampleBank(), {
        fetchImpl: (async (input: RequestInfo | URL) => {
          requestedUrls.push(String(input));
          return notFound();
        }) as typeof fetch,
        decode: decodeOk,
      });
      expect(requestedUrls[0]).toBe(`/kyx/samples/${CURATED_SAMPLES[0]?.file}`);
      expect(requestedUrls.every((url) => url.startsWith("/kyx/samples/"))).toBe(true);
    } finally {
      configureAssetBase("");
    }
  });
});

describe("curated coverage — full-kit contract", () => {
  it("CURATED_SAMPLES covers every WAV-backed asset and leaves only intentional synth-only voices", async () => {
    const { FACTORY_ASSETS } = await import("../src/sample-library/manifest");
    const ids = CURATED_SAMPLES.map((sample) => sample.id);
    const synthOnlyIds = [
      "factory.brush.swirl",
      "factory.brush.tip",
      "factory.field.fridge",
      "factory.field.gravel",
      "factory.field.mains",
      // factory.field.match / roomtone / rustle / street used to live here and
      // were removed in 3743f178: they ship WAVs AND curated overrides
      // (src/sample-library/curated.ts:193-196), so they are no longer
      // synth-only. factory.field.paper has no WAV and stays.
      "factory.field.paper",
      "factory.field.switch",
      "factory.ride.ding",
      "factory.snare.ghost",
    ];
    expect(new Set(ids).size).toBe(ids.length);
    const assetIds = FACTORY_ASSETS.map((asset) => asset.id).sort();
    expect(synthOnlyIds.every((id) => assetIds.includes(id))).toBe(true);
    expect([...ids].sort()).toEqual(assetIds.filter((id) => !synthOnlyIds.includes(id)).sort());
  });

  it("every curated file exists on disk", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    for (const sample of CURATED_SAMPLES) {
      const file = path.resolve(__dirname, "..", "public", "samples", sample.file);
      expect(() => readFileSync(file), `${sample.file} missing`).not.toThrow();
    }
  });

  it("the shipped curated layer fits UNDER the byte ceiling", async () => {
    // The ceiling is a guard, not a budget: a layer that crosses it loses
    // masters SILENTLY. The shipped layer is 35.5 MB of WAV, so the ceiling
    // has to cover it — the old 30 MB ceiling truncated ~15 % of the
    // product's own masters on every boot.
    const { statSync } = await import("node:fs");
    const path = await import("node:path");
    let total = 0;
    for (const sample of CURATED_SAMPLES) {
      const file = path.resolve(__dirname, "..", "public", "samples", sample.file);
      total += statSync(file).size;
    }
    expect(total, `the curated layer is ${(total / 1024 / 1024).toFixed(1)} MB`).toBeLessThan(CURATED_MAX_TOTAL_BYTES);
  });
});

/**
 * The byte ceiling must truncate DETERMINISTICALLY.
 *
 * The bytes used to be counted in FETCH-COMPLETION order, so which samples
 * crossed the ceiling depended on which download answered first: the same
 * project exported twice carried different masters (17 skipped in one run,
 * 15 in the next). The accounting now runs in the canonical sample order.
 */
describe("curated layer — the byte ceiling truncates deterministically", () => {
  const IDS = CURATED_SAMPLES.slice(0, 8).map((s) => s.id);
  const CEILING = 10 * 1024;
  const PAYLOAD = 4 * 1024;

  /** A fetch whose answers arrive in the requested order. */
  function orderedFetch(order: "canonical" | "reverse"): typeof fetch {
    const rankOf = new Map(CURATED_SAMPLES.slice(0, 8).map((s, i) => [s.file, order === "canonical" ? i : 7 - i]));
    return (async (input: RequestInfo | URL) => {
      const file = String(input).split("/").pop() ?? "";
      await new Promise((r) => setTimeout(r, (rankOf.get(file) ?? 0) * 4));
      return okResponse(new ArrayBuffer(PAYLOAD));
    }) as unknown as typeof fetch;
  }

  it("truncates the same samples whichever download answers first", async () => {
    // The round-robin re-derivation needs a real AudioBuffer, which Node does
    // not have — the loader treats that as best-effort and warns.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bankA = new SampleBank();
      const resultA = await loadCuratedLayer(bankA, {
        ids: IDS,
        fetchImpl: orderedFetch("canonical"),
        decode: decodeOk,
        maxTotalBytes: CEILING,
      });
      const bankB = new SampleBank();
      const resultB = await loadCuratedLayer(bankB, {
        ids: IDS,
        fetchImpl: orderedFetch("reverse"),
        decode: decodeOk,
        maxTotalBytes: CEILING,
      });

      // The ceiling really was reached — otherwise this proves nothing.
      expect(resultA.skipped.length, "the fixture must cross the ceiling").toBeGreaterThan(0);
      expect(resultA.loaded, "some samples must still fit").toBeGreaterThan(0);
      // The same slots, whichever order the downloads answered in.
      expect([...resultA.skipped].sort()).toEqual([...resultB.skipped].sort());
      expect(resultA.loaded).toBe(resultB.loaded);
      // And the same slots carry the curated master.
      expect(
        bankA
          .entries()
          .map(([id]) => id)
          .sort(),
      ).toEqual(
        bankB
          .entries()
          .map(([id]) => id)
          .sort(),
      );
    } finally {
      warning.mockRestore();
    }
  });
});
