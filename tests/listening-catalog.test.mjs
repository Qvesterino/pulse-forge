import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildListeningCatalog } from "../scripts/listening-catalog.mjs";

let temporaryRoot;

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

async function makeSession(root, directory, id, { wavCount = 2, guide = "", verdicts = false } = {}) {
  const sessionRoot = path.join(root, "listening", directory, id);
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(path.join(sessionRoot, "index.html"), "<!doctype html>");
  for (let pair = 0; pair < wavCount / 2; pair += 1) {
    const pairId = `P${String(pair + 1).padStart(2, "0")}`;
    await writeFile(path.join(sessionRoot, `${pairId}-A.wav`), "audio");
    await writeFile(path.join(sessionRoot, `${pairId}-B.wav`), "audio");
  }
  if (guide) await writeFile(path.join(sessionRoot, "LISTENING.md"), guide);
  if (verdicts) await writeFile(path.join(sessionRoot, "verdicts.json"), "{}");
  await writeFile(path.join(sessionRoot, "answer-key.json"), '{"mustNotBeReturned":true}');
}

describe("buildListeningCatalog", () => {
  it("lists playable Producer DNA packs, excludes empty render attempts, and never exposes answer keys", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kyx-listening-catalog-"));
    const listeningRoot = path.join(temporaryRoot, "listening");
    await mkdir(path.join(listeningRoot, "room"), { recursive: true });
    await writeFile(path.join(listeningRoot, "room", "room.html"), "room");
    await writeFile(
      path.join(listeningRoot, "room", "room.json"),
      JSON.stringify({
        generatedAt: "2026-10-01T12:00:00.000Z",
        morph: [{}],
        scenes: [{}, {}],
        intent: [{}],
        conditioning: [{}, {}],
        grooves: [{}, {}, {}],
      }),
    );
    await mkdir(path.join(listeningRoot, "lanes"), { recursive: true });
    await writeFile(
      path.join(listeningRoot, "lanes", "lanes.json"),
      JSON.stringify({ lanes: [{ id: "house.a" }, { id: "house.a" }, { id: "dnb.b" }] }),
    );
    await mkdir(path.join(listeningRoot, "abx"), { recursive: true });
    await writeFile(path.join(listeningRoot, "abx", "index.html"), "abx");
    await writeFile(
      path.join(listeningRoot, "abx", "lanes.json"),
      JSON.stringify({ lanes: [{ lane: "one" }, { lane: "two" }] }),
    );

    await makeSession(temporaryRoot, "producer-dna", "2026-10-02T10-00-00-000Z-session", {
      wavCount: 4,
      guide: "# KYX Producer DNA — blind hook listening pack\n\nMode: **hook** · Genre: **trap** · Pairs: **2**\n",
      verdicts: true,
    });
    await makeSession(temporaryRoot, "producer-dna", "2026-10-03T10-00-00-000Z-empty", { wavCount: 0 });
    await makeSession(temporaryRoot, "producer-dna-songs", "2026-10-04T10-00-00-000Z-song", { wavCount: 2 });

    const catalog = await buildListeningCatalog(temporaryRoot);
    expect(catalog.room).toMatchObject({
      available: true,
      lanes: 2,
      suites: { morph: 1, scenes: 2, intent: 1, conditioning: 2, grooves: 3 },
    });
    expect(catalog.abx).toMatchObject({ available: true, lanes: 2, url: "/abx/" });
    expect(catalog.producerDna).toHaveLength(1);
    expect(catalog.producerDna[0]).toMatchObject({ genre: "trap", mode: "hook", pairCount: 2, verdictsSaved: true });
    expect(catalog.producerDna[0].url).toContain("2026-10-02T10-00-00-000Z-session");
    expect(catalog.producerDnaSongs).toHaveLength(1);
    expect(JSON.stringify(catalog)).not.toContain("mustNotBeReturned");
  });

  it("returns empty, safe defaults when generated listening folders are absent", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kyx-listening-catalog-"));

    const catalog = await buildListeningCatalog(temporaryRoot);

    expect(catalog).toMatchObject({
      room: { available: false, lanes: 0, suites: { morph: 0, scenes: 0, intent: 0, conditioning: 0, grooves: 0 } },
      abx: { available: false, lanes: 0 },
      producerDna: [],
      producerDnaSongs: [],
    });
  });
});
