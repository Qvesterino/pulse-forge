# Pulse Forge — realizačný plán: mastering

> Stav plánu: priebežne aktualizovaná implementácia, 2026-10-07
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

Projektový master zostáva hlavným masteringovým workflow. Oddelená P2 cesta teraz umožňuje otvoriť WAV/MP3 mixdown v samostatnej lokálnej relácii; používa spoločný `AudioEngine` a `renderProject()`, no zatiaľ má prísny pamäťový strop a nepodporuje streamovanie ľubovoľne dlhých súborov. Súčasné sample workflow nie je zmluvou pre neobmedzené stereo mixy.

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
- `MasterConfig` ukladá profil, samostatný dBTP cieľ a globálny zoznam insertov. Schéma je v12; staršie LUFS ciele a limiter ceiling sa pri migrácii zachovávajú. Cielený kontrakt migrácie starého projektu bez master configu overuje aj zhodu s predvoleným runtime nastavením (`tests/schema-migration.test.ts`).
- Globálny insert rack je pred vstavaným clipperom a limiterom a spracúva finálny súčet. Master/stem bypass ostáva pre-master cestou. Insert parametre používajú existujúce efektové príkazy a runtime.
- Horný MASTER prehľad sústreďuje čerstvosť reportu, profil, scope, LUFS-I/dBTP odchýlky, stereo kontrolu a nálezy na kontrolu. SONG/PATTERN, sample rate aj Live/Studio HQ voľba a primárne Analyze tlačidlo sú dostupné pred živým metrom; nižšie ostávajú formát, bit depth a samotné doručenie.
- Nový dock panel MASTER (Alt+9) spája živý meter, stavový prehľad presného master chainu, spoločné Core master controls, master insert rack a offline analýzu/export. Rovnaký project-backed komponent ovláda vstavané stupne z MIX aj MASTER; explicitný prepínač sprístupňuje M/S gain ovládače. Report V8 oddeľuje PCM pred enkódovaním od finálneho WAV/MP3, pomenúva hlavný tap `master-output` (po limiteri, pred enkódovaním), nesie revíziu sample banku a uloží zdieľaný profilový verdict pre presne nameraný PCM. Doplnková LRA používa 3 s K-weighted okná, 10 Hz krok, EBU Tech 3342 gating a percentily; krátkodobá timeline zobrazuje min/mean/max priebeh v najviac 1 200 bodoch. Syntetické EBU Tech 3342 minimálne testy 1–4 prešli v tolerancii ±1 LU; autentické programové prípady 5–6 zostávajú otvorené. Dlhé pre-encode a post-decode analýzy bežia v zrušiteľnom module workeri. Worker v jednom priechode spracúva mono/stereo PCM po chunk-och s maximálne 0,5 MiB na kanál, validuje rozmery aj poradie a nedrží druhú celú kópiu audia. Vstupný render je obmedzený na 12 hodín materiálu; nejde o garanciu wall-clock času analýzy. Ešte treba overiť správanie pri tomto limite v browseroch s menšou dostupnou pamäťou. Export skontroluje kontajner, WAV hlavičku/BWF a MP3 frame metadáta. WAV nad 96 MiB sa analyzuje inkrementálne priamo z PCM dát v analytickom workeri bez ďalšej celej Float32 kópie; menšie WAV a MP3 do 12 MiB používajú browser decoder. MP3 nad 12 MiB sa po blokoch dekóduje a analyzuje cez voliteľný WebCodecs worker, ak prehliadač potvrdí podporu MP3; inak report výslovne uvedie „audio not measured“ aj dôvod a nechá dĺžku označenú ako odhad.
- `kyx_master` read-back používa ten istý uložený globálny master flow ako UI, doplní runtime fallbacky a živé úrovne výslovne označí ako snapshot, nie ako report celej skladby. ZENIT ovládanie zostáva samostatne pomenované ako track/group procesor.
- Master A/B ukladá úplný master config do lokálnej browser session, renderuje oba snapshoty pri rovnakej SONG/Studio HQ konfigurácii a ponúka preview-only loudness match. Live monitor bypass má plynulý prechod medzi suchou a master vetvou, ktoré sa stretávajú pred spoločným limiter stupňom. Referenčný WAV/MP3 vstup je lokálny a read-only; import a porovnanie nemenia projekt.

- MASTER ponúka jednoduchý a rozšírený pohľad bez druhého state modelu: jednoduchý ukazuje IN, TRIM, CEIL a LIMIT; rozšírený sprístupní vstavané spracovanie a master inserts. Skryté procesory ostávajú aktívne a signal-flow navigácia otvorí rozšírené ovládače pred presunom fokusu.

### Otvorené P0 brány

