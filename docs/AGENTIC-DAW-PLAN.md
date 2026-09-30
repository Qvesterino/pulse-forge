# AGENTIC DAW — KYX ako pracovné prostredie pre LLM producenta

> **Cieľ**: aby LLM agent (GLM-5.3 v ZCode, Claude Desktop, ...) mohol KYX nielen _ovládať_,
> ale v ňom _pracovať_ — počuť ho, experimentovať, vrátiť sa, a vyrábať beaty v cykle
> generate → analyze → adjust. Dokument rozširuje docs/INTENT-MCP-EXPANSION-PLAN.md
> (transporty, protokol) a MCP_AI_CONTROL_MATRIX.md (20 toolov, P0–P2) na agentný zážitok.

---

## 0. Čo už agent má (2026-09-30) — a prečo to nestačí

| Vrstva       | Stav                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transports   | desktop stdio (loopback bridge), web streamable-HTTP — protocol-complete (negotiation, batch, resources)                                                                         |
| Tool surface | 20 toolov: intent/state/undo/transport/export/generate/groove/fx/sections/markers/tracks/pattern/steps/catalog/meter/automation/clips/batch/loudness (+ skrytý `__kyx_resource`) |
| Čítanie      | 5 `kyx://project/*` resources, `data` JSON obálky, verify-by-read-backs                                                                                                          |
| Bezpečnosť   | D4 deštrukčný zámok, one-undo snapshoty, `kyx_batch` = 10 volaní v JEDNOM undo                                                                                                   |
| Sluch        | `kyx_loudness measure` (render-backed LUFS), `kyx_meter` (živé peak/RMS metre)                                                                                                   |

**Čo agentovi chýba**: nemá ÚCHY (len hlasitosť, nie spektrum/karakter), nemá ČASOVÝ STROJ
(expery bez vrátenia), nepozná SOP (čo s toolmi a v akom poradí), a nie je NAPPOJENÝ
(zive — config existuje v chipi, ale wire-up nie je zdokumentovaný pre konkrétneho agenta).

---

## Fáza E — Napojenie agenta (PRVÉ — bez tohto zvyšok nemá zmysel)

**Cieľ**: GLM-5.3 v ZCode (a Claude Desktop) vidia `kyx_*` tooly a môžu ich volať ešte dnes.

1. `docs/AGENTIC-ZCODE-SETUP.md` — krok-za-krokom: KYX desktop → ⚡ chip → enable →
   skopírovať clientConfig → vložiť do MCP konfigu agenta (ZCode `mcp` settings /
   Claude Desktop config) → reštart → overiť `kyx_state overview`.
2. **Smoke checklist pre agenta** (tých 5 volaní, ktoré overia reťaz): overview →
   `kyx_generate` → `kyx_steps add` → `kyx_state pattern` (read-back) → `kyx_undo` →
   `kyx_state tempo` (žiadna zmena). Vložiť do playbooku ako "hello KYX".
3. Trap-hunter: transport timeouty (10 s desktop / 15 s web) a ich dopad na dlhé rendery —
   zapísať do playbooku ("export może timeoutnúť, download aj tak pristane").

Effort: jedno popoludnie, žiadny nový kód okrem dokumentu (chip už clientConfig vydáva).

---

## Fáza A — Agent onboarding (playbook + slovník ako resources)

**Cieľ**: agent sa naučí DAW bez toho, aby míňal tokeny na pokus-omyl.

1. `kyx://playbook` resource — výrobný manuál:
   - pracovné cykly (beat z nuly / remix existujúceho / mix pass / aranžmán),
   - kedy `kyx_intent` free-text vs kedy štruktúrovaný tool (spoloahlivosť!),
   - token-ekonomika: čítaj `data` obálky nie dlhé texty, `kyx_batch` pre série,
   - zakázané kroky (refusaly) a ako na ne reagovať.
