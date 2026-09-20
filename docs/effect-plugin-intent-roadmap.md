# Effect / Plugin Intent — produktová a implementačná roadmapa

**Status:** plánovanie · **Dátum:** 2026-09-20  
**Cieľ:** bezpečne a zrozumiteľne upravovať zvuk existujúcich vstavaných efektov prirodzeným jazykom  
**Základné pravidlo:** AI smie pomôcť pochopiť zámer; iba verzovaný deterministický planner smie vytvoriť parameterový návrh a iba explicitné potvrdenie používateľa smie zmeniť projekt.

> „Na tomto delayi trochu viac tape charakteru, ale nechaj feedback bezpečný a mix pod 30 %.“

Toto nie je funkcia „pošli text modelu a zapíš čísla do pluginu“. Je to **kontextový zvukový asistent**: pozná vybraný efekt, jeho skutočnú schému, význam parametrov a obmedzenia; navrhne vysvetlený diff, umožní bezpečné vypočutie a zmenu aplikuje jedným vratným krokom.

---

## 1. Produktový rozsah a terminológia

### V1: vstavané effect zariadenia

- Používateľ začne z konkrétneho vybraného efektu; target sa nikdy nehádá z textu.
- Zámer môže byť zvukový („teplejšie“, „viac priestoru“), relatívna úprava („trochu viac modulácie“) alebo neskôr explicitná hodnota („mix na 20 %“).
- Výsledok je návrh s hodnotami pred/po, krátkym dôvodom, upozorneniami a jasnou voľbou Apply/Cancel.
- Podpora sa zapína po jednotlivých schopnostiach zariadenia. Parameter v editore, automation lane alebo schéme **nie je automaticky povolený pre intent**.
- Bez modelu, siete a bez dostupného audio preview musí zostať deterministický bezpečný tok použiteľný.

### Nie je súčasťou V1

- Ľubovoľné externé VST/AU/user pluginy: v aktuálnom projekte nie je generický host/plugin metadata kontrakt.
- Priama generácia čísel modelom, automatické Apply, zmena routingu, chain topológie, bypassu alebo sidechain zdroja.
- Viac zariadení/trackov naraz, automatizácia v čase, „namixuj celý track“, tvorba kompletných presetov a neobmedzené DSP ovládanie.
- Sľub, že subjektívny pojem ako „profesionálnejšie“ má univerzálne správnu interpretáciu.

### Dôležité rozlíšenie

„Plugin“ tu znamená vstavaný FX nástroj v Pulse Forge (napr. PRISM/FXEQ, VLYX/Ultina, VØID/Ozvena alebo RYFT/Kaskáda), nie ľubovoľný plugin tretej strany. Inštrumentové pluginy sú samostatná budúca vetva: majú iný target, inú ontológiu aj odlišné riziká.

---

## 2. Aktuálny stav potvrdený v repozitári

- Existuje samostatný `EffectIntentSpec`, deterministický parser/planner a návrh s `baseStateHash`; parser a pilotné semantic mappingy pokrývajú najmä EQ/Reverb.
- Rack efekty majú spoločný registry `ParamDef`, no flagship efekty majú vlastné hlboké schémy. `project-model/targets.ts` už skladá niektoré z nich pre automation/macro použitie.
- Zápisy nie sú univerzálne: obyčajné efekty, FXEQ, Ultina a ďalšie zariadenia majú osobitné command paths. Aktuálny generický `effect-intent/apply.ts` pracuje s rack definíciami; sám osebe preto ešte nie je bezpečným writerom hlbokých parametrov.
- V pracovnom strome je rozpracované rozšírenie read-only descriptor katalógu pre FXEQ. Tento plán ho rešpektuje a považuje za katalógový adapter, nie za hotovú sémantickú ani write podporu.
- Ultina má vlastný analysis/proposal systém; Ozvena má vlastný assistant flow. Sú to znovupoužiteľné doménové precedensy, nie automaticky kompatibilné FX-intent planner-y.
- Repozitórium už obsahuje ONNX runtime, worker pattern a AI komponenty pre hudobný Intent Engine. Existujúci music ranker/model nie je FX parameter model a bez FX datasetu sa nesmie považovať za vhodný model.

### Kľúčová medzera

