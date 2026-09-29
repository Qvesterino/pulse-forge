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

| Oblasť                | Dnešný stav                                                                                                                                                                             | Dôsledok                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Text → hudobný návrh  | `src/intent/types.ts`, `normalize.ts`, `plan.ts`, `pipeline.ts`; interaktívna plocha `src/ui/IntentPanel.tsx`                                                                           | Reuse existujúceho parsera, kandidátov a audition flow. Nevytvárať druhý generátor.                                     |
| Generačný výsledok    | `GenerationResult` nesie `plan`, `proposal.pattern` a voliteľný kandidátsky `bank`; `resultForCandidate()` vyberá presný audition kandidát                                              | Nexus mapper dostane potvrdený pattern, nie znovu pregenerovaný brief.                                                  |
| KYX projektové zmeny  | `ProjectStore` + command systém; `ProjectDocument` je serializovateľný zdroj pravdy                                                                                                     | SDK entity, OAuth klient ani vzdialený Audiotool stav nepatria do ProjectDocument.                                      |
| KYX collaboration     | `src/collab/CollabSession.ts`, `CollaborationProvider.ts`, Yjs + `y-websocket`                                                                                                          | Zostáva nezmenená. KYX collab a Audiotool Nexus sú oddelené transporty a protokoly.                                     |
| Audiotool integration | `@audiotool/nexus` 0.0.19 je pinned ako build-time dependency; `src/integrations/audiotool-nexus/` obsahuje MIDI mapper a create-only writer; Intent kandidát má explicitný export flow | Existuje úzky konkrétny Nexus adapter, nie všeobecný provider runtime ani plná session synchronizácia.                  |
| Hosting               | `vite.config.ts` podporuje `STUDIO_APP_BASE`, vrátane `/kyx/`                                                                                                                           | Popup používa `window.location.origin`; zaregistrovaný Audiotool Redirect URI musí povoliť lokálny aj produkčný origin. |

### Známe vlastnosti SDK, ktoré treba znovu potvrdiť pri štarte

