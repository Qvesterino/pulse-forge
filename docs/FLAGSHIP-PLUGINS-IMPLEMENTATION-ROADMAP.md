# KOPA · TSAR · KOREŇ — spoločná implementačná roadmapa

**Stav:** návrh poradia ďalšej práce

**Aktualizované:** 2026-10-21

**Rozsah:** produktové a implementačné kroky pre tri hlavné KYX nástroje; bez sľubovaných termínov vydania.

Tento dokument spája prácu naprieč tromi pluginmi a určuje odporúčané poradie. Detailné technické checklisty zostávajú v [KOPA + KOREŇ V2 backloge](KOPA-KOREN-V2-ROADMAP.md) a [TSAR implementačnej roadmape](TSAR-IMPLEMENTATION-ROADMAP.md). Tento plán ich nenahrádza.

## Zámer a hranice

- **KOPA** tvorí nový kick. Jej telo, pitch sweep, click, sub, tail a fázovo viazané harmoniky patria do jedného nástroja.
- **TSAR** premieňa vzorky aj syntetické zdroje na hrateľné hybridné patche a dáva priestor na ich ďalšiu tvorbu.
- **KOREŇ** spracúva už existujúci basový signál, sleduje jeho fundament a pridáva harmonické, ktoré zlepšia jeho čitateľnosť.
- Nástroje sa dopĺňajú. KOPA má vlastnú pitch synchronizovanú harmonickú vrstvu; KOREŇ zostáva všeobecným trackerom pre ľubovoľný basový vstup.
- Spoločným cieľom je skrátiť cestu od nápadu po počuteľný výsledok priamo v projekte, s preview, porovnaním a vratným potvrdením.

## Čo už máme

Základné zvukové schopnosti existujú. Ďalšia práca má najprv potvrdiť ich správanie a zlepšiť tvorivý workflow.

| Plugin | Už dodaná schopnosť                                                                                                 | Najbližšia otvorená otázka                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KOPA   | Samostatná kick syntéza, click/body/sub/tail, pitch obálka, harmoniky, režimy `ONE SHOT`/`GATED` a factory presety. | Zhodné velocity a fallback správanie, MIDI/retrigger kontrakt, produkčná hlasitosť a rýchlejšie vizuálne tvarovanie kicku.                                                                                          |
| TSAR   | Dva zdrojové sloty, sampler/wavetable/granular, modulácia, Forge analýza a deterministický A/B turnaj mutácií.      | Uzavrieť priame live/export porovnanie. Forge dnes po analýze ponúka **viac počuteľných čítaní** (vlna 3, ADR 0064) a vybraný sa aplikuje jedným undo krokom; chýba prepojenie A/B čítaní s live/export porovnaním. |
| KOREŇ  | Sledovanie fundamentu, harmonická syntéza, stav `LOCKED`/`HOLD`/`SEARCH`, confidence a monitor-only `PHONE CHECK`.  | Doplniť level-matched wet/dry počúvanie a uzavrieť merania trackingu, mono kompatibility, aliasingu a CPU.                                                                                                          |

Podrobné plány KOPA/KOREŇ a TSAR uvádzajú posledný zdokumentovaný correctness stav k **15. 10. 2026**. Pred vykonaním konkrétnej fázy treba ich otvorené položky porovnať s aktuálnym kódom a aktuálnymi výsledkami; tento dokument sám osebe neoznačuje žiadnu z nich za hotovú.

## Odporúčané poradie

| Vlna                                | Priorita    | Výsledok                                                                                | Závisí od                            |
| ----------------------------------- | ----------- | --------------------------------------------------------------------------------------- | ------------------------------------ |
| 0. Spoľahlivé základy               | P0          | Uzavreté správne správanie, live/export kontrola a zvukový review každého pluginu.      | Aktuálny kód a merania               |
| 1. KOREŇ A/B                        | P1          | Používateľ počuje, čo harmonická vrstva pridáva, pri porovnateľnej hlasitosti.          | Vlna 0 pre KOREŇ                     |
| 2. KOPA editor                      | P1          | Kick sa dá rýchlo tvarovať zrozumiteľnými krivkami a vrstvami.                          | Vlna 0 pre KOPA                      |
| 3. TSAR zdroje a Forge              | P1          | Vzorku možno znovu použiť a pred aplikovaním vypočuť viac tvorivých interpretácií.      | Vlna 0 pre TSAR; kontrakt zdrojov    |
| 4. TSAR mutácie                     | P1          | Variácie zachovávajú používateľom uzamknuté časti a majú ovládateľnú intenzitu.         | Stabilné parametre a mutačný preview |
| 5. Výraz a špecializované workflowy | P2          | ORBIT a prípadné pitch/monitor režimy riešia overené potreby z predchádzajúcich vĺn.    | Automatizácia a posluchové zistenia  |
| 6. Low-End Assist                   | P2 / výskum | KOPA, basová stopa a KOREŇ spolu navrhnú a umožnia vypočuť úpravu celého nízkeho pásma. | Vlny 0–4                             |

