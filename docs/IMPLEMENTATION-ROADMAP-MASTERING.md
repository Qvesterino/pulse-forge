# Pulse Forge — realizačný plán: mastering

> Stav plánu: priebežne aktualizovaná implementácia, 2026-10-06  
> Produktové meno: **KYX**  
> Rozsah: zjednotenie existujúceho masteringu do profesionálneho, merateľného a zrozumiteľného workflow  
> Účel: vykonateľný plán nad aktuálnym kódom; nejde o tvrdenie, že všetky body už KYX obsahuje.

## Cieľ

KYX má používateľovi pomôcť pripraviť, upraviť, porovnať a bezpečne vyexportovať finálny stereo master. Na jednom mieste má byť zrozumiteľné:

1. čo je v signálovej ceste a v akom poradí;
2. čo meranie naozaj zistilo a čo z neho nemožno vyvodiť;
3. ktoré zmeny sa navrhujú, prečo a ako znejú pri férovom A/B porovnaní;
4. či finálny, vyrenderovaný súbor zodpovedá zvolenému profilu doručenia.

„Profesionálny“ tu znamená **reprodukovateľný audio workflow s jasným meraním, vratnými zmenami, kontrolou finálneho súboru a pravdivými obmedzeniami**. Samotný algoritmus ani zelený meter nemôžu potvrdiť umeleckú kvalitu alebo vhodnosť mastera pre každý reprodukčný systém.

## Rozsah a poradie

### Odporúčaný rozsah prvej produktovej verzie

Prvé vydanie pokrýva finálny stereo výstup **KYX projektu**. Použije spoločný `AudioEngine` a `renderProject()`; nesmie vytvoriť paralelný audio engine iba pre mastering. Prijíma aj skupinové zbernice pre stem processing, pričom finálny výstup každej zbernice prechádza globálnym master chainom.

Samostatné masteringové relácie pre dlhé stereo súbory vytvoríme až ako oddelenú fázu po návrhu streamovaného/chunkovaného audio importu. Súčasné importné a sample workflow nie je zmluvou pre veľké plnohodnotné stereo mixy.

### Súhrn etáp

| Etapa                                | Výsledok                                                    | Závislosť      | Priorita                    |
| ------------------------------------ | ----------------------------------------------------------- | -------------- | --------------------------- |
| 0. Rozhodnutia a baseline            | Jasný produktový, audio a validačný kontrakt                | —              | P0                          |
| 1. Jednotný profil doručenia         | Rovnaké ciele a pravidlá v MIX, EXP a MCP                   | 0              | P0                          |
| 2. Master bus a signálová cesta      | Jednoznačný graf procesorov vrátane finálneho insert miesta | 0              | P0                          |
| 3. Master pracovisko                 | Jedna používateľská cesta od analýzy po export              | 1, 2           | P0                          |
| 4. Merací a exportný report          | Dôveryhodná analýza vyrenderovaného výstupu                 | 1, 2           | P0                          |
| 5. Snapshoty, A/B a referencie       | Bezpečné porovnávanie master verzií                         | 2, 3, 4        | P1                          |
| 6. Masteringový asistent             | Vysvetliteľné návrhy s preview, potvrdením a undo           | 4, 5           | P1                          |
| 7. Delivery QA                       | Kontrola skutočne zakódovaného súboru a exportné profily    | 1, 4           | P1                          |
| 8. Mastering externého stereo súboru | Samostatná práca so stereo mixom mimo projektu KYX          | osobitný návrh | P2                          |
| 9. Release hardening                 | Zvuková, browserová a používateľská dôkazná sada            | 3–7            | P0 pred označením za hotové |

## Aktuálny stav implementácie

### Dodaný základ

- UI, offline export a `kyx_master` používajú spoločné profily a pravidlá verdictu. Výber profilu mení kontrolné ciele; master gain, fyzický limiter ceiling a spracovanie sa nemenia. Streaming verdict navyše ukáže Spotify advisory pri hlasnejšom než −14 LUFS masteri s true peakom aspoň −2 dBTP.
- `MasterConfig` ukladá profil, samostatný dBTP cieľ a globálny zoznam insertov. Schéma je v12; staršie LUFS ciele a limiter ceiling sa pri migrácii zachovávajú.
- Globálny insert rack je pred vstavaným clipperom a limiterom a spracúva finálny súčet. Master/stem bypass ostáva pre-master cestou. Insert parametre používajú existujúce efektové príkazy a runtime.
- Horný MASTER prehľad sústreďuje čerstvosť reportu, profil, scope, LUFS-I/dBTP odchýlky, stereo kontrolu a nálezy na kontrolu. SONG/PATTERN, sample rate aj Live/Studio HQ voľba a primárne Analyze tlačidlo sú dostupné pred živým metrom; nižšie ostávajú formát, bit depth a samotné doručenie.
- Nový dock panel MASTER (Alt+9) spája živý meter, stavový prehľad presného master chainu, spoločné Core master controls, master insert rack a offline analýzu/export. Rovnaký project-backed komponent ovláda vstavané stupne z MIX aj MASTER; explicitný prepínač sprístupňuje M/S gain ovládače. Report V8 oddeľuje PCM pred enkódovaním od finálneho WAV/MP3, pomenúva hlavný tap `master-output` (po limiteri, pred enkódovaním), nesie revíziu sample banku a uloží zdieľaný profilový verdict pre presne nameraný PCM. Doplnková LRA používa 3 s K-weighted okná, 10 Hz krok, EBU Tech 3342 gating a percentily; krátkodobá timeline zobrazuje min/mean/max priebeh v najviac 1 200 bodoch. Syntetické EBU Tech 3342 minimálne testy 1–4 prešli v tolerancii ±1 LU; autentické programové prípady 5–6 zostávajú otvorené. Dlhé pre-encode a post-decode analýzy bežia v zrušiteľnom module workeri. Worker v jednom priechode spracúva mono/stereo PCM po chunk-och s maximálne 0,5 MiB na kanál, validuje rozmery aj poradie a nedrží druhú celú kópiu audia. Jeden beh je obmedzený na 12 hodín; ostáva overiť tento horný limit a správanie pri limite v browseroch s menšou dostupnou pamäťou. Export skontroluje kontajner, WAV hlavičku/BWF a MP3 frame metadáta a použije tú istú masteringovú analýzu na dekódovanom výstupe, ak sa zmestí do pamäťového limitu browsera. Súbor nad 96 MiB WAV alebo 12 MiB MP3 dostane poctivý stav „audio not measured“ s dôvodom; veľký MP3 sa na kontrolu hlavičky číta po krátkych úsekoch a dĺžka sa označí ako odhad.
- `kyx_master` read-back používa ten istý uložený globálny master flow ako UI, doplní runtime fallbacky a živé úrovne výslovne označí ako snapshot, nie ako report celej skladby. ZENIT ovládanie zostáva samostatne pomenované ako track/group procesor.
- Master A/B ukladá úplný master config do lokálnej browser session, renderuje oba snapshoty pri rovnakej SONG/Studio HQ konfigurácii a ponúka preview-only loudness match. Live monitor bypass má plynulý prechod medzi suchou a master vetvou, ktoré sa stretávajú pred spoločným limiter stupňom. Referenčný WAV/MP3 vstup je lokálny a read-only; import a porovnanie nemenia projekt.

