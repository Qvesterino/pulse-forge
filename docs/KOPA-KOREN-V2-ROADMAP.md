# KOPA + KOREŇ — V2 backlog

**Stav:** implementácia prebieha; typecheck, oba worklet buildy a loudness merania prešli, regresné DSP merania ešte zostávajú · **Aktualizované:** 2026-10-11  
**Rozsah:** KOPA je kick-design inštrument; KOREŇ je samostatný Bass Harmonic Processor insert.  
**V1 kontext:** [historický implementačný plán](KOPA-KOREN-IMPLEMENTATION-PLAN.md), [ADR 0034 — KOREŇ](adr/0034-koren-bass-harmonic-exciter.md), [ADR 0035 — KOPA](adr/0035-kopa-kick-designer.md), [ADR 0036 — KOPA harmonics](adr/0036-kopa-bass-harmonic-layer.md).  
**Povinná DSP brána:** [NEW-EFFECT-CHECKLIST.md](NEW-EFFECT-CHECKLIST.md).

## Produktové rozdelenie

- **KOPA** navrhuje nový kick. Jej `KICK HARM` vrstva patrí dovnútra nástroja, pretože sleduje známu fázu a pitch sweep jeho tela.
- **KOREŇ** spracúva už existujúci basový signál. Fundament odhaduje z audia, sleduje jeho harmonický deficit a dopĺňa len to, čo vstup nemá.
- Môžu sa použiť spolu. KOREŇ nesmie byť podmienkou dobrého zvuku KOPA a KOPA harmonics nesmú nahradiť všeobecný tracker KOREŇA.
- V2 znamená predvídateľný, merateľný a dobre ovládateľný zvuk v projekte aj exporte. Neznamená to automaticky ďalšie parametre.

## P0 — dokončiť pred označením V2

### KOPA

- [ ] **Zjednotiť velocity law medzi workletom a fallbackom.** Implementácia teraz aplikuje velocity raz na celý hlas a velocity modulation číta samostatnú hodnotu; fallback už velocity po druhý raz neaplikuje na click/harmonics. Zostáva pinovať RMS aj pomer click/body/harmonics pri velocity 0.2, 0.5 a 1 na oboch cestách.
- [ ] **Zadefinovať zmluvu fallbacku.** Fallback teraz pokrýva pitch envelope, body waveform/hollow, tuning, click typy, harmonics a drive/punch. Stále treba zmerať všetky ovládače a rozhodnúť, ako používateľovi priznať rozdiely oproti workletu (najmä mod matrix a stereo spread).
- [ ] **Zmerať presety cez skutočný KOPA worklet.** Loudness harness načíta lazy worklet a pred exportom nasadí offline event queue. Všetkých 16 presetov už má zmeraný LUFS priamo cez worklet (−32.6 až −24.8 LUFS pred korekciou; automatická korekcia −2.5 až +2.6 dB). Ešte zmerať peak/headroom a vzájomnú použiteľnosť presetov; native fallback ponechať ako samostatnú metriku.
- [ ] **Uzavrieť MIDI a one-shot kontrakt.** `TRIGGER` teraz ponúka `ONE SHOT` (dohrá obálku) a `GATED` (existujúce `noteOff` choke správanie, predvolená kompatibilná voľba). Otestovať krátke MIDI noty, oba režimy, choke, retrigger a voice-steal bez klikov či useknutého tailu.
- [ ] **Prejsť parameter route od UI po DSP.** Každý viditeľný parameter musí mať zhodný rozsah/default v definícii, sanitizáciu v DSP, živú zmenu aj zmysluplný rozsah účinku. Zapísať testovateľný dôkaz, že minimum a maximum menia určenú zvukovú metriku.

### KOREŇ

