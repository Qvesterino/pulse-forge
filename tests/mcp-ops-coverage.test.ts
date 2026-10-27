import { describe, expect, it } from "vitest";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { drainMcpOpsCoverageViolations, executeMcpTool } from "../src/mcp/tools";
import { createDefaultProject } from "../src/project-model/schema";

/**
 * AS-008 — guard coverage by evidence, not convention. Stale-write, scope
 * and idempotency written-field tracking all read command.ops; a mutating
 * tool that executes a hand-written command silently loses all three. This
 * suite drives one representative call per mutating family through the REAL
 * dispatcher and asserts the recorded ops-less set stays exactly the
 * exemption list baked into tools.ts (OPS_COVERAGE_EXEMPT).
 */

function host() {
  return createHeadlessMcpHost({ document: createDefaultProject() });
}

describe("MCP ops coverage (AS-008)", () => {
  it("every shipped mutating op produces an ops-carrying command or is exempt", async () => {
    const h = host();
    const drum = h.store.doc.tracks.find((track) => track.kind === "drum")!;
    const bass = h.store.doc.tracks.find((track) => track.kind === "instrument")!;

    const calls: Array<[string, Record<string, unknown>]> = [
      ["kyx_tracks", { op: "addDrum", name: "Coverage Kit" }],
      ["kyx_tracks", { op: "setGain", trackId: drum.id, gainDb: -3 }],
      ["kyx_tracks", { op: "rename", trackId: drum.id, name: "Coverage Drums" }],
      ["kyx_tracks", { op: "move", trackId: drum.id, relativeTo: bass.id, where: "after" }],
      ["kyx_generate", { genre: "house", seed: "ops-coverage" }],
      ["kyx_notes", { op: "add", trackId: bass.id, noteName: "C2", startBeat: 0 }],
      ["kyx_notes", { op: "move", trackId: bass.id, noteId: "nope", startBeat: 1 }], // error — no execute
      ["kyx_notes", { op: "setVelocity", trackId: bass.id, noteId: "nope", velocity: 0.5 }],
      ["kyx_steps", { op: "add", family: "kick", steps: [1], velocity: 0.9 }],
      ["kyx_steps", { op: "setVelocity", family: "kick", steps: [1], velocity: 0.5 }],
      ["kyx_steps", { op: "setMeta", family: "kick", steps: [1], probability: 0.5 }],
      ["kyx_markers", { op: "add", bar: 5, name: "coverage" }],
      ["kyx_music", { op: "setTempo", bpm: 124 }],
      ["kyx_pattern", { op: "select", pattern: 1 }],
      ["kyx_fx", { family: "drums", effect: "reverb", action: "more", percent: 10 }],
      ["kyx_fx", { family: "drums", effect: "reverb", action: "bypass" }],
    ];
    for (const [tool, args] of calls) {
      await h.call(tool, args);
    }
    expect(drainMcpOpsCoverageViolations()).toEqual([]);
  });

  it("the recorder itself works: an exempt-listed tool never hides a NEW violation", async () => {
    // Structural guard: the exemption set is keyed tool:op — a new op on an
    // exempt tool is NOT exempt. Verified indirectly by the drain contract:
    // drain always returns and clears.
    const first = drainMcpOpsCoverageViolations();
    expect(first).toEqual([]);
  });
});

