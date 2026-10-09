# KYX Mastering — záznam manuálnej QA

Tento hárok zachytáva posluchové a prístupnostné overenia, ktoré nemožno
nahradiť úspešným renderom, automatickým testom ani screenshotom. Každý výsledok
patrí ku konkrétnej verzii KYX, browseru, OS a audio výstupu.

## Podmienky testu

| Pole                                             | Hodnota |
| ------------------------------------------------ | ------- |
| Tester                                           |         |
| Dátum a čas                                      |         |
| KYX verzia / commit                              |         |
| Runtime (Web / Electron)                         |         |
| OS a verzia                                      |         |
| Browser a verzia                                 |         |
| Audio výstup zvolený v KYX                       |         |
| Skutočný výstupný route / driver                 |         |
| Kontrolné slúchadlá alebo reproduktory           |         |
| Kontrolný materiál a jeho SHA-256                |         |
| Delivery profil                                  |         |
| Render rate / kvalita / exportný formát          |         |
| Hladina posluchu alebo jej reprodukovateľný opis |         |

Zapíš systémový mixer alebo driver medzi browserom a zariadením. Voľba výstupu
v **Studio I/O** a nahlásená browser latency samy osebe nepotvrdzujú ASIO,
hardware round-trip latency ani kalibráciu monitorov.

Použi kópie materiálu, ktorých hlasitosť aj obsah poznáš. Pri každom porovnaní
over, že strany idú cez ten istý fyzický výstup. Zaznamenaj použitý offset,
audition trim a či si počúval na natívnej úrovni alebo s loudness matchom.

## Manuálny posluch

Pre každý riadok zapíš `PASS`, `FAIL`, `BLOCKED`, `NOT RUN` alebo `NOT MEASURED`
a stručný dôkaz. `PASS` znamená, že si výsledok skutočne počul na uvedenom
zariadení. Zelený profilový verdict, waveform ani úspešný download nie sú dôkaz
počuteľnej kvality.

| ID  | Kontrola                                                                                                                                                                                                                                                          | Výsledok a poznámky |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| L1  | Zastav transport, spusti **Play master-path test tone** a počas tónu prepni **Live monitor bypass**. Potvrď plynulý prechod bez cvaknutia alebo náhleho ticha; over, že tón nemení projekt ani offline export. Pri aktívnom loudness matchi použi natívne úrovne. |                     |
| L2  | Ak používaš **Match bypass loudness**, porovnaj spracovaný a bypass zvuk pri dorovnaní aj natívnych úrovniach. Zapíš zobrazené trimy a over, že match nemení export.                                                                                              |                     |
| L3  | Ulož A/B snapshoty s odlišnou, rozpoznateľnou zmenou. Vyrenderuj ich pri rovnakom programe a sample rate; porovnaj s loudness matchom a potom na natívnej úrovni.                                                                                                 |                     |
| L4  | Ak používaš referenciu, porovnaj rovnaký úsek a zapíš oba štartovacie offsety aj spoločnú dĺžku. Over prepnutie strán bez reštartu a bez počuteľného kliknutia.                                                                                                   |                     |
| L5  | Vypočuj exportované WAV v stereo a mono. Zapíš, či sa pri mono fold-down stratí dôležitý prvok alebo sa zmení stabilita basu a stredu.                                                                                                                            |                     |
| L6  | Vypočuj master pri bežnej a nízkej úrovni. Skontroluj najtichšiu časť, najhlasnejší transient/drop, subbas, sykavé alebo ostré výšky, prechody a koniec vrátane dozvuku.                                                                                          |                     |
| L7  | Skontroluj clipping, pumping, únavnú ostrosť, nadmerné stereo rozšírenie, nestabilný stred a useknutý efektový tail. Zapíš konkrétny čas v skladbe.                                                                                                               |                     |
| L8  | Vypočuj aspoň jedny slúchadlá, bežné reproduktory a jedno ďalšie kontrolné zariadenie. Zariadenia a výstupnú trasu uveď samostatne.                                                                                                                               |                     |
| L9  | Vyrenderuj aspoň jeden reprezentatívny projekt pre každý profil, ktorý chceš podporovať. Potvrď, že nastavenie profilu nemení spracovanie bez výslovného zásahu a že export je ten súbor, ktorý bol skontrolovaný.                                                |                     |

