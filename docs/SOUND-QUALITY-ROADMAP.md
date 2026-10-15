# KYX Sound Quality Program

**Status:** pracovná implementačná roadmapa · **Dátum:** 2026-10-15

## Cieľ

Postaviť z KYX spoľahlivý a osobitý nástroj na tvorbu beatov: každý dôležitý nástroj a efekt má predvídateľný zvuk, funguje pri hraní aj exporte, ponúka užitočné zvukové možnosti a obstojí v porovnaní naslepo pri rovnakej hlasitosti. AI má urýchliť hľadanie zvuku bez toho, aby preberala autorstvo alebo obchádzala audio a projektové pravidlá.

„AAA“ ani „world-class“ nie sú samy osebe merateľné technické kritériá. V tejto roadmape znamenajú preukázanú kvalitu v troch oblastiach:

1. **Technická dôvera:** zvuk je konečný, ovládače fungujú, prehrávanie a export majú rovnaký význam a výkon zostáva v rozpočte.
2. **Hudobná hodnota:** nástroj rieši jasnú úlohu, jeho presety sa dajú použiť v mixe a rozdiely medzi nastaveniami sú počuteľné a zámerné.
3. **Tvorivý tok:** používateľ vie zvuk rýchlo nájsť, porovnať, uložiť a upraviť; AI prípadne navrhne zmenu, ktorú možno bezpečne vypočuť a odmietnuť.

Toto je nadradený plán kvality, nie tvrdenie, že všetky uvedené schopnosti už sú hotové. Konkrétne implementačné úlohy a ich stav zostávajú v prepojených plánoch jednotlivých oblastí.

## Prečo majú tieto nástroje zmysel

- **KOPA** vytvára kick od transientu po telo a sub. Môže byť rýchlym, laditeľným nástrojom pre kick namiesto výberu zo statickej banky.
- **KOREŇ** je samostatný basový harmonický procesor. Sleduje fundament a pridáva čitateľné harmonické pásmo tam, kde pomôže menším reproduktorom, pričom má chrániť pôvodný sub.
- **TSAR** spája vlastné zdroje, sample, wavetable a granulárne možnosti do editovateľného nástroja. Jeho odlišnosť má vychádzať z cesty od importovaného zvuku k hrateľnému patchu, nie z počtu knobov alebo presetov.
- **Zvuková knižnica** dáva týmto nástrojom a beatovým workflow použiteľné východisko. Syntetické a nahraté zdroje majú odlišné úlohy; jedna kategória nemusí nahradiť druhú.
- **AI producent** môže preložiť zvukový zámer na konkrétny návrh KOPA, KOREŇA alebo TSAR, vytvoriť niekoľko kontrolovaných možností a nechať používateľa vybrať si.

Jedinečnosť KYX teda môže byť v súhre **navrhnutých zvukových nástrojov + kurátorovaného materiálu + editovateľného AI workflow**. Samotné AI ani veľký počet presetov túto výhodu nedokazujú.

## Aktuálny východiskový bod

Prvý technický correctness slice bol implementovaný a zmeraný 15. októbra 2026. Je to pokrok v spoľahlivosti, nie potvrdenie zvukovej kvality na úrovni „AAA“ ani uzavretie V2:

