/**
 * The producer-DNA ledger's localStorage event names, kept apart from the
 * ledger itself.
 *
 * WHY THIS FILE EXISTS — the studio boot path is measured, and this module is
 * one of the seams that holds it honest. `src/intent/preference-ledger.ts`
 * imports the AI engine (pattern features -> generator -> the whole groove
 * library, ~200 KB built). The style observer only needs to know WHEN the
 * ledger was cleared — it needs a NAME, not the ledger. Importing that name
 * from the ledger pulled the entire AI engine into the studio boot closure
 * through a single edge:
 *
 *   TopBar -> CollabPanel -> services.ts -> style-observation
 *           -> preference-ledger -> ai/features/pattern-features
 *           -> ai/generator -> ai/grooves/*
 *
 * The constant moves here so that edge no longer exists. The event name
 * string is unchanged, so listeners and dispatchers still match.
 */
export const PREFERENCE_LEDGER_CLEARED_EVENT = "pf:producer-dna-preferences-cleared";
