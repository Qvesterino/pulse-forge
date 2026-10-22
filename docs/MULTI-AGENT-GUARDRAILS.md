# MULTI-AGENT GUARDRAILS — práca viacerých session na jednom strome

Tento repo beží s viacerými kódovacími agentmi naraz na jednom working tree.
Pravidlá nižšie vznikli z reálnych incidentov (2026-10-02/03) — každý má za
sebou konkrétnu opravu. Sú krátke zámerne: mali by ich vedieť všetci.

---

## 1. Commituj SKORO — untracked súbor = nezabezpečený súbor

Súbežná session commituje snapshoty zdieľaného stromu a pohltí do nich
všetko, čo je v ňom v momente ich `git add`. 2026-10-03: surface commit
`0e0ce3a7` zobral `tools.ts` + mirrors + test súbor, ale **nie** modul, ktorý
importovali (bol untracked) → commit referencoval súbor, ktorý v git-e nebol
(čerstvý clone sa neskompiluje). Oprava prišla ako `ee7fc17a`.

**Pravidlo:** hotový kúsok = commit hneď. Rozpracovaná práca žije v worktree
alebo vo vlastnej ratline, nie hodiny untracked v zdieľanom strome.

## 2. Nikdy `git stash pop` na zdieľanom strome

Stash je globálny — pop ťahá cudzí stash (`stash@{0}` patril inej vlne) a
vytvorí konflikty v cudzích súboroch. 2026-10-02: recovery = `git reset` +
`checkout --` presnej zoznamu dotknutých súborov, stash entry zostal.

**Pravidlo:** na zdieľanom strome sa nepoužíva stash vôbec. Alternatívy:
explicit staging podľa súborov, alebo worktree (pravidlo 5).

## 3. Staguj výhradne súbory, ktoré si sám autoroval

`git add <explicitný zoznam>`, nikdy `git add -A` / `git add .`. Pred stagingom
`git status --short <súbor>` — ak je dirty a nie je tvoj, nepatrí do tvojho
commitu. Kompatibilný one-liner do cudzieho WIP súboru nechaj v strome
nezastagovaný a zmieň sa o nom v commit message (prielom `aef3e62c`).

## 4. Pred editom skontroluj vlastníctvo súboru

`git status --short <súbor>` pred každou úpravou väčšieho rozsahu. Dirty
súbor, ktorý nie je tvoj = niečí WIP: bud sa ho nedotýkaj, ale sprav minimálny
kompatibilný edit a explicitne ho nestaguj. Zdieľané hotspoty dnes:
`src/ui/PianoRoll.tsx`, `Sequencer.tsx`, `ArrangementPanel.tsx`,
`src/mcp/tools.ts`, `src/project-model/types.ts`, `docs/CURRENT-STATE.md`.

## 5. Falsifikácia a čisté behy cez `git worktree`, nikdy cez stash

Overenie regresného testu proti pre-fix kódu alebo čistý full-suite baseline:

```bash
git worktree add ../pf-x <commit>
rm -rf ../pf-x/node_modules
cmd //c "mklink /J D:\\pulse-forge\\..\\pf-x\\node_modules D:\\pulse-forge\\node_modules"
cd ../pf-x && npx vitest run tests/…
cd /d/pulse-forge && git worktree remove ../pf-x --force
```

Zdieľaný strom zostáva nedotknutý; `node_modules` sa nekopíruje (junction).

## 6. „Zelený baseline“ sa meria proti HEAD, nie proti dirty stromu

Full-suite beh na zdieľanom strome meria rozrobenú prácu ostatných vlán, nie
projekt (2026-10-03: 6 typecheck chýb, všetky v cudzom pitchcorrect WIP).
Baseline beh = worktree na HEAD (pravidlo 5), výsledok sa zapisuje do
`docs/CURRENT-STATE.md` s commitom, na ktorom bežal.

## 7. Konfliktné značky v hotovom súbore: najprv zisti, čie sú v nich veci

Pravidlo 2 hovorí „nikdy stash". Zlyhanie pravidla sa dá napraviť, ale
`git stash pop` zanechá v pracovnom strome `<<<<<<< Updated upstream` /
`=======` / `>>>>>>> Stashed changes` a **zablokuje `tsc` pre celý repo**.

Postup, ktorý funguje:

1. `Select-String -Pattern "^(<<<<<<<|=======|>>>>>>>)"` — zisti, _kde_ sú.
2. **Prečítaj obe strany a over, či je vnútri niečo cudzie.** Ak obe strany
   patria tebe (napr. tvoj stary a nový zápis toho istého bloku), rozhodnutie
   je jednoznačné a môžeš conflict vyriešiť sám. Ak vnútri je cudzí obsah,
   **netlač na svoje riešenie** — označ to a nechaj vlánu, ktorá ten súbor
   vlastní.