- **KOPA:** nulová velocity teraz správne znamená ticho; worklet aj fallback majú cielenejšie pokrytie velocity, one-shot/gated a správy hlasov. Browser DSP audit našiel účinok pri 35/35 kontrolovaných parametroch. Zostáva úplný velocity/fallback pomer, MIDI/retrigger a kliky, spektrálne/alias merania a level-matched počúvanie. Podrobnosti sú v [KOPA + KOREŇ V2 backloge](KOPA-KOREN-V2-ROADMAP.md).
- **KOREŇ:** tracker testy teraz zahŕňajú šum/ticho, out-of-phase stereo, krátky kick nad basovým fundamentom, ukončenie signálu a 44.1/48/96 kHz. Browser DSP audit našiel účinok pri 18/18 kontrolovaných parametroch. Päťminútový soak v pohybovom režime nameral medián 0.0903 ms/blok na začiatku a 0.0837 ms/blok ku koncu, 0 subnormálov/NaN a nárast heapu 1.1 MB; statický drift bol 0.00025 dB. Zostáva meranie v mono/mixe, gain/aliasing na širšom korpuse a level-matched posluch.
- **TSAR:** opravený bol release po MIDI note-off, scan wavetable v oboch slotoch a počuteľný zdroj pri prázdnom patchi. Engine regresie prešli 21/21, browser parameter audit 69/69 a Chromium preset audit 48/48. Posledný audit kontroloval konečný/neclippujúci zvuk a zhodu loudness mapy; nie je to posluchová známka presetov. E2E overil počuteľný offline worklet render a panel; priame level-matched porovnanie živého prehratia s exportom ešte treba doložiť. Stav a ďalšie brány sú v [TSAR implementačnej roadmape](TSAR-IMPLEMENTATION-ROADMAP.md).
- **Produkčný build:** strict typecheck a Vite production render prešli; všetky oddelené worklet bundly sa zostavili. Bundle audit nameral DAW JS 5030/5186 KB a štúdiovú boot cestu 2202/2200 KB (+2 KB). Žiadny limit som nezvyšoval; boot cesta zostáva otvoreným release gate-om na zmeranú lazy-split optimalizáciu.
- Továrenský manifest má 155 zvukov: 142 WAV override-ov a 13 syntetických hlasov. WAV-y sú technicky čisté podľa auditu, no boli vytvorené z KYX syntetických seedov; nejde o nahratú akustickú súpravu. Všetkých 142 WAV-ov je dual-mono a základná knižnica zatiaľ nemá nahraté breaky/loopy ani skutočné stereo textúry. Podrobnosti a návrhy sú v [audite zvukovej knižnice](SOUND-LIBRARY-AUDIT-2026-10-15.md).
- KYX už má AI a intent infraštruktúru, vrátane generovania a mix návrhov. Ďalšou medzerou nie je „pridať AI všade“, ale kvalitné, špecifické adaptéry na zvukové nástroje a vyhodnotenie, či návrhy reálne pomáhajú. Platí [AI Producer Contract](AI-PRODUCER-CONTRACT.md), [Effect Intent roadmapa](effect-intent-engine-roadmap.md) a [Producer DNA roadmapa](PRODUCER-DNA-ROADMAP.md).

Čísla a stav zvukovej knižnice sú auditované k uvedenému dátumu. Pred ďalším slice treba skontrolovať aktuálny kód a príslušný backlog; táto roadmapa zaznamenáva len priečne výsledky a nepreberá celý meniteľný zoznam úloh.

## Spoločný protokol kvality

Každá etapa má používať rovnaký základ, aby výsledky medzi nástrojmi a verziami dávali zmysel:

1. **Referenčné situácie:** krátke kicky, ladené kicky, 808 bez výrazných harmonických, harmonicky bohatá basa, glissando, kick+basa, sample s transientom a tónom, textúra/šum a reprezentatívne beatové aranžmány. Zaznamenať zdroj, tóninu, sample rate, tempo, seed a očakávaný cieľ.
2. **Technické kontroly:** konečné vzorky bez NaN/Infinity, ticho pri neplatnom trackingu, bezpečné limity gainu, mono fold-down, automatizácia, všetky rozsahy parametrov, opakovateľnosť, load/unload, AudioWorklet deadline a prípadná degradácia bez workletu.
3. **Audio kontrola:** podľa efektu merať true/sample peak, LUFS alebo RMS, crest/transient, fundament a harmonické pásma, alias energiu, stereo koreláciu a sub zachovanie. Metrika sa vyberá podľa toho, čo má daný ovládač meniť; jedno skóre nenahradí posluch.
4. **A/B posluch:** level-matched, anonymný a s konkrétnou úlohou. Hodnotiť napríklad „je kick čitateľnejší v telefónnom pásme a zostal sub stabilný?“ alebo „ktorý patch lepšie zachová transient importu?“, nie iba „ktorý znie lepšie?“. Zaznamenať systém posluchu a prehrávacie podmienky.
5. **Kontrolný mix:** výsledok overiť v celom beate, pri rozumnej hlasitosti, v slúchadlách/reprákoch a pri mono prehratí. Solo zvuk je len jedna časť rozhodnutia.

