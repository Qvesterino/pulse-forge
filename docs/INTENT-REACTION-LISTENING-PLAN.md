# INTENT REACTION + LISTENING — plán (uzavretá slučka spätnej väzby)

> Dva žreby jednej mince: (1) **učenie z reakcií** — čo robíš s mojimi
> návrhmi po tom, ako ich vrátim (undo / keep / ručná korekcia), a
> (2) **pozorné počúvanie** — always-on meranie počas prehrávania, ktoré
> sa ozve len keď má čo povedať. Obe local-first, opt-in, s rovnakou
> gate disciplínou ako zvyšok intent engine.
>
> Súvisiace: `docs/INTENT_ENGINE.md` §5 (mining, style observation),
> `src/intent/style-correction-learning.ts` (existujúci edit→preferencia
> loop pre patterny), `src/intent/failure-log.ts` (mining eventy),
> `docs/INTENT-MCP-EXPANSION-PLAN.md` Phase C (complaints).

---

## 0. Čo už existuje (nepíše sa znova)

| Infraštruktúra         | Kde                                                                                                                                                   | Čo dáva                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Style observation loop | `services.ts:498-500`, `style-correction-learning.ts`                                                                                                 | settled human pattern edit → pairwise preferencia (MIN_FEATURE_DELTA 0.02, preferencia-ledger) |
| Privacy hranica        | `store.executeUserEdit` vs `store.execute`                                                                                                            | human gesture vs vlastný výstup — DAW sa nikdy neučí zo svojho outputu                         |
| Mining eventy          | `failure-log.ts` (logIntentMiningEvent)                                                                                                               | model-hit / model-miss / clarify pri ROUTE čase                                                |
| Preference ledger      | `preference-ledger.ts`                                                                                                                                | lokálny pairwise ledger + flag + export                                                        |
| Complaints / diagnóza  | `complaints.ts`                                                                                                                                       | sťažnosť → meranie → ohraničený návrh                                                          |
| Meracie funkcie        | `audio-features.ts` (V2: centroid/rolloff/flatness/harmonicity), `extractStereoAudioFeatures` (width), `analyzeLoudnessBuffer`, `truePeakOversampled` | pure math nad Float32Array                                                                     |
| renderTrack            | `rendering/track-renderer.ts`                                                                                                                         | offline render jedného tracku (filtered doc)                                                   |

**Medzera #1:** intent akcie idú cez `store.execute()` — teda SÚ zámerne
neviditeľné pre style observer (správne: DAW sa nesmie učiť zo svojho
výstupu). Ale **reakcia POUŽÍVATEĽA na vlastný výstup** je iný signál —
a ten dnes nikto nezachytáva.

**Medzera #2:** počas prehrávania engine nič neanalyzuje; mixDoctor aj
metering sú on-demand.

---

## 1. F1 — Reaction Ledger (signál)

### Čo sa zachytáva (a čo NIE)

Pri každej **intent-aplikovanej akcii** (paramIntent, effectIntent,
paramIntent z modelu, mix, loudness, song, …) sa označí „čaká na reakciu":
{ts, route kind, compact action (už sanitizovaný), affected track ids,
content hash}. Potom:

- **KEEP** — 90 s bez undo tej akcie ALEBO transport sa pustil/posunul ďalej → `kept`
- **UNDO** — používateľ undo-uje práve tú akciu (store históriu pozná) → `undone` (undo do 5 s od apply = mash-guard, nezaznamená sa)
- **TWEAK** — po kept, `executeUserEdit` zasiahne rovnaké tracky v rámci okna → `tweaked` + before/after content hashe (korekčný pár — ten istý kontrakt ako style-correction-learning)

**Čo sa NIKDY nezachytáva:** prompt/text, audio, projekty, mená, názvy
trackov. Len compact action JSON + hashe + časovania. Local-only
(IndexedDB rovnaký vzor ako preference-ledger), opt-in flag
`pf:reaction-ledger` (default ON, kill switch v paneli), export tlačidlom.

### Súbory

| Súbor                                  | Rola                                        |
| -------------------------------------- | ------------------------------------------- |
| `src/intent/reaction-ledger.ts` (nový) | eventy, okná, mash-guard, sanitizér, export |
| `src/ui/IntentPanel.tsx` (dotyk)       | po apply zaregistrovať reakciu; undo hook   |
| `services.ts` (dotyk)                  | prepojenie store undo eventov → ledger      |

### Brány F1

- Testy: keep/undo/tweak okná, mash-guard (5 rýchlych undo = 1 event alebo 0), opt-in off = nič, export tvar, žiadny prompt/text v ledgeri, undo generovanej akcie NEspustí style observer (hranica zostáva)
- Flag off = nulová réžia (žiadne listenery)

---

## 2. F2 — Reakcie → učenie (uzáver)

- **Report**: `reaction-summary` (kept/undone/tweaked per route kind) — do MCP (kyx_diagnose štýl) a do panelu
- **Corpus cesta**: undone akcia + tweaked after-state = nový teacher pár (mining wave vzor: re-route cez súčasný parser = vždy aktuálny label); kept akcie = weight-only posily
- **Rerank**: reakcie kŕmia rerank-weights fit (už existuje) — selekcia sa učí poriadky, nie len audio-fit
- **Model gate**: retrain IBA keď reakcií ≥ 50 a val split rastie; rovnaké brány (≥95 % / 0 wrongKind / abstain ≤ 23 %) + INT8 føllow-up
- **Bias guard (predregistrovaný)**: reakcie REUSPORIADUJÚ gated kandidátov, nikdy nevytvárajú akcie mimo schémy; ledger sa dá zmazať + exportovať (užívateľ vlastní dáta)

---

## 3. F3 — Always-on Listening (pozorný režim)

- Opt-in toggle (🎧 POZORNÝ REŽIM) — default OFF
- Počas prehrávania: na sekčných hraniciach / každých ~20 s krátke meranie cez existujúci metering tap (nie nový worklet; rafLoop disciplína, žiadna práca v audio callbacku)
- Diagnóza cez complaints slovnú zásobu (empty/thin/muddy/harsh/noPunch) + mixDoctor typ metriky → **návrh chip** (audition-first, nikdy tiché pečiatky)
- Ticho štandard: bez nálezu žiadny output; max 1 návrh per sekcia
- CPU rozpočet: analýza mimo hot path, flag off = nulový loop

---

## 4. F4 — Overenie

- ABX lane pre F3 návrhy (existujúci `listening/abx` harness) — „návrh pomohol" ako merateľné tvrdenie
- Owner ear-pass na F1: reakcie z reálneho sedenia → corpus diff → retrain → gate → ABX FP32-vs-nový

---

## Poradie, odhady, brány

| Fáza | Obsah                                           | Odhad    | Gate                                                   |
| ---- | ----------------------------------------------- | -------- | ------------------------------------------------------ |
| F1   | reaction ledger + undo/keep/tweak okná + export | ~1 deň   | 16+ testov, opt-in off = 0 réžia, privacy pin testy    |
| F2   | reakcie → corpus/rerank + report                | ~0,5 dňa | summary testy, bias-guard piny                         |
| F3   | always-on meranie + návrh chipy                 | ~1 deň   | CPU guard testy, flag off = 0 loop, max 1 návrh/sekciu |
| F4   | ABX + owner ear-pass                            | owner    | p-hodnota z reálneho sedenia                           |

## Mimo scope

Reakcie ako tréning dát mimo lokálneho stroja (žiadny cloud), automatické
opravy bez súhlasu, učenie z audio obsahu (len z metrík), zmena
privacy hranice style observera.
