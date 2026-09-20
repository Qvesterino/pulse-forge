# Effect Intent Engine — implementačná roadmapa

**Status:** implementácia — prebieha · **Dátum:** 2026-09-20 · **Priorita:** P1 produkt, P0 bezpečnosť dát
**Rozsah:** prirodzeným jazykom navrhovať bezpečné zmeny parametrov existujúcich FX zariadení v Pulse Forge  
**Princíp:** offline-first, deterministické plánovanie, používateľ schvaľuje každú zmenu

---

## 1. Produktový cieľ

Používateľ vyberie konkrétny efekt alebo plugin a povie napríklad:

> „Trochu to zohrej, ale nechaj výšky a stereo tak.“

Pulse Forge má:

1. pochopiť zvukový zámer a jeho obmedzenia;
2. zistiť, ktoré parametre vybraného zariadenia tento zámer vedia bezpečne ovplyvniť;
3. pripraviť konkrétny, vysvetlený návrh zmien;
4. umožniť jeho vypočutie a porovnanie s originálom;
5. zapísať schválený výsledok ako jednu vratnú operáciu.

Výsledkom nemá byť „AI, ktorá hýbe gombíkmi“. Má to byť **hudobný FX asistent**, ktorého návrhy sú pochopiteľné, obmedzené skutočnou schémou zariadenia, vratné a funkčné bez internetu.

### Produktové pravidlo

Model alebo parser môže navrhnúť **zvukový cieľ**. Iba deterministický, verzovaný planner môže tento cieľ preložiť na parametre. Iba explicitné potvrdenie používateľa môže zmeniť projektový dokument.

---

## 2. Rozsah prvej verzie

### V1 zahŕňa

- existujúce vstavané efekty v racku;
- interné flagship zariadenia, keď ich parametre prejdú cez schválený adapter;
- začiatok z kontextu jedného konkrétneho effect instance — nie nejednoznačné „uprav mi celý track“;
- ciele ako teplejšie/tmavšie/jasnejšie, viac-menej priestoru, jemne viac drive a neskôr stereo/dynamics;
- malé, konzervatívne zmeny s vysvetlením každého parametra;
- offline návrh, diff, undo a testovanú obnovu pôvodného stavu;
- Slovenské a anglické formulácie najčastejších zámerov; nepodporovaný alebo nejasný výraz sa nesmie potichu hádať.

### V1 výslovne nezahŕňa

- hostovanie ľubovoľných používateľských VST/AU pluginov — v aktuálnom kóde sa nenašiel generický hostiteľský kontrakt;
- automatické pridávanie/odstraňovanie efektov, prepájanie routingu alebo zmenu bypassu;
- automatické úpravy viacerých zariadení naraz;
- voľné AI zapisovanie čísel do `EffectInstance.params`;
- cloud request ako podmienku fungovania;
- tvrdenie, že „teplejšie“ alebo „profesionálnejšie“ má jednu univerzálne správnu číselnú definíciu.

Master chain, automatizácia, viac-trackové mixovanie a tvorba celých presetov sú samostatné rozšírenia po úspešnom V1.

---

## 3. Overený základ v projekte

Pri plánovaní bol v aktuálnom zdrojovom kóde potvrdený tento reuse potenciál:

- `src/effects/types.ts` už definuje `ParamDef` s ID, názvom, rozsahom, defaultom, jednotkou, možnosťami a prípadnou log taper krivkou.
- `src/effects/registry.ts` je autorita pre vstavané efekty, ich defaulty, clampovanie a runtime factory.
- `src/project-model/targets.ts` už skladá katalóg parametrov aj pre hlboké FXEQ/Ultina/Ozvena schémy, najmä pre automatizáciu a makrá.
- `src/project-model/types.ts` uchováva effect instance a jeho parametre ako serializovateľný stav projektu.
- `src/commands/commands.ts` už má rozdielne validované write paths pre bežné efekty, FXEQ, Ultina a Ozvena; apply operácie môžu byť undoable a kolaboračné.
- `src/ui/EffectRack.tsx` poskytuje kontext vybraného tracku/zariadenia, jeho parameter editor, presety a existujúce proposal flow pre niektoré flagship pluginy.
- `src/intent/mix.ts` mapuje hudobný intent na deterministický mix profil; je to užitočný precedens, nie hotový univerzálny FX planner.
- Ultina má samostatný audio-analysis/proposal systém v `src/effects/ultina-core/analysis/`.

### Medzery, ktoré roadmapa rieši

