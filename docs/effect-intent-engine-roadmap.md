# Effect Intent Engine — implementačná roadmapa

**Status:** návrh · **Dátum:** 2026-09-20 · **Priorita:** P1 produkt, P0 bezpečnosť dát  
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

- [ ] Zaznamenať aktuálny command → store → runtime → offline render tok pri editácii FX parametra.
- [ ] Inventarizovať effect types, parametre, enumy, deep schemas, write commands, pluginové A/B/preview schopnosti a existujúce assistant proposals.
- [ ] Určiť, ktoré zariadenia sú podporované priamo a ktoré vyžadujú explicitný adapter.
- [ ] Zafixovať východiskové audio/project fixture pre vybraný pilot.
- [ ] Vybrať vertikálny pilot: vstavaný `eq` a `reverb`, následne jeden flagship (odporúčanie: FXEQ) po zavedení adaptera.
- [ ] Zaznamenať, že V1 mení iba jedno existujúce zariadenie a nemení routing/bypass/topológiu.
- [ ] Overiť, že nový kód neprepisuje aktuálne necommitnuté zmeny.

### Exit criteria

- [ ] Každý plánovaný zápis má jednoznačný target a validovaný write path.
- [ ] Existuje reprodukovateľný test pre aktuálny stav pilotného zariadenia.
- [ ] Je jasne oddelená jednorazová editácia parametrov od hudobnej generácie a `planMixProfile`.

---

## Fáza 1 — Jednotný parameter catalog a schopnosti zariadení

**Priorita:** P0 · **Závisí od:** Fáza 0

### Úlohy

- [ ] Zaviesť read-only normalizovaný descriptor catalog nad existujúcimi schémami; nezačať paralelnú autoritatívnu schému.
- [ ] Adaptovať bežný `ParamDef` a následne FXEQ/Ultina/Ozvena/Kaskada schémy.
- [ ] Rozlišovať continuous/enum/toggle, jednotky, log/linear škálu, default, rozsah a aktuálne dostupnosť parametra.
- [ ] Pridať ručne kurátorované sémantické anotácie: `warmth`, `brightness`, `body`, `presence`, `space`, `width`, `drive`, `dynamics`, `movement`.
- [ ] Pri každej anotácii uviesť polarity, konzervatívny rozsah zmeny, možné konflikty a kvalitu dôkazu.
- [ ] Označiť nebezpečné/štrukturálne parametre ako nepodporované vo V1: bypass, routing, module graph, latency/quality modes a skryté analysis-only hodnoty.
- [ ] Pridať coverage report: koľko parametrov má technickú validáciu a koľko aj overenú sémantiku.

### Exit criteria

- [ ] Descriptor catalog je deterministický a nemení projekt.
- [ ] Neznáme ID, zastaraná schema a neplatné enum hodnoty sú odmietnuté s dôvodom.
- [ ] Sémantické anotácie sú oddelené od DSP schém a každá má aspoň unit test.

---

## Fáza 2 — Effect Intent contract a offline parser

**Priorita:** P0 · **Závisí od:** Fáza 1

### Úlohy

- [ ] Zaviesť verzovaný `EffectIntentSpec` oddelený od existujúceho `IntentSpec` pre generovanie hudby.
- [ ] Implementovať deterministic parser pre malý, zdokumentovaný lexikón slovenských a anglických zvukových zámerov.
- [ ] Parsovať intenzitu (`jemne`, `výrazne`), smer, negáciu a zachovávacie obmedzenia (`bez zmeny basov`).
- [ ] Podporiť viac cieľov v jednej požiadavke len vtedy, ak sú nezávislé a neprotirečia si.
- [ ] Vrátiť `needsClarification` pri rozpore, neznámom pojme alebo chýbajúcom targete; nevymýšľať parameter.
- [ ] Zachovať vstupný text, parser version a normalizovaný intent v diagnostike; neukladať ich do projektu bez potreby.
- [ ] Pridať fixtures pre diakritiku, synonymá, preklepy v bežnej miere, negáciu, zložené požiadavky a adversarial vstupy.

### V1 podporované formulácie