- [ ] **Dokončiť celý kontrakt parametrov.** `presence` je teraz zapojená v parametroch, AudioParam wrapperi, DSP aj factory presetoch a zobrazuje sa v prvom pohľade. Zostáva per-parameter sweep/golden dôkaz, že oba limity hýbu správnym spektrálnym cieľom a že automatizácia aj low-sample-rate graf fungujú.
- [ ] **Zvýšiť istotu pitch trackingu bez falošných partialov.** Zostaviť vstupnú testovaciu sadu: čistá 808, silná 2. a 3. harmonická, pitch glide, krátke kicky, ticho/šum, stereo out-of-phase bas a kick súčasne s basou. Zmerať detekčnú chybu, čas lock/unlock a úroveň syntézy pri strate confidence. Pri nejasnom fundamentе má efekt harmoniky bezpečne stiahnuť, nie hádať oktávu.
- [ ] **Doplniť hysterezis a plynulé odomknutie.** Generátor teraz začne uvoľňovať starý koreň po dvoch neúspešných detekčných oknách; UI ukazuje `LOCKED`/`HOLD`/`SEARCH` a confidence. Zmerať, že prechod nerobí pumpovanie/chvenie a doladiť hold/release podľa corpus testov.
- [ ] **Zabezpečiť generátor proti aliasingu a nebezpečným sample rate.** Partialy sa teraz plynulo stlmia od 0.42× do 0.48× sample rate. Zmerať `range`/`f0`/sample-rate sweep vrátane SAT/FOLD charakteru; oversampling/ďalší anti-aliasing pridávať až keď meranie ukáže potrebu a CPU budget to dovolí.
- [ ] **Zmerať gain a mono kompatibilitu.** FX loudness meter už zmeral 4 factory KOREŇ presety (korekcie −0.6 až +3.5 dB). Ešte porovnať bypass/wet na level-matched nastavení a zmerať sub energiu, pásmo 120–350 Hz, telefónnu oblasť a mono fold-down pri `mix`, `subAnchor`, `width`, `presence` a výstupe. „PHONE READY“ má znamenať viac čitateľného basu bez nečakaného skoku hlasitosti alebo vymazania subu.
- [ ] **Spriehľadniť stav trackera v paneli.** Vizuálne rozlíšiť „zamknutý fundament“, „hľadám tón“ a „mimo tracking okna“; ukázať confidence, nie iba odhad Hz. Keď sa nič nesyntetizuje, meter nesmie vyzerať, akoby efekt stále generoval harmoniky.
- [ ] **Zmerať realtime rozpočet.** Soak/CPU meranie na 44.1/48/96 kHz a stereo v najdrahšom nastavení (`range`, width, key mode). KOREŇ musí bezpečne stíhať AudioWorklet deadline bez alokácií v `process()` a bez telemetry prevádzky závislej od otvoreného panelu.

## P1 — kvalita a pracovný tok

### KOPA

- [ ] **Preskúmať pitch, tuning a low-end na reálnych mierkach.** Zamerať sa na extrémny pitch sweep, `bodyTune`/`tailTune`/`subTune`, kicky ladené ku konkrétnej tónine a ich mono fázu. Pridať spektrálne merania pre prvý transient aj neskorý tail; potvrdiť, že sub sa pri ladení neodpojí od tela.
- [ ] **Otestovať aliasing všetkých drive kriviek.** Sweepnúť pitch, drive a sample rate, porovnať alias energiu a CPU. Ak je problém počuteľný/merateľný, zvoliť najlacnejšiu vhodnú metódu (napr. oversampling alebo band-limited tvarovanie) a stanoviť bundle/CPU limit.
- [ ] **Zlepšiť prvý pohľad a audition.** Z hlavnej plochy spraviť rýchly kick workflow: najdôležitejšie makrá, zrozumiteľne oddelený click/body/sub/tail, ladenie a okamžitý preview. Pokročilé ladenie obálok môže zostať v detailoch; nepridávať ďalšie DSP ovládače len na zaplnenie panelu.
- [ ] **Doplniť preset coverage podľa použitia.** Presety majú reprezentovať krátky punch, trap/808, drill, techno/909, čistý sub a telefónnu čitateľnosť. Každý preset musí byť unikátny v meranom zvuku, nie iba v číslach parametrov; normalizovať ich na porovnateľný vnímaný level.
- [ ] **Zvážiť velocity-sensitive timbre až po P0.** Ak sa ukáže, že velocity má hudobne meniť click/body, navrhnúť túto krivku vedome a pinovať spektrom. Inak zachovať jednoduché velocity = hlasitosť.

### KOREŇ