- Súčasné `ParamDef` opisuje najmä technický rozsah. Samo osebe nehovorí, čo znamená „teplejší“, „širší“, „menej ostrý“, aký smer parametra to dosahuje ani s čím je jeho zmena v konflikte.
- Rôzne zariadenia majú rozdielne schémy a write paths; generický editor-parametre neznamená generický bezpečný AI-parametre.
- Súčasný hudobný Intent Engine a `planMixProfile` neriešia výber konkrétneho FX instance, prirodzený jazykový návrh preň ani neperzistentné audio preview.
- Pluginové enumy, hlboké cesty, band-aware parametre a moduly potrebujú zariadeniovo špecifickú validáciu.
- V projekte je rozsiahly rozpracovaný stav mimo tejto úlohy. Táto roadmapa je nový samostatný dokument a nepredpisuje meniť existujúce rozpracované zmeny.

---

## 4. Základný workflow a pravidlá správania

1. Používateľ otvorí **Ask FX / Upraviť zvuk** na konkrétnom zariadení. Zariadenie je explicitný target.
2. Zadá cieľ a prípadne intenzitu/obmedzenia: „jemne jasnejšie, bez pridania drive“.
3. Engine vráti stav: `ready`, `needsClarification`, `unsupported` alebo `rejected` — nikdy falošný úspech.
4. Návrh zobrazí parametre `pred → po`, dôvod, očakávaný účinok, intenzitu/riziko a obmedzenia.
5. Používateľ môže návrh vypočuť, upraviť intenzitu, odmietnuť ho alebo ho prijať.
6. Prijatie zapíše všetky zmeny **jedným undo krokom**; zrušenie preview obnoví presný pôvodný zvukový aj dokumentový stav.

Ak sa projekt alebo daný plugin zmení medzi návrhom a prijatím, návrh sa označí ako zastaraný a musí sa prepočítať alebo explicitne znovu potvrdiť. Nikdy sa nesmie potichu aplikovať na iný stav.

---

## 5. Cieľová architektúra

```text
Text + vybrané zariadenie + aktuálny stav
                  │
                  ▼
     Parser / voliteľný AI interpreter
                  │  kanonický zámer, nikdy parametre
                  ▼
        EffectIntentSpec v1
                  │
                  ▼
  Descriptor catalog + device adapter
                  │
                  ▼
  Deterministický proposal planner
                  │
                  ▼
 Validácia, constraints, stale-state hash
                  │
                  ▼
 Diff + neperzistentné audio audition
                  │ explicitné Apply
                  ▼
 Existujúci command/store/undo/Yjs tok
```

### Navrhované doménové kontrakty

Názvy sú pracovné; konkrétne typy sa v implementačnej fáze prispôsobia štýlu projektu.

- `EffectTargetRef`: `trackId`, `fxId`, `effectType` a verziu/schema identity target zariadenia.
- `EffectIntentSpec`: verzia, normalizovaný cieľ (`warmth`, `brightness`, `space`, …), smer, intenzita, explicitné zachovávacie obmedzenia a voliteľné parser provenance.
- `EffectParameterDescriptor`: kanonické ID, label, typ (`continuous`, `enum`, `toggle`), rozsah/default/unit, taper alebo mapovanie na perceptuálny priestor, podporované ciele, preferovaný smer, konzervatívne delta limity, risk, interakcie a zdroj schémy.
- `EffectChangeProposal`: target, `baseStateHash`, zmeny `{paramId, before, after, rationale}`, sumarizácia, warningy, confidence, `plannerId/version` a validácia. Je to obyčajný serializovateľný návrh, nie command ani mutovaný dokument.
- `EffectIntentResult`: rozlíšené výsledky `ready`, `needsClarification`, `unsupported`, `noChange`, `stale` a `rejected` s pravdivou diagnostikou.

**Neukladať** parser state, UI state ani proposal do `EffectInstance.params` alebo project modelu pred Apply.

### Device adapter kontrakt

Každé zariadenie dostane adapter, ktorý vie:

- načítať aktuálny canonical stav a platný katalóg parametrov;
- preložiť parametre a enumy do jednotného descriptor modelu;
- validovať a clampovať hodnoty cez pôvodnú autoritatívnu schému;
- vyrobiť jeden project command pre celý proposal;
- vysvetliť nepodporované parametre a starú/neplatnú schema verziu.

Neprehľadávať ľubovoľné objektové kľúče a nepovažovať „parameter existuje v uložených dátach“ za oprávnenie meniť ho.

---

## Fáza 0 — Baseline, hranice a bezpečný pilot

**Priorita:** P0 · **Závisí od:** nič

### Úlohy