Vlny predstavujú poradie a brány, nie pevné termíny. Každý plugin môže mať vlastný reviewable diff; spoločné správanie sa integruje až po stabilizácii jednotlivých častí.

## Vlna 0 — spoľahlivé základy

Najprv obnoviť aktuálny baseline. Doterajšie roadmapy obsahujú konkrétne otvorené merania; výsledky zo 15. októbra sú dobrý východiskový bod, nie náhrada za nové meranie.

### KOPA

- [ ] Zmerať pomer click/body/harmonics pri nízkej, strednej a plnej velocity na worklete aj natívnom fallbacku.
- [ ] Uzavrieť `ONE SHOT`/`GATED`, krátke MIDI noty, note-off, retrigger, choke a voice stealing bez klikov alebo useknutého tailu.
- [ ] Premerať factory presety vrátane true peak a porovnania hlasitosti v praktickom gain kontexte; vypočuť ich v mixe.
- [ ] Potvrdiť účinok parametrov cez UI → command → project/runtime → počuteľný výsledok aj pri automatizácii.

### KOREŇ

- [ ] Zmerať pitch error a lock/unlock časy na basových zdrojoch, glisse a kombinácii kick + basa. Pri neistom fundamente musí generovanie bezpečne ustúpiť.
- [ ] Zmerať správny spektrálny cieľ každého parametra, low sample rate, aliasing, gain, mono fold-down a CPU v náročnom nastavení.
- [ ] Vypočuť level-matched bypass/wet porovnanie; potvrdiť, že PHONE CHECK ostáva monitor-only.
- [ ] Overiť, že stav trackera a confidence pravdivo zodpovedajú tomu, čo práve hrá.

### TSAR

- [ ] Uzavrieť priamy level-matched live playback ↔ offline export na rovnakom patchi a udalostiach.
- [ ] Vypočuť a kurátorsky skontrolovať ponúkané presety v mixe; automatický loudness/finiteness audit sám osebe nepreukazuje ich hudobnú kvalitu.
- [ ] Potvrdiť, že každý viditeľný zdroj a parameter ovplyvňuje aktívny hlas a že worklet sa načíta po pridaní TSAR do už otvoreného projektu.

**Brána:** uzavrieť len položky, ku ktorým existuje reprodukovateľný test alebo zdokumentovaný posluchový výsledok. Známe rozdiely medzi fallbackom a workletom pomenovať v UI alebo v podpore zariadení.

## Vlna 1 — KOREŇ: dôveryhodné A/B počúvanie

### Dodávka

- Pridať okamžité bypass/wet A/B s dorovnaním vnímanej hlasitosti na monitorovacej ceste.
- Pridať možnosť samostatne počuť generovanú harmonickú vetvu, aby sa dalo rozlíšiť, čo KOREŇ vytvoril a čo zostalo vo vstupe.
- Zachovať PHONE CHECK ako monitorovací filter; všetky porovnávacie režimy musia byť mimo projektovej state a exportného signálového reťazca.
- Zobraziť jasný stav porovnania a vysvetliť rolu `lowCut`, `subAnchor` a `mix` podľa skutočného signálového modelu.

### Kritériá hotovosti

- A/B porovnanie nemení uložené parametre, automatizáciu, mix ani export.
- Dorovnanie hlasitosti sa kontroluje na reprezentatívnych vstupoch; pri tichu alebo neistom trackingu sa nezobrazuje falošný prínos.
- Ovládanie funguje aj pri zatvorenom paneli v tom zmysle, že DSP nespolieha na otvorenú UI telemetriu.
- Používateľ dokáže v krátkom posluchovom teste určiť, čo harmonická vrstva pridala a či zlepšila čitateľnosť.

### Neskoršie rozšírenie

Po vyhodnotení A/B možno pridať monitorovacie profily pre malý mono reproduktor, laptop a širokopásmový systém. Profily ostanú monitor-only. Pitch režim `Audio / MIDI / Hybrid` sa začne až vtedy, ak korpus potvrdí, že MIDI koreň reálne znižuje oktávové chyby bez nových chybných lockov.

### Stav (2026-10-24) — DODANÉ

Implementované ako **ADR 0034 addendum 15** (kontrakt) + `docs/CURRENT-STATE.md` (popis).

