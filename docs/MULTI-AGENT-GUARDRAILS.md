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
