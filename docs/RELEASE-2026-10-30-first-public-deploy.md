# KYX — the first public deployment (2026-10-30)

| Item            | Value                                                                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live URL**    | https://kyx-d40.pages.dev                                                                                                                                                                                                               |
| Host            | Cloudflare Pages, project `kyx`, production branch `main`                                                                                                                                                                               |
| Build           | commit `fa4184ab` — KYX Web as a static PWA (`dist/`)                                                                                                                                                                                   |
| Deployed bytes  | 458 files, **88.6 MB** (the full local build is 414.6 MB — see "What is not deployed")                                                                                                                                                  |
| Verified before | `npm run build` → `[size-budget] OK`; `npm run release:preflight` → **PASS**; `npm run test:browser:production` → **PASS**                                                                                                              |
| Verified after  | `npm run release:deployed-smoke` against the live URL → **PASS** (app shell, JS/CSS content types, the KYX manifest identity, all five worklets, the service worker; the collab/gallery checks report themselves as **SKIP** — no host) |
| Browser boot    | a real Chromium against the live URL: the landing page renders (**0 console errors, 0 failed requests**) and `/studio` mounts the workstation for a returning user (**0 console errors, 0 failed requests**)                            |

This is the **first** time KYX Web has been reachable from the open internet. Before
2026-10-30 the product existed only as a repository: the Cloudflare Pages project had
never been created (`wrangler.toml` said so: _"First-time setup (CLI): npx wrangler
pages project create kyx"_), and the launch kit still carried a `[DEPLOYED-URL]`
placeholder.

---

## What is deployed

The whole static app, served as a PWA: `/studio`, `/landing`, `/gallery` (shell),
`/embed`, `/download`, `/agents`, plus the service worker and its precache. A first
visit needs no install; the precache is 9.9 MB and the rest streams on demand.

## What is NOT deployed — and why (measured limits, not choices)

Two hard limits shaped this artifact. The deploy platform caps the whole artifact at
**200 MB**; Cloudflare Pages caps **one file at 25 MiB**. Three assets did not fit,
and every one of them is provably unused by the app:

1. **The piano sample pack (235.7 MB)** — the single biggest asset, and the only one
   whose size is worth arguing about. It is the only thing cut that changes what a
   user hears: the pack's sample references degrade the way the app already degrades
   when a pack is absent (the preset browser skips what it cannot load and says so).
   The production smoke proves the app still boots, renders a template, renders the
   FX rack and runs the ONNX ranker without it. **The piano pack stays in the
   repository and in the full local build** — see "Next" below.
2. **Two ONNX Runtime wasm variants (52.1 MB)** —
   `assets/ort-wasm-simd-threaded.jsep-*.wasm` (WebGPU) and
   `assets/ort-wasm-simd-threaded.asyncify-*.wasm`. The app never loads either: all
   four model workers fetch **one named file**, `/models/ort/ort-wasm-simd-threaded.wasm`
   (`src/ai/ranking/ranker-worker.ts`, `src/ai/symbolic/prior-worker.ts`,
   `src/intent/model-worker.ts`, `src/mastering/mastering-ranker-worker.ts`). The
   deployed set keeps both 13.3 MB variants, so the per-file limit holds.
3. **The vendored Audiotool Nexus document validator (38.2 MB)** — the app fetches
   that validator from the Audiotool CDN at runtime; the vendored copy is explicitly
   excluded from the PWA install payload (`src/pwa.ts`) and nothing loads it.

**The collab / gallery server is not deployed either** — it is a Node websocket app
(`server/collab-server.mjs`), and Cloudflare Pages hosts only the static app. Until
it gets a host (Fly.io / Railway / VPS), **multiplayer and the public gallery are
off**. The app degrades honestly: the boot gate tolerates the refused optional
service, and the deployed smoke marks those checks as skipped.

## Next (the two things this deployment owes the product)

1. **Host the piano pack separately** — a CDN or its own Pages project, referenced
   from the pack manifest, so the full preset set ships publicly. The limit is
   per-deployment, not per-product.
2. **A host for the collab server** — it is the only thing between this build and
   working multiplayer, and the gallery is what turns "a tool" into "a place".

## The brand gate that caught a real leak

The release preflight refused the first deploy: the QMR ecosystem chunk shipped
`"KYX (Pulse Forge)"` and `"ZYVO (VocalForge DAW)"` — the old public names next to
the current ones. The names were changed in the sibling repository
(`Qvester_AI_STUDIO_LANDING_PAGE`, `packages/qmr-hud/`), the compiled knowledge graph
was regenerated to match, and the KYX-side rule was narrowed to what its own comment
says it means — _a legacy label must never appear in shipped user-facing copy_, not
"in any string". The identifiers (`appId "pulse_forge"`, `appId "vocalforge_daw"`,
the route `/pulse-forge`, the external repo `repo://vocalforge-daw`) are interop
protocol keys and are not brand statements to a user.

The rule lives in `scripts/release-brand-rule.mjs` and is locked by
`tests/release-brand-rule.test.ts` (5 specs): every display name and keyword is still
caught, every identifier still passes, and the preflight runner is asserted to import
the one rule instead of repeating it.

## Provenance (this repo, 2026-10-29 → 30)

- The KYX/ZYVO public-name rename in `qmr-knowledge.ts` / `capability-manifest.ts`
  landed in `6a3a8c986` (a parallel session's commit in the sibling repository
  absorbed the staged index; the content is intact).
- The KYX-side brand rule (`scripts/release-brand-rule.mjs`, the preflight narrowing
  and its spec) was committed by a parallel session in `4c53cf42` for the same
  reason.

## Verify it yourself

```bash
KYX_DEPLOY_URL=https://kyx-d40.pages.dev npm run release:deployed-smoke
```

The static checks need no collab host; the server-side checks report themselves as
skipped when `KYX_COLLAB_URL` is not set. That skip is honest, not a pass.
