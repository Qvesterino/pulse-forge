# Deploy platforms — KYX (Audit 14 / release readiness)

> The app is a static PWA (`dist/` after `npm run build`) + an optional Node
> collab/gallery server (`server/collab-server.mjs`). This doc covers the
> static deploy for each platform and where the collab server can live.

---

## Cloudflare Pages (recommended)

Free tier covers the static app; PWA + service worker + worklets work
natively. Repo config is committed:

- `public/_redirects` — SPA fallback for first-visit deep links
  (`/studio`, `/gallery`, `/embed`, `/download`, `/landing`). Installed
  clients don't need it: the SW `navigateFallback` (src/pwa.ts) serves all
  navigations from the precache.
- `public/_headers` — `sw.js` + manifest always revalidate.
- `wrangler.toml` — Pages project config (`pages_build_output_dir = "dist"`).

### CLI deploy

```bash
npx wrangler pages login                      # once
npx wrangler pages project create kyx --production-branch=main   # once
npm run deploy:cf                             # build + deploy dist/
```

Or use the committed scripts directly (`preview:cf` runs a local Pages
emulator with the built dist).

### Dashboard deploy (no CLI)

1. `npm run build`
2. Cloudflare dashboard → Workers & Pages → Create → Pages → **Upload assets**
3. Drag the `dist/` folder. Later updates: drag the new `dist/` over it.

### First-visit deep links

`_redirects` maps the five app routes to `index.html` (200 fallback). A
missing JS chunk still 404s loudly (no `/*` catch-all — deliberate).

### Collab / gallery server

`server/collab-server.mjs` is a Node **websocket** app — Cloudflare Pages
cannot host it (no raw WS; relay via Durable Objects would be a rewrite).
Options:

- **Fly.io / Railway / VPS**: `node server/collab-server.mjs` behind a TLS
  proxy. Then set env for clients: `KYX_COLLAB_URL=https://collab.example.com`
  (see `release:deployed-smoke` — it validates `/api/health`, CORS origin and
  the admin token).
- **Self-hosted at home**: Instant Jam works on the LAN; deployed-smoke marks
  the collab checks as skipped when `KYX_COLLAB_URL` is unset.

---

## GitHub Pages (subpath)

GH Pages serves under `/<repo>/` — the app supports that via the
`STUDIO_APP_BASE` build env (asset URLs, PWA scope/start_url and route
parsing all derive from it — see vite.config.ts + src/shared/mountBase.ts):

```bash
STUDIO_APP_BASE=/<repo>/ npm run build
# publish dist/ to the gh-pages branch; add a copy of dist/index.html as
# dist/404.html (GH Pages SPA fallback trick)
```

Caveats: subpath SW scope works, but a custom domain (apex, root deploy) is
the smoother PWA experience. `?import=` share links carry the full URL so
they keep working.

---

## Netlify

Drop-in: `netlify.toml`

```toml
[build]
  command = "npm run build"
  publish = "dist"
[[redirects]]
  from = "/studio"
  to = "/index.html"
  status = 200
[[redirects]]
  from = "/gallery"
  to = "/index.html"
  status = 200
[[redirects]]
  from = "/embed"
  to = "/index.html"
  status = 200
[[redirects]]
  from = "/download"
  to = "/index.html"
  status = 200
[[redirects]]
  from = "/landing"
  to = "/index.html"
  status = 200
```

(Same explicit-routes reasoning as the Cloudflare `_redirects`.)

---

## Post-deploy verification

```bash
KYX_DEPLOY_URL=https://<your-app>.pages.dev npm run release:deployed-smoke
```

Checks: app shell identity, manifest, all five worklet bundles, precache
asset samples; collab/gallery checks run only with `KYX_COLLAB_URL` set.

Then the **owner gates** (manual, your devices — see
`RELEASE_READINESS_REPORT.md`): Safari/iOS AudioWorklet + IndexedDB
persistence + PWA install prompt, and a two-tab Instant Jam on the deployed
URL.