### Výsledky súboru

| Exportovaný súbor | SHA-256 | Playback zariadenie | Zistenie po posluchu |
| ----------------- | ------- | ------------------- | -------------------- |
|                   |         |                     |                      |
|                   |         |                     |                      |

Ak post-encode audio nebolo dekódované a zmerané, zachovaj tento stav ako
`NOT MEASURED`. Neoznač ho za PASS na základe pre-encode PCM alebo hlavičky.

## Screen-reader smoke test

| Pole                   | Hodnota |
| ---------------------- | ------- |
| Screen reader a verzia |         |
| Browser a verzia       |         |
| OS a verzia            |         |
| Tester                 |         |
| Dátum a čas            |         |

Klávesnicou prejdi MASTER od profilových ovládačov po report a export. Pre každú
udalosť zapíš skutočne vyslovený text, jeho načasovanie a to, či bolo možné
pokračovať bez opustenia kontextu.

| ID  | Stav alebo úkon                                                                                                                                                                                                                                                                                                                                           | Výsledok a vyslovený text |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| A1  | Spusti analýzu. Počuj busy stav a potom výsledok; potvrď, že ten istý výsledok nie je oznámený duplicitne.                                                                                                                                                                                                                                                |                           |
| A2  | Zruš analýzu alebo export. Počuj, že úloha bola zrušená a nebola označená ako úspešne dokončená.                                                                                                                                                                                                                                                          |                           |
| A3  | Zmeň INPUT po hotovom meraní. Počuj, že report je zastaraný; over, že starý výsledok sa nevydáva za aktuálny.                                                                                                                                                                                                                                             |                           |
| A4  | Spusti export. Over stav busy, zmysluplný priebeh, chybu alebo dokončenie a výsledný názov súboru.                                                                                                                                                                                                                                                        |                           |
| A5  | Vyvolaj clipping. Over jedno globálne oznámenie peak/hold údajov; lokálny CLIP badge nesmie udalosť oznámiť druhýkrát.                                                                                                                                                                                                                                    |                           |
| A6  | V externej session zmeň excerpt offset počas loudness merania. Over stav fronty, Cancel match a readout až po dokončení nového merania.                                                                                                                                                                                                                   |                           |
| A7  | Otvor report history. Over názov download akcie, čas uloženia a pôvodnú revíziu session.                                                                                                                                                                                                                                                                  |                           |
| A8  | Vymaž report history. Over oznámenie výsledku a potvrď, že session, source audio a referencia zostali zachované.                                                                                                                                                                                                                                          |                           |
| A9  | Otestuj úzky viewport aj zväčšené písmo. Over, že statusy, ovládače a mená súborov sa dajú prečítať bez horizontálneho posúvania.                                                                                                                                                                                                                         |                           |
| A10 | Spusti a zastav **Play master-path test tone**. Over dostupný názov akcie, oznámenie prehrávania/zastavenia a to, že nevznikne hlásenie o zmene projektu.                                                                                                                                                                                                 |                           |
| A11 | Začni A/B/reference/assistant audition a počas prehrávania spusti testovací tón; preview sa má zastaviť. Počas tónu a hneď po ňom skús **BOUNCE WHAT YOU HEAR** a audition znova spustiť. KYX ich má blokovať po odhadovaný tail, zobraziť odpočet bez zahlcovania čítačky obrazovky a po odomknutí neprepustiť testovací tón do nahrávky ani porovnania. |                           |

## Zhrnutie a podpora

| Rozhodnutie                                        | Hodnota |
| -------------------------------------------------- | ------- |
| Celkový výsledok (PASS / FAIL / BLOCKED / NOT RUN) |         |
| Podporovaný profil a exportná cesta                |         |
| Nepodporované alebo neoverené kombinácie           |         |
| Otvorené chyby / follow-up                         |         |
| Odkaz na audio alebo reprodukovateľné dôkazy       |         |

Výsledok platí iba pre zapísaný browser, OS, output route, zariadenia, verziu
KYX a delivery cestu. Neprenášaj PASS na iné zariadenia alebo platformy bez
ďalšieho overenia. Uchovaj použitý projekt, profil, exportný súbor, jeho hash a
poznámky; samotný JSON sidecar neobsahuje počuteľné potvrdenie kvality.
