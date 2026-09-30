/**
 * SHARED SFT DATASET DOCUMENT — the single fixed document every stage of the
 * intent-model pipeline resolves against: corpus generation (teacher routes),
 * in-training val, and the live Ollama eval/probe. Deterministic ids make the
 * corpus's scene/clip ids (scene-test-*, clip-test-*) resolvable at eval time,
 * so a corpus-trained model is scored on EQUAL FOOTING — an arrange/clips row
 * is only answerable when the scenes and clips it names actually exist.
 *
 * Used by: scripts/generate-intent-dataset.mts, scripts/eval-ollama-intent.mts,
 * scripts/eval-ollama-intent-probe.mts.
 */
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { addArrangementClip, createScene, setSceneRole } from "../src/commands/commands";
import type { ProjectDocument } from "../src/project-model/types";

/** Fixed dataset document: deterministic ids, role scenes, two clips. */
export function datasetDoc(): ProjectDocument {
  useDeterministicIds();
  resetDeterministicIds();
  let doc = createProjectFromTemplate("house");
  // the house template ships an arrangement clip at bar 0 — strip it so the
  // dataset clips land exactly where the corpus expects them
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] }, markers: [] };
  doc = createScene(doc, "Intro").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "intro").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 0, 4).execute(doc);
  doc = createScene(doc, "Drop").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "drop").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 4, 4).execute(doc);
  return doc;
}
