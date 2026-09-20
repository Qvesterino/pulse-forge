# KYX — Viral Growth Plan

> **Téza:** Intent engine je produkt. DAW je retention vrstva.
> Používateľovi musí stačiť jedna veta — „temný trap 140“ — a do minúty má vlastný beat, ktorý môže zdieľať.
>
> Stav: návrh pripravený na implementáciu · 2026-09-20 · Autor: audit + produktná recon (ZCode)

---

## 1. North-star a metriky

| Metrika | Definícia | Cieľ |
|---|---|---|
| **TTFB** (time-to-first-beat) | Prvé otvorenie stránky → používateľ počuje **vlastný** vygenerovaný beat | < 60 s prvýkrát, < 30 s pri druhej návšteve |
| Prompt→zvuk konverzia | % návštevníkov landing page, ktorí aspoň raz prehrajú výsledok promptu | > 25 % |
| Share moment | % úspešne vygenerovaných beatov, po ktorých používateľ klikne Publish / Video / Copy link | > 10 % |
| Galéria ako vstup | % nových session začatých cez Remix/Regenerate z galérie | rast mesiac nad mesiacom |

Meriame jednoducho (Fáza A4): čítače v `localStorage` + neskôr voliteľný beacon. Žiadne accounty, žiadny server pre core.

---

## 2. Audit funnelsu — kde presakujú používatelia (overené v kóde)

### Čo už existuje a funguje
- **Intent engine**: `src/intent/` — parser EN+SK, kandidátsky bank + ranking, audition, revise routing („viac energie“), song builder (verš/refren/bridge), mix chain, semantická vrstva (lazy, 118 MB model len pri slabom parsovaní).
- **Video export** pre Reels/TikTok: `src/export/video.ts` (canvas + audio mux, formát guard `canExportVideo()`).
- **Galéria** s publish + remix: `src/gallery/` (`GalleryPage`, `PublishButton`, `remix.ts`).
- **Share linky + embed player**: `src/export/shareCode.ts`, `src/embed/EmbedApp.tsx` (celý projekt v URL `#p=<code>`, `?import=` ho hodí priamo do štúdia).
- **Landing** so živým hero playerom: `src/landing/LandingPage.tsx` — renderuje reálny house template cez offline engine.
- **First-run routing**: `src/main.tsx` (`pf-onboarded` flag, `enterStudio()`), demo projekt po vstupe.

### Kde funnel presakuje
1. **Landing predáva DAW, nie kúzlo.** Features sú „Chop beats“, „Pro plugin suites“ — jazyk pre ľudí, ktorí vedia čo je MPC. Intent engine (jediný skutočný diferenciátor) nie je na landing page spomenutý ani ukázaný.
2. **V štúdiu musí nový používateľ INTENT nájsť.** Panel nie je defaultne otvorený; demo projekt hrá, ale nepatrá používateľovi.
3. **Share moment nie je naviazaný na generovanie.** Po `USE` (aplikovaní kandidáta) žiadne CTA — používateľ si má sám nájsť ExportPanel/Publish.
4. **Galéria je len výjazd.** Chýba „Regenerate with intent“ — každý publikovaný beat je mŕtvy koniec funnelu namiesto vstupného bodu.

---

## 3. FÁZA A — Prompt-first (najvyšší dopad, najmenší nový kód)

Všetky diely existujú; Fáza A je **wiring + UI**. Cieľ: typu „napíš → počuj → vlastníš → zdieľaj“ bez jediného kliku zbytočne.

### A1 — Prompt box na landing page (`M`, jadro fázy)
`src/landing/LandingPage.tsx`

