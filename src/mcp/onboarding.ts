/**
 * KYX MCP — AGENT ONBOARDING TEXTS (docs/AGENTIC-DAW-PLAN.md Fáza A).
 *
 * Two `kyx://` resources give a freshly-connected LLM agent the manual and
 * the vocabulary WITHOUT burning tokens on trial-and-error. The texts are
 * compact BY DESIGN — they are loaded into the agent's context on every
 * session, so every kilobyte here is a permanent tax.
 *
 * The vocab is PINNED: tests/mcp-onboarding.test.ts runs representative
 * samples from VOCAB_SAMPLES through the LIVE parsers, so the document
 * cannot silently rot when the parser vocabulary changes.
 */

export const MCP_PLAYBOOK_TEXT = `KYX PRODUCER PLAYBOOK (for LLM agents driving the DAW over MCP)

MENTAL MODEL
- Every mutation goes through the deterministic command layer: clamped
  values, strict targets, ONE undo step. You cannot corrupt the project.
- Every mutating tool returns a VERIFICATION READ-BACK. Trust read-backs
  and kyx_state reads, never the dispatch echo.
- Undo is always available: kyx_undo / kyx_undo redo, and kyx_state
  subject:history lists what happened.

THE CORE LOOP
  read (kyx://project/* resources or kyx_state) -> act (structured tool)
  -> verify (the read-back, then a state read when it matters)

WORKFLOW: WHOLE TRACK IN ONE CALL
  kyx_song {genre, length?, mix?, loudness?} — generates the genre form
  (patterns per section), lays out scenes/clips/markers and applies the
  measured mix profile in ONE undo step; loudness adds a render-backed
  trim as a second step. Slow (full generation) but the biggest gesture
  an agent can make. Use the fine-grained loop below when you want
  control over individual patterns.

WORKFLOW: BEAT FROM SCRATCH
  1. kyx_generate {genre, seed, bars?, bpm?} — deterministic; same seed
     reproduces the same pattern. Prefer 2-4 bars for loops.
  2. kyx_state {subject: pattern} — see the grid before editing.
  3. kyx_steps {op: add/remove/toggle/ghost/clearPad, family, steps} —
     exact 16th edits (steps are 1-based ACROSS the pattern, 16 per bar).
  4. kyx_groove {direction} — swing/humanize; section-scoped when asked.
  5. kyx_mix {genre, tone?, reverb?, punch?, pump?} (or kyx_intent
     "make it punchier") — the MEASURED genre mix profile in one undo.
  6. kyx_arrange {genre, length?} — the whole song form as scenes + clips +
     cue markers in one undo (empty arrangement only); kyx_sections +
     kyx_clips for surgical edits afterwards.
  7. kyx_loudness {op: match, targetDb} — land near -14 LUFS.

WORKFLOW: MIX PASS ON EXISTING MATERIAL
  kyx_state {subject: fxChain} -> kyx_mix for the whole-gesture profile
  (or kyx_fx per family: more/less/remove/bypass) or kyx_intent with
  production concepts ("make the bass deeper") -> kyx_meter / kyx_loudness
  to verify with numbers, not vibes.

WORKFLOW: ARRANGEMENT PASS
  On an EMPTY arrangement start with kyx_arrange {genre, length?} (whole
  form in one undo), then refine with kyx_sections {op: add/duplicate/
  resize/reorder, role, bars?} -> kyx_clips {op: move/resize/duplicate,
  anchor bar} -> kyx_markers {op: add, bar, name}.

TOKEN ECONOMY (your context is finite)
- Prefer the structured tools over free-text kyx_intent: typed arguments
  cannot misparse.
- kyx_batch: up to 10 {tool, args} calls folded into ONE undo — use it for
  series of small edits; per-call failures never abort the batch.
- The kyx://project/* resources are the CHEAPEST way to re-read state.
- Tool results carry a machine-readable data envelope alongside the text —
  parse that instead of prose when you need exact values.

HONEST REFUSALS AND HOW TO REACT
- "generation requests run inside the KYX app" -> you asked kyx_intent to
  CREATE music; use kyx_generate instead (deterministic, seedable).
- "destructive MCP ops are locked" -> removing tracks/sections needs the
  USER to flip the MCP-chip lock. Ask them; undoable edits still work.
- "no track matches family" -> read kyx_state {subject: tracks} and use
  exact ids (many tools accept trackId) or a family from the response.
- "export is not available over this MCP transport" -> start it in the
  KYX window; over transports WITH a render hook, kyx_export awaits and
  reports duration/size.

HYGIENE
- Before a risky sequence, kyx_checkpoint {op: save, name} — and
  kyx_checkpoint {op: restore, name} rolls the WHOLE project back (one
  undo step). Destructive ops auto-save "auto-before-<tool>" checkpoints
  when the user allowed them; kyx_checkpoint {op: list} shows everything.
- Read before acting. One read saves three wrong mutations.
- Generation candidates need in-app auditioning — never claim a beat
  "sounds good" without kyx_loudness/kyx_meter numbers or the user's ears.
- If a tool reports isError, change the ARGUMENTS, not the tool.`;

