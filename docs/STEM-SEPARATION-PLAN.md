# STEM SEPARATION — plán (ADR 0019, 2026-10-06)

> **Pitch:** všetky transkripčné vrstvy dnes čítajú plný mix a bojujú s
> rovnakou interrogenciou. Stem separation rozdelí zdroj na percussion/tonal
> (Tier 1, vždy dostupné) alebo drums/bass/vocals/other (Tier 2, opt-in
> model) — a každá vrstva číta svoj stem. To je najväčší kvalitatívny skok,
> aký tento engine môže dostať.
>
> Architektúra a rozhodnutia: **docs/adr/0019-stem-separation.md**. Rešerš
> 2026-10-06: htdemucs MIT ~80 MB s fungujúcimi ONNX exportmi (StemSplit:
> 31 % rýchlejší než PyTorch CPU), HPSS = deterministický model-free
> baseline, BS-RoFormer odmietnutý (veľkosť), cloud odmietnutý (local-first).

## Vlny

### S0 — HPSS core (pure, deterministický)

- `src/analysis/hpss.ts`: median filtering cez čas (harmonic) a frekvenciu
  (percussive) na magnitude spektre (reference DSP FFT), soft-mask resyntéza
  s margin parametrom (librosa konvencia), + band split harmonic stemu
  (bass register ≤250 Hz / remainder). Výstup: `{ percussive, harmonic, bass }`
  AudioBuffer-like štruktúry.
- Beží v reference workere (FFT infra je hotová), chunkovaný pre dlhé tracky.
- **Testy:** golden house render → percussive stem zachová kick transikenty
  (drums lane step F1 na stem ≥ track baseline), harmonic stem zachová akordy
  (chord KPI ≥ baseline), determinizmus (bit-identický výstup), cap/abort.
- **Úsilie:** ~1 blok.

### S1 — Lane integration + KPI re-measure

- `transcribeTrack` options `{ separation?: "off" | "hpss" | "model" }`
  (default "off" — žiadna tichá zmena správania). Pri "hpss" sa najprv
  separuje a vrstvy čítajú svoje stemy (drums→percussive, bass→bass stem,
  chords/melody→harmonic).
- **Golden floors sa RE-LOCKNÚ**: oddelená baseline tabuľka `HPSS_FLOORS`
  vedľa existujúcej (target: techno bass recall 0.09→≥0.3, snare cross-talk
  dole; žiadna vrstva nesmie klesnúť pod existujúci floor).
- **Úsilie:** ~0.5–1 blok.

### S2 — Stems export pre usera (standalone hodnota)

- Panel (ReferenceMap alebo ExportPanel): „Exportovať stemy" → HPSS stemy →
  WAV cez existujúci `src/rendering/stems.ts`/wav encoder. Pre akýkoľvek
  analyzovaný track — nezávisle od UN-SUNO.
- **Akceptácia:** export 3 WAVov, bit-deterministický, prehrateľný (owner ear).
- **Úsilie:** ~0.5 bloku.

### S3 — htdemucs ONNX infra (opt-in)

- `scripts/stem:fetch` (replayable download + sha256 + manifest
  featureVersion/modelHash), `pf:stem-model` flag, gate pin (candidate bez
  PASSED gate neaktívny — audio-tag ritual).
- ORT worker (vzor audio-worker.ts): session init, chunked inference
  (~7.8 s chunky + overlap-add), progress + abort, memory bound.
- **Akceptácia:** 4 stemy z chunkov bez klikov na spojoch (overlap-add súčet
  = sum pôvodného chunku v overlap regióne), 3-min track bez OOM, determinizmus
  per chunk.
- **Úsilie:** ~1.5–2 bloky (najťažšia vlna — ONNX export detaly, IO shapes).

### S4 — Lane wiring + panel surface

- `separation: "model"` číta demucs stemy; UI indikátor ktorej tier bežal;
  stemy export aj pre model tier (4 WAVy).
- **KPI:** model floors tabuľka (target: všetky vrstvy nad HPSS floors).
- **Úsilie:** ~0.5–1 blok.

### S5 — WebGPU + benchmarky (optional)

- ORT-web WebGPU backend za flagom, benchmark tabuľka (WASM SIMD vs WebGPU,
  realtime factor per minúta audia), dokumentovaná podpora matrix.

## KPI

| Metrika                        | Baseline (full mix) | Cieľ HPSS                    | Cieľ model |
| ------------------------------ | ------------------- | ---------------------------- | ---------- |
| Techno bass recall             | 0.09                | ≥ 0.30                       | ≥ 0.60     |
| House kick F1                  | 0.91                | ≥ 0.91 (žiadny regres)       | ≥ 0.93     |
| Snare exact (techno/boom/trap) | 1.00/1.00/1.00      | ≥ baseline                   | ≥ baseline |
| Chords per-bar exact           | 1.00                | ≥ 0.95 (harmonic bleed)      | ≥ 1.00     |
| Stems export                   | —                   | deterministický, prehrateľný | 4 stemy    |

## Anti-goals

- Žiadny cloud, žiadny model v gite (fetch script + manifest).
- HPSS sa nikdy neinzeruje ako „Demucs kvalita" — UI menuje tier.
- Žiadna tichá zmena default správania — separation je explicitná voľba.
- ONNX v projekte len cez manifest+gate ritual (žiadne lokálne binárky).
