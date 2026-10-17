/**
 * SESSION STORY — the readable account of how a beat came to be.
 *
 * The session tape is a strip of chips; the selection reasons are tooltips; the
 * reaction verdicts live in a learning ledger. This module joins them into one
 * markdown page a producer can hand to a collaborator: every step in order,
 * WHY it turned out that way (only when the reason was measured), what was kept
 * or reverted, which models are in the mix, and the hash of the export.
 *
 * ── The honesty rule, enforced here ─────────────────────────────────────────
 * A step with no measured rationale prints NOTHING about why. No "the engine
 * chose the best option" filler: the story is a record, not a brochure. The
 * verdict join goes through the SAME generation identity the rerank fit uses
 * (`rerankGenerationId`), so a claim in the story is anchored to data that
 * another system already checks.
 *
 * Everything is pure apart from the collector (`collectSessionStoryInput`),
 * which reads the live stores and degrades each read to null independently —
 * a story is exactly the thing you open when something is missing.
 */
import type { ReactionEntry } from "../intent/reaction-ledger";
import type { TapeOutcome, TapeStep } from "../intent/session-tape";
import type { Services } from "../services";
import { tapeSteps } from "../intent/session-tape";
import { activeReactionLedger } from "../intent/reaction-ledger";
import { buildReactionReport } from "../intent/reaction-learning";
import {
  collectAiAssetReceipts,
  collectAiPatternReceipts,
  collectAiTrackReceipts,
  lastRenderStamp,
} from "../export/renderManifest";
import { downloadBlob } from "../export/download";
import { buildZip } from "../export/zip";
import { freezeSignature } from "../rendering/freezeSignature";

export const SESSION_STORY_FORMAT = "kyx-session-story/1";
/** The longest prompt the story quotes (the tape already bounds it at 240). */
const STORY_PROMPT_CHARS = 160;

const GLYPH: Record<TapeOutcome, string> = {
  applied: "✎",
  "applied-candidate": "★",
  generated: "⚡",
  clarify: "?",
  failed: "!",
};

export interface StoryVerdict {
  outcome: "kept" | "undone" | "tweaked" | "pending";
  candidateIndex?: number;
}

/**
 * The latest state of a generation's applied candidate, joined by the SAME id
 * the rerank fit uses. Null when nothing in the ledger mentions the generation
 * (a step that was never applied, or a session recorded before the join).
 */
export function verdictForGeneration(
  entries: readonly ReactionEntry[],
  generationId: string | undefined,
): StoryVerdict | null {
  if (generationId === undefined) return null;
  const matches = entries.filter((entry) => entry.generationId === generationId);
  if (matches.length === 0) return null;
  // Entries are chronological: the last one is the current state.
  const latest = matches[matches.length - 1]!;
  return {
    outcome: latest.outcome,
    ...(latest.candidateIndex !== undefined ? { candidateIndex: latest.candidateIndex } : {}),
  };
}

export interface SessionStoryAiReceipts {
  assets: number;
  patterns: number;
  tracks: number;
  models: string[];
}

export interface SessionStoryInput {
  docName: string;
  docId: string;
  generatedAt: Date;
  contentHash: string | null;
  /** Newest-first, as the tape exposes it; the story prints oldest-first. */
  steps: readonly TapeStep[];
  reactionEntries: readonly ReactionEntry[];
  reactions: { kept: number; undone: number; tweaked: number; pending: number } | null;
  ai: SessionStoryAiReceipts | null;
  exportStamp: { fileName: string; hash: string | null; renderedAt: string } | null;
}