Numerické hranice pre CPU, detekčnú chybu, latenciu, hlasitosť či úspech posluchu sa určia po zmeraní referenčného zariadenia a baseline. Nesmú sa vyberať spätne len preto, aby konkrétny build prešiel. Ľudský posluch a jeho výsledky sa vedú oddelene od heuristického alebo modelového skóre.

## Poradie realizácie

| Fáza                                    | Čo dodať                                                                                                                                                 | Brána na pokračovanie                                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **0. Baseline a korpus**                | Zafixovať reprezentatívne projekty, zvukové vstupy, sample rate-y, zariadenia a meracie protokoly. Uložiť výsledky pred zmenami.                         | Rovnaký vstup a seed dávajú reprodukovateľné meranie; známe limity a chýbajúce dôkazy sú zapísané.                               |
| **1. Spoľahlivosť jadra**               | Dokončiť otvorené P0 KOPA/KOREŇ a TSAR reliable-first-sound. Prejsť parametre od UI po DSP, MIDI, fallback, lazy load a live/offline cestu.              | Každý ovládač má doložený účinok a rozsah; nejednoznačný tracker stíši syntézu; preset a eventy znejú predvídateľne.             |
| **2. Zvuková kvalita a identita**       | Level-matched počúvanie, kontrola gain/phase/alias/mono/CPU a odladenie defaultov/presetov. Doplniť originálne akustické a textúrne zdroje podľa auditu. | Vybrané použitia majú preukázateľný prínos v mixe; nové zdroje majú jasný účel, pôvod/licenciu a technickú QA.                   |
| **3. Rýchle hľadanie a opakovateľnosť** | TSAR source library, viac návrhov z jedného importu, patch mutations, preset audition; KOPA/KOREŇ cielené presety a bezpečné A/B.                        | Používateľ rozlíši a vypočuje možnosti bez straty práce; každý preset je počuteľne odlišný, level-aware a editovateľný.          |
| **4. AI zvukový producent**             | Pluginovo špecifické návrhy, obmedzené varianty, render/preview, porovnanie a potvrdené použitie cez existujúce command/undo pravidlá.                   | Návrhy plnia brief lepšie než deterministický baseline v slepom hodnotení a zlyhanie modelu neovplyvní projekt ani audio thread. |
| **5. Rozšírenie podľa dôkazov**         | Pridať ďalšie DSP, presetové série, balíky zvukov alebo modely len vtedy, keď pilot ukáže konkrétnu medzeru.                                             | Novinka rieši zdokumentovaný problém a prejde rovnakými technickými aj posluchovými bránami.                                     |

### Fáza 0 — Baseline a korpus

- Zvoliť referenčný projekt pre čistý KOPA kick, ladený kick, 808/KOREŇ, bohatú basu, zdroj do TSAR a celý beat s kick+basa súhrou.
- Pre každý nástroj vytvoriť pevné prípady: minimum/default/maximum parametrov, automatizácia, reset, preset load, opakované spustenie, ticho, extrémny vstup a offline export.
- Zaznamenať bežné platformy a sample rate-y (minimálne 44.1, 48 a 96 kHz podľa podpory), cieľovú polyfóniu/hlasové zaťaženie a rozpočet workletu.
- Vytvoriť malý anonymný A/B balík. Pri prvom kole zbierať baseline, nie marketingové tvrdenie.

### Fáza 1 — Uzavrieť dôveru v DSP

**KOPA:** zjednotiť velocity správanie workletu a fallbacku; overiť one-shot/gated, note-off, choke, retrigger a voice-steal bez klikov; zmerať všetky ovládače na účel a oba konce rozsahu; vyhodnotiť preset hlasitosť a rozlišovaciu schopnosť; preveriť ladenie, fázu sub/body, true peak a drive aliasing.

