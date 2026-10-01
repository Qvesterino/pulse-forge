# AGENTIC DOGFOOD LOG — reálna agentná session proti KYX MCP

> Live záznam trenia z prvej agentnej session (GLM-5.3 cez MCP).
> Každý finding: čo sa stalo / vrstva / stav fixu. Dopĺňa sa počas práce.

## Nájdené trenie

| #   | Fáza     | Finding                                                                                                                  | Vrstva           | Stav                                        |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------- |
| 1   | Boot     | `desktop-dev.mjs` čakal na `^Local:\s+`, ale vite v6.4 obaľuje banner ANSI kódmi (`[1mLocal[22m:`) — wait VŽDY timeoutol | dev tooling      | **FIXED** (match `/Local/i`)                |
| 2   | Boot     | Electron spawn cez `spawnNode` = node.exe parse electron.exe ako JS (`MZx` syntax error) — skript nikdy nespustil okno   | dev tooling      | **FIXED** (priamy spawn binárky)            |
| 3   | Session  | `destructiveRefusal` nemalo `isError: true` — zamietnutá deštrukcia vyzerala ako úspešný no-op                           | tool contracts   | **FIXED** (chytil agent simulation)         |
| 4   | Session  | `kyx_steps` target-failure (neznámy family / neplatné steps) bez `isError`                                               | tool contracts   | **FIXED** (chytil agent simulation)         |
| 5   | Workflow | drill Grime kit nemá ŽIADNY hat pad — `kyx_steps hat` poctivo odmieta; agent musí čítať grid prv                         | agent experience | zdokumentované (playbook hovorí read-first) |
| 6   | Workflow | drill pattern oplýva obsadeným last-16th — ghost na ňom je no-op; read-before-act rieši                                  | agent experience | by design (ghost len na prázdne steps)      |

## Poznámky

- Desktop dev script zjavne nikdy nebežal end-to-end na tomto stroji (dva
  boot-bloky za sebou pred prvým oknom).
- Agent simulation E2E (`tests/mcp-agent-simulation.test.ts`) je regresný
  gate: fake agent prehrá celý playbook (hello-KYX, beat workflow,
  checkpoint experiment, producer moves, batch, song, hooks) a overuje
  STAV + isError kontrakty. Beží v plnom vitest suite => verify:all ho
  zamyká automaticky.
- Simulácia pri prvom behu chytila 2 reálne isError medzery (findingy 3+4)
  — presne na to bola staveneá.
