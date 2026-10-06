# Mastering v KYX

Praktická príručka k master zbernici, meraniu, masteringovým efektom a exportu. Názvy tlačidiel a ovládacích prvkov uvádzam tak, ako sa zobrazujú v aplikácii.

> KYX ti dáva nástroje na úpravu a kontrolu finálneho mixu. Meter ani preset však nedokážu potvrdiť, že skladba znie dobre na každom systéme. Pred odovzdaním si export vypočuj a skontroluj aj v mono.

## Rýchla orientácia

- **MASTER** (Alt+9): finálny výstup, profily doručenia, master inserts a offline analýza.
- **MIX** (Alt+1): kanály, skupinové zbernice a hlavný MASTER strip s meraním.
- **DEV** (Alt+2): zariadenia a efektový reťazec vybratej stopy alebo zbernice.
- **EXP** (Alt+5): ostatné exporty, stemy, projektové súbory a záznam.

Master chain spracúva výstup projektu pri prehrávaní aj pri offline rendri. Zmeny v masteri preto ovplyvnia finálny export. MASTER otvoríš jedným klikom na dock záložku alebo skratkou **Alt+9**. V **OFFLINE CHECK** vyber **Arrangement (SONG)**, ak chceš analyzovať celú skladbu; **Active pattern** vyrenderuje jeden priechod aktuálneho patternu.

## Odporúčaný postup

1. **Dokonči mix pred masterom.** Najprv vyváž hlasitosti a panorámu stôp, skontroluj basy a dozvuky. Ak musí master limiter sústavne výrazne uberať hlasitosť, vráť sa k mixu a nájdi najhlasnejšie stopy alebo skupiny.
2. **Vyber profil doručenia.** V MASTER meteri vyber **Streaming**, **Quieter / dynamic**, **Club / loud**, **Vinyl pre-master** alebo **Custom**. Profil mení len meracie ciele, nie zvuk. Sú to pracovné východiská, nie certifikácia služby. V režime Custom môžeš upraviť LUFS-I aj maximum dBTP.
3. **Zmeraj celý track.** V **OFFLINE CHECK** použi **ANALYZE FULL SONG**; tým sa vyrenderuje celý aranžmán v zvolenej kvalite a výsledok sa zobrazí bez stiahnutia súboru. Živý LUFS-I môžeš merať aj počas prehrávania po **RESET INTEGRATED**. Pri tichu alebo príliš krátkom materiáli nemusí byť údaj merateľný.
4. **Skontroluj úroveň a rezervu.** Sleduj true peak, indikátor CLIP a gain reduction. Tlačidlo **AUTO -6dB** nastaví vstup mastera tak, aby špičky mierili približne 6 dB pod zvolený strop. Je to nastavenie vstupnej rezervy, nie dorovnanie na LUFS cieľ.
5. **Uprav farbu a dynamiku len podľa potreby.** Použi vstavané TAPE, TILT, GLUE alebo B-MONO a podľa potreby pridaj efekt do master insert racku v MASTER paneli. Inserty ležia po GLUE a pred vstavaným clipperom/limiterom. Po každej zmene znova počúvaj aj meraj; hlasnejšia verzia môže pri rýchlom A/B pôsobiť lepšie len preto, že je hlasnejšia.
6. **Vyrenderuj a skontroluj finálny súbor.** V **OFFLINE CHECK** použi **Studio HQ**, vyber WAV a vhodnú bitovú hĺbku a stlač **EXPORT MASTER**. Report oddeľuje meranie zdrojového PCM od dekódovaného WAV/MP3. Pred stiahnutím overí hlavičku, pri WAV aj BWF metadáta a potom zmeria dekódovaný súbor, ak sa zmestí do pamäťového limitu browsera. Pri WAV nad 96 MiB alebo MP3 nad 12 MiB ukáže kontrolu hlavičky a dôvod, prečo post-encode audio meranie vynechal; pri veľkom MP3 označí dĺžku ako odhad z MPEG frame bitratu. Cez **DOWNLOAD REPORT JSON** môžeš uložiť sidecar s profilom, verziou KYX, metrikami, kontrolou súboru a varovaniami. Aj po technickej kontrole si celý master vypočuj. Ak prijmeš AUTO STAGE alebo MIX FIX, report sa označí za zastaraný — znova analyzuj a exportuj.

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

Master chain obsahuje aj korekčné a ochranné stupne. Orientačný tok je: **IN/TRIM → TAPE → B-MONO a interné spracovanie → EQ/TILT → GLUE → MASTER INSERTS → CLIP → LIMIT → výstup a metering**. Niektoré stupne sú neutrálne, kým ich projekt alebo funkcia ako referenčné prispôsobenie nenastaví.

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