export interface SessionStory {
  format: string;
  markdown: string;
  json: Record<string, unknown>;
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function quoted(prompt: string): string {
  const text = prompt.length > STORY_PROMPT_CHARS ? `${prompt.slice(0, STORY_PROMPT_CHARS - 1)}…` : prompt;
  return text === "" ? "(no prompt)" : `"${text}"`;
}

export function buildSessionStory(input: SessionStoryInput): SessionStory {
  const ordered = [...input.steps].reverse(); // oldest first: a story reads forward
  const detached = ordered.filter((step) => step.abandoned).length;
  const attached = ordered.length - detached;

  const lines: string[] = [];
  lines.push(`# Session Story — "${input.docName}"`);
  lines.push("");
  lines.push(
    `Generated ${input.generatedAt.toISOString()} · project \`${input.docId}\`${
      input.contentHash ? ` · content \`${input.contentHash.slice(0, 12)}\`` : ""
    }`,
  );
  lines.push(
    `${ordered.length} step(s) · ${attached} on the current branch${
      detached > 0 ? ` · ${detached} detached by a rewind` : ""
    }`,
  );
  lines.push("");
  lines.push("## The session");
  lines.push("");

  if (ordered.length === 0) {
    lines.push("- No steps were recorded in this session yet.");
  } else {
    ordered.forEach((step, index) => {
      const parts: string[] = [`${index + 1}. **${timeOf(step.at)}** ${GLYPH[step.outcome]} ${quoted(step.prompt)}`];
      if (step.detail) parts.push(`— ${step.detail}`);
      if (step.abandoned) parts.push("· *(detached — a rewind left this branch)*");
      lines.push(parts.join(" "));
      if (step.outcome === "clarify") {
        lines.push("   The ask needed disambiguation before anything was applied.");
      }
      // WHY — only when it was measured. No filler prose, ever.
      if (step.rationale) {
        lines.push(`   Why: ${step.rationale}`);
      }
      const verdict = verdictForGeneration(input.reactionEntries, step.generationId);
      if (verdict != null) {
        const candidate =
          verdict.candidateIndex !== undefined ? `candidate #${verdict.candidateIndex + 1}` : "the applied result";
        const state =
          verdict.outcome === "kept"
            ? "kept (heard and not reverted)"
            : verdict.outcome === "undone"
              ? "REVERTED"
              : verdict.outcome === "tweaked"
                ? "kept and corrected"
                : "still undecided";
        lines.push(`   → ${candidate}: ${state}`);
      }
    });
  }
  lines.push("");

  lines.push("## What this session taught the model");
  lines.push("");
  lines.push(
    input.reactions == null
      ? "- The learning ledger is not available in this environment."
      : `- Verdicts: kept ${input.reactions.kept} · reverted ${input.reactions.undone} · corrected ${input.reactions.tweaked} · undecided ${input.reactions.pending}. ` +
          "Kept/reverted pairs are what the rerank fit learns from (`npm run rerank:fit`).",
  );
  lines.push("");

  lines.push("## What the models contributed");
  lines.push("");
  if (input.ai == null) {
    lines.push("- Not available in this environment.");
  } else if (input.ai.assets + input.ai.patterns + input.ai.tracks === 0) {
    lines.push("- No AI-generated material is placed in this project.");
  } else {
    lines.push(
      `- ${input.ai.assets} generated asset(s) · ${input.ai.patterns} generated pattern(s) · ${input.ai.tracks} generative track(s)`,
    );
    if (input.ai.models.length > 0) lines.push(`- Models: ${input.ai.models.join(", ")}`);
  }
  lines.push("");

  lines.push("## The export");
  lines.push("");
  if (input.exportStamp == null) {
    lines.push("- No export was stamped in this session — export a WAV to add a reproducible hash to the story.");
  } else {
    lines.push(`- \`${input.exportStamp.fileName}\` (rendered ${input.exportStamp.renderedAt})`);
    lines.push(`- Render hash: \`${input.exportStamp.hash ?? "unavailable (insecure context)"}\``);
    if (input.exportStamp.hash) {
      lines.push(`- Check it yourself: \`npx kyx-verify <file.wav> --expect ${input.exportStamp.hash}\``);
    }
  }
  lines.push("");

  lines.push("## How to read this");
  lines.push("");
  lines.push("- ⚡ a generation · ★ an applied candidate · ✎ a plain action · ? a clarifying question · ! a failure.");
  lines.push("- The `Why:` lines are MEASURED reasons attached at the moment of the decision; a step without one says");
  lines.push("  nothing about why, because nothing was measured. This is a record, not marketing.");
  lines.push("- A detached step is still in the journal but no longer on the current branch (Ctrl+Y redoes it).");
  lines.push("");

  const json: Record<string, unknown> = {
    format: SESSION_STORY_FORMAT,
    generatedAt: input.generatedAt.toISOString(),
    project: { id: input.docId, name: input.docName, contentHash: input.contentHash },
    steps: ordered.map((step) => ({
      at: step.at,
      outcome: step.outcome,
      routeKind: step.routeKind,
      action: step.action,
      prompt: step.prompt,
      ...(step.detail !== undefined ? { detail: step.detail } : {}),
      ...(step.rationale !== undefined ? { rationale: step.rationale } : {}),
      ...(step.generationId !== undefined ? { generationId: step.generationId } : {}),
      ...(step.candidateIndex !== undefined ? { candidateIndex: step.candidateIndex } : {}),
      abandoned: step.abandoned,
      verdict: verdictForGeneration(input.reactionEntries, step.generationId),
    })),
    reactions: input.reactions,
    ai: input.ai,
    exportStamp: input.exportStamp,
  };

  return { format: SESSION_STORY_FORMAT, markdown: lines.join("\n"), json };
}