3. Po oprave `git status --porcelain <súbor>` musí ukázať `M `, nie `UU`.
   Kým ostáva `UU`, `git commit --only` cez ten súbor **zlyhá**.
4. `git add <súbor>` až po vyčistení značiek — to je krok, ktorý zmení stav
   z `UU` na staged.

Pozor na to, že `presets.ts` a `definitions.ts` sú hotspoty: zdieľané
presety aj parametre sa do nich píše z viacerých vĺn naraz.

Incidencia 2026-10-12: pop cudzej vlany vrátil do `src/effects/presets.ts`
dve verzie môjho vlastného bloku (starú s chybnými id a opravenú) a
duplikoval 5 presetov. Obe strany boli moje, rozhodnutie bolo jednoznačné,
ale `tsc` bol červený dovtedy, kým sa značky neodstránili.

## 8. NEVYTÁRAJ VLASTNÚ VETVU — pracuj priamo na `main`

Vetva v zdieľanom strome **neizoluje commity, iba ich prelepí štítkom**.
`HEAD` je globálny: všetky session zdieľajú ten istý pracovný strom, takže
ktoľkoľvek spustí `git commit`, commitne na tom, čo je práve checkoutnuté.

Incidencia 2026-10-20: agent si odbočil na `feat/state-matrix`, aby držal
izolovaný jeden commit s plánom. Do 20 minút na tú vetvu dopadlo **päť
commitov iných session** (intent routing, PCM mic recorder, master meter,
audit17, prepínací commit) — všetky, pretože commitujú proti spoločnému
`HEAD`. `main` zaostal o 6 commitov. Náprava: `git update-ref refs/heads/main
feat/state-matrix` (čistý fast-forward **bez dotyku pracovného stromu**),
potom `git checkout main` a `git branch -d`.

**Pravidlo:** commituj priamo na `main`. `main` je release/deploy vetva — to,
čo sa dodáva, to sa pushuje. Vetvu si nezakladaj. Ak potrebuješ izolovaný
**readonly** beh proti čistému HEAD (baseline, falsifikácia), použi pravidlo 5
(`git worktree add` na commit) — to je detached checkout na meranie, nie
vetva na commitovanie.

Súvisiace pravidlá, ktoré zostávajú v platnosti: 1 (commituj skoro), 2
(nikdy stash), 3 (staguj len vlastné súbory), 4 (skontroluj vlastníctvo
súboru pred editom).

**Kontrola, že si dodržal:** po commit-e `git branch --show-current` musí
vrátiť `main`, a `git status` nesmie mať tvoje súbory unstaged.

## 9. INDEX je zdieľaný — pred commitom ho vráť na HEAD

Pravidlo 3 hovorí „staguj len vlastné súbory". To nestačí: **index je tiež
zdieľaný**. `git commit` **bez pathspec** commituje **celý index** — teda aj to,
čo tam pred tebou nastagovala iná session. Tvoj `git add -- <tvoj súbor>`
pridá k tomu, čo už tam je.

Incidencia 2026-10-23: commit `6dd5b76e` bol spravený cez `git commit -F <msg>`
(bez pathspec, aby sa scope-riadky načítali zo súboru) a zobral **štyri cudzie
cesty**, ktoré mala paralelná session nastagované (`CAMPAIGN_STATE.md`,
`src/ai/grooves/index.ts`, `src/ai/meter.ts`, `src/intent/candidate-search.ts`).
Commit bol pushnutý skôr, než som to zistil, takže ho už nebolo možné amendnúť
bez force-pushe na zdieľanom `main` — force-push je horšia chyba než vysvetlenie
v správe. Cudzia práca zostala zachovaná a zverejnená (to session chcela), no
správa o commite neopisovala tie štyri cesty.

**Pravidlo — postup, ktorý funguje:**

```bash
git reset                                  # index := HEAD; pracovný strom sa NEMENÍ
git add -- <tvoj-súbor1> <tvoj-súbor2>    # stage presne tvoje cesty
git diff --cached --stat                   # KONTROLA: v indexe sú len tvoje cesty
git commit -F "<absolútna cesta k msg súboru>"
```

`git reset` (mixed) vráti index na HEAD a **pracovný strom nechá tak, ako je** —
cudzia nastagovaná práca teda neprejde, ostane v strome nezastagovaná (kto ju
potrebuje, znova ju `git add`-ne). Vec, ktorú `git diff --cached --stat`
ukáže navyše, patrí cudzej session: necommituj ju, odlož ju do nového commitu
alebo ju nechaj v strome.

**Nepoužívaj `git commit -- <cesta>` ako náhradu:** ten commituje **pracovný
strom** pre danú cestu, nie index — takže by zCommitoval aj cudziu WIP, ktorý
si práve editoval. `git commit --only <cesta>` má rovnaké správanie.

Súvisiace pravidlá: 1 (commituj skoro), 3 (staguj len vlastné), 4 (skontroluj
vlastníctvo), 8 (commituj na `main`).
