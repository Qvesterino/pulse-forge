# QMR × KYX — integračný návrh (KYX ako QMR orgán)

> Stav: **KYX-side hotový** (toto repo). QMR-side kroky sú návrhy pre
> Qvester session — žiadne zmeny v QVESTER_LANDING_PAGE neboli spravené.

## Čo už beží na KYX strane (toto repo)

`src/interop/qmrBridge.ts`, viazané v App.tsx (`startQmrBridge(services)`):

1. **Manifest** (`QMR_KYX_MANIFEST`) — AppCapabilityManifest tvar:
   - `handoffOut` **PRIMÁRNY**: `audio_canvas` / `send_beat_to_audio_canvas`
     (packet-verified H53 — WAV + ≤6 role-stemov cez shared IndexedDB,
     bpm/key/camelot hinty; sender `src/interop/qvesterHandoff.ts`)
   - `customCommands`: `kyx.state | kyx.song | kyx.mix | kyx.arrange |
kyx.transport | kyx.undo` — každý typ mapuje 1:1 na REÁLNY MCP tool
   - import/export formáty, supports, assistantPrompts (SK+EN)
2. **Runtime kontrakt** `window.qvesterQmr`:
   - `executeCommand("kyx.<tool>", args)` → `executeMcpToolAsync` —
     deterministická command vrstva, one-undo, verification read-backs,
     D4 zámok. QMR dodá inteligenciu, KYX garanty.
   - `requestHandoff()` — render + persist Audio Canvas handoff, vráti URL
     (mimo Qvester shellu poctivo odmietne — medium je same-origin)
   - `listCommands()` / `manifest`
3. Testy: `tests/qmr-bridge.test.ts` (7) — manifest↔MCP parity, runtime,
   refusaly, handoff guard.

## Návrhy pre Qvester session (QVESTER_LANDING_PAGE)

1. **Manifest do knowledge graphu**: `pulse_forge` je už v KG (mounted,
   route) — doplniť `customCommands` + `handoffOut` z
   `QMR_KYX_MANIFEST` (JSON-identické polia; `kyx.*` typy sú prefixespaced).
2. **Chip nad /pulse-forge route**: apps/KYX je dist mount — dve možnosti:
   a) shell renderuje QMR chip overlay nad route (žiadna zmena v KYX
   builde), alebo
   b) nový QMR wave pridá `QmrMiniChipMount appId="pulse_forge"` do
   shell obálky route — manifest môže prísť z KG alebo runtime
   `window.qvesterQmr.manifest`.
3. **Custom commands execution**: shell môže volať `window.qvesterQmr
.executeCommand(type, args)` priamo (same-origin iframe/postMessage
   podľa architektúry shellu). Nula nových KYX endpointov.
4. **Alternatívny kanál (remote)**: KYX je plnohodnotný MCP server
   (web: POST /mcp na collab serveri + /mcp-relay; desktop: stdio) —
   ak QMR beží mimo origin KYX okna, MCP je transport bez cross-origin
   kompromisov. Detaily: docs/INTENT-MCP-EXPANSION-PLAN.md,
   docs/AGENTIC-ZCODE-SETUP.md.

## Záruky (prečo je to bezpečné)

- QMR nemá vlastnú cestu do dokumentu — výhradne `kyx.*` → MCP tooly →
  deterministic command layer (clamps, strict targets, one-undo).
- Deštrukcie ostávajú za D4 zámkom (user flip v ⚡ chipu).
- Každý call vracia verification read-back — QMR overí stav, nie echo.
- Handoff medium je same-origin; standalone KYX deploy handoff poctivo
  odmietne.