- Pred externým file-session UI build prešiel 2026-10-07 s fyzickým bundle budgetom: shipped JS 6 037 KB, DAW JS 4 517/5 000 KB, on-demand runtimes 640/650 KB, kodeky 166/170 KB, audio tool 713/750 KB, HUD 1 078/1 600 KB a worklety 142/150 KB. Následný build po pridaní file session aj po doplnení delivery verdictu prešiel: shipped JS **6 063 KB**, DAW JS **4 544/5 000 KB**, on-demand runtimes 640/650 KB, kodeky 166/170 KB, audio tool 713/750 KB, HUD 1 078/1 600 KB a worklety 142/150 KB. Po session insert racku, A/B, referencii a export oprave prešiel nový build: shipped JS **6 083 KB**, DAW JS **4 564/5 000 KB**, on-demand runtimes 640/650 KB, kodeky 166/170 KB, audio tool 713/750 KB, HUD 1 078/1 600 KB a worklety 142/150 KB. Vite stále hlási existujúce chunk/dynamic-import upozornenia. `npm run drift:check` prešiel po session/reference zmenách. Počet test súborov v `docs/CURRENT-STATE.md` pri tejto kontrole sedel na 846. Nový Chromium scenár overil session-local referenciu a audition; session insert/A-B a WAV export/reimport scenáre tiež prešli.
- `npm run typecheck` prešiel 2026-10-07 po zosúladení `YDocStore.beginUndoFrame()` s kontraktom crossfade store.
- Dva posledné široké behy `npm run test:browser` skončili **303/309** a **302/309**. Master chain, glue, limiter, meter, bounce, Match EQ a PDC export alignment prešli; gate a suchá stopa boli v oboch behoch po `prepareOfflineRender()` zarovnané na rovnakú vzorku. Zostávajúce všeobecné zlyhania sa medzi behmi menili: preset audibility, live↔offline null, round-robin variácie, click/tail artifact gate, občasné audio-clock cadence, app boot s `ERR_CONNECTION_REFUSED` a plugin workflow timeout. Celý Vitest suite, masteringový dlhý audio soak, ďalšie browsery, poškodený output a manuálny posluch takisto ostávajú otvorené.
- Post-encode merania, WAV/MP3 kontajnerové údaje a stiahnuteľný JSON sidecar patria do reportu. WAV nad 96 MiB sa meria po blokoch z hotových PCM bajtov cez rovnaký analyzer worker; menší WAV a MP3 do 12 MiB používajú browser decoder. MP3 nad 12 MiB sa posiela do WebCodecs workeru, ktorý po blokoch číta MPEG snímky, dekóduje ich a posiela PCM priamo do kanonického analyzéra; ak Worker alebo MP3 kodek chýba, report zostáva header-only `not measured`. `tests/wav-bwf.test.ts` overuje PCM round-trip pre 16/24/32-bit, BWF data offset, kanonický WAV analyzer cez Worker harness a explicitný MP3 fallback pri nepodporovanom WebCodecs (**15/15**); exportné MP3 testy prešli **7/7**. Chromium E2E prešlo na platnom 4 s LAME MP3 s 12 MiB ID3 paddingom: súbor presiahol limit, skutočný WebCodecs Worker vrátil `measured`, a test zrušil následné dekódovanie cez `AbortSignal`. Ďalšie Chromium scenáre odmietli poškodený MPEG header a potvrdili používateľské zrušenie počas WAV encode aj post-encode decode bez reportu či downloadu. Nový Chromium E2E vytvoril platný **96 MiB + 48 B PCM WAV**, zmeral ho cez skutočný analysis worker po viac než 100 chunkoch bez odovzdania takého bufferu browser decoderu a úspešne zrušil druhý priechod počas chunkovania. Pri dlhom reporte test odhalil zaokrúhľovací prípad, ktorý porušoval `low ≤ mean ≤ high` v zhrnutých loudness bodoch; mean sa teraz ohraničí nameraným minimom a maximom a `tests/kweighting.test.ts` túto vlastnosť regresne kontroluje. `tests/export-verification.test.ts` prešiel 8/8 a potvrdil, že abort počas encode yield nepridá ďalší 65 536-frame blok. Zostávajú dlhý MP3 a heap soak a ďalšie browsery.
- Master A/B, referenčné porovnávanie, vysvetliteľný asistent a obmedzený file-mastering workflow sú implementované v pracovnom strome, no akceptačné kontroly etáp 5–9 ostávajú otvorené. File session používa lokálne uložený originál, oddelený processing config, session undo/redo, plný projektový master insert editor v izolovanej `ProjectStore` a renderer. Session A/B ukladá pomenované snapshoty A/B celého `MasterConfig`, oba rendery používa rovnaký zdroj aj nastavenia renderu a pri posluchu ponúka iba dočasné dorovnanie hlasitosti. Session-local referencia má vlastný IndexedDB store, hash a read-only WAV/MP3 audition voči vyrenderenému masteru. Chromium E2E pokrýva externé insert Apply/Undo/Redo, izoláciu od projektu, referenčný posluch, uloženie A/B a porovnávací posluch; druhý scenár overuje exportovaný 24-bit WAV po dekódovaní a opätovnom importe. Pätnásť nových Chromium scenárov overilo Cancel počas source/reference Blob read, SHA-256, decode a worker analýzy, cooperative PCM auditu, session restore/retry, source/reference quota chýb, databázového permission zlyhania, poškodeného WAV headeru a externého renderu, A/B renderu aj WAV encode/post-encode kontroly bez čiastočných výsledkov alebo downloadu. Zostávajú streamovanie dlhých súborov, ďalšie storage/browser zlyhania, browser/OS soak a manuálny posluch.

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
- [ ] Určiť vlastníka a postup periodickej revízie cieľových špecifikácií. Spotify mastering guide bol skontrolovaný 2026-10-07; zdroj a dátum kontroly sa zobrazujú pri Streaming profile. Profil uvádza podmienené −2 dBTP odporúčanie; ostatné profily sú workflow východiská, kým nebudú overené konkrétne briefy.
- [x] Zaznamenať implementačný baseline rozsahu, meteringu, offline rendereru, formátov a delivery thresholdov nižšie. Ide o stav po prvej integrácii; reprodukovateľný zvukový baseline pred týmito zmenami sa spätne nedá obnoviť.
- [ ] Zaznamenať platformové obmedzenia monitoringu. Windows Electron je podľa aktuálneho kontraktu tenký Web Audio shell; profesionálny monitoringový claim čaká na zdokumentovaný a odmeraný výstupný device path.

