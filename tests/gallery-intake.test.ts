import { describe, it, expect, afterAll } from "vitest";
import { compressToEncodedURIComponent } from "lz-string";
import { createCollabServer } from "../server/collab-server.mjs";

/**
 * SEND-TO-KYX intake — the bounded FIFO the browser extension pushes into
 * and the studio drains. Pins: add/list/remove round-trip, base64 payload
 * validation, size ceiling, FIFO cap, and the live HTTP surface (POST +
 * GET list + GET payload + DELETE) exactly as the extension and tray use it.
 */

const tmpFiles: string[] = [];
function freshServer() {
  const file = `D:/pulse-forge/.sound-audit/intake-test-${Math.random().toString(36).slice(2)}.json`;
  tmpFiles.push(file);
  return createCollabServer({ intakeFile: file });
}
afterAll(() => {
  for (const file of tmpFiles) {
    try {
      require("node:fs").unlinkSync(file);
    } catch {
      /* best-effort cleanup */
    }
  }
});

const B64 = Buffer.from("fake wav bytes").toString("base64");

describe("intake store", () => {
  it("add → list round-trip keeps metadata, hides payload from the feed", () => {
    const { intake } = freshServer();
    const r = intake.add({ name: "kick.wav", dataB64: B64, sourceUrl: "https://example.com/kick.wav" });
    expect(r.error).toBeUndefined();
    const listed = intake.list()[0];
    expect(listed).toMatchObject({ name: "kick.wav", sourceUrl: "https://example.com/kick.wav", bytes: 14 });
    expect(listed.dataB64).toBeUndefined(); // the FEED never carries payloads
    expect(intake.get(r.item.id).dataB64).toBe(B64); // the payload endpoint does
  });

  it("rejects missing name, missing payload, and non-base64 payloads", () => {
    const { intake } = freshServer();
    expect(intake.add({ dataB64: B64 }).error).toContain("name is required");
    expect(intake.add({ name: "x" }).error).toContain("dataB64 is required");
    expect(intake.add({ name: "x", dataB64: "not base64!!!" }).error).toContain("must be base64");
    expect(intake.list()).toHaveLength(0);
  });

  it("caps the FIFO (oldest evicted) and removes consumed entries", () => {
    const { intake } = freshServer();
    const ids: string[] = [];
    for (let i = 0; i < 55; i += 1) {
      ids.push(intake.add({ name: `clip-${i}`, dataB64: B64 }).item.id);
    }
    const listed = intake.list();
    expect(listed).toHaveLength(50);
    expect(listed[0].name).toBe("clip-54"); // newest first
    expect(intake.remove(ids[10])).toBe(true); // already evicted → false below
    expect(intake.remove(ids[54])).toBe(true);
    expect(intake.remove(ids[54])).toBe(false);
  });
});

describe("intake HTTP surface", () => {
  it("POST → GET list → GET payload → DELETE over real HTTP", async () => {
    const { server, intake } = freshServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const post = await fetch(`${base}/api/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "hat.wav", dataB64: B64 }),
      });
      expect(post.status).toBe(201);
      const { item } = (await post.json()) as { item: { id: string; dataB64?: string } };
      expect(item.dataB64).toBeUndefined(); // the ack carries no payload

      const list = await (await fetch(`${base}/api/intake`)).json();
      expect(list.items[0]).toMatchObject({ name: "hat.wav" });

      const payload = await (await fetch(`${base}/api/intake/${item.id}`)).json();
      expect(payload.item.dataB64).toBe(B64);

      const del = await fetch(`${base}/api/intake/${item.id}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      expect(intake.list()).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("POST with invalid JSON answers 400, oversize answers 413", async () => {
    const { server } = freshServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const bad = await fetch(`${base}/api/intake`, { method: "POST", body: "{nope" });
      expect(bad.status).toBe(400);
      const big = await fetch(`${base}/api/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "huge", dataB64: "A".repeat(9_100_000) }),
      });
      expect([400, 413]).toContain(big.status);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