Potrebujeme samostatné, explicitné vrstvy pre (1) autoritatívny parameter/schema adapter, (2) kurátorovaný zvukový význam a riziká, (3) intent interpretáciu, (4) deterministické plánovanie, (5) plugin-aware atomic write a (6) audio preview. Ich zmiešanie by umožnilo, aby technicky existujúci, ale skrytý alebo nebezpečný parameter získal AI oprávnenie len preto, že ho model pozná.

---

## 3. Cieľový tok

```text
Vybraný FX instance + text + aktuálny stav
                  │
                  ▼
       deterministický parser / voliteľný ONNX interpreter
                  │  verzovaný, obmedzený zámer — nikdy surové knob hodnoty
                  ▼
           EffectIntentSpec / edit operations
                  │
                  ▼
     device adapter + schema + capability/semantic catalog
                  │
                  ▼
       deterministický constrained planner
                  │  znovu-validovaný návrh + base/schema hash
                  ▼
          diff → bezpečné transient audition → Apply/Cancel
                  │ explicitné Apply
                  ▼
     existujúci command/store/Yjs/audio sync/undo-redo tok
```

**Žiadna** parser/model/preview fáza nesmie mutovať projekt alebo zapisovať do workletu spôsobom, ktorý obíde lifecycle preview. ONNX nikdy nevytvára `EffectInstance.params` ani project command.

---

## 4. Kontrakty a invarianty pred rozširovaním pokrytia

### Device adapter / parameter descriptor

Každý adapter musí explicitne poskytnúť:

- stabilné `deviceType`, `schemaId/schemaVersion`, canonical parameter ID a aktuálnu hodnotu;
- typ hodnoty: continuous, enum s povolenými hodnotami/labelmi, boolean/toggle, discrete alebo unsupported;
- jednotku, validný rozsah, default, krok/taper a pravidlo normalizácie;
- dostupnosť/visibility a podmienené parametre (napr. aktívny počet FXEQ pásiem);
- schopnosti read, plan, write, preview a automation odlíšené od seba;
- canonical read/validate a device-aware write path, ktorý zachováva undo, collaboration/Yjs a runtime sync.

Neznámy parameter, stará schema, enum mimo možností, skrytý interný stav alebo neplatný persisted value vedie k diagnostike/odmietnutiu. Katalóg pri čítaní neprevádza neplatné dáta potichu na bezpečnú hodnotu.

### Semantic capability catalog

Technický parameter dostane intent oprávnenie iba cez ručne skontrolovaný mapping, napríklad:

- `brightness`, `warmth`, `body`, `presence`, `space`, `width`, `drive`, `movement`, `dynamics`, `tempoSync`;
- smer/polarita, zmysluplný rozsah, konzervatívny limit, confidence/evidence;
- interakcie a hard constraints (napr. zmena crossoveru mení platnosť pásiem; mix/feedback sa držia pod user limitom);
- risk tier: `safe`, `elevated` (zobraziť varovanie/potvrdenie) alebo `forbidden`;
- testy a krátky rationale text pre používateľa.

Capability nie je len alias parametra. Môže byť kompozitnou operáciou nad viacerými parametrami, ale jej preconditions, hard limits a povolené efekty musia byť testovateľné deterministicky.

### Intent a proposal

- Zachovať kompatibilitu v1; pri rozšírení kontraktu zvýšiť `schemaVersion` namiesto tichej zmeny významu.
- Intent vyjadruje capability/action, smer alebo explicitnú požadovanú hodnotu, intenzitu, constraints a prípadne parser provenance. Target prichádza z vybraného FX contextu.
- Proposal obsahuje target identity, device schema identity, `baseStateHash`, intent/parser/planner verzie, diff, rationale, warnings a výsledky validácie.
- Povolené stavy sú pravdivé a rozlíšené: `ready`, `needsClarification`, `unsupported`, `noChange`, `stale`, `rejected`.
- Pri Apply sa celý proposal znovu prepočíta/validuje voči aktuálnemu dokumentu, schema ID, targetu a allowlistu. Zmena projektu od preview znamená stale návrh.

---

## Fáza 0 — Produktový kontrakt a bezpečný rozsah

**Priorita:** P0 · **Závisí od:** nič

