# TSAR — implementačná roadmapa

**Stav:** návrh ďalších implementačných fáz · **Aktualizované:** 2026-10-08

- **Východiskový stav:** T0–T7 sú dodané; ich realizáciu a zistenia zachytáva [TSAR-ROADMAP.md](TSAR-ROADMAP.md).
- **Produktový zámer:** [TSAR-PRODUCT-DIRECTION.md](TSAR-PRODUCT-DIRECTION.md)
- **Architektúra:** [ADR 0023](adr/0023-tsar-hybrid-engine.md)

## Cieľ

TSAR má producentovi umožniť vziať hotový alebo vlastný zvuk, spraviť z neho hrateľný patch a ďalej ho pretvárať pri hraní. Ambíciou je dosiahnuť hĺbku a súdržnosť nástroja na úrovni etablovaných hybridných syntetizátorov, pričom TSAR využije výhodu KYX: zdrojový zvuk, patch, MIDI, aranžmán a export sú v jednom pracovnom prostredí.

Úspech nebudeme merať počtom položiek v katalógu. Budeme ho merať tým, ako rýchlo používateľ dostane zaujímavý zvuk, ako ľahko pochopí jeho zdroje a ako dobre reaguje na jeho hru.

## Produktové princípy

- **Zvuk → hrateľný patch.** Nová stopa musí znieť hneď a importovaný zvuk musí viesť k použiteľným výsledkom bez skrytého nastavovania.
- **Zdroj nie je patch.** Zvukový materiál a nastavenia nástroja majú byť zrozumiteľné a znovupoužiteľné samostatne. Zdroj možno použiť vo viacerých patchoch.
- **Najprv počuť, potom potvrdiť.** Forge, variácie aj presety majú mať rýchly náhľad. Náhľad nemení projekt; potvrdená úprava je vratná cez undo.
- **Výrazová hrateľnosť.** TSAR má reagovať na velocity, moduláciu, MIDI a pohyb makier. Dôležité zmeny musia fungovať aj pri exporte.
- **Lokálne a dôveryhodné.** Používateľské audio zostáva lokálne. Pôvod a licencia pribaleného factory audia sú zaznamenané.
- **Kvalita pred šírkou.** Nový DSP alebo ovládač pridáme vtedy, keď prináša počuteľný a zrozumiteľný rozdiel.

## Poradie implementácie

R-fázy určujú navrhované poradie práce. Nejde o termíny ani sľub vydania. Toto je konkrétny vykonávací plán k širším prioritám v produktovej vízii.

| Fáza                                      | Priorita | Výsledok pre používateľa                                                      | Hlavná závislosť                                   |
| ----------------------------------------- | -------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| R1 — Spoľahlivý prvý zvuk                 | P0       | Nová TSAR stopa a každý ponúkaný preset znejú predvídateľne.                  | Súčasný engine T0–T7                               |
| R2 — Knižnica zdrojov                     | P1       | Používateľ nájde, uloží a opakovane použije factory aj vlastné zdroje.        | Rozhodnutie o metadátach a lokálnom úložisku       |
| R3 — Sample Forge: viac ciest             | P1       | Z jedného importu možno vypočuť viac vhodných patchov a vybrať si.            | R1; napojenie na R2                                |
| R4 — Patch Mutations                      | P1       | Z patcha vzniknú kontrolované, opakovateľné variácie.                         | Stabilný model parametrov; R1                      |
| R5 — Preset browser a audition            | P1       | Presety sa hľadajú podľa použitia a dajú sa porovnať bez straty práce.        | R1; postupne R2                                    |
| R6 — ORBIT performance surface            | P2       | Jedným pohybom možno výrazne a opakovateľne hrať patch.                       | Stabilné modulačné ciele; command/automation cesta |
| R7 — Hlbší zdrojový engine                | P2       | Granulárny režim a ďalšie zdrojové techniky vytvoria nové počuteľné možnosti. | CPU profil, R1; pri granulari aj R2                |
| R8 — MIDI, performance a rozšírenie banky | P2       | Patch sa pohodlne ovláda a vrství v KYX; pribúdajú kurátorované presety.      | R4–R7 podľa rozsahu                                |

