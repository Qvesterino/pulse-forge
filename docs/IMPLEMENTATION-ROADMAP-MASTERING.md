# Pulse Forge — realizačný plán: mastering

> Stav plánu: návrh, 2026-10-06  
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

| Etapa | Výsledok | Závislosť | Priorita |
| --- | --- | --- | --- |
| 0. Rozhodnutia a baseline | Jasný produktový, audio a validačný kontrakt | — | P0 |
| 1. Jednotný profil doručenia | Rovnaké ciele a pravidlá v MIX, EXP a MCP | 0 | P0 |
| 2. Master bus a signálová cesta | Jednoznačný graf procesorov vrátane finálneho insert miesta | 0 | P0 |
| 3. Master pracovisko | Jedna používateľská cesta od analýzy po export | 1, 2 | P0 |
| 4. Merací a exportný report | Dôveryhodná analýza vyrenderovaného výstupu | 1, 2 | P0 |
| 5. Snapshoty, A/B a referencie | Bezpečné porovnávanie master verzií | 2, 3, 4 | P1 |
| 6. Masteringový asistent | Vysvetliteľné návrhy s preview, potvrdením a undo | 4, 5 | P1 |
| 7. Delivery QA | Kontrola skutočne zakódovaného súboru a exportné profily | 1, 4 | P1 |
| 8. Mastering externého stereo súboru | Samostatná práca so stereo mixom mimo projektu KYX | osobitný návrh | P2 |
| 9. Release hardening | Zvuková, browserová a používateľská dôkazná sada | 3–7 | P0 pred označením za hotové |

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

## Baseline: čo KYX už obsahuje

Táto časť je súpis aktuálneho základu, nie implementačný zoznam. Pred každou etapou ho znovu overiť proti HEAD.

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

- [ ] Zafixovať prvý rozsah: master výstup projektu KYX; externý stereo súbor je samostatný P2 workstream.
- [ ] Rozhodnúť, či finálny master bus dostane vlastný insert chain, alebo sa prvá verzia pracoviska mapuje iba na fixný master chain a existujúce group/track insert chainy.
- [ ] Ak sa pridá master insert chain, otvoriť follow-up ADR k ADR 0006/0009/0020: poradie voči returns, master safety, latency/PDC, live/offline sync, solo/stem správanie, bypass a migrácia.
- [ ] Definovať rozdiel medzi **delivery profile** (čo sa kontroluje), **processing preset** (ako sa tvaruje zvuk) a **loudness adjustment** (aké gain zmeny používateľ potvrdil).
- [ ] Určiť cieľové verzie platformových špecifikácií, ich vlastníka a postup periodickej revízie; všetky hodnoty označiť za orientačné alebo používateľsky upraviteľné, ak nie sú povinným technickým limitom.
- [ ] Zaznamenať baseline pre typy projektov, metering, offline renderer, export formáty, aktuálne warning thresholds, testy a známu odchýlku medzi LIVE a Studio HQ quality.
- [ ] Zaznamenať platformové obmedzenia monitoringu. Windows Electron je podľa aktuálneho kontraktu tenký Web Audio shell; profesionálny monitoringový claim čaká na zdokumentovaný a odmeraný výstupný device path.

**Akceptácia:** produktová a architektonická poznámka jasne odpovie, či používateľ masteruje projekt alebo ľubovoľný stereo súbor, kde v grafe leží masteringový rack a ktoré hodnoty sú ciele/verdict, nie automatické úpravy.

## Etapa 1 — jednotný profil doručenia

**Výstup:** jedna zdrojová pravda pre grafické rozhranie, export aj MCP.

**Pravdepodobné súbory:** `src/mcp/master-profiles.ts`, nové zdieľané `src/mastering/profiles.ts`, `src/project-model/types.ts`, `src/project-model/schema.ts`, `src/commands/commands.ts`, `src/ui/MasterMeter.tsx`, `src/ui/ExportPanel.tsx`, `src/mcp/tools.ts` a testy týchto oblastí.