- [x] Potvrdené: existujúci pilot je single-target FX intent s deterministic proposal flow; pluginové deep schémy/write paths sú samostatné.
- [x] Potvrdené: externý generický VST/plugin host nie je v aktuálnom scope kontrakte.
- [ ] Zvoliť UX pomenovanie (napr. „Ask FX“ / „Upraviť zvuk“) a podporované jazyky pre prvý release.
- [ ] Schváliť V1 ciele a explicitný denylist (routing, bypass, module topology, quality modes, skrytý analysis state, IR/file selection).
- [ ] Rozhodnúť produktové správanie pre explicitné číselné pokyny: V1 ich môže odmietnuť/požiadať o potvrdenie; nesmú sa zamieňať so zvukovým cieľom.
- [ ] Zaznamenať baseline latenciu, preview lifecycle a project/undo/collaboration správanie pre pilot.

**Exit:** jediný jednoznačný V1 use case: jeden vybraný efekt, bezpečný proposal, človek ho skontroluje, môže vypočuť, potom Apply/Undo.

---

## Fáza 1 — Schema adapters a capability boundary

**Priorita:** P0 · **Závisí od:** Fázy 0

- [ ] Dokončiť spoločný read-only descriptor kontrakt bez vytvárania paralelnej autoritatívnej FX schémy.
- [ ] Každému descriptoru pridať validné typy/discrete hodnoty, availability, schema identity a oddelené read/plan/write/preview capabilities.
- [ ] Dokončiť a otestovať FXEQ band-aware adapter (aktívne bandy, enumy, aliasy, neplatný fractional bandCount); nezamieňať ho za podporu semantic edits.
- [ ] Doplniť Ultina adapter z jej autoritatívnej `ALL_PARAMS` schémy vrátane unit, step, enum, boolean a `automatable` rozdielu.
- [ ] Doplniť Ozvena adapter z reálneho `OzvenaStateV1` flatten/unflatten kontraktu; bezpečne rozlíšiť numeric parametre od stromových/asset/engine voľieb.
- [ ] Doplniť Kaskada/ostatné rack efekty cez `ParamDef`, s explicitnou detekciou enumov a togglov namiesto odvodzovania len z číselného rozsahu.
- [ ] Neznáme, nepodporené a skryté hodnoty označiť `unsupported`; nepoužívať náhodné fallback range ako dôkaz bezpečnej editovateľnosti.
- [ ] Coverage report rozdeliť na technické pokrytie vs semantic/write/preview pokrytie; nevykazovať „všetky params“ ako „všetky podporené intents“.
- [ ] Schema drift tests: nový/odstránený ID, zmena range/enum, počet bandov/modulov a invalid persisted value.

**Exit:** každý podporovaný zápis má explicitnú schému a validátor; samotná existencia parametra nič nepovoľuje.

---

## Fáza 2 — Zvuková ontológia a bezpečné mappingy

**Priorita:** P0 · **Závisí od:** Fázy 1

- [ ] Definovať malú ontology: cieľ, smer, intenzita, explicitný set/adjust, zachovávacie constraints a terminologické synonymá.
- [ ] Pre EQ/Reverb previesť existujúce mappingy do jednotného capability formátu bez zmeny výstupov, kým golden tests nepotvrdia ekvivalenciu.
- [ ] Pridať najviac 1–2 nové capabilities na pilotný komplexný FX (odporúčanie: Kaskada „viac/kratší delay“ alebo FXEQ „jemnejšie/viac pásmové“ až po schválení semantic mapy).
- [ ] Každý mapping musí mať: polarity, perceptuálnu/parametrovu krivku, delta limit, interakcie, risk tier, krátke vysvetlenie a test fixture.
- [ ] Opačné/konfliktné ciele a hard preserve limits riešiť ako `needsClarification`/`unsupported`, nie váhovou heuristikou.
- [ ] Žiadne plošné „+10 % range“ pravidlo; log frekvencie, dB, percentá, enumy a time-sync majú device-aware kroky.
- [ ] Zachovať rozdiel medzi „zvukový cieľ“ (heuristická interpretácia) a „nastav parameter na presnú hodnotu“ (explicitná operácia).

**Exit:** mappingy sú ručne kontrolované, verzované, deterministické a majú boundary/conflict tests.

---

## Fáza 3 — Intent parser a clarification

**Priorita:** P0 · **Závisí od:** Fázy 2

