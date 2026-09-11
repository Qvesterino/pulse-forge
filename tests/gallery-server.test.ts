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

async function boot(
  options: Record<string, unknown> = {},
): Promise<{ base: string; collab: CollabServer; galleryFile: string }> {
  const galleryFile = join(mkdtempSync(join(tmpdir(), "pf-gallery-")), "gallery.json");
  const collab = createCollabServer({ galleryFile, ...options });
  await new Promise<void>((resolve) => collab.server.listen(0, "127.0.0.1", resolve));
  opened.push(collab);
  const { port } = collab.server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, collab, galleryFile };
}

function shareCode(): string {
  // A realistic project through the exact same encoding the studio uses.
  return compressToEncodedURIComponent(JSON.stringify(createProjectFromTemplate("house")));
}

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const conn = new WebSocket(url);
    const onError = (error: Error) => reject(error);
    conn.once("open", () => {
      conn.off("error", onError);
      resolve(conn);
    });
    conn.once("error", onError);
  });
}

function rejectedWebSocket(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new WebSocket(url);
    conn.once("open", () => {
      conn.terminate();
      reject(new Error("expected websocket upgrade to be rejected"));
    });
    conn.once("error", (error) => {
      conn.terminate();
      resolve(error.message);
    });
  });
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
  it("refuses wildcard CORS when production config enforcement is enabled", () => {
    expect(() =>
      createCollabServer({
        galleryFile: join(mkdtempSync(join(tmpdir(), "pf-gallery-production-cors-")), "gallery.json"),
        enforceProductionConfig: true,
      }),
    ).toThrow("explicit CORS_ORIGIN allowlist");
  });

  it("starts empty and accepts a valid beat", async () => {
    const { base } = await boot();

    const empty = await fetch(`${base}/api/gallery`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [] });

    const post = await fetch(`${base}/api/gallery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "  Midnight Jam ",
        author: "Qveen",
        tags: ["Phonk", "808", "dark"],
        code: shareCode(),
      }),
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

  it("returns a bounded error for oversized gallery request bodies", async () => {
    const { base } = await boot();
    const oversized = await fetch(`${base}/api/gallery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "too large", code: "x".repeat(405_100) }),
    });

    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request body too large" });
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

  it("rate limits uploads per IP (10 per minute)", { timeout: 20_000 }, async () => {
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

  it("supports a production CORS allowlist while keeping non-browser health checks usable", async () => {
    const { base } = await boot({ corsOrigins: ["https://kyx.example"] });
    const allowed = await fetch(`${base}/api/gallery`, { headers: { Origin: "https://kyx.example" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://kyx.example");
    expect(allowed.headers.get("vary")).toContain("Origin");

    const blocked = await fetch(`${base}/api/gallery`, { headers: { Origin: "https://evil.example" } });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "origin is not allowed" });

    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
  });

  it("accepts privacy-safe reports and protects moderation reports/delete behind an admin token", async () => {
    const { base } = await boot({ adminToken: "release-moderator-token" });
    const post = await fetch(`${base}/api/gallery`, {
      method: "POST",
      body: JSON.stringify({ title: "reported beat", code: shareCode() }),
    });
    const { item } = (await post.json()) as { item: { id: string } };

    const report = await fetch(`${base}/api/gallery/${item.id}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "spam\u0000or misleading content" }),
    });
    expect(report.status).toBe(202);

    const publicFeed = (await (await fetch(`${base}/api/gallery`)).json()) as { items: Record<string, unknown>[] };
    expect(publicFeed.items[0]).not.toHaveProperty("reports");
    expect(publicFeed.items[0]).not.toHaveProperty("reporterIp");

    const unauthorized = await fetch(`${base}/api/admin/reports`);
    expect(unauthorized.status).toBe(401);
    const reports = await fetch(`${base}/api/admin/reports`, {
      headers: { Authorization: "Bearer release-moderator-token" },
    });
    expect(reports.status).toBe(200);
    expect(await reports.json()).toMatchObject({
      reports: [{ beatId: item.id, beatTitle: "reported beat", reason: "spam or misleading content" }],
    });

    const blockedDelete = await fetch(`${base}/api/gallery/${item.id}`, { method: "DELETE" });
    expect(blockedDelete.status).toBe(401);
    const deleted = await fetch(`${base}/api/gallery/${item.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer release-moderator-token" },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(((await (await fetch(`${base}/api/gallery`)).json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it("rate limits moderation deletes per source IP", async () => {
    const { base } = await boot({ adminToken: "release-moderator-token" });
    const post = await fetch(`${base}/api/gallery`, {
      method: "POST",
      body: JSON.stringify({ title: "delete-limit beat", code: shareCode() }),
    });
    const { item } = (await post.json()) as { item: { id: string } };

    const responses = await Promise.all(
      Array.from({ length: 11 }, () =>
        fetch(`${base}/api/gallery/${item.id}`, {
          method: "DELETE",
          headers: { Authorization: "Bearer release-moderator-token" },
        }),
      ),
    );
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 404)).toHaveLength(9);
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

  it("bounds rooms and connections and exposes live health metrics", async () => {
    const galleryFile = join(mkdtempSync(join(tmpdir(), "pf-gallery-limits-")), "gallery.json");
    const collab = createCollabServer({
      galleryFile,
      collabLimits: { maxRooms: 1, maxConnectionsPerRoom: 1 },
    });
    await new Promise<void>((resolve) => collab.server.listen(0, "127.0.0.1", resolve));
    opened.push(collab);
    const { port } = collab.server.address() as AddressInfo;
    const wsBase = `ws://127.0.0.1:${port}`;
    const first = await openWebSocket(`${wsBase}/bounded-room`);

    const healthWhileConnected = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as {
      collab: { rooms: number; connections: number };
    };
    expect(healthWhileConnected.collab).toMatchObject({ rooms: 1, connections: 1 });
    expect(await rejectedWebSocket(`${wsBase}/bounded-room`)).toContain("503");
    expect(await rejectedWebSocket(`${wsBase}/another-room`)).toContain("503");

    await new Promise<void>((resolve) => {
      first.once("close", () => resolve());
      first.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const healthAfterClose = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as {
      collab: { rooms: number; connections: number };
    };
    expect(healthAfterClose.collab).toMatchObject({ rooms: 0, connections: 0 });
  });

  it("rejects malformed room ids and oversized binary messages without taking down the server", async () => {
    const galleryFile = join(mkdtempSync(join(tmpdir(), "pf-gallery-payload-")), "gallery.json");
    const collab = createCollabServer({ galleryFile, collabLimits: { maxMessageBytes: 32 } });
    await new Promise<void>((resolve) => collab.server.listen(0, "127.0.0.1", resolve));
    opened.push(collab);
    const { port } = collab.server.address() as AddressInfo;
    const wsBase = `ws://127.0.0.1:${port}`;

    expect(await rejectedWebSocket(`${wsBase}/%E0%A4%A`)).toContain("400");

    const conn = await openWebSocket(`${wsBase}/payload-room`);
    const closed = new Promise<number>((resolve) => conn.once("close", (code) => resolve(code)));
    conn.send(Buffer.alloc(64));
    expect(await closed).toBe(1009);

    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as {
      ok: boolean;
      collab: { rejectedPayloads: number };
    };
    expect(health.ok).toBe(true);
    expect(health.collab.rejectedPayloads).toBeGreaterThanOrEqual(1);
  });
});

describe("gallery flywheel: plays + remix chain", () => {
  it("counts plays and annotates the feed with remix counts", async () => {
    const { base } = await boot();

    // Seed one parent beat.
    const post = await fetch(`${base}/api/gallery`, {
      method: "POST",
      body: JSON.stringify({ title: "Parent Beat", code: shareCode(), tags: ["house"] }),
    });
    const { item: parent } = (await post.json()) as { item: { id: string } };

    // Plays: each ping returns the running total.
    const play1 = await fetch(`${base}/api/gallery/${parent.id}/play`, { method: "POST" });
    expect(play1.status).toBe(200);
    expect(((await play1.json()) as { plays: number }).plays).toBe(1);
    const play2 = await fetch(`${base}/api/gallery/${parent.id}/play`, { method: "POST" });
    expect(((await play2.json()) as { plays: number }).plays).toBe(2);

    // Remix: child references the parent by id.
    const remixPost = await fetch(`${base}/api/gallery`, {
      method: "POST",
      body: JSON.stringify({ title: "Child Remix", code: shareCode(), parentId: parent.id }),
    });
    expect(remixPost.status).toBe(201);

    const feed = (await (await fetch(`${base}/api/gallery`)).json()) as {
      items: { id: string; title?: string; plays?: number; remixCount: number; parentId?: string | null }[];
    };
    const feedParent = feed.items.find((i) => i.id === parent.id)!;
    const feedChild = feed.items.find((i) => i.title === "Child Remix")!;
    expect(feedParent.plays).toBe(2);
    expect(feedParent.remixCount).toBe(1);
    expect(feedChild.parentId).toBe(parent.id);
    expect(feedChild.remixCount).toBe(0);
  });

  it("rejects unknown parent ids and unknown play targets", async () => {
    const { base } = await boot();
    const badParent = await fetch(`${base}/api/gallery`, {
      method: "POST",
      body: JSON.stringify({ title: "orphan", code: shareCode(), parentId: "does-not-exist" }),
    });
    expect(badParent.status).toBe(400);
    expect(((await badParent.json()) as { error: string }).error).toContain("parentId");

    const badPlay = await fetch(`${base}/api/gallery/nope/play`, { method: "POST" });
    expect(badPlay.status).toBe(404);
  });

  // Explicit timeout with a reason: the test deliberately sleeps 3200 ms to
  // let the debounced gallery save flush, then boots a second server — that
  // is 3.2 s of mandated wait inside vitest's default 5 s budget. On a loaded
  // machine the remaining margin goes negative (the observed flake), so the
  // timeout must exceed the deliberate wait, not the other way around.
  it("persists plays across a server restart (debounced save flushes)", { timeout: 20_000 }, async () => {
    const first = await boot();
    const post = await fetch(`${first.base}/api/gallery`, {
      method: "POST",
      body: JSON.stringify({ title: "played beat", code: shareCode() }),
    });
    const { item } = (await post.json()) as { item: { id: string } };
    await fetch(`${first.base}/api/gallery/${item.id}/play`, { method: "POST" });
    // Force the debounced write by saving through a second add on the SAME store…
    await new Promise((r) => setTimeout(r, 3200));

    const collab2 = createCollabServer({ galleryFile: first.galleryFile });
    await new Promise<void>((resolve) => collab2.server.listen(0, "127.0.0.1", resolve));
    opened.push(collab2);
    const { port } = collab2.server.address() as AddressInfo;
    const feed = (await (await fetch(`http://127.0.0.1:${port}/api/gallery`)).json()) as {
      items: { id: string; plays?: number }[];
    };
    expect(feed.items.find((i) => i.id === item.id)?.plays).toBe(1);
  });
});
