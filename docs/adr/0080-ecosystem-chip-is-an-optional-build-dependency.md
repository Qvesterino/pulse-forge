# ADR 0080 — The ecosystem chip is an optional build dependency; the app owns the host side of the command bus

Date: 2026-10-28 · Status: Accepted (shipped) · Scope: build system, QMR interop, CI

## Context

KYX mounts the QMR HUD chip from the sibling monorepo (`D:\QVESTER_LANDING_PAGE`, package `@qvester/qmr-hud`).
The package ships **TS source** and is aliased in-place — there is no published build and nothing is vendored into
this repo.

That worked on the dev machine, where the two checkouts sit side by side. It did not work anywhere else.

### The failure (measured, not inferred)

GitHub Actions has no sibling checkout. `vite.config.ts` documented the consequence before anyone hit it:

> without it the aliases point at a directory that does not exist and **vite build dies on ENOENT before producing
> anything**

Reproduced in a clean Linux checkout (WSL Ubuntu, node v22.22.3) at commit `7355b809`:

| Job                      | Symptom                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production build         | `vite build` dies: `Failed to resolve import @qvester/qmr-hud/command-bus.ts`                                                                                    |
| Production browser smoke | same build, same death                                                                                                                                           |
| E2E smoke                | **7 of 8 specs fail** — the page shows "KYX crashed … Failed to resolve import …" and never mounts `.topbar`                                                     |
| Browser audio checks     | the app cannot boot, so there is no audio to check                                                                                                               |
| Unit tests (vitest)      | **3 collection errors** (`tests/a11y-panels.test.tsx`, `tests/ui/App.test.tsx`, `tests/ui/track-reorder-shortcut.test.tsx`) — the module graph cannot resolve it |

One static import, five red jobs.

### Why the sibling cannot simply be fetched by CI

Measured, not assumed:

- `https://api.github.com/repos/Qvesterino/Qvester_AI_STUDIO_LANDING_PAGE` → **404** unauthenticated, while the owner
  account `Qvesterino` serves dozens of public repos. The sibling is **private** (or renamed).
- `https://api.github.com/search/repositories?q=qvester+OR+qmr+user:Qvesterino` → `total_count: 0`.

So a CI checkout step would need a token secret that does not exist, and the repo would still not build for anyone
who clones it. A pilot reviewer must be able to `git clone` this repo and get a studio.

### What the dependency actually costs

The reachable closure from the app's two import sites, measured with a TypeScript-AST walk: **185 sibling files,
3.07 MB of source**, plus

- `zustand` — **not a dependency of this app** (6 uses in the closure),
- `zod` — the closure wants the sibling's **3.25.76**; this app resolves **4.5.4**,
- `@qvester/boot-screen` — a **fifth** package that no alias covers and that resolves only through the sibling's
  `node_modules` (the monorepo's `file:` deps).

Vendoring that closure would add ~3 MB of foreign source, two new runtime dependencies, and a zod major-version
split — to carry a chip trigger.

## Decision

**The app owns the host side of the ecosystem command channel, and the chip becomes an optional, lazily loaded
affordance with an in-repo fallback.**

1. **The host bus is KYX's own module** (`src/interop/qmrCommandBus.ts`). The channel is a DOM-event contract
   (`qmr:command` → `qmr:command-response`, matched by `requestId`); the app is the **host** of it, and the sibling's
   copy was mostly HUD-side machinery (`dispatchViaHostBus`, shortcut emulation) the app never used. ~40 lines, fully
   typed, testable without the sibling.
2. **The chip stays a sibling import, but only DYNAMICALLY** (`lazy(() => import("@qvester/qmr-hud/…"))`), and the
   alias **falls back to an in-repo stub** (`src/integrations/qmr-hud-stub/`) when the sibling is absent. The stub
   renders nothing — the app already treats a failed chip load as "no chip" (`QmrErrorBoundary` renders null).
3. **The fallback must not change what the gates measure.** The chip lives in its own optional bundle bucket
   (`qmr-` prefix, 1600 KB) and is forbidden in the boot path, so a build without the sibling measures the same DAW
   total and the same boot path as a build with it.
4. **Drift is a red test, not a silent disconnect.** `tests/qmr-command-bus.test.ts` compares our event names against
   the sibling's own declarations whenever the sibling IS present.

## Consequences

- The repository builds and boots from a clean clone, with or without the sibling.
- The static `@qvester` import is gone from the app, so the failure mode cannot come back unnoticed:
  `tests/qmr-hud-optional-build.test.ts` fails on any new static `@qvester` import, and asserts that the alias always
  resolves to a file that exists.
- The host bus is now covered by KYX's own suite — in CI too, where the sibling is absent.
- `vitest.config.ts` now honours `QVESTER_SIBLING_ROOT`, which it did not before: the test graph always pointed at a
  hardcoded `../QVESTER_LANDING_PAGE`, so a CI run and a local run could resolve different sources.

## Rejected alternatives

| Alternative                            | Why not                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Vendor the reachable closure (3.07 MB) | foreign source + `zustand` + a zod major split + a fifth package through `node_modules` — to carry a chip trigger |
| CI checks out the private sibling      | needs a token secret that does not exist; the repo still would not build for a reviewer                           |
| Stub the command bus too               | the real host bus would then be untested in CI — the tests would cover the stub, not the product                  |
| Drop the chip entirely                 | it is a live integration surface of the Qvester ecosystem; the fallback keeps it wherever the sibling exists      |