- MASTER ponúka jednoduchý a rozšírený pohľad bez druhého state modelu: jednoduchý ukazuje IN, TRIM, CEIL a LIMIT; rozšírený sprístupní vstavané spracovanie a master inserts. Skryté procesory ostávajú aktívne a signal-flow navigácia otvorí rozšírené ovládače pred presunom fokusu.

### Otvorené P0 brány

- `npm run build` a fyzický bundle budget prešli v tomto pracovnom stave: shipped JS 5 993 KB, DAW JS 4 474/5 000 KB, on-demand runtimes 640/650 KB, kodeky 166/170 KB, audio tool 713/750 KB, HUD 1 078/1 600 KB a worklety 142/150 KB. Vite stále hlási existujúce chunk/dynamic-import upozornenia. `npm run drift:check` prešiel a počet test súborov v `docs/CURRENT-STATE.md` sedí na 842. Chromium mastering E2E prešiel **6/6** po predĺžení timeoutu pre studený štart dev servera: wet/bypass tónový test, workspace klávesnica a narrow viewport, zrušenie renderu, full-song 16/24/32-bit export a skutočný IndexedDB Blob round-trip referenčného audia vrátane delete. Session/reference unit testy prešli 3/3. Rozšírený masteringový/regresný balík vrátane MCP, session, tailu a render-limit kontrol prešiel **368/368 v 21 súboroch**. Tónový test našiel odpojenie medzi oboma TILT filtrami v master chaine; spojenie je opravené a wet aj bypass vetva prešla. Po refaktore auditov sa štyri zastarané očakávania pre stage order, master input gain, spoločný master-control komponent a MCP status aktualizovali. Typecheck, Prettier, drift a `git diff --check` prešli po posledných zmenách.
- Aktuálny široký `npm run test:browser` skončil **302/309**. Master chain, glue, limiter, meter, bounce a Match EQ kontroly prešli. Release-wide gate zostáva otvorený: preset audibility, EQ/sidechain live↔offline null, round-robin variácie, click/tail artifact gate, PDC export zarovnanie (3 vzorky pri limite 2), app boot s `ERR_CONNECTION_REFUSED` a plugin workflow timeout. Celý Vitest suite, dlhý audio soak, abort v encode/decode fázach, poškodený output a manuálny posluch takisto ostávajú otvorené.
- Post-encode dekódované metriky, WAV/MP3 kontajnerové údaje a stiahnuteľný JSON sidecar už patria do reportu. Chromium round-trip overuje BWF v2 hodnoty aj 16/24/32-bit exporty a presnú zhodu počtu rámcov s reportovaným renderom; zrušenie render fázy nevytvorí report ani download. Otvorené ostávajú dlhé WAV nad browser decode limit, rovnaký exportný round-trip v ďalších podporovaných browseroch, abort v encode/decode fázach a browserová kontrola poškodeného outputu.
- Master A/B, referenčné porovnávanie a vysvetliteľný asistent sú implementované v pracovnom strome, no akceptačné kontroly etáp 5–6 ostávajú otvorené. Mastering externého stereo mixu je samostatná P2 etapa a zatiaľ nie je implementovaný.

Za dokončenú etapu sa považuje až po splnení jej akceptačných kritérií nižšie. Tento stav preto nedeklaruje plnohodnotný release gate ani masteringovú certifikáciu.

Etapy 1–4 vytvárajú prvé použiteľné pracovisko. Označenie „profesionálny masteringový nástroj“ nepriraďovať, kým neprejdú aj relevantné časti etáp 5–9 a manuálny posluchový gate.

## Pracovný kontrakt

Implementácia musí:

- najprv skontrolovať `git status --short` a zachovať cudzie rozpracované zmeny;
- čítať a rešpektovať `AGENTS.md`, `ARCHITECTURE.md`, ADR 0003, 0004, 0006, 0009, 0014 a 0020 podľa dotknutej oblasti;
- upravovať projekt iba cez existujúci project model, commands, store a runtime sync; React state je len pre krátkodobé UI drafty;
- držať jeden audio engine pre živé prehrávanie aj offline export a zachovať `useContext(ctx)` ako jedinú cestu tvorby audio uzlov;
- nové trvalé polia normalizovať, migrovať, otestovať cez undo/redo a kolaboratívny round-trip; projektový model ostáva serializovateľný;
- neukladať odvodené merania, progress, React stav, loading ani audio buffery do project documentu;
- rešpektovať AudioWorklet hranicu pre nový realtime DSP; pri novom DSP pridať ADR, validáciu parametrov, golden/regression a live/offline kontroly;
- rozlišovať „namerané“, „odvodené“ a „odporúčané“. Nesmie prezentovať odhad ako meranie ani „READY“ ako záruku kvality;
- každú automatickú úpravu ukázať vopred, vyžadovať potvrdenie, aplikovať ju ako vratný command a umožniť nové meranie;
- nevymýšľať univerzálne platformové normy. Konkrétne ciele overiť proti aktuálnym dokumentom cieľových služieb pri návrhu profilov a uviesť dátum/pôvod;
- neoznačiť fázu za hotovú, kým kritériá nie sú podložené testami, buildom alebo manuálnym dôkazom uvedeným v tejto roadmap-e.

## Východiskový baseline pred etapami 1–7

Nasledujúci súpis zachytáva stav pri začiatku plánu a slúži ako historický kontext k zmenám nižšie. Niektoré položky už boli etapami 1–7 nahradené; pred ďalšou implementáciou overiť stav proti HEAD a riadiť sa sekciou „Aktuálny stav implementácie“.