- **Prepínač:** panel KOREŇ má trojstupňový A/B — `WET` (spracovaný signál), `DRY` (samotný vstup), `HARM` (samotná generovaná harmonická vetva).
- **Dorovnanie hlasitosti je v DSP, nie v UI:** procesor sleduje tri vyhladené RMS (suchý, normálny výstup, generovaná vetva; τ = 0,3 s) a auditionovanú cestu preskupuje na úroveň normálnej cesty. Prepínač je 10 ms crossfade — tvrdý skok medzi dvoma dorovnanými cestami je klik.
- **Mimo projektovej state:** `audition` je runtime AudioParam, nie projektový parameter. Node wrapper odmieta id na projektovej sync ceste, nie je žiadny command ani undo záznam a offline renderer si stvára vlastný engine — export si to nededí.
- **Jasný stav:** `MATCHED ±x dB`, `MATCH LIMIT` (zapnutý clamp −12…+18 dB), `NOTHING TO COMPARE` / `NO HARMONIC LAYER` (ticho alebo prázdna generovaná vetva → match padá na jednotku, žiadny falošný prínos).
- **Vysvetlenie modelu:** `lowCut` / `subAnchor` / `mix` za `<details>`, vrátane pravdy, ktorú DSP naozaj implementuje — pri `mix = 1` suchý signál mizne a sub pod `lowCut` s ním.
- **Dôkaz (merané, nie tvrdené):** normálna cesta **bit-identická** pred/po (SHA-256 `5821fcf9d22f3dd0` nad 3 s, skript v izolovanom worktree proti parent commitu `1f7ba68b`); DRY −0,12 dB a HARM −0,39 dB od normálnej úrovne; 55 Hz obsah v harmonickej ceste o 52,9 dB nižší než v normálnej.
- **Brány:** `tests/bass-harmonic-audition.test.ts` (skutočný procesor), `tests/koren-audition-engine.test.ts` (dokument, rebuild, zánik s efektom), `tests/ui/KorenPanel.test.tsx` (panel).
- **Otvorené:** posluchový review v tretej vlne korpusu — kritérium „používateľ dokáže v krátkom posluchovom teste určiť, čo harmonická vrstva pridala“ je subjektívne a patrí posluchu, nie automatizovanému testu.

## Vlna 2 — KOPA: vizuálne tvarovanie kicku

### Dodávka

- Pridať spoločnú časovú os s oddelenými click/body/sub/tail vrstvami a vizualizáciou existujúcej pitch obálky.
- Umožniť upraviť základné časovanie a úrovne priamo v grafike; pokročilé nastavenia ponechať dostupné v parametroch.
- Vychádzať najprv z existujúcich parametrov: editor má byť zrozumiteľnejším ovládaním existujúceho DSP, nie dôvodom na pridávanie knobov bez preukázanej potreby.
- Umožniť rýchly preview a porovnanie pred/po. Potvrdenie zapíše zmenu cez kanonický command ako jednu undo akciu.

### Kritériá hotovosti

- Grafika zobrazuje hodnoty uložené v projekte; ťahanie mení len priradené parametre a prejde cez command/undo/redo.
- Preview nemení projekt a používa tú istú zvukovú cestu ako reálne prehrávanie.
- Tvar a dĺžka kicku sú zrozumiteľné pri krátkom punch aj dlhom 808 kicku; UI ostáva použiteľné pri úzkom paneli a klávesnici.
- Zmeny editorom zachovajú MIDI, velocity, ladenie a live/offline paritu.

### Neskoršie rozšírenie

Po dokončení základného editora preveriť ladenie podľa tóniny projektu, BPM/groove-aware dĺžky a presný render velocity → sample. Nový pitch alebo drive DSP pridať iba vtedy, keď zvukové merania a posluch ukážu medzeru, ktorú existujúce vrstvy nepokryjú.

### Stav (2026-10-25) — DODANÉ

Implementované ako **ADR 0062** (kontrakt) + `docs/CURRENT-STATE.md` (popis).

- **Grafika:** jedna **logaritmická** časová os (1 ms → 3 s — 3 ms click a 400 ms tail na jednej osi), PITCH obálka nad vrstvami **CLICK / BODY / SUB / TAIL / HARM**, 10 ťahacích handleov (dĺžka = decay, výška = úroveň, plus pitch amount a pitch time).
- **Obrázok JE obrázok DSP:** model `src/kopa/layerModel.ts` **importuje** tvar pitch obálky a koeficient decayu z procesora (`pitchEnvAt`, `kopaDecayCoef`) — jedna implementácia, nie dve. Sub je široký ako dlhšia z body/tail (jazdí na `max(bodyEnv, tailEnv)`), body nemá height handle (DSP fixuje jeho mix gain) — grafika ponúka handle len tam, kde parameter existuje.
- **Táh = JEDNA undo akcia:** `setInstrumentParams` (dávková forma `setInstrumentParam`); počas ťahania sa kreslí lokálne, dokument sa zapíše raz pri pustení myši. EnvEditor, ktorý commituje na každý pointer-move, sa tu neopakoval.
- **Preview nemení projekt:** `A · SAVED / B · EDIT` prehráva dočasný runtime z draft hodnôt (rovnaká továreň, rovnaké DSP, rovnaká normalizácia ako živý reťazec) — nahradil samostatné tlačidlo „PREVIEW C2“.
- **Klávesnica a úzky panel:** každý handle je `role="slider"`, focusateľný a riaditeľný šípkami.
- **Dôkaz (merané, nie tvrdené):** proti **vykreslenému** procesoru — nakreslená obálka body aj nakreslená pitch krivka sedia so zvukom do 8 %; sub sleduje tail v okamžiku, keď body zhasla. `tests/kopa/layer-model.test.ts`, `tests/kopa/editor-command.test.ts`, `tests/ui/KopaEditor.test.tsx`.
- **Náklad vlny (meraný):** **+9 KB** do DAW-JS sumy, **+1 KB** do boot pathu (2132 → 2135 KB pri strope 2200 KB). Strop DAW-JS (5630 KB) bol už na HEAD **červený o 22 KB** pred touto vlnou — pretečenie nie je moje. Mŕtva váha bola odmeraná skriptom `scripts/audit-dead-weight.mjs`: **204 z 204 chunkov dosiahnuteľných**, **0** modulov poslaných dvakrát v hlavnom grafe — splácať sa nie je čím, lebo suma je shipnutý produkt. Rozhodnutie o strope patrí vlastníkovi budgetu s týmito číslami ako dôkazom.
- **Otvorené:** ladenie podľa tóniny projektu a BPM/groove-aware dĺžky (v „neskoršie rozšírenie“).

