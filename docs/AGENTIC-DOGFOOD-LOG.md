# AGENTIC DOGFOOD LOG — reálna agentná session proti KYX MCP

> Live záznam trenia z prvej agentnej session (GLM-5.3 cez MCP).
> Každý finding: čo sa stalo / vrstva / stav fixu. Dopĺňa sa počas práce.

## Nájdené trenie

| # | Fáza          | Finding                                                                                        | Vrstva            | Stav                                      |
| - | ------------- | ---------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------- |
| 1 | Boot          | `desktop-dev.mjs` čakal na `^Local:\s+`, ale vite v6.4 obaľuje banner ANSI kódmi (`[1mLocal[22m:`) — wait VŽDY timeoutol | dev tooling | **FIXED** (match `/Local/i`)              |
| 2 | Boot          | Electron spawn cez `spawnNode` = node.exe parse electron.exe ako JS (`MZx` syntax error) — skript nikdy nespustil okno | dev tooling | **FIXED** (priamy spawn binárky)          |
| 3 | (doplňuje sa) |                                                                                                |                   |                                           |

## Poznámky

- Desktop dev script zjavne nikdy nebežal end-to-end na tomto stroji (dva
  boot-bloky za sebou pred prvým oknom).
- (doplňuje sa)