1. Otvor **MASTER** (Alt+9) a nastav **SOURCE** na **Arrangement (SONG)**.
2. Pre finálny digitálny master vyber **WAV (studio)**. KYX ponúka 44,1 alebo 48 kHz a pri WAV 16-bit PCM, 24-bit PCM alebo 32-bit float. MP3 192/320 je k dispozícii na zdieľanie.
3. Vyber **Studio HQ** pre finálnu analýzu/render; **Live (faster)** je rýchlejšia voľba. Obe možnosti používajú projektový renderer, ale Studio HQ môže použiť vyššiu kvalitu niektorých efektov.
4. Klikni **ANALYZE FULL SONG** na kontrolu bez sťahovania alebo **EXPORT MASTER** na render a stiahnutie. Offline render používa projektové nástroje a efekty a pridáva 2-sekundový dozvukový chvost.
5. V reporte pozri **PEAK**, **TRUE PEAK**, **RMS**, **LUFS-I**, **×CORR**, **MONO LOSS** a **GAIN VERDICT**. Prečítaj aj **MIX CHECK**. Report obsahuje rozsah a nastavenia behu a zneplatní sa po zmene projektu, cieľa alebo render nastavení.
6. Ak sa zobrazí **AUTO STAGE** alebo **MIX FIX**, rozhodni sa, či návrh chceš použiť. Potom znova analyzuj a exportuj. Ulož alebo odovzdaj až tú verziu, ktorú si aj vypočul.

Pre ďalšiu kontrolu môžeš exportovať **EXPORT STEMS** pre dostupné skupiny alebo **EXPORT ALL TRACKS**. Stemy pomáhajú nájsť problematickú skupinu; nenahrádzajú kontrolu stereo mastera. Pred finálnym odovzdaním si vypočuj začiatok, najhlasnejšiu časť, koniec aj dozvuky a skontroluj prechod do mona.

## Platformové profily cez MCP

Rozšírený nástroj `kyx_master` poskytuje cez MCP profily a operácie **platform**, **land**, **trim** a **assist**. Master meter, exportný súhrn a MCP používajú rovnaké ciele a tolerancie. MCP bez explicitného profilu použije profil uložený v projekte.

| Profil            | Predvolený cieľ hlasitosti | Predvolený limit true peak |
| ----------------- | -------------------------: | -------------------------: |
| Streaming         |                   −14 LUFS |                    −1 dBTP |
| Quieter / dynamic |                   −16 LUFS |                    −1 dBTP |
| Club / Loud       |                    −8 LUFS |                  −0,3 dBTP |
| Vinyl pre-master  |                   −12 LUFS |                    −2 dBTP |
| Custom            |         Projektové hodnoty |         Projektové hodnoty |

Všeobecne platí: odchýlka hlasitosti do ±1 LU prejde, do ±2 LU je upozornenie a väčšia odchýlka zlyhá. True peak do 0,3 dB nad limitom sa označí upozornením; väčšie prekročenie zlyhá. Nezmeraná hlasitosť sa nikdy neoznačí ako úspech. Záporná korelácia zlyhá a výrazný mono loss alebo L/R nerovnováha vyvolajú upozornenie.

Profily Streaming a ostatné sú orientačné workflow. Spotify momentálne uvádza −14 LUFS ako úroveň normalizácie prehrávania a odporúča maximum −1 dBTP pre lossy kódovanie; hlasnejšie masterované skladby odporúča držať pod −2 dBTP. Tieto čísla nie sú všeobecnou normou pre všetky platformy. [Spotify: Loudness normalization](https://support.spotify.com/artists/article/loudness-normalization/). Vinyl profil je orientačný premaster: konkrétny cut priprav podľa požiadaviek masteringového alebo cutting inžiniera. Žiaden profil nenahrádza počúvanie ani kontrolu vyrenderovaného súboru.

## Krátky kontrolný zoznam

- LUFS-I merané na celej skladbe po stlačení **RESET INTEGRATED**.
- True peak na alebo pod zvoleným ceilingom, s rezervou vhodnou pre cieľové médium.
- Bez aktívneho CLIP upozornenia; limiter ani clipper nemenia údernosť viac, než chceš.
- Bez závažného poklesu pri mono fold-down a bez zápornej stereo korelácie.
- Preset alebo automatický návrh po použití znovu zmeraný.
- Finálny WAV po exporte vypočutý od začiatku po dozvuk.