/** One downloadable artifact: the story, plus the machine-readable JSON. */
export function buildSessionStoryZip(story: SessionStory, docName: string): { blob: Blob; filename: string } {
  const safeName =
    docName
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "project";
  const date = story.json.generatedAt ? String(story.json.generatedAt).slice(0, 10) : "session";
  return {
    blob: buildZip([
      { name: "session-story.md", data: new TextEncoder().encode(story.markdown) },
      { name: "session-story.json", data: new TextEncoder().encode(`${JSON.stringify(story.json, null, 2)}\n`) },
    ]),
    filename: `kyx-story-${safeName}-${date}.zip`,
  };
}

/**
 * The whole flow in one call, shared by every surface that offers the story
 * (the export panel and the activity panel). Returns the file name it saved.
 */
export async function downloadSessionStory(services: Services): Promise<string> {
  const input = await collectSessionStoryInput(services);
  const story = buildSessionStory(input);
  const { blob, filename } = buildSessionStoryZip(story, input.docName);
  downloadBlob(blob, filename);
  return filename;
}

/** Read every source the story needs; each read degrades to null on its own. */
export async function collectSessionStoryInput(services: Services, now: Date = new Date()): Promise<SessionStoryInput> {
  const doc = services.store.getDoc();
  const reactionEntries = (() => {
    try {
      return activeReactionLedger()?.entries() ?? [];
    } catch {
      return [];
    }
  })();
  const reactions = (() => {
    try {
      const report = buildReactionReport(reactionEntries);
      return {
        kept: report.totals.kept,
        undone: report.totals.undone,
        tweaked: report.totals.tweaked,
        pending: report.totals.pending,
      };
    } catch {
      return null;
    }
  })();
  const ai = await Promise.resolve()
    .then(() => services.userSamples.list())
    .then((assets) => {
      const assetReceipts = collectAiAssetReceipts(doc, assets);
      const patternReceipts = collectAiPatternReceipts(doc);
      const trackReceipts = collectAiTrackReceipts(doc);
      const models = new Set<string>();
      for (const asset of assetReceipts) models.add(`${asset.providerId}/${asset.modelId}`);
      for (const pattern of patternReceipts) models.add(`${pattern.engineId}@${pattern.engineVersion}`);
      for (const track of trackReceipts) models.add(`${track.providerId}/${track.modelId}`);
      return {
        assets: assetReceipts.length,
        patterns: patternReceipts.length,
        tracks: trackReceipts.length,
        models: [...models].sort(),
      };
    })
    .catch(() => null);
  const stamp = lastRenderStamp();
  return {
    docName: doc.name,
    docId: doc.id,
    generatedAt: now,
    contentHash: await freezeSignature(doc).catch(() => null),
    steps: tapeSteps(),
    reactionEntries,
    reactions,
    ai,
    exportStamp:
      stamp == null
        ? null
        : { fileName: stamp.fileName, hash: stamp.manifest.hash.value, renderedAt: stamp.manifest.renderedAt },
  };
}