**KOREŇ:** uzavrieť parametrový kontrakt; preveriť tracker na čistej a harmonicky bohatej 808, glisse, krátkom kicku, tichu/šume, out-of-phase stereo a súbehu kick+basa; merať chybu, lock/unlock, oktávové skoky a confidence. Pri neistej výške musí wet syntéza bezpečne ustúpiť. Overiť level-matched bypass, sub, telefónne pásmo, mono, nízke sample rate-y, aliasing a CPU.

**TSAR:** dokončiť spoľahlivé načítanie workletu v už otvorenom projekte; potvrdiť, že Source A/B a viditeľné parametre menia aktívny patch; overiť ponúkané presety na skutočnom runtime; porovnať rovnaký patch a udalosti pri živom prehrávaní a offline renderi. Až potom rozširovať granular a moduláciu.

**Spoločná brána:** vyplniť [NEW-EFFECT-CHECKLIST](NEW-EFFECT-CHECKLIST.md) pri každej zmene DSP; dodržať existujúce pravidlá AudioWorkletu, spoločného enginu a deterministického offline renderu. Zvuk, ktorý funguje iba v jednom režime, túto fázu neprešiel.

### Fáza 2 — Zvuk, ktorý obstojí v mixe

- Presety KOPA/KOREŇ porovnávať pri zrovnanej vnímanej hlasitosti. Pri KOPA hodnotiť transient, telo, tail, tuning a sub v kontexte beatov; pri KOREŇA čitateľnosť malého reproduktora bez klamlivého zvýšenia hlasitosti a bez straty subu.
- Pre KOREŇA ponechať „PHONE CHECK“ v monitorovacej ceste. Nesmie meniť export ani projektový zvuk. Pri KOPA a TSAR sa audition gain jasne oddeľuje od výstupnej hlasitosti efektu/nástroja.
- Zachovať silnú súčasnú syntetickú banku, ale pridať malú, kvalitne nahratú KYX súpravu s reálnymi velocity/round-robin rozdielmi, originálne room/brush/found textures a mono-safe stereo materiál. Prípadné loopy začať niekoľkými zámerne odlišnými breakmi; nevytvárať stovky drobných variantov bez úlohy.
- Ku každému assetu uložiť pôvod, licenciu, spôsob tvorby, sample rate/bit depth a určenú rolu. Factory preset a sample musia mať vlastné hlasitostné/peak pravidlá podľa použitia.
- Pri plných beatových vzoroch skontrolovať kick/sub prekrývanie a priestor v aranžmáne. Neopravovať zlú súhru automatickým stíšením zdrojového súboru.

### Fáza 3 — Tvorivý workflow

- TSAR: najprv reuse/import knižnica zdrojov a stabilný prvý zvuk; potom viac dobre odlíšených Forge návrhov z jedného zdroja, bezpečné audition, presety podľa úlohy a deterministické patch variations.
- KOPA: rýchly hlavný workflow od pitch/tail/sub makier po detailné ovládanie; okamžitý preview a presety pomenované podľa zvukovej úlohy.
- KOREŇ: viditeľný stav „zamknutý / držím / hľadám / mimo rozsahu“ s dôveryhodným confidence; vysvetlené ovládače, bezpečné wet/bypass porovnanie a presety podľa vstupu/cieľa.
- Audition musí fungovať bez poškodenia rozpracovaného projektu. Prijatie je editovateľná zmena s undo/redo; zrušenie alebo zastaraný návrh nesmie zmeniť stav.

Rozsah TSAR R2–R5 a V2.2 KOPA/KOREŇ je v existujúcich plánoch. Rozširovanie granulárneho DSP, ďalšie partialy alebo ďalšie ovládače odložiť, ak kvalitatívne meranie neukáže nevyriešenú potrebu.

### Fáza 4 — AI, ktorá navrhuje a dáva na výber

