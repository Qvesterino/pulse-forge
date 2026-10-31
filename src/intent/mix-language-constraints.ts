import type { DeltaPath } from "../commands/docDelta";
import type { ProjectDocument } from "../project-model/types";
import { classifyPads } from "../assist/patternOps";
import { resolveExactTargetTracks } from "../commands/intentRouting";
import { pathContains } from "../mcp/scope-guard";
import type { ProposalConstraints } from "./proposal-constraints";

export interface MixConstraintSelection {
  mode: "only" | "protect";
  label: string;
  trackId: string;
  padId?: string;
  /** Protecting a pad also protects its parent track's mixer and effects. */
  protectsParentTrack: boolean;
}

export type MixLanguageConstraints =
  | { status: "none" }
  | { status: "clarify"; reason: string; choices: string[]; retries?: string[] }
  | { status: "ready"; plannerText: string; constraints: ProposalConstraints; selections: MixConstraintSelection[] };

/**
 * The clarify reasons this resolver produces are SLUGS, not sentences.
 *
 * The reason is the machine key: the SFT teacher compacts it into the
 * training data and the mining log groups by it, so it must be stable and
 * must never be reworded. The sentence the producer reads lives in
 * CLARIFY_MESSAGES (src/intent/clarify-messages.ts) and is resolved with
 * `clarifyMessage(reason)` - on the panel AND on the MCP surface, which is
 * an agent surface and speaks English like every other refusal it emits.
 */
export const MIX_CONSTRAINT_CLARIFY = {
  scopeUnclear: "mix-constraint-scope-unclear",
  ambiguousTarget: "mix-constraint-ambiguous-target",
  targetUnknown: "mix-constraint-target-unknown",
  targetConflict: "mix-constraint-target-conflict",
  missingTarget: "mix-constraint-missing-target",
} as const;

const normalized = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

