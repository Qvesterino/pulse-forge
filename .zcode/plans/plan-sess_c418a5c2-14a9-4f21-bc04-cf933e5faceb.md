# KYX → Qvester Studio ekosystém (mounted chamber + sync bridge)

**Cieľ:** KYX ako plnohodnotná appka na `qvesterstudio.com/pulse-forge` — karta v ekosystéme, povýšenie interop záznamu z `external_repo` na mounted. Zdroj ostáva v `D:\pulse-forge`, do landing repa sa syncuje built dist (jeden príkaz). Bonus: rieši súťažný URL.

**Prečo je to ľahké:** `pulse_forge` už v interop vrstve existuje (`QVESTER_APP_IDS` types.ts:23, KG :5283, capability-registry :2282 ako `external_repo` — čaká na povýšenie). A KYX má vďaka cross-platform kampani `configureAssetBase()` (src/shared/assetUrls.ts) postavenú presne pre subpath hosting.

## Fáza A — KYX subpath podpora (D:\pulse-forge, malé zmeny)

1. `vite.config.ts`: `base: process.env.STUDIO_APP_BASE ?? "/"` (konvencia Qvester build systému).
2. `src/main.tsx`: (a) `configureAssetBase(import.meta.env.BASE_URL)` raz pri boote → všetky worklety/modely/samples sedia pod /pulse-forge/; (b) extrahovať `stripBasePath(pathname, base)` do `src/shared/` a použiť v `PATH` — router regexy (`/^\/studio/`…) musia matchovať aj `/pulse-forge/studio`.
3. Unit test pre `stripBasePath` + verifikácia: `STUDIO_APP_BASE=/pulse-forge/ npx vite build` → dist index.html má /pulse-forge/ asset paths; default build bez env sa NEZMENÍ (bundly, testy, budgety zelené).
4. Overiť SW scope (vite-pwa rešpektuje base) a že /embed, /gallery, /landing cesty fungujú pod base.

## Fáza B — Sync bridge (pulse-forge strana)

5. `scripts/sync-to-qvester.mjs` + npm script `ecosystem:sync`: build s `STUDIO_APP_BASE=/pulse-forge/` → skopíruje `dist/*` do `D:\QVESTER_LANDING_PAGE\apps\KYX\dist` → zapíše PROVENANCE (commit hash, čas) → validuje artifact (index.html existuje, asset paths začínajú /pulse-forge/).

## Fáza C — Integrácia v QVESTER_LANDING_PAGE (podľa ich vlastného checklistu)

6. `scripts/studio-apps.config.mjs`: entry `pulse-forge` (mountPath `/pulse-forge`, spa, `useRootNodeModules`, buildScript = verify-only nad vendored dist, qmr registrácia `pulse_forge`, runtimeNotes).
7. Shell routing: `src/content-types.ts` StudioRoute union + `src/state/studioCore.ts` `STUDIO_ROUTE_META['/pulse-forge'] { mounted: true }`.
8. `src/content-shell.ts`: `surfaceRegistrySeed` (karta: kind/branch podľa ich taxonómie — audio DAW do creative_forge, status Live, launch mounted) + voliteľne `surfaceRelations`.
9. `src/data/ecosystemSurfaceGraph.ts`: konštelačný node (pozor na pinované počty v testoch).
10. `public/_redirects`: `/pulse-forge/* /pulse-forge/index.html 200`.
11. Interop povýšenie: KG (`qmr-knowledge-graph.json:5283`) → status/launch na mounted; regenerovať capability-registry ich skriptom; handoffs (accepts scene_brief, produces beat_pattern) nechám zapísané = pripravené pre fázu 2.
12. **Pušťať ich brány:** `npm run build:studio` (build:apps --app pulse-forge + shell build), ich node:test suity (playfield-integrity, constellation-graph, content-integrity, ecosystem-print), `npm run ecosystem:drift` (musí byť 0 driftu), typecheck. Pred úpravami si prečítať ich AGENTS/CLAUDE.md ak existuje.

## Fáza D — Verifikácia

13. Preview landing repa → `http://localhost:<port>/pulse-forge/` bootuje KYX (project browser, worklety sa loadnú, audio funguje).
14. Deep link s `?import=<share code>` otvorí beat priamo v mounted appke.
15. `npm run ecosystem:print` — KYX riadok v handbooku bez driftu.

## Fáza 2 (samostatná vlna, NIE teraz)

Audio-reactive handoff: KYX render → WAV + `AudioAnalysisProfileV2` (bpm/key/Camelot/beatGrid — ich formát) cez `qvester:handoff:` packet → Atoma/SIQ vizualizery tancujú na KYX beat. Prípadne same-origin embed `/pulse-forge/embed` widgetu do shellu (CSP dovoľuje same-origin frame).

## Riziká

- QVESTER_LANDING_PAGE je živé vydané repo s náročnými verify-scriptami → diff držím fokusovaný, riadim sa ich testami; dist vendoring znamená, že sync treba zopakovať pred každým KYX release-om (jeden príkaz).
- Concurrent session v pulse-forge: fáza A mení main.tsx/vite.config — malé, dobre oddelené zmeny; ich commity ich vstrebejú ako doteraz.
- Ak ich CI (Cloudflare Pages `pages:build:studio`) neprechádza z mojej ruky, doručím ready diff + inštrukcie na ich push.