- [x] Zaznamenať aktuálny command → store → runtime → offline render tok pri editácii FX parametra.
- [ ] Inventarizovať effect types, parametre, enumy, deep schemas, write commands, pluginové A/B/preview schopnosti a existujúce assistant proposals.
- [x] Pokryť v deterministickom report-e všetky effect types, technické descriptor count-y podľa source, deep schema counts a aktuálne write/preview adaptery; hlavné command/A-B/proposal hranice sú zaznamenané nižšie.
- [x] Určiť aktuálnu hranicu podpory: sémanticky iba EQ/Reverb; deep flagship katalógy sú zatiaľ read-only a každý ďalší write path potrebuje explicitný adapter.
- [ ] Zafixovať východiskové audio/project fixture pre vybraný pilot.
- [x] Vybrať vertikálny pilot: vstavaný `eq` a `reverb`; ďalší flagship až po zavedení a overení adaptera.
- [x] Zaznamenať, že aktuálny flow mení iba jeden existujúci effect instance a iba jeho navrhnuté parametre; routing/bypass/topológia nie sú súčasťou Apply.
- [ ] Overiť, že nový kód neprepisuje aktuálne necommitnuté zmeny.

### Baseline tok overený v kóde

1. `EffectIntentAssistant` drží proposal mimo projektu. Preview volá `AudioEngine.beginEffectIntentPreview` iba pre vybrané parametre; pri zmene projektu/targetu, spustení transportu alebo zatvorení assistant-a preview sa ruší. Ak transport práve hrá, nové preview sa odmietne.
2. Apply zavolá `applyEffectIntentProposal`, ktorý overí target, `targetSchemaId` aj `baseStateHash`, znova spustí deterministický planner, vyžaduje presnú zhodu proposal-u a vytvorí jeden snapshot command.
3. `ProjectStore.execute` uloží command do undo histórie a zavolá `onDocChanged`; `services.ts` na tejto hranici posiela nový dokument do `AudioEngine.setProject`. `YDocStore.execute` zapisuje command ako jednu Yjs transakciu.
4. `AudioEngine` vytvorí runtime cez `EFFECT_DEFS[type].factory`; pri zmene parametrov volá `EffectRuntime.setParameter`. `renderProject` vytvorí `OfflineAudioContext`, načíta potrebné worklety a použije rovnaký `AudioEngine`/effect factory tok na render dokumentu.

**Dôležitá hranica:** používateľské Intent preview je dočasný override živého audio runtime-u, nie samostatný offline render kandidáta. Offline render používa aplikovaný (alebo inak pripravený) projektový stav; zatiaľ preto nemožno tvrdiť, že preview waveform a offline render kandidáta boli samostatne porovnané bitovo.

### Existujúce FX editovacie a assistant rozhrania

- Bežné rack parametre zapisuje `setEffectParam`; Ozvena cezň vie zapísať aj hlboké parametre validované cez `targetParamDef`. FXEQ a Ultina majú vlastné schema-aware `setFxEqParam` a `setUltinaParam` commands, preto ich budúci sémantický adapter nesmie obchádzať.
- Panel Ultina už vie prijať návrh modulu toggle-ov a parametrov cez `applyUltinaProposal`; Ozvena má batch patch command `applyOzvenaStatePatch`. Sú to existujúce device-specific proposal/write hranice, nie automaticky kompatibilné návrhy z prirodzeného jazyka.
- FXEQ, Ultina a Ozvena už majú A/B porovnávanie uložené v `deviceState`; FXEQ/Ozvena používajú `effect-ab-v1`, Ultina vlastný `ultina-ab-v1`. Toto je užitočný základ pre neskoršie kandidátne audition, no Intent Assistant zatiaľ do slotov nepíše.
- Bežný knob drag má `AudioEngine.previewFxParam` — priamy runtime override pred commitom. Intent audition je samostatný, stale-guarded flow cez `beginEffectIntentPreview` a dnes povoľuje len rack `ParamDef` hodnoty pre EQ/Reverb. Ani jeden z týchto flow-ov zatiaľ nie je univerzálny bezpečný preview adapter pre hlboké plugin schémy.

**Architektonický dôsledok:** rozšírenie na pluginy má pripojiť capability-specific planner k už existujúcim schema-aware commandom a zdieľanému preview protokolu. Nemá vytvoriť paralelný generický zápis do `effect.params` ani zameniť A/B snapshot s projektovým undo.

### Exit criteria

- [x] Každý aktuálne podporovaný zápis má jednoznačný target a validovaný write path; nepodporované deep write paths sa nezapínajú.
- [x] Existuje reprodukovateľný unit a browser E2E test pre EQ/Reverb pilotný flow.
- [x] Jednorazová FX editácia je oddelená od hudobnej generácie a `planMixProfile` v samostatnom `src/effect-intent/` kontrakte.

---

## Fáza 1 — Jednotný parameter catalog a schopnosti zariadení

**Priorita:** P0 · **Závisí od:** Fáza 0

### Úlohy