- [ ] Rozšíriť deterministic parser postupne: existujúce SK/EN frázy → smer/intenzita → preserve constraints → bezpečné explicitné parameter/capability frázy.
- [ ] Podporovať negáciu len s otestovanou gramatikou; neinterpretované „bez toho, okrem…“ vyžiada clarification.
- [ ] Pridať parser confidence/evidence len ak má definované a testované pravidlo; inak používať presné stavy unsupported/clarification.
- [ ] Ak existuje viac vierohodných target parametrov alebo protichodné ciele, ukázať používateľovi možnosti namiesto tichého výberu.
- [ ] Versioned fixtures pre slovenčinu, angličtinu, diakritiku, synonymá, preklepy (vypnuté, kým sa nevyhodnotia), negáciu a adversarial text.
- [ ] Target pochádza z otvoreného/selected efektu; parser nesmie svojvoľne vybrať iný plugin alebo track.

**Exit:** model/net nie sú nutné; každý podporovaný prompt má stabilný parse alebo čestné odmietnutie.

---

## Fáza 4 — Deterministický planner a plugin-aware atomic write

**Priorita:** P0 · **Závisí od:** Fáz 1–3

- [ ] Nahradiť rastúci effect/param `RULES` switch data-driven plannerom nad explicitnými capabilities a device adaptermi.
- [ ] Planner vyrába kandidátov v stabilnom poradí, aplikuje hard constraints, safety limity, enum snapping a device preconditions.
- [ ] Zaviesť `DeviceProposalAdapter` kontrakt pre canonical read, validate, plan, apply command a stale/schema check.
- [ ] Vytvoriť plugin-aware multi-param command path (alebo command composition), ktorý použije existujúci store/Yjs/runtime tok a vytvorí presne jeden undo krok.
- [ ] Pri deep plugin state zabezpečiť canonical full-state undo, aby sa doc a audio worklet nerozišli po Apply/Undo/reload.
- [ ] Validate-at-plan **aj** validate-at-apply: cudzí ID, duplicitné zmeny, nefinite value, enum mismatch, target/schema/hash drift odmietnuť.
- [ ] Návrh nesmie meniť inštancie mimo targetu ani zapisovať preview výsledok do projektového dokumentu.
- [ ] Každá zmena má presný parameter diff a vysvetlenie odvodené z capability mappingu; neprodukovať marketingové tvrdenia o zvuku.

**Exit:** planner rovnakého intent + target state + verzií dá rovnaký proposal hash; Apply/Undo/Redo a Yjs sú atomic a overené.

---

## Fáza 5 — UI, audition a používateľská kontrola

**Priorita:** P1 · **Závisí od:** Fázy 3–4

- [ ] Sprístupniť intent akciu len v kontexte podporovaného konkrétneho efektu.
- [ ] Zobraziť, čo engine pochopil, target, constraints, neistotu, unsupported dôvod a risk upozornenie.
- [ ] Ukázať diff pred/po s menami plugin parametrov; dovoliť vypnúť jednotlivé návrhy a zmeniť intenzitu s deterministickým prepočtom.
- [ ] Apply je explicitný a jeden undo krok; Cancel nemení dokument.
- [ ] Preview je oddelený transient runtime override, nikdy project command. Lifecycle: cancel, unmount, zmena targetu, transport, reload, chyba a paralelná editácia vždy obnovia živé hodnoty.
- [ ] Preview zapínať len pri adapteroch s otestovanou obnovou; inde ponúknuť iba diff.
- [ ] A/B loudness-match, kde je technicky korektný; nemať hlasnejší výsledok ako skrytú výhodu.
- [ ] Accessibility/keyboard a mobilný panel test; žiadne blokujúce ONNX načítanie pri otvorení UI.

**Exit:** browser E2E pokrýva generate → audition → cancel, selective apply → undo/redo → reload, stale proposal a unsupported/error.

---

## Fáza 6 — Kontrolované rozširovanie efektov a zvuková evaluácia

**Priorita:** P1 · **Závisí od:** Fáz 1–5

Odporúčané poradie (každé zariadenie má samostatný exit gate; nič sa nepovoľuje len preto, že predchádzajúci plugin prešiel):

