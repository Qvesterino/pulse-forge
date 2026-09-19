# public/samples — kurátorská factory vrstva

Tento priečinok drží **kurátorské nahradené zvuky pre celý factory kit** —
všetkých 41 slotov z `src/sample-library/manifest.ts`.
VIZIÓNA §5: _„factory content is part of the product"_ — najlepšie zvuky v apke
by mali byť tie, ktoré do nej kurátorsky vložíš, nie len tie, čo sa syntetizujú.

## Ako to funguje

1. Pri boote sa **najprv** vygeneruje celý syntetizovaný kit (~62 ms) — appka
   znie okamžite, vždy.
2. `src/sample-library/curated.ts` (`CURATED_SAMPLES`) stiahne WAV-y z tohto
   priečinka a **prepíše tie isté id** v banke (`SampleBank.add` prepisuje).
   Chýbajúci/pokazený súbor = slot ostane so syntetizovaným zvukom
   (fallback konštrukčne, žiadne ticho).
3. Export/embed čakajú na vrstvu max 2 s (`renderProject` → `curatedReadyWithin`)
   — „what you hear is what you export".
4. PWA precache zahŕňa `samples/*.wav` (do 4 MB/súbor; celá vrstva ~11 MB) —
   kurátorský kit funguje aj offline po prvom navštívení.

## Kontrakt pre kurátorský súbor

| Vec          | Pravidlo                                                              |
| ------------ | --------------------------------------------------------------------- |
| Meno         | Presne ako v `CURATED_SAMPLES[].file` (napr. `factory.kick.deep.wav`) |
| Formát       | WAV PCM 16/24-bit, 44.1 alebo 48 kHz, mono aj stereo                  |
| Peak         | ≤ -1 dBFS (limiter ceiling + true-peak overshoot)                     |
| Dĺžka        | Krátky tail (~do 1 s pre perkusie, dlhšie pre tonal/FX)               |
| Balance      | Category momentary-max cieľ (tabuľka nižšie) — kit znie ako zmiešaný  |

## Loudness balance (category momentary-max K-weighted ciele)

Kit nie je 41 náhodných patch levels — každá kategória má vlastný cieľ:

| Kategória  | Cieľ (momentary max) | Mastering (tape drive / ceiling) |
| ---------- | -------------------- | -------------------------------- |
| Kick       | -8 LUFS              | 0.22 / -1.2 dBFS                 |
| Snare      | -9.5 LUFS            | 0.20 / -1.4 dBFS                 |
| Clap       | -10.5 LUFS           | 0.18 / -1.5 dBFS                 |
| Hat        | -15.5 LUFS           | 0.14 / -1.8 dBFS                 |
| Cymbal     | -17 LUFS             | 0.10 / -2.0 dBFS                 |
| Crash      | -17 LUFS             | 0.10 / -2.0 dBFS                 |
| Tom        | -11.5 LUFS           | 0.18 / -1.5 dBFS                 |
| Rim        | -13 LUFS             | 0.15 / -1.8 dBFS                 |
| Percussion | -13.5 LUFS           | 0.15 / -1.8 dBFS                 |
| Tonal      | -16 LUFS             | 0.16 / -1.8 dBFS                 |
| FX         | -13 LUFS             | 0.16 / -1.5 dBFS                 |

Ciele žijú v `scripts/render-curated-seeds.mjs` (`CATEGORY_TREATMENT`) —
jeden riadok = nový balance celého kitu.

## Nahradenie seedov

Súbory, ktoré tu sú, sú **seedy** — vyrenderované z vlastnej syntézy cez
per-category mastering chain (normalizácia + tape + limiter). Nahraď ich
reálnymi nahrávkami jednoducho: **vymaž seed, ulož svoj WAV pod rovnakým
menom** — žiadna zmena kódu. Drž sa loudness cieľa kategórie (tabuľka vyššie),
nech kit zostane vyvážený. Ak chceš pridať ďalší slot, pridaj riadok do
`CURATED_SAMPLES` v `src/sample-library/curated.ts` (id musí existovať v
`src/sample-library/manifest.ts`).

## Regen seedov (núdzové / vývoj)

```bash
npm run curated:seeds
```

Skript otvorí apku v headless Chromium, vyrenderuje všetky sloty cez reálnu
syntézu + loudness normalizáciu (2-pass trim) + mastering chain a zapíše ich
sem (24-bit WAV).
