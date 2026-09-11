# public/samples — kurátorská factory vrstva

Tento priečinok drží **kurátorské nahradené zvuky** pre kľúčové sloty factory kitu.
VIZIÓNA §5: *„factory content is part of the product"* — najlepšie zvuky v apke
by mali byť tie, ktoré do nej kurátorsky vložíš, nie len tie, čo sa syntetizujú.

## Ako to funguje

1. Pri boote sa **najprv** vygeneruje celý syntetizovaný kit (~62 ms) — appka
   znie okamžite, vždy.
2. `src/sample-library/curated.ts` (`CURATED_SAMPLES`) stiahne WAV-y z tohto
   priečinka a **prepíše tie isté id** v banke (`SampleBank.add` prepisuje).
   Chýbajúci/pokazený súbor = slot ostanie so syntetizovaným zvukom
   (fallback konštrukčne, žiadne ticho).
3. Export/embed čakajú na vrstvu max 2 s (`renderProject` → `curatedReadyWithin`)
   — „what you hear is what you export".
4. PWA precache zahŕňa `samples/*.wav` (do 4 MB/súbor) — kurátorský kit funguje
   aj offline po prvom navštívení.

## Kontrakt pre kurátorský súbor

| Vec | Pravidlo |
| --- | --- |
| Meno | Presne ako v `CURATED_SAMPLES[].file` (napr. `factory.kick.deep.wav`) |
| Formát | WAV PCM 16/24-bit, 44.1 alebo 48 kHz, mono aj stereo |
| Peak | ~-6 dBFS (nechaj limiteru headroom; apka neclipuje) |
| Dĺžka | Krátky tail (~do 1 s pre perkusie, dlhšie pre tonal) |
| Normalizácia | Zvukovo konzistentná s ostatnými slotmi (počúv si súrodencov) |

## Nahradenie seedov

Súbory, ktoré tu sú, sú **seedy** — vyrenderované z vlastnej syntézy cez
mastering chain (tape + limiter) na demonštráciu pipeline. Nahraď ich
reálnymi nahrávkami jednoducho: **vymaž seed, ulož svoj WAV pod rovnakým
menom** — žiadna zmena kódu. Ak chceš pridať ďalší slot, pridaj riadok do
`CURATED_SAMPLES` v `src/sample-library/curated.ts` (id musí existovať v
`src/sample-library/manifest.ts`).

## Regen seedov (núdzové / vývoj)

```bash
npm run curated:seeds
```

Skript otvorí apku v headless Chromium, vyrenderuje zvolené assety cez reálnu
syntézu + mastering chain a zapíše ich sem (24-bit WAV).