## Vlna 3 — TSAR: zdroje a viac možností z Forge

Táto vlna nadväzuje na R2 a R3 v [TSAR pláne](TSAR-IMPLEMENTATION-ROADMAP.md). Pred rozšírením Forge treba určiť, ako vzorka žije nezávisle od konkrétneho patcha.

### Dodávka

- Navrhnúť lokálny zdrojový záznam s identitou, názvom, technickými metadátami, informáciami o root/loop bodoch, pôvode a stave chýbajúceho súboru. Pred pridaním nového ukladacieho modelu skontrolovať existujúce sample knižnice a persistence.
- Ak sa mení uložený projektový tvar, najprv opísať migračný kontrakt a až potom meniť schému.
- Z jedného importu pripraviť niekoľko odlišných, deterministických Forge návrhov: hrateľný sampler, ladený/wavetable zvuk alebo textúru cez granular, ak to vstup podporuje.
- Pri každom návrhu ukázať meraný dôkaz, istotu koreňa, upozornenia a dôvod voľby enginu. Slabá istota nesmie byť prezentovaná ako presná tónina.
- Umožniť kandidátov vypočuť a porovnať bez zmeny projektu. Vybraný plán sa aplikuje do Source A alebo B jedným undoable commandom.

### Kritériá hotovosti

- Rovnaký súbor a nastavenia dávajú rovnaké kandidáty; prázdne alebo nečitateľné audio nedostane vymyslený koreň.
- Preview nemení zdroje ani parametre tracku. Apply nastaví očakávaný slot a zmena sa vráti jedným undo.
- Zdroj možno znovu použiť vo viacerých patchoch; chýbajúci alebo poškodený zdroj je viditeľný a riešiteľný.
- Vzorky zostávajú v lokálnom workflowe a pribalený factory obsah má doložený pôvod/licenciu.

### Stav (2026-10-25) — DODANÉ

Implementované ako **ADR 0064** (kontrakt) + `docs/CURRENT-STATE.md` (popis).

