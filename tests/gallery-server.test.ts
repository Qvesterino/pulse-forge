/**
 * Beat Gallery server — REST API + JSON store + WS upgrade parity.
 *
 * Boots createCollabServer() on an ephemeral port with a temp gallery.json,
 * exercises the HTTP surface with real fetch, and proves the y-websocket
 * upgrade path still works after the http-server refactor.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { compressToEncodedURIComponent } from "lz-string";
// @ts-expect-error untyped .mjs server module
import { createCollabServer } from "../server/collab-server.mjs";
import { createProjectFromTemplate } from "../src/project-model/templates";

type CollabServer = ReturnType<typeof createCollabServer>;

const opened: CollabServer[] = [];

async function boot(): Promise<{ base: string; collab: CollabServer; galleryFile: string }> {
  const galleryFile = join(mkdtempSync(join(tmpdir(), "pf-gallery-")), "gallery.json");
  const collab = createCollabServer({ galleryFile });
  await new Promise<void>((resolve) => collab.server.listen(0, "127.0.0.1", resolve));
  opened.push(collab);
  const { port } = collab.server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, collab, galleryFile };
}

function shareCode(): string {
  // A realistic project through the exact same encoding the studio uses.
  return compressToEncodedURIComponent(JSON.stringify(createProjectFromTemplate("house")));
}

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(
      (c) =>
        new Promise<void>((resolve) => {
          c.server.close(() => resolve());
          c.wss.close();
        }),
    ),
  );
});

describe("gallery REST API", () => {
  it("starts empty and accepts a valid beat", async () => {
    const { base } = await boot();

    const empty = await fetch(`${base}/api/gallery`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [] });

    const post = await fetch(`${base}/api/gallery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  Midnight Jam ", author: "Qveen", tags: ["Phonk", "808", "dark"], code: shareCode() }),
    });
    expect(post.status).toBe(201);
    const { item } = (await post.json()) as {
      item: { id: string; title: string; author: string; tags: string[]; bpm: number; projectName: string };
    };
    expect(item.id).toBeTruthy();
    expect(item.title).toBe("Midnight Jam"); // trimmed, control chars stripped
    expect(item.author).toBe("Qveen");
    expect(item.tags).toEqual(["phonk", "808", "dark"]); // lowercased
    expect(item.bpm).toBe(createProjectFromTemplate("house").bpm); // decoded from the project
    expect(item.projectName.length).toBeGreaterThan(0);

    const feed = await (await fetch(`${base}/api/gallery`)).json();
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].title).toBe("Midnight Jam");
  });

  it("rejects junk: missing title, invalid code, malformed JSON, unknown route", async () => {
    const { base } = await boot();

    const noTitle = await fetch(`${base}/api/gallery`, {
      method: "POST",
      body: JSON.stringify({ title: "   ", code: shareCode() }),
    });
    expect(noTitle.status).toBe(400);

    const badCode = await fetch(`${base}/api/gallery`, {
      method: "POST",
      body: JSON.stringify({ title: "ok", code: "not-a-real-share-code" }),
    });
    expect(badCode.status).toBe(400);

    const badJson = await fetch(`${base}/api/gallery`, { method: "POST", body: "{oops" });
    expect(badJson.status).toBe(400);

    const unknown = await fetch(`${base}/api/nope`);
    expect(unknown.status).toBe(404);
  });

  it("sanitizes tags (bad chars dropped, max 5 kept)", async () => {
    const { base } = await boot();
    const post = await fetch(`${base}/api/gallery`, {
      method: "POST",
      body: JSON.stringify({
        title: "tags test",
        code: shareCode(),
        tags: ["Good-1", "has space", "<script>", "x".repeat(40), "a", "b", "c", "d"],
      }),
    });
    const { item } = (await post.json()) as { item: { tags: string[] } };
    expect(item.tags).toEqual(["good-1", "a", "b", "c", "d"]);
  });

  it("persists to gallery.json and reloads into a fresh server", async () => {
    const first = await boot();
    const post = await fetch(`${first.base}/api/gallery`, {
      method: "POST",
      body: JSON.stringify({ title: "persisted", tags: ["house"], code: shareCode() }),
    });
    expect(post.status).toBe(201);

    const stored = JSON.parse(readFileSync(first.galleryFile, "utf-8")) as { items: { title: string }[] };
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0].title).toBe("persisted");

    // Second instance over the same file sees the beat.
    const collab2 = createCollabServer({ galleryFile: first.galleryFile });
    await new Promise<void>((resolve) => collab2.server.listen(0, "127.0.0.1", resolve));
    opened.push(collab2);
    const { port } = collab2.server.address() as AddressInfo;
    const feed = await (await fetch(`http://127.0.0.1:${port}/api/gallery`)).json();
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].title).toBe("persisted");
  });

  it("rate limits uploads per IP (10 per minute)", async () => {
    const { base } = await boot();
    const code = shareCode();
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${base}/api/gallery`, {
        method: "POST",
        body: JSON.stringify({ title: `spam ${i}`, code }),
      });
      lastStatus = res.status;
      if (i < 10) expect(res.status).toBe(201);
    }
    expect(lastStatus).toBe(429);
  });

  it("serves CORS headers so the gallery page can live on another origin", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/gallery`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await fetch(`${base}/api/gallery`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
  });
});

describe("y-websocket parity after the http refactor", () => {
  it("still accepts the yjs upgrade handshake on /<roomId>", async () => {
    const { base } = await boot();
    const wsUrl = `${base.replace("http", "ws")}/jam-room`;
    const conn = new WebSocket(wsUrl);
    conn.binaryType = "arraybuffer";
    const firstMessage = new Promise<Buffer>((resolve, reject) => {
      conn.on("message", (data) => resolve(data as Buffer));
      conn.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      conn.on("open", resolve);
      conn.on("error", reject);
    });
    // The server proactively sends sync step 1 + awareness on connect.
    const data = await Promise.race([
      firstMessage,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no handshake within 2s")), 2000)),
    ]);
    conn.terminate();
    const size = (data as unknown as ArrayBuffer).byteLength ?? (data as unknown as Buffer).length;
    expect(size).toBeGreaterThan(2);
  });
});
