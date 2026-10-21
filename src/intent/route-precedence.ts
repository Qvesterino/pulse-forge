/**
 * ROUTE PRECEDENCE — the contract, in one readable place.
 *
 * `routeIntentText` is a deliberate priority chain: the most specific,
 * least-destructive interpretation wins. The order is NOT alphabetical and
 * several positions were paid for with real bugs:
 *
 *   - param before fader/tempo  ("faster compressor attack" once changed BPM)
 *   - compound before exact/fader ("mute the drums and zníž basu" must not
 *     half-apply)
 *   - exact before fader ("lower the drums by 2 dB" keeps its dB meaning)
 *   - descriptive decline before fader ("the bass is quieter than the lead"
 *     must not move anything)
 *   - clarification before pattern (a declined mix ask must not generate a
 *     new song)
 *
 * This table is the contract the corpus pins. It is intentionally grouped by
 * responsibility, not by individual route kind; `tests/intent-router-corpus`
 * asserts both the winners and the relative order of the bug-prone pairs.
 *
 * `contextOnly` stages need runtime state (a selection, a warm preset bank, a
 * recorded ledger entry) and are covered by their own suites rather than the
 * static text corpus.
 */
import type { RoutedIntent } from "./route";

export interface RouteStage {
  id: string;
  kinds: readonly RoutedIntent["kind"][];
  note: string;
  /** Why a plain text corpus cannot exercise this stage. */
  contextOnly?: string;
}

export const ROUTE_PRECEDENCE: readonly RouteStage[] = [
  {
    id: "safety-fences",
    kinds: ["clarify"],
    note: "negation, conflicting directions and hypothetical questions decline before any mutation",
  },
  {
    id: "transport-session",
    kinds: ["transport", "save", "export", "record"],
    note: "runtime/persistence commands are anchored whole-sentence and never become generation prompts",
  },
  {
    id: "undo-query",
    kinds: ["undoIntent", "checkpointIntent", "queryIntent"],
    note: "native history and read-only questions are never gated and never mutate",
  },
  {
    id: "selection-scope",
    kinds: ["selectedStepAssist", "selectedClipArrange", "clips", "selectedRangeArrange"],
    note: "an explicit sequencer/clip/range selection is the most specific musical context",
    contextOnly: "requires a live selection from the UI",
  },
  {
    id: "complaint",
    kinds: ["complaintIntent"],
    note: "measured diagnosis with audition-first chips; nothing mutates until a chip is chosen",
  },
  {
    id: "descriptive-decline",
    kinds: ["clarify"],
    note: "a description of the current sound is not an instruction",
  },
  {
    id: "param",
    kinds: ["paramIntent"],
    note: "effect × knob × target is more specific than fader/tempo/effect-primary; measured wrong-target fixes live here",
  },
  {
    id: "studio-words",
    kinds: [
      "sectionGrooveIntent",
      "grooveIntent",
      "automateIntent",
      "markerIntent",
      "stepEditIntent",
      "soundSwapIntent",
    ],
    note: "explicit groove/automation/marker/step verbs, gated off inside genre prompts",
  },
  {
    id: "clips-arrange",
    kinds: ["clips", "arrange"],
    note: "clip wording beats scene wording; arranges only fire when they parse cleanly",
  },
  {
    id: "compound",
    kinds: ["compound"],
    note: "multi-clause asks fold every clause into ONE undo step; must precede exact/fader/tempo",
  },
  {
    id: "exact",
    kinds: ["exact"],
    note: "explicit units/targets keep exact semantics over the vibe step",
  },
  {
    id: "select-preset-scene",
    kinds: ["select", "preset", "presetUnknown", "sceneIntensity"],
    note: "selection, preset loading and scene intensity are explicit nouns with their own vocabulary",
  },
  {
    id: "send",
    kinds: ["sendIntent"],
    note: "send/return routing must precede the effect-primary knob",
  },
  {
    id: "prior-adjustment",
    kinds: ["fader"],
    note: "a reference to the recorded last move resolves before a fresh fader guess",
    contextOnly: "requires a recorded ledger entry (tests/intent-conversation-memory)",
  },
  {
    id: "fader",
    kinds: ["fader"],
    note: "named track/pad faders beat the master loudness loop",
  },
  {
    id: "loudness-tempo",
    kinds: ["loudness", "tempo"],
    note: "master loudness and tempo after named faders; creative-brief tempo is excluded",
  },
  {
    id: "bypass",
    kinds: ["bypassIntent"],
    note: "bypass vocabulary must precede the effect-primary knob",
  },
  {
    id: "effect",
    kinds: ["effectIntent"],
    note: "effect primary knob after send/bypass; genre-gated",
  },
  {
    id: "section-structure",
    kinds: ["sectionTransition", "sectionFlow", "sectionProduction"],
    note: "section-scoped structure/FX before global production words",
    contextOnly: "requires a section-scored document and a scoped section ask",
  },
  {
    id: "production-mix",
    kinds: ["production", "mix"],
    note: "semantic production and mix profiles before content revision/pattern",
  },
  {
    id: "revise",
    kinds: ["revise"],
    note: "content sliders only when no genre signal owns the prompt",
  },
  {
    id: "clarification",
    kinds: ["clarify"],
    note: "declined intent → executable chips, never generation",
  },
  {
    id: "pattern",
    kinds: ["pattern"],
    note: "generation is the least-destructive default",
  },
];