- **Kandidáti sú ČÍTAKY, nie varianty:** `src/tsar/forge-candidates.ts` je **súrozec** `src/tsar/forge.ts`, nie jeho prepracovanie — `forgePlan` zostáva jedinou implementáciou analýzy a kandidátska vrstva rozhoduje iba, **ktoré enginy dôkaz povoľuje**. **Žiadny seed:** čítanie je čítanie zvuku, nie ťahanie z distribúcie, takže rovnaký PCM dáva rovnakých kandidátov v rovnakom poradí (seedovaný mutation rebrík patrí vlně 4, kde ťahanie variantov je point).
- **Čítanie, ktoré dôkaz nepodporuje, sa NENABÍDZA:** hrateľný (sampler) vždy; ladený (wavetable) len keď `rootMidi !== null && rootConfidence >= 0.5` (wavetable je periodická tabuľka — bez čitateľného koreňa nie je čo ladiť); textúra (granular) len pre sustained materiál alebo telo, ktoré má čo rozložiť (`releaseSec >= 0.08 || attackSec >= 0.08` — 20 ms klik nemá čo rozložiť).
- **Slabý koreň sa nikdy nepredáva ako presná tónina:** `RELIABLE_ROOT_CLARITY = 0.5` riadi, či sa `srcARoot`/`srcBRoot` vôbec zapíše, a dôkazová linka znie `root ~MIDI 36 (weak, 20 % sure)`.
- **`ForgePlan` zámerne NEREZPREPRACOVANÝ:** `src/ui/ChoralPanel.tsx` je druhý konzument `forgePlan`.
- **Poradie import → čítania → počuť → aplikovať:** pred aplikáciou sa projektu nedotkne NIČ a audition (`previewInstrumentWithSources`, ktorý na preview seam získal override `sampleIdB`) používa **VLASTNÝ** zdroj čítania — čítanie do Source B sa počíva so zvukom, s ktorým aj skončí, nie so starým B zdrojom tracku. `applyForgeCandidateCommand` je **nový súrozec** `forgeSampleCommand`: napája iba overlay čítania (zvyšok patchu prežije), píše `sampleId`/`sampleIdB` podľa **vlastného** slotu čítania, zmaže `presetId` a je JEDEN `snapshot()` undo krok.
- **Zdrojový záznam (R2) — vedľa patchu, nie v ňom:** `src/sample-library/source-record.ts` opisuje zdroj nezávisle od patchu: identita podľa **OBSAHU** (`sourceContentHash`; existujúci `userSampleId` je odvodený od času a nie je stabilný), názov, technické metadáta, **meraný** koreň s istotou, obálka, loop info, pôvod a STAV, kde `missing` je viditeľný a riešiteľný („the audio is not in your library“) namiesto tichej diery. **Tvar projektového dokumentu sa NEMENÍ — žiadna migrácia schémy, žiadny bump `SCHEMA_VERSION`.**
- **Dôkaz (merané, nie tvrdené):** `tests/tsar/forge-candidates.test.ts` (17), `tests/tsar/forge-candidate-command.test.ts` (8), `tests/sample-library/source-record.test.ts` (12), `tests/ui/TsarForgeCandidates.test.tsx` (7). Slot-B čítanie nechá **každý** parameter `srcA*` byte-rovnaký; čítanie bez koreňa nechá producentov vlastný koreň; a import sám o sebe **nevykoná žiadny príkaz**.
- **Náklad vlny (meraný):** DAW-JS **5666 → 5672 KB** (**+6 KB**) pri strope **5630 KB**; boot path **2135 → 2135 KB** (**+0 KB**) pri strope 2200 KB. Obe čísla sú z **rovnakého stromu postaveného dvakrát** (priamy rodič `971750b0` a `374cd287` + táto vlna) v izolovaných worktreeoch, takže súbežné commity cudzích sessií nahlodenia nemenia. Brána DAW-JS bola **červená už o 36 KB pred touto vlnou** — vlnou 3 pribudlo 6 z 42 KB. Strop sa **nezvyšoval**: spúšťač to bez diety zakazuje a mŕtva váha bola odmeraná skriptom `scripts/audit-dead-weight.mjs` (**204 z 204 chunkov dosiahnuteľných, 0 modulov poslaných dvakrát v hlavnom grafe**). Rozhodnutie o strope patrí vlastníkovi budgetu s týmito číslami ako dôkazom.
- **Otvorené:** strop DAW-JS (5630 KB) je stále červený a patrí vlastníkovi budgetu; browser audit (`npm run test:browser`) stále nebežal, takže **počuteľná** rozdielnosť granular/wavetable čítaní v reálnom prehrávači zostáva neoverená.

## Vlna 4 — TSAR: riadené mutácie

Existujúci deterministický A/B turnaj mutácií ostáva základom. Rozšírenie sa sústreďuje na to, čo môže producent zachovať a ako ďaleko sa má patch zmeniť.

### Dodávka

- Pridať zámky pre skupiny parametrov, minimálne zdroj, ladenie, obálku a moduláciu.
- Pridať rozsah mutácie od jemnej zmeny po výraznejšiu premenu.
- Zobraziť seed a ponechať možnosť vyvolať rovnaké variácie neskôr.
- Zachovať aktuálny tournament preview; potvrdenie víťaza použije jeden undoable command.

### Kritériá hotovosti

- Rovnaký patch, seed, počet variantov, rozsah a zámky dávajú rovnaké výsledky.
- Zamknuté parametre zostanú bitovo nezmenené; všetky zmenené hodnoty sú v rozsahu a patch ostane hrateľný.
- Náhľad neprepíše originál a pôvodný patch možno vždy znovu vypočuť.
- Varianty sú odlišné aj zvukovo; iba odlišné číselné hodnoty nie sú dôkazom kvality.

### Stav (2026-10-27) — DODANÉ

Implementované ako **ADR 0073** (kontrakt) + `docs/CURRENT-STATE.md` (popis).

