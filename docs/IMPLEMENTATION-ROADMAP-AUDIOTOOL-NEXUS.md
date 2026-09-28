# KYX × Audiotool Nexus — implementation roadmap

> Stav: MVP vertical slice je rozpracovaný v pracovnom strome; release gate-y sú stále otvorené. Baseline overený 2026-09-27
> Cieľ: prepojiť existujúci KYX Intent Songstarter s používateľom zvoleným Audiotool projektom cez oficiálne Audiotool Nexus SDK.  
> Zásada: Nexus je voliteľná externá integrácia. Nenahrádza KYX project model, Yjs collab ani lokálny/offline workflow.

## 1. Produktový cieľ

Používateľ otvorí Audiotool projekt, pripojí KYX cez Nexus, v KYX opíše hudobný zámer, vypočuje si návrhy a až po výslovnom potvrdení odošle vybraný návrh do Audiotool session ako editovateľný materiál.

```text
Audiotool projekt (zdroj pravdy pre cieľovú session)
        ↕ explicitné pripojenie cez Audiotool Nexus
KYX IntentPanel → kandidáti → audition → používateľ vyberie
        ↓ potvrdený, validovaný export plán
Nexus adapter → Audiotool entity v jednej ohraničenej transakcii
```

Prvé vydanie je **Songstarter/Composition integrácia**, nie vzdialené ovládanie celej KYX DAW. Oficiálne súťažné kategórie zahŕňajú Songstarter a Composition; Connect je relevantná sekundárna kategória, keď nástroj priamo rozširuje Audiotool workflow. Prvé vydanie sa nebude prezentovať ako Sound Design nástroj, pokiaľ nebude generovať alebo meniť signálové/audio zariadenia v Audiotool session. [Audiotool challenge categories](https://www.audiotool.com/LetsBuild/challenges)

## 2. Aktuálny baseline a dôsledky

Overené v pracovnom strome:

| Oblasť                | Dnešný stav                                                                                                                                                                             | Dôsledok                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Text → hudobný návrh  | `src/intent/types.ts`, `normalize.ts`, `plan.ts`, `pipeline.ts`; interaktívna plocha `src/ui/IntentPanel.tsx`                                                                           | Reuse existujúceho parsera, kandidátov a audition flow. Nevytvárať druhý generátor.                    |
| Generačný výsledok    | `GenerationResult` nesie `plan`, `proposal.pattern` a voliteľný kandidátsky `bank`; `resultForCandidate()` vyberá presný audition kandidát                                              | Nexus mapper dostane potvrdený pattern, nie znovu pregenerovaný brief.                                 |
| KYX projektové zmeny  | `ProjectStore` + command systém; `ProjectDocument` je serializovateľný zdroj pravdy                                                                                                     | SDK entity, OAuth klient ani vzdialený Audiotool stav nepatria do ProjectDocument.                     |
| KYX collaboration     | `src/collab/CollabSession.ts`, `CollaborationProvider.ts`, Yjs + `y-websocket`                                                                                                          | Zostáva nezmenená. KYX collab a Audiotool Nexus sú oddelené transporty a protokoly.                    |
| Audiotool integration | `@audiotool/nexus` 0.0.19 je pinned ako build-time dependency; `src/integrations/audiotool-nexus/` obsahuje MIDI mapper a create-only writer; Intent kandidát má explicitný export flow | Existuje úzky konkrétny Nexus adapter, nie všeobecný provider runtime ani plná session synchronizácia. |
| Hosting               | `vite.config.ts` podporuje `STUDIO_APP_BASE`, vrátane `/kyx/`                                                                                                                           | OAuth redirect URL pre lokálne aj produkčné nasadenie musí byť presne zaregistrovaná a otestovaná.     |

### Známe vlastnosti SDK, ktoré treba znovu potvrdiť pri štarte

Pri implementácii bol pinned balík `@audiotool/nexus` v0.0.19 použitý s browser popup auth scope `project:write`, `noteTrack`/`noteRegion` a offline document API. SDK/package sú pred 1.0 a ich API môže meniť správanie. Navyše npm metadata deklaruje MIT, ale publikovaný `LICENSE` súbor začína Apache-2.0; build preto zachováva priložený LICENSE text a generuje tretie-stranové licenčné oznámenia konzervatívne podľa reálneho súboru. Túto publisher nezhodu treba vyriešiť pred distribúciou/submissionom. [Nexus JavaScript package docs](https://developer.audiotool.com/js-package-documentation/) · [Nexus repository](https://github.com/audiotool/nexus).

### Aktuálny implementačný checkpoint

- **Hotový lokálny slice:** lazy-load po výslovnom kliknutí, popup OAuth flow, validácia Audiotool project URL, náhľad a samostatné potvrdenie vzdialeného zápisu, create-only MIDI/synth/mixer entity, idempotentný retry marker s kontrolou presných MIDI hodnôt (s float32 toleranciou pre velocity) a route grafu pri prvom zápise aj retry, živý stav spojenia, opätovná kontrola KYX zdroja po získaní Nexus transakčného zámku a lifecycle ochrana pre neskoro otvorenú session, prebiehajúci štart aj async UI výsledky po unmount. UI integračný test vykoná potvrdený write cez Nexus `OfflineDocument` a overí receipt aj vytvorené entity; regresia overuje, že ručne zmenené noty sa netvária ako nezmenený idempotentný import. Cielený balík: 11 Nexus testov a spolu s curated-sample, PWA, platform-contract a Intent regresiami 41/41.
- **MIDI časová mierka:** KYX používa 480 tickov/štvrťovú dobu, Audiotool 3 840; mapper prevádza pozície, dĺžky a hranice taktov pomerom 8:1. Regresné testy kontrolujú notové polia na vytvorených Audiotool entitách.
- **Offline dôkaz:** `createOfflineDocument()` s povolenou Nexus validáciou vytvoril MIDI track/region/collection/note a Heisenberg→mixer route; toto samo osebe **nedokazuje** serverovú validáciu ani úspešný živý Audiotool zápis.
- **Podporovaná platforma:** connector UI sa zobrazuje iba v KYX Web. KYX Studio používa `app://bundle`, ktorého OAuth popup/redirect origin nie je zaregistrovaný ani otestovaný; Electron zatiaľ nepodporujeme.
- **Subpath deploy:** Vite build s `STUDIO_APP_BASE=/kyx/` prefixuje entry/assets, PWA `start_url`/scope aj service worker. Mount-aware Chromium smoke na `http://127.0.0.1:4180/kyx/` po oprave `loadCuratedLayer()` načítal sample súbory z `/kyx/samples/` a skončil s 0 browser console errors. Samotný `vite preview` nie je mount-aware a môže pre chýbajúci asset vrátiť HTML SPA fallback; kontrolovať MIME, nie iba HTTP status. Živý smoke `https://qvesterstudio.com/kyx/` 2026-09-27 naopak zlyhal ešte v Qvester shelli: jeho JS/CSS asset URL pod `/kyx/assets/...` vracajú `text/html` (29 console errors). Toto je samostatný host/deploy blocker; do Qvester repozitára sa v tejto práci nič nesynchronizovalo.
- **Dependency gate:** SDK 0.0.19 je exact-pin dev/build dependency; emitted Nexus chunk má 678 KiB oproti 750 KiB opt-in capu, nie je v initial/PWA precache a browser bundle neobsahuje Node-only `connect-node`/`undici`. `npm audit --omit=dev` hlási 0, ale plný audit hlási 8 advisories: moderate Nexus cez `connect-node`, high `undici`/Vite a critical Vitest v dev dependency tree. Nevykonať dependency bump/override v tomto feature diff-e; samostatný security/dependency review je potrebný pred distribúciou build toolchainu.
- **WASM runtime gate:** Chromium smoke na namountovanom `/kyx/` builde prešiel cez skutočný browser chunk SDK 0.0.19: `createOfflineDocument({ validated: true })` následne validoval vytvorenie Heisenberg synthu, note track/region/note aj mixer channel/cable. SDK úspešne natiahlo `wasm_exec.js` a validator z Audiotool CDN; browser GET mal `200`, `Access-Control-Allow-Origin: *` a `application/wasm`, takže `WebAssembly.compileStreaming`/SDK validator funguje bez kopírovania ~40 MB nekomprimovaného WASM do `dist/`. Test bol lokálny; live OAuth/project session ešte nie. Qvester `public/_headers` ani aktuálna live odpoveď CSP neuvádzajú; ak sa CSP pridá na Cloudflare úrovni, treba povoliť príslušný Audiotool CDN origin v `script-src` a `connect-src`.
- **Deploy artifact gate:** `scripts/sync-to-qvester.mjs` teraz po Vite builde generuje Audiotool LICENSE/NOTICE súbory, spúšťa bundle-budget check a pred kopírovaním vyžaduje Nexus licenčný text. Celá pipeline prešla proti izolovanému cieľu v pracovnom strome; živý Qvester checkout nebol zmenený.
- **Build gate (2026-09-28):** samostatný `npx vite build` úspešne skompiloval 737 modulov; LICENSE/NOTICE generation aj `scripts/check-bundle-size.mjs` prešli. Nexus: 678/750 KB, DAW JS: 3 095/3 170 KB, AI runtimes: 640/650 KB, celkový script budget OK. `npm run build` sa zastaví pred Vite na `tsc --noEmit` pre štyri existujúce chyby v nesúvisiacom `tests/groove-dedup.test.ts`; tieto testy sme v tejto práci nemenili.
- **Stále release-blocking:** chýba registrovaný OAuth `clientId`, dedikovaný test project a výslovné potvrdenie pre živý zápis; live Qvester mount aktuálne servuje svoje shell assety s chybným MIME. Navyše GitHub `LICENSE`/npm tarball Nexus hovoria Apache-2.0, kým npm metadata deklaruje MIT. Zachovať LICENSE/NOTICE text a pred distribúciou potvrdiť zamýšľanú licenciu publishrom. Kým tieto brány neprejdú, nepovažovať integráciu za release-ready ani za súťažnú compliance.

Roadmapa **nepredpokladá**, že všetky KYX roly, patterny, zariadenia alebo automatizácie majú v SDK priamy ekvivalent. Presný MVP rozsah sa uzamkne až po funkčnom API spike.

## 3. Rozsah MVP

### Zahrnúť

- Explicitné prihlásenie/pripojenie používateľa k Audiotool aplikácii a otvorenie ním zvoleného Audiotool projektu.
- Použitie existujúceho KYX Intent pipeline na generovanie a audition kandidátov.
- Zobrazenie, ktoré časti návrhu možno do cieľovej Audiotool session zapísať a ktoré ešte podporované nie sú.
- Používateľom potvrdený, **create-only** zápis jedného úzko podporovaného kompozičného výsledku do Audiotool projektu.
- Stav pripojenia, chyby, zrušenie, opakovanie po zlyhaní a jasné oddelenie lokálneho KYX projektu od vzdialeného Audiotool projektu.
- Fungovanie KYX bez Audiotool účtu, siete alebo SDK inicializácie.

### Nezahrnúť do prvej verzie

- Plnú obojsmernú synchronizáciu KYX ↔ Audiotool ani mirrorovanie `ProjectDocument`.
- Tichú alebo automatickú zmenu Audiotool projektu počas generovania/audition.
- Vzdialené ovládanie KYX transportu z Audiotool alebo opačne.
- Rozsiahly import/export všetkých KYX nástrojov, efektov, automatizácií, scén, sample packov či mixer routingu.
- MRT2 realtime/PCM streaming do Audiotool, kým SDK audio cesty, asset práva a latencia nebudú samostatne preukázané.
- Pridanie serverového token relay alebo ukladanie OAuth refresh/access tokenov do KYX collab servera.

## 4. Architektonické pravidlá

1. **Nexus je adapter, nie nový zdroj pravdy.** KYX projekt ostáva v `ProjectStore`; Audiotool vlastní stav svojej session. Vzdialené SDK objekty sa neukladajú do KYX schémy.
2. **Preview pred zápisom.** Používateľ najprv vidí/vypočuje konkrétny kandidát a jeho plánované zmeny, potom ich výslovne potvrdí.
3. **Nemeníme existujúci obsah.** MVP vytvára len nové, jednoznačne označené entity; nič nemaže, neprepisuje a nepripája do existujúceho routingu bez nového explicitného potvrdenia.
4. **Jedna cesta generovania.** `IntentPanel`/pipeline zostáva zdrojom návrhu. Integrácia konzumuje vybraný výsledok a nikdy ho pri zápise ticho neregeneruje.
5. **Žiadny SDK kód v audio realtime hranici.** Nexus operácie bežia mimo AudioWorklet, scheduler ticku a audio callbackov.
6. **Lazy/opt-in načítanie.** SDK sa inicializuje až po voľbe „Connect to Audiotool“; akceptačný gate kontroluje entry/DAW/lazy bundle rozpočty.
7. **Lokálny fallback.** Keď Nexus chýba alebo je nedostupný, KYX generovanie a bežný MIDI/scorepack export fungujú ako doteraz. Fallback export sa nesmie označiť ako živá Nexus integrácia.
8. **Bez neoverených capability claims.** Len capabilities potvrdené aktuálnym SDK a reálnou session možno zobraziť ako podporované.

## 5. Implementačné fázy

### Fáza 0 — pravidlá, API spike a go/no-go

**Cieľ:** odstrániť riziko, že SDK nevie vytvoriť typ kompozičného výsledku, ktorý si zvolíme.

**Práca:**

1. Znova prečítať oficiálny Nexus quick start, API reference, entity a auth docs; zaznamenať verziu, dátum, licenciu SDK, browser support, OAuth scopes, rate/size limity a známe breaking changes.
2. Overiť registráciu aplikácie a redirect URI pre lokálny Vite server a plánovaný produkčný origin/subpath. Audiotool quick start uvádza lokálne `127.0.0.1`, nie `localhost`; presná URL musí sedieť s registráciou.
3. Bez produkčných používateľských dát spraviť technický spike s `createOfflineDocument()`: vytvorenie minimálneho podporovaného player/device → note track → note region → MIDI notes; potom načítať dokument a overiť výsledok.
4. Potvrdiť, či možno vytvoriť podporovaný výsledok v reálnom používateľskom projekte bez deštruktívneho zásahu, čo sa stane pri retry/čiastočnom zlyhaní a aká je cesta pre Audiotool Undo.
5. Potvrdiť hackathonové pravidlá: prijatie existujúceho projektu, povinná Nexus integrácia, požadované publikovanie/demá, eligibility, submission deadline/time a IP granty. Verejná súťažná stránka odkazuje na samostatný FAQ; túto roadmapu nepovažovať za právne ani súťažné potvrdenie.

**Exit gate:** existuje reprodukovateľný offline spike a jeden úspešný reálny create-only zápis do testovacieho Audiotool projektu; alebo je napísaný presný blocker a MVP sa upraví pred vývojom UI.

### Fáza 1 — dependency qualification (samostatná zmena)

**Cieľ:** bezpečne pridať a uzamknúť externú SDK závislosť bez miešania dependency bumpu s feature diffom.

**Práca:**

- Vybrať verziu SDK až po API spike; pin/lock správanie a prečítať package metadata, license, transitive dependencies, browser/WASM assets, install scripts a bundle footprint.
- Pridať dependency/lockfile vo vlastnom, úzkom change sete podľa repo pravidla pre dependency bump.
- Spustiť `npm audit --omit=dev` pred/po, test/production build a `scripts/check-bundle-size.mjs`; zaznamenať výsledné čísla.
- Overiť, že sa Nexus nedostane do initial bundle ani browser boot pathu bez opt-in integrácie.

**Exit gate:** dependency je auditovateľná, buildovateľná a lazy-loadovateľná bez porušenia bundle budgetov. Ak SDK vyžaduje neprijateľné licenčné, bezpečnostné alebo bundle podmienky, zastaviť sa a vrátiť sa k adapter/spike rozhodnutiu.

### Fáza 2 — provider-neutral KYX adapter boundary

**Cieľ:** vytvoriť úzku, testovateľnú hranicu medzi KYX intent a Audiotool SDK.

**Navrhované nové súbory** (po overení finálnej stromovej konvencie):

```text
src/integrations/audiotool-nexus/
  types.ts          # adapter interfaces, status, capability report, safe errors
  load-sdk.ts       # lazy SDK import + version boundary
  auth-session.ts   # explicit login/logout and SDK session lifecycle
  project-session.ts# user-selected project open/start/stop/subscription
  mapping.ts        # pure KYX output → validated Audiotool write plan
  writer.ts         # explicit, bounded write; no UI or generator logic
```

**Práca:**

- Definovať lifecycle: `unavailable → disconnected → authenticating → connected → project-open → writing → error/closed`.
- `clientId` je verejný identifikátor podľa SDK quick startu, nie secret. Nepatria sem client secret, server-side token store ani token export.
- Vyžiadať iba potrebný scope dostupný pre aplikáciu; quick start aktuálne uvádza `project:write`. Projekt sa vyberá/otvára vedomou akciou používateľa.
- Všetky vstupné/vrátené hodnoty skontrolovať na shape, veľkosť a konečnosť. SDK chyby normalizovať na bezpečné user-facing stavy bez logovania tokenov alebo citlivého projektu.
- Zaviesť capability negotiation. Adapter nesmie tvrdiť podporu pre entity, MIDI rozsahy, zariadenia alebo automation bez potvrdenia handshake/API.

**Exit gate:** adapter ide testovať cez fake transport/offline Nexus document, opakovane sa pripojí/odpojí a nevyžaduje zmenu `ProjectDocument`, `SCHEMA_VERSION`, Yjs modelu ani AudioEngine.

### Fáza 3 — deterministický Intent → Audiotool write plan

**Cieľ:** presne definovať, čo z vybraného KYX návrhu možno preniesť.

**Práca:**

- Použiť existujúce `generateAsyncResult(..., { includeBank: true })`, `resultForCandidate()` a kandidátsky audition flow v `src/intent/pipeline.ts`/`src/ui/IntentPanel.tsx`.
- Mapper bude čistá funkcia: vstupom je validovaný vybraný `Pattern`, požadovaný Intent/seed a capability snapshot; výstupom serializovateľný `AudiotoolWritePlan` bez SDK objektov.
- Najprv podporiť iba tú jednu kompozičnú vertikálu, ktorú Fáza 0 reálne overila (napr. pitched MIDI part cez podporovaný `noteTrack`/`noteRegion` player). Nepredpokladať, že KYX drum pattern automaticky zodpovedá Audiotool drum device.
- Zachovať BPM/key/počet taktov/timing a všetky obmedzenia v write pláne; odmietnuť neplatné čísla, rozsahy alebo nedostupné entity pred začatím zápisu.
- Nepodporované roly zobrazovať ako „neprenesené“; nikdy ich potichu zahodiť a nehlásiť celý export ako úspešný.
- Vypočítať stabilný plánový fingerprint z Intent hash + vybraného kandidáta + cieľového project identity, aby retry nevytváral nechcené duplicitné party. Nepoužívať KYX IDs ako Audiotool IDs bez SDK záruky.

**Exit gate:** golden testy dokazujú stabilné note/tick/track mapovanie, presný selected candidate, odmietnutie unsupported výstupov a zhodu preview vs write plan.

### Fáza 4 — create-only zápis a ochrana používateľského projektu

**Cieľ:** vytvoriť nové Audiotool entity iba po potvrdení a bez neúmyselnej zmeny cudzieho obsahu.

**Práca:**

- Pred zápisom znovu skontrolovať otvorený project identity, capabilities a predpoklady plánu; ak sa cieľ zmenil, potvrdenie zneplatniť.
- Zapísať konzistentný, čo najmenší entity batch cez aktuálne podporovaný `nexus.modify(...)` mechanizmus.
- Vytvorené party/region pomenovať jednoznačne ako KYX návrh (napr. brief/seed skrátený a bezpečne limitovaný), bez vkladania citlivého promptu do názvov.
- Po zápise znovu query-núť výsledné entity a skontrolovať, že sa počty, polohy a note dáta zhodujú s plánom.
- Ak API nevie garantovať atomicitu/rollback, UI musí priznať čiastočný výsledok, zabrániť slepému retry a poskytnúť presný recovery postup; neodstraňovať entity potichu.
- Disconnect, revoke, tab close, timeout, conflict a retry musia mať explicitné výsledné stavy.

**Exit gate:** reálny testovací projekt po úspešnom zápise obsahuje iba očakávané nové entity; zlyhanie nevytvára druhú sadu pri retry; existujúci obsah zostáva nezmenený.

### Fáza 5 — UX v Intent workflow

**Cieľ:** Nexus pôsobí ako cieľ pre používateľom vybraný beat, nie ako neviditeľný background sync.

**Práca:**

- Pridať do existujúceho Intent workflow stav „Connect Audiotool“, názov/identitu otvoreného projektu a tlačidlo „Send selected idea to Audiotool“.
- Pred potvrdením zobraziť destination project, entity, track/region názvy, počet taktov, podporované/nepodporované roly a explicitné varovanie, že zápis mení vzdialenú session.
- Vyžadovať samostatné potvrdenie vzdialeného zápisu; samotné Generate/Audition nesmie zapisovať do Audiotool.
- Pridať progress, cancel ak ho API dovolí, retry po preflight a krátky success receipt s počtom vytvorených entít.
- Udržať aktuálny KYX keyboard/navigation/accessibility conventions; stav chyby nesmie zablokovať IntentPanel ani lokálne generovanie.

**Exit gate:** používateľ dokáže bez dokumentácie pripojiť session, vypočuť výber, pochopiť následky, potvrdiť zápis a rozoznať úspech od partial/failure.

### Fáza 6 — QA, deploy a submission-ready dôkazy

**Testy:**

1. Mapper unit/golden tests: timing/PPQ, transpozícia/rozsah, seed, počet taktov, invalid/unsupported events a stable fingerprint.
2. Adapter tests: cancelled/failed OAuth, token expiration podľa SDK, project switch, stale confirmation, disconnect during write, duplicate retry a malformed response.
3. SDK offline tests cez `createOfflineDocument()` pre entity lifecycle; version drift sa zachytí pri build/test gate.
4. UI tests s mock adapter: no network on boot, preview-only generation, explicit confirm, errors/retry, local fallback.
5. Reálny Chromium smoke proti dedikovanému testovaciemu Audiotool projektu; Firefox otestovať len v rozsahu oficiálne podporovanom SDK. Safari/Electron support netvrdiť bez samostatného dôkazu.
6. Production build pod `/kyx/`: OAuth callback, refresh po návrate, PWA/service-worker chovanie, deep links, CSP/connect-src, načítanie Audiotool CDN WASM validatora a browser reload priamo na integration route.

**Release evidence:**

- krátky demo flow od briefu po editovateľnú Audiotool session;
- README: požiadavky, supported browser/SDK version, permissions, login, known limitations a odpojenie;
- pravdivé AI/MRT2 a tretie-stranové asset acknowledgements; demo používa iba vlastné alebo jasne licencované audio;
- security/license/dependency report, build/bundle výsledky a testovací project cleanup/recovery postup;
- súťažné submission polia, publikovanie a eligibility overené priamo v aktuálnom oficiálnom FAQ.

## 6. Testovacie a release invariants

- Local KYX Intent, preview a offline export zostávajú použiteľné bez Nexus SDK, Audiotool účtu aj siete.
- Žiadny OAuth token, Audiotool entity object ani vzdialený session stav sa neukladá do IndexedDB projektu, share code, gallery alebo Yjs room.
- Žiadny remote write počas app bootu, generovania, auditionu, reconnectu alebo bez finálneho potvrdenia.
- SDK failure nesmie vyhodiť do React renderu, scheduleru ani audio callbacku.
- Bez project model zmeny neinkrementovať `SCHEMA_VERSION`; ak neskôr pribudne trvalý Nexus link na projekte, samostatne otvoriť schema/migration rozhodnutie.
- Nepridávať skrytú sieťovú telemetriu ani upload briefov/audio do KYX servera. Audiotool dostane iba dáta nutné pre operáciu, ktorú si používateľ potvrdil.
- Pred každým SDK upgrade spustiť offline entity suite aj reálny smoke; SDK je podľa aktuálnej dokumentácie vo vývoji.

## 7. Súťažný a právny preflight

Hackathon stránka aktuálne opisuje Songstarter/Composition a Connect smery a odkazuje na osobitný živý rules/FAQ dokument. Pri baseline review sa celý FAQ nedal spoľahlivo overiť; pred submission musí vlastník potvrdiť najmä:

- či treba projekt vytvoriť počas hackathonu alebo možno prihlásiť existujúci KYX;
- či je Nexus integration povinná a aké minimum znamená „Nexus app“;
- submission format, publikovanie, termín a timezone;
- podmienky tímu/účasti, prize eligibility, IP a práva na demo/submission.

Nezávisle od súťaže, Audiotool Terms ukladajú používateľovi zodpovednosť za práva k nahranému materiálu a Audiotool Code of Conduct povoľuje AI obsah len za predpokladu, že neporušuje práva tretích strán; AI použitie odporúča transparentne uviesť. Pri MRT2 model card rozlišuje Apache 2.0 kód a CC BY 4.0 váhy a prenáša zodpovednosť za output na používateľa. Prvý MVP preto nepoužíva MRT2 ako povinnú súčasť; ak sa pridá do submission, uviesť model/attribution a použiť originálne alebo licencované zdrojové audio.

Zdroje: [Audiotool Let's Build](https://www.audiotool.com/LetsBuild/) · [Nexus SDK docs](https://developer.audiotool.com/js-package-documentation/) · [Audiotool Terms](https://www.audiotool.com/terms) · [Audiotool Code of Conduct](https://www.audiotool.com/code-of-conduct) · [MRT2 model card](https://huggingface.co/google/magenta-realtime-2).

Tento dokument je technická roadmapa, nie právne stanovisko ani vyhlásenie o splnení pravidiel súťaže.

## 8. Odporúčaná `/goal` sekvencia

Spúšťať v poradí; každý goal má skončiť konkrétnym gate reportom. Keďže MVP vertical slice už čiastočne existuje, prvý goal má overiť a doplniť aktuálny stav, nie znovu vytvárať hotové súbory. Nezačínať živý OAuth/write smoke bez registrovaného client ID, dedikovaného test projektu a výslovného potvrdenia vlastníka.

1. **Current-state + feasibility gate:** skontrolovať existujúci diff a testy, overiť SDK API/licenciu, offline `noteTrack`/`noteRegion` dôkaz a browser WASM loader; pripraviť živý test iba po získaní potrebných vstupov. Výstup: potvrdené hotové časti, presné medzery a go/no-go.
2. **Dependency qualification:** keďže dependency už pinned je, auditovať current package/lockfile, SDK licenciu/transitives, lazy bundle a opt-in load; meniť dependency iba ak gate nájde konkrétny dôvod.
3. **Adapter + failure hardening:** audit auth/session lifecycle, capability checks, error normalization, disconnect/retry/stale confirmation, timeout/circuit behavior; doplniť chýbajúce offline/fake tests bez duplikovania existujúcich testov.
4. **Intent Songstarter write:** overiť mapovanie vybraného KYX candidate → Audiotool plan → create-only confirmed write, MIDI časovanie, idempotentný retry a zachovanie vzdialeného obsahu; bez zmeny project schema.
5. **UX + production/release proof:** uzavrieť CDN WASM a `/kyx/` OAuth/browser smoke, PWA/CSP, dokumentáciu, dependency/security/licence review a aktuálne súťažné podmienky. Živý write sa vykoná len po explicitnom test-project potvrdení.

Goal 1 môže zmeniť poradie alebo zastaviť plán, ak SDK nedokáže spoľahlivo vytvoriť a overiť konkrétny kompozičný artefakt. To je očakávaný technický gate, nie zlyhanie implementácie.

### Copy-paste zadanie pre `/goal`

```text
Dokonči bezpečnú a release-ready integráciu KYX × Audiotool Nexus podľa
`docs/IMPLEMENTATION-ROADMAP-AUDIOTOOL-NEXUS.md`.

Začni auditom aktuálneho pracovného stromu a existujúcich testov. Zachovaj všetky
nesúvisiace používateľské zmeny a znovu neimplementuj hotové časti. Postupuj cez
fázy roadmapy v poradí, zapisuj priebežný stav a pri každej fáze uveď dôkazy,
testy a otvorené riziká. Rešpektuj ADR a AGENTS.md.

Nexus musí zostať opt-in, lazy-loaded a create-only: bez vzdialeného zápisu pri
boote/generovaní/auditione, iba po náhľade a samostatnom potvrdení. KYX project
model/Yjs/audio realtime hranicu nemeň, pokiaľ roadmapa nepreukáže nevyhnutnosť
a nie je pripravené príslušné ADR/migrácia. Nezvyšuj bundle budget bez meraného
dôvodu. Over production build pod `/kyx/`, vrátane OAuth návratu, Audiotool CDN
WASM loadera (CORS/MIME/CSP) a PWA/service worker.

Nevykonávaj živý Audiotool zápis, kým vlastník neposkytne zaregistrovaný verejný
OAuth client ID, dedikovaný test-project URL a výslovne nepotvrdí testovací
zápis. Client ID nie je secret; nikdy nepýtaj ani neloguj client secret ani OAuth tokeny.
Ak tieto vstupy alebo publishrom potvrdená SDK licencia chýbajú, dokonči všetku
bezpečnú offline prácu, jasne vypíš presný blocker a nepovažuj integráciu za
release-ready. Necommituj ani nepushuj bez samostatnej požiadavky.
```