- **Master chain:** `src/audio-engine/masterChain.ts` obsahuje IN/TRIM, páskovú saturáciu, M/S a bass-mono stupne, DC filter, MATCH EQ, TILT, buss GLUE, voliteľný soft clipper a master look-ahead limiter. Predvolené nastavenia sú prevažne neutrálne; LIMIT a GLUE sú zapnuté.
- **Živý master meter:** `src/ui/MasterMeter.tsx`, `src/ui/Mixer.tsx` a `src/audio-engine/metering.ts` už zobrazujú LUFS-M/S/I, true peak, stereo koreláciu, mono loss, GR, GLUE GR, spektrum, spektrogram, goniometer, históriu loudness, varovania a verdikt voči cieľu.
- **Grafické ciele:** master meter dnes ponúka −14, −12, −9 a −7 LUFS. Výber cieľa mení verdict; sám osebe nemení audio.
- **MCP profily:** `src/mcp/master-profiles.ts` definuje inú sadu profilov a stropov; masteringové operácie žijú v `kyx_master`. Toto sa musí zjednotiť, nie dokumentovať ako dve rovnocenné pravdy.
- **Masteringové efekty:** ZENIT skladá existujúce procesory do pevného reťazca; APEKS je maximizer, ŠÍRKA per-band imager a PRÚD dvojpásmový dynamický EQ. Sú dostupné ako efektové zariadenia. ZENIT na skupinovej zbernici spracúva daný stem, ale za ním stále nasleduje globálny master chain.
- **Export:** `src/ui/ExportPanel.tsx`, `src/rendering/renderer.ts` a `src/rendering/wav.ts` podporujú offline master render, WAV 16/24-bit PCM a 32-bit float, 44,1/48 kHz, MP3, stem export, summary, Mix Check, MONO GUARD, AUTO STAGE a obmedzený MIX FIX.
- **Mix analýza:** Mix Doctor v `src/analysis/mixDoctor.ts` počíta okrem iného integrovaný loudness, peak, crest a podiel nízkych frekvencií; niektoré deterministické opravy sa ponúkajú až po exporte.
- **VLYX:** VLYX Mix Assist a Reference Match analyzujú vybranú stopu, predkladajú návrhy a používateľ ich môže skontrolovať. Nejde o plnohodnotnú analýzu ani automatické spracovanie finálneho stereo mastera.
- **Chýbajúci jednotný povrch:** kroky masteringu sú rozdelené medzi MIX, DEV a EXP. Nie je jeden trvalý mastering report, jednotný profile contract, full-master A/B snapshot ani spoločný master-bus insert rack.

Referencie k aktuálnemu správaniu: [Mastering v KYX](MASTERING.md), [ADR 0009 — offline render/export](adr/0009-offline-render-export.md), [ADR 0020 — ZENIT](adr/0020-zenit-composite-mastering-device.md), [CURRENT-STATE](CURRENT-STATE.md).

## Etapa 0 — produktový kontrakt a baseline

**Výstup:** uzavreté rozhodnutia o tom, čo KYX sľubuje, a opakovateľný baseline pred zmenami.

### Rozhodnutia pred implementáciou

- [x] Zafixovať prvý rozsah: master výstup projektu KYX; externý stereo súbor je samostatný P2 workstream.
- [x] Rozhodnúť, či finálny master bus dostane vlastný insert chain, alebo sa prvá verzia pracoviska mapuje iba na fixný master chain a existujúce group/track insert chainy.
- [x] Ak sa pridá master insert chain, otvoriť follow-up ADR k ADR 0006/0009/0020: poradie voči returns, master safety, latency/PDC, live/offline sync, solo/stem správanie, bypass a migrácia.
- [x] Definovať rozdiel medzi **delivery profile** (čo sa kontroluje), **processing preset** (ako sa tvaruje zvuk) a **loudness adjustment** (aké gain zmeny používateľ potvrdil).
- [ ] Určiť vlastníka a postup periodickej revízie cieľových špecifikácií. Spotify mastering guide bol skontrolovaný 2026-10-06 a Streaming profil už zobrazuje jeho podmienené −2 dBTP odporúčanie; ostatné profily sú workflow východiská, kým nebudú overené konkrétne briefy.
- [ ] Zaznamenať baseline pre typy projektov, metering, offline renderer, export formáty, aktuálne warning thresholds, testy a známu odchýlku medzi LIVE a Studio HQ quality.
- [ ] Zaznamenať platformové obmedzenia monitoringu. Windows Electron je podľa aktuálneho kontraktu tenký Web Audio shell; profesionálny monitoringový claim čaká na zdokumentovaný a odmeraný výstupný device path.

**Akceptácia:** produktová a architektonická poznámka jasne odpovie, či používateľ masteruje projekt alebo ľubovoľný stereo súbor, kde v grafe leží masteringový rack a ktoré hodnoty sú ciele/verdict, nie automatické úpravy.

## Etapa 1 — jednotný profil doručenia

**Výstup:** jedna zdrojová pravda pre grafické rozhranie, export aj MCP.

**Pravdepodobné súbory:** `src/mcp/master-profiles.ts`, nové zdieľané `src/mastering/profiles.ts`, `src/project-model/types.ts`, `src/project-model/schema.ts`, `src/commands/commands.ts`, `src/ui/MasterMeter.tsx`, `src/ui/ExportPanel.tsx`, `src/mcp/tools.ts` a testy týchto oblastí.

- [x] Presunúť alebo zdieľať profilovú definíciu tak, aby UI a `kyx_master` volali tie isté čisté pravidlá a mali identické verdict thresholds.
- [x] Definovať profilový kontrakt minimálne s: ID/názvom, integrovaným LUFS cieľom, toleranciou, max true peak dBTP, pravidlami pre nemerateľný signál, mono/fázovými kontrolami, odporúčaním pre formát a jasným textom o zamýšľanom použití.
- [x] Pridať používateľský **Custom** profil. Nesmie odstrániť možnosť nastaviť samostatne loudness target a ceiling.
- [x] Oddeliť `Check against profile` od explicitného `Apply profile settings`. Výber profilu sám nemení masterGain, ceiling, limiter ani efekty.
- [x] Rozhodnúť persisted semantiku: ak sa profil uloží v projekte, doplniť voliteľné pole `MasterConfig`, zvýšiť `SCHEMA_VERSION` a pridať migráciu cez `migrateProject`. Existujúce `lufsTarget` a `ceilingDb` zachovať bez prekvapivého prepisu; stará hodnota sa bezpečne premietne do Custom/legacy stavu.
- [x] Zachovať profilové merania ako odvodený runtime/export report, nie ako údaj uložený v project documente.
- [x] MCP `platform`, `land`, `trim` a `assist` majú používať zdieľaný profilový kontrakt; MCP read-back a UI verdict musia byť pri rovnakom reporte identické.
- [x] Zjednotiť jednotky a popisy: sample peak dBFS, true peak dBTP, loudness LUFS/LU; nikde neskrývať rozdiel pod všeobecné „dB“.