- **Zámky (LOCK)** — šesť skupín parametrov, ktoré sú **partíciou** všetkých 76 parametrov TSAR: `source`, `tuning`, `envelope`, `filter`, `modulation`, `character`. Zamknutá skupina sa **vyberá z osí** — jej parametre sa v žiadnom variante nezapíšu, takže zostávajú **bitovo nezmenené** (a zámky sa prenášajú aj do top-up variantov, ktoré sú druhý beh mutátora s iným seedom).
- **Rozsah (RANGE)** — štyri stupne (SUBTLE/MEDIUM/BOLD/FULL). Rozsah riadi **šírku** (koľko osí variant smie), **nie dosah**: meranie ukázalo, že pohyb zmenšený na sedminu váhy mení číslo, nie zvuk. Dosah si drží aspoň polovicu váhy aj pri najjemnejšom stupni a `range = 1` reprodukuje pôvodné ťaženie aj výber **presne**.
- **Seed** — zobrazený **celý** (staré tlačidlo ukazovalo len posledných päť číslic, čo nie je seed, ktorý sa dá znovu vyvolať), dá sa vpísať späť a každý beh sa eviduje s kľúčom (seed + rozsah + zámky), takže tie isté variácie sa dajú priviesť neskôr. Kľúč cestuje aj v menovke víťaza v histórii.
- **Pravidlo živosti osí** — `isMutationAxisLive` číta pravidlá samotného DSP: slot s LEVEL 0 je tichý; `srcAMorph`/`srcBMorph` číta len wavetable; `srcASpread` potrebuje unison; globálny `morph` potrebuje B; `noiseColor` potrebuje noise; **šírka** pracuje na side signále (`panR − panL`), takže centrovaný zdroj nemá side; **otvorený filter** prehltne svoje Q; LFO sa dostane k zvuku len cez mod slot; glide pod 0.001 engine ignoruje.
- **Brána počuteľnosti (audit)** — varianty sa renderujú **skutočným** procesorom a rozdiel sa meria v ZVUKU (vlastný vzorec z `tests/tsar/engine.test.ts`, rozšírený na stereo). Brána má **kontroly**: patch proti sebe = **presne 0**, patch líšiaci sa len v parametroch **tichého** zdroja = **presne 0** (pasca, merateľná), reálna zmena zvuku = **0,33**.
- **Zmerané (960 variantov, 4 rozsahy):** pred pravidlami boli **2 z 48** variantov bitovo identické originálu; po nich **0 z 960**. Najslabší variant na `FULL` = 0,0083, 10. percentil = 0,165, medián = 1,41. Turnaj zostáva slepý, originál sa dá vždy znova vypočuť a víťaz je stále JEDEN príkaz.
- **Úprimné limity** — meranie je rozdiel **energie** za celý render, takže pomalejšiu zmenu obálky podhodnocuje; je to dolná hranica vnemenoťného rozdielu, nie model sluchu. Pravidlá živosti pracujú s parametrami — asset-závislý fakt im je neviditeľný.
- **Náklad vlny (meraný, izolovaný)** — DAW-JS **5801 → 5807 KB** (**+6 KB**) pri strope **5630 KB**; boot path **2191 → 2191 KB** (**+0 KB**) pri strope 2200 KB. Obe stavy sú **ten istý strom** (`03d845d0`) postavený dvakrát — s tejto vlny zdrojovými zmenami a bez nich — v jednom izolovanom worktree, takže súbežné commity cudzích sessií nahlodenia nemenia. Boot path sa nepohohol (mutačný panel je za lazy chunkom). **Pre vlastníka budgetu:** brána DAW-JS bola **červená už o 171 KB** pred touto vlnou (pri vlne 3 stála na 5666 KB) a boot path má **len 9 KB rezervy**. Strop sa **nezvyšoval** — spúšťač to bez diety zakazuje a mŕtva váha bola odmeraná (`scripts/audit-dead-weight.mjs`: 204/204 chunkov dosiahnuteľných).
- **Otvorené:** strop DAW-JS (5630 KB) je stále červený a patrí vlastníkovi budgetu; browser audit (`npm run test:browser`) stále nebežal.

## Vlna 5 — výrazové ovládanie a podmienené rozšírenia

### TSAR ORBIT

- Pridať jednoduchú 2D X/Y plochu s voliteľným priradením na stabilné ciele, napríklad source morph, cutoff a intenzitu modulácie.
- Mapovanie sa uloží s patchom; pohyb sa zaznamená cez existujúcu projektovú automatizáciu.
- Overiť myš, dotyk a klávesnicu. MIDI learn/MPE rozšíriť po kontrole celej vstup → projekt → prehrávanie → export cesty.

**Brána ORBIT:** pohyb má počuteľnú odozvu; nahraná automatizácia prežije uloženie, prehrávanie aj offline export; obnovenie mapovania je jednoduché.

### Stav — vlna 5 hotová (2026-10-28, ADR 0074)

Implementované ako **ADR 0074** (kontrakt) + `docs/CURRENT-STATE.md` (popis).