- [ ] Presunúť alebo zdieľať profilovú definíciu tak, aby UI a `kyx_master` volali tie isté čisté pravidlá a mali identické verdict thresholds.
- [ ] Definovať profilový kontrakt minimálne s: ID/názvom, integrovaným LUFS cieľom, toleranciou, max true peak dBTP, pravidlami pre nemerateľný signál, mono/fázovými kontrolami, odporúčaním pre formát a jasným textom o zamýšľanom použití.
- [ ] Pridať používateľský **Custom** profil. Nesmie odstrániť možnosť nastaviť samostatne loudness target a ceiling.
- [ ] Oddeliť `Check against profile` od explicitného `Apply profile settings`. Výber profilu sám nemení masterGain, ceiling, limiter ani efekty.
- [ ] Rozhodnúť persisted semantiku: ak sa profil uloží v projekte, doplniť voliteľné pole `MasterConfig`, zvýšiť `SCHEMA_VERSION` a pridať migráciu cez `migrateProject`. Existujúce `lufsTarget` a `ceilingDb` zachovať bez prekvapivého prepisu; stará hodnota sa bezpečne premietne do Custom/legacy stavu.
- [ ] Zachovať profilové merania ako odvodený runtime/export report, nie ako údaj uložený v project documente.
- [ ] MCP `platform`, `land`, `trim` a `assist` majú používať zdieľaný profilový kontrakt; MCP read-back a UI verdict musia byť pri rovnakom reporte identické.
- [ ] Zjednotiť jednotky a popisy: sample peak dBFS, true peak dBTP, loudness LUFS/LU; nikde neskrývať rozdiel pod všeobecné „dB“.

**Akceptácia:** golden testy pre každý profil pokryjú hranice pass/warn/fail, nemerateľný materiál, true peak, mono/fázu a custom hodnoty. Pri tom istom `MasterMeasurement` musí UI aj MCP vrátiť rovnaký status, hodnoty a dôvody. Projekt vytvorený pred migráciou si ponechá doterajší zvuk aj cieľ merania.

## Etapa 2 — jednoznačný master bus a signálová cesta

**Výstup:** používateľ vidí a ovláda skutočný reťazec, ktorý spracúva finálny výstup.

**Pravdepodobné súbory:** `src/project-model/types.ts`, `schema.ts`, `src/audio-engine/masterChain.ts`, `AudioEngine.ts`, `src/effects/registry.ts`, `src/ui/EffectRack.tsx`, `src/ui/Mixer.tsx`, `src/rendering/renderer.ts`, commands a engine/render testy.

- [ ] Zvoliť kanonickú reprezentáciu master insertov. Odporúčaný cieľ: rovnaký `EffectRuntime`/`EffectDefinition` kontrakt ako pri trackoch, ale v explicitnom master slote project modelu.
- [ ] Zachovať oddelenie fixných safety/utility stupňov (napr. DC a ochrana stropu) od používateľsky vložených farebných/dynamických insertov; presné poradie musí byť viditeľné a zdokumentované.
- [ ] Rozhodnúť, či ZENIT dostane host pozíciu na master bus alebo zostane iba track/group device. Nevykresliť falošnú UI cestu, ktorá ovláda inú zbernicu, než používateľ počuje.
- [ ] Definovať master-insert správanie pre returns, group routovanie, solo, mute, export master, skupinové stemy a export všetkých trackov.
- [ ] Implementovať jednu signal-flow reprezentáciu, ktorú používajú graf, engine sync, offline render, metering a MCP. Žiadna paralelná ručne udržiavaná tabuľka poradia.
- [ ] Ošetriť bypass bez klikov, missing worklet/degraded stav, disposal, parameter automation a súčet `getLatencySec()` cez PDC.
- [ ] Pri novom persisted master racku zvýšiť `SCHEMA_VERSION`, doplniť migráciu cez `migrateProject`, normalize, command/undo/redo, collab/YDoc round-trip a import/export projektu.
- [ ] Zachovať nulové rozšírenie live graphu po otvorení exportného `OfflineAudioContext`; všetky uzly vznikajú cez `useContext(ctx)`.
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

