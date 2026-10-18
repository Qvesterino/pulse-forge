# SOUND IDENTITY — the decision brief (§3.4 of the Prestige plan)

> **Status: DECIDED — VLYX (2026-10-18), shipped in the fixed order.** The plan's
> §3.4 was an owner decision, and the owner picked VLYX: the brief below still
> records the reasoning for the other two so the choice can be re-examined, and
> §5 is what actually shipped (template → pin → claim card → landing section).

## 0. What "identity" means here

An identity is **not** a new plugin (the plan forbids new DSP) and **not** a logo.
It is the thing a stranger repeats after hearing about the product once:

1. **One signature capability** — a thing you can do here in ten seconds that is
   slow or impossible elsewhere.
2. **One measurable claim** — provable by a command, carried on the status page.
3. **One 60-second demo** — a project shipped as a factory template, not a video.
4. **One verbal mark** — a sentence and a visual accent, added only after 1–3
   exist.

The infrastructure to carry the claim already exists: `npm run status:report`,
the Trust Report, the Session Story, and the reproducibility protocol.

---

## 1. Candidate A — **VLYX** (the verifiable mix doctor)

**Pitch:** _"It hears the mix, tells you what is wrong, and proves what it did."_

- **Exists today:** `src/ui/UltinaPanel.tsx` — REFERENCE MATCH (a target curve
  from a reference sample or the library), MIX ASSIST (render the selected track,
  analyse it, propose device settings), G-MATCH; the vendored core in
  `src/effects/ultina-core/` with golden vectors and 300 s soaks; the analysis
  worker in `src/analysis/` behind a timeout + cancel.
- **The measurable claim:** _"On the demo project, applying the assistant's
  proposal reduces spectral masking in the 200 Hz–5 kHz range by ≥ N dB while
  keeping integrated loudness within ±0.5 LU."_ Measurable today: before/after
  renders + the existing analysis + the loudness path.
- **60-second demo:** open the demo template (a deliberately muddy beat) → MIX
  ASSIST → **show the proposal card with the measured deltas** → apply (one
  undo) → A/B → the card lives in the Session Story afterwards.
- **What must ship:** a demo template, the before/after measured card, a golden
  fixture pinning the numbers, one landing-page section, the claim on the status
  page.
- **Why this is strategic:** it is the only candidate that _is_ the product's
  thesis — AI that shows its work, inside a DAW that stamps its exports. It
  extends the whole trust narrative instead of sitting beside it.
- **Risk:** "AI mix assist" is a crowded phrase; the differentiator must be the
  **proof**, never the adjective. If N cannot be made honest, the direction fails
  and we say so.

## 2. Candidate B — **DRIFT** (the space you can steer)

**Pitch:** _"Drag one dot and the room changes — reflections, plate, hall, at
every frequency."_

- **Exists today:** `src/ui/OzvenaPanel.tsx` — a three-engine blend pad
  (E1 REFLECTIONS / E2 PLATE / E3 HALL) with weights and a numeric blend
  position; the per-frequency decay network in `src/effects/ozvena-core/`;
  quality roadmap + soaks.
- **The measurable claim:** _"Each octave band's RT60 follows the blend position
  within ±5 % of its target curve."_ Measurable from the core's impulse
  responses (the decay network is deterministic).
- **60-second demo:** one dry vocal → three pad positions → the same vocal in
  three rooms, with the RT60-per-band readout on screen.
- **What must ship:** the pad as the panel's front page (it already is), a demo
  template, an RT60-per-band measured card, a golden fixture, a landing section.
- **Why this is strategic:** it is the most _audible_ and most _visually
  distinctive_ object in the app — a sound-first identity, ideal for short video.
- **Risk:** reverbs are commoditized; the identity rests on the pad's
  interaction, which a competitor can imitate faster than the DSP.

## 3. Candidate C — **PRISM** (the surgical EQ with a face)

**Pitch:** _"Paint the curve you hear — and get exactly that curve."_

- **Exists today:** `src/ui/FxEqPanel.tsx` — a 2–6 crossover-band EQ with a
  spectrum paint canvas, dynamics and module pages, per-band params; the
  vendored core + vendor reconciliation; the curve math already exposed as
  `bandEqMagnitudeDb`.
- **The measurable claim:** _"The rendered magnitude response matches the drawn
  curve within 0.1 dB at 1/24-octave resolution."_ Very cheap to pin: the curve
  math is pure and tested.
- **60-second demo:** draw a curve that fixes a phone-speaker-simulated mix →
  the measured response overlay snaps to the drawing → A/B.
- **Why this is strategic:** precision tools earn professional trust, and the
  claim is the easiest to prove.
- **Risk:** EQ is the most commoditized category of the three; the identity would
  lean on the _interaction_, which is excellent but less ownable than AI proof.

---

## 4. Comparison

| Dimension                     | VLYX (mix doctor)                 | DRIFT (space pad)            | PRISM (paint EQ)          |
| ----------------------------- | --------------------------------- | ---------------------------- | ------------------------- |
| Distinctiveness               | high (proof is the moat)          | high (interaction + sound)   | medium (crowded category) |
| Fit with the product's thesis | **strongest** (AI + trust)        | medium                       | medium                    |
| Demo-ability in 60 s          | high, but needs numbers on screen | **highest** (pure listening) | high                      |
| Cost to a provable claim      | medium (analysis + loudness)      | medium (RT60 per band)       | **low** (pure curve math) |
| Risk of being copied quickly  | **low** (needs the harness)**     | medium (interaction)         | high                      |

**Recommendation: VLYX.** The moat in this product is not a sound — it is
_proof around sound_. VLYX is the one candidate whose claim is only believable
because of everything else this repository already built (determinism, the
Trust Report, the Story, the protocol). If the priority is short-video reach
over strategic coherence, DRIFT is the right second choice; PRISM is the
lowest-risk, lowest-differentiation fallback.

## 5. What ships first after the pick (fixed order)

1. **Artifact** — the demo project as a factory template (the existing template
   process), with one undoable "before → after" path.
2. **Pin** — a golden fixture that freezes the claim's numbers (reusing the
   existing golden-vector and benchmark patterns), plus the claim row in
   `docs/status.json` so `npm run drift:check` keeps it honest.
3. **Claim** — the measured card in the app (the Trust Report / Session Story
   already carry measured facts), with the exact command that reproduces it.
4. **Face** — one landing-page section and the verbal mark. **No logo redesign,
   no pricing page, no new DSP.**

## 6. Non-goals (stated so the decision cannot creep)

- No new instrument/effect/DSP suite for the identity; it is a _choice among what
  ships_, not a new build.
- No renaming of existing suites.
- No marketing copy before steps 1–3 exist — a claim without a pin is the exact
  thing the Prestige plan exists to end.

---

**The decision (recorded): `VLYX`.** The fixed order in §5 shipped on 2026-10-18 —
see the Prestige plan's progress log for the artifacts and their pins.
