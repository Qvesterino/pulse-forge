# BUNDLE MEASUREMENT — reálna session vs disk (2026-09-30)

> Meranie: production build (preview :4173), reálny prehliadač, session =
> landing → open studio → TECHNO template → onboarding skip → play →
> (intent generate). Zdroj: `performance.getEntriesByType("resource")`.

## LOADED v normálnej session — 31 chunkov / 2724 KB

| KB   | chunk                  | poznámka                                            |
| ---- | ---------------------- | --------------------------------------------------- |
| 768  | App-\*                 | App + všetko statické (contexty, overlay registry)  |
| 522  | commands-\*            | command barrel — core, každý klik cez neho          |
| 311  | audio-takes-\*         | ⚠ EAGER cez Scheduler/renderer import               |
| 249  | index-\*               | entry                                               |
| 173  | IntentPanel-\*         | default-open panel (A2)                             |
| 140  | sections-\*            | sekčný parser (intent router chain)                 |
| 140  | vendor-react-\*        |                                                     |
| 130  | services-\*            |                                                     |
| 87   | qmr-mini-chip-\*       | QMR chip trigger (panel 991 KB zostáva lazy ✓)      |
| 56   | factory-\*             | sample manifest                                     |
| 51   | song-\*                | PO dynamic-import fixe (bolo 192 KB eager ✓)        |
| ~46  | model-loader/ollama/worker | ⚠ warm aj s flagom OFF — kandidát na defer       |
| ~120| zvyšok (drobné moduly)  |                                                     |

## NIKDY nenačítané — 55 chunkov / 3335 KB (všetko poctivo on-demand)

| KB   | chunk cluster                    | trigger                              |
| ---- | -------------------------------- | ------------------------------------ |
| 991  | qmr-panel-mount                  | QMR chip klik / Ctrl+K               |
| 677+36 | audiotool-nexus                | Audiotool akcia                      |
| 568+72+11 | transformers/ort/onnx       | AI featury (opt-in)                  |
| 166  | mp3                              | MP3 export                           |
| 112  | ArrangementPanel                 | ARR toggle                           |
| 84+24+13 | yjs/YDocStore/CollabSession  | collab join                          |
| 53+44+42+41+36+36+35+32+12+7 | panely (Ultina/Mixer/Reference/Export/Mod/Morph/FxEq/Midi/Dice/Ozvena/Kaskada) | toggle panelu |
| ~250 | route chunky (Gallery/Landing/Agents/Download/Embed) | navigácia |
| ~100 | workers (reference/prior/ranker/stt/onset/pitch) | príslušné akcie |

## Závery

1. **Bucket systém funguje**: 3.3 MB, ktoré by sme mohli "ušetriť", sa v
   normálnej session NENAČÍTA — všetko je poctivo user-triggered.
2. **Eager boot graf (2.7 MB)** má dva veľké ciele na ďalšiu lazy-ifikáciu:
   - `audio-takes` cluster (311 KB) — ťahaný Schedulerom/rendererom
     (core-audio chirurgia, opatrne),
   - `App-*` 768 KB — rozložiť App.tsx statické importy.
3. **Malý finding**: model-loader/ollama/worker (~46 KB + worker spawn) sa
   warmuje aj s `pf:intent-model` OFF — deferred kandidát.
4. Delenie na chunky NEMENÍ DAW-total bucket (súčet všetkého) — mení len
   načasovanie načítania. Tomu rozumieme a budget je zarovnaný (3500).