- [ ] Pridať vstup do MASTER pracoviska z master metera a exportu. O vhodnosti samostatného dock tabu rozhodnúť na úzkom prototype; neskrývať ho za viacero vnorených panelov.
- [ ] Zobraziť názov projektu, SONG/PATTERN scope, dĺžku analyzovaného programu, profil, dátum/čerstvosť render reportu a jedinú primárnu akciu `Analyze full arrangement`.
- [ ] V hornej sumarizácii ukázať stav profilu, LUFS-I delta, max dBTP delta, mono/fázu a počet otvorených problémov. Každý status musí mať aj text, nie iba farbu.
- [ ] Zobraziť audio chain ako čitateľné bloky s aktívnym/bypass/degraded stavom a otváraním parametrov. Rozlíšiť BUS/STEM, MASTER INSERT a SAFETY; nepredstierať, že track insert je master insert.
- [ ] Zachovať rýchly prístup k MIX/DEV/EXP a existujúcim shortcutom; MASTER je workflow vrstva, nie skrytá náhrada mixeru.
- [ ] Ponúknuť jednoduchý pohľad s bezpečnými makrami a rozšírený pohľad na konkrétne zariadenia. Neprepisovať pokročilé DSP ovládače do druhého, odlišného state modelu.
- [ ] Pridať keyboard/focus flow, screen-reader názvy, resize/narrow viewport správanie a jasný návrat do arrangementu.
- [ ] Starý projekt bez mastery state otvorí MASTER bez migráciou vynútených zvukových zmien.

**Akceptácia:** používateľ dokáže z MASTER spustiť full-song analýzu, prečítať report, upraviť reálny procesor, znova zmerať a exportovať bez straty kontextu. UI testy pokryjú collapsed dock, úzku výšku, keyboard/focus, loading, cancel, error a stale-report stav.

## Etapa 4 — dôveryhodná analýza a report

**Výstup:** rovnaký finálny buffer vedie k rovnakému meraniu v playback verdict, offline exporte a mastering reporte.

**Pravdepodobné súbory:** `src/audio-engine/kweighting.ts`, `metering.ts`, `meteringRig.ts`, `artifactGate.ts`, `src/analysis/mixDoctor.ts`, nové `src/mastering/analysis.ts`/worker, `src/rendering/renderer.ts`, `ExportPanel.tsx` a meracie/browser testy.

- [ ] Vytvoriť jeden verzovaný typ `MasterRenderReport` s run ID, project revision/hash, profilom, sample rate, quality mode, scope SONG/PATTERN, rozsahom analyzovaných vzoriek a dôvodom zrušenia/neúplnosti.
- [ ] Prežiť celý finálny výstup cez offline renderer; meranie nesmie čítať iba aktuálny 30 Hz live UI snapshot a tvrdiť, že pokrýva celý track.
- [ ] Znovu použiť existujúce meracie primitívy. Zjednotiť integrovaný LUFS, sample peak, true peak, RMS/crest, koreláciu, mono loss, L/R imbalance, clipping a Mix Doctor pod report kontraktom.
- [ ] Preskúmať pridanú hodnotu a presnú definíciu Loudness Range (LRA), krátkodobej loudness timeline, DC offsetu a fade/tail detekcie. Pridať iba tie, ktoré majú referenčné vectors a zrozumiteľné použitie.
- [ ] Žiadne skryté “spectral balance pass” rozhodnutie bez jasného popisu proxy a neistoty; tonal curve je odporúčanie, nie štandardizovaný pass/fail.
- [ ] Oddeliť `pass / advisory / fail / not measured / stale / cancelled`. Ticho, úsek kratší než meracie minimum, mono zdroj a chýbajúci worklet nesmú skončiť ako falošné zelené OK.
- [ ] Report zneplatniť pri zmene audio parametra, routovania, sample banku, aranžmánu, profilu alebo export-quality režimu. Používateľ musí vidieť, kedy výsledky už nie sú aktuálne.
- [ ] Dlhšie analyzovanie držať mimo realtime audio callbacku; progress/cancel a validácia dát worker boundary podľa pracovného kontraktu.
- [ ] Neodovzdávať do workerov bez limitov celé neoverené reťazce a náhodné typed arrays. Udržať pamäťový rozpočet pre dlhé skladby.

**Akceptácia:**

- známe vektory pre K-weighting/LUFS vrátane existujúceho browser conformance testu dávajú očakávané výsledky v meracej tolerancii;
- true-peak testy zahŕňajú inter-sample peak, rôzne sample rate a strop testovaný po poslednom DSP stupni;
- mono, phase, silent, krátky, clipped a hot stereo case majú očakávané verdict triedy;
- ten istý vyrenderovaný PCM buffer dá zhodný report pre UI a MCP;
- cancel, worker failure a zmena projektu počas merania nemôžu aplikovať zastaraný výsledok.

## Etapa 5 — bezpečné verzie, A/B a referencie

**Výstup:** master rozhodnutia sú porovnateľné bez hlasitostnej ilúzie a bez straty pôvodného stavu.

