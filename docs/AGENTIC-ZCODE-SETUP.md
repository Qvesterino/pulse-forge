# AGENTIC SETUP — napojenie KYX na LLM agenta (ZCode / Claude Desktop)

> Fáza E plánu docs/AGENTIC-DAW-PLAN.md. Cieľ: LLM agent (GLM-5.3 v ZCode,
> Claude Desktop, ...) vidí `kyx_*` tooly a ovláda KYX cez deterministickú
> command vrstvu. Reťaz: **agent → stdio forwarder → loopback bridge (KYX
> desktop) → KYX okno**. Všetko beží lokálne, nič neopúšťa stroj.

---

## 1. Prerekvizity

- **KYX desktop** bežiaci (dev: `npm run desktop:dev`; packaged: nainštalovaný KYX).
- Projekt otvorený v KYX — MCP volania vykonáva konkrétne otvorené okno.

## 2. V KYX: povoľ MCP a skopíruj config

1. V INTENT paneli klikni na **⚡ chip** (vpravo hore, vedľa 🤖).
2. Chip zapne loopback bridge (127.0.0.1, token-auth) a pod ním zobrazí blok
   **MCP** s JSON konfiguráciou.
3. Klikni **KOPIÍROVAŤ**. Vzerá približne takto (hodnoty sú vždy čerstvé):

```json
{
  "command": "C:\\path\\to\\electron.exe",
  "args": ["C:\\path\\to\\pulse-forge\\desktop\\mcp-server.cjs"],
  "env": {
    "ELECTRON_RUN_AS_NODE": "1",
    "KYX_MCP_BRIDGE_URL": "http://127.0.0.1:8787/rpc",
    "KYX_MCP_TOKEN": "<48-hex token>"
  }
}
```

> `ELECTRON_RUN_AS_NODE=1` je dôležité: command je electron/KYX binárka a tento
> env ju prepnú do plain-node režimu (packaged KYX.exe tak slúži ako node
> runtime — na stroji nemusí byť globálny node).

⚠ **Token + port sa menia pri každom zapnutí** — po re-enable vždy skopíruj
čerstvý config a aktualizuj agenta (sekcia Troubleshooting).

## 3. Napoj do ZCode

**User scope** (doporučené — platí pre všetky workspacy): uprav
`C:\Users\<ty>\.zcode\cli\config.json` a pridaj server pod `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "kyx": {
        "command": "C:\\path\\to\\electron.exe",
        "args": ["C:\\path\\to\\pulse-forge\\desktop\\mcp-server.cjs"],
        "env": {
          "ELECTRON_RUN_AS_NODE": "1",
          "KYX_MCP_BRIDGE_URL": "http://127.0.0.1:8787/rpc",
          "KYX_MCP_TOKEN": "<token z chipu>"
        }
      }
    }
  }
}
```

Prípadne **workspace scope** (len pre tento repo, shareovateľné — ale NIKDY
necommittuj token!): `D:\pulse-forge\.zcode\config.json`, tá istá štruktúra.

Reštartuj session. ZCode MCP servery **auto-connectujú** pri štarte; stav
skontroluješ v Settings → MCP (server `kyx` má byť connected, 20+ toolov).

## 4. Alebo napoj do Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json` — ten istý objekt pod
`mcpServers`:

```json
{
  "mcpServers": {
    "kyx": {
      "command": "C:\\path\\to\\electron.exe",
      "args": ["C:\\path\\to\\pulse-forge\\desktop\\mcp-server.cjs"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "KYX_MCP_BRIDGE_URL": "http://127.0.0.1:8787/rpc",
        "KYX_MCP_TOKEN": "<token z chipu>"
      }
    }
  }
}
```

Reštartuj Claude Desktop → ikona nástrojov zobrazí `kyx_*`.

## 5. "Hello KYX" — smoke checklist (5 volaní)

Keď je agent pripojený, prepíš mu (alebo ho nech urobiť sám — to je pointa):

| #   | Povedz agentovi                        | Čo volá                                        | Očakávané read-back                    |
| --- | -------------------------------------- | ---------------------------------------------- | -------------------------------------- |
| 1   | "Prečítaj KYX project overview"        | `kyx_state {subject: overview}`                | BPM, tracks, patterns, aktívny pattern |
| 2   | "Vygeneruj techno pattern, seed hello" | `kyx_generate {genre: techno, seed}`           | názov patternu + BPM (one undo)        |
| 3   | "Pridaj kick na step 5"                | `kyx_steps {op: add, family: kick, steps:[5]}` | "kick add: N → N+1 steps"              |
| 4   | "Prečítaj aktívny pattern a over"      | `kyx_state {subject: pattern}`                 | grid obsahuje step 5 (verifikácia!)    |
| 5   | "Undo a over že sa vrátilo"            | `kyx_undo` + `kyx_state`                       | grid bez step 5                        |

Ak všetkých 5 prešlo: agent riadi KYX naplno. Testuj ďalej: `kyx_batch`
(10 volaní v jednom undo), `kyx://project/*` resources, `kyx_analyze` (keď
dorazí Fáza B).

## 6. Troubleshooting

| Symptóm                                    | Príčina / fix                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Agent nevidí `kyx_*` tooly                 | ZCode: Settings → MCP stav servera; skontroluj JSON syntax v config.json (žiadne komentáre)           |
| Tool call timeout / "window not available" | KYX okno minimalizované/zatvorené alebo bridge vypnutý — otvor KYX, zapni ⚡                          |
| 401 / unauthorized                         | Token v agentovi ≠ token bežiaceho bridge — **skopíruj čerstvý config z chipu** (mení sa pri enable)  |
| Connection refused na 8787                 | Bridge nepočúva (⚡ off) alebo port zaneprázdnený a bridge si zobral iný — čerstvý config rieši oboje |
| Agent "zmazal" a nemôže vrátiť             | D4: mazanie je zamknuté — povoľ 🔒 MAZANIE v chipi (alebo nechaj zamknuté, undo funguje vždy)         |
| Dlhý export timeoutol                      | Render/generovanie majú 60 s; pri extrémne dlhom rendri download aj tak pristane v KYX okne           |

## 7. Bezpečnostný model (prečo je to OK nechať zapnuté)

- Bridge počúva **len 127.0.0.1** a vyžaduje Bearer token (constant-time compare).
- Agent NEMÔŽE obísť doménu: každý tool ide cez deterministickú command vrstvu
  (clamps, strict targets), každá mutácia je jeden undo krok.
- Deštrukcie sú default **zamknuté** (D4) — povoľuje ich user, nie agent.
- Off switch: ⚡ chip vypne bridge okamžite.

## 8. Web varianta (advanced)

KYX v prehliadači + `npm run collab` s `MCP_TOKEN=<tajomstvo>`: streamable-HTTP
na `<server>/mcp` + relay do okna (⚡ chip web vetva). Pre ZCode/Claude Desktop
je stdio varianta vyššie jednoduchšia a preferovaná — web využij pre remote
scenáre.

---

## Pre agentov čítajúcich tento súbor

Volaj štruktúrované tooly nad free-text `kyx_intent` (spolahlivejšie), čítaj
`data` JSON obálky kvôli tokenom, a overuj každú mutáciu read-backom — tooly
to robia za teba, ale never dispatchu, ver stavu. `kyx_batch` na série, undo
funguje vždy. Detaily: `kyx://playbook` resource (keď dorazí Fáza A).