Po stabilizácii parametrov a audition workflow pripojiť jednotlivé adaptéry:

1. Zámer a kontext vyberú konkrétny cieľ: napríklad „kratší kick, ladený do D“, „808 čitateľnejšia na telefóne, zachovaj sub“ alebo „urob z tohto samplu pohyblivý pad, zachovaj attack“.
2. Deterministický plánovač alebo voliteľný model pripravia malý počet ohraničených, pomenovaných kandidátov. Zobrazia predpoklady, zmenené parametre a neistotu.
3. Kandidáti sa vyrenderujú cez zdieľanú audio cestu, prejdú technickými bránami a vypočujú sa pri zrovnanej hlasitosti v mixe.
4. Používateľ vyberie, upraví alebo odmietne; Apply vytvorí jednu undoable zmenu. Bez modelu musí zostať použiteľná lokálna/deterministická cesta.

AI nebeží v audio callbacku, nezapisuje ľubovoľné hodnoty do projektu a nevydáva proxy score za ľudský vkus. Automatické učenie preferencií ostáva explicitné a lokálne/opt-in podľa existujúcej AI zmluvy. Modelový kandidát sa aktivuje až po porovnaní s baseline: plnenie briefu, počuteľná odlišnosť, latencia/veľkosť a ľudské blind preferencie.

### Fáza 5 — Rozšírenie podľa dôkazov

Po každom vydanom slice rozhodnúť, či ďalšiu kapacitu investovať do:

- presnejšieho DSP alebo lepšieho defaultu,
- kvalitnejšieho nahratého materiálu,
- lepšieho hľadania/audition a editácie,
- alebo AI, ktorá preukázateľne uľahčuje konkrétnu úlohu.

Nové funkcie a zvuky nesmú rásť iba preto, že ich možno pridať. Musia doplniť počuteľnú rolu alebo vyriešiť opakujúci sa problém z testov/posluchu. Ak prínos nepotvrdí meranie a posluch, zostáva experimentom alebo sa vynechá.

## Spoločná definícia hotového slice-u

Slice je pripravený na označenie za hotový, keď:

- sú aktualizované príslušné cielené testy, typecheck, worklet build a produktové QA podľa rozsahu;
- je doložená cesta od ovládacieho prvku cez model/command až po DSP a jej hranice;
- live playback a offline render používajú rovnaký význam parametrov a udalostí;
- sú zverejnené výsledky relevantných metrických a posluchových kontrol vrátane neúspechov;
- fallback, chýbajúci model, nepodporovaný vstup a cancel majú pravdivé a bezpečné správanie;
- nové presety/zvuky majú účel, hlasitostnú kontrolu a dohľadateľný pôvod;
- `docs/CURRENT-STATE.md` sa mení iba vtedy, keď sa zmenil skutočne dodávaný rozsah alebo jeho počty.

## Najbližší implementačný rad

1. **KOPA/KOREŇ V2.0 correctness:** parameter trasy, velocity/fallback a MIDI správanie; tracker corpus a neistota.
2. **TSAR reliable first sound:** runtime load, parameter/source účinok, reprezentatívne presety a live/offline porovnanie.
3. **Spoločné sound quality review:** KOPA/KOREŇ level-matched A/B a mix testy; stanoviť baseline zariadenia, CPU a aliasingu.
4. **KOPA/KOREŇ V2.2 workflow + TSAR R2/R5:** audition, stavové indikátory, knižnica/preset prehľad a opakovateľné uloženie.
5. **Obmedzený AI sound-design pilot:** jeden zámer pre každý plugin, návrh → porovnanie → potvrdené Apply; rozšíriť až po slepej evaluácii.
6. **Kurátorovaná nahratá kolekcia:** malý prvý balík s velocity/round-robin a niekoľkými textúrami; ďalšie nahrávanie podľa zistených medzier.

Toto poradie najskôr odstráni neistotu, či nástroje robia to, čo sľubujú. Potom vylepšuje počuteľný výsledok a až následne škáluje presety, knižnicu a AI.
