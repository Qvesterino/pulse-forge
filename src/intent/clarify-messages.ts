/**
 * DECLINE MESSAGES — the human sentence behind a decline's machine key.
 *
 * AUDIT 2026-10-19 (control-surface audit, decline UX).
 *
 * A decline (`kind: "clarify"`) carries two things: a machine `reason` and a
 * list of `suggestions`. The reason is what the SFT teacher compacts into the
 * training data and what the mining log groups by, so it is a stable snake-case
 * KEY and must never be reworded. The producer, however, was reading that key
 * verbatim in the status line:
 *
 *   "turn down the drums and don't touch the bass"
 *     → status: "negated-mutation-command"
 *
 * Nine decline reasons were slugs and were shown raw. This module is the ONE
 * home for that vocabulary, for the same reason `reference-clause.ts` is one
 * home for the comparison words: three copies of one vocabulary is how "than"
 * ended up honoured on one route and ignored on another.
 *
 * Contract:
 *   - `reason` stays the key. Nothing here changes the SFT dataset, the
 *     shipped model's training hashes, or the mining log's group keys.
 *   - `clarifyMessage(reason)` returns the sentence, and FALLS BACK to the
 *     reason itself — so a decline that already uses a sentence as its reason
 *     (the unmatched-route clarify, "which fader?") reads as-is.
 *   - tests/intent-decline-ux.test.ts pins that every slug reason the router
 *     can produce has an entry here, so a new decline cannot silently ship
 *     its key to the screen.
 */

/** Slug reason → the sentence the producer actually reads. */
export const CLARIFY_MESSAGES: Readonly<Record<string, string>> = {
  "negated-mutation-command":
    "That sentence asks for a change AND an exception, so I didn't change anything. Send the change on its own.",
  "last-adjustment-reference":
    "That refers to an earlier change I don't have in this session, so I didn't change anything — name the target and the amount, or say 'undo that'.",
  "descriptive-not-a-command":
    'That describes how the mix sounds right now, so I didn\'t change anything. Say what you want changed, for example "turn down the bass".',
  "model-route-rejected":
    "The local model proposed a change that could not be validated against the project, so I didn't change anything. Name the target and the action.",
  "scene-reference":
    'Section-relative references ("same as the chorus", "quieter than the drop") aren\'t supported yet. I didn\'t change anything — name the track and the amount.',
  "param-target": "That names a parameter but not the track it belongs to. I didn't change anything — pick a track.",
  "prior-adjustment-target":
    "That track doesn't resolve in this project (or in the remembered adjustment). I didn't change anything — name an existing track.",
  "hypothetical-action-question":
    "That was a question about what would happen, not an instruction to change something — I left the project alone.",
  "conflicting-values":
    "That gives two different values for the same control — I didn't change anything. Give one value, or split it into separate asks.",
  "conflicting-actions": "That asks for the same track to be muted and audible at once — I didn't change anything.",
  "conflicting-pan-directions":
    "That asks for the same track to pan left AND right — I didn't change anything. Pick one side.",
  "conflicting-level-directions":
    "That asks for the same track to be louder AND quieter — I didn't change anything. Pick one direction.",
  "missing-level-value": "I need a number for that level — a percentage or a dB value. I didn't change anything.",
  "missing-pan-target": "Which track should pan? I didn't change anything — name the track or layer.",
  "missing-level-target": "Which track should that level apply to? I didn't change anything — name the track or layer.",
  "missing-fader-target": "Which fader should move? I didn't change anything — name the track or layer.",
  "missing-layer-target": "Which layer should move? I didn't change anything — name the track or layer.",
  "missing-effect-target": "Which effect, and on which track? I didn't change anything — name both.",
  "missing-pan-amount": "How far should it pan? I didn't change anything — give a pan amount or a percentage.",
  "missing-tempo-value": "What tempo? I didn't change anything — give a BPM value, or say faster or slower.",
  "missing-send-value": "I need the effect, the track and a level. I didn't change anything.",
  "missing-effect-value": "I need a number for that effect — a percentage. I didn't change anything.",
  "ambiguous-send-return":
    "That's either the track's send or the effect's return channel — I didn't change anything. Pick which one.",
  "ambiguous-effect-instance":
    "That track has multiple inserts of this effect type, so I didn't change anything. Name one exact FX insert; MCP callers can read its fxId with kyx_state and target it with kyx_plugin_param.",
  "preset-bank-cold":
    "The preset bank is still loading, so I couldn't read it. Nothing was changed — try again in a moment.",
  "preset-target": "Which track should the preset land on? I didn't change anything — name the track.",
};

/**
 * The sentence a producer should read for a decline.
 *
 * Falls back to the reason itself, which is correct for the declines that
 * already use a sentence as their reason and for the Slovak ones the fader
 * and effect clarifications produce ("ktorý fader?").
 */
export function clarifyMessage(reason: string): string {
  return CLARIFY_MESSAGES[reason] ?? reason;
}