Pri implementácii bol pinned balík `@audiotool/nexus` v0.0.19 použitý s browser popup auth scope `project:write`, `noteTrack`/`noteRegion` a offline document API. SDK/package sú pred 1.0 a ich API môže meniť správanie. Navyše npm metadata deklaruje MIT, ale publikovaný `LICENSE` súbor začína Apache-2.0; build preto zachováva priložený LICENSE text a generuje tretie-stranové licenčné oznámenia konzervatívne podľa reálneho súboru. Túto publisher nezhodu treba vyriešiť pred distribúciou/submissionom. [Nexus JavaScript package docs](https://developer.audiotool.com/js-package-documentation/) · [Nexus repository](https://github.com/audiotool/nexus).

### Aktuálny implementačný checkpoint

- **Hotový lokálny slice:** lazy-load po výslovnom kliknutí, OAuth popup flow, validácia Audiotool project URL, preview s read-only tempo/taktom a samostatné potvrdenie vzdialeného zápisu. Create-only zápis pokrýva pitched MIDI + podporované Beatbox8 drum roly, zvuk (Gakki General MIDI je predvolený a odporúčaný; Heisenberg sine carrier je dostupný po vypnutí voľby), mixer routing a zapnuté tracky/regióny. Všetkých 128 SDK GM programov je dostupných v UI, predvolený výber sa mapuje podľa KYX nástroja a presety sa načítajú až po potvrdení odoslania. Ide o soundfont aproximáciu, nie prenos KYX patchu ani efektov. Idempotentný retry overuje fingerprint, zariadenia, regióny, MIDI hodnoty a route graf; UI znovu kontroluje KYX zdroj po získaní transakčného zámku a chráni lifecycle pri async štarte/unmount. Offline UI validačná cesta vytvára SDK `OfflineDocument`, nie uložený/exportovateľný Audiotool projekt. Cielený aktuálny Nexus balík: 16/16.
- **MIDI časová mierka:** KYX používa 480 tickov/štvrťovú dobu, Audiotool 3 840; mapper prevádza pozície a dĺžky pomerom 8:1. BPM/takt cieľa sa iba číta a zobrazuje; project config sa nemení. Pri odlišnom takte sa môžu líšiť taktové hranice, pretože zdrojové tickové rozloženie zostáva zachované.
- **Offline dôkaz:** `createOfflineDocument()` s povolenou Nexus validáciou vytvoril MIDI track/region/collection/note, Beatbox8 pattern, Heisenberg aj Gakki zariadenie z GM presetu a ich mixer routes; testy overujú zvolený preset, zachovanie nôt a idempotentný retry. Toto samo osebe **nedokazuje** serverovú validáciu ani úspešný živý Audiotool zápis.
- **Podporovaná platforma:** connector UI sa zobrazuje iba v KYX Web. KYX Studio používa `app://bundle`, ktorého OAuth popup/redirect origin nie je zaregistrovaný ani otestovaný; Electron zatiaľ nepodporujeme.
- **Subpath deploy:** Vite build s `STUDIO_APP_BASE=/kyx/` prefixuje entry/assets, PWA `start_url`/scope aj service worker. Mount-aware Chromium smoke na `http://127.0.0.1:4180/kyx/` po oprave `loadCuratedLayer()` načítal sample súbory z `/kyx/samples/` a skončil s 0 browser console errors. Samotný `vite preview` nie je mount-aware a môže pre chýbajúci asset vrátiť HTML SPA fallback; kontrolovať MIME, nie iba HTTP status. Živý smoke `https://qvesterstudio.com/kyx/` 2026-09-27 naopak zlyhal ešte v Qvester shelli: jeho JS/CSS asset URL pod `/kyx/assets/...` vracajú `text/html` (29 console errors). Toto je samostatný host/deploy blocker; do Qvester repozitára sa v tejto práci nič nesynchronizovalo.
- **Dependency gate:** SDK 0.0.19 je exact-pin dev/build dependency; aktuálne emitted Nexus chunks spolu majú 711 KiB oproti 750 KiB opt-in capu, nie sú v initial/PWA precache a browser bundle neobsahuje Node-only `connect-node`/`undici`. `npm audit --omit=dev` hlási 0, ale plný audit hlási 8 advisories: moderate Nexus cez `connect-node`, high `undici`/Vite a critical Vitest v dev dependency tree. Nevykonať dependency bump/override v tomto feature diff-e; samostatný security/dependency review je potrebný pred distribúciou build toolchainu.
- **WASM runtime/deploy gate:** v pracovnom strome existujú `public/audiotool-nexus/document_validator.wasm` (40,017,715 B) a `wasm_exec.js`; Vite ich kopíruje do `dist/audiotool-nexus/`. Sú vylúčené z install-time PWA precache, ale to **neznamená**, že nie sú súčasťou statického deploy artefaktu alebo že ich runtime nepoužije. Pred release treba potvrdiť z browser network trace, či SDK berie lokálny prefix alebo CDN, a zmerať skutočne prenášané/komprimované bajty. Starší Chromium smoke overil CDN cestu (`200`, CORS `*`, WASM MIME) pri offline validácii Heisenberg; aktuálny lokálny asset setup a Gakki voči živému Audiotoolu zatiaľ takto neboli overené. Qvester CSP treba skontrolovať osobitne podľa zvolenej runtime cesty.
- **Deploy artifact gate:** `scripts/sync-to-qvester.mjs` teraz po Vite builde generuje Audiotool LICENSE/NOTICE súbory, spúšťa bundle-budget check a pred kopírovaním vyžaduje Nexus licenčný text. Celá pipeline prešla proti izolovanému cieľu v pracovnom strome; živý Qvester checkout nebol zmenený.
- **Deployed smoke hardening (2026-09-28):** `scripts/release-deployed-smoke.mjs` teraz vyhľadáva same-origin JS/CSS entry a module-preload assets v HTML a kontroluje ich HTTP status, telo aj MIME; trvalé testy v `tests/release-deployed-smoke.test.ts` prechádzajú 4/4 (správny `/kyx` shell aj tri HTTP-200 fallback/MIME prípady). Aktuálny lokálny Qvester preview (`127.0.0.1:6050/kyx/`) prešiel celým release smoke vrátane entry chunkov, CSS, manifestu a workletov; jeho `/kyx/PROVENANCE.json` vracia aplikáciu `kyx`. Produkčný `https://qvesterstudio.com/kyx/` však vracia HTML so statusom 200 a všetkých 27 nájdených JS/CSS URL má `text/html; charset=utf-8`; dokonca aj produkčný `/kyx/PROVENANCE.json` vracia shell HTML. To ukazuje rozdiel medzi správnym lokálnym mountom a zastaraným/nesprávne routovaným produkčným artefaktom; zmeny v aktívnom Qvester repozitári sme nemenili. Priamy Node `fetch` z tohto Windows prostredia mal problém s externou sieťou, preto live dôkaz pochádza z PowerShell HTTP požiadaviek a lokálny end-to-end smoke z Node testu.
- **Aktuálne overenie (2026-09-28):** `npm run typecheck` PASS; Nexus testy 16/16 PASS, spolu s relevantnými intent/groove/PWA/model testami 254/254 PASS; zmenené Nexus TS/TSX súbory Prettier PASS a `git diff --check` PASS. Úplný `npm run test`: 634/656 test files PASS, 7 293 tests PASS, 37 FAIL, 117 skipped (7 447 total); zlyhania sú naprieč intent/groove baseline, presets/loudness, sound-quality, command/automation, model/golden, UI a ďalšími oblasťami, nie v Nexus suite. `npm run format:check` FAIL s 75 súbormi mimo formátu; naše štyri zmenené Nexus TS/TSX súbory prešli samostatnou kontrolou. Produkčný Vite/PWA/license build kompiluje, no pevný DAW JS budget zlyháva: default base 3 203/3 170 KB a aktuálny `/kyx/` build 3 211/3 170 KB. Optional AI 640/650 KB, MP3 166/170 KB, Nexus 711/750 KB, core worklets 129/150 KB a landing 157/600 KB sú v limitoch. Nexus je osobitne vyčlenený, takže jeho nové Gakki UI/writer zmeny tento DAW presah nevysvetľujú; budget sa nezvyšoval.
- **Stále release-blocking:** chýba zaregistrovaný OAuth `clientId`, dedikovaný test project a výslovné potvrdenie pre živý zápis. Posledný zdokumentovaný živý Qvester smoke (2026-09-27) našiel nesprávny MIME na shell assetoch pod `/kyx/assets/...`; pred releasom treba chybu opraviť a znovu overiť. Navyše GitHub `LICENSE`/npm tarball Nexus hovoria Apache-2.0, kým npm metadata deklaruje MIT. Zachovať LICENSE/NOTICE text a pred distribúciou potvrdiť zamýšľanú licenciu publishrom. Kým tieto brány neprejdú, nepovažovať integráciu za release-ready ani za súťažnú compliance.
- **Vite/subpath gate (2026-09-28):** najnovší `STUDIO_APP_BASE=/kyx/ npm run build` skompiloval 791 modulov; built HTML assety aj PWA manifest používajú `/kyx/`, `start_url` a `scope` sú `/kyx/`, LICENSE/NOTICE generovanie prešlo. Lokálne `/kyx/` build artefakty teda majú správny prefix, ale celá build command končí na zachovanom DAW budgete 3 211/3 170 KB. Nexus 711/750 KB, AI 640/650 KB, MP3 166/170 KB, worklets 129/150 KB a landing 157/600 KB sú v limite. Živý Qvester MIME/OAuth smoke nebol touto lokálnou kontrolou nahradený.
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
2. Overiť registráciu aplikácie a Redirect URI pre lokálny Vite server aj produkčný web. Nexus `audiotoolPopup` posiela výsledok na `targetOrigin` (predvolene `window.location.origin`) a Audiotool vyžaduje zhodný origin v registrácii; lokálny server musí používať `127.0.0.1`, nie `localhost`. Zaregistrované URI aj oba runtime originy treba otestovať.
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

## Súťažná stratégia — re-evaluácia 2026-09-28

### Čo súťaž skutočne hľadá

Oficiálna stránka Let's Build uvádza šesť výziev: **Songstarter**, **Composition**, **Sound Design**, **Music Games**, **Connect** a **Marketing & Distribution**. Porota priraďuje kategórie pri posudzovaní a jedna appka môže spadať do viacerých. Hlavná stránka zároveň uvádza, že súťaž je otvorená do **28. septembra 2026** — teda do dneška podľa dátumu tohto review. Stránka neuvádza časové pásmo ani presnú hodinu uzávierky. Odkaz na oficiálny Notion FAQ pri kontrole vracal 404, preto deadline detail, existujúceho projektu a submission požiadavky treba potvrdiť priamo cez Audiotool/Discord alebo `events@audiotool.com` ešte dnes. To, že je KYX už existujúci produkt, samo osebe nepotvrdzuje ani nevylučuje oprávnenosť.

Zdroje: [Let's Build](https://www.audiotool.com/LetsBuild/) · [šesť challenge kategórií](https://www.audiotool.com/LetsBuild/challenges) · [prizes](https://www.audiotool.com/LetsBuild/prizes).

### Najsilnejšie a najvierohodnejšie umiestnenie KYX

**Hlavné:** Songstarter + Composition. **Sekundárne:** Connect. Neprezentovať aktuálny build ako víťaza Sound Design ani Music Games: zatiaľ nevkladá do session vlastný efekt/inštrumentálny DSP nástroj a nejde o interaktívnu performance hru.

Súťažný príbeh by mal byť úzky a demonštrovateľný: **„Napíš hudobný zámer, vyber si z viacerých vypočuteľných beat nápadov a pošli si jeden ako editovateľný songstarter priamo do Audiotoolu.“** KYX sa tak odlíši od generátora hotového audia tým, že používateľ dostane štruktúru, ktorú vie ďalej aranžovať a meniť v cieľovej DAW.

Existujúci kód pokrýva Intent kandidátov a audition; lokálny Nexus slice prenáša pitched MIDI aj podporované Beatbox8 drums do explicitne zvoleného projektu a pred potvrdením zobrazuje read-only BPM/takt cieľa. Pitched party sa štandardne mapujú na Audiotool Gakki GM zvuky, pričom Heisenberg ostáva opt-out fallback; producent tak po importe dostane počuteľnejší/editovateľný štart, hoci nejde o prenos KYX patchov. Nie je to ešte live-overený songstarter: OAuth/cloud zápis sa nevykonal, SDK licenčná nezhoda čaká na potvrdenie publisherom a verejný `/kyx/` deploy má známy asset MIME blocker.

### Súťažný vertical slice s najlepším pomerom dopadu a rizika

1. **Editovateľný Songstarter — lokálny spike hotový.** Implementované sú pitched MIDI, predvolené mapovanie na Audiotool Gakki GM program podľa nástroja s voľbou všetkých 128 programov, Heisenberg fallback, factory/synth drum roly, drum-only export, kolízie a nepodporované hity zobrazené v preview a ohraničenie 64 krokmi. GM soundfont je aproximácia, nie KYX patch transfer; KYX sample zvuk, presná velocity, ratchet, probability a microtiming sa neprenášajú. Machiniste a sample upload ostávajú samostatné neskoršie vetvy; upload navyše potrebuje rights/scope/failure lifecycle review.
2. **Tempo/context — read-only preview hotový.** Pred zápisom sa zobrazí BPM/signature Audiotool session a porovná so zdrojom. Export nemení project config ani neprepočíta MIDI tickové rozloženie; prípadný setter by vyžadoval samostatný explicitný product/SDK gate.
3. **Predviesť hudobnú kvalitu, nielen API.** Jeden krátky prompt-to-beat demo scenár s konkrétnymi obmedzeniami (napr. BPM, nálada, harmónia), nie feature tour celej DAW. Ukázať dve-tri alternatívy, audition, výber GM zvuku, import a následnú úpravu MIDI aj drum patternu v Audiotool. Porotcovia zahŕňajú producentov, hudobno-technologických odborníkov a výskumníkov, takže zvukový výsledok a kontrolovateľnosť musia byť na zázname okamžite zrozumiteľné — toto je produktové odporúčanie, nie citované oficiálne scoring rubric.
4. **Dokázať skutočné Nexus prepojenie.** Zaregistrovaný client ID, overený OAuth návrat, dedikovaný test projekt, jeden živý create-only zápis, refresh/retry bez duplicít a záznam projektu po importe. OfflineDocument test je dôležitý, ale nenahrádza túto ukážku.
5. **Odstrániť release blocker-y pre verejnú ukážku.** Opraviť/overiť `/kyx/` hosting v Qvester shelli, licenčnú nezhodu SDK, build gates a browser smoke. Nepridávať do súťažného pitchu live co-play, MRT2 stream, automatické remixovanie ani všeobecný DAW round-trip — tie nie sú súčasťou dnešného kódu.

### Rozhodovacie brány

- **Teraz:** registrácia/uzávierka/eligibility a existujúci projekt potvrdiť u organizátora; FAQ link momentálne nie je použiteľný.
- **Nasledujúci technický goal:** opraviť aktuálne typecheck/bundle-budget gate-y a overiť browser/deployed `/kyx` smoke. Offline Beatbox8/tempo spike aj create-only vertikálny slice sú hotové; Machiniste ostáva nepodporený.
- **Súťažné MVP:** Songstarter/Composition s pitched MIDI + Gakki GM zvukom predvolene (Heisenberg fallback) + editovateľnými drums + truthful tempo preview + živý Nexus write. Connect je výsledok workflow, nie dôvod rozširovať produkt na full two-way sync.
- **Po súťažnom MVP:** audition/preview GM zvukov ešte pred cloud zápisom, uloženie vlastných mapovaní, bezpečný consentovaný sample upload/import, generative sound-design zariadenia a širší project-aware arrangement; každé s vlastným právnym/licenčným a SDK smoke gate-om.

Nexus dokumentácia potvrdzuje dostupnosť device/pattern entít (vrátane Beatbox8 a Machiniste) a sample API pre upload/insertion, ale samotný katalóg typov nedokazuje, že konkrétny KYX kit možno preniesť korektne. Offline API spike a konkrétny Beatbox8 kontrakt sú teraz overené; Machiniste ani prenos KYX sample-ov tým potvrdené nie sú. [Nexus entity list](https://developer.audiotool.com/js-package-documentation/documents/All_Entities.html) · [Machiniste pattern](https://developer.audiotool.com/js-package-documentation/types/entities.MachinistePattern.html) · [Nexus API / sample upload](https://developer.audiotool.com/js-package-documentation/documents/API.html).

## 8. Odporúčaná `/goal` sekvencia

Ďalšie goals spúšťať v poradí; každý má skončiť konkrétnym gate reportom. Goals 2–4 sú podľa implementačného checkpointu nižšie dokončené pre úzky Beatbox8/MIDI slice, nie pre celý produkt. Nezačínať živý OAuth/write smoke bez registrovaného client ID, dedikovaného test projektu a výslovného potvrdenia vlastníka.

1. **Súťažná eligibility teraz:** vlastník má potvrdiť registráciu, deadline/timezone, existujúceho projektu a submission formát s Audiotoolom. Verejná stránka hovorí „until 28 Sep 2026“ a oficiálny FAQ odkaz pri review vracal 404; kým to organizátor nepotvrdí, nevydávať submission za prijatý ani oprávnený.
2. **Drums + tempo feasibility spike — hotovo pre Beatbox8:** offline `createOfflineDocument()` potvrdil Beatbox8 pattern a read-only target config. Podporované roly, 64-step limit a straty mapovania sú zapísané v checkpoint-e; Machiniste a sample transfer nie sú zahrnuté.
3. **Songstarter plan — hotovo v lokálnom slice:** pitched MIDI + dokázané Beatbox8 role-y, nepodporované/kolidujúce hity v preview, BPM/signature porovnanie a stabilný fingerprint; cieľové tempo sa nemení.
4. **Atomic/create-only writer + UI — hotovo lokálne/offline:** zariadenia, patterns, tracks a routes vznikajú v jednej transakcii s receipt/idempotent retry. Žiadny live cloud write sa zatiaľ nevykonal. Upload audio sample-ov je mimo tohto slice-u.
5. **Živý dôkaz a súťažná prezentácia:** až po client ID, dedikovanom test projekte a výslovnom potvrdení vykonať OAuth → write → retry → projektová kontrola; potom opraviť/overiť `/kyx/` Qvester mount, SDK licenciu/security, build, browser smoke a nahrať krátku ukážku prompt → candidates → audition → Audiotool edit.
Spúšťať v poradí; každý goal má skončiť konkrétnym gate reportom. Keďže MVP vertical slice už čiastočne existuje, prvý goal má overiť a doplniť aktuálny stav, nie znovu vytvárať hotové súbory. Nezačínať živý OAuth/write smoke bez registrovaného client ID, dedikovaného test projektu a výslovného potvrdenia vlastníka.

1. **Current-state + feasibility gate:** skontrolovať existujúci diff a testy, overiť SDK API/licenciu, offline `noteTrack`/`noteRegion` dôkaz a browser WASM loader; pripraviť živý test iba po získaní potrebných vstupov. Výstup: potvrdené hotové časti, presné medzery a go/no-go.
2. **Dependency qualification:** keďže dependency už pinned je, auditovať current package/lockfile, SDK licenciu/transitives, lazy bundle a opt-in load; meniť dependency iba ak gate nájde konkrétny dôvod.
3. **Adapter + failure hardening:** audit auth/session lifecycle, capability checks, error normalization, disconnect/retry/stale confirmation, timeout/circuit behavior; doplniť chýbajúce offline/fake tests bez duplikovania existujúcich testov.
4. **Intent Songstarter write:** overiť mapovanie vybraného KYX candidate → Audiotool plan → create-only confirmed write, MIDI časovanie, idempotentný retry a zachovanie vzdialeného obsahu; bez zmeny project schema.
5. **UX + production/release proof:** uzavrieť CDN WASM a `/kyx/` OAuth/browser smoke, PWA/CSP, dokumentáciu, dependency/security/licence review a aktuálne súťažné podmienky. Živý write sa vykoná len po explicitnom test-project potvrdení.

Goal 1 môže zmeniť poradie alebo zastaviť plán, ak SDK nedokáže spoľahlivo vytvoriť a overiť konkrétny kompozičný artefakt. To je očakávaný technický gate, nie zlyhanie implementácie.

### Copy-paste zadanie pre `/goal`

```text
Dokonči súťažný, bezpečný vertical slice KYX × Audiotool Nexus podľa
`docs/IMPLEMENTATION-ROADMAP-AUDIOTOOL-NEXUS.md`.

Začni aktuálnym auditom diffu a testov; zachovaj nesúvisiace zmeny a
neimplementuj znova hotové časti. Lokálny/offline vertical slice už podporuje
vybraný Intent candidate, pitched MIDI, obmedzený Beatbox8 drum mapping,
read-only BPM/takt preview, explicitné potvrdenie, create-only zápis a
idempotentný retry. Machiniste, sample upload, MRT2 streaming a two-way sync
nie sú podporované.

Najprv rieš bezpečné release gates: triage plného Vitest reportu (7 293 pass,
37 fail, 117 skipped), zníž DAW JS pod zachovaný 3 170 KB budget, potom over
browser/deployed `/kyx` smoke vrátane OAuth návratu, CDN WASM CORS/MIME/CSP a
PWA/service worker. Zachovaj opt-in/lazy-load/create-only kontrakt, Project
Model/Yjs/audio realtime hranice a všetky ADR/AGENTS.md pravidlá. Nezvyšuj
bundle cap bez meraného dôvodu.

Nevykonávaj živý Audiotool zápis bez zaregistrovaného verejného OAuth client ID,
dedikovaného test-project URL a výslovného potvrdenia vlastníka. Client ID nie
je secret; nikdy nepýtaj ani neloguj client secret alebo OAuth tokeny. Vyrieš
SDK publisher license mismatch pred distribúciou. Ak externé vstupy chýbajú,
dokonči bezpečné offline práce a nahlás presný blocker; nepovažuj integráciu za
release-ready. Necommituj ani nepushuj bez samostatnej požiadavky.
```

## Implementačný checkpoint — 2026-09-28

- **Offline schema spike: dokončený pre Beatbox8, nie Machiniste.** Overené na nainštalovanom `@audiotool/nexus` 0.0.19 a reálnom `createOfflineDocument()` validátore. Beatbox8 pattern má 64-slotové pole, dĺžku 1–64 a `stepScaleIndex: 3` pre 16tiny (960 Audiotool ticks; KYX 120 ticks × 8).
- **Mapovanie: implementované a ohraničené.** Factory kick/snare/clap/hat/tom/rim/cowbell/cymbal a vstavané kick/snare/closed/open hat/clap/cowbell synth roly mapujú na Beatbox8. Neznáme/custom samply a generické `perc` zostávajú nepodporené. Roly kolidujúce na rovnakom kroku sa zlúčia a spočítajú; hity mimo 64 krokov sa reportujú. KYX sample audio sa nekopíruje. Velocity sa zmení na spoločný step accent pri prahu 0.75; ratchet/probability/microtiming sa neprenášajú.
- **Cieľový config: iba čítanie.** Preview číta BPM/takt z `config`; prázdny offline dokument zobrazí Audiotool default 125 BPM / 4/4. UI upozorňuje na tempo/taktový nesúlad a poskytuje ručné obnovenie. Žiadna config entity sa nevytvára ani nemení.
- **Writer/UI: lokálne overené.** Jedna Nexus transakcia vytvára MIDI + Beatbox8 + zapnuté tracky/regióny + mixer route; pitched MIDI predvolene používa aktívny Gakki GM preset, ktorý sa načíta z Audiotool katalógu až po write confirmation. Heisenberg sine carrier je dostupný ako fallback po vypnutí GM voľby. Región Beatbox8 sa pri dlhších zdrojových patternoch obmedzí na exportovaný 64-step rozsah. Post-write kontrola a fingerprint retry odmietajú neúplný alebo zmenený graph. OAuth/cloud zápis ostáva explicitne potvrdený; lazy-load sa zachoval. Offline panel je iba in-memory validačná cesta, nie uložený ani exportovateľný Audiotool projekt.
- **Overenie:** Nexus 16/16 PASS; relevantné intent/groove/PWA/model testy spolu 254/254 PASS; strict TypeScript PASS; naše zmenené Nexus TS/TSX súbory Prettier PASS a `git diff --check` PASS. Aktuálny `npm run build` zlyhá na DAW JS budgete (3 203/3 170 KB; Nexus samostatne 711/750 KB). Aktuálny plný Vitest/format výsledok je uvedený v časti „Aktuálny implementačný checkpoint“ vyššie; cap sa nezvyšuje.
- **Local E2E smoke:** 5/6 prešlo. Persistence-roundtrip test timeoutol pred vstupom do štúdia: helper čakal na `.topbar`, ale stránka zostala v Project Browser. Je to mimo Nexus flow a treba opraviť/triagovať samostatne; deployed `/kyx` a cross-browser smoke stále chýbajú.
- **Full Vitest report (2026-09-28):** aktuálny kompletný beh: 634/656 test files PASS; 7 293 tests PASS, 37 FAIL, 117 skipped (7 447 total). Zlyhania sú roztrúsené naprieč intent/groove baseline, AI/golden, presets/loudness, sound-quality, command/automation, UI a audio testami; Nexus integračný súbor v tomto behu PASS (16/16). Tento report zaznamenáva stav pracovného stromu, nie tvrdenie o tom, že zlyhania existovali pred aktuálnymi pracovnými zmenami.
- **Neuzavreté release gates:** full-suite 43 zlyhaní treba triagovať/fixnúť pred release; DAW JS bundle budget je nad limitom; real-browser testy a deployed `/kyx` smoke/CSP/WASM treba zopakovať; SDK license potrebuje publisher/owner review; na živý write naďalej chýba registrovaný verejný client ID, dedikovaný Audiotool test project a výslovné potvrdenie. Žiadny live write sa nevykonal.
