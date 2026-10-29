import { addAutomationRamp } from "../src/commands/automation";
import { addEffectToTracks } from "../src/commands/commands";
import type { TargetingScenario } from "../src/mcp/targeting-benchmark";
import type { ProjectDocument } from "../src/project-model/types";
import { testDoc } from "./fixtures/doc";

/**
 * E9 — the seeded scenario catalog for the MCP targeting benchmark.
 *
 * Every scenario builds its world from the house fixture (testDoc: Drums +
 * "808" + "Chords", 1 scene/pattern, 3 returns) and closes over the ids of
 * THAT template, so expectations name exact track ids while each RUN gets a
 * fresh `structuredClone` (the store mutates its document). Direct tool
 * calls carry known-by-construction targeting truth; the NL intents are
 * forms already pinned by the router's own suites. The adversarial set is
 * the audit's Layer-2 adversarial class list: negated mutation, hypothetical
 * question, unknown object, descriptive non-command, bare transport.
 */

const BASE = testDoc();
const DRUMS_ID = BASE.tracks.find((track) => track.kind === "drum")!.id;
const BASS_ID = BASE.tracks.find((track) => track.kind === "instrument" && track.name === "808")!.id;

function withDelayTemplate(): ProjectDocument {
  const doc = structuredClone(BASE);
  return addEffectToTracks(doc, [BASS_ID], "delay").execute(doc);
}

const DELAY_TEMPLATE = withDelayTemplate();
const DELAY_FX_ID = DELAY_TEMPLATE.tracks
  .find((track) => track.id === BASS_ID)
  ?.effects.find((fx) => fx.type === "delay")!.id;

function withLaneTemplate(): ProjectDocument {
  const doc = structuredClone(DELAY_TEMPLATE);
  return addAutomationRamp(
    doc,
    { kind: "fxParam", trackId: BASS_ID, fxId: DELAY_FX_ID, paramId: "mix" },
    0,
    0.2,
    960,
    0.8,
  ).execute(doc);
}

const LANE_TEMPLATE = withLaneTemplate();

const fresh = (): ProjectDocument => structuredClone(BASE);
const freshDelay = (): ProjectDocument => structuredClone(DELAY_TEMPLATE);
const freshLane = (): ProjectDocument => structuredClone(LANE_TEMPLATE);

