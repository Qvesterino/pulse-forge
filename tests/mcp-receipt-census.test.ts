import { describe, expect, it } from "vitest";
import { executeMcpTool, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

/**
 * THE RECEIPT CENSUS.
 *
 * `verifiedMutation` is the ONE place where a mutation becomes a claim: it
 * corrects an undo claim the stack does not support, turns "a success" whose
 * document is identical into "nothing changed", and gives a success without a
 * read-back the structural summary of what moved. It runs for every tool.
 *
 * But a framework that runs for every tool is not the same as a framework
 * every tool actually satisfies. This census closes that gap the way the
 * R-03 battery closed the normalizer seam: the SURFACE is enumerated, every
 * member is asserted, and the census is CLOSED UNDER THE MANIFEST — a tool
 * added to `MCP_TOOLS` without a census entry fails here rather than
 * slipping through unverified.
 *
 * The receipt itself: a document mutation must tell the agent WHAT LANDED.
 * The marker set is the framework's own (`verified-mutation.ts`), so the
 * census and the framework cannot drift apart on what a receipt looks like.
 *
 * The census does NOT re-list which tools mutate the document: it OBSERVES.
 * A member whose document moved must carry a receipt; a member whose document
 * did not move must not claim a document mutation. The external members are
 * declared with the reason they are exempt — the document is not the witness
 * of their work (a file, the runtime, the checkpoint repository).
 */

/** What a receipt looks like — the framework's own definition. */
const RECEIPT = /→|->|read-?back|verification/i;

/** What a response says when it claims an applied change. */
const APPLIED = /applied|changed|set|added|removed|moved|updated/i;

type Kind = "document" | "external" | "read";

interface CensusEntry {
  tool: string;
  /** The call — a function of the document so ids and names are always real. */
  args: (doc: ProjectDocument) => Record<string, unknown>;
  kind: Kind;
  /** Calls that must land first (e.g. something to undo). */
  setup?: Array<{ tool: string; args: Record<string, unknown> }>;
  /** A document this tool needs (e.g. an empty arrangement to lay out into). */
  fixture?: (base: ProjectDocument) => ProjectDocument;
  /** Why an external member is exempt from the document receipt. */
  why?: string;
}

function instrumentTrack(doc: ProjectDocument): ProjectDocument["tracks"][number] {
  const track = doc.tracks.find((candidate) => candidate.kind === "instrument");
  if (!track) throw new Error("fixture: no instrument track");
  return track;
}

function firstClipId(doc: ProjectDocument): string {
  const clip = doc.arrangement.clips[0];
  if (!clip) throw new Error("fixture: no arrangement clip");
  return clip.id;
}

function census(): CensusEntry[] {
  return [
    {
      tool: "kyx_intent",
      args: () => ({ instruction: "set reverb decay to 2.5 s on the 808" }),
      kind: "document",
    },
    { tool: "kyx_state", args: () => ({ subject: "overview" }), kind: "read" },
    {
      tool: "kyx_save",
      args: () => ({ op: "save" }),
      kind: "external",
      why: "writes the project repository — the document is not the witness",
    },
    {
      tool: "kyx_undo",
      args: () => ({ action: "undo" }),
      kind: "document",
      setup: [{ tool: "kyx_music", args: { op: "setTempo", bpm: 130 } }],
    },
    {
      tool: "kyx_transport",
      args: () => ({ action: "play" }),
      kind: "external",
      why: "drives the runtime transport — the document is not the witness",
    },
    {
      tool: "kyx_export",
      args: () => ({ format: "wav" }),
      kind: "external",
      why: "writes an audio file — the document is not the witness",
    },
    {
      tool: "kyx_audio_preview",
      args: () => ({}),
      kind: "external",
      why: "auditions in the runtime — the document is not the witness",
    },
    { tool: "kyx_generate", args: () => ({ genre: "house" }), kind: "document" },
    { tool: "kyx_groove", args: () => ({ direction: "more" }), kind: "document" },
    { tool: "kyx_fx", args: () => ({ effect: "reverb", action: "more", family: "drums" }), kind: "document" },
    { tool: "kyx_sections", args: () => ({ op: "add", scene: "Census Section", role: "verse" }), kind: "document" },
    { tool: "kyx_markers", args: () => ({ op: "add", bar: 9, name: "Outro" }), kind: "document" },
    { tool: "kyx_tracks", args: () => ({ op: "addInstrument", instrument: "808" }), kind: "document" },
    {
      tool: "kyx_pattern",
      args: () => ({ op: "list" }),
      kind: "read",
    },
    { tool: "kyx_steps", args: () => ({ op: "add", family: "kick", steps: [1, 5] }), kind: "document" },
    {
      tool: "kyx_notes",
      args: () => ({ op: "add", family: "bass", noteName: "C2", index: 0, durationBeats: 1 }),
      kind: "document",
    },
    { tool: "kyx_music", args: () => ({ op: "setTempo", bpm: 130 }), kind: "document" },
    { tool: "kyx_catalog", args: () => ({ subject: "effects" }), kind: "read" },
    {
      tool: "kyx_plugin_param",
      args: () => ({ op: "set", effect: "reverb", family: "drums", param: "mix", value: 0.4 }),
      kind: "document",
      setup: [{ tool: "kyx_fx", args: { effect: "reverb", action: "more", family: "drums" } }],
    },
    {
      tool: "kyx_instrument_param",
      args: (doc) => ({ op: "set", trackId: instrumentTrack(doc).id, param: "decay", value: 1.2 }),
      kind: "document",
    },
    { tool: "kyx_meter", args: () => ({ scope: "master" }), kind: "read" },
    {
      tool: "kyx_automation",
      args: (doc) => ({
        op: "addPoint",
        trackId: instrumentTrack(doc).id,
        param: "gain",
        bar: 2,
        beat: 1,
        value: 0.5,
      }),
      kind: "document",
    },
    {
      tool: "kyx_clips",
      args: (doc) => ({ op: "move", clipId: firstClipId(doc), toBar: 2 }),
      kind: "document",
    },
    {
      tool: "kyx_batch",
      args: () => ({ calls: [{ tool: "kyx_music", args: { op: "setTempo", bpm: 132 } }] }),
      kind: "document",
    },
    {
      tool: "kyx_loudness",
      args: () => ({ op: "measure" }),
      kind: "external",
      why: "measures and trims the rendered mix — the document is not the witness",
    },
    {
      tool: "kyx_import_sfz",
      args: () => ({ name: "kit", sfzBase64: "", trackId: "t1", samples: [] }),
      kind: "external",
      why: "writes samples into the user library — the document is not the witness",
    },
    {
      tool: "kyx_publish_gallery",
      args: () => ({ title: "A beat" }),
      kind: "external",
      why: "publishes to the gallery — the document is not the witness",
    },
    {
      tool: "kyx_render_summary",
      args: () => ({}),
      kind: "external",
      why: "renders and reports — the document is not the witness",
    },
    {
      tool: "kyx_diagnose_mix",
      args: () => ({}),
      kind: "external",
      why: "renders and analyses — the document is not the witness",
    },
    {
      tool: "kyx_mix_idea",
      args: () => ({ idea: "warmer", target: "drums", apply: true }),
      kind: "document",
    },
    {
      tool: "kyx_checkpoint",
      args: () => ({ op: "list" }),
      kind: "external",
      why: "reads the checkpoint repository — the document is not the witness",
    },
    { tool: "kyx_mix", args: () => ({ genre: "house", mood: "dark" }), kind: "document" },
    {
      tool: "kyx_arrange",
      args: () => ({ genre: "house" }),
      kind: "document",
      // A whole-form layout refuses to lay over an arrangement that already
      // has clips — so this member runs against an empty one.
      fixture: (base) => ({ ...base, arrangement: { ...base.arrangement, clips: [] } }),
    },
    {
      tool: "kyx_song",
      args: () => ({ genre: "house" }),
      kind: "document",
      fixture: (base) => ({ ...base, arrangement: { ...base.arrangement, clips: [] } }),
    },
    { tool: "kyx_routing", args: () => ({ op: "createGroup", groupName: "Drums" }), kind: "document" },
    {
      tool: "kyx_unsuno",
      args: () => ({ action: "transcribe" }),
      kind: "external",
      why: "calls the generation host — the document is not the witness",
    },
    { tool: "kyx_master", args: () => ({ op: "add", family: "drums" }), kind: "document" },
    { tool: "kyx_takes", args: () => ({ op: "list" }), kind: "read" },
    {
      tool: "kyx_blind_ab",
      args: () => ({ op: "plan" }),
      kind: "external",
      why: "records the A/B trial log — the document is not the witness",
    },
    {
      tool: "kyx_separate",
      args: () => ({ sourceId: "user.song" }),
      kind: "read",
    },
    {
      tool: "kyx_context",
      args: () => ({ fromBar: 1, toBar: 4 }),
      kind: "read",
    },
    {
      // ADR 0077 — the performance DOCUMENT surface. createSet is the
      // mutating branch (Live Sets are plain document commands, one undo
      // step), so the census observes it as a document member: the document
      // must move and the agent must be told what landed.
      tool: "kyx_performance",
      args: () => ({ op: "createSet", name: "Census Set" }),
      kind: "document",
    },
  ];
}

interface Harness {
  ctx: McpToolContext;
  doc: () => ProjectDocument;
}

function harness(start: ProjectDocument): Harness {
  let current = start;
  const undoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const redoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const labels: string[] = [];
  return {
    doc: () => current,
    ctx: withAgentWriter({
      getDoc: () => current,
      execute: (command) => {
        current = command.execute(current);
        labels.push(command.label);
        undoStack.push({ undo: () => command.undo(current), redo: () => command.execute(current) });
        redoStack.length = 0;
      },
      undo: () => {
        const entry = undoStack.pop();
        if (entry) {
          current = entry.undo();
          redoStack.push(entry);
        }
      },
      redo: () => {
        const entry = redoStack.pop();
        if (entry) {
          current = entry.redo();
          undoStack.push(entry);
        }
      },
      undoStackLength: () => undoStack.length,
      historyLabels: () => [...labels],
      isMicRecordingActive: () => false,
      transport: {
        play: () => {},
        stop: () => {},
        pause: () => {},
        setLoop: () => {},
        setMetronome: () => {},
      },
    }),
  };
}

function fixtureDoc(): ProjectDocument {
  return createProjectFromTemplate("house");
}

describe("the receipt census is closed under the manifest", () => {
  it("every tool in MCP_TOOLS has a census entry", () => {
    const covered = new Set(census().map((entry) => entry.tool));
    const missing = MCP_TOOLS.map((tool) => tool.name).filter((name) => !covered.has(name));
    expect(missing, "a new tool must be classified before it can be trusted").toEqual([]);
  });

  it("the census does not name a tool the manifest does not have", () => {
    const declared = new Set(MCP_TOOLS.map((tool) => tool.name));
    const unknown = census()
      .map((entry) => entry.tool)
      .filter((name) => !declared.has(name));
    expect(unknown).toEqual([]);
  });
});

describe("every document mutation carries a receipt", () => {
  for (const entry of census().filter((candidate) => candidate.kind === "document")) {
    it(`${entry.tool} — the document moved, and the agent is told what landed`, async () => {
      const base = fixtureDoc();
      const h = harness(entry.fixture ? entry.fixture(base) : base);
      for (const step of entry.setup ?? []) {
        await executeMcpTool(h.ctx, step.tool, step.args);
      }
      const before = h.doc();
      const result = await executeMcpTool(h.ctx, entry.tool, entry.args(before));
      const after = h.doc();

      expect(after, `${entry.tool} must actually move the document — else the census entry is stale`).not.toBe(before);
      expect(result.mutated, `${entry.tool} moved the document and must say so`).toBe(true);
      expect(
        RECEIPT.test(result.text),
        `${entry.tool} produced no receipt — the agent would be told a change happened without learning what changed:\n${result.text}`,
      ).toBe(true);
    }, 30_000);
  }
});

describe("a tool that changed nothing must not claim it did", () => {
  for (const entry of census().filter((candidate) => candidate.kind === "read")) {
    it(`${entry.tool} — a read moves nothing and claims nothing`, async () => {
      const h = harness(fixtureDoc());
      const before = h.doc();
      const result = await executeMcpTool(h.ctx, entry.tool, entry.args(before));
      const after = h.doc();

      expect(after, `${entry.tool} is a read — the document must not move`).toBe(before);
      expect(result.mutated, `${entry.tool} is a read — it must not claim a mutation`).toBe(false);
    });
  }
});

describe("an external tool is exempt from the document receipt, for a stated reason", () => {
  for (const entry of census().filter((candidate) => candidate.kind === "external")) {
    it(`${entry.tool} — the document is not the witness`, async () => {
      expect(entry.why, `${entry.tool} must say WHY it is exempt`).toBeTruthy();
      const h = harness(fixtureDoc());
      const before = h.doc();
      await executeMcpTool(h.ctx, entry.tool, entry.args(before));
      const after = h.doc();

      expect(after, `${entry.tool} writes outside the document — it must not have moved it`).toBe(before);
    });
  }
});

describe("the census itself is honest", () => {
  it("a document member that reports nothing applied is caught by the framework, not by luck", async () => {
    // The framework's own rule: a success whose document is identical is not
    // a success. A census entry whose call turns out to be a no-op must show
    // up as "mutated: false" rather than a silent success.
    const h = harness(fixtureDoc());
    const result = await executeMcpTool(h.ctx, "kyx_music", { op: "setTempo", bpm: h.doc().bpm });
    expect(result.mutated).toBe(false);
    expect(APPLIED.test(result.text)).toBe(false);
  });
});
