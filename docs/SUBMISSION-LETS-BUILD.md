# KYX × Audiotool Nexus — Let's Build submission pack

> Deadline: **Monday 28 September 2026** (submissions close the same day).
> This file is the copy-paste source for every submission surface: the sign-up
> form, the Discord submission channel, demo-video description, and any final
> submission form. Fill the two `«FILL»` placeholders before sending.

---

## 1. The pitch (one paragraph, ~80 words — form/Discord-ready)

**KYX** is a browser-native digital audio workstation that turns a written
prompt into a finished, playable beat: describe your idea in plain language,
KYX proposes several candidate beats with real synthesized audio, you audition
them live, tweak instruments, effects and mix — all offline-capable, nothing
leaves your machine. With the new **Audiotool Nexus connector**, you send the
idea you kept as fully editable MIDI — synth, note track, region and mixer
route — straight into your own Audiotool session, after an explicit preview
and confirmation. No overwrites, ever.

Deployed app: «FILL — production URL»
Demo video: «FILL — video link»
Repository: github.com/«FILL — repo» (contains the Nexus integration under
`src/integrations/audiotool-nexus/` and `src/ui/AudiotoolNexusExport.tsx`)

---

## 2. Category fit (submit where judges look first)

| Category        | Why KYX qualifies                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Songstarter** | The core loop: text prompt → multiple candidate beats → live audition → keep one. Sparks the creative starting point.                  |
| **Composition** | Intent engine with scene structure, groove vocabulary (600+ artist presets), key/mode conditioning — craft, not slot machine.          |
| **Connect**     | The Nexus bridge: KYX selected idea → editable Audiotool session material (Songstarter/Composition tool extending Audiotool workflow). |

Lead with **Songstarter** in all copy; mention Connect as the Nexus story.

## 3. What the Nexus integration does today (honest capabilities)

- **Connect to Audiotool**: user opens any Audiotool Studio project by URL;
  KYX validates it is an official `beta.audiotool.com/studio` project link.
- **Preview before write**: the exact write plan (parts, note counts, bars,
  BPM) is shown; nothing is sent until the user explicitly confirms.
- **Create-only write**: per supported part KYX creates a Heisenberg synth,
  a note track + region + collection with the mapped MIDI notes (KYX 480 PPQ
  → Audiotool 3,840), a mixer channel, and an audio cable — in one Nexus
  transaction. Existing project content is never modified.
- **Idempotent retry**: a fingerprint marker makes retries safe; an incomplete
  previous import is detected and reported instead of duplicated.
- **Opt-in and lazy**: the SDK loads only after the user clicks Connect;
  KYX works fully without it (offline MIDI/scorepack export remains).

**Not supported yet (stated, not hidden):** drum-pattern lanes (drum-only
ideas are reported as unsupported), audio/stem transfer, importing Audiotool
content into KYX, Safari/Electron (Chromium + Firefox is the tested path).

## 4. AI & licensing disclosure (judges increasingly ask)

- Generation is a **deterministic local engine** (seeded intent parser +
  candidate bank). An optional small ONNX intent-ranker reorders candidates;
  it loads behind a timeout + circuit breaker and falls back to the built-in
  deterministic heuristics when absent.
- No MRT2 / third-party generative weights are part of this submission.
- The Nexus connector loads Audiotool's own SDK + WASM validator from the
  official Audiotool CDN at runtime; no Audiotool assets are redistributed.
- Third-party code: `@audiotool/nexus` 0.0.19 (pinned; LICENSE/NOTICE files
  ship with the deployed build — npm metadata says MIT, the repository
  LICENSE says Apache-2.0, we distribute the conservative NOTICE pending
  clarification from the publisher), React/Vite/etc. per generated NOTICE.
- All demo audio is synthesized in-browser by KYX; no third-party samples
  that are not already factory-shipped are used in the demo.

## 5. Sign-up form fields (already open — docs.google.com form, ~2 min)

1. E-mail — «FILL»
2. First / Last name — «FILL»
3. **URL of your Audiotool user account** — create one at audiotool.com if
   missing; copy the profile URL — «FILL»
4. Partner organization — **No** (unless applicable)
5. Agree to ToS / Privacy / Community Guidelines — tick
6. Newsletter — your choice

After submitting: **join the Discord** (audiotool.com/discord) — that is
where contest content is distributed and where final project submission
happens per the FAQ.

## 6. 90-second demo video shot list (screen recording)

Record at 1080p, Chromium, fresh profile, audio on. Rehearse once.

| Time      | Shot                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------- |
| 0:00–0:08 | Landing page + one-sentence pitch (voice-over): "You describe it, KYX plays it."                   |
| 0:08–0:25 | IntentPanel: type a brief (e.g. "dark drill, sliding 808s, 140"), hit generate, candidates appear. |
| 0:25–0:40 | Audition two candidates back-to-back; pick one; hint at the mixer / piano roll briefly.            |
| 0:40–0:55 | **Send to Audiotool**: Connect flow — paste project URL, plan preview appears (parts/notes).       |
| 0:55–1:10 | Confirm; receipt shows created entities.                                                           |
| 1:10–1:30 | Cut to Audiotool Studio: the same project now contains the KYX parts; press play in Audiotool.     |

Caption lower-third during 0:40–1:30: "Audiotool Nexus — editable MIDI,
create-only, confirmed."

If the live write cannot be demoed (missing OAuth client), record 0:00–0:40
plus the plan-preview state and say honestly: "the connector writes after
confirmation — full live run in the repo test suite (11 integration tests,
offline Nexus document)."

## 7. Owner checklist (deadline day, in order)

- [ ] **Sign-up form** submitted (section 5) — even if the app isn't perfect.
- [ ] **Discord joined**, find the submission channel + rules/FAQ Notion.
- [ ] **Deploy `dist-contest/`**: Cloudflare Pages → Create project →
      **Upload assets** → drag the `dist-contest` folder (26 MB, 206 files,
      all under the 25 MiB per-file limit). Or `npx netlify deploy --prod --dir=dist-contest`.
      Put the URL into section 1.
- [ ] **Register OAuth app** at developer.audiotool.com (public client ID;
      redirect origins: `http://127.0.0.1:5173` + the production URL),
      set `VITE_AUDIOTOOL_NEXUS_CLIENT_ID`, rebuild + redeploy.
- [ ] **Live write smoke** into a throwaway Audiotool project (one part is
      enough); delete the test entities afterwards.
- [ ] **Record the demo video** (section 6), upload (YouTube unlisted /
      Drive), link into section 1.
- [ ] **Post the submission** per the Discord/FAQ instructions; email
      events@audiotool.com with the pitch + links as a fallback paper trail.

## 8. FAQ traps to double-check (Notion FAQ, 5 minutes)

- Exact submission time + timezone for 28 September (submit at least 2 h early).
- Whether the project must be created **during** the hackathon window (KYX
  predates it — pitch framing: "the Nexus integration was built for
  Let's Build"; if prior work is disqualifying, ask the judges on Discord
  before submitting).
- Whether the demo must be **published on Audiotool** (platform publish vs.
  external video) — "published music application" wording.
- Team/IP grant terms in the submission form, if any.