- Nový komponent `LandingPrompt` nad hero playerom: input + žánrové chips („dark trap 140“, „sunny house 124“, „lo-fi 85“…) + tlačidlo **Forge it**.
- Generovanie 100 % client-side: `createProjectFromTemplate(žánr z promptu)` → `generateAsyncResult(doc, …)` z `src/intent/pipeline.ts`. Bežné žánre pokryje keyword parser — **žiadny model download na landing page** (semantická vrstva ostáva lazy).
- Prehratie cez rovnakú offline render cestu, ktorú dnes beží hero player (EmbedApp dokazuje, že to na landing page funguje).
- **Autoplay politika:** prehratie vždy až na klik používateľa (Forge it / Play) — user gesture, browser autoplay policy teda nevadia. Typ samotný nič nehrá.
- Status: „Generating…“ → „▶ Preview · Forge it in studio“.
- Handoff do štúdia: úspešná generácia uloží vybraný dokument do `sessionStorage` (`pf-pending-doc` = share code); `Boot` v `main.tsx` si ho po `enterStudio` vyzdvihne a otvorí štúdio s beatom už aplikovaným. (Robustná alternatíva `?import=` má dlhý URL — sessionStorage je čistejšie; fallback: ak storage zlyhá, štúdio sa otvorí normálne.)
- Landing copy: hero nadpis doplniť o promise — „**Describe it. Hear it. Own it.**“ / SK „Napíš to. Počuj to. Vlastni to.“ Features sekcia dostane prvú kartu **„Type a beat into existence“**.

### A2 — Prvé spustenie v štúdiu: INTENT defaultne (`S`)
`src/main.tsx` + `src/ui/IntentPanel.tsx`

- Nový flag `pf-intent-seen`: pri **prvom** vstupe do štúdia sa IntentPanel otvorí automaticky s focusom v poli (demo projekt ostane pod tým — niečo hrá hneď).
- Ak prišiel pending doc z A1, IntentPanel sa otvorí s predvyplneným promptom a statusom „Your beat — tweak it or Forge another“.

### A3 — Share moment po USE (`S`)
`src/ui/IntentPanel.tsx` (+ malý zdieľaný CTA komponent)

- Po úspešnom `applyGenerationResultCommand` sa vedľa statusu „✓ 3 candidates“ objaví **Share CTA**: `Publish to gallery` · `Export VIDEO` · `Copy link`. Všetky tri existujú (`PublishButton`, `recordVideo`, `encodeShareCode`) — len sa zapoja na miesto momentu hrdosti.
- Po prvom USE jeden toast: „This beat is yours — it autosaves locally. Share it?“

### A4 — Meracie hooky (`S`)
Nový malý modul `src/services/funnel.ts`: `funnelEvent(name)` → `localStorage` čítače + `console.debug`. Eventy: `landing_prompt_played`, `landing_forged`, `studio_first_apply`, `share_clicked` (s variantom). Diagnostics panel si ich neskôr vypíše.

### Akceptačné kritériá Fázy A
- [x] Z landing page: napíšem prompt → klik → počujem beat. **Bez vstupu do štúdia.** *(A1 dodané 2026-09-20)*
- [x] Klik na Forge it → štúdio sa otvorí s týmto beatom, IntentPanel je otvorený a predvyplnený. *(A1+A2 dodané)*
- [x] Úplne prvá návšteva štúdia (bez promptu) → IntentPanel otvorený, pole má focus. *(A2)*
- [ ] Po každom USE sú viditeľné tri share akcie; každá funguje ako doteraz. *(A3 — ešte nie)*
- [x] Funnel eventy sa zapisujú (`pf-funnel-v1`); landing bundle sa nezväčší o model ani engine navýše existujúceho EmbedApp path. *(A4-lite)*
- [x] E2E smoke: landing prompt → studio (rozšírený `01-landing-to-studio`, plný forge test v Chromium).

**Poznámky z implementácie (2026-09-20):** handoff beží peek+clear-po-úspechu (StrictMode dvojité mountnutie Bootu by take-and-clear prehltil); corrupt handoff padá na normálne otvorenie štúdia; corrupt `?import=` link zostáva viditeľná chyba. E2E helpery seedujú `pf-intent-opened`, nech generické špecy držia klasický default dock — auto-open pokrýva dedikovaný forge špec.

---

