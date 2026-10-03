import { decodeShareCode } from "../export/shareCode";
import { encodeProjectForGallery } from "./galleryApi";
import { assistVary, autoArrangeSong } from "../commands/commands";
import { ensureRootLineage, readLineage, familyProvenance } from "./lineage";
import { uid } from "../shared/ids";
import type { ProjectDocument } from "../project-model/types";

/**
 * Gallery REMIX pipeline — one call turns a published beat into "your take":
 * decode → fresh project id → auto-arrange into a full song → deterministic
 * variation on every drop-scene pattern → doc lineage stamped at the source
 * → re-encode for publishing. Pure document math: no store, no UI, no server.
 *
 * The lineage stamp is what joins the child into the family tree: the feed's
 * tree builds from the schema-v3 `lineage` inside each share code
 * (parentDocId ↔ doc.id), not from the gallery-side parentId chain — a remix
 * without the stamp was counted as "N remixes" on the card yet stayed
 * invisible in the 🧬 FAMILY panel.
 */

/** How hard the re-roll hits the drop patterns (0..1). */
const REMIX_VARY_AMOUNT = 0.35;
const REMIX_TAG = "remix";
const GALLERY_TAG_RE = /^[a-z0-9-]{1,16}$/;

export interface RemixSource {
  id: string;
  title: string;
  code: string;
}

export interface RemixResult {
  title: string;
  code: string;
  doc: ProjectDocument;
  /** Scene roles touched by the variation pass. */
  variedPatterns: number;
}

export function remixTitleOf(sourceTitle: string): string {
  const t = `Remix of ${sourceTitle}`.trim();
  return t.length > 64 ? `${t.slice(0, 61)}…` : t;
}

/** Gallery-safe tags for a remix: keep the source's valid tags + the remix marker. */
export function remixTagsOf(sourceTags: string[]): string[] {
  return [...new Set([...sourceTags.filter((t) => GALLERY_TAG_RE.test(t)), REMIX_TAG])].slice(0, 5);
}

export function buildRemix(source: RemixSource): RemixResult | null {
  const decoded = decodeShareCode(source.code);
  if (!decoded) return null;
  // Stamp the family link FIRST (on the untouched source): the child's
  // parentId is the source's DOC id — the family tree's join key.
  const base = ensureRootLineage(decoded);
  const baseLineage = readLineage(base) ?? { parentId: null, rootId: base.id, depth: 0, prompt: null, seed: null };
  const provenance = familyProvenance(base);
  const now = new Date().toISOString();
  let doc: ProjectDocument = {
    ...base,
    id: uid("project"),
    name: remixTitleOf(source.title),
    createdAt: now,
    updatedAt: now,
    lineage: {
      parentId: base.id,
      rootId: baseLineage.rootId,
      depth: baseLineage.depth + 1,
      prompt: baseLineage.prompt ?? provenance.prompt,
      seed: baseLineage.seed ?? provenance.seed,
    },
  };
  // 1) Turn the scene grid into a full arrangement (intro→build→drop→…→outro).
  doc = autoArrangeSong(doc).execute(doc);
  // 2) Re-roll every drop pattern with a seed derived from the source beat —
  //    the same beat remixes to the same take, a different beat never collides.
  const dropPatterns = [...new Set(doc.scenes.filter((s) => s.role === "drop").map((s) => s.patternId))];
  let variedPatterns = 0;
  for (const [index, patternId] of dropPatterns.entries()) {
    try {
      doc = assistVary(doc, patternId, `${source.id}-${index}`, REMIX_VARY_AMOUNT).execute(doc);
      variedPatterns += 1;
    } catch {
      /* a scene whose pattern cannot vary is left untouched */
    }
  }
  return {
    title: doc.name,
    doc,
    variedPatterns,
    code: encodeProjectForGallery(doc),
  };
}