### Implementačný baseline po prvej integrácii — 2026-10-06

| Oblasť             | Aktuálny kontrakt                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rozsah analýzy     | `SONG` vyrenderuje aranžmán; `PATTERN` vyrenderuje jeden priechod aktívnym patternom. Obe cesty používajú `renderProject()` a zdieľaný `AudioEngine`.                                                                                                                                                  |
| Offline render     | Pred alokáciou stereo Float32 bufferu sa odhad kontroluje voči 320 MiB; pri 48 kHz je to približne 14,6 min programu bez započítania ďalšej spotreby browsera.                                                                                                                                         |
| Export             | 44,1/48 kHz; WAV 16-bit PCM, 24-bit PCM alebo 32-bit float; MP3 192/320 kbps. Po exporte sa malé súbory dekódujú v browseri; WAV nad 96 MiB sa analyzuje inkrementálne z PCM v workeri; MP3 nad 12 MiB používa voliteľný WebCodecs MP3 worker a pri nepodporovanom dekóderi ostáva `not measured`.     |
| Delivery defaulty  | Streaming −14 LUFS / −1 dBTP; Quieter/Dynamic −16/−1; Club/Loud −8/−0,3; Vinyl pre-master −12/−2. Sú to orientačné workflow ciele, okrem samostatne pomenovaných platformových advisory nejde o distribučné špecifikácie.                                                                              |
| Verdict tolerancie | Hlasitosť: do ±1 LU `pass`, do ±2 LU `warn`, ďalej `fail`. True peak: do 0,3 dB nad cieľom `warn`, väčšie prekročenie `fail`. Záporná korelácia `fail`, mono loss pod −3 dB a L/R rozdiel nad 6 dB sú kontrolné upozornenia.                                                                           |
| LIVE vs Studio HQ  | Obe kvality používajú ten istý renderer. Studio HQ nastaví aktívny PRISM na 8× oversampling a predvolený VØID na render tier aj v track/group, return a master insert owneroch; explicitná VØID voľba sa rešpektuje. LIVE ponechá uložené nastavenia efektov. Zmeny sú render-only a nemenia dokument. |
| Dôkazový stav      | Mastering E2E: Chromium 6/6. Posledný plný Vitest: 831/845 súborov, 9 193 pass, 19 fail, 122 skip. Široký browser audio beh: 302/309; release-wide zlyhania sú v Etape 9.                                                                                                                              |

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
- [x] Exportný stav má samostatné screen-reader oznámenie; dlhý priebeh sa oznamuje po 10 % krokoch, stale výsledok sa pripomenie a chyba má alert úroveň. Všeobecná `.sr-only` utilita je definovaná v base štýloch. Manuálny Narrator/VoiceOver smoke test ostáva otvorený.
- [ ] Dokončiť manuálny screen-reader smoke test a skontrolovať všetky oznamované statusy v MASTER pre Narrator/VoiceOver.
- [x] Starý projekt bez master state sa doplní presne na `defaultMasterConfig()`, teda na tie isté hodnoty, ktoré používa `MasterChain.build()` ako fallback pred materializáciou poľa; regresný test to pripína v `tests/schema-migration.test.ts`.

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
- [x] Spektrálny podiel je diagnostický proxy, nie delivery pass/fail: Mix Doctor ho pomenúva ako „harshness risk“, asistent ukazuje nízku istotu a pri explicitnom delivery contracte testy potvrdzujú, že vysoký/nízky HF share sám nevytvorí processing návrh (`tests/master-assistant.test.ts`). Tonalitu treba posúdiť posluchom; nejde o štandardizovaný cieľ.
- [x] Oddeliť `pass / advisory / fail / not measured` v profilovom verdicte (`warn` znamená advisory) a `stale / cancelled` v stave pracoviska. Ticho, krátky render a mono zdroj vracajú `not-measured` pre kontroly, ktoré si vyžadujú merateľný program alebo stereo signál; problém true peak/fázy môže stále viesť k fail.
- [x] Report zneplatniť pri zmene projektu, sample-bank revision, scope, sample rate, profile alebo export-quality režimu; panel dostáva revision notifikáciu okamžite a ak sa banka zmení priamo počas renderu, render sa zahodí.
- [x] Dlhšie analyzovanie držať mimo realtime audio callbacku; progress/cancel zastaví worker a zmena projektu alebo sample banku zahodí zastarané výsledky.
- [x] Masteringové render vstupy (analyze/export, A/B, reference a assistant) čakajú na dokončenie boot-time curated/user-sample hydratácie; používateľ môže čakanie zrušiť. Zdrojová bank revision sa zachytí až po hydratácii, takže prvá analýza nepomieša staré a nové assety.
- [x] PCM worker boundary validuje sample rate, profil, kanály, rozmery a poradie chunkov. Jedno-priechodová analýza udržiava iba stav filtrov, 16-sample true-peak históriu a K-weighted subblock powers; nevytvára druhú plnú PCM kópiu.
- [x] Prenos mono/stereo PCM prebieha po frame chunk-och s limitom 131 072 vzoriek na kanál (0,5 MiB/kanál); vstupný render má 12-hodinový limit dĺžky a neodpovedajúci worker sa po 3 minútach bez platnej odpovede ukončí.
- [ ] Overiť rozsiahle vektory, viac-hodinovú analýzu, worker abort počas spracovania chunku a správanie watchdogu v podporovaných browseroch.

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
- [x] A/B vyrenderovať ako SONG pri rovnakom sample rate a Studio HQ kvalite. Voliteľný LUFS-I match používa len audition gain a hlasnejšiu verziu iba stíši; merania aj project config ostávajú bez zmeny. Zmena projektu, snapshotu, sample rate alebo sample banku okamžite zneplatní porovnanie a zastaví jeho preview.
- [x] Pridať referenčný audio vstup pre monitoring: pred dekódovaním skontrolovať WAV/MP3 kontajner, po dekódovaní zmerať trvanie/kanály/sample rate/peak/LUFS, uložiť originálne bajty do samostatnej lokálnej IndexedDB a porovnať s plným current-master renderom cez priamy monitor route. Referencia sa do projektu ani exportu nezapája.
- [x] Zachovať originálny WAV/MP3 read-only. Nahradenie a odstránenie referencie sú explicitné úkony; import nemení masteringové ani tonálne parametre projektu.
- [x] Pridať spoločné hlasitostné dorovnanie, mono audition, dim a samostatné štartovacie body projektu/referencie. Prepínanie strán začína od zvolených bodov a ovládanie je dostupné štandardnou klávesnicovou navigáciou.
- [x] Voliteľný **Blind listen** náhodne zamieša označenie A/B na Version 1/2, skryje snapshot metadata, metriky a súvisiace assistant/reference/bypass ovládanie, uzamkne sample rate a matching, umožní zvoliť preferenciu a odhalí mapovanie až na vyžiadanie. Výsledok ani preferencia sa neukladajú do projektu; ide o pomôcku pre vlastný posluch, nie kontrolovaný študijný protokol.

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
- [x] Veľký WAV nad 96 MiB analyzovať z PCM blokov bez `decodeAudioData()` a bez alokácie celej druhej Float32 PCM kópie. Využiť rovnaký kanonický worker analyzer a označiť spôsob dekódovania v reporte; abort ostáva cez worker terminate.
- [x] Veľké MP3 nad 12 MiB čítať a dekódovať po MPEG snímkach vo WebCodecs workeri; pri nedostupnej podpore MP3 vykázať `not measured` s konkrétnym dôvodom. Chromium E2E cez `tests/e2e/17-mastering-workspace.spec.ts` overil skutočné meranie LAME MP3 >12 MiB v workeri; dlhý audio a heap soak zostávajú samostatnou bránou.
- [x] Audit bit-depth reduction: 16-bit WAV používa seeded TPDF dither; generické exporty zachovávajú zdokumentovaný soft-knee. Projektový a externý mastering export pre integer PCM/MP3 používa `integerOverflowPolicy: reject`: pri sample peaku nad 0 dBFS odmietne doručenie, obíde skryté soft-knee a odporučí úpravu gainu alebo 32-bit-float WAV. 32-bit float zachováva finite headroom bez ditheru/soft-knee. Sync a async 16-bit výstup majú deterministický byte-equality contract v existujúcich testoch.
- [x] WAV hlavička, channel count, sample rate, bit depth, BWF chunk a dĺžka sa kontrolujú pri exporte. BWF v2 loudness polia používajú Tech 3285 ×100 škálu a unavailable sentinel; export ich po zápise načíta a porovná s pred-encode PCM meraním.
- [x] Chromium E2E exportuje full-song 16/24-bit PCM a 32-bit float WAV; každý download overí voči reportovanému sample count, s BWF v2 read-back a post-encode dekódovaným meraním.
- [x] WAV parser odmietne skrátený RIFF aj poškodený data chunk ešte pred tým, než ich report môže prijať ako platný master.
- [x] Dynamický offline tail pokrýva reverb a delay aj vo finálnom MASTER insert racku; export tak neusekne efektové chvosty vložené na globálnom master bus-e (`tests/render-quality.test.ts`).
- [x] Pred vytvorením `OfflineAudioContext` renderer odhadne stereo Float32 výstup a odmietne odhad nad 320 MiB s konkrétnym dôvodom a návrhom skrátiť render alebo znížiť sample rate; neznámy/nekonečný odhad je fail-closed. MASTER pracovisko tento istý odhad ukáže ešte pred akciou a pri prekročení limitu zablokuje Analyze aj Export.
- [x] Chromium E2E zruší render fázu master exportu a overí stav `cancelled`, žiadny mastering report a žiadny download.
- [x] Post-encode inspection prestane čakať hneď po AbortSignal aj počas Blob read alebo `decodeAudioData()`; neskorý výsledok sa zahodí a chybu dekódera nezamení za cancel. Samotný browserový decode je neodvolateľný, preto sa iba opustí jeho výsledok a uvoľní referencie, keď dobehne. WAV encoder rovnako okamžite ruší svoj yield a nezačne ďalší blok po cancel.
- [x] Chromium E2E pokrýva veľký validný MP3 v reálnom WebCodecs workeri, AbortSignal počas decode a odmietnutie poškodeného MP3 outputu (`tests/e2e/17-mastering-workspace.spec.ts`).
- [ ] Doplniť WAV round-trip pre všetky depthy v ďalších podporovaných browseroch; Chromium už má UI dôkazy zrušenia počas WAV encode/decode a interné AbortSignal pokrytie.
- [x] Používateľská príručka vysvetľuje meranie veľkých MP3, poctivý fallback `NOT MEASURED` a zrušenie počas exportu (`docs/MASTERING.md`).
- [x] Export ponúka explicitné **Use profile file settings** pre známy formát/depth odporučený profilom. Zmena sa vykoná až kliknutím a nemení audio processing.
- [x] MASTER predvolí WAV bit depth podľa aktívneho delivery profilu (alebo 24-bit PCM, keď profil formát neurčuje); EXP si drží samostatné 16-bit predvolenie a ručné voľby v režimoch sa navzájom neprepisujú.
- [x] MASTER má voliteľné pole VERSION; bezpečne normalizovaný suffix sa pridá k WAV/MP3 aj zodpovedajúcemu JSON sidecaru. Prázdne pole ponechá doterajšie názvy a dokončovací status vypíše skutočný názov súboru.
- [x] Mastering integer delivery odmietne sample peak nad 0 dBFS: WAV 16/24-bit a MP3 používajú explicitnú reject overflow policy bez skrytého soft clipu, zobrazia odporúčaný ďalší krok a ponechajú aktuálny pre-encode report na kontrolu. 32-bit-float WAV zachováva over-range rezervu; štandardný EXP si zatiaľ ponecháva existujúcu quantization policy.
- [ ] Doplniť pre profily explicitné sample-rate a version-name odporúčania až po overení konkrétneho delivery briefu; UI ich nesmie hádať ani skryť ručné nastavenia.
- [x] Ponúknuť stiahnuteľný JSON sidecar: project/session revision, profil, pre/post-encode merania, formát, dátum, warningy a verziu KYX. Projektová revízia je výslovne označená ako platná iba v aktuálnej app session.
- [x] Report uvádza Studio HQ alebo LIVE kvalitu a zneplatní sa po zmene quality mode.
- [x] Zachovať abort semantiku: zrušený export prejde do samostatného stavu a progress/status označuje aktuálnu render/encode/measure fázu; akceptačné vektory pre abort ostávajú release gate.
- [x] Stemy sú oddelené od mastering reportu. Group aj per-track export zachová track/group a routované return processing, obíde globálny master chain a výsledok neoznačuje ako finálny master report.