R2, R3 a R4 tvoria jadro odlišujúce TSAR: vlastné zdroje, počuteľné alternatívy a tvorba variácií. R5 môže napredovať súbežne po stabilizácii R1. R6 a R7 prídu po tom, ako budú hotové spoľahlivé ciele modulácie a meranie výkonu.

## R1 — Spoľahlivý prvý zvuk

Najprv odstrániť rozdiel medzi tým, čo ukazuje panel a projekt, a tým, čo vytvorí audio runtime.

- Nová TSAR stopa dostane počuteľný a hudobne použiteľný predvolený zdroj.
- Každý ponúkaný factory preset zaznie bez ručného opravovania stavu zdroja.
- Zmena Source A aj B sa prejaví v otvorenom projekte a pri ďalšom prehratí.
- Viditeľné ovládače, vrátane Drift a LFO Sync, budú zapojené do DSP alebo odstránené/skryté, kým nebudú funkčné.
- Overí sa načítanie workletu pri pridaní TSAR do už otvoreného projektu.
- Realtime playback a offline export sa overia na rovnakom patchi a udalostiach.

**Brána:** čistá TSAR stopa a všetky ponúkané presety sú počuteľné; každý viditeľný ovládač má overiteľný účinok; zmena oboch zdrojov sa prejaví; browser kontrola potvrdí správnu TSAR cestu v prehratí aj exporte.

**Závislosti a pravidlá:** DSP zostáva v AudioWorklete; projektový stav sa mení cez commands; worklet sa načítava podľa potreby. Pri každom parametri overiť cestu UI → command → projekt/runtime → počuteľný účinok podľa [NEW-EFFECT-CHECKLIST.md](NEW-EFFECT-CHECKLIST.md).

## R2 — Knižnica zdrojov

Vytvoriť prehľadný základ pre zdrojové audio, aby sa patch dal preniesť, upraviť alebo znovu použiť bez opätovného hľadania pôvodného súboru.

- Oddeliť metadáta zdroja od parametrov patcha: názov, dĺžka, kanály, sample rate, odhad ladenia, loop body, typ a pôvod/licencia.
- Začať s lokálnou knižnicou factory a používateľských zdrojov; cloudová služba nie je podmienka workflowu.
- Umožniť prezrieť zdroj a jeho waveform, skontrolovať chýbajúci asset a zistiť, ktoré patche ho používajú.
- Načítavať voliteľné audio až pri použití TSAR alebo konkrétneho zdroja; projekty bez TSAR nemajú platiť jeho boot náklady.
- Rozhodnúť, ako budú patchy odkazovať na zdroje a ako sa zachová identita pri premenovaní alebo presune v rámci knižnice.

**Brána:** zdroj možno znovu použiť vo viacerých patchoch; jeho názov a metadáta sa zobrazujú konzistentne; chýbajúci asset je zrozumiteľný a nespôsobí ticho bez vysvetlenia; projekt možno uložiť a znovu otvoriť s rovnakým výsledkom.

**Schéma:** ak sa mení uložený tvar projektu alebo persistovaných dát, najprv zaznamenať rozhodnutie, zvýšiť príslušnú verziu a doplniť migráciu podľa pravidiel projektu. Rozsah zmeny potvrdiť v ADR pred implementáciou.

## R3 — Sample Forge: viac ciest z jedného zvuku

Forge dnes analyzuje import a navrhuje základné nastavenie. Ďalším krokom je premeniť tento návrh na krátky výber počuteľných tvorivých možností.

- Z jedného importu pripraviť niekoľko odlišných interpretácií podľa materiálu: ladený nástroj, one-shot/transient, textúra alebo wavetable patch.
- Pri každom návrhu zobraziť, čo Forge zistil: koreňový tón, typ, obálku, zvolený režim a mieru istoty.
- Umožniť okamžitý náhľad a A/B porovnanie návrhov bez zmeny projektového stavu.
- Podporiť vloženie výsledku do Source A alebo B.
- Použiť jeden undoable command na potvrdenie zvoleného návrhu.
- Keď analýza nevie bezpečne určiť ladenie alebo charakter, ponúknuť poctivú nepresnú voľbu namiesto vymysleného výsledku.