2. `kyx://vocab` resource — slovná zásoba `kyx_intent` po kategóriách (mixer, groove,
   fx, sections, steps, production koncepty; EN + SK), generovaná z parser regexov
   (kurátorovaný export, pinutý testom proti parserom).

Effort: 1 večer; resources list sa rozšíri na 7 URI (mirrory + piny podľa etabovaného vzoru).

---

## Fáza B — Uši: `kyx_analyze` (render → zvuková správa)

**Cieľ**: agent ZPOČUJE projekt bez ľudí v reťazi. Najväčší schopnostný unlock.

`kyx_analyze { bars?, tracks?, compareTo?: "genre" }` → compact report + `data`:

- master: integrated LUFS (existujúca render infra z `kyx_loudness`), peak, crest factor,
- per-track: RMS/peak, low/mid/high energie (3-pásmo stačí pre agentné rozhodovanie),
  stereo šírka,
- `compareTo: "genre"` — referencie zo sound-quality sprintu (FAMILY_REFERENCE
  PLR+tilt): "hat wash je +4 dB nad genre cieľom" — agentné rozhodnutie je potom číslo,
  nie dojem.

Infraštruktúra VŠETKO existuje: offline render (renderer.ts), metering rig,
analyzeAudioReference, genre referencie. Nové je len agregácia do jedného tool reportu.
Effort: 1–2 večera. Limit: render dlhší ako transport timeout — riešiť kratším
rozborom (default 4–8 barov) a dokumentovať.

---

## Fáza C — Časový stroj: `kyx_checkpoint`

**Cieľ**: agentné experimenty — checkpoint → 10 smelých krokov → restore. Bez strachu.

- `kyx_checkpoint { op: "save", name }` — pomenovaný snapshot (snapshots repo existuje),
- `op: "list"` — názvy + vek + počet krokov od checkpointu,
- `op: "restore", name` — nahradenie dokumentu (jeden undo krok späť na stav pred restore),
- AUTO-checkpoint pred každou D4 povolenou deštrukciou ("auto-before-destructive-N"),
- `kyx_state history` ukáže checkpointy ako prvé položky (agent ich vidí v prehľade).

Effort: 1 večer (snapshots repo + restore path už bežia pre UI; tenké MCP obalenie + D4 hook).

---

## Fáza D — Producer moves (jeden call, celý ťah)

**Cieľ**: token-ekonomické hrubé kroky — agent premýšľa v zámeroch, nie v 20 volaniach.

1. `kyx_mix { genre, mood?, tone?, reverb?, punch?, pump? }` — planMixProfile +
   applyMixIntent (OBE existujú z D1 mix vlny): celý mix v jednom undo.
2. `kyx_arrange { form: "intro/build/drop/break/outro", bars per role }` — sekčný
   pipeline existuje (parseSectionRequests + forms + sceneAutomation); štruktúrovaný
   wrapper = spoľahlivosť pre agentov (bez NLP).
3. Neskôr: `kyx_song` — beat + mix + aranžmán v jednej dávke (batch nad A+B+D).

Effort: mix 1 večer, arrange 1 večer.

---

## Ne-ciele (poctivo)

- **Prompt capability** — margínne; playbook resource pokrýva to isté lacnejšie.
- **Resource subscriptions / server→agent push** — agent má poll model; netreba.
- **Audio import cez MCP** — 25 MB base64 v tool calloch = user samples UI ostáva cestou.
- **Recording-take manažment** — ostáva za rozhodnutím "record je window-local" (matrix P2-19).

---

## Poradie a dôvod

**E → A → B → C → D**. E je 30 min a hneď ma môžeš používať na KYX. A ma urobí
kompetentným bezplytovo. B je najväčší unlock (agent číta ZVUK ako čísla). C dáva
odvahu experimentovať. D je luxus na záver — a veľkú časť D už dnes kryje `kyx_batch`.

Všetko je GPU-free a stavia výhradne na existujúcej infraštruktúre.