**Akceptácia:** uložený finálny audio buffer/file je zdrojom post-encode reportu. Round-trip decode nameria očakávané sample rate, dĺžku, peak/loudness a metadata. Ak sa zmení bit depth, codec alebo quality mode, výsledok prejde novým meraním.

## Etapa 8 — mastering externého stereo súboru (oddelené rozhodnutie)

**Výstup:** používateľ môže pripraviť master z hotového stereo mixu bez plného multitrack projektu KYX.

- [x] Navrhnúť samostatnú lokálnu session hranicu a runtime/render kontrakt v [ADR 0022](adr/0022-external-mastering-sessions.md). Relácia drží zdrojový Blob mimo project documentu, má verziované metadáta a obmedzenú undo/redo históriu processing configu.
- [x] Prvá verzia odmieta súbory nad 96 MiB, podporuje WAV/MP3, mono/stereo, 8–192 kHz a 0,8 s–12 min; dekódovanie beží na 44,1 kHz a render na 44,1/48 kHz. Vstupný sample buffer má strop 128 MiB a render preflight odmietne odhadovaný pracovný set nad 512 MiB. Nie je to streamovanie ani prísľub podpory každého 12-minútového súboru; reálne prijatie závisí aj od pamäte browsera a exportných rozmerov.
- [x] Zdroj sa zachováva read-only; SHA-256 sa uloží pri importe a znovu overí pri otvorení relácie. Úpravy ostávajú v samostatnom session configu a render používa dočasný scratch projekt aj izolovanú kópiu SampleBank.
- [x] Render používa `renderProject()` a spoločný `AudioEngine` podľa ADR 0009. Offline master parametre sa nastavia presne od prvej vzorky; realtime smoothing ostáva pre živé prehrávanie.
- [x] Znovu použiť plný master `EffectRack` v samostatnom session scratch store; efekty, poradie, bypass, parametre a preset príkazy upravujú session `MasterConfig.effects`, nie otvorený project store. Session settings Apply/Undo/Redo vrátane insertov pokrýva Chromium E2E.
- [x] Pridať trvalé pomenované verzie A/B pre celý session `MasterConfig` a férové loudness-matched audition vyrenderených verzií bez zapojenia do živého project audio graphu. Snapshoty sú uložené v session IndexedDB; A/B rendery aj audition gain ostávajú runtime-only.
- [x] Pridať session-local referenčný WAV/MP3 a porovnanie externého mastera s referenciou; samostatný IndexedDB store, SHA-256 read-back, dekódované LUFS-I/dBTP a fair listen trim nemenia pôvodný zdroj, session processing config ani export.
- [x] Doplniť session-store testy a skutočný browser workflow import → render → encode/check → export → opätovný import výsledku. Chromium test kontroluje 24-bit PCM, BWF v2, počet vzoriek, energiu aj úspešný druhý import.
- [x] Po kontrole exportovaného WAV/MP3 umožniť stiahnuť externý mastering report JSON: session/config revízia, zdrojový SHA-256 a metadáta, MasterConfig/profil, Studio HQ render merania, výstupné metadáta a post-encode merania alebo explicitný `not-measured` dôvod. Report neobsahuje zdrojové audio a nevydáva source-PCM verdict za post-decode kontrolu.
- [x] V externej WAV/MP3 session zobrazovať rovnaké hlavné audio dôkazy ako v projektovom MASTER: LRA, krátkodobú loudness timeline, stereo kompatibilitu a Mix Doctor vlajky. Po úspešnom decode majú prednosť post-encode dáta; pri nedostupnom decode sa zobrazenie označí ako zdrojové PCM a žiadne chýbajúce dekódované údaje sa nedopĺňajú zo source renderu.
- [x] Externý mastering session má voliteľnú revíziu výstupu uloženú v lokálnom session summary; staré záznamy bez poľa dostanú prázdny default. Revízia sa pridá do WAV názvu aj sidecaru a report si pamätá presný filename, ktorý sa skutočne stiahol.
- [x] Externá session exportuje lossless WAV (16/24-bit PCM alebo 32-bit float) aj MP3 (192/320 kbps). Obe cesty kontrolujú skutočne zakódovaný súbor a sidecar sa viaže na konkrétny názov/formát; MP3 s nepodporovaným browser decoderom sa stiahne s viditeľným `not measured` dôvodom.
- [x] Aktuálny workspace drží JSON reporty posledných šiestich kombinácií session a názvu WAV/MP3 exportu. Každý sidecar zostáva naviazaný na konkrétny filename aj po prepnutí formátu, otvorení inej session alebo zmene processing draftu; opakovaný export pod rovnakým názvom v tej istej session nahradí starší report. Reporty nie sú trvalo uložené a používateľ ich stiahne podľa potreby.
- [x] Externý delivery profil viditeľne vysvetľuje zamýšľané použitie aj to, že profil iba kontroluje výstup: nemení LUFS, procesory ani limiter ceiling; `CEILING` riadi limiter, `TRUE PEAK TARGET` iba delivery QA.
- [x] Externý AUTO STAGE zobrazuje odhad jedného `masterGain` kroku z posledného source PCM renderu podľa shared gain-staging logiky. Potvrdenie mení session draft; `Apply settings` vytvorí vratný undo krok a nasledujúci render zmeria skutočný výstup.
- [x] Pri MP3 zdroji externý panel pred exportom upozorňuje na ďalšiu stratovú MP3 generáciu a vysvetlí, že WAV zabráni ďalšiemu stratovému encode-u, ale neobnoví zdrojové detaily.
- [x] Externá session má samostatnú, používateľom spúšťanú analýzu vstupného dekódovaného PCM: LUFS-I, true peak, LRA, stereo/mono zhrnutie, Mix Doctor nálezy a loudness timeline sa zobrazia pred masteringovým renderom bez zmeny spracovania. Výsledok je viazaný na session ID a source hash; worker analýza sa dá zrušiť.
- [x] Externý mastering report v2 archivuje pôvodný input baseline spolu s jeho session ID, source hash, timestampom merania, decode sample rate, PCM metrikami, Mix Doctor reportom a timeline. Ak používateľ baseline nezmeral, report explicitne uloží `not-measured` a dôvod.
- [x] Report v2 rozlišuje `decoded-exported-file` od `pre-encode-render-pcm-only`, aby sa verdict bez post-encode merania nezamieňal s analýzou pôvodného vstupného súboru.
- [x] Externá session sprístupňuje rozbaľovacie vstavané TAPE, M/S a B-MONO ovládače cez zdieľaný `MasterProcessingControls`; explicitný session config a `updateDraft` callback udržia úpravy v session, bez zápisu do otvoreného projektu.
- [ ] Chromium acceptance pre source baseline: správne oddelenie od master výstupu, zrušenie analýzy, prepnutie session, zachovanie nezmeneného master draftu a report v2 pre nameraný aj nespustený baseline.
- [ ] Chromium acceptance pre pokročilé vstavané externé ovládače: zmena TAPE/M/S/B-MONO zneplatní render, ostane izolovaná v session drafte a po Apply settings sa uloží s funkčným undo/redo.
- [ ] Doplniť Chromium acceptance pre externé MP3 192/320 exporty, MPEG metadáta, post-encode WebCodecs meranie pri dostupnej podpore, `not measured` fallback a Cancel počas dlhého encode/decode.
- [ ] Browser acceptance má overiť, že sidecary pre dva po sebe idúce exporty zostanú správne spárované a stiahnuteľné po prepnutí formátu, session aj processing draftu.
- [x] Zopakovať externý workflow vo Firefoxe (`firefox-mastering-session` Playwright project): lokálny IndexedDB import, spoločný offline render/analyzér, 24-bit BWF export, decode meranie a opätovný import prešli. Päť Firefox scenárov pokrýva túto round-trip cestu, source/reference quota errors, storage permission failure a source/A-B render cancellation; projekt nespúšťa celú Chromium E2E maticu.
- [x] Chromium E2E: Cancel počas source/reference Blob read, SHA-256, decode a reference worker analýzy, cooperative source-audio auditu aj session restore; zrušený import sa neuloží a uloženú reláciu možno po cancel znovu otvoriť. UI zobrazuje fázu operácie aj Cancel pred vytvorením prvej relácie.
- [x] Chromium E2E: simulovaný `QuotaExceededError` pri IndexedDB source Blob a reference zápise zobrazí „Browser storage is full“; zamietnuté otvorenie session databázy zobrazí storage permission pokyn.
- [x] Chromium E2E: poškodený RIFF/WAVE header sa odmietne pred dekódovaním a bez vytvorenia session.
- [x] Windows Playwright WebKit capability gate (`tests/e2e/09-audio-capability.spec.ts`) potvrdil, že tento build nemá `AudioContext` a zobrazí Web Audio guidance screen; WebKit sa preto nepovažuje za podporovanú DAW/mastering cestu. Skutočný Safari na macOS ostáva owner smoke gate.
- [x] Chromium UI Cancel počas externého source master renderu a renderu verzií A/B; riadená `OfflineAudioContext` brána overí, že sa zrušenie odovzdá render pipeline a nevznikne čiastočný report ani použiteľný A/B výsledok.
- [x] Chromium UI Cancel počas WAV PCM encodingu a finálnej WAV kontroly; riadené encoder yield a Web Audio dekódovanie overujú okamžitý cancel a nulový neoverený download.
- [x] Source/reference quota a storage permission failures prešli v Chromium aj focused Firefox acceptance projekte. Windows WebKit nemá audio stack; Safari/macOS ostáva owner gate. Krátky atomický IndexedDB commit zostáva necancellable a UI počas neho tlačidlo skryje.
- [ ] Zmerať dĺžkové a pamäťové limity v podporovaných browser/OS kombináciách; podľa výsledkov navrhnúť chunkovaný vstupný parser/render/export. Táto fáza nerozširuje multitrack recording claims ADR 0014.