- **Najprv defekt, ktorý brána odhalila.** Automatizačný most plánuje parameter zariadenia cez `setParameterAt`, ak ho runtime ponúka, a inak **padá na `setParameter`** — a ten zapisuje **ihneď**. TSAR `setParameterAt` nemal, takže nahraná krivka na parametri TSAR padala **okamžite**: v offline rendere sa každý bod krivky zapísal pred prvým vzorkou, **posledný bod vyhral** a export nebol výkon, ale jeho posledný snímok vydržaný dve minúty. DSP časovanú frontu udalostí už mal (`postEvent` / `applyEvent` / vyprázdnenie v bloku na vlastnej vzorke) — chýbala len runtime a worklet trasa. `tsarNode.setParameterAt` teraz v živom vysiela správu s `when` a v offline **udalostenie uloží** do `processorOptions.events` (`OfflineAudioContext` počas rendera nečerpá port queue — rovnaký kontrakt ako noty), a worklet rozdeľuje oba prípady: param bez `when` zostáva okamžitý, param s `when` vstúpi do fronty. Časovaný zápis je **override** — nemení zrkadlo parametrov runtime, pretože to je **základná hodnota projektu** a offline seed si ju odčíta.
- **Plocha** — `src/ui/TsarOrbit.tsx`: inertný renderer v domácich konvenciách vstupu (pointer capture, **jeden undo frame** na ťah, 2-D plocha na 1-D slider roli s oboma osami v `aria-valuetext`, šípky / Shift / PageUp, číselný fallback). Panel je škrup: odvádza, čo kreslí, a posiela, čo producent urobil — **UI nie je zdroj pravdy**.
- **Pozícia JE hodnota parametra** — jedno číslo, jedna pravda: čo producent vidí na ploche, čo engine hrá a čo zapisuje lane, je to isté číslo v `params` tracku. **Mapovanie** (ktorý parameter, v akom rozsahu) je to, čo hodnota povedať nevie, preto žije v projekte: `InstrumentTrack.orbit`, `SCHEMA_VERSION` 39 → 40 (`additive`, bez `MIGRATIONS` kroku; neprítomné = žiadna ORBIT plocha).
- **Katalóg je kurátorovaný, nie „všetkých 76"** — priradiť sa dajú len **spojité** parametre, pretože automatizačný most zapisuje pre enum a prepínač surové body (interpolovaná osa cez `srcAEngine` by prebehla cez neexistujúce indexy enginov) a grain/scan parametre sú von, lebo ich počuteľnosť závisí od enginu zdroja a žiadne pravidlo živosti to zatiaľ nerozlišuje. Pravidlá živosti sú **pravidlá mutátora** (`isMutationAxisLive`), **zdieľané**, nie napísané nanovo; s jednou výnimkou (mod slot bez zdroja alebo bez cieľa je vypnutý) a sídlia v `src/tsar/liveness.ts`, aby sa do boot cesty nevtiahol celý mutačný engine.
- **Nahrávanie je bežná projektová automatizácia** — nový príkaz **UPSERT** (`setAutomationPointAt`) drží **jeden bod na ticku** a pri prepise zachová identitu bodu (`addAutomationPoint` VKLADÁ a mohol nechať dve hodnoty na jednom ticku). Vzniknutá krivka je bežná lane: kreslí sa, presúva a zruší v existujúcom KYX workflow.
- **Pôvodné mapovanie sa vráti JEDNÝM príkazom** (`restoreDefaultOrbitMapping`) — brána „obnovenie mapovania je jednoduché". Dve osy na jeden parameter sa odmietnu (zápis X a Y by sa navzájom prepisovali).
- **Brána (meraná)** — `tests/tsar/orbit-timing.test.ts` načíta **skutočný postavený worklet bundel** v Node so stubovanými globálmi AudioWorkletu a **zmeria**, že časovaný parameter neplatí pri príchode a dopadne na svojej vzorke, že zvuk pred udalosťou je **bitovo identický** s plochým renderom, že energia za ňou sa naozaj hýbe a že dva rendry sú **bitovo identické** (export je deterministický). Model a príkazy sú zmerané tiež. 202 špecov zelených.
- **MIDI learn / MPE odložené** — zámerno, a s dôvodom zapísaným: najprv sa overí celá cesta vstup → projekt → prehrávanie → export.
- **Náklad vlny (meraný, izolovaný)** — DAW JS **5917 → 5932 KB** (**+15 KB**) pri strope **5630 KB**; studio boot path **2199 → 2201 KB** (**+2 KB**) pri strope 2200 KB; shipped JS total **8419 → 8434 KB**. Obe stavy sú **ten istý strom** (`4d9e96f5`) postavený dvakrát — raz s týmito zmenami a raz s nimi obrátenými (všetky štyri commity vlny) — v jednom izolovanom worktree, takže súbežné commity cudzích sessií nahlodenia nemenia. **Dve veci, ktoré musia byť povedané celé:** (1) brána DAW-JS bola **červená už o 287 KB pred touto vlnou** — vlna pridáva 15 KB z 302; (2) **boot path bol pred vlnou ZELENÝ s 1 KB rezervy** (2199/2200) a vlna ho prekračuje o **1 KB**. Rozpad tých 2 KB je presne merateľný: plocha aj jej príkazy sú **lazy** (0 KB — barrel ich výslovne nepre-exportuje, takže do statickej uzávierky studia nevstupujú), a na boot ceste ležia len tri malé príspevky, ktoré sú z podstaty boot-kritické — tvarová kontrola `orbit` v schéme, príkaz UPSERT v `commands/automation.ts` a časovaný zapisovateľ v `tsarNode.ts`. Strop sa **nezvyšoval** — spúšťač to bez diety zakazuje a vlna 2 ukázala, že mŕtva váha nie je (`scripts/audit-dead-weight.mjs`: 204/204 chunkov dosiahnuteľných, 0 modulov dvakrát v hlavnom grafe). Rozhodnutie patrí vlastníkovi budgetu; tieto čísla sú dôkaz.
- **Otvorené:** strop DAW-JS (5630 KB) je stále červený a patrí vlastníkovi budgetu; **boot path prekročil strop o 1 KB** (pozri vyššie — rezerva pred vlnou bola 1 KB); browser audit (`npm run test:browser`) stále nebežal; MIDI learn/MPE po bráne.