**Pravdepodobné súbory:** `MasterConfig`/schema/commands, nový MasteringPanel, `AudioEngine.ts`, `renderProject()`, export a master session testy.

- [ ] Pridať A/B snapshoty pre celý master setup: profile selection, master config a všetky master inserts; jasne oddeliť snapshot od obyčajného undo stacku.
- [ ] Rozhodnúť, či snapshoty patria do project documentu alebo lokálnej mastering session. Ak sú project-persisted, migrovať, normalizovať a testovať collab/import/export.
- [ ] Implementovať presný, neklikajúci Master Bypass, ktorý bypassuje iba deklarovaný mastering chain. Track mix, routing, instrument a tvorivé track FX musia ostať rovnaké.
- [ ] A/B porovnávať na rovnakom rendered programe, rovnakom sample rate/quality a s voliteľným výstupným gain matchom. Gain match nesmie meniť uložené audio parametre.
- [ ] Pridať referenčný stereo audio vstup pre monitoring: validovaný decode, trvanie/peak/LUFS, local-first persistence, explicitný route mimo master processing a rýchly level-matched A/B. Reference audio sa nesmie omylom vyexportovať spolu s masterom.
- [ ] Zachovať original/reference súbor read-only. Potvrdenie použitia reference alebo tonal matching zmeny musí byť samostatné.
- [ ] Pre reference comparison pridať synchronizované transport/toggle, mono a dim/level controls; testovať keyboard a audio context state.
- [ ] Blind A/B je neskorší voliteľný režim; nesmie byť release podmienkou pre prvú workspace iteráciu.

**Akceptácia:** A/B renderuje ten istý program bez driftu, rozdiel output trimu je viditeľný, zmeny neprepíšu snapshot a Undo nezmieša snapshot s audio render cache. Referencia sa neobjaví v master/stem exportoch a pri vypnutí reference sa nič nestratí.

## Etapa 6 — vysvetliteľný masteringový asistent

**Výstup:** používateľ dostáva malý počet overiteľných návrhov, nie „AI mastered“ štítok.

**Pravdepodobné súbory:** `src/mcp/master-assistant.ts`, shared mastering planner, `src/ui/MasteringPanel.tsx`, commands, `src/analysis/mixDoctor.ts` a návrhové/preview testy.

- [ ] Zdieľať čisté deterministické plánovanie s MCP. MCP a UI nesmú obsahovať dve verzie limitov alebo parametre, ktoré sa rozchádzajú.
- [ ] Každá karta návrhu ukáže merací dôkaz, dôvod, zariadenie/parameter, starú a novú hodnotu, predpokladaný trade-off a istotu/obmedzenie pravidla.
- [ ] Preview vyrenderovať na draft dokumente mimo projektu a prehrať ho vedľa originálu pri loudness match. Žiadny návrh sa neuplatní pri samotnej analýze.
- [ ] Poskytnúť **Apply selected**, **Apply all** len pre navzájom konzistentný plán, **Dismiss** a **Reset to snapshot**. Apply je jedna pomenovaná undoable zmena; dismiss je bez zmeny dokumentu.
- [ ] Pre clipping, fázu, low end, harshness, crest/loudness a šírku riešiť najprv najmenšiu bezpečnú zmenu. Nepoužívať master gain na zakrytie nevyváženej stopy.
- [ ] Neodhadovať výsledný LUFS/true peak z parametrov. Po aplikácii znovu renderovať a uviesť skutočne zmeraný výsledok.
- [ ] Ak sa dokument alebo bank zmení počas analýzy/preview, výsledok označiť stale a odmietnuť commit bez opakovania.
- [ ] Zachovať deterministic fallback; žiadny model/tool failure nesmie zablokovať UI alebo audio callback.
- [ ] Oddeliť mix repair (opraviť mix na stope/buse) od mastering návrhu (finálny stereo výstup). UI nesmie potichu prepísať track FX ako „master adjustment“.

**Akceptácia:** golden proposals viažu merací input na konkrétne návrhy; no-signal/stale/error casos odmietnu apply; každý apply vytvorí jeden undo krok; rejected návrh nemení `ProjectDocument`; počuteľné A/B preview zodpovedá presnému návrhu, ktorý sa commitne.

## Etapa 7 — delivery QA a export

**Výstup:** výsledný súbor, ktorý používateľ dostane, je ten istý súbor, ktorý mastering report skontroloval.

