/**
 * COVER BAND (Session Theatre × UN-SUNO crossover — the demo moment):
 * the default producer cast each COVERS the transcribed song via
 * per-persona regeneration (their genre's groove + bass style over the
 * source's structure and harmony). Pure: returns one command per persona;
 * the panel renders blind auditions and runs the A/B tournament, and only
 * the WINNER's command is executed on the real store.
 */
import type { ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import { defaultCast, type ProducerPersona } from "../intent/producer-personas";
import { regenerateForGenre } from "./regen-style";

export interface CoverCandidate {
  personaSlug: string;
  personaName: string;
  avatar: string;
  genre: string;
  /** Pure regeneration command — executed ONLY if this cover wins. */
  command: Command;
}

export interface CoverBandOptions {
  /** Override the cast (default: the theatre's default 3-persona cast). */
  personas?: readonly ProducerPersona[];
}

export function coverBandCandidates(doc: ProjectDocument, options: CoverBandOptions = {}): CoverCandidate[] {
  const cast = options.personas ?? defaultCast();
  const candidates: CoverCandidate[] = [];
  for (const persona of cast) {
    const { command } = regenerateForGenre(doc, {
      genre: persona.genre as never,
      style: undefined,
      seedLabel: `cover|${persona.slug}`,
    });
    if (!command) continue; // no UN-SUNO sections — persona sits out
    candidates.push({
      personaSlug: persona.slug,
      personaName: persona.name,
      avatar: persona.avatar,
      genre: persona.genre,
      command,
    });
  }
  return candidates;
}

/** The audition pattern for a covered doc: the DROP section if present,
 * else the first UN-SUNO section (the drop is the honest taste test). */
export function pickCoverPattern(doc: ProjectDocument): ProjectDocument["patterns"][number] | null {
  const ours = doc.patterns.filter((p) => p.name.startsWith("UN-SUNO"));
  if (ours.length === 0) return null;
  return ours.find((p) => /drop/i.test(p.name)) ?? ours[0];
}