- [ ] „teplejšie“ / „warmer“;
- [ ] „tmavšie“ / „darker“, „jasnejšie“ / „brighter“;
- [ ] „viac/menej priestoru“, „suchšie“ / „drier“;
- [ ] intenzita a jednoduché zachovávacie obmedzenia.

Drive, šírka, punch, pohyb, „vintage“, „profesionálnejšie“ a artist/style imitation sa aktivujú až po kurátorskej evaluácii; samotné slovo sa nesmie mapovať na náhodný parameter.

### Exit criteria

- [ ] Rovnaký text, target a parser version vytvoria rovnaký kanonický intent.
- [ ] Nejasná požiadavka nevedie k návrhu ani k zápisu.
- [ ] Parser nemení projekt a nemá sieťovú závislosť.

---

## Fáza 3 — Deterministický planner, obmedzenia a vysvetlenia

**Priorita:** P0 · **Závisí od:** Fázy 1–2

### Úlohy

- [ ] Mapovať kanonický cieľ iba na parametre s explicitnou sémantickou anotáciou pre konkrétne zariadenie.
- [ ] Zohľadniť aktuálne hodnoty, taper, enumy, coupled parametre a bezpečné delta limity.
- [ ] Použiť perceptuálne normalizované kroky; nepoužívať univerzálne „pridaj 10 % rozsahu“ pre Hz, dB, čas aj enum naraz.
- [ ] Rešpektovať explicitné `preserve` obmedzenia ako hard constraints.
- [ ] Detegovať konflikty a zamietnuť alebo sa opýtať; nikdy ich potichu neprepisovať prioritou heuristiky.
- [ ] Zaviesť `plannerVersion`, canonical serialization a `baseStateHash`.
- [ ] Každú navrhnutú zmenu vysvetliť ľudsky: „znížil som high shelf, aby bol výsledok tmavší“.
- [ ] Ak vybraný efekt nedokáže dosiahnuť cieľ bez rizika alebo bez porušenia constraints, vrátiť `unsupported`/`needsClarification`.
- [ ] Vygenerovať viac než jeden kandidát iba ak ich vieme férovo porovnať a používateľ ich vie vypočuť.

### Bezpečnostné invarianty

- [ ] Žiadny parameter mimo target zariadenia sa nezmení.
- [ ] Žiadne neznáme ID alebo nefinite hodnoty neprejdú validatorom.
- [ ] Všetky hodnoty sú platné v originálnej plugin schéme pred Apply aj pri Apply.
- [ ] Planner nikdy nemení bypass, track routing, sidechain source ani effect chain topology vo V1.
- [ ] Zachovávacie constraints platia presne, nie len ako penalizácia v score.
- [ ] Žiadny ONNX/LLM výstup neobchádza planner ani validator.

### Exit criteria

- [ ] Golden text → intent → proposal fixtures sú stabilné a vysvetliteľné.
- [ ] Property testy dokazujú rozsahy, enum validitu, target izoláciu a deterministickosť.
- [ ] Opakovaný planner nad rovnakým stavom nevytvorí „zmenu“, ktorá nič nemení.

---

## Fáza 4 — Atomic Apply, undo/redo a kolaborácia

**Priorita:** P0 · **Závisí od:** Fáza 3

### Úlohy

- [ ] Pridať command builder pre validovaný `EffectChangeProposal`; zariadeniovo špecifické adaptery vyberú správnu schému a normalizáciu.
- [ ] Aplikovať všetky zmeny jedným používateľským undo krokom.
- [ ] Undo musí obnoviť presný pôvodný canonical stav vrátane deep plugin parametrov a defaultov.
- [ ] Zachovať Yjs/collab, autosave, project reload a existujúce project normalization pravidlá.
- [ ] Pred Apply porovnať target identity a `baseStateHash`; pri stale state proposal odmietnuť alebo vyžiadať refresh.
- [ ] Opakované Apply nesmie neúmyselne zduplikovať deltu ani vytvoriť prázdne undo položky.
- [ ] Zápis cez jednorazovú sadu existujúcich setterov sa môže použiť interne, ale do history/store sa odošle jedna atomic command.