- [x] Zaviesť read-only normalizovaný descriptor catalog nad existujúcimi schémami; nezačať paralelnú autoritatívnu schému (aktuálny pilot: EQ/Reverb).
- [x] Adaptovať bežný `ParamDef` pre všetky vstavané rack efekty do read-only technického descriptor catalogu.
- [x] Adaptovať hlbokú FXEQ schému read-only cez explicitný band-aware adapter; schema identity zahŕňa aktuálne bandy a metadata.
- [x] Adaptovať hlbokú Ultina schému z `ALL_PARAMS` vrátane enumov, boolean/step metadát, automation capability a schema identity.
- [x] Adaptovať Ozvena audio state tree read-only; numeric enum indexy zdieľajú jednu mapu medzi hostom a workletom a assistant/masking/IR identity zostávajú mimo param katalógu.
- [x] Kaskada nemá samostatnú deep schema; jej technické parametre sú pokryté rack `ParamDef` adapterom.
- [x] Pre rack `ParamDef` rozlišovať continuous/enum, jednotky, log/linear škálu, default, rozsah, možnosti a validitu aktuálnej hodnoty; chybné dáta sa pri čítaní potichu neopravujú.
- [x] Explicitne označiť známe rack binary controls ako `toggle` (Delay, FXEQ, Ultina, Ozvena, Utility, Beat Mangler, Kaskáda a Tape Stop); test kontroluje zhodu `ParamDef` → descriptor.
- [x] Označiť Tape Stop `curve`/`spin` ako enum s explicitnými možnosťami; nepretržitý `tremolo.shape` zostáva continuous, pretože DSP ho morfuje medzi vlnovými tvarmi.
- [x] Explicitne označiť známe DSP-kvantované integer controls (`bits`, `downsample`, `taps`, `repeatFill`, vocoder `bands`) ako `discrete`/`step: 1`; malformed fractional state sa hlási ako neplatný.
- [x] Doplniť dostupné enum/discrete/toggle metadáta z FXEQ, Ultina, Ozvena a explicitne označených Kaskada rack parametrov; chýbajúce FXEQ taper/enum údaje označiť `unknown`/`rangeOnly`.
- [x] Doplniť explicitné boolean/enum metadáta pre zistené rack výnimky; analýza všetkých registry definitions rozlíšila Tape Stop modes od skutočne continuous normalized controls.
- [x] Rack UI zobrazuje toggles/enums ako selects a `setEffectParam` odmieta neplatné rack enum/toggle hodnoty aj neznáme parametre.
- [ ] Pridať ručne kurátorované sémantické anotácie: `warmth`, `brightness`, `body`, `presence`, `space`, `width`, `drive`, `dynamics`, `movement`.
- [ ] Pri každej anotácii uviesť polarity, konzervatívny rozsah zmeny, možné konflikty a kvalitu dôkazu.
- [x] Pilotné EQ/Reverb anotácie majú jediný zdroj pravdy (`capabilities.ts`) s polaritou, safe bounds, constraints, vysvetlením, rizikom a evidence statusom; catalog aj planner z neho odvodzujú svoje schopnosti.
- [ ] Označiť nebezpečné/štrukturálne parametre ako nepodporované vo V1: bypass, routing, module graph, latency/quality modes a skryté analysis-only hodnoty.
- [x] Pridať coverage report pre celý technický catalog: parameter counts podľa rack/deep source, sémantické coverage, rack-only intent write/preview adaptery a zastarané mapping ID.

### Exit criteria

- [x] Rack descriptor catalog je deterministický a nemení projekt.
- [x] FXEQ descriptor catalog rešpektuje aktívny počet bandov, obsahový schema fingerprint a ne-normalizuje malformed current values.
- [x] Ultina a Ozvena deep adapters zachovávajú schémou určené enum/toggle validity a neexponujú neaudio bookkeeping ako FX parametre.
- [ ] Neznáme ID, zastaraná schema a neplatné enum hodnoty sú odmietnuté s dôvodom.
- [x] Pre aktuálny EQ/Reverb pilot je proposal zviazaný s fingerprintom úplného parameter catalogu; zmena schema identity zneplatní návrh ešte pred Apply.
- [x] Pilotné sémantické anotácie sú oddelené od DSP schém a testy overujú každé mapping ID, rozsah aj descriptor binding.

---

## Fáza 2 — Effect Intent contract a offline parser

**Priorita:** P0 · **Závisí od:** Fáza 1

### Úlohy