1. [ ] Upevniť existujúci EQ/Reverb pilot a vyplniť blind golden review.
2. [ ] Jeden jednoduchší charakterový/časový efekt (Kaskada alebo saturácia) s konzervatívnymi safety limitmi.
3. [ ] FXEQ/PRISM po hotovom band-aware descriptor **aj** writer adapteri a golden zvukových prípadoch.
4. [ ] Ultina/VLYX s mapovaním existujúcich analyzátor/proposal capabilities; oddeliť nepodporované topology/module-toggle návrhy.
5. [ ] Ozvena/VØID až po kompletnej tree schema, asset/engine risk modeli a validovanom round-trip write/undo.
6. [ ] Ostatné efekty iba po vlastnom semantic mappingu, tests, preview readiness a ľudskom golden sign-off.

- [ ] Golden prompt dataset: prompt, target, očakávaný intent, povolené capability/param IDs, zakázané zmeny, constraints a expected proposal hash/delta.
- [ ] Syntetické/property testy pokrývajú range, enumy, no-op, stale hash, target izoláciu a deterministickosť.
- [ ] Golden audio render porovná realtime event plán s offline renderom; numerické DSP metriky nenahrádzajú počúvanie.
- [ ] Blind loudness-matched A/B; človek nastaví `reviewed=true`, agent/system nikdy.
- [ ] Zmeny mapping/planner verzie majú vysvetlený golden diff; bezpečnostné false-positive rate je samostatná metrika.
- [ ] Latency gate pre parser/planner/preview, lazy-load, memory a dostupnosť model assetu.

**Exit:** každé povolené zariadenie má úplný testovaný cyklus; ostatné sa férovo hlásia ako nepodporované.

---

## Fáza 7 — Rozhodnutie a prípadné nasadenie malého ONNX modelu

**Priorita:** P2 · **Závisí od:** stabilných Fáz 2–6 a dostatočného FX eval datasetu

### Odporúčanie

Nerobiť teraz model, ktorý „ovláda všetky pluginy“. Prvý kandidát má byť **malý constrained intent classifier/slot ranker** v samostatnom Worker-i. Vstup: text + podporované capability names + vybraný device context. Výstup: jedna z vopred definovaných intent schém alebo clarification scores. Výstup neobsahuje ľubovoľné parameter ID ani autoritatívne číselné hodnoty.

- [ ] Zostaviť FX-specific označený dataset z realistických promptov a variantov, vrátane unsupported/ambiguous/adversarial príkladov.
- [ ] Zmerať deterministic parser baseline: intent accuracy, unsupported false-positive, clarification precision, target/capability selection a latencia.
- [ ] Porovnať (a) rozšírený deterministic parser, (b) existujúci lokálny semantic retrieval iba ako kandidátsky lookup a (c) malý fine-tuned ONNX klasifikátor/slot model.
- [ ] Nezamieňať existujúci music candidate ranker za FX ranker; odlišné vstupy, ciele a golden labely vyžadujú vlastnú evaluáciu.
- [ ] Model sa aktivuje iba ak held-out výsledky merateľne zlepšia porozumenie bez zvýšenia nebezpečných false positives; inak sa nevydáva.
- [ ] Worker: lazy-load z lokálneho manifestu, hash/model version check, timeout/error status, cache session, dispose, no main/audio-thread inference.
- [ ] Model output strict schema validation → ambiguity gate → deterministic planner → safety validator → user review; pri výpadku späť na parser alebo clarification.
- [ ] Model nesmie generovať finálne parametre, meniť target, obísť schema/constraints, volať write path ani byť požiadavkou na offline použitie.
- [ ] Evidovať model/data/ontology verzie a golden dataset split; žiadne user projekty/audio/prompt logovanie bez opt-in a privacy dizajnu.

**Go/no-go:** ONNX je opodstatnený len vtedy, ak zlepšenie na held-out FX benchmarku prevýši komplexitu, bundle/memory náklady a false-positive riziko. „Máme ONNX runtime“ nie je dôkaz vhodnosti modelu.

---

## Fáza 8 — Neskoršie rozšírenia (mimo V1)

**Priorita:** P2/P3 · **Závisí od:** overeného single-effect V1

- [ ] Audio-context-aware návrhy z normalizovaných analyzovaných features, s jasne zobrazenou provenienciou a súhlasom používateľa.
- [ ] Coordinované zmeny viacerých FX/trackov s explicitným target zoznamom a spoločným diffom.
- [ ] Preset remix ako samostatný proposal typ; neskrývať za obyčajný intent parameter patch.
- [ ] Automation proposal ako samostatný temporal kontrakt, interval a undo flow.
- [ ] Instrument intent pre synth/sampler parametre po definícii iného ontology a target modelu.
- [ ] Externý VST/AU až po stabilnom plugin metadata/capability/write/preview API.
- [ ] Voliteľný vzdialený interpreter môže nahradiť parser provider, nie planner/validator/Apply boundary.