export const TARGETING_SCENARIOS: readonly TargetingScenario[] = [
  // ── TARGETING: the action must land on the named object and nowhere else ──
  {
    id: "T1-intent-mute-drums",
    category: "targeting",
    description: "NL 'mute the drums' mutes ONLY the drum track",
    doc: fresh,
    call: { kind: "intent", instruction: "mute the drums" },
    expect: { mutated: true, changedDocFields: ["tracks"], changedTracks: [DRUMS_ID] },
  },
  {
    id: "T2-intent-tempo-140",
    category: "targeting",
    description: "NL 'set tempo to 140' changes only doc.bpm",
    doc: fresh,
    call: { kind: "intent", instruction: "set tempo to 140" },
    expect: { mutated: true, changedDocFields: ["bpm"] },
  },
  {
    id: "T3-intent-key-a-minor",
    category: "targeting",
    description: "NL 'set key to A minor' changes only doc.key",
    doc: fresh,
    call: { kind: "intent", instruction: "set key to A minor" },
    expect: { mutated: true, changedDocFields: ["key"] },
  },
  {
    id: "T4-music-settempo",
    category: "targeting",
    description: "kyx_music setTempo is the structured tempo path",
    doc: fresh,
    call: { kind: "tool", name: "kyx_music", args: { op: "setTempo", bpm: 141 } },
    expect: { mutated: true, changedDocFields: ["bpm"], textContains: ["141"] },
  },
  {
    id: "T5-tracks-setgain",
    category: "targeting",
    description: "kyx_tracks setGain moves ONLY the named track",
    doc: fresh,
    call: { kind: "tool", name: "kyx_tracks", args: { op: "setGain", trackId: BASS_ID, gainDb: -3 } },
    expect: { mutated: true, changedDocFields: ["tracks"], changedTracks: [BASS_ID] },
  },
  {
    id: "T6-steps-add-kick",
    category: "targeting",
    description: "kyx_steps add writes pattern rows, not tracks or transport state",
    doc: fresh,
    call: { kind: "tool", name: "kyx_steps", args: { op: "add", family: "kick", steps: [1, 5] } },
    expect: { mutated: true, changedDocFields: ["patterns"] },
  },
  {
    id: "T7-markers-add",
    category: "targeting",
    description: "kyx_markers add writes exactly the markers array",
    doc: fresh,
    call: { kind: "tool", name: "kyx_markers", args: { op: "add", bar: 2, name: "Bridge" } },
    expect: { mutated: true, changedDocFields: ["markers"] },
  },
  {
    id: "T8-automation-addpoint",
    category: "targeting",
    description: "kyx_automation addPoint writes exactly the automation array",
    doc: fresh,
    call: {
      kind: "tool",
      name: "kyx_automation",
      args: { op: "addPoint", trackId: BASS_ID, param: "gain", bar: 2, value: 1.2 },
    },
    expect: { mutated: true, changedDocFields: ["automation"] },
  },
  {
    id: "T9-plugin-param-set",
    category: "targeting",
    description: "kyx_plugin_param set moves the effect param on the owning track only",
    doc: freshDelay,
    call: {
      kind: "tool",
      name: "kyx_plugin_param",
      args: { op: "set", trackId: BASS_ID, effect: "delay", param: "mix", value: 0.5 },
    },
    expect: { mutated: true, changedDocFields: ["tracks"], changedTracks: [BASS_ID] },
  },
  {
    id: "T10-instrument-param-set",
    category: "targeting",
    description: "kyx_instrument_param set moves the instrument param on its own track",
    doc: fresh,
    call: {
      kind: "tool",
      name: "kyx_instrument_param",
      args: { trackId: BASS_ID, op: "set", param: "decay", value: 2 },
    },
    expect: { mutated: true, changedDocFields: ["tracks"], changedTracks: [BASS_ID] },
  },

  // ── ADVERSARIAL: the ask must NOT mutate — ask-back or honest decline ──
  {
    id: "A1-negated-mutation",
    category: "adversarial",
    description: "'turn down the drums and DON'T TOUCH the bass' must stop and ask",
    doc: fresh,
    call: {
      kind: "intent",
      instruction: "turn down the drums and don't touch the bass",
    },
    expect: {
      mutated: false,
      errorCode: "POLICY_REFUSED",
      changedDocFields: [],
      textContains: ["Send the change on its own"],
    },
  },
  {
    id: "A2-hypothetical-question",
    category: "adversarial",
    description: "a 'should I …?' question never mutates",
    doc: fresh,
    call: { kind: "intent", instruction: "should I add more reverb to the drums?" },
    expect: { mutated: false, changedDocFields: [], changedTracks: [] },
  },
  {
    id: "A3-unknown-object",
    category: "adversarial",
    description: "'mute the trumpet' names an object the project does not have",
    doc: fresh,
    call: { kind: "intent", instruction: "mute the trumpet" },
    expect: { mutated: false, changedDocFields: [], changedTracks: [] },
  },
  {
    id: "A4-descriptive-not-command",
    category: "adversarial",
    description: "'the bass sounds muddy' describes, it does not command",
    doc: fresh,
    call: { kind: "intent", instruction: "the bass sounds muddy" },
    expect: { mutated: false, changedDocFields: [], changedTracks: [] },
  },
  {
    id: "A5-bare-transport",
    category: "adversarial",
    description: "bare 'play' never touches the document",
    doc: fresh,
    call: { kind: "intent", instruction: "play" },
    expect: { mutated: false, changedDocFields: [], changedTracks: [] },
  },

  // ── REFUSAL: typed error codes, nothing changed ──
  {
    id: "R1-unknown-track-id",
    category: "refusal",
    description: "setGain on a nonexistent track refuses with UNKNOWN_TARGET",
    doc: fresh,
    call: { kind: "tool", name: "kyx_tracks", args: { op: "setGain", trackId: "track-nope", gainDb: -3 } },
    expect: { mutated: false, errorCode: "UNKNOWN_TARGET", changedDocFields: [] },
  },
  {
    id: "R2-param-nonnumeric",
    category: "refusal",
    description: "a non-numeric param value refuses with INVALID_ARGUMENTS, no write",
    doc: freshDelay,
    call: {
      kind: "tool",
      name: "kyx_plugin_param",
      args: { op: "set", trackId: BASS_ID, effect: "delay", param: "mix", value: "loud" },
    },
    expect: { mutated: false, errorCode: "INVALID_ARGUMENTS", changedDocFields: [] },
  },
  {
    id: "R3-destructive-locked",
    category: "refusal",
    description: "kyx_fx remove without the destructive gate is POLICY_REFUSED",
    doc: freshDelay,
    host: { allowDestructive: false },
    call: { kind: "tool", name: "kyx_fx", args: { action: "remove", effect: "delay", trackId: BASS_ID } },
    expect: { mutated: false, errorCode: "POLICY_REFUSED", changedDocFields: [] },
  },
  {
    id: "R4-unknown-step-family",
    category: "refusal",
    description: "kyx_steps with a family outside the enum refuses with UNKNOWN_REQUEST",
    doc: fresh,
    call: { kind: "tool", name: "kyx_steps", args: { op: "add", family: "kazoo", steps: [0] } },
    expect: { mutated: false, errorCode: "UNKNOWN_REQUEST", changedDocFields: [] },
  },

  // ── VERIFICATION: the receipt must SAY what happened ──
  {
    id: "V1-automation-disclosure",
    category: "verification",
    description: "E5: a param set under a live lane discloses the masking in the receipt",
    doc: freshLane,
    call: {
      kind: "tool",
      name: "kyx_plugin_param",
      args: { op: "set", trackId: BASS_ID, effect: "delay", param: "mix", value: 0.5 },
    },
    expect: {
      mutated: true,
      changedDocFields: ["tracks"],
      textContains: ["automation still controls the effective value", "edit a lane with kyx_automation"],
    },
  },
  {
    id: "V2-state-read-only",
    category: "verification",
    description: "kyx_state overview is a read: nothing mutates, tempo is reported",
    doc: fresh,
    call: { kind: "tool", name: "kyx_state", args: { subject: "overview" } },
    expect: { mutated: false, changedDocFields: [], textContains: ["124"] },
  },
  {
    id: "V3-requestid-replay",
    category: "verification",
    description: "the same requestId twice: the second receipt is a replay and changes nothing",
    doc: fresh,
    call: {
      kind: "tool",
      name: "kyx_tracks",
      args: { op: "setGain", trackId: BASS_ID, gainDb: -2, requestId: "bench-replay-1" },
    },
    expect: { mutated: true, changedDocFields: ["tracks"], replayWithSameRequestId: true },
  },
  {
    id: "V4-tempo-readback-names-value",
    category: "verification",
    description: "the tempo read-back names the landed number",
    doc: fresh,
    call: { kind: "intent", instruction: "set tempo to 141" },
    expect: { mutated: true, changedDocFields: ["bpm"], textContains: ["141"] },
  },
];
