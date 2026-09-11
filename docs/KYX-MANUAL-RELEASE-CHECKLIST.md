# KYX — manual release checklist

Tento checklist je posledný manuálny gate k
[`KYX-PRE-RELEASE-IMPLEMENTATION-ROADMAP.md`](./KYX-PRE-RELEASE-IMPLEMENTATION-ROADMAP.md).
Automated Chromium/Edge checks už pokrývajú základný flow; tu sa zapisujú iba
reálne browser/device výsledky, ktoré nie je možné poctivo odvodiť z jsdom alebo
headless Chromium.

Pred deployom spusti po `npm run build` aj lokálny preflight:

```text
NODE_ENV=production CORS_ORIGIN=https://app.example.com npm run release:preflight
```

Ak je verejná gallery zapnutá, pridaj `KYX_GALLERY_PUBLIC=1` a produkčný
`GALLERY_ADMIN_TOKEN`. Preflight kontroluje iba lokálne artefakty a konfiguráciu;
nasledujúca device matrix a production health check sú stále povinné.

## 1. Matrix

Vyplniť každý riadok na produkčnom builde, nie iba na Vite dev serveri.

| Runtime  | OS/device  | Build/URL | Result | Tester/date | Evidence / blocker |
| -------- | ---------- | --------- | ------ | ----------- | ------------------ |
| Chromium | desktop    |           | ☐      |             |                    |
| Edge     | desktop    |           | ☐      |             |                    |
| Firefox  | desktop    |           | ☐      |             |                    |
| Safari   | macOS      |           | ☐      |             |                    |
| Safari   | iOS/iPadOS |           | ☐      |             |                    |

Pass znamená: žiadny neočakávaný console/page error, worklet load error,
unhandled rejection, zamrznutie UI alebo tichá strata práce.

## 2. Core create → sound → export flow

Na každom dostupnom runtime:

1. Otvor nový projekt/template a over audio unlock pri prvom gesture.
2. Vyber instrument track a preset. Spusť `Preview`, rýchlo prepni preset,
   stlač `Escape`, `Stop` a `Play`; projekt a undo history sa nesmú zmeniť.
3. Použi `Apply`, over jednu undo položku a následné undo/redo.
4. Prepni Inspector Simple/Advanced; všetky viditeľné ovládania musia mať
   hodnotu, keyboard step, reset a dostupný focus.
5. V sequenceri otvor Beat Focus, použi shortcut, Escape a resize/rotate.
   Playhead, selection, p-locky a transport nesmú byť prekryté.
6. Na track pridaj cez `+ ADD EFFECT` postupne PRISM, VLYX a VØID. Pre každý:
   bypass, collapse/expand, preset, reset, dirty/modified indikáciu a error/
   loading stav. Collapse nesmie zničiť audio runtime.
7. Pre každý plugin over `A/B`: STORE, COPY, CLEAR, recall, undo, reload a
   bypass. Recall nesmie meniť routing ani trvalo prepisovať gain-match trim.
8. Over gain-match v stavoch `WAITING`, `NO SIGNAL`, `LOCKED`, `BYPASSED` a
   `STALE/RECALCULATE`; pri zapnutí nesmie vzniknúť počuteľný level jump.
9. V MIX over peak/true-peak meter, clip hold, mute/solo, group/bus a batch
   operáciu s jedným undo. Otvor overflow menu a over Escape/focus return.
10. V MOD over macro keyboard/drag flow a po reload skontroluj, že target
    zostal správny a command stream sa nezahltí.
11. Exportuj WAV, MP3 a krátky video súbor. Over duration, sample rate,
    channel count, peak policy a že súbor sa dá znovu prehrať.
12. Urob refresh počas uloženého projektu, zavri tab a znovu otvor projekt.
    Posledná potvrdená verzia musí byť dostupná; recovery nesmie potichu
    prepísať novšiu verziu.

## 3. VØID device-memory smoke

Na zariadení s dostupným memory profilerom:

1. Zapíš browser, OS, sample rate, `navigator.deviceMemory` (ak je dostupné)
   a počet súčasných VØID inštancií.
2. Otvor VØID, nechaj IR načítať do `ready`, prehraj suchý transient aj dlhý
   tail, zmeň pre-delay cez direct aj tempo-sync hodnoty a opakuj bypass/
   reload.
3. Sleduj JS heap/native audio memory pred `prepare`, po `prepare`, po prvom
   renderi a po dispose. Nesmie rásť pri live parameter/BPM sweepovaní.
4. Ak testuješ vysoký sample rate, zaznamenaj výsledok zvlášť. Orientačný
   prepare-time pre-delay cost jednej stereo inštancie je približne 37 MB pri
   48 kHz, 74 MB pri 96 kHz a 147 MB pri 192 kHz; neočakávaj nulový footprint.

| Device/browser | Sample rate | Instances | Before | After prepare | After sweep | After dispose | Result |
| -------------- | ----------: | --------: | -----: | ------------: | ----------: | ------------: | ------ |
|                |             |           |        |               |             |               | ☐      |

## 4. Production collab/gallery check

Ak je collaboration/gallery verejne zapnutá:

- nastav `CORS_ORIGIN` na presné production origins, nie wildcard;
- over `GET /api/health` bez `Origin` aj z povolenej browser origin;
- otvor room v dvoch tabs, zmeň BPM/pattern a over sync + presence;
- odošli validný gallery publish/play/report request;
- over, že admin reports/delete vyžadujú `GALLERY_ADMIN_TOKEN` a zlý token
  dostane 401;
- over malformed/oversized request, rate limit a že server ostáva živý;
- skontroluj logy a health counters po zavretí roomu.

## 5. Sign-off

Release môže byť označený ako manuálne overený až keď sú všetky dostupné
riadky v Matrix vyplnené a každý blocker má ownera, reprodukciu a rozhodnutie
(`fix`, `waive` alebo `not supported`).

```text
Build/commit:
Browsers/devices tested:
Automated gates:
Manual blockers:
VØID memory notes:
Production CORS/health result:
Tester/sign-off/date:
```