## 4. FÁZA B — Galéria ako vstupný bod (share loop)

### B1 — Remix + Regenerate na každej karte (`M`)
`src/gallery/GalleryPage.tsx`, `src/gallery/remix.ts`

- Každý beat dostane dve akcie: **Remix in studio** (existuje) a **Regenerate** — z publikovaného projektu prečíta intent/seed a pustí novú generáciu s rovnakým characterom, iným seedom. Publikované projekty si majú ukladať intent metadáta (rozšírenie publish payloadu — spätné kompatibilné).
### B2 — „Toto chcem tiež“ na share pohľade (`S`)
Embed/share view dostane výrazné CTA „Open in studio + Remix“ (cesta `?import=` existuje).
### B3 — Žánrové filtre galérie (`S`)
Filtrovanie podľa intent žánra uloženého pri publishi.

---

## 5. FÁZA C — Výkonnostný rozpočet konverzie

- **Landing first sound < 5 s** za tepla, < 10 s studená (merané `performance.mark`; event do funnel.ts).
- Landing chunk ostane bez intent modelu aj bez plného štúdia (len parser + offline render — overené, že cesta existuje cez EmbedApp).
- Po A1 zmerať a prípadne odstrániť ťažké importy z landing path (LandingPage je už lazy).
- Štúdio TTI (time-to-interactive) po Forge it: demo projekt + pending doc nesmú blokovať prvý render.

---

## 6. Poradie a veľkosti

| Krok | Veľkosť | Závislosti |
|---|---|---|
| A1 Landing prompt box | **M** | — |
| A2 Prvé spustenie → INTENT | S | A1 (pending doc) |
| A3 Share moment po USE | S | — |
| A4 Funnel eventy | S | — |
| B1 Regenerate z galérie | M | publish payload rozšírenie |
| B2 Share view CTA | S | — |
| B3 Žánrové filtre | S | B1 |
| C Rozpočty a meranie | S | A1, A4 |

Odporúčané dodanie: **A1+A2 ako jeden kus** (spolu tvoria cestu „napíš → vlastníš“), potom A3+A4, potom B.

---

## 7. Explicitný non-scope (čo tento plán zámerne NEmení)

- Žiadne nové DSP, žiadne nové efekty ani inštrumenty.
- Žiadne accounty, žiadny povinný server; core ostáva local-first (galéria zostáva jediná voliteľná online služba).
- Žiadny redesign existujúceho štúdia — len predné dvere a hradlá okolo existujúcich akcií.
- Žiadne breaking zmeny projektu schémy (publish payload len pribudne, voliteľné pole).

---

## 8. Riziká a mitigácie

| Riziko | Mitigácia |
|---|---|
| Autoplay policy na landing | Prehratie vždy na klik (gesture); typ sám nič nehrá. |
| Mobil / Safari: video export obmedzený | `canExportVideo()` guard už existuje; CTA skryje nepodporované varianty. |
| Dlhé share kódy v URL pri handoff | sessionStorage primárne; fallback normálny vstup do štúdia. |
| Slabý internet: model download | Landing používa len keyword parser; semantická vrstva sa nestahuje (existujúce správanie). |
| Concurrent session v repu | Fáza A sa dotýka `LandingPage.tsx`, `main.tsx`, `IntentPanel.tsx` — pred prácou skontrolovať `git status` a dohoda kto čo drží. |
| Kvalita generácií z krátkych promptov | Landing chips predvyplňujú overené prompty; engine už má invariant gating + fallback. |

---

## 9. Definícia úspechu (po Fáze A+B)

1. Nový návštevník: veta → beat → zdieľanie bez toho, aby musel čokoľvek vedieť o DAW.
2. TTFB < 60 s sa dá zopakovať na čerstvom profil viditeľným meraním (A4).
3. Každý publikovaný beat je zároveň vstupný bod (Regenerate) — galéria rastie sama.
4. Žiadny regression: plná test sada zelená, E2E smoke rozšírený o novú cestu.