export const MCP_VOCAB_TEXT = `KYX INTENT VOCABULARY (what free-text kyx_intent understands, EN + SK)

MixER / FADER (per family or track name):
  louder, quieter, up/down, +n dB · hlasnejšie, potichu, o dosť hlasnejšie
  mute / unmute / solo ("mute the drums", "zníž basu")
TEMPO:
  "set tempo to 140", bpm words ("polo času", genre tempo hints)
MIX PROFILE (measured, whole-mix):
  more/less reverb, delay, punch, pump (sidechain), wider, mono-ish
  tone: warmer/darker/brighter ("more reverb, punchier drums", "darker",
  SK: "viac dozvuku", "bez pumpy", "tmavší zvuk")
PRODUCTION CONCEPTS (target-aware, per family: drums/bass/lead/chords):
  deeper, punchier, warmer, darker, brighter, wider, grittier, glue, lofi,
  wobbly, robotic, metallic, filter, sidechain, notch, phaser, chorus,
  sharper, reverse, crunchy, vinyl, wide, sub, air, deess
  ("make the bass deeper", "warmer 808 please", "wobbly drill" -> generation)
COMPLAINTS (the listening loop — measured diagnosis + executable proposals):
  empty / thin / muddy / harsh / no punch + role or family
  ("the drop is empty", "the lead is harsh", "no punch")
STEP EDITS (drum grid):
  remove/delete, ghost, accent/add + kick/snare/clap/hat/perc/tom +
  bar/beat/last 16th ("remove the kick on beat 3 of bar 2", "pridaj ghost
  snare na poslednú 16tinu")
SOUND SWAP (pad descriptor -> factory asset within the family):
  "swap the snare to something fatter", "make the kick darker"
SECTIONS (arrangement):
  intro, build, verse, chorus, drop, break, bridge, fill, outro
  + bar counts and repeats ("16-bar intro", "chorus twice", "drop twice",
  SK: "8 taktov intro", "dva razy drop"); "no break" removes it
GROOVE:
  more/less/tighter swing, humanize; section-scoped ("more swing in the drop")
SEND / BYPASS / PRESETS:
  "more reverb send on the lead", "bypass the delay on the bass",
  preset load/list by name
MARKERS / AUTOMATION / TRANSPORT / UNDO:
  "marker at bar 9", "automate the filter", "undo two steps", play/stop,
  loop, metronome (prefer the STRUCTURED tools: kyx_markers,
  kyx_automation, kyx_transport, kyx_undo)
GENERATION (refused over kyx_intent — use kyx_generate):
  genre words: house, techno, trap, ambient, drill, phonk, jersey, dnb,
  ukg, amapiano, postrock, drone, chiptune, eurodance, latin
PLUGINS (desktop): "aké clapy mám?" / "what claps do I have" -> CLAP scan

Rule of thumb: if a phrase carries a NUMBER + TARGET (steps, bars, dB,
percent), a structured tool is safer than free text.`;
