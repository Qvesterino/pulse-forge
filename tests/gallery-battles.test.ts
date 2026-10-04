/**
 * Gallery battles — the blind A/B preference tournament API.
 *
 * Boots createCollabServer() on an ephemeral port (temp gallery + battle
 * files), publishes beats through the real POST /api/gallery, and drives the
 * battle surface with real fetch: blind pairs, vote → Elo movement + reveal,
 * one-vote-per-pair-per-session dedupe, leaderboard ordering, and the
 * training export (pairs + outcomes, no voter identities).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { compressToEncodedURIComponent } from "lz-string";
import { createCollabServer } from "../server/collab-server.mjs";
import { createProjectFromTemplate } from "../src/project-model/templates";

type CollabServer = ReturnType<typeof createCollabServer>;

const opened: CollabServer[] = [];

async function boot(): Promise<{ base: string; collab: CollabServer; battlesFile: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pf-battles-"));
  const galleryFile = join(dir, "gallery.json");
  const battlesFile = join(dir, "gallery-battles.json");
  const collab = createCollabServer({ galleryFile, battlesFile });
  await new Promise<void>((resolve) => collab.server.listen(0, "127.0.0.1", resolve));
  opened.push(collab);
  const { port } = collab.server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, collab, battlesFile };
}

afterEach(() => {
  for (const collab of opened.splice(0)) collab.server.close();
});

function shareCode(): string {
  return compressToEncodedURIComponent(JSON.stringify(createProjectFromTemplate("house")));
}

async function publish(base: string, title: string): Promise<{ id: string; title: string }> {
  const res = await fetch(`${base}/api/gallery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, author: "tester", tags: ["test"], code: shareCode() }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { item: { id: string; title: string } };
  return body.item;
}

interface PairBody {
  pair: { a: { id: string; code: string }; b: { id: string; code: string } } | null;
}

async function vote(
  base: string,
  a: string,
  b: string,
  winner: string,
  session: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/gallery/battles/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ a, b, winner, session }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("gallery battles — Elo-ordered feed", () => {
  it("sort=battles orders by Elo with never-battled beats after, default stays newest-first", async () => {
    const { base } = await boot();
    const champ = await publish(base, "Feed Champ"); // newest of the three
    const middle = await publish(base, "Feed Middle");
    const fresh = await publish(base, "Never Battled");
    await vote(base, middle.id, champ.id, "b", "feed-1"); // champ gains Elo

    const battleSort = await (await fetch(`${base}/api/gallery?sort=battles`)).json();
    const titles = (battleSort as { items: Array<{ title: string; elo: number | null }> }).items.map((i) => i.title);
    expect(titles).toEqual(["Feed Champ", "Feed Middle", "Never Battled"]);
    for (const item of (battleSort as { items: Array<{ elo: number | null }> }).items) {
      expect(typeof item.elo === "number" || item.elo === null).toBe(true);
    }

    // Default order is untouched — newest first regardless of battles.
    const def = await (await fetch(`${base}/api/gallery`)).json();
    expect((def as { items: Array<{ title: string }> }).items.map((i) => i.title)).toEqual([
      "Never Battled",
      "Feed Middle",
      "Feed Champ",
    ]);
    // Unknown sort falls back to new.
    const weird = await (await fetch(`${base}/api/gallery?sort=chaos`)).json();
    expect((weird as { sort?: string }).sort).toBe("new");
    void fresh;
  });
});

describe("gallery battles — blind pair endpoint", () => {
  it("refuses to build a pair from an empty gallery", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/gallery/battles/pair`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PairBody;
    expect(body.pair).toBeNull();
  });

  it("returns two distinct beats with codes and NO titles — blindness is server-side", async () => {
    const { base } = await boot();
    await publish(base, "Beat One");
    await publish(base, "Beat Two");
    await publish(base, "Beat Three");
    const res = await fetch(`${base}/api/gallery/battles/pair`);
    const body = (await res.json()) as PairBody;
    expect(body.pair).not.toBeNull();
    const { a, b } = body.pair!;
    expect(a.id).not.toBe(b.id);
    expect(typeof a.code).toBe("string");
    expect(a.code.length).toBeGreaterThan(0);
    for (const side of [a, b]) {
      const keys = Object.keys(side).sort();
      expect(keys).toEqual(["code", "id"]);
    }
  });
});

describe("gallery battles — voting, Elo, reveal", () => {
  it("moves Elo toward the winner and reveals titles only in the vote response", async () => {
    const { base } = await boot();
    const one = await publish(base, "Winner");
    const two = await publish(base, "Loser");
    const { status, body } = await vote(base, one.id, two.id, "a", "session-1");
    expect(status).toBe(201);
    const reveal = (body as { reveal: { a: { title: string }; b: { title: string } } }).reveal;
    expect(reveal.a.title).toBe("Winner");
    expect(reveal.b.title).toBe("Loser");
    const ratings = (
      body as {
        ratings: { a: { elo: number; wins: number; losses: number }; b: { elo: number; wins: number; losses: number } };
      }
    ).ratings;
    expect(ratings.a.elo).toBeGreaterThan(1000);
    expect(ratings.b.elo).toBeLessThan(1000);
    expect(ratings.a.wins).toBe(1);
    expect(ratings.b.losses).toBe(1);
  });

  it("keeps ratings on ties and logs both_weak without touching Elo", async () => {
    const { base } = await boot();
    const one = await publish(base, "Tie A");
    const two = await publish(base, "Tie B");
    const tie = await vote(base, one.id, two.id, "tie", "s-tie");
    expect(tie.status).toBe(201);
    const ratings = (tie.body as { ratings: { a: { elo: number; ties: number }; b: { elo: number; ties: number } } })
      .ratings;
    expect(ratings.a.elo).toBeCloseTo(1000, 6);
    expect(ratings.b.elo).toBeCloseTo(1000, 6);
    expect(ratings.a.ties).toBe(1);

    const weak = await vote(base, one.id, two.id, "both_bad", "s-weak");
    expect(weak.status).toBe(201);
    const weakRatings = (
      weak.body as {
        ratings: { a: { elo: number; bothBad: number; ties: number }; b: { elo: number; bothBad: number } };
      }
    ).ratings;
    expect(weakRatings.a.elo).toBeCloseTo(1000, 6);
    expect(weakRatings.a.bothBad).toBe(1);
    expect(weakRatings.b.bothBad).toBe(1);
    expect(weakRatings.a.ties).toBe(1); // untouched by the both_weak vote
  });

  it("deduplicates one vote per pair per session (409) and validates input", async () => {
    const { base } = await boot();
    const one = await publish(base, "Dedupe A");
    const two = await publish(base, "Dedupe B");
    expect((await vote(base, one.id, two.id, "a", "s1")).status).toBe(201);
    // Same pair, same session — regardless of listing order.
    expect((await vote(base, one.id, two.id, "a", "s1")).status).toBe(409);
    expect((await vote(base, two.id, one.id, "b", "s1")).status).toBe(409);
    // A different session may judge the same battle.
    expect((await vote(base, one.id, two.id, "a", "s2")).status).toBe(201);

    expect((await vote(base, one.id, one.id, "a", "s3")).status).toBe(400);
    expect((await vote(base, "nope", two.id, "a", "s3")).status).toBe(400);
    expect((await vote(base, one.id, two.id, "winner takes all", "s3")).status).toBe(400);
    expect((await vote(base, one.id, two.id, "a", "")).status).toBe(400);
  });

  it("orders the leaderboard by Elo and lists only battled beats", async () => {
    const { base } = await boot();
    const one = await publish(base, "Champ");
    const two = await publish(base, "Chump");
    await publish(base, "Never Battled");
    await vote(base, one.id, two.id, "a", "lb-1");
    const res = await fetch(`${base}/api/gallery/battles/leaderboard`);
    const body = (await res.json()) as {
      leaders: Array<{ id: string; title: string; elo: number; battles: number }>;
    };
    expect(body.leaders).toHaveLength(2);
    expect(body.leaders[0]!.id).toBe(one.id);
    expect(body.leaders[0]!.elo).toBeGreaterThan(body.leaders[1]!.elo);
    expect(body.leaders.map((row) => row.title)).not.toContain("Never Battled");
  });

  it("exports the training log as pairs + outcomes without voter sessions", async () => {
    const { base } = await boot();
    const one = await publish(base, "Export A");
    const two = await publish(base, "Export B");
    await vote(base, one.id, two.id, "a", "secret-session");
    const res = await fetch(`${base}/api/gallery/battles/export`);
    const body = (await res.json()) as { votes: Array<Record<string, unknown>> };
    expect(body.votes).toHaveLength(1);
    const entry = body.votes[0]!;
    expect(entry.a).toBe(one.id);
    expect(entry.b).toBe(two.id);
    expect(entry.winner).toBe("a");
    expect(typeof entry.createdAt).toBe("string");
    expect(Object.keys(entry)).not.toContain("session");
  });

  it("persists votes across a server restart — the flywheel outlives the process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-battles-restart-"));
    const galleryFile = join(dir, "gallery.json");
    const battlesFile = join(dir, "gallery-battles.json");
    const first = createCollabServer({ galleryFile, battlesFile });
    await new Promise<void>((resolve) => first.server.listen(0, "127.0.0.1", resolve));
    const { port } = first.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const one = await publish(base, "Persist A");
    const two = await publish(base, "Persist B");
    expect((await vote(base, one.id, two.id, "a", "restart-s")).status).toBe(201);
    first.server.close();

    const second = createCollabServer({ galleryFile, battlesFile });
    await new Promise<void>((resolve) => second.server.listen(0, "127.0.0.1", resolve));
    opened.push(second);
    const base2 = `http://127.0.0.1:${(second.server.address() as AddressInfo).port}`;
    // Same session votes the same pair again → the dedupe index survived.
    expect((await vote(base2, one.id, two.id, "a", "restart-s")).status).toBe(409);
  });
});