**Pravdepodobné súbory:** `src/ui/ExportPanel.tsx`, `src/rendering/renderer.ts`, `src/rendering/wav.ts`, `src/export/mp3.ts`, `src/export/scorepack.ts`, `src/mastering/profiles.ts`, export browser checks.

- [ ] Oddeliť exportné nastavenia od analytického targetu, ale prepojiť ich cez čitateľné upozornenia. 32-bit float môže zachovať headroom; PCM/MP3 output sa posudzuje až po encode.
- [ ] Zmerať finálne zakódované WAV dáta po quantization. Pri MP3 navyše znovu dekódovať zakódovaný súbor a zmerať true peak/loudness po kodeku; ak decoder nie je dostupný, poctivo označiť stav „codec TP not measured“.
- [ ] Urobiť audit dither/bit-depth reduction. Ak sa pridá TPDF dither, musí byť zapínateľný/zdokumentovaný podľa export formátu, deterministický v testoch cez seed alebo mať jasne definovaný test contract; 32-bit float sa neditheruje bez explicitného dôvodu.
- [ ] Skontrolovať WAV hlavičky, channel count, sample rate, bit depth, BWF metadata, dĺžku a tail. Všetko pinovať tests pre 16/24/32-bit a abort/chybný output.
- [ ] Exportné profily môžu predvyplniť WAV rate/depth a názov verzie, nesmú však skryť ručné nastavenia ani meniť audio bez potvrdenia.
- [ ] Pridať možnosť exportovať stručný JSON alebo text report vedľa mastera: project/render fingerprint, profil, meranie pre-encode aj post-encode, export formát, dátum, warningy a verziu nástrojov.
- [ ] V prípade odlišnosti Studio HQ a LIVE kvality ukázať konkrétne nastavenie a zneplatniť report po zmene quality mode.
- [ ] Zachovať abort semantiku: zrušený export nesmie vyzerať ako hotový master; progress ukazuje aktuálnu render/encode/measure fázu.
- [ ] Stemy ostávajú samostatnou diagnostickou/exportnou funkciou; master report sa nesmie prezentovať ako meranie každého stema, ak ho neanalyzoval.

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

- [ ] `npm run typecheck`.
- [ ] Relevantné Vitest suites: schema/migration, commands/undo, collab delta, master signal graph, profile verdict, metering conformance, artifact gate, audio worker, export/WAV/MP3, UI a MCP equality.
- [ ] `npm run drift:check`; ak sa zmení odvodený artefakt, blessovať podľa projektu a skontrolovať diff.
- [ ] `npm run format:check` alebo najmenej format check zmenených súborov, ak existuje známy baseline drift.
- [ ] `npm run test:browser` s master meter, mono fold-down, true-peak case a kompletným offline master exportom.
- [ ] `npm run build` a fyzická kontrola bundle budgetu; mastering panel/analyzátor musí byť lazy-loaded, ak jeho veľkosť alebo dependency odôvodňuje separáciu.
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

| Riziko | Opatrenie |
| --- | --- |
| Dvojité limitovanie (napr. group ZENIT + global master) | Zobraziť obe pozície v grafe, obe gain-reduction meter hodnoty a výsledný master true peak. Preset nesmie tajne zvyšovať výstup gain. |
| Cieľ LUFS sa považuje za automatickú normalizáciu | Rozdeliť „check against target“ a potvrdenú loudness úpravu; po zmene vykonať nové meranie. |
| Hlasnejšie A/B vyhrá | Level-match iba cez dočasný posluchový trim; zobraziť rozdiel gainu a neukladať ho do signálovej cesty. |
| Report zastará po editácii | Naviazať report na render fingerprint a invalidovať ho pri každej relevantnej zmene dokumentu, banku, profilu alebo export módu. |
| Všeobecné „streaming standard“ tvrdenie | Profily mať ako verziované ciele s pôvodom a dátumom kontroly; Custom zostáva dostupný. |
| Meranie správneho signálu na nesprávnom bode | Dokumentovať measurement tap a merať po poslednom processor/encode stupni podľa otázky reportu. |
| Browserová prekážka pri externom masteringu | V prvej verzii jasne obmedziť scope na render projektu; dlhý import súboru navrhovať samostatne s pamäťovým a I/O auditom. |
| Nové mastering UI nafúkne startup bundle | Nový panel/analyzátor lazy-loadovať, render worker oddeliť a merať produkčný bundle. |

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