**Akceptácia:** podporovaný WAV/MP3 mix sa bezpečne otvorí v rámci zverejnených limitov, zachová originál, renderuje cez zdieľaný engine a exportne WAV alebo MP3 s kontrolou skutočného súboru a jasným stavom post-decode merania. Chromium E2E overuje import, izolované insert Apply/Undo/Redo, session-local referenciu, pomenované A/B snapshoty a fair audition, export 24-bit/BWF v2 a opätovný import; externé MP3 výstupy ešte čakajú na automatizované acceptance. Pätnásť nových Chromium scenárov prešlo vrátane import/hash/decode/analysis cancellation, session restore/retry, storage failure a Cancel počas source/A-B renderu aj WAV exportu. Päť focused Firefox scenárov prešlo pre WAV delivery round-trip, source/reference quota reporting, permission failure a source/A-B render cancellation. Zostávajú ďalšie browser/OS profily, dĺžkové a pamäťové limity.

## Etapa 9 — release hardening a „professional“ gate

**Výstup:** zvukové, UI, persistence, export a manuálne QA dôkazy pre každú podporovanú cestu.

### Automatické gate-y

- [x] `npm run typecheck` — PASS, `tsc --noEmit` exit 0 po pridaní file-session UI a persistence (2026-10-07).
- [x] Historický recheck po prvom session-cancellation hardeningu (2026-10-07): v tom stave `npm run build` prešiel; shipped JS 6 086 KB, DAW JS 4 567/5 000 KB, on-demand runtimes 640/650 KB, codecs 166/170 KB, audio tool 713/750 KB, HUD 1 078/1 600 KB a worklety 142/150 KB. `npm run drift:check` prešiel. Päť cielených Vitest súborov prešlo 68/68 a jedenásť Chromium file-session scenárov vrátane deviatich nových prípadov prešlo. Tento výsledok predchádza neskoršej oprave IndexedDB quota error propagation a nie je aktuálnym build potvrdením.
- [x] Recheck po oprave IndexedDB error propagation: `tests/mastering-session.test.ts` **11/11 PASS**; štyri cielené Chromium scenáre prešli pre reference read/analysis cancel a source/reference quota reporting. Dva následné Chromium scenáre prešli pre UI cancel source/A-B renderu a WAV encode/post-encode decode bez partial resultu alebo downloadu. V prvej sade sa potvrdilo, že vnorený IndexedDB `put()` callback predtým pohltil `QuotaExceededError`; repository teraz prenáša pôvodnú chybu do session UI.
- [x] Aktuálny recheck po IndexedDB error propagation (2026-10-07): `npm run typecheck` a plný `npm run build` PASS; shipped JS 6 086 KB, DAW JS 4 567/5 000 KB, on-demand runtimes 640/650 KB, codecs 166/170 KB, audio tool 713/750 KB, HUD 1 078/1 600 KB, worklety 142/150 KB a studio boot path 1 891/2 400 KB. `npm run drift:check` PASS. Vite vypísal existujúce dynamic-import/chunk-size upozornenia. Po tejto kontrole prešli typy aj po pridaní focused Firefox acceptance projektu.
- [x] Cielený masteringový/regresný balík: 21 Vitest súborov, 368/368 testov prešli vrátane master reťazca, delivery-contract asistenta, profilov, meteringu, tail výpočtu, render memory guardu, exportu/WAV, UI/MCP, auditov a A/B/reference session persistence. Planner testy potvrdzujú, že broad mix metriky samy nevyvolajú procesing a nameraný true-peak miss navrhne len bounded ceiling.
- [ ] Celý Vitest suite: posledný úplný beh skončil s **831/845 súbormi prešlými**, **9 193 testami úspešnými**, **19 zlyhanými** a **122 preskočenými** (9 334 spolu). Žiadny zlyhaný súbor nebol v masteringovom balíku; zlyhania sú v AI/intent/symbolic/groove oblastiach a MCP inventári/dokumentácii (MCP testy očakávajú 36 nástrojov, runtime hlási 37 vrátane `kyx_unsuno`). Cielený beh `tests/schema-migration.test.ts` + `tests/master-assistant.test.ts` prešiel 14/14. Plná release brána ostáva otvorená, kým sa celý suite nevyčistí.
- [x] Cielené `tests/kweighting.test.ts` prešlo **27/27**: štyri syntetické EBU Tech 3342 LRA vektory, stabilita pri opakovaní a fade-out a poradie low/mean/high bodov časovej osi. `tests/wav-bwf.test.ts` prešlo **15/15** vrátane troch streamovaných WAV prípadov a MP3 fallbacku; Chromium E2E pokrývajú large-MP3 WebCodecs decode/cancel, poškodený MP3 header, používateľské zrušenie počas WAV encode/post-encode decode a 96 MiB WAV analýzu/zrušenie v skutočnom worker-i. `tests/export-verification.test.ts` prešlo **8/8** a pokrýva okamžité zrušenie medzi encode blokmi. Dlhý audio a pamäťový soak pri veľkom WAV/MP3 zostáva neoverený. Predchádzajúci kombinovaný výsledok 174/174 predchádza týmto novým prípadom.
- [x] `npm run drift:check` po aktualizáciách dokumentácie a session persistence.
- [x] Prettier check na všetkých upravených masteringových zdrojových, testovacích a dokumentačných súboroch.
- [ ] Uzavrieť release-wide `npm run test:browser`: posledné dva behy **303/309** a **302/309**. Master chain/glue/limiter, master meter, master bounce, Match EQ a PDC alignment prešli; zostávajúce všeobecné audio, preset a app/plugin workflow zlyhania sú uvedené vyššie.
- [x] `npm run build` a fyzická kontrola bundle budgetu; mastering panel/analyzátor musí byť lazy-loaded, ak jeho veľkosť alebo dependency odôvodňuje separáciu. Build aj fyzické bundle limity prešli po pridaní file-session workflow (shipped JS 6 063 KB, DAW JS 4 544/5 000 KB); `MasteringPanel` je samostatný lazy chunk.
- [x] UI recheck po profile-specific bit depth, screen-reader statusoch a revízii exportov v projektovom aj externom MASTER: `npm run typecheck`, `npx vite build`, Prettier, `git diff --check` a fyzický bundle budget PASS. Bundle: entry 264/1 070 KB, DAW JS 4 579/5 000 KB, on-demand 640/650 KB, codecs 166/170 KB, Audiotool 713/750 KB, HUD 1 078/1 600 KB, worklets 142/150 KB, studio boot 1 893/2 400 KB; shipped JS 6 098 KB. Vite ponechal existujúce dynamic-import a >500 KB chunk upozornenia.
- [x] Recheck po uložení VERSION revízie do lokálneho IndexedDB session summary: `npx vite build`, fyzický bundle budget, Prettier a `git diff --check` PASS. Entry 264/1 070 KB, DAW JS 4 580/5 000 KB, on-demand 640/650 KB, codecs 166/170 KB, Audiotool 713/750 KB, HUD 1 078/1 600 KB, worklets 142/150 KB, studio boot 1 893/2 400 KB; shipped JS 6 100 KB. Typecheck sa zastavil na nesúvislom nepoužitom importe v rozpracovanom `src/browser-checks-live-editing.ts` (`syncDocChangeWhilePlaying`); súbor nebol súčasťou tejto zmeny.
- [x] Externý file-mastering dostal WAV/MP3 delivery workflow a MP3 kvantizácia teraz po blokoch púšťa UI aj Cancel. `npm run build` vrátane `tsc --noEmit`, worklet buildov, produkčného Vite buildu a fyzického bundle budgetu PASS; entry 264/1 070 KB, DAW JS 4 583/5 000 KB, on-demand 640/650 KB, kodeky 167/170 KB, Audiotool 713/750 KB, HUD 1 078/1 600 KB, worklety 142/150 KB, studio boot 1 893/2 400 KB a shipped JS 6 103 KB. Prettier a `git diff --check` PASS. Vite ponechal existujúce dynamic-import/chunk upozornenia. Externé MP3 browser acceptance zostáva otvorené.
- [x] Po pridaní workspace histórie sidecarov pre posledných šesť WAV/MP3 výstupov: `npm run build` vrátane `tsc --noEmit`, všetkých worklet buildov, produkčného bundlu a fyzického budgetu PASS; entry 264/1 070 KB, DAW JS 4 583/5 000 KB, on-demand 640/650 KB, kodeky 167/170 KB, Audiotool 713/750 KB, HUD 1 078/1 600 KB, worklety 142/150 KB, studio boot 1 893/2 400 KB a shipped JS 6 104 KB. Prettier a `git diff --check` PASS. E2E párovanie reportov po zmene session/config ostáva otvorené.
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