- [ ] **Validovať na rôznych zdrojoch a aranžmánoch.** Mono 808, syntetický sub, sampled bass, gliss, kick+808 a basová linka v mixe. Nastaviť, kde je efekt určený na použitie a kde má radšej ticho odhadnúť ako pridať nesprávny tón.
- [ ] **Ujasniť pomenovania a signálový model ovládačov.** Najmä `lowCut`, `subAnchor` a `mix`: dokumentácia/panel majú presne vysvetliť, čo sa deje s pôvodným suchým signálom a čo s wet sub vetvou. Ak ovládače vytvárajú ťažko predvídateľnú hlasitosť, zmeniť ich mapovanie alebo copy až po audio/null testoch.
- [ ] **Doplniť bezpečné porovnanie A/B.** PHONE CHECK ponechať ako monitor-only; pridať level-matched bypass/wet audition tak, aby zmena hlasitosti nepredstierala zlepšenie. Potvrdiť, že monitor filtre a A/B nezasahujú do exportu ani projektovej state.
- [ ] **Urobiť presety podľa cieľa, nie podľa DSP názvu.** Napr. `808 Phone`, `Sub Anchor`, `Drill Presence`, `Kick Duck` — každý s opisom, vhodným vstupom, nameraným gainom a overením, že preset neprebije už harmonicky bohatý signál.
- [ ] **Rozhodnúť, či `width` patrí predvolene na nulu.** Sub ostáva mono už dnes; overiť, či horné partialy rozšírené mimo stredu pomáhajú alebo len znižujú mono kompatibilitu. Zachovať konzervatívny default podľa testov a reálneho A/B.

## P2 — len ak merania ukážu prínos

- [ ] **KOPA:** ďalší click model (napr. impulse-train), samostatný transient shaper alebo ďalšie drive typy. Najprv dokázať, že ich nemožno spraviť existujúcimi click/drive vrstvami a že riešia reálnu medzeru v sound design-e.
- [ ] **KOREŇ:** adaptívny telefónny/formant cieľ, viac tracker režimov alebo viac generovaných partialov. Najprv potvrdiť prínos na tichom speaker-A/B a spektrálnych metrikách; viac harmoník samo o sebe nie je zlepšenie.
- [ ] **Oba:** AI auto-design/auto-setting až po stabilnom, vysvetliteľnom parametri a rozumných factory presetech. Model nesmie skrývať nejasný zvukový kontrakt.

## V2 akceptačné brány

- [ ] Každý parameter má dokázaný účinok na správny zvukový znak, sanitizáciu, automatizáciu a rozsah; bez mŕtvych alebo iba zobrazovaných knobov.
- [ ] KOPA: velocity/worklet/fallback kontrakt je zdokumentovaný; presety sú merané na worklet ceste; MIDI note-off, voice-steal, aliasing a loudness majú automatizované regresné pokrytie.
- [ ] KOREŇ: pitch-tracker corpus prejde bez oktávových skokov na podporovaných vstupoch; nejednoznačný signál harmoniky bezpečne utlmí; wet/sub/mono/gain a low-sample-rate správanie majú spektrálne merania.
- [ ] Obe cesty sú deterministické a export zdieľa tú istú DSP cestu ako live playback. Zmeny v KOREŇI spĺňajú `docs/NEW-EFFECT-CHECKLIST.md` a live/offline parity povinnosť.
- [ ] CPU, bundle a loudness limity sú zmerané. Každý nový preset je level-aware a každý nový parameter je zapojený vo všetkých registračných a UI vrstvách.
- [ ] Zmeniť `docs/CURRENT-STATE.md` len keď sa zmení zdokumentovaný počet alebo shipped povrch; ADR aktualizovať pri zmene architektonického kontraktu.

## Navrhované poradie

1. **V2.0 correctness:** KOPA velocity + note-off/fallback contract; KOREŇ kompletnosť param route a finálne rozhodnutie o `presence`.
2. **V2.1 sound quality:** KOPA worklet loudness/alias audit; KOREŇ tracker corpus, stale-lock a Nyquist safety.
3. **V2.2 workflow:** level-matched audition, stavové metery, KOPA preview/panel, kurátorované a zmerané presety.
4. **V2.3 experiments:** len tie P2 funkcie, ktorých prínos potvrdia merania aj počúvanie.

Každá fáza má vlastný reviewable diff a prejde príslušnými testami podľa `AGENTS.md` a `docs/NEW-EFFECT-CHECKLIST.md`. Tento dokument zatiaľ plánuje prácu; neznamená, že uvedené položky sú implementované alebo overené.
