## KYX Desktop — Electron balenie (Windows)

**Stratégia:** obaliť produkčný `dist/` build cez custom `app://` protokol. Všetky root-absolutné URL v kóde (`/core-worklet.js` v `src/audio-worklets/loader.ts:98`, `/models/...` v ranker-workerovi, `/samples/...` v `curated.ts`) sa pod `app://bundle/...` (standard scheme) rozrešia automaticky — **nulové zásahy do audio enginu, persistence aj workletov** (v duchu ADR 0001: "desktop packaging must not contaminate the core design"). Nové devDeps: `electron`, `electron-builder`.

### Nové súbory
1. **`desktop/main.cjs`** — Electron main:
   - `registerSchemesAsPrivileged` pre `app://` (standard, secure, supportFetchAPI, stream) + `protocol.handle` servujúci `dist/` s ochranou proti path traversal
   - BrowserWindow 1280×800 (min 1024×640), tmavé pozadie `#14161c`, `contextIsolation: true`, `sandbox: true`, bez nodeIntegration
   - permission request/check handler: povoliť `media` (mikrofón) a `midi` — potichu, bez dialógov
   - `will-download` handler → natívny Save-As dialóg (WAV/MP3/MIDI/JSON exporty sa uložia cez priebojník, nie do Downloads)
   - `autoplay-policy=no-user-gesture-required`, single-instance lock
   - dev režim: env `KYX_DEV_URL` → načíta Vite dev server; inak `app://bundle/index.html`
2. **`desktop/preload.cjs`** — `contextBridge.exposeInMainWorld("kyxDesktop", { isDesktop: true })`
3. **`electron-builder.yml`** — productName **KYX**, appId `app.kyx.studio`, ciele: NSIS inštalátor (per-user, bez admina) + portable `.exe`, ikona z `public/maskable-512x512.png`, výstup do `release/`
4. **`scripts/desktop-dev.mjs`** — spustí Vite dev server + Electron spolu (jedno okno na vývoj)
5. **`scripts/desktop-package.mjs`** — nakopíruje ikonu, spustí `npm run build` s `KYX_DESKTOP=1` a potom `electron-builder --win`
6. **`scripts/desktop-smoke.mjs`** — spustí Electron nad `dist/`, overí že renderer nabootuje bez page errorov (exit code 0/1)
7. **`docs/adr/0010-desktop-packaging.md`** — ADR podľa konvencií repa + sekcia v README

### Zásahy do existujúcich súborov (minimálne, web správanie sa nezmení)
1. **`vite.config.ts`** — preskočiť `VitePWA()` keď `KYX_DESKTOP=1` (desktop dist nebude mať sw.js/manifest; `virtual:pwa-register` spadne na existujúci stub alias) — ~2 riadky
2. **`src/sw-update.ts`** — early-return keď `location.protocol` nie je http(s) (poistka pre `app://` aj dev) — ~2 riadky
3. **`src/main.tsx`** — v `Entry()` pri `window.kyxDesktop?.isDesktop` rovno do štúdia (preskočiť landing page) + drobný global type declaration — ~3 riadky
4. **`package.json`** — devDeps + skripty `desktop:dev`, `desktop:build`, `desktop:smoke`

### Ostáva nezmenené (overené v explorácii)
- IndexedDB projekty/samples pod stabilným secure origin → prežijú reštart aj update appky (dáta v `%APPDATA%/KYX/`)
- Collab ostáva opt-in cez CollabPanel (manuálne URL servera), Freesound aj onnxranker fungujú, exporty cez natívny dialóg

### Overenie
1. `npm run typecheck` + `npm test` zelené
2. `npm run desktop:build` → `release/KYX-Setup-0.1.0.exe` + portable exe
3. `npm run desktop:smoke` prejde
4. Manuálny smoke: štart rovno do štúdia, prehratie factory kitu, načítanie všetkých 5 workletov bez chýb, create/reopen projektu cez reštart, drag-drop sample import, WAV export cez natívny dialóg, mic + MIDI bez blokovaných permissionov

### Mimo rozsah v1
Auto-update (electron-updater — čaká na rozhodnutie o deploy hostiteľovi), macOS/Linux ciele, code signing, bundlovanie collab servera.

Odhad: jeden sedenie — konfigurácia Electronu je rutina, všetky riziká (absolutné cesty, SW, permissions) sú už namapované.