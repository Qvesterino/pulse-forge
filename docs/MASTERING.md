# Mastering v KYX

Praktická príručka k master zbernici, meraniu, masteringovým efektom a exportu. Názvy tlačidiel a ovládacích prvkov uvádzam tak, ako sa zobrazujú v aplikácii.

> KYX ti dáva nástroje na úpravu a kontrolu finálneho mixu. Meter ani preset však nedokážu potvrdiť, že skladba znie dobre na každom systéme. Pred odovzdaním si export vypočuj a skontroluj aj v mono.

## Rýchla orientácia

- **MASTER** (Alt+9): finálny výstup, profily doručenia, master inserts a offline analýza.
- **MIX** (Alt+1): kanály, skupinové zbernice a hlavný MASTER strip s meraním.
- **DEV** (Alt+2): zariadenia a efektový reťazec vybratej stopy alebo zbernice.
- **EXP** (Alt+5): ostatné exporty, stemy, projektové súbory a záznam.

Master chain spracúva výstup projektu pri prehrávaní aj pri offline rendri. Zmeny v masteri preto ovplyvnia finálny export. MASTER otvoríš jedným klikom na dock záložku alebo skratkou **Alt+9**. V hornom prehľade **MASTER CHECK** nastav **Full song** na celý aranžmán alebo **Active pattern** na jeden priechod aktuálneho patternu. Tam nastavíš aj sample rate a kvalitu renderu.

Blok **Signal path** zobrazuje poradie vstavaných master stupňov, master insertov a výstupného metera. **Enabled**, **Unity / flat** a **Bypassed** opisujú uložené nastavenie projektu; ak engine nahlási fallback niektorého master insertu, blok ukáže aj stav **Degraded** s dôvodom. **Go to master inserts** presunie zobrazenie k ovládacím prvkom master racku.

## Odporúčaný postup