### Exit criteria

- [ ] Apply/undo/redo vráti presne očakávané parametre.
- [ ] Persistence a kolaborácia zachovajú zmenu bez neznámych fields.
- [ ] Zmena targetu alebo editácia parametra po preview nedovolí stale proposal prepísať nové dáta.

---

## Fáza 5 — FX workflow v UI a bezpečné počúvanie návrhu

**Priorita:** P1 · **Závisí od:** Fázy 2–4

### UX minimum

- [ ] Pridať akciu **Ask FX / Upraviť zvuk** do kontextu konkrétneho effect device.
- [ ] Zobraziť rozpoznaný cieľ a target, aby používateľ vedel, čo engine pochopil.
- [ ] Ukázať parameter diff, krátke vysvetlenie, warnings a intenzitu.
- [ ] Poskytnúť `Apply`, `Cancel`, zmenu intenzity a možnosť vyradiť jednotlivú navrhnutú zmenu.
- [ ] Zobraziť jasné empty/error states pre nepodporovaný zámer, neplatný target, plugin fallback a stale proposal.
- [ ] Po Apply ponúknuť štandardný Undo; neduplikovať nový vlastný history systém.

### Audio audition — povinný bezpečnostný návrh

- [ ] Navrhnúť ephemeral preview session pre jeden `trackId/fxId`, oddelenú od project modelu.
- [ ] Preview nesmie zapisovať do dokumentu, autosave, Yjs ani undo stacku.
- [ ] Cancel, unmount, target switch, transport stop/error a project reload musia obnoviť pôvodné live parametre.
- [ ] Apply počas preview musí commitnúť práve vypočutý a stále aktuálny proposal; nesmie znovu vypočítať inú hodnotu.
- [ ] Pred implementáciou vybrať jednotný engine boundary na transient overrides. Nepoužívať priamo perzistentné commandy ako „dočasný preview“.
- [ ] Ak nemožno garantovať bezpečný preview lifecycle pre zariadenie, UI zobrazí statický diff a preview preň zatiaľ nezapne.
- [ ] Loudness-matched A/B je preferovaný; hlasnejší kandidát nesmie automaticky pôsobiť ako „lepší“.

### Exit criteria

- [ ] E2E: otvorenie panelu → parse → proposal → audition → cancel obnoví audio aj project hash.
- [ ] E2E: audition → apply → undo → redo zachová presnú sekvenciu.
- [ ] Všetky opustené preview sessions sa deterministicky uzatvoria a nezanechajú transient state.

---

## Fáza 6 — Pokrytie efektov a kvalitatívne golden review

**Priorita:** P1 · **Závisí od:** Fázy 1–5

### Odporúčané poradie pokrytia

1. [ ] `eq` a `reverb` — najzrozumiteľnejšie pilotné mapovania;
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
- [ ] Browser app funguje offline pre všetky deterministické V1 flow-y.

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

| Riziko | Mitigácia |
|---|---|
| Nejasné slová majú rozdielny význam podľa efektu | Explicitný target, kurátorované device mappings, otázka pri nejednoznačnosti |
| Parameter ranges nie sú perceptuálne lineárne | Descriptor mapping podľa jednotky/taper + konzervatívne zariadeniové limity |
| AI zmení nesúvisiaci alebo skrytý parameter | Strict allowlist, output ako intent, schema validation pred plannerom aj pri Apply |
| Preview sa uloží alebo zostane po zatvorení panelu | Samostatná transient session s lifecycle cleanup; preview bez dostupnej garancie sa vypne |
| Undo deep plugin parametrov neobnoví audio runtime | Canonical full-state undo a device-specific integration tests |
| Model znie „presvedčivo“, ale návrh zhorší mix | Blind loudness-matched golden review a explicitné subjektívne acceptance |
| Rozsah feature sa rozleje na celý mixer/VST hosting | V1 = jedno existujúce effect instance; ďalší scope až po V1 gate |
| Model/asset spomalí offline app | Parser je plnohodnotný offline baseline; model lazy a optional |

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