- [x] Zaviesť verzovaný `EffectIntentSpec` oddelený od existujúceho `IntentSpec` pre generovanie hudby.
- [x] Implementovať deterministic parser pre malý, zdokumentovaný lexikón slovenských a anglických zvukových zámerov.
- [x] Parsovať intenzitu a smer, rozpoznávať explicitné zachovávacie obmedzenia a neinterpretovanú negáciu bezpečne odmietnuť.
- [x] Podporiť viac cieľov v jednej požiadavke len vtedy, ak sú nezávislé a neprotirečia si; opačné pohyby jedného parametra vyžiadajú clarification.
- [x] Vrátiť pravdivé `needsClarification`/`unsupported` pri rozpore, neznámom pojme alebo neplatnom targete; nevymýšľať parameter.
- [x] Validovať aj runtime payload shape (vnorené `null`, neznáme hodnoty, duplicitné goals/constraints, NaN) a vrátiť `unsupported` namiesto neobslúženej výnimky.
- [x] Zachovať vstupný text, parser version a normalizovaný intent v kanonickom výsledku; neukladať ich do projektu.
- [x] Pridať fixtures pre diakritiku, synonymá, zložené požiadavky a adversarial vstupy; typo tolerance zostáva zámerne vypnutá.

### V1 podporované formulácie

- [x] „teplejšie“ / „warmer“;
- [x] „tmavšie“ / „darker“, „jasnejšie“ / „brighter“;
- [x] „viac/menej priestoru“, „suchšie“ / „drier“;
- [x] intenzita a jednoduché zachovávacie obmedzenia.

Drive, šírka, punch, pohyb, „vintage“, „profesionálnejšie“ a artist/style imitation sa aktivujú až po kurátorskej evaluácii; samotné slovo sa nesmie mapovať na náhodný parameter.

### Exit criteria

- [x] Rovnaký text, target a parser version vytvoria rovnaký kanonický intent.
- [x] Nejasná požiadavka nevedie k návrhu ani k zápisu.
- [x] Parser nemení projekt a nemá sieťovú závislosť.

---

## Fáza 3 — Deterministický planner, obmedzenia a vysvetlenia

**Priorita:** P0 · **Závisí od:** Fázy 1–2

### Úlohy

- [x] Mapovať kanonický cieľ iba na parametre s explicitnou sémantickou anotáciou pre konkrétne zariadenie (pilot EQ/Reverb).
- [x] Zdieľať ten istý capability mapping medzi descriptor catalogom a plannerom; neexistujúci parameter, necontinuous typ ani nesúlad capability so schémou sa odmietne s diagnostikou.
- [x] Zohľadniť aktuálne hodnoty, lineárne/logaritmické mapovanie a konzervatívne delta limity; enum/coupled mappingy čakajú na device adaptery.
- [x] Použiť ručne zvolené dB a log-ratio kroky; nepoužívať univerzálne „pridaj 10 % rozsahu“ naprieč jednotkami.
- [x] Rešpektovať explicitné `preserve` obmedzenia ako hard constraints.
- [x] Detegovať konflikty a zamietnuť alebo sa opýtať; nikdy ich potichu neprepisovať prioritou heuristiky.
- [x] Zaviesť `plannerVersion`, canonical serialization a `baseStateHash`.
- [x] Každú navrhnutú zmenu vysvetliť ľudsky a uviesť konkrétny parameter.
- [x] Zobraziť warning pre zvýšené riziko a pre pilotné mappingy bez blind golden review; confidence sa nesmie predstierať.
- [x] Ak vybraný efekt nedokáže dosiahnuť cieľ bez rizika alebo bez porušenia constraints, vrátiť `unsupported`/`needsClarification`.
- [ ] Vygenerovať viac než jeden kandidát iba ak ich vieme férovo porovnať a používateľ ich vie vypočuť.

### Bezpečnostné invarianty

- [x] Žiadny parameter mimo target zariadenia sa nezmení.
- [x] Žiadne neznáme ID alebo nefinite hodnoty neprejdú validatorom.
- [x] Všetky pilotné hodnoty sú platné v originálnej efektovej schéme pri plánovaní aj Apply.
- [x] Planner nikdy nemení bypass, track routing, sidechain source ani effect chain topology vo V1.
- [x] Zachovávacie constraints platia presne, nie len ako penalizácia v score.
- [ ] Žiadny ONNX/LLM výstup neobchádza planner ani validator.

### Exit criteria

- [ ] Golden text → intent → proposal fixtures sú stabilné a vysvetliteľné.
- [x] Boundary/property-style test sweep dokazuje deterministickosť a rozsahy pilotných hodnôt; integration test overí izoláciu ostatných trackov.
- [x] Boundary sweep overuje nulovú intenzitu; opakovaný planner nad rovnakým stavom je deterministický a nulový návrh vráti ako `noChange`.

---

## Fáza 4 — Atomic Apply, undo/redo a kolaborácia

**Priorita:** P0 · **Závisí od:** Fáza 3

### Úlohy

