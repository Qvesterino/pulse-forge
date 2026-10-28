/**
 * ANALYSIS STALENESS (E-3, perception audit §11/G-2) — the scope- and
 * stage-aware invalidation rules for cached analysis results, plus the
 * content hash that makes source-domain caching possible.
 *
 * The audit's rule: DIFFERENT invalidation rules for source-audio,
 * post-FX track, and master analysis — a revision-only check is
 * conservative (everything stale after anything), which is safe but makes
 * source-domain caching worthless and trains consumers to ignore
 * staleness. These rules say exactly what each stage survives:
 *
 *   source  — the SOURCE PCM. Survives every non-destructive edit (trim,
 *             stretch, gain, automation, FX, tempo, meter) because none of
 *             them touch the source bytes; dies only on media-replace.
 *             Results are anchored in SOURCE seconds (the contract's
 *             sourceWindow) — re-anchoring to ticks is the caller's job.
 *   clip/track/bus — the rendered window. Dies on anything that changes
 *             what the strip/bus/master renders: media, trim, stretch,
 *             gain, automation, FX, tempo, meter, routing. Survives
 *             non-audio edits (rename, color) and — the leverage — edits
 *             to OTHER tracks.
 *   master  — like track but from every track.
 *
 * The tri-state mirrors the freeze contract: an entry WITHOUT identity
 * (no revision, no content hash) is `unknown` — never guessed fresh.
 */

export type AnalysisStage = "source" | "clip" | "track" | "bus" | "master";
export type EditKind =
  | "media-replace"
  | "trim"
  | "stretch"
  | "gain"
  | "automation"
  | "tempo"
  | "meter"
  | "fx-bypass"
  | "fx-params"
  | "routing"
  | "rename"
  | "color";

export type Staleness = "fresh" | "stale" | "unknown";

export interface CachedAnalysisEntry {
  stage: AnalysisStage;
  scopeKind: "track" | "clip" | "bus" | "master";
  scopeId?: string;
  /** Source-domain content hash, when the analyzer pinned it (G-2). */
  contentHash?: string;
  /** The store revision at production time. */
  revision?: number;
}

export interface CurrentState {
  revision: number;
  edit: { kind: EditKind; /** The track the edit touched, when scope-specific. */ trackId?: string };
  /** The content hash of the analyzed source NOW, when the caller has it. */
  contentHash?: string;
}

/** FNV-1a 32-bit over every sample's BIT PATTERN — exact, no stride. The
 * samples are hashed through a Uint32 view: an int-truncating hash would
 * map the entire [-1, 1] PCM range onto zero (silent hits by construction). */
export function audioContentHash(channels: readonly Float32Array[], sampleRate: number): string {
  let hash = 0x811c9dc5;
  const mixWord = (value: number): void => {
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (value >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (value >>> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (value >>> 24) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  mixWord(channels.length);
  mixWord(sampleRate | 0);
  for (const channel of channels) {
    const words = new Uint32Array(channel.buffer, channel.byteOffset, channel.length);
    for (let i = 0; i < words.length; i++) mixWord(words[i]!);
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * The cache key for a stored analysis result (G-2's minimal fix shape):
 * content identity FIRST, then the request axes. A map keyed by this string
 * cannot silently serve a different buffer.
 */
export function analysisCacheKey(parts: {
  stage: AnalysisStage;
  scopeId?: string;
  contentHash?: string;
  window?: { startTick: number; endTick: number };
  featureSet: string;
  algorithm: { name: string; version: string };
}): string {
  const w = parts.window ? `@${parts.window.startTick}-${parts.window.endTick}` : "";
  const scope = parts.scopeId ?? "master";
  const content = parts.contentHash ?? "no-content-hash";
  return `${parts.stage}:${scope}:${content}${w}:${parts.featureSet}:${parts.algorithm.name}@${parts.algorithm.version}`;
}

/** Does this edit change WHAT THE STAGE RENDERS? (the rules table) */
function stageSurvives(
  stage: AnalysisStage,
  scopeKind: CachedAnalysisEntry["scopeKind"],
  scopeId: string | undefined,
  edit: { kind: EditKind; trackId?: string },
): boolean {
  switch (edit.kind) {
    case "media-replace":
      return false; // the analyzed media changed — stale everywhere
    case "rename":
    case "color":
      return true; // non-audio edits change nothing audible
    case "trim":
    case "stretch":
    case "tempo":
    case "meter":
      // The audible window moved/rescaled; the SOURCE bytes did not.
      return stage === "source";
    case "gain":
    case "automation":
    case "fx-bypass":
    case "fx-params":
    case "routing":
      // Track-scoped edits: the touched track (and everything downstream of
      // it) re-renders; other tracks' strips are untouched.
      if (stage === "source") return true;
      if (edit.trackId === undefined) return false; // a global edit: stale everywhere downstream
      if (scopeKind === "master") return false;
      if (scopeKind === "bus") return false; // conservatively stale: routing analysis decides precisely
      return scopeId !== edit.trackId; // another track's strip survives
  }
}

/**
 * The tri-state staleness decision for one cached entry against the current
 * document state. `unknown` only when the entry carries no identity —
 * never guessed fresh (the freeze contract).
 */
export function stalenessOf(entry: CachedAnalysisEntry, current: CurrentState): Staleness {
  if (entry.revision === undefined && entry.contentHash === undefined) return "unknown";
  if (entry.revision !== undefined && entry.revision === current.revision) return "fresh";
  if (entry.contentHash !== undefined && current.contentHash !== undefined) {
    // Content identity settles SOURCE-stage questions without revision math.
    if (entry.stage === "source") {
      return entry.contentHash === current.contentHash ? "fresh" : "stale";
    }
  }
  return stageSurvives(entry.stage, entry.scopeKind, entry.scopeId, current.edit) ? "fresh" : "stale";
}

/** Convenience: is a stored result stale after `edit`? */
export function isAnalysisStale(entry: CachedAnalysisEntry, current: CurrentState): boolean {
  return stalenessOf(entry, current) === "stale";
}