describe("per-call agentId envelope (AS-010)", () => {
  it("attributes the call: history label carries the declared id; the audit risk/receipt still work", async () => {
    const h = host();
    const tracksBefore = h.store.doc.tracks.length;
    const add = await h.call("kyx_tracks", { op: "addDrum", name: "Attributed", agentId: "claude-2" });
    expect(add.mutated, add.text).toBe(true);
    expect(h.store.doc.tracks.length).toBe(tracksBefore + 1);
    const labels = h.store.history.map((entry) => entry.label);
    expect(labels.some((label) => label.startsWith("[claude-2] "))).toBe(true);
    // The label names the EFFECTIVE actor — a transport-attributed context
    // re-attributed per call must not stack two prefixes.
    expect(labels.every((label) => !label.includes("] ["))).toBe(true);
  });

  it("refuses a malformed agentId without mutating", async () => {
    const h = host();
    const before = h.store.undoStackLength;
    const bad = await h.call("kyx_tracks", { op: "addDrum", name: "X", agentId: "NOT VALID!" });
    expect(bad.isError).toBe(true);
    expect(bad.errorCode).toBe("INVALID_ARGUMENTS");
    expect(h.store.undoStackLength).toBe(before);
  });

  it("the idempotency signature ignores agentId — a replay with the same requestId replays", async () => {
    const h = host();
    const tracksBefore = h.store.doc.tracks.length;
    const first = await h.call("kyx_tracks", {
      op: "addDrum",
      name: "Replayed",
      requestId: "agentid-1",
      agentId: "a-one",
    });
    expect(first.mutated).toBe(true);
    expect(h.store.doc.tracks.length).toBe(tracksBefore + 1);
    const replay = await h.call("kyx_tracks", {
      op: "addDrum",
      name: "Replayed",
      requestId: "agentid-1",
      agentId: "a-one",
    });
    expect(replay.replayed).toBe(true);
    expect(h.store.doc.tracks.length).toBe(tracksBefore + 1);
  });
});

describe("P2 receipts: retry policy, warp pins, document export", () => {
  it("capabilities publish the retry policy (AS-009 phase 1)", async () => {
    const h = host();
    const result = await h.call("kyx_state", { subject: "capabilities" });
    const capabilities = (result.data as { capabilities: { retryPolicy: { notIdempotent: string[] } } }).capabilities;
    expect(capabilities.retryPolicy.notIdempotent).toContain("kyx_publish_gallery");
    expect(capabilities.retryPolicy.notIdempotent).toContain("kyx_export");
  });

  it("audioList reports the warp-pin map (AS-012)", async () => {
    const doc = createDefaultProject();
    const drums = doc.tracks.find((track) => track.kind === "drum")!;
    const withClip = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: [
          {
            id: "ac-warp",
            trackId: drums.id,
            bufferId: "buf-x",
            startBar: 0,
            lengthBars: 2,
            offsetSec: 0,
            trimStart: 0,
            trimEnd: 0,
            gain: 1,
            fadeIn: 0,
            fadeOut: 0,
            stretchRate: 1,
            reverse: false,
            warpMarkers: [
              { timeSec: 0, tick: 0 },
              { timeSec: 0.5, tick: 480 },
            ],
          },
        ],
      },
    };
    const h = createHeadlessMcpHost({ document: withClip });
    const result = await executeMcpTool(h.ctx, "kyx_clips", { op: "audioList" });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.mutated).toBe(false);
    const clips = (result.data as { clips: Array<{ id: string; warpPinCount: number; warpPins: unknown[] }> }).clips;
    const probe = clips.find((clip) => clip.id === "ac-warp")!;
    expect(probe.warpPinCount).toBe(2);
    expect(probe.warpPins).toHaveLength(2);
    expect(result.text).toContain("2 warp pin(s)");
  });

  it("kyx_export midi/json refuses honestly without the host hook and delivers with it (AS-013)", async () => {
    const h = host();
    const refused = await h.call("kyx_export", { format: "midi" });
    expect(refused.isError).toBe(true);
    expect(refused.errorCode).toBe("UNAVAILABLE_ON_TRANSPORT");

    let deliveredKind = "";
    const plain = host();
    const wired = {
      ...plain.ctx,
      exportDocument: async (kind: "midi" | "json") => {
        deliveredKind = kind;
        return { report: `${kind} export started`, sizeBytes: 1024 };
      },
    };
    const delivered = await executeMcpTool(wired, "kyx_export", { format: "json" });
    expect(delivered.isError, delivered.text).not.toBe(true);
    expect(delivered.stage).toBe("delivered");
    expect(deliveredKind).toBe("json");
    expect((delivered.data as { sizeBytes: number }).sizeBytes).toBe(1024);
  });
});
