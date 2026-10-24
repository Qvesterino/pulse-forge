import { describe, it, expect } from "vitest";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import {
  applyParamIntent,
  parseParamIntent,
  paramPlanLines,
  paramReadback,
  paramReadbackReport,
} from "../src/intent/param-intent";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * THE PARAM READ-BACK — the AI's window onto a knob it did not touch itself.
 *
 * Three defects met here, all of them the same shape: a mutation that
 * happened, and a report that did not describe it.
 *
 *  1. TWO RESOLVERS. The plan and the read-back resolved the family
 *     vocabulary by NAME REGEX; the APPLY resolved it by ROLE (with a
 *     positional fallback) and, for "vocal", by ARRANGEMENT CLIP BINDING.
 *     A "Sub" at instrument index 0 IS the bass by position; a take called
 *     "Take 1" IS the vocal by its clip binding. The old resolver found
 *     neither, so the plan said "no matching track" while the apply quietly
 *     changed a track, and the read-back reported that nothing happened.
 *
 *  2. NO READ-BACK OVER MCP. The MCP `kyx_intent` param branch printed the
 *     words "verification: applied" and never read a single value back. The
 *     UI's same branch DID read back (and could even render-verify the
 *     audible delta) — the agent got the weaker surface.
 *
 *  3. SILENT PARTIALS. An ask naming two targets, one of which does not
 *     exist, applied to the one that does and reported success. The target it
 *     missed was never named.
 *
 * Every case below FAILS on the pre-fix code — that is the point of the file.
 */

/** MCP context over the real command layer (the house harness shape). */
function makeCtx(doc: ProjectDocument): McpToolContext {
  let current = doc;
  const undoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const redoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const labels: string[] = [];
  return {
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
  };
}

/** Rename the instrument tracks (in order) — the POSITION stays the same. */
function withInstrumentNames(doc: ProjectDocument, names: string[]): ProjectDocument {
  let index = 0;
  return {
    ...doc,
    tracks: doc.tracks.map((track) =>
      track.kind === "instrument" ? { ...track, name: names[index++] ?? track.name } : track,
    ),
  };
}

/**
 * A take called "Take 1" — the word "vocal" appears nowhere in it. The
 * arrangement clip binding is what makes it the vocal track.
 */
function withVocalTake(doc: ProjectDocument): ProjectDocument {
  const target = doc.tracks.find((track) => track.kind === "instrument");
  if (!target) throw new Error("fixture: no instrument track to carry the take");
  return {
    ...doc,
    tracks: doc.tracks.map((track) => (track.id === target.id ? { ...track, name: "Take 1" } : track)),
    arrangement: {
      ...doc.arrangement,
      audioClips: [
        {
          id: "take-clip-1",
          trackId: target.id,
          bufferId: "take-buffer-1",
          startBar: 0,
          lengthBars: 4,
          offsetSec: 0,
          trimStart: 0,
          trimEnd: 0,
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
          stretchRate: 1,
          reverse: false,
        },
      ],
    },
  };
}

const mustParse = (text: string) => {
  const intent = parseParamIntent(text);
  if (!intent) throw new Error(`fixture: "${text}" did not parse as a param intent`);
  return intent;
};

describe("the param family vocabulary has ONE resolver", () => {
  it("finds a bass that is a POSITION, not a name — and says so in the plan", () => {
    // "Sub" carries no "bas" and no "808": the old name regex found nothing.
    const doc = withInstrumentNames(testDoc(), ["Sub", "Chords"]);
    const intent = mustParse("set reverb decay to 2.5 s on the bass");

    const plan = paramPlanLines(intent, doc).join(" ");
    expect(plan, "the plan must not claim a missing track").not.toContain("no matching track");
    expect(plan).toContain("Sub");

    const after = applyParamIntent(doc, intent).execute(doc);
    const readback = paramReadback(doc, after, intent);
    expect(readback, "the read-back must name the track that changed").toContain("Sub");
    expect(readback).toContain("2.5");
  });

  it("finds a vocal by its ARRANGEMENT CLIP BINDING, not by the word in its name", () => {
    const doc = withVocalTake(testDoc());
    const intent = mustParse("set reverb decay to 2.5 s on the vocals");

    const plan = paramPlanLines(intent, doc).join(" ");
    expect(plan).not.toContain("no matching track");
    expect(plan).toContain("Take 1");

    const after = applyParamIntent(doc, intent).execute(doc);
    expect(paramReadback(doc, after, intent)).toContain("Take 1");
  });

  it("names EVERY track the apply changed, not just the first", () => {
    // Two tracks carry the name "bass" — the apply writes to both.
    const doc = withInstrumentNames(testDoc(), ["Bass A", "Bass B"]);
    const intent = mustParse("set reverb decay to 2.5 s on the bass");
    const after = applyParamIntent(doc, intent).execute(doc);

    const readback = paramReadback(doc, after, intent);
    expect(readback).toContain("Bass A");
    expect(readback).toContain("Bass B");
  });

  it("keeps the idempotent re-apply on the mix layer's honest 'changed nothing'", () => {
    const doc = testDoc();
    const intent = mustParse("set reverb decay to 2.5 s on the 808");
    const after = applyParamIntent(doc, intent).execute(doc);
    expect(() => applyParamIntent(after, intent).execute(after)).toThrow(/changed nothing/i);
  });
});

describe("the MCP param branch reads the value back", () => {
  it("reports the value that landed, not the bare claim that it did", async () => {
    const ctx = makeCtx(testDoc());
    const result = await executeMcpTool(ctx, "kyx_intent", {
      instruction: "set reverb decay to 2.5 s on the 808",
    });

    expect(result.mutated).toBe(true);
    expect(result.text).toContain("reverb.decay");
    expect(result.text).toContain("2.5");
    // The old text claimed "verification: applied" without verifying anything.
    expect(result.text).not.toContain("verification: applied");
    expect(result.text).toContain("read-back");
  });

  it("names the target it could not resolve instead of reporting a clean success", async () => {
    const ctx = makeCtx(testDoc());
    const result = await executeMcpTool(ctx, "kyx_intent", {
      instruction: "set reverb decay to 2.5 s on the 808 and the vocals",
    });

    expect(result.mutated).toBe(true);
    expect(result.text).toContain("skipped");
    expect(result.text).toContain("skipped vocal");
    expect((result.data as { status?: string } | undefined)?.status).toBe("partial");
  });

  it("does not claim the mix 'already matches' when the track simply does not exist", async () => {
    const ctx = makeCtx(testDoc());
    const result = await executeMcpTool(ctx, "kyx_intent", {
      instruction: "set reverb decay to 2.5 s on the vocals",
    });

    expect(result.isError).toBe(true);
    expect(result.text, "the old message asserted a state that was not true").not.toContain("already matches");
    expect(result.text).toContain("no track in this project matches");
  });
});

describe("the read-back report separates what moved from what was missed", () => {
  it("buckets a missed target separately from a moved one", () => {
    const doc = testDoc();
    const intent = mustParse("set reverb decay to 2.5 s on the 808 and the vocals");
    const after = applyParamIntent(doc, intent).execute(doc);
    const report = paramReadbackReport(doc, after, intent);

    expect(report.moved.join(" ")).toContain("808");
    expect(report.skipped).toContain("vocal");
    expect(report.unchanged).not.toContain("808");
  });
});