**Akceptácia:** golden testy pre každý profil pokryjú hranice pass/warn/fail, nemerateľný materiál, true peak, mono/fázu a custom hodnoty. Pri tom istom `MasterMeasurement` musí UI aj MCP vrátiť rovnaký status, hodnoty a dôvody. Projekt vytvorený pred migráciou si ponechá doterajší zvuk aj cieľ merania.

## Etapa 2 — jednoznačný master bus a signálová cesta

**Výstup:** používateľ vidí a ovláda skutočný reťazec, ktorý spracúva finálny výstup.

**Pravdepodobné súbory:** `src/project-model/types.ts`, `schema.ts`, `src/audio-engine/masterChain.ts`, `AudioEngine.ts`, `src/effects/registry.ts`, `src/ui/EffectRack.tsx`, `src/ui/Mixer.tsx`, `src/rendering/renderer.ts`, commands a engine/render testy.

- [x] Zvoliť kanonickú reprezentáciu master insertov. Odporúčaný cieľ: rovnaký `EffectRuntime`/`EffectDefinition` kontrakt ako pri trackoch, ale v explicitnom master slote project modelu.
- [x] Zachovať oddelenie fixných safety/utility stupňov (napr. DC a ochrana stropu) od používateľsky vložených farebných/dynamických insertov; presné poradie musí byť viditeľné a zdokumentované.
- [x] ZENIT ostáva efektom track/group zbernice; finálny stereo sum má samostatný projektový master insert rack podľa ADR 0021. MASTER mapa preto nepredstiera, že ZENIT na skupine je globálny master.
- [x] Definovať master-insert správanie: full master zahŕňa returns a všetky skupiny; group/per-track stem zachováva vybrané track/group FX a routované return FX, ale obchádza globálny master chain. Export stemov ignoruje live mute/solo; plný mix ich rešpektuje. Report finálneho súboru patrí MASTER exportu. Kontrakt je v ADR 0021.
- [x] Použiť zdieľanú definíciu poradia na skladanie sériovej master signal path v `MasterChain` aj na vykreslenie MASTER mapy; odstrániť dve nezávislé tabuľky poradia.
- [x] Rozšíriť zdieľaný `MASTER_SIGNAL_FLOW` do `kyx_master op:status`; uviesť named post-limiter meter tap, pre-encode report tap a runtime fallbacky master workletov/inserts.
- [x] Monitor-only bypass používa plynulý crossfade a suchú vetvu dorovnáva podľa nahlásenej pre-limiter latencie vstavaných aj vložených master procesorov; prekročenie 0,999 s sa viditeľne označí ako čiastočné dorovnanie.
- [x] Unit testy potvrdzujú 15 ms párový crossfade, podržanie automatizácie pri rýchlom prepnutí, aktualizáciu zarovnania po neskorom reporte latencie, limit 0,999 s s viditeľným warningom a sample-exact delay write pri offline príprave (`tests/master-chain.test.ts`).
- [ ] Browser audio akceptácia musí potvrdiť počuteľne click-free toggle, reálne oneskorené worklet reporty, výmenu/fallback workletu, disposal a live/offline parity.
- [x] Pri novom persisted master racku zvýšiť `SCHEMA_VERSION`, doplniť migráciu cez `migrateProject`, normalize, command/undo/redo, collab/YDoc round-trip a import/export projektu.
- [x] Zachovať nulové rozšírenie live graphu po otvorení exportného `OfflineAudioContext`; všetky uzly vznikajú cez `useContext(ctx)`.
- [ ] Ak sa zavádza nový efekt/processor, pridať technický ADR a zodpovedajúce zdokumentované QA. M1/M2 DSP sa nesmie potichu meniť pod existujúcim presetom.

**Akceptácia:** testy deterministicky preukážu skutočné poradie uzlov, bypass, latency/PDC, dispose a zhodu živej a offline cesty. Export mastera obsahuje presne zobrazené master inserts; group/stem render spracuje len tie zbernice, ktoré deklaruje UI.

## Etapa 3 — jednotné MASTER pracovisko

**Výstup:** používateľ nepreskakuje medzi tromi panelmi, aby zistil stav mastera.

**Pravdepodobné súbory:** nové `src/ui/MasteringPanel.tsx`, `src/ui/dockLayout.ts`, `src/ui/DockChrome.tsx`, `src/ui/Mixer.tsx`, `src/ui/ExportPanel.tsx`, `src/styles.css` a UI/E2E testy.

Navrhovaná informačná architektúra:

```text
MASTER
├─ Delivery: profil, target, ceiling, formát
├─ Analyze: celý arrangement, priebeh, report a problémy podľa priority
├─ Chain: skupinové/track processing → master inserts → master safety
├─ Compare: A/B, reference, hlasitostne dorovnaný bypass
└─ Export: nastavenia, render, post-encode QC a finálny report
```

- [x] Pridať samostatnú MASTER dock záložku a klávesovú skratku Alt+9; meter, insert rack a exportná analýza sú v jednom pracovisku.
- [x] Zobraziť názov projektu, SONG/PATTERN scope, dĺžku analyzovaného programu v reporte, profil, dátum/čerstvosť render reportu, rate/quality nastavenia a jedinú primárnu akciu Analyze.
- [x] V hornej sumarizácii ukázať stav profilu, LUFS-I delta, max dBTP margin, mono/fázu a počet nálezov na kontrolu. Každý status má aj text, nie iba farbu.
- [x] Zobraziť skutočné poradie globálneho master chainu a jeho aktuálne active/flat/bypassed stavy; tracky, groupy a returns pomenovať ako vstupný súčet a user inserts oddeliť od clipper/limiter safety stupňov.
- [x] Zobrazovať degradation status vstavaného Tape/Glue/Limiter fallbacku aj master insert runtime; `getDegradedFx()` zahŕňa master FX rack a `getDegradedMasterStages()` vstavané DSP stupne.
- [x] Zobraziť vstavané master ovládače priamo v MASTER a znovu použiť ten istý project-backed komponent v MIX; pridať chýbajúci explicitný M/S enable prepínač.
- [x] Umožniť klávesnicovým výberom v signal-flow prehľade presunúť fokus na jestvujúci vstavaný ovládač alebo vybrať konkrétny master insert v jeho existujúcom racku; nové parametre ani samostatný stav sa nevytvárajú.
- [x] Zachovať rýchly prístup k MIX/DEV/EXP a existujúcim shortcutom; Chromium E2E overuje viditeľné dock taby, ich Alt+1/2/5 popisy, prepnutie Alt+1 a otvorenie/zatvorenie MASTER cez Alt+9.
- [x] Ponúknuť jednoduchý pohľad s hlavnými gain/ceiling ovládačmi a rozšírený pohľad na konkrétne zariadenia. Neprepisovať pokročilé DSP ovládače do druhého, odlišného state modelu.
- [x] Signal-flow ovládače sú klávesnicovo aktivovateľné; výber TILT z jednoduchého pohľadu otvorí Advanced a presunie fokus priamo na existujúci slider. Chromium E2E pokrýva roly/názvy ovládačov aj návrat na collapsed dock.
- [x] Chromium workflow E2E spustí full-song analýzu, overí busy stav a report, zmenou INPUT označí výsledok stale a po opakovanom meraní stale stav odstráni.
- [x] Rovnaký E2E tok exportuje 16/24-bit PCM aj 32-bit float WAV, zachytí každý download a overí BWF v2 metadata aj post-decode audio QC finálneho súboru.
- [x] Narrow viewport `390×844`: MASTER nemá horizontálny overflow a Analyze aj Render A/B ostávajú viditeľné; overené v Chromium E2E.
- [ ] Dokončiť manuálny screen-reader smoke test a skontrolovať všetky oznamované statusy v MASTER pre Narrator/VoiceOver.
- [ ] Starý projekt bez mastery state otvorí MASTER bez migráciou vynútených zvukových zmien.

