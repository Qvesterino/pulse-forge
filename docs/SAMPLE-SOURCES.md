# Sample Sources — licenčne overené zdroje pre KYX

> KYX **redistribuuje** raw samply vo svojom binárnom balíku — to je prísnejšia
> požiadavka než bežné „free for your music". Toto je overený zoznam zdrojov
> (rešerš 2026-10-03) + pravidlá, čo nefunguje a prečo.

## Pravidlo redistribúcie (filter každej voľby)

| Licencia                                                  | Do KYX?      | Prečo                                                           |
| --------------------------------------------------------- | ------------ | --------------------------------------------------------------- |
| **CC0**                                                   | ✅ ideálne   | žiadne podmienky                                                |
| **CC-BY 3.0/4.0**                                         | ✅ + credits | komerčné OK, atribúcia do `public/licenses/credits.md`          |
| CC-BY-**NC**                                              | ❌           | nekomerčné vylučuje shipped produkt                             |
| CC-BY-**ND**                                              | ❌           | sampling = derivát                                              |
| CC-BY-**SA**                                              | ❌           | share-alike koliduje s proprietárnou licenciou appky            |
| **Pixabay Content License**                               | ✅           | komerčné + redistribúcia v produkte povolená, bez atribúcie     |
| „Free for your music" (LABS, Spitfire, MT Power Drum Kit) | ❌           | grant end-user hudbe, NIE raw redistribúciu v nástroji          |
| **LMMS samples** (data/samples)                           | ❌           | GPL-2.0 bez sample výnimky — nejasný pôvod jednotlivých súborov |
| ccMixter                                                  | ❌           | prevažne CC-BY-NC varianty                                      |

## Overené zdroje

### 1. Freesound.org — filter „Creative Commons 0" ✅✅

Najväčšia per-file overená CC0 knižnica. Hľadaj `acoustic drum one shot`,
filtruj licenciu na CC0. Sťahovanie vyžaduje bezplatný účet.
https://freesound.org/search/?q=drum+kit&f=license:%22Creative+Commons+0%22

### 2. VSCO 2 Community Edition — CC0 ✅ (už v KYX)

Orchester: sláčiky, dychy, činely, harfa, klávesy. 75 SFZ / 3168 WAVov.
Konverzia: `scripts/convert-vsco2.mjs`. Zdroj:
https://archive.org/details/vsco-2-ce-sfz — LICENSE súbor v balíku potvrdzuje CC0.

### 3. Salamander Grand Piano V3 — CC-BY 3.0 ✅ (už v KYX)

Yamaha C5, 88 klávesy × velocity vrstvy. Konverzia: `scripts/convert-salamander.mjs`.
https://archive.org/details/SalamanderGrandPianoV3 (Alexander Holm).

### 4. Pixabay — audio ✅

Pixabay Content License: komerčné použitie + integrácia do produktov povolená,
bez atribúcie. Drum one-shots: https://pixabay.com/sound-effects/search/drums/
Kvalitná kurátorovaná časť, menej „hlbokých" samplov než Freesound.

### 5. Vlastné nahrávky — bez licencie ✅✅

KYX recording pipeline (PcmMicRecorder) + IR generator = vlastné clap/perkusie/
found-sound/room IR. 100 % práva, unikátny obsah. Nahrávky importuj cez
DropZone priamo do user knižnice.

## Zamietnuté (skontrolované, nepoužiteľné)

- **LMMS data/samples** — GPL-2.0 repozitár bez sample výnimky; per-súborový
  pôvod neoveriteľný → redistribúcia riziko.
- **MT Power Drum Kit** — zdarma v plugin-e, redistribúcia zakázaná.
- **Musical Artifacts** — per-artifact licencie, ale väčšina drum záznamov
  je SF2 s nejasným pôvodom („gray"/„copyright"); použiť len s jasným CC0.
- **ccMixter** — kvalitné, ale prevažne NC licencie.
- **„Free for your music" balíky** (Spitfire LABS, PianoBook, decentsamples
  free) — end-user grant bez raw redistribúcie.

## Postup pri pridaní packu

1. Stiahni len CC0/CC-BY materiál + ZACHOVaj LICENSE súbor.
2. Konverzia: `scripts/convert-salamander.mjs` / `convert-vsco2.mjs` ako vzor
   (trim → per-key normalizácia → 16-bit stereo 44.1k → public/samples/<pack>/).
3. Registruj pack v `src/sample-library/licenses.ts` → PACK_CREDITS
   (license + credits riadky + sourceUrl).
4. Gate test `tests/sample-license-gate.test.ts` overí atribúciu aj credits.md.
5. `public/licenses/credits.md` deployuje sa s appkou (CC-BY povinnosť splnená).
