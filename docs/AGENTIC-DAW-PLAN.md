# AGENTIC DAW — KYX ako pracovné prostredie pre LLM producenta

> **Cieľ**: aby LLM agent (GLM-5.3 v ZCode, Claude Desktop, ...) mohol KYX nielen _ovládať_,
> ale v ňom _pracovať_ — počuť ho, experimentovať, vrátiť sa, a vyrábať beaty v cykle
> generate → analyze → adjust. Dokument rozširuje docs/INTENT-MCP-EXPANSION-PLAN.md
> (transporty, protokol) a MCP control-surface plán na agentný zážitok.

---

## 0. Aktuálny stav (2026-10-04)

| Vrstva       | Stav                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Transports   | Desktop stdio + web Streamable HTTP; oficiálny MCP SDK testuje oba transporty.                                               |
| Tool surface | 34 toolov vrátane `kyx_song`, checkpointov, producer moves a batch operácií.                                                 |
| Čítanie      | 7 resources: 5 `kyx://project/*` snapshotov + `kyx://playbook` + `kyx://vocab`; mutácie vracajú read-backy.                  |
| Bezpečnosť   | D4 deštrukčný zámok, checkpoint/undo, `kyx_batch` = do 10 volaní v jednom undo rámci.                                        |
| Sluch        | `kyx_audio_preview` vracia audio blok; `kyx_render_summary` meria; `kyx_diagnose_mix` vysvetľuje problémy a navrhuje opravy. |
| Latencia     | 10 s desktop / 15 s web pre bežné volania; 60 s pre render/generovanie.                                                      |

Pôvodné fázy E → A → B → C → D sú implementované. Zvuková analýza z Fázy B
sa dodáva cez `kyx_render_summary` + `kyx_diagnose_mix`, nie samostatným
`kyx_analyze`. `npm run mcp:demo` overuje 16 krokov cez web relay. Zostáva
ručný smoke s reálnym KYX balíkom a klientom ZCode/Claude a neskôr job/progress
model pre operácie, ktoré prekročia 60 s limit.

---

## Fáza E — Napojenie agenta — SHIPPED

**Cieľ**: GLM-5.3 v ZCode (a Claude Desktop) vidia `kyx_*` tooly a môžu ich volať ešte dnes.

1. `docs/AGENTIC-ZCODE-SETUP.md` — krok-za-krokom: KYX desktop → ⚡ chip → enable →
   skopírovať clientConfig → vložiť do MCP konfigu agenta (ZCode `mcp` settings /
   Claude Desktop config) → reštart → overiť `kyx_state overview`.
2. **Smoke checklist pre agenta** (tých 5 volaní, ktoré overia reťaz): overview →
   `kyx_generate` → `kyx_steps add` → `kyx_state pattern` (read-back) → `kyx_undo` →
   `kyx_state tempo` (žiadna zmena). Vložiť do playbooku ako "hello KYX".
3. Trap-hunter: bežné volania majú krátky timeout (10 s desktop / 15 s web),
   render/generovanie dostali rozšírený 60 s limit; veľmi veľké rendery môžu
   stále dobehnúť až po odpovedi agenta (download aj tak pristane v KYX).

Effort: jedno popoludnie, žiadny nový kód okrem dokumentu (chip už clientConfig vydáva).

---

## Fáza A — Agent onboarding — SHIPPED

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

## Fáza B — Uši: `kyx_render_summary` + `kyx_diagnose_mix` — SHIPPED

**Cieľ**: agent ZPOČUJE projekt bez ľudí v reťazi. Najväčší schopnostný unlock.

Dodané cez dva nástroje s oddelenou rolou:

- `kyx_render_summary` vracia master + strip LUFS, peak, crest factor, dĺžku a
  delty hlasitosti voči najhlasnejšiemu stripu.
- `kyx_diagnose_mix { scope? }` pridáva low/HF energy shares, clipping,
  headroom, master stereo correlation, atribúciu stripov a konkrétne
  volateľné návrhy opráv. `scope: "tracks"` je rýchla kontrola po oprave;
  `scope: "master"` vynechá per-strip rendery.
- Loudness referenciou je streamingový cieľ −14 LUFS; nejde o
  `compareTo: "genre"` ani o per-track stereo-width analýzu.

Oba nástroje renderujú offline cez zdieľaný engine. Sú read-only; agent
vykoná návrh samostatným MCP toolom a potom diagnostiku zopakuje.

---

## Fáza C — Časový stroj: `kyx_checkpoint` — SHIPPED

**Cieľ**: agentné experimenty — checkpoint → 10 smelých krokov → restore. Bez strachu.

- `kyx_checkpoint { op: "save", name }` — pomenovaný snapshot (snapshots repo existuje),
- `op: "list"` — názvy + vek + počet krokov od checkpointu,
- `op: "restore", name` — nahradenie dokumentu (jeden undo krok späť na stav pred restore),
- AUTO-checkpoint pred každou D4 povolenou deštrukciou ("auto-before-destructive-N"),
- `kyx_state history` ukáže checkpointy ako prvé položky (agent ich vidí v prehľade).

Effort: 1 večer (snapshots repo + restore path už bežia pre UI; tenké MCP obalenie + D4 hook).

---

## Fáza D — Producer moves (jeden call, celý ťah) — SHIPPED

**Cieľ**: token-ekonomické hrubé kroky — agent premýšľa v zámeroch, nie v 20 volaniach.

1. `kyx_mix { genre, mood?, tone?, reverb?, punch?, pump? }` — planMixProfile +
   applyMixIntent (OBE existujú z D1 mix vlny): celý mix v jednom undo.
2. `kyx_arrange { form: "intro/build/drop/break/outro", bars per role }` — sekčný
   pipeline existuje (parseSectionRequests + forms + sceneAutomation); štruktúrovaný
   wrapper = spoľahlivosť pre agentov (bez NLP).
3. `kyx_song` — beat + mix + aranžmán v jednej dávke; loudness trim je
   voliteľný ďalší undo krok.

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
