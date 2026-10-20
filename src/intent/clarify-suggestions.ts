import { routeIntentText } from "./route";
import { isCreativeBriefRoute } from "./model-fallback-policy";
import type { ProjectDocument } from "../project-model/types";

/**
 * IS A DECLINE SUGGESTION EXECUTABLE?
 *
 * AUDIT 2026-10-19 (decline UX).
 *
 * A decline's `suggestions` are rendered as chips, and a clicked chip is sent
 * to the router STANDALONE — the sentence it came from is gone. Two kinds were
 * mixed in one list:
 *
 *   COMMAND  "turn down the drums" — a complete ask the engine runs.
 *   ADVICE   "name the track or layer" — an instruction in prose. Rendered as
 *             a chip, clicking one re-routed English prose back into the
 *             engine.
 *
 * and one was worse than prose:
 *
 *   FRAGMENT  "on the bass" — the TAIL of "load the Warm Sub preset on the
 *              bass". Sent alone it lost its sentence and routed to a CREATIVE
 *              BRIEF. Measured: clicking it GENERATED A NEW BEAT and replaced
 *              the producer's song — the exact P0-A failure the miss path is
 *              guarded against everywhere else.
 *
 * WHY THE KIND IS DECLARED, NOT INFERRED
 * ---------------------------------------
 * The obvious discriminator — "route it and see whether the engine can act" —
 * was measured and REJECTED. It misfires in both directions:
 *
 *   "name the track or layer"     → queryIntent  (read-only: harmless, but a
 *                                    chip that does nothing useful)
 *   "choose louder or quieter"    → loudness     (a REAL global mutation, from
 *                                    a sentence that is a QUESTION)
 *   "say faster or slower"        → tempo        (same)
 *
 * Prose that happens to route to an action is still prose, and the difference
 * is grammatical, not semantic. So the route DECLARES which suggestions are
 * advice (`advice`), and this module only adds the safety net below.
 *
 * The safety net is deliberately narrow: it vetoes a chip that would GENERATE,
 * and nothing else. It does not veto a chip that routes to another decline —
 * that depends on mutable state (a cold preset bank makes a valid preset ask
 * decline), and a chip whose click leads to a VISIBLE decline is safe.
 */

/**
 * Would running this suggestion REPLACE THE PRODUCER'S SONG?
 *
 * True only for the generation path: a "pattern" route that the creative-brief
 * guard accepts. Everything else — an action, another decline — is safe.
 */
export function wouldGenerateOnClick(suggestion: string, doc: ProjectDocument): boolean {
  const route = routeIntentText(suggestion, doc);
  if (route.kind !== "pattern") return false;
  return isCreativeBriefRoute(suggestion, route);
}

/**
 * Split a decline's suggestions into the ones the producer can click and the
 * ones that are only advice.
 *
 * `declaredAdvice` is the route's own declaration of which suggestions are
 * prose. Anything not declared advice is a command — unless it would
 * GENERATE, in which case it is demoted to advice, because a decline must
 * never be one click away from replacing the producer's song.
 */
export function partitionClarifySuggestions(
  suggestions: readonly string[],
  declaredAdvice: readonly string[] | undefined,
  doc: ProjectDocument,
): { executable: string[]; advice: string[] } {
  const adviceSet = new Set(declaredAdvice ?? []);
  const executable: string[] = [];
  const advice: string[] = [];
  for (const suggestion of suggestions) {
    if (adviceSet.has(suggestion) || wouldGenerateOnClick(suggestion, doc)) {
      advice.push(suggestion);
      continue;
    }
    executable.push(suggestion);
  }
  return { executable, advice };
}