### KOREŇ monitor a pitch režimy

Monitor profily dokončiť iba po posluchovom potvrdení, že prinášajú užitočné porovnanie. Audio/MIDI/Hybrid pitch zdroj pridať iba po meraní na korpuse a po definovaní správania pri nezhode MIDI a audio detekcie.

### KOPA rozšírené ladenie a zvuk

Najskôr preveriť čitateľnosť pitch krivky, ladenie k tónine a dĺžku podľa tempa cez existujúce parametre. Ďalšie click modely, transient DSP, drive krivky či oversampling otvoriť ako samostatnú úlohu len po meranom alias/gain/CPU probléme.

## Vlna 6 — spoločný Low-End Assist

Po stabilizácii jednotlivých pluginov môže KYX pridať nástroj, ktorý vypočuje krátku slučku a pomôže s kickom a basou naprieč KOPA, basovým trackom a KOREŇOM.

### Navrhovaný workflow

1. Vybrať úsek, ktorý obsahuje kick a basu; analyzovať ich úrovne, spektrá, trvanie a časové prekrytie.
2. Navrhnúť niekoľko vysvetliteľných variantov, napríklad Tight, Heavy a Readable. Každý uvedie, či mení KOPA tail, rozostup, harmonické alebo úroveň.
3. Vypočuť varianty pri dorovnanej hlasitosti a v kontexte slučky.
4. Potvrdiť výber ako jednu transakčnú, undoable zmenu projektu.

### Brána pred implementáciou

- Existujú stabilné analyzátory a KOPA/KOREŇ preview bez skrytých zmien projektu.
- Varianty sa dajú odlíšiť meraním aj počutím; používateľ vidí, ktoré tracky a parametre sa zmenia.
- Funkcia nemení projekt automaticky počas prehrávania a výsledok sa správne prehrá aj vyrenderuje offline.
- Prvá verzia používa obmedzené, vysvetliteľné návrhy; automatické ladenie modelom sa rieši až po preukázaní kvality základných pravidiel.

## Spoločné implementačné a QA pravidlá

Každý implementačný diff sa riadi [AGENTS.md](../AGENTS.md), relevantnými ADR a [NEW-EFFECT-CHECKLIST.md](NEW-EFFECT-CHECKLIST.md).

- **Projektová pravda:** UI vydáva zmenu cez canonical command. Zmena má správne undo/redo a persistence round-trip.
- **Zvuková pravda:** realtime aj export používajú rovnaký DSP a význam MIDI/audio udalostí. Ak architektúra vyžaduje výnimku, zdokumentovať ju a overiť jej zvukový dopad.
- **Dôkaz parametra:** každý viditeľný parameter mení očakávanú merateľnú vlastnosť na hraniciach rozsahu a pri každej enum hodnote; preveriť sanitizáciu, automatizáciu a podporované sample rate.
- **Determinizmus:** zhodný projekt, seed a udalosť dávajú opakovateľný výsledok. Preview aj generovanie kandidátov nesmú závisieť od skrytého času.
- **Realtime rozpočet:** meria sa CPU, pamäť, hlasová cena a worklet bundle. V `process()` sa nepridávajú neohraničené alokácie.
- **Loudness a mono:** presety a A/B sa porovnávajú pri dorovnanej hlasitosti; KOPA/KOREŇ sa preveria v mono a v relevantnom nízkofrekvenčnom pásme.
- **Žiadne duplicity bez dôkazu:** KOPA harmoniky nenahrádzajú všeobecný KOREŇ tracker. Nový parameter alebo DSP sa pridá až keď existujúce schopnosti nepokryjú potvrdený používateľský cieľ.
- **Dokumentácia:** pri zmene počtu alebo shipped schopnosti upraviť `docs/CURRENT-STATE.md`; pri zmene architektonického kontraktu aktualizovať alebo pridať ADR.

## Najbližší vykonateľný krok

1. Obnoviť current baseline pre všetky tri pluginy a uzavrieť zostávajúce brány z vlny 0.
2. ~~Ako prvý nový používateľský workflow implementovať **KOREŇ level-matched A/B a počúvanie generovanej harmonickej vetvy**.~~ **DODANÉ 2026-10-24** (ADR 0034 addendum 15) — zostáva posluchový review.
3. Následne postaviť **KOPA vizuálny editor existujúcich vrstiev a pitch obálky**.
4. Potom rozšíriť **TSAR zdrojový workflow a Forge preview viacerých návrhov**.

Po každej vlne aktualizovať jej stav dôkazmi z testov, meraní a posluchového review. Názov položky v tejto roadmap-e neznamená, že už bola implementovaná.
