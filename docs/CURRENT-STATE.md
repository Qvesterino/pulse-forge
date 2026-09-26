# Current State — single source of truth

**Last verified:** 2026-09-26
**Verified by:** direct count against `src/effects/registry.ts`, `src/instruments/registry.ts`, `src/presets/factory.ts`, `src/sample-library/`, `docs/adr/`, `tests/` and the `public/models/*.manifest.json` reports.

This document is the **single source of truth** for the headline numbers about KYX / Pulse Forge. Older documents in this repo (`RELEASE_ROADMAP.md`, `DSP-ROADMAP.md`, `EDIT-ROADMAP.md`, `INSTRUMENT-ROADMAP.md`, `SCENE-MODE-ROADMAP.md`, `INTENT_ENGINE.md`, `KYX_CURRENT_STATE.md`, `MAINTENANCE_AUDIT_PROGRESS.md`, `PERFORMANCE.md`) may carry their own point-in-time numbers; when those disagree with the figures below, **this document wins** for the question "how many / what ships today?".

For an architecture overview, see `ARCHITECTURE.md` and `docs/adr/`. For a user-facing description of every feature, see `README.md`.

---

## Headline numbers

| What                                   |   Count | Source of truth                                                                                                               |
| -------------------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------- |
| **Instruments** (melodic track kind)   |  **19** | `INSTRUMENT_DEFS` / `InstrumentKind` in `src/instruments/registry.ts` and `src/project-model/types.ts`                        |
| **Effects** (registry entries)         |  **47** | `EFFECT_DEFS` in `src/effects/registry.ts` (mirrors `EffectType` union in `src/project-model/types.ts`)                       |
| └─ native/core effects                 |      42 | `EFFECT_ORDER` excluding flagship suites                                                                                      |
| └─ primary Add Effect choices          |      26 | `CORE_EFFECT_ORDER` (the rest are surfaced through the effect rack)                                                           |
| └─ flagship plugin suites              |   **5** | `FLAGSHIP_EFFECT_ORDER` (`fxeq`, `ultina`, `ozvena`, `kaskada`, `morphdynamics`)                                              |
| **Project templates**                  |  **13** | `TemplateId` union in `src/project-model/templates.ts`                                                                        |
| **Factory assets** (drum / tonal / FX) |  **94** | `FACTORY_ASSETS` in `src/sample-library/manifest.ts`                                                                          |
| └─ curated WAV overrides               |      91 | `CURATED_SAMPLES` in `src/sample-library/curated.ts` (same-id override contract; only the 3 mallet slots stay synthesis-only) |
| **Factory presets**                    | **449** | `src/presets/factory.ts`                                                                                                      |
| └─ instrument presets                  |     443 | `FACTORY_PRESETS`                                                                                                             |
| └─ drum-synth presets                  |       6 | `DRUM_FACTORY_PRESETS`                                                                                                        |
| **Architecture decision records**      |  **17** | `docs/adr/0001` … `0015`, plus 0006/0007 each have two companion files                                                        |
| **Vitest spec files**                  | **559** | `tests/` files matching `*.test.ts` and `*.test.tsx`, excluding `tests/e2e/`                                                  |

## Flagship plugin implementations

| Plugin suite    | Brand             | DSP core / ownership                                         | Worklet bundle                     |
| --------------- | ----------------- | ------------------------------------------------------------ | ---------------------------------- |
| `fxeq`          | **PRISM**         | `src/effects/fxeq-core/` (vendored upstream)                 | `public/fxeq-worklet.js`           |
| `ultina`        | **VLYX**          | `src/effects/ultina-core/` (vendored upstream)               | `public/ultina-worklet.js`         |
| `ozvena`        | **VØID**          | `src/effects/ozvena-core/` (vendored upstream)               | `public/ozvena-worklet.js`         |
| `kaskada`       | **Kaskáda Delay** | first-party DSP in `src/audio-worklets/kaskada-processor.js` | `public/core-worklet.js`           |
| `morphdynamics` | **MORPH**         | first-party DSP in `src/effects/morph-dynamics-core/`        | `public/morph-dynamics-worklet.js` |

