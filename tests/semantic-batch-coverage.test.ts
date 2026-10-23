import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ANSWER MUST COVER EXACTLY THE TEXTS THAT WERE ASKED FOR.
 *
 * The semantic worker filtered its batch before embedding:
 *
 *   const texts = request.texts.filter((text) => typeof text === "string" && text.trim().length > 0);
 *
 * so a request for three texts, one of them empty, came back as TWO vectors.
 * The client did not notice: it returned whatever the worker said, so the
 * caller received a short answer and used it as if it were complete.
 *
 * The consumer did notice — `buildReferenceEmbedding` checks
 * `vectors.length !== texts.length` and returns null — but that is a SILENT
 * loss of the whole reference-informed conditioning (labels + feature poles),
 * not a report. The user gets a beat with no reference conditioning and no
 * explanation.
 *
 * The contract is simple: N texts in, N vectors out, in order. A request that
 * cannot be answered that way is a FAILURE, not a shorter answer.
 *
 * The worker is driven for real here (only the model pipeline is mocked), so
 * the assertion sees the texts the worker actually embedded — not a promise
 * about the code.
 */

const EMBED_DIM = 4;

/** What the mocked pipeline was asked to embed. */
let embeddedBatches: string[][] = [];

vi.mock("@huggingface/transformers", () => ({
  env: { allowLocalModels: true, allowRemoteModels: false, localModelPath: "" },
  pipeline: vi.fn(async () => {
    return async (texts: string[]) => {
      embeddedBatches.push(texts);
      const data = new Float32Array(texts.length * EMBED_DIM);
      for (let index = 0; index < data.length; index += 1) data[index] = (index % 7) / 7;
      return { data, dims: [texts.length, EMBED_DIM] };
    };
  }),
}));

let previousOnMessage: typeof self.onmessage;
let previousPostMessage: typeof self.postMessage;

beforeEach(() => {
  embeddedBatches = [];
  previousOnMessage = self.onmessage;
  previousPostMessage = self.postMessage;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        semanticVersion: "semantic-embed.v1",
        modelId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        dtype: "q8",
      }),
    })),
  );
});

afterEach(() => {
  self.onmessage = previousOnMessage;
  self.postMessage = previousPostMessage;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the semantic worker answers the batch it was given", () => {
  it("embeds every text of the batch, including an empty one", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("postMessage", (message: unknown) => {
      posted.push(message);
    });
    vi.resetModules();
    await import("../src/ai/semantic/semantic-worker");

    const handler = (self as unknown as { onmessage?: (event: MessageEvent) => unknown }).onmessage;
    expect(typeof handler).toBe("function");

    await Promise.resolve(
      handler?.({ data: { type: "embed", requestId: 7, texts: ["alpha", "", "beta"] } } as unknown as MessageEvent),
    );

    expect(
      embeddedBatches[0],
      "the worker must embed the texts it was given — a filtered batch answers a different question",
    ).toEqual(["alpha", "", "beta"]);

    const answer = posted[0] as { requestId?: unknown; ok?: unknown; rowCount?: unknown };
    expect(answer?.requestId).toBe(7);
    expect(answer?.ok).toBe(true);
    expect(answer?.rowCount, "three texts in, three rows out").toBe(3);
  });

  it("refuses a batch it cannot answer instead of answering a shorter one", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("postMessage", (message: unknown) => {
      posted.push(message);
    });
    vi.resetModules();
    await import("../src/ai/semantic/semantic-worker");

    const handler = (self as unknown as { onmessage?: (event: MessageEvent) => unknown }).onmessage;
    await Promise.resolve(
      handler?.({ data: { type: "embed", requestId: 8, texts: ["alpha", 42] } } as unknown as MessageEvent),
    );

    const answer = posted[0] as { requestId?: unknown; ok?: unknown };
    expect(answer?.requestId).toBe(8);
    expect(answer?.ok, "a batch that is not a batch is a controlled failure").toBe(false);
  });
});

describe("the semantic client refuses a short answer", () => {
  it("returns null when the worker answers fewer rows than texts sent", async () => {
    vi.resetModules();
    const { embedTexts } = await import("../src/ai/semantic/semantic-client");

    class ShortAnswerWorker {
      static last: ShortAnswerWorker | null = null;
      private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
      terminated = false;
      constructor() {
        ShortAnswerWorker.last = this;
      }
      addEventListener(type: string, listener: (event: unknown) => void): void {
        let set = this.listeners.get(type);
        if (!set) this.listeners.set(type, (set = new Set()));
        set.add(listener);
      }
      removeEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners.get(type)?.delete(listener);
      }
      postMessage(message: unknown): void {
        const { requestId } = message as { requestId: number };
        // Two rows for three texts — the shape the worker's filter used to
        // produce. The client must not pass it on as a complete answer.
        for (const listener of this.listeners.get("message") ?? []) {
          listener({ data: { type: "embed", requestId, ok: true, vectors: new Float32Array(8), rowCount: 2 } });
        }
      }
      terminate(): void {
        this.terminated = true;
      }
    }
    vi.stubGlobal("Worker", ShortAnswerWorker as unknown as typeof Worker);

    const vectors = await embedTexts(["one", "two", "three"]);
    expect(vectors, "a short answer is not an answer — the caller must see the failure").toBeNull();
  });
});