- [x] Pridať command builder pre validovaný `EffectChangeProposal` v pilotnom EQ/Reverb rozsahu; deep plugin adaptery zostávajú otvorené.
- [x] Aplikovať všetky zmeny jedným používateľským undo krokom.
- [x] Undo musí obnoviť presný pôvodný canonical stav pilotného efektu.
- [x] Pilotný command prechádza cez `YDocStore` ako jedna undo transakcia; peer sync a zachovanie nesúvisiacej vzdialenej zmeny sú testované. Autosave/reload pilotnej hodnoty je pokrytý browser E2E.
- [x] Pred Apply porovnať target identity a `baseStateHash`; pri stale state proposal odmietnuť alebo vyžiadať refresh.
- [x] Pred Apply porovnať aj `targetSchemaId`, odvodené z kompletného technical parameter catalogu; planner/proposal contract je vo verzii `effect-intent-rules-v2`.
- [x] Opakované Apply nad už zmeneným targetom odmietne stale proposal; prázdny alebo nepovolený výber parametrov nevytvorí undo položku.
- [x] Všetky schválené parametre sa zapíšu jednou atomic command do history/store.

### Exit criteria

- [x] Apply/undo/redo vráti presne očakávané parametre pre pilotný EQ/Reverb flow.
- [x] YDocStore peer round-trip zachová pilotnú zmenu a nesúvisiacu peer editáciu.
- [x] Autosave a reload zachovajú aplikovanú Reverb hodnotu v browser E2E.
- [ ] Legacy schema/unknown-field compatibility je overená pre všetky device adaptery.
- [ ] Zmena targetu alebo editácia parametra po preview nedovolí stale proposal prepísať nové dáta.

---

## Fáza 5 — FX workflow v UI a bezpečné počúvanie návrhu

**Priorita:** P1 · **Závisí od:** Fázy 2–4

### UX minimum

- [x] Pridať akciu **Ask FX / Upraviť zvuk** do kontextu konkrétneho podporovaného effect device.
- [x] Zobraziť rozpoznaný cieľ a target, aby používateľ vedel, čo engine pochopil.
- [x] Ukázať parameter diff, krátke vysvetlenie, warnings a ovládanie intenzity s deterministickým prepočtom návrhu.
- [x] Poskytnúť `Apply`, `Cancel`, zmenu intenzity a možnosť vyradiť jednotlivú navrhnutú zmenu; preview aj atomic Apply rešpektujú vybranú množinu parametrov.
- [x] Zobraziť jasné empty/error states pre nepodporovaný zámer, neplatný target, plugin fallback a stale proposal.
- [x] Po Apply funguje štandardný globálny Undo/Redo; nepridávať paralelný history systém.

### Audio audition — povinný bezpečnostný návrh

- [x] Navrhnúť ephemeral preview session pre jeden `trackId/fxId`, oddelenú od project modelu.
- [x] Preview nesmie zapisovať do dokumentu, store commandov ani undo stacku.
- [x] Cancel, unmount, target change, štart transportu a project reload ukončujú preview; zlyhanie obnovy sa prizná v UI.
- [x] Apply počas preview commitne ten istý, stále aktuálny proposal; pred Apply sa proposal stale-validuje.
- [x] Vybrať jednotný engine boundary na transient overrides. Nepoužívať perzistentné commandy ako „dočasný preview“.
- [ ] Ak nemožno garantovať bezpečný preview lifecycle pre zariadenie, UI zobrazí statický diff a preview preň zatiaľ nezapne.
- [ ] Loudness-matched A/B je preferovaný; hlasnejší kandidát nesmie automaticky pôsobiť ako „lepší“.

### Exit criteria

- [x] Browser E2E: offline Reverb proposal → audition → cancel ponechá project parameter nezmenený; engine test overí návrat live hodnoty. Exact PCM/hash parity zostáva otvorená.
- [x] Browser E2E: audition → Apply iba vybraného parametra pri upravenej intenzite → štandardný undo/redo a autosave/reload; nevýber MIX ponechá MIX nezmenený.
- [x] Browser E2E: offline EQ brightness request vráti konkrétny HIGH SHELF diff bez modelu alebo siete.
- [ ] Všetky opustené preview sessions sa deterministicky uzatvoria a nezanechajú transient state.

---

## Fáza 6 — Pokrytie efektov a kvalitatívne golden review

**Priorita:** P1 · **Závisí od:** Fázy 1–5

### Odporúčané poradie pokrytia

1. [x] `eq` a `reverb` — pilotné mapovania sú implementované; slepé ľudské golden počúvanie ešte chýba;
2. [ ] `saturation`/`tapeSat` a `delay` — až s jasným wet/output safety správaním;
3. [ ] FXEQ — prvý deep-schema flagship adapter;
4. [ ] Ultina, Ozvena a Kaskada — každé ako vlastná capability sada a vlastné testy;
5. [ ] ďalšie vstavané FX len keď majú kurátorované goal mappings a merateľný QA.

### Eval dataset