| Riziko                                                  | Opatrenie                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dvojité limitovanie (napr. group ZENIT + global master) | Zobraziť obe pozície v grafe, obe gain-reduction meter hodnoty a výsledný master true peak. Preset nesmie tajne zvyšovať výstup gain.                                                       |
| Cieľ LUFS sa považuje za automatickú normalizáciu       | Rozdeliť „check against target“ a potvrdenú loudness úpravu; po zmene vykonať nové meranie.                                                                                                 |
| Hlasnejšie A/B vyhrá                                    | Level-match iba cez dočasný posluchový trim; zobraziť rozdiel gainu a neukladať ho do signálovej cesty.                                                                                     |
| Report zastará po editácii                              | Naviazať report na render fingerprint a invalidovať ho pri každej relevantnej zmene dokumentu, banku, profilu alebo export módu.                                                            |
| Všeobecné „streaming standard“ tvrdenie                 | Profily mať ako verziované ciele s pôvodom a dátumom kontroly; Custom zostáva dostupný.                                                                                                     |
| Meranie správneho signálu na nesprávnom bode            | Dokumentovať measurement tap a merať po poslednom processor/encode stupni podľa otázky reportu.                                                                                             |
| Browserová prekážka pri externom masteringu             | File-session import a render majú explicitné byte/duration/working-set limity; odmietnutie je prednostné pred nekontrolovanou veľkou alokáciou. Streamovanie vyžaduje samostatný I/O audit. |
| Nové mastering UI nafúkne startup bundle                | Nový panel/analyzátor lazy-loadovať, render worker oddeliť a merať produkčný bundle.                                                                                                        |

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
