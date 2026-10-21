/**
 * Which factory samples does a project actually need?
 *
 * The factory catalogue (155 synthesized assets) is rendered OFF the boot's
 * critical path, so a project open has to say which samples it wants NOW.
 * The answer is "the ones the document references" — the drum pads' asset
 * ids, the pattern notes' sample ids, the instrument tracks' sample params.
 *
 * The walk is deliberately generic: a sample id is any string that starts
 * with the factory prefix, wherever it sits in the document. A field that
 * merely LOOKS like a sample id costs one map lookup that finds nothing.
 */
import type { ProjectDocument } from "../project-model/types";

const FACTORY_PREFIX = "factory.";

/** Collect every factory sample id referenced by the document. */
export function factorySampleIdsOf(doc: ProjectDocument | null | undefined): string[] {
  const ids = new Set<string>();
  if (!doc) return [];
  const seen = new Set<object>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 12) return;
    if (typeof value === "string") {
      if (value.startsWith(FACTORY_PREFIX)) ids.add(value);
      return;
    }
    if (!value || typeof value !== "object") return;
    // A document is plain JSON, but a cycle guard keeps a malformed doc from
    // turning the walk into an infinite recursion.
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(doc, 0);
  return [...ids].sort();
}