**Akceptácia:** používateľ dokáže z MASTER spustiť full-song analýzu, prečítať report, upraviť reálny procesor, znova zmerať a exportovať bez straty kontextu. UI testy pokryjú collapsed dock, úzku výšku, keyboard/focus, loading, cancel, error a stale-report stav.

## Etapa 4 — dôveryhodná analýza a report

**Výstup:** rovnaký finálny buffer vedie k rovnakému meraniu v playback verdict, offline exporte a mastering reporte.

**Pravdepodobné súbory:** `src/audio-engine/kweighting.ts`, `metering.ts`, `meteringRig.ts`, `artifactGate.ts`, `src/analysis/mixDoctor.ts`, nové `src/mastering/analysis.ts`/worker, `src/rendering/renderer.ts`, `ExportPanel.tsx` a meracie/browser testy.

- [x] Vytvoriť jeden verzovaný typ `MasterRenderReport` pre úspešný beh s run ID, project revision ID, profilom, sample rate, quality mode, scope SONG/PATTERN a rozsahom analyzovaných vzoriek.
- [x] Previesť celý finálny výstup cez offline renderer; meranie nesmie čítať iba aktuálny 30 Hz live UI snapshot a tvrdiť, že pokrýva celý track.
- [x] Export panel používa samostatné `cancelled` a `error` stavy. Zrušenie odstráni report aj Mix Doctor výsledok a uvedie, či akciu zrušil používateľ alebo ju zastavilo runtime; nikdy sa nevydáva za úspešné `done`.
- [x] Znovu použiť existujúce meracie primitívy pod jedným `analyzeMasterBuffer()` kontraktom pre zdrojový aj dekódovaný PCM: LUFS, sample/true peak, RMS, koreláciu, mono loss, L/R RMS imbalance, clipping, crest, DC a Mix Doctor. Report ukladá profilový verdict vrátane jednotlivých checkov; L/R balans sa už nenahrádza fiktívnou nulou.
- [x] Doplniť LRA ako doplnkovú metriku reportu podľa EBU Tech 3342: 3 s K-weighted okná s krokom 100 ms, absolútny gate −70 LUFS, relatívny gate −20 LU a percentily 10/95; pri súborovom meraní sa doplní aspoň 1,5 s ticha. LRA nie je cieľ hlasitosti a pri nepočuteľnom alebo kratšom než 3 s programe sa označí ako nemeraná.
- [x] Zobraziť krátkodobú loudness timeline s 3 s oknami a 100 ms krokom v MASTER prehľade. Dlhé rendery kondenzovať na najviac 1 200 min/mean/max bodov; timeline neobsahuje analytické padding ticho a po dekódovaní uprednostní meranie finálneho súboru.
- [ ] Uzavrieť LRA dôkazy bez tvrdenia o úplnej EBU zhode. Synteticky zostrojené prípady 1–4 z Tech 3342 prešli v `tests/kweighting.test.ts` v tolerancii ±1 LU; pribudli testy invariancie pri opakovaní programu a krátkom koncovom fade. [EBU Tech 3342](https://tech.ebu.ch/docs/tech/tech3342.pdf) vyžaduje aspoň 10 Hz sliding-window meranie a pre file-based LRA aspoň 1,5 s koncového ticha; zároveň vysvetľuje, že krátky hudobný fade nemá LRA významne nafúknuť. Autentické programové prípady 5–6 ostávajú neoverené: [podmienky test setu EBU](https://tech.ebu.ch/files/live/sites/tech/files/shared/testmaterial/use%20of%20EBU%20AUDIO%20test%20sequences.pdf) povoľujú sekvencie iba na interné R&D a zakazujú business/commercial/for-profit použitie, preto sa nesmú pridať do KYX CI alebo distribuovaných fixture-ov. Ďalší dôkaz musí použiť nezávisle licencovaný materiál alebo vlastné programovo realistické vektory. DC offset je už súčasťou Mix Doctor analýzy.
- [ ] Žiadne skryté “spectral balance pass” rozhodnutie bez jasného popisu proxy a neistoty; tonal curve je odporúčanie, nie štandardizovaný pass/fail.
- [x] Oddeliť `pass / advisory / fail / not measured` v profilovom verdicte (`warn` znamená advisory) a `stale / cancelled` v stave pracoviska. Ticho, krátky render a mono zdroj vracajú `not-measured` pre kontroly, ktoré si vyžadujú merateľný program alebo stereo signál; problém true peak/fázy môže stále viesť k fail.
- [x] Report zneplatniť pri zmene projektu, sample-bank revision, scope, sample rate, profile alebo export-quality režimu; panel dostáva revision notifikáciu okamžite a ak sa banka zmení priamo počas renderu, render sa zahodí.
- [x] Dlhšie analyzovanie držať mimo realtime audio callbacku; progress/cancel zastaví worker a zmena projektu alebo sample banku zahodí zastarané výsledky.
- [x] Masteringové render vstupy (analyze/export, A/B, reference a assistant) čakajú na dokončenie boot-time curated/user-sample hydratácie; používateľ môže čakanie zrušiť. Zdrojová bank revision sa zachytí až po hydratácii, takže prvá analýza nepomieša staré a nové assety.
- [x] PCM worker boundary validuje sample rate, profil, kanály, rozmery a poradie chunkov. Jedno-priechodová analýza udržiava iba stav filtrov, 16-sample true-peak históriu a K-weighted subblock powers; nevytvára druhú plnú PCM kópiu.
- [x] Prenos mono/stereo PCM prebieha po frame chunk-och s limitom 131 072 vzoriek na kanál (0,5 MiB/kanál); celý beh má explicitný 12-hodinový strop a okamžite zrušiteľný worker.
- [ ] Overiť rozsiahle vektory, viac-hodinovú analýzu, worker abort počas spracovania chunku a správanie pri dosiahnutí časového stropu v podporovaných browseroch.

**Akceptácia:**

- známe vektory pre K-weighting/LUFS vrátane existujúceho browser conformance testu dávajú očakávané výsledky v meracej tolerancii;
- true-peak testy zahŕňajú inter-sample peak, rôzne sample rate a strop testovaný po poslednom DSP stupni;
- mono, phase, silent, krátky, clipped a hot stereo case majú očakávané verdict triedy;
- ten istý vyrenderovaný PCM buffer dá zhodný report pre UI a MCP;
- cancel, worker failure a zmena projektu počas merania nemôžu aplikovať zastaraný výsledok.

## Etapa 5 — bezpečné verzie, A/B a referencie

**Výstup:** master rozhodnutia sú porovnateľné bez hlasitostnej ilúzie a bez straty pôvodného stavu.

**Pravdepodobné súbory:** `MasterConfig`/schema/commands, nový MasteringPanel, `AudioEngine.ts`, `renderProject()`, export a master session testy.

- [x] Pridať session A/B snapshoty pre celý `MasterConfig`, teda aj profile selection a všetky master inserts; snapshot sa nemení cez undo stack.
- [x] Uložiť snapshoty do `sessionStorage` podľa project ID. Snapshot je lokálny pre aktuálny browser tab, neputuje cez project document, undo/redo ani spoluprácu.
- [x] Implementovať monitor-only Master Bypass s 15 ms gain crossfade. Suchá cesta obchádza master trim, tónové stupne, glue, inserts a clipper; obe cesty sa stretnú pred spoločným finálnym limiterom. Projektový mix, routing a export sa nemenia.
- [x] A/B vyrenderovať ako SONG pri rovnakom sample rate a Studio HQ kvalite. Voliteľný LUFS-I match používa len audition gain a hlasnejšiu verziu iba stíši; merania aj project config ostávajú bez zmeny.
- [x] Pridať referenčný audio vstup pre monitoring: pred dekódovaním skontrolovať WAV/MP3 kontajner, po dekódovaní zmerať trvanie/kanály/sample rate/peak/LUFS, uložiť originálne bajty do samostatnej lokálnej IndexedDB a porovnať s plným current-master renderom cez priamy monitor route. Referencia sa do projektu ani exportu nezapája.
- [x] Zachovať originálny WAV/MP3 read-only. Nahradenie a odstránenie referencie sú explicitné úkony; import nemení masteringové ani tonálne parametre projektu.
- [x] Pridať spoločné hlasitostné dorovnanie, mono audition, dim a samostatné štartovacie body projektu/referencie. Prepínanie strán začína od zvolených bodov a ovládanie je dostupné štandardnou klávesnicovou navigáciou.
- [ ] Blind A/B je neskorší voliteľný režim; nesmie byť release podmienkou pre prvú workspace iteráciu.

**Akceptácia:** A/B renderuje ten istý program bez driftu, rozdiel output trimu je viditeľný, zmeny neprepíšu snapshot a Undo nezmieša snapshot s audio render cache. Referencia sa neobjaví v master/stem exportoch a pri vypnutí reference sa nič nestratí.

Implementácia snapshotov, monitor bypassu a referenčného porovnávania je v pracovnom strome. Akceptácia etapy 5 ostáva otvorená do automatických browser/audio kontrol a manuálneho posluchu; blind A/B je voliteľný follow-up.

## Etapa 6 — vysvetliteľný masteringový asistent

**Výstup:** používateľ dostáva malý počet overiteľných návrhov, nie „AI mastered“ štítok.

**Pravdepodobné súbory:** `src/mcp/master-assistant.ts`, shared mastering planner, `src/ui/MasteringPanel.tsx`, commands, `src/analysis/mixDoctor.ts` a návrhové/preview testy.

- [x] Zdieľať čisté deterministické plánovanie s MCP cez `src/mcp/master-assistant.ts`; UI aj MCP používajú rovnaký planner.
- [x] Karty ukazujú merací dôkaz, dôvod, zariadenie/parameter, starú a novú hodnotu, trade-off a nízku istotu heuristiky.
- [x] Preview sa renderuje na draft dokumente mimo projektu. Aktuálny master sa dá znovu vyrenderovať a porovnať pri loudness match; analýza sama nič nezapíše.
- [x] **Apply selected**, **Apply all**, **Dismiss** a **Reset to snapshot**; apply je jedna pomenovaná undoable zmena a vyžaduje preview presne vybranej kombinácie.
- [x] Pri explicitnom delivery contracte navrhovať len najmenšiu bezpečnú korekciu podloženú meraním: pri true-peak prekročení upraviť bounded limiter ceiling. LUFS, crest, korelácia, low end a spektrálne podiely ostávajú report-only, kým samy osebe nepreukazujú bezpečný master-bus zásah; master gain sa nepoužíva na zakrytie nevyváženej stopy.
- [x] Neodhadovať výsledný LUFS/true peak z parametrov. Po apply sa znovu renderuje a zobrazia sa skutočne zmerané metriky.
- [x] Zmena projektovej revízie alebo sample-bank revision počas renderu, preview či apply zneplatní výsledok; commit odmietne stale návrh.
- [x] Planner ostáva čistý, deterministický a bez sieťového/modelového runtime; jeho výpadok nezasahuje audio callback.
- [x] Mix repair je oddelený od mastering návrhu; UI upravuje len master inserts a nikdy automaticky nemení track FX.

**Stav:** UI a render workflow sú implementované. Akceptácia zostáva otvorená do existujúcich planner/UI/browser kontrol a manuálneho posluchu; doterajšie návrhové pravidlá treba ešte odborne overiť na žánrovo rôznych mixoch a skontrolovať ich malé bezpečné kroky.

**Akceptácia:** golden proposals viažu merací input na konkrétne návrhy; no-signal/stale/error casos odmietnu apply; každý apply vytvorí jeden undo krok; rejected návrh nemení `ProjectDocument`; počuteľné A/B preview zodpovedá presnému návrhu, ktorý sa commitne.

## Etapa 7 — delivery QA a export

**Výstup:** výsledný súbor, ktorý používateľ dostane, je ten istý súbor, ktorý mastering report skontroloval.

**Pravdepodobné súbory:** `src/ui/ExportPanel.tsx`, `src/rendering/renderer.ts`, `src/rendering/wav.ts`, `src/export/mp3.ts`, `src/export/scorepack.ts`, `src/mastering/profiles.ts`, export browser checks.

- [x] Oddeliť exportné nastavenia od analytického targetu; report sa zneplatní pri zmene bit depthu alebo kodeku. PCM/MP3 súbor má samostatný post-encode check.
- [x] WAV a MP3 výstup sa dekóduje a zmeria po kódovaní/kvantizácii, keď je v pamäťovom limite browsera. Nad limitom alebo pri nedostupnom decoderi sa zobrazí „not measured“ aj s dôvodom; report nevydáva pre-encode metriky za codec TP.
- [x] Audit bit-depth reduction: 16-bit WAV používa seeded TPDF dither; 24-bit integer WAV dither nepoužíva a aplikuje zdokumentovaný soft-knee; 32-bit float zachováva finite headroom bez ditheru/soft-knee. Sync a async 16-bit výstup majú deterministický byte-equality contract v existujúcich testoch.
- [x] WAV hlavička, channel count, sample rate, bit depth, BWF chunk a dĺžka sa kontrolujú pri exporte. BWF v2 loudness polia používajú Tech 3285 ×100 škálu a unavailable sentinel; export ich po zápise načíta a porovná s pred-encode PCM meraním.
- [x] Chromium E2E exportuje full-song 16/24-bit PCM a 32-bit float WAV; každý download overí voči reportovanému sample count, s BWF v2 read-back a post-encode dekódovaným meraním.
- [x] WAV parser odmietne skrátený RIFF aj poškodený data chunk ešte pred tým, než ich report môže prijať ako platný master.
- [x] Dynamický offline tail pokrýva reverb a delay aj vo finálnom MASTER insert racku; export tak neusekne efektové chvosty vložené na globálnom master bus-e (`tests/render-quality.test.ts`).
- [x] Pred vytvorením `OfflineAudioContext` renderer odhadne stereo Float32 výstup a odmietne odhad nad 320 MiB s konkrétnym dôvodom a návrhom skrátiť render alebo znížiť sample rate; neznámy/nekonečný odhad je fail-closed.
- [x] Chromium E2E zruší render fázu master exportu a overí stav `cancelled`, žiadny mastering report a žiadny download.
- [ ] Doplniť browser round-trip pre všetky depthy v ďalších podporovaných browseroch, abort v encode/decode fázach a browserovú kontrolu poškodeného outputu.
- [x] Export ponúka explicitné **Use profile file settings** pre známy formát/depth odporučený profilom. Zmena sa vykoná až kliknutím a nemení audio processing.
- [ ] Doplniť pre profily explicitné sample-rate a version-name odporúčania až po overení konkrétneho delivery briefu; UI ich nesmie hádať ani skryť ručné nastavenia.
- [x] Ponúknuť stiahnuteľný JSON sidecar: project/session revision, profil, pre/post-encode merania, formát, dátum, warningy a verziu KYX. Projektová revízia je výslovne označená ako platná iba v aktuálnej app session.
- [x] Report uvádza Studio HQ alebo LIVE kvalitu a zneplatní sa po zmene quality mode.
- [x] Zachovať abort semantiku: zrušený export prejde do samostatného stavu a progress/status označuje aktuálnu render/encode/measure fázu; akceptačné vektory pre abort ostávajú release gate.
- [x] Stemy sú oddelené od mastering reportu. Group aj per-track export zachová track/group a routované return processing, obíde globálny master chain a výsledok neoznačuje ako finálny master report.

**Akceptácia:** uložený finálny audio buffer/file je zdrojom post-encode reportu. Round-trip decode nameria očakávané sample rate, dĺžku, peak/loudness a metadata. Ak sa zmení bit depth, codec alebo quality mode, výsledok prejde novým meraním.

## Etapa 8 — mastering externého stereo súboru (oddelené rozhodnutie)

**Výstup:** používateľ môže pripraviť master z hotového stereo mixu bez plného multitrack projektu KYX.

- [ ] Pred implementáciou navrhnúť samostatný `MasteringSession`/document contract a workflow na otvorenie, uloženie, verziovanie a opätovný export zdrojového audio súboru.
- [ ] Overiť limity memory/IndexedDB, maximálnu dĺžku, kanály, sample rates, PCM/float, metadata, oversize/import failure a abort. Na dlhé súbory používať bounded chunking/streaming; nekopírovať celý súbor cez renderer bez limitov.
- [ ] Udržať source audio nedestruktívne a read-only. Všetky processing parametre ukladať ako session stav; vyrenderovaný master je nový súbor.
- [ ] Zdieľať `AudioEngine`/processor runtimes podľa ADR 0009 alebo zdokumentovať presnú hranicu, ak file mastering vyžaduje odlišný event driver.
- [ ] Pridať round-trip testy import → analyzovať → A/B → render → znovu importovať výsledný súbor a overiť report.
- [ ] Zvážiť ako follow-up k ADR 0014; táto fáza nerozširuje súčasné multitrack recording claims.

**Akceptácia:** veľký stereo mix sa dá bezpečne otvoriť bez preťaženia pamäte, spracovať a vyexportovať bez modifikácie source; testy pokryjú zrušenie, storage limit, poškodený header a re-import.

## Etapa 9 — release hardening a „professional“ gate

**Výstup:** zvukové, UI, persistence, export a manuálne QA dôkazy pre každú podporovanú cestu.

### Automatické gate-y

- [x] `npm run typecheck` — PASS, `tsc --noEmit` exit 0 (2026-10-06; re-run after master-insert tail correction).
- [x] Cielený masteringový/regresný balík: 21 Vitest súborov, 368/368 testov prešli vrátane master reťazca, delivery-contract asistenta, profilov, meteringu, tail výpočtu, render memory guardu, exportu/WAV, UI/MCP, auditov a A/B/reference session persistence. Planner testy potvrdzujú, že broad mix metriky samy nevyvolajú procesing a nameraný true-peak miss navrhne len bounded ceiling.
- [ ] Celý Vitest suite: pred doplnením session/reference testov skončil s 830/844 súbormi prešlými, 9 183 testami úspešnými, 19 zlyhanými a 122 preskočenými. Žiadny zlyhaný súbor nebol v masteringovom balíku; zvyšné zlyhania boli v AI/intent/symbolic/groove testoch a v MCP inventári/dokumentácii (MCP testy očakávajú 36 nástrojov, runtime hlási 37 vrátane `kyx_unsuno`). Následný rozšírený masteringový/regresný beh prešiel (349/349 v 20 súboroch). Plná release brána ostáva otvorená, kým sa celý suite nevyčistí.
- [x] Cielené `tests/kweighting.test.ts` vrátane štyroch syntetických EBU Tech 3342 LRA vektorov a testov stability opakovania aj fade-outu (26/26), a `tests/wav-bwf.test.ts` s encoder/parser read-back a corrupt-container kontrolou (11/11) prešli; sú započítané aj v balíku 174/174 vyššie.
- [x] `npm run drift:check`; ak sa zmení odvodený artefakt, blessovať podľa projektu a skontrolovať diff. Už predtým zmenené MCP mirrors boli korektne preskočené shared-tree guardrailom.
- [x] `npm run format:check` alebo najmenej format check zmenených súborov, ak existuje známy baseline drift.
- [ ] Uzavrieť release-wide `npm run test:browser`: najnovší beh **302/309**. Master chain/glue/limiter, master meter, master bounce a Match EQ testy prešli; zostávajúce audio artifact, live/offline, preset, PDC a app/plugin workflow zlyhania sú uvedené vyššie.
- [x] `npm run build` a fyzická kontrola bundle budgetu; mastering panel/analyzátor musí byť lazy-loaded, ak jeho veľkosť alebo dependency odôvodňuje separáciu. Build aj fyzické bundle limity prešli; `MasteringPanel` je samostatný lazy chunk.
- [ ] Dlhý audio soak: nulové non-finite samples, nulový neplánovaný tail cut, bounded heap growth a stabilná LUFS/true-peak integrácia v podporovanej dĺžke projektu.
- [ ] Pri DSP zmene: zlaté vektory, bypass transparency, parameter aliveness a parity testy pre každý nový/dotknutý processor.

### Manuálne posluchové gate-y

- [ ] WAV kontrola v mono, stereo, nízkej hlasitosti, slúchadlách, bežných reproduktoroch a aspoň jednom kontrolnom zariadení; zaznamenať tester, dátum, browser/OS a konfiguráciu.
- [ ] Porovnať RAW/master bypass, mastering A/B a referenciu s výstupmi dorovnanými na rovnakú hlasitosť.
- [ ] Poslúchať najtichšiu časť, najhlasnejší drop/transient, subbas, sykavé/high-frequency pasáže, prechody a koniec/tail.
- [ ] Overiť, že výstup netrpí clippingom, pumpingom, zbytočným stereo rozšírením, mono stratou ani masteringom skrytým pred používateľom.
- [ ] Ručne overiť aspoň jednu projektovú cestu pre každý dodávaný profil. Profily/požiadavky, ktoré neboli testované, označiť ako experimental/unsupported.
- [ ] Browser/devices claim musí zodpovedať skutočne overenému output path; nedeklarovať referenčný monitoring tam, kde browser OS mixer alebo zariadenie nebolo kontrolované.

### Definition of Done

Mastering upgrade je release-ready len vtedy, keď:

- MASTER pracovisko pokrýva analysis → edit → compare → export → post-encode verify bez skrytého automatického prepisu zvuku;
- UI, MCP a export používajú rovnaké profilové pravidlá, alebo rozdiel otvorene a testovateľne vysvetlia;
- človek vidí skutočnú signálovú cestu, vrátane bus inserts a globálneho master chainu;
- každý status rozlišuje measured/predicted/not measured/stale; finálny report pochádza z finálneho audio súboru;
- mastering snapshoty, zmeny, undo/redo, project migration, collab a export fungujú spoľahlivo;
- každý masteringový návrh je počuteľný v level-matched A/B, vysvetlený, odmietnuteľný a po apply vratný;
- všetky automatické, browserové a manuálne gate-y pre podporované profile/delivery cesty prešli;
- známe obmedzenia input/output device, browser, codec a platform profile sú priamo pomenované.

## Riziká a guardrails

| Riziko                                                  | Opatrenie                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Dvojité limitovanie (napr. group ZENIT + global master) | Zobraziť obe pozície v grafe, obe gain-reduction meter hodnoty a výsledný master true peak. Preset nesmie tajne zvyšovať výstup gain. |
| Cieľ LUFS sa považuje za automatickú normalizáciu       | Rozdeliť „check against target“ a potvrdenú loudness úpravu; po zmene vykonať nové meranie.                                           |
| Hlasnejšie A/B vyhrá                                    | Level-match iba cez dočasný posluchový trim; zobraziť rozdiel gainu a neukladať ho do signálovej cesty.                               |
| Report zastará po editácii                              | Naviazať report na render fingerprint a invalidovať ho pri každej relevantnej zmene dokumentu, banku, profilu alebo export módu.      |
| Všeobecné „streaming standard“ tvrdenie                 | Profily mať ako verziované ciele s pôvodom a dátumom kontroly; Custom zostáva dostupný.                                               |
| Meranie správneho signálu na nesprávnom bode            | Dokumentovať measurement tap a merať po poslednom processor/encode stupni podľa otázky reportu.                                       |
| Browserová prekážka pri externom masteringu             | V prvej verzii jasne obmedziť scope na render projektu; dlhý import súboru navrhovať samostatne s pamäťovým a I/O auditom.            |
| Nové mastering UI nafúkne startup bundle                | Nový panel/analyzátor lazy-loadovať, render worker oddeliť a merať produkčný bundle.                                                  |

## Odporúčané poradie implementačných PR/commits

Commitovať po dôkaznom celku; staging iba vlastných súborov v zdieľanom worktree.

1. `docs: lock mastering contract and baseline` — táto roadmapa + uzavretie ADR/product rozhodnutí.
2. `mastering: unify delivery profiles` — shared profile model, backward compatibility, MCP/UI parity.
3. `audio-engine: define master insert graph` — follow-up ADR, graph/model, live/offline/PDC parity.
4. `feat: add mastering workspace` — master surface a signal-flow UI.
5. `audio-engine: unify mastering render report` — full-song analysis, worker, vectors a stale/cancel contract.
6. `feat: add mastering snapshots and compare` — A/B, level match, reference monitor.
7. `feat: add evidence-based mastering assist` — rendered preview, explicit apply/undo.
8. `export: verify encoded mastering output` — post-encode QC, dither audit, report artifact.
9. `test: close mastering release gates` — browser, stress, manual listen a limitations.

Ak si súborové zmeny vyžadujú inú sériu, zachovať rovnaké závislosti a nekombinovať veľký architektúrny refactor s novým DSP bez samostatného dôvodu.