1. **Dokonči mix pred masterom.** Najprv vyváž hlasitosti a panorámu stôp, skontroluj basy a dozvuky. Ak musí master limiter sústavne výrazne uberať hlasitosť, vráť sa k mixu a nájdi najhlasnejšie stopy alebo skupiny.
2. **Vyber profil doručenia.** V MASTER meteri vyber **Streaming**, **Quieter / dynamic**, **Club / loud**, **Vinyl pre-master** alebo **Custom**. Profil mení len meracie ciele, nie zvuk. Sú to pracovné východiská, nie certifikácia služby. V režime Custom môžeš upraviť LUFS-I aj maximum dBTP. Profil Streaming vychádza z bežného cieľa −14 LUFS-I a −1 dBTP, ale nie je univerzálnou normou všetkých platforiem. Spotify navyše odporúča pri masteri hlasnejšom než −14 LUFS držať true peak pod −2 dBTP; KYX takúto situáciu zobrazí ako samostatné upozornenie. Hodnoty a správanie služby sme skontrolovali 6. 10. 2026 podľa [oficiálnych pokynov Spotify](https://support.spotify.com/us/artists/article/loudness-normalization/). Spotify normalizuje pri prehrávaní, s výnimkami podľa prehrávača a zariadenia, takže cieľ hlasitosti nie je zárukou rovnakej hlasitosti všade.
3. **Zmeraj celý track.** V hornom prehľade použi **ANALYZE FULL SONG**; tým sa vyrenderuje celý aranžmán v zvolenej kvalite a výsledok sa zobrazí bez stiahnutia súboru. Dlhé analýzy bežia v samostatnom workeri po malých chunkoch a bez druhej celkovej kópie PCM; ukazujú fázu a percentá a tlačidlo Cancel zastaví výpočet. Jeden beh má explicitný limit 12 hodín. Ešte pred alokáciou offline kontextu KYX odhadne stereo Float32 výstup a nad 320 MiB render odmietne s pokynom skrátiť výber alebo znížiť sample rate; ide o limit veľkosti výstupu, nie záruku celkovej spotreby pamäte. Živý LUFS-I môžeš merať aj počas prehrávania po **RESET INTEGRATED**. Pri tichu alebo príliš krátkom materiáli nemusí byť údaj merateľný. Ak analýzu zrušíš, KYX ju označí ako **cancelled** a zahodí neúplný report.
4. **Skontroluj úroveň a rezervu.** Sleduj true peak, indikátor CLIP a gain reduction. Tlačidlo **AUTO -6dB** nastaví vstup mastera tak, aby špičky mierili približne 6 dB pod zvolený strop. Je to nastavenie vstupnej rezervy, nie dorovnanie na LUFS cieľ.
5. **Uprav farbu a dynamiku len podľa potreby.** V paneli MASTER použi **Core master controls** pre vstavané IN, CEIL, TRIM, TILT, GLUE, TAPE, M/S a B-MONO ovládače. Rovnaké ovládače sú aj v master stripe v MIX a menia ten istý stav projektu. Podľa potreby pridaj efekt do master insert racku v MASTER paneli; inserty ležia po GLUE a pred vstavaným clipperom/limiterom. Po každej zmene znova počúvaj aj meraj; hlasnejšia verzia môže pri rýchlom A/B pôsobiť lepšie len preto, že je hlasnejšia.
6. **Vyrenderuj a skontroluj finálny súbor.** V hornom prehľade nastav **Studio HQ**, potom v **OFFLINE CHECK** vyber WAV a vhodnú bitovú hĺbku a stlač **EXPORT MASTER**. Report V8 oddeľuje meranie zdrojového PCM od dekódovaného WAV/MP3, ukladá profilový verdict a pomenúva svoj post-limiter/pre-encode merací tap. Zobrazuje sample peak, true peak v dBTP, RMS, LRA, krátkodobú loudness timeline, koreláciu, L/R balans, LUFS, mono kompatibilitu a Mix Doctor diagnostiku. LRA je doplnkový opis makrodynamiky podľa [EBU Tech 3342](https://tech.ebu.ch/docs/tech/tech3342.pdf), nie cieľ hlasitosti ani náhrada crest faktora; pri programe kratšom než 3 sekundy alebo bez merateľného signálu sa neuvádza. Timeline používa 3-sekundové okná s krokom 100 ms; dlhé skladby sa pre zobrazenie zhrnú do obmedzeného min/mean/max prehľadu. Pri mono alebo tichom zdroji stereo kontroly majú stav **N/A / NOT MEASURED**, nie fiktívne zelené skóre. Report obsahuje aj revíziu sample banku použitého pri rendri. Pred stiahnutím KYX overí hlavičku, pri WAV aj BWF metadáta a potom zmeria dekódovaný súbor, ak sa zmestí do pamäťového limitu browsera. Pri WAV nad 96 MiB alebo MP3 nad 12 MiB ukáže kontrolu hlavičky a dôvod, prečo post-encode audio meranie vynechal; pri veľkom MP3 označí dĺžku ako odhad z MPEG frame bitratu. Cez **DOWNLOAD REPORT JSON** môžeš uložiť sidecar s profilom, verziou KYX, metrikami, kontrolou súboru a varovaniami. Ak sa počas master renderu zmení sample bank, výsledok sa zahodí; neskoršia zmena banku report označí ako stale. Aj po technickej kontrole si celý master vypočuj. Ak prijmeš AUTO STAGE alebo MIX FIX, report sa označí za zastaraný — znova analyzuj a exportuj.

## Férové A/B porovnanie mastera

V časti **Core master controls** môžeš prepínať medzi jednoduchým a rozšíreným pohľadom. Jednoduchý pohľad ukazuje hlavné úrovňové ovládače **IN**, **TRIM**, **CEIL** a **LIMIT**. Pokročilé procesory a master inserts ostávajú aktívne podľa uložených nastavení, aj keď ich ovládače skryje jednoduchý pohľad. Rozšírený pohľad sprístupní všetky vstavané stupne a zariadenia; zmena v ňom upravuje ten istý stav projektu ako master strip v MIX.

V paneli MASTER otvor **Master A/B**. Pred úpravou stlač **Capture current** pri A, uprav master a ulož druhý stav do B. Snapshot zahŕňa celý master config vrátane profilu, master parametrov a insertov; je oddelený od Undo a platí iba v aktuálnom browser tab-e. KYX nemení projekt ani zdieľaný stav, keď snapshot vytvoríš.

Stlač **Render A/B**. Obe verzie sa renderujú z rovnakého SONG projektu pri zvolenom 44,1 alebo 48 kHz a kvalite Studio HQ. Výsledky sú dočasné a po zmene projektu, snapshotu alebo sample rate sa zahodia. Prehrávanie ide priamo do monitor výstupu, takže render sa druhý raz nespracuje aktívnym master chainom.

**Match audition loudness** dorovnáva podľa nameraného LUFS-I k tichšej z dvojice a hlasnejšiu verziu iba stíši. Pri každej verzii uvidíš použitý audition trim. Trim je len na porovnávací posluch: nemení master parametre, export ani uložené audio. Ak je jedna verzia tichá a LUFS-I sa nedá zmerať, matching sa pre ňu nepoužije.

**Live monitor bypass** v tom istom paneli prepne živý posluch na suchú cestu a späť plynulým krátkym crossfade. Obíde master input trim, farbu, glue, master inserts a clipper; suchá vetva sa časovo dorovnáva podľa nahlásenej latencie procesorov pred spoločným limiterom. Obe vetvy potom používajú ten istý limiter. Ak latencia prekročí rozsah dorovnania, blok **Signal path** ukáže stav **Degraded**. Je to monitorovacia kontrola — export naďalej používa uložený master chain.

### Master assistant

Klikni **Analyze master** na celú skladbu. KYX vykoná SONG render v Studio HQ a zmeria LUFS-I, true peak, crest, stereo koreláciu a podiel energie vo výškach. Zdieľaný deterministický planner MCP/UI navrhne ZENIT CEIL len vtedy, keď nameraný true peak prekročí zvolený limit o viac než 0,3 dB. Ostatné merania ostávajú diagnostické: samotná korelácia, LUFS, crest ani široké pásmové podiely neprezrádzajú bezpečnú opravu. Pri tichu alebo príliš krátkom vstupe sa návrh nevytvorí.

Každá karta ukazuje starú a novú hodnotu, merací dôkaz, dôvod, možný trade-off a nízku istotu všeobecného heuristického pravidla. Vyber návrhy a stlač **Render selected preview**. Draft sa vyrenderuje mimo projektu; jeho skutočné metriky sa zobrazia pred aplikovaním. **Play current** a **Play proposal** prepínajú medzi zdrojom a presnou navrhnutou verziou. **Match audition loudness** používa len dočasný monitor gain a nemení projekt ani export.

**Apply selected** a **Apply all** sú aktívne až pre kombináciu, ktorá prešla preview renderom. Zmena master insertov sa uloží ako jeden Undo krok a KYX vykoná nový post-apply render. **Reset to snapshot** vráti inserty do stavu zachyteného pred návrhom, pokiaľ sa projekt medzitým nezmenil. **Dismiss** nič nezapíše. Analýza a preview sa odmietnu ako stale, ak sa zmení projekt alebo obsah sample banku. Porovnávacie PCM buffery zdieľajú 320 MiB limit.

Asistent automaticky nevyvažuje stopy a nerobí z meraní certifikát kvality. Korelácia, spektrálny podiel, crest ani samotná LUFS odchýlka neodhaľujú príčinu problému; návrhy sú len štartovacie body. Pri novom clippe, fáze, basoch alebo ostrosti sa často treba vrátiť na konkrétnu stopu, potom znova zmerať celý master.

### Porovnanie s referenčným súborom

V sekcii **Compare with a reference track** môžeš načítať WAV alebo MP3 (max. 96 MiB). KYX pred dekódovaním overí kontajner a jeho deklarované kanály, sample rate a dĺžku, potom dekóduje audio, odmietne neplatné vzorky alebo neprimeranú pamäťovú náročnosť a zobrazí LUFS-I a true peak. Podporované sú mono aj stereo referencie; viac než dva kanály sa odmietnu. Importovaný originál sa nemení a uloží sa lokálne v prehliadači, oddelene od projektu.

Stlač **Render current master** a KYX vyrenderuje aktuálny projekt ako SONG v rovnakej sample rate a Studio HQ kvalite, akú používa A/B. Nastav zvlášť **Project start** a **Reference start**, potom prepínaj **Play project master** a **Play reference**. **Mono audition**, spoločný **Dim** a voľba **Match audition loudness** platia pre obe strany; match používa dočasný gain a hlasnejšiu stranu iba stíši. Ovládanie funguje aj cez bežnú klávesnicovú navigáciu.

Referenčný zvuk aj vyrenderovaný master idú priamo na monitor výstup, takže sa master chain nepoužije druhýkrát. Import, meranie aj render aktuálneho mastera majú stav a možno ich zrušiť; projektová alebo sample-bank zmena počas merania zahodí zastaraný výsledok. Referencia nie je audio stopa, nesynchronizuje projektový transport a nedostane sa do master ani stem exportu. Podporu ďalších vstupných formátov a plnohodnotný sync s transportom treba overiť alebo doplniť v ďalšej iterácii.

## Master strip a jeho ovládanie

Master strip sa nachádza v paneli **MIX**. Jeho hlavné ovládače upravujú spoločnú zbernicu, nie jednotlivé stopy.

| Ovládanie             | Čo robí                                                                                                                   | Praktické použitie                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **IN**                | Vstupná hlasitosť master chainu; rozsah približne od ticha po +6 dB.                                                      | Zníž ju pri preťažení alebo keď chceš viac rezervy. Zvýšenie zároveň viac budí následné procesory.           |
| **CEIL**              | Strop limitera, nastaviteľný od 0 do −12 dB. Predvolená hodnota je −1 dB.                                                 | Pre bežný digitálny export začni okolo −1 dB a over skutočný true peak po rendri.                            |
| **LIMIT**             | Zapína master look-ahead limiter s true-peak ochranou. Predvolene je zapnutý.                                             | Nechaj ho zapnutý ako ochranu pred špičkami; samotný limiter nenahrádza dobrý gain staging.                  |
| **CLIP**              | Zapína mäkký clipper, ktorý pridáva saturáciu a môže znížiť špičky za cenu zmeny charakteru zvuku. Predvolene je vypnutý. | Zapni ho len vtedy, keď chceš jeho zvuk. Pri porovnaní dorovnaj hlasitosť.                                   |
| **GLUE**              | Jemná kompresia spoločnej zbernice. Predvolene je zapnutá.                                                                | Použi ju na mierne zjednotenie mixu. Ak mix stráca údernosť alebo limiter pracuje viac, uber alebo ju vypni. |
| **TAPE / TAPE DRIVE** | Pásková saturácia a jej intenzita; štandardne je vypnutá.                                                                 | Jemné nastavenie môže pridať harmonické. Sleduj, či sa nemení bas a či nevzniká príliš veľa skreslenia.      |
| **B-MONO**            | Zúži nízke pásmo do mona pod nastaviteľnou frekvenciou 60–400 Hz; predvolená hranica je 120 Hz.                           | Pomáha stabilizovať subbas v strede. Po zapnutí over mono aj stereo obraz.                                   |
| **TILT**              | Mení tonálny sklon pomocou opačných nízkych a vysokých políc. Rozsah je −4 až +4 dB.                                      | Rob malé zmeny a porovnávaj ich pri rovnakej hlasitosti.                                                     |
| **TRIM**              | Dodatočný loudness gain pred limitujúcou časťou master chainu; rozsah v master stripe je ±6 dB.                           | Uprav ho po vyvážení mixu. Viac trimu môže znamenať viac práce pre limiter.                                  |

Master chain obsahuje aj korekčné a ochranné stupne. Tok zobrazený v **Signal path** je: **IN/TRIM → TAPE → M/S → B-MONO → DC filter → MATCH EQ → TILT → GLUE → MASTER INSERTS → CLIP → LIMIT → output meter**. Niektoré stupne ostávajú unity/flat, kým ich projekt alebo funkcia ako referenčné prispôsobenie nenastaví. Efekty na group/stem zbernici spracujú danú skupinu pred týmto globálnym stereo chainom.

**CEIL** riadi fyzický strop interného limitera. **MAX TP** v Custom profile je kontrolná hranica pre doručenie. Sú to samostatné hodnoty: zmena profilu alebo MAX TP sama neprepíše CEIL ani nezmení zvuk.

### Dva rôzne „AUTO“ kroky

- **AUTO -6dB** v master meteri nastavuje vstup tak, aby špičky zostali s rezervou pod limitom. Nerovná sa cieľu −14 LUFS.
- **AUTO STAGE** sa môže zobraziť po offline analýze alebo exporte mastera v MASTER/EXP. Vypočíta jedno vratné nastavenie master IN podľa nameranej hlasitosti, zvoleného LUFS cieľa a ceilingu. Zmenu musíš potvrdiť, znovu analyzovať a exportovať.
- **MIX FIX** sa zobrazí len vtedy, keď Mix Check navrhne jednu zo svojich obmedzených opráv, napríklad pri nízkych frekvenciách alebo preťažení. Aj po oprave export zopakuj. Návrh nemení aranžmán ani nenahrádza vlastné počúvanie.

## Čítanie master metera

| Údaj                      | Význam                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **LUFS-M**                | Momentálna vnímaná hlasitosť. Rýchlo reaguje na aktuálny zvuk.                                                  |
| **LUFS-S**                | Krátkodobá hlasitosť; je stabilnejšia než momentálna hodnota.                                                   |
| **LUFS-I**                | Integrovaná hlasitosť od posledného resetu. Pri rozhodovaní o celom tracku ju meraj počas celého prehratia.     |
| **TP**                    | True peak v dBTP. Odhaduje špičky medzi digitálnymi vzorkami, ktoré bežný sample peak nemusí ukázať.            |
| **GR**                    | Gain reduction hlavného limitera. Ukazuje, o koľko limiter práve uberá.                                         |
| **GLUE**                  | Gain reduction master kompresie.                                                                                |
| **L / R, RMS, peak hold** | Úrovne ľavého a pravého kanála, priemerná energia a podržaná špička.                                            |
| **×CORR**                 | Korelácia sterea: záporná hodnota upozorňuje na možný problém s fázou; veľmi široký materiál skontroluj v mono. |
| **MONO LOSS**             | Zmena úrovne po sčítaní sterea do mona. Strata pod −3 dB vyvolá varovanie; pod −6 dB je vážnejší problém.       |
| **HEAD**                  | Graf rezervy voči stropu limitera.                                                                              |

Meter dopĺňajú spektrálny analyzér, spektrogram, goniometer a história hlasitosti. Verdikt **READY**, **TOO LOUD**, **TOO QUIET**, **TRUE PEAK OVER**, **PHASE ISSUES** alebo **CHECK STEREO** je kontrolný signál, nie certifikát kvality. Pri zmene TARGET sa mení interpretácia hlasitosti; ostatné merania sa tým nemenia.

### Pojmy v skratke

- **LUFS** vyjadruje vnímanú hlasitosť. LUFS-I je najužitočnejší pri porovnaní celej skladby s cieľom.
- **dBFS** vyjadruje úroveň voči digitálnemu maximu. **dBTP** označuje true-peak odhad vrátane medzi-vzorkových špičiek.
- **Gain reduction (GR)** hovorí, koľko úrovne kompresor alebo limiter práve uberá.
- **Korelácia** a mono fold-down pomáhajú odhaliť prvky, ktoré sa pri prehrávaní v mono oslabia alebo vyrušia.

## ZENIT: vložiteľný masteringový strip

**ZENIT** je efekt, ktorý môžeš vložiť do efektového reťazca stopy alebo skupinovej zbernice. V paneli **DEV** pridaj ZENIT na vybraný kanál a jeho makrá dolaď v editore efektu. Na skupinovej zbernici ním spracuješ daný stem. Výstup tejto zbernice potom stále prechádza globálnym master chainom.

ZENIT skladá existujúce spracovanie v pevnom poradí:

**EQ → páskový drive → glue kompresia → šírka a mono basy → clipper → limiter**

| Makro                | Úloha                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| **LOW / MID / HIGH** | Korekcia nízkeho, stredného a vysokého pásma. Rozsah každého ovládača je ±6 dB.                    |
| **GLUE**             | Miera spoločnej kompresie.                                                                         |
| **DRIVE**            | Intenzita páskového skreslenia.                                                                    |
| **WIDTH**            | Stereo šírka; 100 % je neutrálna hodnota.                                                          |
| **BASS MONO**        | Frekvencia, pod ktorou sa bas zúži do mona; 0 znamená vypnuté.                                     |
| **CEIL**             | Strop clippera a limitera.                                                                         |
| **LIMIT**            | Miera zásahu limitera. Pri 0 leží jeho prah na nastavenom ceilingu; vyššie hodnoty ho tlačia viac. |

Factory presety zahŕňajú **Streaming −14**, **Club Push** a **Vinyl Safe**. Sú to východiskové nastavenia tvaru a dynamiky, nie automatické dorovnanie na uvedenú hlasitosť ani záruka pripravenosti pre platformu. Po výbere presetu zmeraj výstup. Ak používaš ZENIT na skupine, počítaj s tým, že globálny master limiter a glue spracujú jeho výstup ešte raz. Sleduj súčet gain reduction a nenechávaj dva limitery bez zámeru tvrdo pracovať naraz.

### Ďalšie masteringové efekty

V efektovom reťazci sú dostupné aj samostatné nástroje:

- **APEKS** — maximizer na zvýšenie hustoty/hlasitosti s ovládačmi DRIVE, CEIL, RELEASE, PRESERVE, MIX a OUTPUT. PRESERVE pomáha zachovať špičku úderu; vysoký DRIVE môže zvuk výrazne stlačiť.
- **ŠÍRKA** — stereo imager zvlášť pre nízke, stredné a vysoké pásmo. Hodnota 100 % je neutrálna; nízke pásmo môžeš zúžiť a vyššie pásma opatrne rozšíriť.
- **PRÚD** — dvojpásmový dynamický EQ, ktorý pásma pri prekročení prahu uberá. Hodí sa na sykavé, ostré alebo rezonujúce miesta, ktoré sa objavujú len pri hlasnejších úderoch.

Presety APEKS, ŠÍRKA a PRÚD sú štartovacie body. Pri šírke vždy skontroluj koreláciu a mono; pri dynamickom EQ nastav prah tak, aby efekt nereagoval stále; pri maximizeri vyhodnoť aj údernosť a skreslenie.

## Mix a referencie pred masteringom

**VLYX Mix Assist** pracuje s vyrenderovaným materiálom vybratej stopy a navrhuje zmeny pre jej mix. **REFERENCE MATCH** porovná tonálnu rovnováhu stopy s vybranou vzorkou alebo krivkou. Návrh si môžeš vypočuť, skontrolovať a až potom použiť; aplikácia ho zapíše ako vratnú zmenu. Sú to nástroje na prípravu mixu, nie automatický mastering finálneho stereo výstupu.

VLYX tiež ponúka **G-MATCH** na hlasitostne dorovnané porovnávanie pri úprave, čím znižuje riziko, že hlasnejšia verzia bude pôsobiť „lepšie“ len vďaka úrovni. Použi ho pri A/B porovnaní efektu.

## Export a kontrola výsledku

1. Otvor **MASTER** (Alt+9). V hornom prehľade zvoľ **Full song** pre finálny master alebo **Active pattern** pre rýchlu kontrolu jednej slučky.
2. V tom istom prehľade nastav **44,1/48 kHz** a **Studio HQ** pre finálny render; **Live (faster)** je rýchlejšia voľba. Obe možnosti používajú projektový renderer, ale Studio HQ môže použiť vyššiu kvalitu niektorých efektov.
3. V časti **OFFLINE CHECK** vyber **WAV (studio)**, MP3 192/320 na zdieľanie a bit depth WAV 16-bit PCM, 24-bit PCM alebo 32-bit float. **Use profile file settings** je výslovná akcia pre odporučený formát/hĺbku a nemení spracovanie zvuku. 16-bit WAV používa deterministický TPDF dither, 24-bit WAV ho nepoužíva a 32-bit float sa neditheruje.
4. Klikni hore **ANALYZE FULL SONG** na kontrolu bez sťahovania alebo nižšie **EXPORT MASTER** na render a stiahnutie. Offline render používa projektové nástroje a efekty a pridáva 2-sekundový dozvukový chvost.
5. V hornom prehľade sleduj čerstvosť reportu, LUFS-I odchýlku, dBTP rezervu, LRA, stereo/mono stav a počet nálezov. Zdrojové meranie označuje **SOURCE PCM · MASTER-OUTPUT · POST-LIMITER · PRE-ENCODE**; úspešná dekódovaná kontrola sa označí **FINAL FILE · POST-DECODE**. Ak dekódované audio nie je dostupné, zobrazí túto skutočnosť a nenechá PCM čísla pôsobiť ako kontrolu finálneho súboru. V detaile reportu pozri **PEAK**, **TRUE PEAK**, **RMS**, **LUFS-I**, **LRA**, **×CORR**, **MONO LOSS** a **GAIN VERDICT**. Prečítaj aj **MIX CHECK**. Report obsahuje rozsah a nastavenia behu a zneplatní sa po zmene projektu, cieľa alebo render nastavení.
6. Ak sa zobrazí **AUTO STAGE** alebo **MIX FIX**, rozhodni sa, či návrh chceš použiť. Potom znova analyzuj a exportuj. Ulož alebo odovzdaj až tú verziu, ktorú si aj vypočul.

Pre ďalšiu kontrolu môžeš exportovať **EXPORT STEMS** pre dostupné skupiny alebo **EXPORT ALL TRACKS**. Tieto stemy zachovajú track/group a routované return spracovanie, ale obídu globálny master chain; rešpektujú obsah stemu namiesto aktuálnych live mute/solo tlačidiel. Pomáhajú nájsť problematickú skupinu, nenahrádzajú kontrolu stereo mastera. Pred finálnym odovzdaním si vypočuj začiatok, najhlasnejšiu časť, koniec aj dozvuky a skontroluj prechod do mona.

## Platformové profily cez MCP

Nástroj `kyx_master` cez MCP zobrazuje pri operácii **status** globálny MASTER signal flow, profil, runtime fallbacky a aktuálny živý meter snapshot. Tento snapshot nie je analýza celej skladby; na plný report použi MASTER → **ANALYZE FULL SONG** alebo **EXPORT MASTER**. Ostatné operácie **platform**, **land**, **trim** a **assist** pracujú s profilmi a ZENIT zariadeniami. Master meter, exportný report a MCP používajú rovnaké profilové ciele a verdict pravidlá. MCP bez explicitného profilu použije profil uložený v projekte.

| Profil            | Predvolený cieľ hlasitosti | Predvolený limit true peak |
| ----------------- | -------------------------: | -------------------------: |
| Streaming         |                   −14 LUFS |                    −1 dBTP |
| Quieter / dynamic |                   −16 LUFS |                    −1 dBTP |
| Club / Loud       |                    −8 LUFS |                  −0,3 dBTP |
| Vinyl pre-master  |                   −12 LUFS |                    −2 dBTP |
| Custom            |         Projektové hodnoty |         Projektové hodnoty |

Všeobecne platí: odchýlka hlasitosti do ±1 LU prejde, do ±2 LU je upozornenie a väčšia odchýlka zlyhá. True peak do 0,3 dB nad limitom sa označí upozornením; väčšie prekročenie zlyhá. Nezmeraná hlasitosť sa nikdy neoznačí ako úspech. Záporná korelácia zlyhá a výrazný mono loss alebo L/R nerovnováha vyvolajú upozornenie.

Profily Streaming a ostatné sú orientačné workflow. Spotify uvádza −14 LUFS ako úroveň normalizácie prehrávania a odporúča true peak pod −1 dBTP pre lossy kódovanie; pri hlasnejšom masteri odporúča pod −2 dBTP. KYX preto pri LUFS-I vyššom než −14 a true peaku aspoň −2 dBTP pridá samostatné upozornenie. Tieto čísla nie sú všeobecnou normou pre všetky platformy. [Spotify: Loudness normalization](https://support.spotify.com/us/artists/article/loudness-normalization/), kontrolované 2026-10-06. Spotify prijíma WAV, ale preferuje FLAC pre lossless dodanie; KYX aktuálne exportuje WAV a jeho formát profilu je len praktické východisko, nie úplný distribučný brief. [Spotify: Lossless audio](https://support.spotify.com/us/artists/article/lossless-audio/). Vinyl profil je orientačný premaster: konkrétny cut priprav podľa požiadaviek masteringového alebo cutting inžiniera. Žiaden profil nenahrádza počúvanie ani kontrolu vyrenderovaného súboru.

Pri WAV masteri BWF v2 `bext` nesie integrovanú hlasitosť, LRA, maximum true peak, momentary a short-term maximum z **pred-encode PCM**. KYX zapisuje hodnoty podľa [EBU Tech 3285 v2](https://tech.ebu.ch/docs/tech/tech3285.pdf) s presnosťou 0,01; nedostupné hodnoty majú špecifikovaný sentinel. Export ich po zápise znovu načíta a porovná so zdrojovým meraním. Samostatné **POST-DECODE** hodnoty opisujú zakódovaný WAV po kvantizácii.

## Krátky kontrolný zoznam

- LUFS-I merané na celej skladbe po stlačení **RESET INTEGRATED**.
- True peak na alebo pod zvoleným ceilingom, s rezervou vhodnou pre cieľové médium.
- Bez aktívneho CLIP upozornenia; limiter ani clipper nemenia údernosť viac, než chceš.
- Bez závažného poklesu pri mono fold-down a bez zápornej stereo korelácie.
- Preset alebo automatický návrh po použití znovu zmeraný.
- Finálny WAV po exporte vypočutý od začiatku po dozvuk.
