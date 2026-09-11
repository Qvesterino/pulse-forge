# Golden review — počúvaci pack

## house:classic

| Súbor | Kandidát (index/seed) | Heuristické poradie |
| ----- | --------------------- | ------------------- |
| house_classic/cand-1.wav | #1 (ds-house-classic-0|candidate:1) | heuristic: 1. |
| house_classic/cand-3.wav | #3 (ds-house-classic-0|candidate:3) | heuristic: 2. |
| house_classic/cand-2.wav | #2 (ds-house-classic-0|candidate:2) | heuristic: 3. |
| house_classic/cand-0.wav | #0 (ds-house-classic-0) | heuristic: 4. |

→ Tvoje poradie pre house:classic zapíš do `scripts/data/intent-ranker-golden.json` (kandidát INDEXY, najlepší prvý).

## house:deep

| Súbor | Kandidát (index/seed) | Heuristické poradie |
| ----- | --------------------- | ------------------- |
| house_deep/cand-1.wav | #1 (ds-house-deep-0|candidate:1) | heuristic: 1. |
| house_deep/cand-0.wav | #0 (ds-house-deep-0) | heuristic: 2. |
| house_deep/cand-3.wav | #3 (ds-house-deep-0|candidate:3) | heuristic: 3. |
| house_deep/cand-2.wav | #2 (ds-house-deep-0|candidate:2) | heuristic: 4. |

→ Tvoje poradie pre house:deep zapíš do `scripts/data/intent-ranker-golden.json` (kandidát INDEXY, najlepší prvý).

## house:organs

| Súbor | Kandidát (index/seed) | Heuristické poradie |
| ----- | --------------------- | ------------------- |
| house_organs/cand-2.wav | #2 (ds-house-organs-0|candidate:2) | heuristic: 1. |
| house_organs/cand-1.wav | #1 (ds-house-organs-0|candidate:1) | heuristic: 2. |
| house_organs/cand-0.wav | #0 (ds-house-organs-0) | heuristic: 3. |
| house_organs/cand-3.wav | #3 (ds-house-organs-0|candidate:3) | heuristic: 4. |

→ Tvoje poradie pre house:organs zapíš do `scripts/data/intent-ranker-golden.json` (kandidát INDEXY, najlepší prvý).

## techno:drive

| Súbor | Kandidát (index/seed) | Heuristické poradie |
| ----- | --------------------- | ------------------- |
| techno_drive/cand-2.wav | #2 (ds-techno-drive-0|candidate:2) | heuristic: 1. |
| techno_drive/cand-1.wav | #1 (ds-techno-drive-0|candidate:1) | heuristic: 2. |
| techno_drive/cand-0.wav | #0 (ds-techno-drive-0) | heuristic: 3. |
| techno_drive/cand-3.wav | #3 (ds-techno-drive-0|candidate:3) | heuristic: 4. |

→ Tvoje poradie pre techno:drive zapíš do `scripts/data/intent-ranker-golden.json` (kandidát INDEXY, najlepší prvý).

## techno:acid

| Súbor | Kandidát (index/seed) | Heuristické poradie |
| ----- | --------------------- | ------------------- |
| techno_acid/cand-2.wav | #2 (ds-techno-acid-0|candidate:2) | heuristic: 1. |
| techno_acid/cand-3.wav | #3 (ds-techno-acid-0|candidate:3) | heuristic: 2. |
| techno_acid/cand-1.wav | #1 (ds-techno-acid-0|candidate:1) | heuristic: 3. |
| techno_acid/cand-0.wav | #0 (ds-techno-acid-0) | heuristic: 4. |

→ Tvoje poradie pre techno:acid zapíš do `scripts/data/intent-ranker-golden.json` (kandidát INDEXY, najlepší prvý).

## trap:roll

| Súbor | Kandidát (index/seed) | Heuristické poradie |
| ----- | --------------------- | ------------------- |
| trap_roll/cand-1.wav | #1 (ds-trap-roll-0|candidate:1) | heuristic: 1. |
| trap_roll/cand-0.wav | #0 (ds-trap-roll-0) | heuristic: 2. |
| trap_roll/cand-3.wav | #3 (ds-trap-roll-0|candidate:3) | heuristic: 3. |
| trap_roll/cand-2.wav | #2 (ds-trap-roll-0|candidate:2) | heuristic: 4. |

→ Tvoje poradie pre trap:roll zapíš do `scripts/data/intent-ranker-golden.json` (kandidát INDEXY, najlepší prvý).

## ambient:drift

| Súbor | Kandidát (index/seed) | Heuristické poradie |
| ----- | --------------------- | ------------------- |
| ambient_drift/cand-3.wav | #3 (ds-ambient-drift-0|candidate:3) | heuristic: 1. |
| ambient_drift/cand-0.wav | #0 (ds-ambient-drift-0) | heuristic: 2. |
| ambient_drift/cand-1.wav | #1 (ds-ambient-drift-0|candidate:1) | heuristic: 3. |
| ambient_drift/cand-2.wav | #2 (ds-ambient-drift-0|candidate:2) | heuristic: 4. |

→ Tvoje poradie pre ambient:drift zapíš do `scripts/data/intent-ranker-golden.json` (kandidát INDEXY, najlepší prvý).

---

Po prespojaní všetkých combo: nastav v `scripts/data/intent-ranker-golden.json`
`reviewed: true`, `reviewedBy`, `reviewedAt` a pusti `npm run ranker:train`.