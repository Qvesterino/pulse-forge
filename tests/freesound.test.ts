import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchFreesoundPreview,
  freesoundSampleId,
  loadFreesoundToken,
  saveFreesoundToken,
  searchFreesound,
  FreesoundError,
} from "../src/samples/freesound";

const REAL_FETCH = globalThis.fetch;

interface MockResponse { status: number; body?: unknown; bodyArrayBuffer?: ArrayBuffer }

function mockFetch(handler: (url: string) => MockResponse) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const result = handler(url);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
      arrayBuffer: async () => result.bodyArrayBuffer ?? new ArrayBuffer(0),
    } as Response;
  });
}

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("freesound token storage", () => {
  it("round-trips through localStorage and trims", () => {
    saveFreesoundToken("  abc123  ");
    expect(loadFreesoundToken()).toBe("abc123");
    saveFreesoundToken("");
    expect(loadFreesoundToken()).toBe("");
  });
});

describe("searchFreesound", () => {
  it("queries the API with CC0 + duration filter and maps results", async () => {
    let capturedUrl = "";
    const fetchMock = mockFetch((url) => {
      capturedUrl = url;
      return {
        status: 200,
        body: {
          results: [
            {
              id: 42,
              name: "808 Kick",
              username: "producer",
              duration: 1.2,
              previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/42/hq.mp3" },
              license: "http://creativecommons.org/publicdomain/zero/1.0/",
            },
            {
              id: 43,
              name: "No preview sound",
              username: "x",
              duration: 2,
              previews: {},
              license: "cc0",
            },
          ],
        },
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await searchFreesound("808 kick", { token: "tok123" });
    // URL assertions after the call (throwing inside the mock gets caught
    // by the module's network-error wrapper).
    expect(capturedUrl).toContain("https://freesound.org/apiv2/search/text/");
    expect(capturedUrl).toContain('license%3A%22Creative+Commons+0%22'); // CC0 filter
    expect(capturedUrl).toContain("duration%3A%5B0+TO+8%5D");
    expect(capturedUrl).toContain("token=tok123");
    expect(capturedUrl).toContain("query=808+kick");
    expect(results).toHaveLength(1); // preview-less result dropped
    expect(results[0]).toMatchObject({
      id: 42,
      name: "808 Kick",
      username: "producer",
      previewUrl: "https://cdn.freesound.org/previews/42/hq.mp3",
    });
  });

  it("throws a friendly error on 401 (bad token)", async () => {
    globalThis.fetch = mockFetch(() => ({ status: 401, body: {} })) as unknown as typeof fetch;
    await expect(searchFreesound("x", { token: "bad" })).rejects.toThrow(/Invalid API token/);
  });

  it("throws without a token set", async () => {
    await expect(searchFreesound("x", { token: "" })).rejects.toThrow(/freesound.org\/api/);
  });

  it("wraps network failures", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(searchFreesound("x", { token: "t" })).rejects.toBeInstanceOf(FreesoundError);
  });
});

describe("fetchFreesoundPreview", () => {
  it("downloads preview bytes from the public CDN", async () => {
    const payload = new ArrayBuffer(16);
    globalThis.fetch = mockFetch((url) => {
      expect(url).toBe("https://cdn.freesound.org/previews/42/hq.mp3");
      return { status: 200, body: null, bodyArrayBuffer: payload };
    }) as unknown as typeof fetch;
    const bytes = await fetchFreesoundPreview({
      id: 42,
      name: "x",
      username: "u",
      durationSec: 1,
      previewUrl: "https://cdn.freesound.org/previews/42/hq.mp3",
      license: "cc0",
    });
    expect(bytes.byteLength).toBe(16);
  });
});

describe("freesoundSampleId", () => {
  it("builds a clean, bounded, unique-per-sound id", () => {
    const a = freesoundSampleId({ id: 42, name: "Fat 808 KICK!!", username: "u", durationSec: 1, previewUrl: "p", license: "l" });
    expect(a).toBe("fs-42-fat-808-kick");
    const long = freesoundSampleId({ id: 7, name: "x".repeat(200), username: "u", durationSec: 1, previewUrl: "p", license: "l" });
    expect(long.length).toBeLessThanOrEqual(3 + 1 + 1 + 40 + 1);
    expect(long.startsWith("fs-7-")).toBe(true);
  });
});