**Brána:** opakovaný import rovnakého audia vytvorí rovnaké návrhy; náhľad nemení projekt; Apply vytvorí jednu undo akciu; používateľ vie rozlíšiť návrhy podľa ich zvuku a popisu; tiché alebo nečitateľné audio má zrozumiteľnú odpoveď.

## R4 — Patch Mutations

Dodať rýchle objavovanie variantov, ktoré zachováva zámer patcha a dá sa kontrolovať.

- Vytvárať variácie zo seedu, takže rovnaký patch, seed a nastavenia vrátia rovnaký výsledok.
- Umožniť uzamknúť zdroj, ladenie, obálku alebo iné skupiny parametrov, ktoré sa nemajú meniť.
- Ovládať rozsah zmeny od jemnej variácie po odvážnejšiu premenu.
- Porovnať pôvodný patch a návrh; potvrdenie uloží jeden undoable command.
- Zachovať základnú identitu a hrateľnosť patcha. Zdrojový sample sa bez súhlasu nemení ani nenahrádza.
- Umožniť vrátiť sa k seedu a vyvolať obľúbenú variáciu ako nový preset.

**Brána:** variácie sú deterministické; zamknuté skupiny parametrov sa nemenia; každý výsledok rešpektuje platné rozsahy a vytvorí počuteľný patch; A/B náhľad neprepíše originál.

## R5 — Preset browser a audition

Zlepšiť nájdenie a porovnanie zvuku skôr, než sa výrazne zväčší factory banka.

- Prehľadávať podľa hudobnej roly, nálady, energie a zdrojového typu.
- Doplniť obľúbené, nedávne a podobné zvuky; využiť existujúce `src/presets/similar.ts` a `src/sample-library/audio-index.ts`, kde ich dátový kontrakt sedí.
- Umožniť krátko zahrať alebo vypočuť preset bez straty aktuálnej práce.
- Porovnávať preset s aktuálnym patchom cez A/B; jasne ukázať, či výber mení celý patch alebo len zdroj.
- Udržať rýchle hľadanie aj pri väčšej knižnici a nenačítavať všetky audio zdroje do pamäte naraz.

**Brána:** vyhľadanie, filtrovanie, preview a návrat k pôvodnému patchu nemenia projekt; metadáta aj podobnosť sú deterministické; pri výbere presetu sa používateľ nestratí v aktuálnom kontexte.

## R6 — ORBIT performance surface

Pridať zapamätateľnú plochu pre výrazovú hru. „ORBIT“ je pracovný názov; pred UI implementáciou sa môže zmeniť.

- Jedna 2D plocha X/Y ovláda používateľom zvolené ciele, napríklad morph, cutoff, wavetable position alebo intenzitu modulácie.
- Ponúknuť niekoľko jasných predvolieb mapovania a vlastné priradenia; nepreplniť plochu malými ovládačmi.
- Pohyb možno nahrať ako projektovú automatizáciu a spätne upraviť v existujúcom KYX workflowe.
- Podporiť myš, dotyk, klávesnicu a po dohode MIDI kontrolér; UI nie je zdrojom pravdy pre audio callback.
- Uložiť mapovanie do presetu, aby sa performance správanie prenieslo spolu so zvukom.

**Brána:** pohyb ovplyvní zvuk s nízkou odozvou; nahratá automatizácia sa uloží, prehrá a vyrenderuje; projekty zostanú deterministické; používateľ vie obnoviť pôvodné mapovanie.

## R7 — Hlbší zdrojový engine

Najväčšiu novú zvukovú schopnosť budovať po tom, ako bude stabilná knižnica zdrojov a máme merací základ pre CPU.

### Plný granulárny režim

- Nahradiť skenovanie jednej pozície ohraničeným cloudom prekrývajúcich sa grainov.
- Hudobne zrozumiteľne ovládať veľkosť, hustotu, pozíciu, ladenie, jitter a tvar okna.
- Seedovať náhodné rozhodnutia, aby rovnaký projekt a udalosť dali rovnaký render.
- Ošetriť transienty, dlhé textúry aj ladený materiál; zachovať sampler a wavetable ako užitočné alternatívy.
- Pred rozšírením hlasov alebo parametrov zmerať alokácie, kvantovú prácu, CPU a správanie pri kradnutí hlasov.

