/**
 * CANONICAL DEGREE CONTRACT — the shared 7-level language.
 *
 * KYX and VocalForge each grew a seven-level modifier table. Most words already
 * agreed; three did not:
 *
 *   word          KYX (before)   VocalForge   canonical (this contract)
 *   much          6              5            5
 *   noticeably    5              4            4
 *   quite/pretty  5              (absent)     4
 *
 * The canonical levels follow the host's production contract for the shared
 * words: "much" is a strong move but "a lot/dramatically" is the rung above it;
 * "noticeably" belongs with "moderately", not with "significantly". KYX keeps
 * "quite/pretty" as documented extensions at level 4 (conservative: "quite" is
 * ambiguous in English and must not outrank "significantly").
 *
 * This module is the BEHAVIOURAL contract: `tests/param-intent.test.ts` parses
 * every word and asserts the level, so the regex table in `degree.ts` cannot
 * drift from this list. The runtime table remains in `degree.ts`; the contract
 * is the source of truth for the words that matter across surfaces.
 *
 * VocalForge's `graduatedDegree.ts` is compared by the parity test when that
 * checkout is present; a divergence in a shared word is a failure.
 */
export type CanonicalDegreeLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface CanonicalDegreeWord {
  word: string;
  level: CanonicalDegreeLevel;
  /** Words KYX adds beyond the host contract (documented, not a divergence). */
  extension?: boolean;
}

export const CANONICAL_DEGREE_CONTRACT_VERSION = "1.0" as const;

export const CANONICAL_DEGREE_WORDS: readonly CanonicalDegreeWord[] = [
  // L1 — minimal
  { word: "barely", level: 1 },
  { word: "hardly", level: 1 },
  { word: "scarcely", level: 1 },
  { word: "minimally", level: 1 },
  { word: "almost imperceptibly", level: 1 },
  { word: "the tiniest bit", level: 1 },
  { word: "as little as possible", level: 1 },

  // L2 — very small
  { word: "a tiny bit", level: 2 },
  { word: "a hair", level: 2 },
  { word: "a touch", level: 2 },
  { word: "a tad", level: 2 },
  { word: "a jot", level: 2 },
  { word: "a smidge", level: 2 },

  // L3 — small
  { word: "slightly", level: 3 },
  { word: "a little", level: 3 },
  { word: "a bit", level: 3 },
  { word: "subtly", level: 3, extension: true },
  { word: "gently", level: 3 },

  // L4 — moderate (noticeably belongs here, not with "significantly")
  { word: "somewhat", level: 4 },
  { word: "moderately", level: 4 },
  { word: "fairly", level: 4 },
  { word: "reasonably", level: 4 },
  { word: "noticeably", level: 4 },
  { word: "quite", level: 4, extension: true },
  { word: "pretty", level: 4, extension: true },

  // L5 — large (much is strong, but "a lot/dramatically" is the rung above)
  { word: "significantly", level: 5 },
  { word: "considerably", level: 5 },
  { word: "substantially", level: 5 },
  { word: "much", level: 5 },

  // L6 — very large
  { word: "dramatically", level: 6 },
  { word: "drastically", level: 6 },
  { word: "massively", level: 6 },
  { word: "heavily", level: 6 },
  { word: "strongly", level: 6 },
  { word: "a lot", level: 6 },
  { word: "way", level: 6, extension: true },
  { word: "really", level: 6, extension: true },

  // L7 — maximum
  { word: "as far as possible", level: 7 },
  { word: "as much as possible", level: 7 },
  { word: "to the limit", level: 7 },
  { word: "maximally", level: 7 },
  { word: "completely", level: 7, extension: true },
  { word: "fully", level: 7, extension: true },
];

const LEVEL_BY_WORD = new Map(CANONICAL_DEGREE_WORDS.map((entry) => [entry.word, entry.level]));

export function canonicalDegreeLevel(word: string): CanonicalDegreeLevel | null {
  return LEVEL_BY_WORD.get(word.trim().toLowerCase()) ?? null;
}

/** Shared words only — the set the cross-engine parity test compares. */
export const CANONICAL_SHARED_WORDS: readonly CanonicalDegreeWord[] = CANONICAL_DEGREE_WORDS.filter(
  (entry) => !entry.extension,
);