- [ ] Golden prompts pre každý intent, target effect, smer, intenzitu a constraint.
- [ ] Expected parse, povolené parametre, zakázané zmeny a expected state hash/delta.
- [ ] Blind audio A/B kandidátov s hlasitosťou dorovnanou pred hodnotením.
- [ ] Hodnotiť: splnenie zámeru, zachovanie constraints, prirodzenosť, artefakty, stabilitu a jednoduchosť použitia.
- [ ] Subjektívny golden review musí vyplniť človek; systém nesmie automaticky nastaviť `reviewed=true`.
- [ ] Každá zmena sémantického mappingu/planner version má regression fixture a poznámku o očakávanom zvukovom rozdiele.

### Kvalitatívne gate-y

- [ ] 100 % návrhov prejde typ/range/enum/target validáciou.
- [ ] 0 neautorizovaných zmien mimo vybraného effect instance v property/integration testoch.
- [ ] 100 % podporovaných golden promptov má vysvetlený, opakovateľný výsledok alebo explicitný clarification.
- [ ] Unsupported requests sú bezpečne odmietnuté, nie „opravené“ na iný význam.
- [x] Offline browser E2E pokrýva Reverb audition/apply/undo/redo/reload a EQ proposal; ďalšie efekty ešte nie sú vo V1 podporované.

---

## Fáza 7 — AI rozšírenie bez straty kontroly

**Priorita:** P2 · **Závisí od:** úspešných Fáz 2–6 a zmysluplných golden dát

### Rozhodnutie

**Zatiaľ nevyberať ani netrénovať ONNX model.** Najprv potrebujeme stabilný intent ontology, dosť označených príkladov a eval dataset, ktorý vie dokázať, že model pomáha viac než deterministický parser.

### Bezpečný model boundary

- [ ] Lokálny ONNX model môže klasifikovať text na obmedzený `EffectIntentSpec` alebo zoradiť už validované proposals.
- [ ] Model nesmie vracať autoritatívne číselné parametre ani vykonávať commandy.
- [ ] Každý výstup prejde schema validation, ambiguity checkom, deterministic plannerom a safety gate-mi.
- [ ] Ak confidence nedosiahne kalibrovaný prah, vráti sa deterministický parser alebo otázka používateľovi.
- [ ] Model sa lazy-loaduje; offline režim bez model assetu stále podporuje základný parser.
- [ ] Voliteľný vzdialený provider v budúcnosti implementuje rovnaké constrained-intent API, nikdy priamy project write.
- [ ] Opt-in spätná väzba môže ukladať iba používateľom schválené/odmietnuté návrhy podľa privacy pravidiel; nesmie sa potichu použiť ako tréningová pravda.

### Podmienka na model

ONNX pokračuje iba vtedy, ak held-out test preukáže merateľné zlepšenie rozpoznania zámerov oproti parseru, bez zhoršenia false-positive bezpečnostnej miery. Inak zostane parser deterministický a investícia pôjde do lepších sémantických mappings.

---

## Fáza 8 — Rozšírenia po V1

**Priorita:** P2/P3 · **Závisí od:** stabilného V1

- [ ] Track-level návrhy naprieč viacerými efektmi s explicitným zoznamom targetov a jedným spoločným proposal review.
- [ ] Audio-context-aware plánovanie cez analyzované/normalizované features, nie nezdokumentované čítanie ľubovoľného realtime signálu.
- [ ] Preset creation/remix ako samostatný proposal type s vlastným diffom a undo.
- [ ] Automatizácia parametra iba po výslovnom potvrdení rozsahu a cieľovej lane.
- [ ] Budúci VST/AU/user plugin host až po samostatnom stable capability/parameter API vrátane plugin identity, schema version a failure handlingu.
- [ ] Voliteľné online generovanie textovej interpretácie, pričom offline planner, bezpečnosť a apply contract zostanú rovnaké.

---

## 6. Testovacia stratégia

### Unit

- [ ] Parser normalization, intents, synonymá, negácia a ambiguity.
- [ ] Descriptor/adapters, enum mapovania, rozsahy, taper a plugin schema drift.
- [ ] Planner: deterministic output, dôvody, constraints, konflikty, no-op a unsupported.
- [ ] Proposal validation: neznáme ID, NaN/Infinity, stale hash, cudzí target.

### Property / invariant

- [ ] Žiadna generovaná hodnota neprekročí autoritatívny rozsah ani enum.
- [ ] Planner nikdy nezmení parameter mimo allowlistu target zariadenia.
- [ ] Rovnaký canonical input + target state + parser/planner versions = rovnaký proposal hash.
- [ ] Zachovávacie constraints zostanú bitovo nezmenené.
- [ ] Cancel preview vráti parameter map aj počuteľný výstup na pôvodný stav.

### Integration / persistence

- [ ] One-command apply, undo, redo, project reload, autosave a Yjs round-trip.
- [ ] Plugin-specific deep param normalization a legacy projekt compatibility.
- [ ] Stale proposal pri súbežnej editácii a pri zmene targetu.