All five flagship suites use AudioWorklet DSP. PRISM, VLYX and VØID include separately vendored cores reconciled by `scripts/vendor-*.mjs`; Kaskáda and MORPH are first-party DSP owned in-tree. Plugin-specific regression / golden test suites live under `tests/<plugin>-vectors/` and `tests/<plugin>-golden/`.

### Artist roster size

**473 artist presets** in `src/intent/artists.ts` (`ARTIST_PRESETS.length`). Genre spread: trap 148 · house 106 · techno 68 · dnb 40 · ambient 37 · drill 27 · phonk 27 · jersey 20. (Techno was 24 before the techno depth wave — the genre's largest roster hole relative to its weight.)

## AI models shipped in the browser

| Model                      |   Size | Feature version                     | Role                                                                              |
| -------------------------- | -----: | ----------------------------------- | --------------------------------------------------------------------------------- |
| `intent-ranker-v1.onnx`    | ~25 KB | `features.v1` (54 features)         | heuristic-vs-ONNX ranker, default **active** (0.6/0.4 blend)                      |
| `symbolic-prior-v1.onnx`   | ~20 KB | `prior-features.v1` (44 features)   | drum prior fallback branch (one-hot style×role×position)                          |
| `symbolic-prior-v2.onnx`   | ~18 KB | `prior-features-v2` (35 features)   | drum prior intermediate (16-dim semantic conditioning; ds.v2, valAUC 0.845)       |
| `symbolic-prior-v3.onnx`   | ~24 KB | `prior-features-v3` (60 features)   | drum prior **default** branch (hybrid; ds.v2, valAUC 0.905)                       |
| `symbolic-melodic-v1.onnx` | ~18 KB | `melodic-features.v1` (29 features) | melodic next-note prior, **preferred** (valDegreeAcc 0.679)                       |
| `symbolic-melodic-v2.onnx` | ~21 KB | `melodic-features-v2` (41 features) | melodic embedding variant, fallback (ds.v2, valDegreeAcc 0.483; v1 still sharper) |

All six are loaded lazily in dedicated Web Workers with bounded timeouts + circuit breaker + deterministic heuristic fallback (`src/ai/ranking/ranker-client.ts`, `src/ai/symbolic/prior-client.ts`). Inference never runs on the audio thread. Two further models are lazy-fetched on demand (not in git): multilingual MiniLM q8 ~118 MB (`npm run semantic:fetch` → `public/models/semantic/`) and AST AudioSet q8 ~86.6 MB (`npm run audio:fetch` → `public/models/audio/`); both degrade to keyword/heuristic paths when absent. The retrained `hybrid v3` symbolic prior (label smoothing + variant embeddings, logit saturation fix) is the active generation source behind the candidate bank; see `INTENT_ENGINE.md` for the full conditioning chain (semantic embedding, user style vector, SUNO MODE button).

**DnB retrain (2026-09-26)** — the DnB vocabulary wave extended the drum dataset from `symbolic-prior-ds.v1` (87 552 samples / 33 grooves) to **`symbolic-prior-ds.v2` (95 232 samples / 64 grooves)** by training all seven `dnb.*` grooves through the semantic pack (`style-embeddings.json` gained the dnb centroids + variants; the frozen one-hot `PRIOR_STYLE_VOCAB` is untouched). All three embedding-conditioned artifacts were retrained: **v3 valAUC 0.9203 → 0.9047** overall — but on the _identical old split_ (ds.v1 rows reproduced byte-for-byte) the new model scores **0.9247 vs 0.9163**, i.e. the drop is dilution by the hard new dnb groups, not a regression; per-group, `dnb.roller` rose **0.657 → 0.849** and old groups moved ≤ ±2 %. v2 rose **0.8805 → 0.8883** (old split), melodic-v2 rose **0.429 → 0.483** (239 rows / 33 groups, now training DnB bass/chord/lead references added to `MELODIC_BY_GENRE`). Runtime routes `dnb.*` styles past v3's one-hot gate straight to the v2 semantic branch. Full gate: `validate-symbolic-prior v2/v3`, `validate-symbolic-melodic v2`, `v3 hybrid gate 3/3 PASS`, `smoke-symbolic-prior 10/10`.

## Platform reach

- **Browser** — Chromium-family, Firefox and Microsoft Edge are target environments. The current revision passes the Chromium browser verifier at 260/260; Firefox/Edge cross-browser coverage and manual Safari/iOS Safari checks remain separate gates.
- **Desktop** — Windows x64 shipped (NSIS installer + portable exe via `electron-builder`). The MRT2 macOS arm64 path now has a GitHub Actions package gate: after all shared CI checks pass, it builds a DMG + ZIP, verifies the DMG and packaged arm64 app/helper, boots the packaged Electron app in smoke mode, then uploads a 14-day QA artifact. This artifact is unsigned/unnotarized and does not include model weights; it is not a public macOS release or proof of MRT2 inference. Windows MRT2 uses a separate optional companion boundary and remains capture/near-realtime/realtime only after capability and benchmark evidence. Auto-update through GitHub Releases (ADR 0011).
- **Safari / iOS Safari** — manual smoke only; not covered by automated browser verifier.
- **macOS / Linux desktop** — not shipped (ADR 0010 is Windows-only by current target list). The macOS MRT2 CI artifact is an opt-in QA build only; signing/notarization and a real model-inference test remain release requirements.

## Recent additions (last two weeks)

High-level summary of what landed on top of the 2026-09-14 release-readiness candidate. Each item maps to one or more git commits and lives in `src/` today.

### Instruments

- **Flute** (kind #15) — breath-noise + delayed vibrato + legato glide (slide-from with a `GLIDE` knob) + overblow harmonic + formant / drive body. 10 factory presets covering drill slide leads, memphis / liquid / jersey / pan / whistle / breath / reed / air timbres. Browser factory audio QA 252/252. _(feat a2992f2)_

### Effects

- **Morph Dynamics** — fifth flagship plugin. First-party DSP, dedicated `morph-dynamics-worklet.js`, panel under `src/ui/MorphDynamicsPanel.tsx`. _(feat `no dobre teraz` / `okay vša`)_.
- **Granular Freeze send** — texture engine wrapped as a send-effect: freeze latch captures a window, granular cloud (64 grains, 4× overlap, Hann) plays the frozen buffer, dry path is ducked by the same envelope so the send stays usable (not a stack). Released crossfade returns to the live signal. 5 factory presets (Pad Hold / Shimmer Cloud / Deep Drone / Glitch Cloud / Tape Hold). _(feat `700c20d`)_
- **Telephone preset pack** — SVF narrow-band + distortion character for the lo-fi phone / handset chain beatmakers reach for on hooks and fills. 5 pure-preset entries (svf-telephone-band / svf-telephone-band2 / svf-radio-mid / dist-telephone / dist-intercom); no new DSP. _(feat `700c20d`)_
- **Beatmaking expansion** — tapeStop, ringMod, freqShifter, pitchShift, vinyl, beatMangler, multiTapDelay + bassMono master utility. Each ships a dedicated worklet processor, panel UI, factory presets and regression / golden tests. _(feat `0899762`)_
- **Vocoder + Reverse Swell** — two new character send-effects for the FX rack. _(feat `b3a6c69` family)_

### Sample bank expansion

- Kick bank 6 → 15 — drill / phonk / 808s / vintage / club punches / boom-bap knock; genre kits carry dedicated kicks.
- Snare bank 4 → 9 — drill crack, phonk / jersey / dnb backbeats, lofi dust.
- Hat bank 5 → 10 — drill tick, phonk dusty, jersey / dnb metallic pings, open cup; hat.pedal synth pulled apart from closed.soft (0.993 duplicate pair). _(feat `38b8fd0`, `378ab36`)_
- Pop wave — kick.pop, clap.pop stack, crash.pop, tom.floor, rim.pop, shaker.pop + kalimba/musicbox mallets (86 → 94 assets, all with curated WAVs; orphan backfill: cello/nylon/orchestrahit/pizzicato/violin seeds).

### Preset expansion

- Synth presets 199 → 220 — 21 genre-anchored synth voices (analog leads / stabs / pads, wavetable morph leads, fm bells / keys, club plucks). _(feat `7af7c0d`)_
- Drum presets 220 → 232 — 12 genre-anchored drum-synth voices (drill crackers, memphis snare, dusty tom, jersey clap, dnb snare / rim / open cup, first Rimshot type). _(feat `027dcab`)_
- 808 presets 232 → 242 — 10 genre-anchored 808 voices with `GLIDE` front and center for drill / phonk slide ladder. _(feat `2ba6a9d`)_
- Browser factory preset audio QA currently green at 252/252 (after Flute preset addition).
- Pop preset pack — 24 vocal-first presets (bright keys/plucks, lush/bedroom/air pads, marimba/celesta/nylon/rhodes/wurli/sad-piano carriers, round basses, tuned 808s, soft leads, FM bells), all measured into the loudness map.
- Pop preset delta — 7 fill-in voices: intimate upright piano, kalimba + music box (consuming the two orphaned mallet assets), funky moving bass, dance-pop saw lead, FM DX-style piano, vocal-chop pop adlib; tonal/mallet factory assets now all have a preset consumer. _(feat pop preset delta)_

### Intent and AI

- **SUNO MODE button** — "one sentence to a finished track" UI mode plus dynamic song-form expansion (intro / build / drop / outro). Embedding shadow A/B harness for safe rollout. _(feat `e7d3071`, `add0f8b`)_
- **Audio reference intent** — `feat: make it sound like this WAV`. _(feat `daa7d8a`)_
- **User style vector** — blend star-roll embeddings into the conditioning. _(feat `7491b11`)_
- **Melodic prior v2** — embedding-conditioned (41-dim semantic) melodic prior. _(feat `5e571ac`)_
- **Embedding-conditioned prior v2** — Phases D–F of the conditioning chain. _(feat `c7df20b`)_
- **Hybrid v3 prior (active)** — retrained with label smoothing + variant embeddings, logit-saturation fix; activation commit flips the runtime to the new model. _(feat `64e2b61`, `8bd904c`)_
- **Vocabulary wave** — 38 artists, sub-genres, mood / trait expansion. _(feat `33d05a2`)_
- **World roster + genre depth** — researched BPM ranges (west coast / g-funk roster: snoop / dre / warren g & nate dogg / ty dolla on the trap.headnod + trap.gfunk grooves), roller/amen/horrorcore grooves, producer session dialogue. _(feat `a1e1a1b`..)_
- **Club depth wave** — jersey (uniiqu3 / tameil / sliink / 2rare + jersey-club entry), sexy drill (cash cobain + chow lee on drill.bounce), NY/UK/Chicago drill corners (fivio / sheff g + sleepy / headie / digga / 808melo / axl / ghosty / herbo / m1) and phonk depth (kaito shoma / pharmacist drift; xavier wulf / night lovell / bones memphis-lofi) — all styles resolve to real groove ids.
- **Club depth wave 2** — jersey second line (mcvertt / jayhood / nadus / r3ll / unicorn151), bronx drill (b-lovee / kay flock), UK forefront (unknown t) and drift anthems (interworld metamorphosis / dxrk rave).
- **Producer wave** — trap producers (wheezy / southside / tm88 / murda beatz / mike will made-it / hit-boy / london on da track / wondagurl / sonny digital), memphis OG producers (dj squeeky / dj spanish fly / kingpin skinny pimp / playa fly / tommy wright iii), UKG revival (conducta / interplanetary criminal / sammy virji / piri) and UK drill second line (ofb / loski / harlem spartans / digdat) — BPM anchors from SongBPM (Drip Too Hard 113, Black Beatles 146, HUMBLE. 150, Life Is Good 142).
- **Producer wave 2** — plugg producers (mexikodro / cashcache / xangang / senseiatl / forza), opium room (f1lthy / outtatown / lil 88 / ojivolta / richie souf) + drain-gang production (whitearmor / yung gud), amapiano & afro-house producer school (kabza de small / maphorisa / mr jazziq / uncle waffles / major league djz / focalistic / kelvin momo / shimza / black motion / da capo / eno napa / kususa / caiiro / themba), phonk TikTok wave 2 (hensonn / g3ox_em / cypariss / kslv / sxmpra) + rare-phonk school (mythic / backwhen / yung vamp).
- **Crate-digger wave** — jersey/Baltimore producer depth (dj lilman / kayy drizz / so dellirious / dj problem / dj delish / dj tim dolla; baltimore club parent genre at 125–135 with scottie b / k-swift / debonair samir / kw griff / rod lee / miss tonya / blaqstarr), UKG producers (salute / barry can't swim / bassline-niche school: dj q / t2 / burgaboy / jamie duggan / trc), hyperpop deconstruction (umru / felicita / easyfun / life sim / hdmird / shygirl / jockstrap / black dresses), hardcore revival (machine girl / alice gas / sewerslvt / goreshit → dnb.amen) and the sigilkore/witch-house underworld (luci4 / sellasouls / nosgov / sematary / ghost mountain / salem / crim3s / crystal castles / ic3peak).
- **Augmented datasets into all four prior training chains.** _(feat `0c6b105`)_
- **Pop wave** — pop routing (dance-pop/synth-pop/pop-rap/hyperpop → house/trap), 12 pop artist presets, 4 pop grooves (house.pop/synthpop, trap.pop, ambient.pop), POP_FORM (verse/pre-chorus/chorus, hook before ~45 s), pop mix (bright + vocal glue + low-end control) and −9 LUFS pop loudness target.
- **Disco pop sub-genre** — `house.disco` groove (octave-bass walk, offbeat open hats, snare+clap backbeat, 112–124 swung), parser routing (disco / nu-disco / disko / disco funk → house + style disco, ordered above the funky style so "disco funk" stays disco) and 4 researched artists (Kylie 115–128, Bee Gees 100–110, Chic/Nile Rodgers 115–125, Jessie Ware 108–124).
- **Country pop / afro-pop / latin pop sub-genres** — three dedicated grooves: `house.countrypop` (train-beat boom-chicka, shaker 16ths, 96–126), `house.afropop` (3+3+2 kick cross-rhythm + rim melody, 98–112 — distinct from the afro-house groove) and `house.dembow` (the reggaeton chop: rim-snare on the "and" of 1/3, 88–100). Parser routing (afro pop / afrobeats, reggaeton / latin pop / latinský pop, country pop / nashville pop — bare "country" and "country rap/trap" keep legacy readings) + upgraded lanes (afrobeats wizkid/burna entry → afropop 100–112, latin urban j balvin entry → dembow) + 8 researched artists (Shania 96–122, Kacey 88–118, The Chicks 100–130, Carrie Underwood 92–120; Shakira 92–105, Karol G 88–102, Luis Fonsi 92–100, Rauw Alejandro 90–104). Sub-genre × disco word mixes resolve to the disco groove (deliberate global style order); cross-lane artist blends carry lane A's groove with blended sliders.
- **Legends + southern specialties + now wave** — 90s NY (2pac/biggie/wu-tang/jay-z/mobb deep), Dirty South founders (outkast/ugk/scarface/t.i./jeezy/gucci/mannie→bounce), 2000s mainstream (eminem/50/wayne/ross/dmx/busta/missy-timbaland), Bay/LA g-era (too $hort/quik/kurupt/yg-mustard/nipsey/blueface), three 6 + griselda on existing grooves; 5 new grooves (trap.bounce/miamibass/snap/countrytune, house.afroswing) with parser routing + artist lanes; female rap (nicki/cardi/latto/glorilla/sexyy/doechii/simz), latin trap (bunny/myke/duki/pnl), chicago/detroit/LA now, soundcloud era, death grips→dnb.amen; signature sounds (plugg bell, eski lead, syrup FX chain, electro snare, triggerman perc set); artist-name masking in text-parser (a name never doubles as a descriptor unless the name IS the descriptor, e.g. neurofunk).
- **DnB wave** — 29 artist presets across the whole genre tree (liquid: netsky / hybrid minds / high contrast / ltj bukem / dj marky; jump-up: turno / kanine / upgrade / a.m.c / serum; dancefloor: andy c / dimension / culture shock / metrik / grafix; neuro: noisia / black sun empire / phace / misanthrop / ed rush & optical / dom & roland; rollers: break / skeptical / alix perez / dilinja; jungle/ragga: congo natty / shy fx / general levy; two-step: roni size) with researched 160–178 BPM pockets; sub-genre parser sweep (jump up / drumfunk / techstep / darkstep / ragga jungle / halftime / minimal dnb / deep drum and bass — the last fixed to stop falling into house via the bare "deep" stem); context-gated `two step dnb` style so plain "two step" stays UK garage; guarded aliases (`serum` / `break` / `upgrade` only qualified — never hijack synth or arrangement talk); semantic corpus + description vocabulary (12 EN/SK runtime entries, 8 style synonym sets, dnb tempo words). Every style resolves to a real `dnb.*` groove id (`twostep` / `liquid` / `jumpup` / `roller` / `amen` / `dancefloor` / `neuro`).
- **Drum & Bass starter template** (kind #13 in `TemplateId`) — 174 BPM two-step roller with a Reese sub line and open-hat answers, registered in `TEMPLATES`, plus landing-page prompt routing (`liquid dnb 174` / `jump up jungle` forge from the dnb template).
- **DnB mix default** — `GENRE_TONE_DEFAULT.dnb = "dark"` (+2 dB master tilt) with mood/explicit-tone overrides still winning (liquid chill stays warm).
- **Techno depth wave** — the genre's biggest roster hole (24 presets vs trap's 140) closed with the floors that were missing entirely: **Detroit** (jeff mills / derrick may / juan atkins / kevin saunderson / carl craig / robert hood / octave one / terrence dixon + the soul axis omar s / moodymann / theo parrish), **dub techno** (basic channel / maurizio / rhythm & sound / deepchord / deadbeat / monolake / yagya — the `techno.dub` groove had zero artist consumers), **acid** (dj pierre / phuture / hardfloor / emmanuel top / luke vibert / tin man / 999999999 / nico moreno — the `techno.acid` groove had zero artist consumers), **micro-house** (villalobos / sonja moonear / perlon), **electro** (drexciya / dopplereffekt / dj stingray / helena hauff / aux 88 / client_03) and the **90s→now hard lineage** (dave clarke / ben sims / oscar mulero / dvs1 / dax j / len faki / speedy j / paula temple / shlomo). Guarded aliases keep generic words safe (`reese` = the DnB technique, `plug` = the English verb, `big beat` = promo text — all never match as artists). Parser gains `detroit techno` / `detroit electro` / `hardgroove` so they stop falling into the hip-hop "detroit rap" entry.
- **Experimental + score wave** — roadmap wave 12 edges (brockhampton / flying lotus / dälek / cLOUDDEAD / abstract hip-hop), neoclassical + modern-score ambient depth (einaudi / max richter / vangelis / steve roach / sakamoto / biosphere), big-beat + 90s-rave lineage (fatboy slim / chemical brothers / prodigy / orbital / underworld / leftfield) and the 2-step UKG originators (mj cole / artful dodger / zed bias / wookie).

### Arrangement

- Arrangement-as-a-tool — variant swap, ripple edit, paint wiring. _(feat `2a7aa23`)_
- Finish the tool wave — drop-swap, multi-ripple, ghost preview. _(feat `49f678c`)_
- Determinism: velocityFx seedable, determinism verdicts recorded. _(feat `98e2e3b`)_

### Export and interchange

- **BWF Broadcast Wave metadata** — deliverable WAV exports (master, grouped stems, per-track stems, scorepack master/stems, ZYVO transfer) carry an EBU Tech 3285 `bext` chunk: originator, timestamp, sample-accurate time reference and — wherever a render summary exists — the measured loudness in the spec's v2 fixed-point fields (LUFS-I, LRA, true peak, momentary/short-term), which Pro Tools / Nuendo / film workflows read on import. Opt-in at the encoder level (`createBextMetadata` in `src/rendering/wav.ts`), so internal round-trip WAVs (freeze, bounce persistence, consolidation, Qvester handoff) stay byte-compatible. Spec-pinned by `tests/wav-bwf.test.ts`.

### Architecture

- **ADR 0012 — MRT2 generative tracks** records the Mac Apple-Silicon-only generative-tracks helper path; the helper builds in `native/mrt2-host/`, packaging lives in `electron-builder.yml` and `desktop:build:mac:mrt2`. `.github/workflows/ci.yml` gates its downloadable QA artifact on the shared test suite and packaged-app smoke verification.
- **ADR 0013 — Windows generative companion tiers** records the separate Windows manager/transport, capture-first capability tiers, benchmark gate and fixed optional companion/model paths. The checked-in JAX capture host, opt-in WSL2/CUDA near-realtime launcher, SHA-256 package manifest verifier and guarded model-data uninstall script live under `companion/mrt2-windows/`, `desktop/` and `scripts/`; the macOS helper remains Apple Silicon-only. The 2026-09-25 RTX 3060 Laptop 600 s WSL2 stream failed promotion (35.98 ms p95, 9 overruns), so Windows live playback is still experimental and is not advertised as promoted realtime.

## Prior test-gate baseline — not verified on the current revision

The following historical results were recorded against candidate `b8c7a00` on 2026-09-14. `RELEASE_READINESS_REPORT.md` is present but records a separate 2026-09-21 campaign; neither source is evidence for the current revision. Re-run each gate before relying on it.

| Gate                                 | Historical result                                                        | Source                            |
| ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------- |
| `npm run typecheck`                  | PASS (clean `tsc --noEmit`)                                              | candidate `b8c7a00`, 2026-09-14   |
| Full Vitest suite                    | **239 files / 2351 tests passed / 103 skipped / 2454 total** (`424.94s`) | candidate `b8c7a00`, 2026-09-14   |
| Real-browser verifier                | **226/226 in Chromium, Firefox and Edge**                                | candidate `b8c7a00`, 2026-09-14   |
| Factory preset audio QA              | **292/292**                                                              | candidate `b8c7a00`, 2026-09-14   |
| 300 s plugin soaks (PRISM/VLYX/VØID) | PASS (≤ 6 MB heap growth, ≤ 0.003 dB drift, zero tail peak)              | candidate `b8c7a00`, 2026-09-14   |
| `npm audit --omit=dev`               | 0 vulnerabilities                                                        | candidate `b8c7a00`, 2026-09-14   |
| `npm run format:check`               | **DEVIATIONS DOCUMENTED — owner gate open**                              | `docs/FORMAT-CHECK-DEVIATIONS.md` |

The numbers above are point-in-time and may drift between candidate revisions; the document is re-verified manually after each release-readiness review.

## Owner gates still open

These remain unverified for the current revision:

1. Manual browser/device checks (Firefox, Safari, iOS Safari, physical audio-device lifecycle).
2. Deployed smoke against a real `KYX_DEPLOY_URL` (`npm run release:deployed-smoke`).
3. Prettier formatting decision (the recorded 209-file baseline is historical; the 2026-09-25 recheck reports 199 pre-existing paths; `npm run format` across the repository would clear it but create broad churn).

## What this document is NOT

- It is **not** a roadmap. See `RELEASE_ROADMAP.md`, `EDIT-ROADMAP.md`, `INSTRUMENT-ROADMAP.md`, `DSP-ROADMAP.md`, `SCENE-MODE-ROADMAP.md`, `INTENT_ENGINE.md` and `docs/IMPLEMENTATION-ROADMAP-MRT2-GENERATIVE-TRACKS.md` for planned work.
- It is **not** an architecture reference. See `ARCHITECTURE.md` and `docs/adr/`.
- It is **not** a user-facing feature description. See `README.md`.
- It is **not** a changelog. See `git log --oneline` and the commit messages; the "Recent additions" section above is a curated digest, not the full history.

When you change a number above (e.g. you add a new instrument and `INSTRUMENT_DEFS` grows to 16), update this file in the same commit. The whole point is that there's exactly one place readers look for "what ships today".