---

## 5. Testovacie a release gates

### Correctness / safety

- [ ] Každá navrhnutá hodnota prejde originálnou device schema; enum/toggle/discrete je presná povolená hodnota.
- [ ] Žiadny nepodporovaný/skrytý parameter, cudzí target, bypass/routing/module topology alebo invalid ID sa nedostane do Apply.
- [ ] `preserve` constraints sú hard constraints a po Apply zostanú hodnoty nezmenené.
- [ ] Rovnaký text + target + state + parser/planner/schema/model verzie = rovnaký intent/proposal hash.
- [ ] Invalid/stale proposal nikdy nevráti truthful `ready` status.
- [ ] Fallback bez ONNX/modelu aj bez sieti je validný, zrozumiteľný a nezapisuje nič automaticky.

### State / integration

- [ ] Apply je jeden command; Undo/Redo presne obnoví celý canonical plugin state.
- [ ] Testy pokrývajú store/Yjs, autosave/reload, runtime/worklet sync a súbežnú vzdialenú zmenu.
- [ ] Preview neprepíše dokument/undo history a po každom lifecycle exit obnoví runtime na aktuálnu (nie zastaranú) hodnotu.

### Audio / product quality

- [ ] Offline render je konzistentný s realtime plánom pri reprezentatívnych plugin nastaveniach.
- [ ] Blind golden review pre každý povolený semantic mapping; človek schvaľuje subjektívnu kvalitu.
- [ ] Meria sa latencia parseru/plannera/preview aj lazy-load ONNX; UI má limit pre synchronnú prácu.
- [ ] Unsupported a ambiguous corpus sa vyhodnocuje na false-positive návrhoch, nielen na accuracy podporovaných fráz.

---

## 6. Navrhované pracovné balíky / vlastníctvo kódu

Pracovné cesty; pred implementáciou ich zosúladiť s aktuálnym stavom pracovného stromu a hotovými zmenami.

- **Contracts/catalog:** `src/effect-intent/types.ts`, `catalog.ts`, nový adapter modul podľa zariadenia; čítať autoritatívne FX schémy, nekopírovať ich.
- **Parser/ontology/planner:** `parser.ts`, nový capability catalog, `planner.ts`; verziovať výstup a ponechať parser offline.
- **Writes:** `apply.ts` + plugin-aware command builder v `src/commands/commands.ts`; rešpektovať rozdielne FXEQ/Ultina/Ozvena contracts a Yjs undo.
- **UI/preview:** `src/ui/EffectIntentAssistant.tsx`, FX rack context a audio-engine transient override boundary; bez cross-feature state mutation.
- **AI (až po gate):** samostatné `src/ai/effect-intent/*` Worker/client/types/model manifest; nepreberať music ranker payload/model identity.
- **Validation:** `tests/effect-intent.test.ts`, store/E2E/audio engine testy, nový FX golden corpus a explicitný browser/audio test pre každý plugin pilot.

---

## 7. Odporúčaný prvý implementačný rez

Po schválení tejto roadmapy nezačínať tréningom modelu ani povolením desiatok nových parametrov. Prvý vertikálny rez má:

1. dotiahnuť descriptor/adapter contract a explicitne odlíšiť read-only vs plan/write/preview capability;
2. ponechať EQ/Reverb ako baseline a zvoliť **jeden** deep-schema pilot (odporúčanie: FXEQ/PRISM, ak súčasný rozpracovaný adapter prejde testami);
3. pridať preň jednu úzku semantic capability s jasnými hard limits a golden audio review;
4. implementovať správny plugin-specific atomic write + undo/Yjs + stale schema/state guards;
5. zapnúť UI preview len po overení transient lifecycle pre tento konkrétny plugin;
6. pripraviť benchmark promptov a až výsledok benchmarku rozhodne, či malý ONNX interpreter reálne pomôže.

Tým vznikne skutočná vertical slice „povie → pochopí → navrhne → vypočuje → prijme/vráti“ bez predstierania, že celý rack už má bezpečnú AI kontrolu.