### Audio / browser

- [ ] Offline render parity a deterministický render pre pilotné zariadenia.
- [ ] Preview lifecycle: cancel/unmount/switch/error/transport.
- [ ] Blind, loudness-matched golden listening; technické metriky sú pomocné, nie náhrada ľudského úsudku.
- [ ] Browser verification pokrýva offline parser, unsupported, preview, accept, undo a reload.
- [ ] Performance: parser/planner mimo audio callbacku; latencia UI preview má stanovený limit.

---

## 7. Riziká a mitigácie

| Riziko                                              | Mitigácia                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Nejasné slová majú rozdielny význam podľa efektu    | Explicitný target, kurátorované device mappings, otázka pri nejednoznačnosti              |
| Parameter ranges nie sú perceptuálne lineárne       | Descriptor mapping podľa jednotky/taper + konzervatívne zariadeniové limity               |
| AI zmení nesúvisiaci alebo skrytý parameter         | Strict allowlist, output ako intent, schema validation pred plannerom aj pri Apply        |
| Preview sa uloží alebo zostane po zatvorení panelu  | Samostatná transient session s lifecycle cleanup; preview bez dostupnej garancie sa vypne |
| Undo deep plugin parametrov neobnoví audio runtime  | Canonical full-state undo a device-specific integration tests                             |
| Model znie „presvedčivo“, ale návrh zhorší mix      | Blind loudness-matched golden review a explicitné subjektívne acceptance                  |
| Rozsah feature sa rozleje na celý mixer/VST hosting | V1 = jedno existujúce effect instance; ďalší scope až po V1 gate                          |
| Model/asset spomalí offline app                     | Parser je plnohodnotný offline baseline; model lazy a optional                            |

---

## 8. Definition of Done pre V1

- [ ] Používateľ zadá podporovaný prirodzený jazykový zámer pre konkrétny effect device offline.
- [ ] Výsledok je deterministický, vysvetlený a rešpektuje explicitné obmedzenia.
- [ ] Návrh sa nedotkne projektu, kým ho používateľ nepotvrdí.
- [ ] Používateľ vie návrh vypočuť alebo bezpečne zrušiť; zrušenie obnoví presný originál.
- [ ] Apply je jeden undoable/persisted/collaborative command a undo/redo je presné.
- [ ] Podporované zariadenia majú golden fixtures; nepodporované sú pravdivo označené.
- [ ] Unit, property, integration, offline audio a browser gates sú zelené.
- [ ] Feature funguje bez siete a bez model assetu.
- [ ] Model sa nepridáva, kým nedosiahne definovaný held-out eval gate.

---

## 9. Odporúčané poradie implementácie

1. **Fáza 0:** potvrdiť target/write/preview boundary a zachytiť baseline.
2. **Fáza 1:** descriptor catalog a pilotné sémantické anotácie pre EQ/Reverb.
3. **Fázy 2–3:** text → canonical intent → deterministický, testovaný proposal.
4. **Fáza 4:** atomic apply/undo/stale guard ešte pred UI polishom.
5. **Fáza 5:** Ask FX UI, najprv diff, potom plne životným cyklom kryté audio preview.
6. **Fáza 6:** golden listening, opravy mappings a postupné pridávanie zariadení.
7. **Fáza 7:** ONNX iba ak dáta preukážu jasný prínos oproti parseru.

Prvý implementačný slice má byť malý, ale end-to-end: **Reverb „viac/menej priestoru“ + EQ „teplejšie/jasnejšie“**, proposal diff, jeden Apply command, undo/redo a offline tests. Až po jeho QA pridať FXEQ adapter a ďalšie pluginy.

---

## 10. Agent execution contract

Agent, ktorý začne implementovať túto roadmapu, musí:

- prečítať roadmapu a skontrolovať aktuálny worktree pred každým fázovým zásahom;
- zachovať všetky existujúce používateľské zmeny; nepoužiť reset/checkout ani široké prepisy;
- postupovať po jednej fáze a označiť checkbox až po konkrétnom teste alebo overiteľnom dôkaze;
- používať existujúce registry, schema, commands, store a audio-engine hranice namiesto paralelného parameter state;
- nezasahovať do vendored plugin core, ak adapter alebo lokálna vrstva postačuje;
- pri každom novom persisted poli doplniť normalizáciu, kompatibilitu, undo/redo, kolaboráciu a testy;
- nenechať AI/model priamo meniť projekt alebo generovať nevalidované parameter values;
- pred pokračovaním zastaviť fázu, ak kód neposkytuje bezpečný transient preview boundary, a zdokumentovať rozhodnutie;
- na konci každej fázy uviesť zmenené súbory, spustené kontroly, výsledky, limity a otvorené riziká.
