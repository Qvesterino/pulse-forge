import type { Pattern, ProjectDocument, ReturnTrack, Scene, Track } from "./types";

/**
 * THE SHARED DOCUMENT INDEX — one derived lookup per document version.
 *
 * WHY THIS EXISTS
 * ---------------
 * The performance-cliff audit (docs/PERFORMANCE_CLIFF_DETECTOR_REPORT.md, §4.3)
 * found the SAME defect three times in three costumes: per-item work that
 * scans the whole collection.
 *
 *   - `soloAudibility(doc).audible(id)` resolved its track with `tracks.find`
 *     and is called once per track, so one document change cost O(T²) —
 *     the measured quadratic (256 tracks: 1.67 ms of pure overhead).
 *   - `AudioEngine.syncPdc()` did the same lookup inside a loop over the track
 *     nodes, twice.
 *   - `targetOwner()` did it per automation lane per scheduler tick.
 *
 * The codebase ALREADY knows the right pattern: `normalizeArrangementDomain`
 * builds `scenesById` / `patternsById` maps once and uses them inside its
 * per-clip map. The problem was never knowledge — it was that the one-line
 * `tracks.find(...)` is always writable and a shared index is not. That is why
 * the fix is a MECHANISM rather than three patches: one index makes the
 * quadratic unreintroducible instead of fixed three times.
 *
 * HOW THE INVALIDATION WORKS — this is the whole trick
 * ----------------------------------------------------
 * The document is copy-on-write. `applyDocDelta` applies operations
 * functionally, keeps the references of unchanged branches, and returns the
 * document itself when nothing applied (`src/commands/docDelta.ts:245-256`);
 * a command that changes nothing returns the same document object
 * (`src/store/ProjectStore.ts:257`). So document identity IS document version.
 *
 * A `WeakMap` keyed by the document therefore invalidates itself: a mutation
 * produces a new document (a new key, the old entry dies with the old
 * document), and a no-op produces the same document (the index stays valid).
 * No version counter, no dirty flag, no explicit invalidation — the copy-on-
 * write architecture that the delta engine already established pays for it.
 *
 * The one hole in that reasoning is a document whose collections are REPLACED
 * in place — `doc.tracks = [...]`, which the template factories do
 * (`src/project-model/templates.ts`, `src/project-model/template-pack2.ts`).
 * The index therefore also remembers the array references it was built from
 * and rebuilds when any of them changed.
 *
 * IN-PLACE MUTATION of an array (push/splice) would still be invisible to it.
 * Nothing in `src/` does that to a project document — the two call sites that
 * push (`src/intent/model-context.ts:223`, `src/mcp/meters.ts:57`) push to
 * their own objects, not to the document. That is the invariant this module
 * relies on, and it is stated here so a future writer has to break it
 * deliberately.
 *
 * WHAT IT IS NOT
 * --------------
 * It is DERIVED DATA, never a second source of truth. The project model owns
 * the truth (invariant 1: the project model stores truth); this owns a lookup.
 * Nothing may write through it, and no consumer may hold on to a map across a
 * document change without asking the index again.
 */
export interface DocIndex {
  /** Track by id. First match wins — see `indexById`. */
  readonly tracksById: ReadonlyMap<string, Track>;
  /** Scene by id. */
  readonly scenesById: ReadonlyMap<string, Scene>;
  /** Pattern by id. */
  readonly patternsById: ReadonlyMap<string, Pattern>;
  /** Return bus by id. */
  readonly returnsById: ReadonlyMap<string, ReturnTrack>;
}

interface IndexEntry {
  tracks: readonly Track[] | undefined;
  scenes: readonly Scene[] | undefined;
  patterns: readonly Pattern[] | undefined;
  returns: readonly ReturnTrack[] | undefined;
  index: DocIndex;
}

const cache = new WeakMap<ProjectDocument, IndexEntry>();

/**
 * The index for this document version. The same document object always gets
 * the same index; a new document version gets a new one.
 */
export function getDocIndex(doc: ProjectDocument): DocIndex {
  const cached = cache.get(doc);
  if (
    cached &&
    cached.tracks === doc.tracks &&
    cached.scenes === doc.scenes &&
    cached.patterns === doc.patterns &&
    cached.returns === doc.returns
  ) {
    return cached.index;
  }
  const entry: IndexEntry = {
    tracks: doc.tracks,
    scenes: doc.scenes,
    patterns: doc.patterns,
    returns: doc.returns,
    index: buildIndex(doc),
  };
  cache.set(doc, entry);
  return entry.index;
}

/**
 * Index by id, FIRST match wins.
 *
 * The order matters and is not cosmetic: `doc.tracks.find((t) => t.id === id)`
 * returns the FIRST match, while `new Map(items.map((i) => [i.id, i]))` keeps
 * the LAST. A document that carries a duplicate id would therefore get a
 * different answer from the index than from the scan it replaces. Duplicate
 * ids are not supposed to exist, but the rule that decides audibility must not
 * change because of an optimization.
 */
function indexById<T extends { id: string }>(items: readonly T[] | undefined): Map<string, T> {
  const map = new Map<string, T>();
  if (!items) return map;
  for (const item of items) {
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return map;
}

/**
 * Each collection is indexed on FIRST use. A consumer that only needs the
 * tracks must not pay for the scenes and the patterns — the whole point is
 * that the index costs one pass over what is actually asked for, once per
 * document version.
 */
function buildIndex(doc: ProjectDocument): DocIndex {
  let tracks: Map<string, Track> | undefined;
  let scenes: Map<string, Scene> | undefined;
  let patterns: Map<string, Pattern> | undefined;
  let returns: Map<string, ReturnTrack> | undefined;
  return {
    get tracksById(): ReadonlyMap<string, Track> {
      return (tracks ??= indexById(doc.tracks));
    },
    get scenesById(): ReadonlyMap<string, Scene> {
      return (scenes ??= indexById(doc.scenes));
    },
    get patternsById(): ReadonlyMap<string, Pattern> {
      return (patterns ??= indexById(doc.patterns));
    },
    get returnsById(): ReadonlyMap<string, ReturnTrack> {
      return (returns ??= indexById(doc.returns));
    },
  };
}