function candidates(doc: ProjectDocument, raw: string): Array<Omit<MixConstraintSelection, "mode">> {
  const name = normalized(raw.replace(/^["']|["']$/g, "")).replace(/^(?:the|my|moj|moju|moje|tu)\s+/, "");
  const all: Array<Omit<MixConstraintSelection, "mode">> = doc.tracks.flatMap((track) => [
    { label: track.name, trackId: track.id, protectsParentTrack: false },
    ...(track.kind === "drum"
      ? track.pads.map((pad) => ({
          label: `${track.name} / ${pad.name}`,
          trackId: track.id,
          padId: pad.id,
          protectsParentTrack: true,
        }))
      : []),
  ]);
  // Explicit IDs or exact quoted names override family names, but a common
  // bare family word never picks the first of several matching objects.
  const quoted = /^["'].*["']$/.test(raw.trim());
  const exact = all.filter((item) => {
    const track = doc.tracks.find((t) => t.id === item.trackId)!;
    const pad = track.kind === "drum" ? track.pads.find((p) => p.id === item.padId) : undefined;
    return (
      (normalized(item.trackId) === name && !item.padId) ||
      (item.padId !== undefined && normalized(item.padId) === name) ||
      (quoted && (normalized(item.label) === name || normalized(pad?.name ?? track.name) === name))
    );
  });
  if (exact.length) return exact;
  if (quoted) return [];
  const aliases: Record<string, "bass" | "drums" | "lead" | "chords" | "kick" | "snare" | "hats"> = {
    bass: "bass",
    bas: "bass",
    basa: "bass",
    basu: "bass",
    basy: "bass",
    drums: "drums",
    drum: "drums",
    bicie: "drums",
    bicia: "drums",
    bicich: "drums",
    bubny: "drums",
    bubnov: "drums",
    lead: "lead",
    melodia: "lead",
    melodiu: "lead",
    melody: "lead",
    chords: "chords",
    chord: "chords",
    akordy: "chords",
    akordov: "chords",
    keys: "chords",
    kick: "kick",
    kopak: "kick",
    kopaku: "kick",
    snare: "snare",
    clap: "snare",
    hats: "hats",
    hat: "hats",
    hihat: "hats",
    "hi-hat": "hats",
  };
  if (name === "808") {
    const bassIds = resolveExactTargetTracks(doc, "bass");
    return all.filter((item) => {
      if (!item.padId) return bassIds.includes(item.trackId);
      const track = doc.tracks.find((t) => t.id === item.trackId);
      return track?.kind === "drum" && track.pads.some((pad) => pad.id === item.padId && /808/i.test(pad.name));
    });
  }
  const family = aliases[name];
  if (family === "kick" || family === "snare" || family === "hats") {
    return doc.tracks.flatMap((track) => {
      if (track.kind !== "drum") return [];
      const families = classifyPads(track.pads);
      const pads =
        family === "kick"
          ? track.pads.filter((pad) => families.kicks.includes(pad) || pad.synth?.type === "kick")
          : family === "snare"
            ? families.snares
            : families.hats;
      return pads.map((pad) => ({
        label: `${track.name} / ${pad.name}`,
        trackId: track.id,
        padId: pad.id,
        protectsParentTrack: true,
      }));
    });
  }
  if (family) {
    const ids = resolveExactTargetTracks(doc, family);
    return all.filter((item) => !item.padId && ids.includes(item.trackId));
  }
  // A non-family exact name is useful without quoting, provided it is unique.
  return all.filter((item) => {
    const track = doc.tracks.find((t) => t.id === item.trackId)!;
    return normalized(item.label) === name || (!item.padId && normalized(track.name) === name);
  });
}

/** Intersect allowed scopes; protection always accumulates. */
export function mergeProposalConstraints(a: ProposalConstraints, b: ProposalConstraints): ProposalConstraints {
  const allow =
    a.allow === undefined
      ? b.allow
      : b.allow === undefined
        ? a.allow
        : a.allow.flatMap((left) =>
            b.allow!.flatMap((right) =>
              pathContains(left, right) ? [right] : pathContains(right, left) ? [left] : [],
            ),
          );
  const protect = [...(a.protect ?? []), ...(b.protect ?? [])];
  return {
    ...(allow === undefined ? {} : { allow: structuredClone(allow) }),
    ...(protect.length ? { protect: structuredClone(protect) } : {}),
  };
}

/** Parse a deliberately narrow, clause-bounded EN/SK protection vocabulary. */
export function resolveMixLanguageConstraints(doc: ProjectDocument, text: string): MixLanguageConstraints {
  const input = normalized(text).replace(/\bhi[ -]?hat\b/g, "hihat");
  const clauses = input.split(/\s*(?:[,;]|\bbut\b|\bwhile\b|\bale\b)\s*/).filter(Boolean);
  const selections: MixConstraintSelection[] = [];
  const planner: string[] = [];
  let sawDirective = false;
  for (const [clauseIndex, clause] of clauses.entries()) {
    const preservePrefix =
      /^(?:keep|leave|preserve|don't touch|don't change|do not touch|do not change|nechaj|ponechaj|zachovaj|zachovat|nemen|nemenit)\s+(.+?)(?:\s+(?:unchanged|alone|tak|nedotknute))?$/.exec(
        clause,
      );
    const preserveSuffix =
      /^(.+?)\s+(?:nechaj|ponechaj|zachovaj|zachovat|nemen|nemenit)(?:\s+(?:tak|nedotknute))?$/.exec(clause);
    const only =
      /^(?:only|just|iba|len)\s+(?:(?:change|edit|adjust|modify|uprav|zmen)\s+)?(.+)$|^(?:change|edit|adjust|modify|uprav|zmen)\s+(?:only|just|iba|len)\s+(.+)$/.exec(
        clause,
      );
    const directive = preservePrefix ?? preserveSuffix ?? only;
    if (!directive) {
      if (
        /\b(?:keep|leave|preserve|nechaj|ponechaj|zachovaj|zachovat|nemen|nemenit|only|just|iba|len|don't touch|don't change|do not touch|do not change)\b/.test(
          clause,
        )
      ) {
        return {
          status: "clarify",
          reason: MIX_CONSTRAINT_CLARIFY.scopeUnclear,
          choices: [],
        };
      }
      planner.push(clause);
      continue;
    }
    sawDirective = true;
    const mode = only ? "only" : "protect";
    const target = (directive[1] ?? directive[2] ?? "").trim();
    const matches = candidates(doc, target);
    if (matches.length !== 1) {
      const retries = matches.flatMap((item) => {
        const id = item.padId ?? item.trackId;
        if (!/^[a-z0-9_-]{1,128}$/i.test(id)) return [];
        const updated = [...clauses];
        updated[clauseIndex] = `${mode === "only" ? "only change" : "keep"} "${id}"`;
        return [updated.join(", ")];
      });
      return {
        status: "clarify",
        reason: matches.length > 0 ? MIX_CONSTRAINT_CLARIFY.ambiguousTarget : MIX_CONSTRAINT_CLARIFY.targetUnknown,
        choices: matches.map((item) => `${item.label} [${item.padId ?? item.trackId}]`),
        ...(retries.length ? { retries } : {}),
      };
    }
    const selected = { ...matches[0], mode } as MixConstraintSelection;
    selections.push(selected);
    if (mode === "only") planner.push(target);
  }
  if (!sawDirective) return { status: "none" };
  const allowed: DeltaPath[] = selections
    .filter((s) => s.mode === "only")
    .map((s) => (s.padId ? ["tracks", { id: s.trackId }, "pads", { id: s.padId }] : ["tracks", { id: s.trackId }]));
  const protectedPaths: DeltaPath[] = selections
    .filter((s) => s.mode === "protect")
    .map((s) => ["tracks", { id: s.trackId }]);
  const constraints: ProposalConstraints = {
    ...(selections.some((s) => s.mode === "only") ? { allow: allowed } : {}),
    ...(protectedPaths.length ? { protect: protectedPaths } : {}),
  };
  if (
    allowed.some((path) => protectedPaths.some((blocked) => pathContains(blocked, path) || pathContains(path, blocked)))
  ) {
    return {
      status: "clarify",
      reason: MIX_CONSTRAINT_CLARIFY.targetConflict,
      choices: [],
    };
  }
  const plannerText = planner.join(", ").trim();
  if (plannerText.length < 3)
    return {
      status: "clarify",
      reason: MIX_CONSTRAINT_CLARIFY.missingTarget,
      choices: [],
    };
  return { status: "ready", plannerText, constraints, selections };
}