### Ďalšie techniky podľa potreby

Stereo vzorky a loop/zónová práca, ďalšie filtre, waveshaping alebo FM rozšíriť iba vtedy, ak používateľské scenáre ukážu jasný prínos a výkonové merania ich podporia. Každá nová technika má dostať vlastné zvukové vektory a jasné ovládače.

**Brána pre granular:** opakovateľné golden audio vectors pre ladený, transientný aj textúrny materiál; rovnaký interpretačný a event systém pre realtime aj offline; konečná cena CPU a pamäte pri dohodnutej polyfónii; žiadne alokácie bez hornej hranice v `process()`.

## R8 — MIDI, performance a rozšírenie banky

Po stabilizovaní zdrojov, modulácie a browsera doplniť výkonové workflowy a rozšíriť obsah.

- Preskúmať MIDI learn pre makrá a kľúčové parametre, vrátane uloženia mapovania do patcha.
- Doviesť pressure/MPE cestu od vstupu cez nahrávanie a prehrávanie až po offline render.
- Využiť KYX track groups pre vrstvenie a rozdelenie nástrojov; nebudovať v TSAR paralelný multitimbrálny aranžér.
- Rozšíriť factory banku až po stabilizácii zdrojov, mutácií a audition workflowu. Cieľom je odlišnosť a užitočnosť presetov, nie samotný počet.
- Pri factory audiu uchovať pôvod, licenčný stav a spôsob distribúcie.

**Brána:** mapovanie prežije uloženie a znovuotvorenie projektu; MIDI zmena počuteľne zasiahne práve hrajúci patch a export; factory banka prejde automatickou kontrolou parametrov a počuteľnosti aj kurátorskou kontrolou rozdielov.

## Spoločné akceptačné pravidlá

Každá fáza musí rešpektovať tieto projektové invarianty:

- DSP beží v AudioWorklete a načítava sa iba tam, kde ho projekt potrebuje.
- UI vydáva intent cez commands; projektový model zostáva pravdou a každá úprava podporuje undo/redo.
- Realtime a offline používajú rovnaký TSAR procesor a význam udalostí.
- Náhodnosť má seed; rovnaký vstup a nastavenia sú opakovateľné.
- Každý viditeľný ovládač má merateľný zvukový účinok alebo je zrozumiteľne označený ako nedostupný.
- Factory zvuk má zdokumentované práva; user audio zostáva v lokálnom workflowe.
- Počet presetov, nástrojov a ďalšie canonical counts sa menia iba v [CURRENT-STATE.md](CURRENT-STATE.md) a musia byť overiteľné v repozitári.

## Odporúčaný postup pri implementácii

1. Dokončiť R1 a odstrániť všetky známe rozdiely medzi ovládačmi, projektom a runtimeom.
2. Rozhodnúť a zapísať kontrakt pre zdroje v R2; migráciu schémy pripraviť pred prvým ukladaním nového tvaru.
3. Na tejto vrstve postaviť preview a viac výstupov Forge (R3).
4. Pridať Mutations (R4) a dokončiť preset audition/search (R5); tieto dve fázy môžu napredovať čiastočne paralelne po stabilizovaní R1.
5. Dodať ORBIT (R6) až po ustálení cieľov modulácie a cesty projektovej automatizácie.
6. Zmerať granulárny engine a jeho náklady pred implementáciou plného cloudu (R7).
7. Odomknúť MIDI workflow a rast banky (R8) podľa toho, čo ukážu predchádzajúce fázy.

Pri začatí každej fázy vytvoriť konkrétne úlohy z jej brány, prečítať súvisiace ADR a checklisty, a po dokončení aktualizovať dokumentáciu o tom, čo bolo skutočne dodané a zmerané. Táto roadmapa je návrh poradia; nevydáva nedokončené schopnosti za hotové.
