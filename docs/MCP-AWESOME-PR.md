# MCP ŤAH #5 — awesome-mcp-servers PR (draft, ready-to-paste)

> Stav: obsah hotový, čaká na repo pre-flight ( checklist dole — 10 min,
> rozhodnutia usera). Repo musí byť PUBLIC + hľadateľné ako MCP server,
> kým PR otvoríme, inak ho maintaineri zamietnu ako "dead link".

---

## 1. Repo pre-flight (USER — ~10 min na GitHub.com)

- [ ] **Description** (pod názvom repa): `KYX / Pulse Forge — browser-first DAW with a built-in MCP control surface: AI agents (Claude, Cursor, …) drive the studio through 27 deterministic tools. Local-first, no cloud.`
- [ ] **Website** pole: URL deployu (po wrangler login — ťah z deploy kampane)
- [ ] **Topics**: `mcp` `mcp-server` `model-context-protocol` `daw` `webaudio` `ai-agents` `music-production` `typescript`
- [ ] **LICENSE súbor** — rozhodnutie usera (pozri `docs/LAUNCH-HN-REDDIT.md` §pre-flight): MIT/Apache-2.0 ak chceš komunitu a PR akceptovaný; inak "source-available" vetu do README. **PR bez licence maintaineri nereviewujú.**

## 2. Čo pridáme do ich README (exact line)

Repo: `punkpeye/awesome-mcp-servers` (najväčší curated zoznam). Sekcia:
music/audio (pri otvorení PR skontroluj aktuálne názvy sekcií — zoznam
sa mení; KYX patrí k audio/music alebo creativity, podľa čoho tam už je).

```markdown
- [KYX](https://github.com/Qvesterino/pulse-forge) — Browser-first DAW driven by AI agents: 27 MCP tools (transport, mixer, FX, arrangement, song builder, export) over a deterministic command layer — every action one undo step, verification read-backs, zero cloud. ![Open Source](https://img.shields.io/badge/license-TBD-green)
```

⚠ Počet toolov (27) = `server/mcp-core.mjs MCP_TOOL_DEFS.length` po
kyx_publish_gallery — over `node -e "import('./server/mcp-core.mjs').then(m=>console.log(m.MCP_TOOL_DEFS.length))"`
pred odoslaním.

## 3. PR body (paste do GitHub PR formulára)

**Title:** `Add KYX — browser-first DAW with a built-in MCP control surface`

**Body:**

> ### What is KYX?
>
> KYX (repo name Pulse Forge) is a browser-first digital audio workstation
> (Web Audio + AudioWorklet, TypeScript/React, local-first IndexedDB) whose
> entire control surface is exposed to AI agents over MCP — stdio via the
> desktop shell, streamable HTTP via the collab-server relay.
>
> ### Why it belongs here
>
> - **27 tools, one contract**: transport, mixer, FX rack, arrangement
>   editing, song builder, loudness (BS.1770 render-backed), WAV/MP3 export,
>   gallery publishing — every mutation flows through the same deterministic
>   command layer the UI uses, so every agent action is exactly one undo
>   step with a verification read-back (never a dispatch echo).
> - **Honest failures**: destructive ops sit behind an explicit allow flag;
>   unavailable capabilities refuse instead of pretending; async tools
>   (render/export) answer from the live engine or not at all.
> - **Agent-made beats**: agents publish what they build straight into the
>   public beat gallery (`kyx_publish_gallery`) with a 🤖 provenance badge —
>   playable in the browser, no install.
> - **Local-first**: the studio runs in the browser, projects live in
>   IndexedDB, the optional intent model is a local Ollama GGUF — no cloud
>   in the loop.
>
> ### Try it
>
> Claude Desktop config + safety notes: `docs/AGENTIC-ZCODE-SETUP.md`
> (repo root), demo: `npm run mcp:demo`.
>
> Thanks for maintaining the list! 🙏

## 4. Proces (30 min)

1. Pre-flight checklist hore (user).
2. Fork `punkpeye/awesome-mcp-servers` → branch `add-kyx`.
3. Pridaj riadok do správnej sekcie (alphabetical within section).
4. PR s body vyššie. Očakávaj review ping do ~1 týždňa; maintaineri chcú
   niekedy dôkaz že server reálne funguje → link na demo GIF/videu z
   launch kitu (`npm run video:agents-vertical` output).
5. Po merge: retroálna veta do `docs/LAUNCH-HN-REDDIT.md` + HN post má
   druhý dôkaz bod ("listed on awesome-mcp-servers").

## 5. Čo už máme (nereplikovať)

- `/agents` onboarding page (78693295) — copy-paste Claude Desktop configy
- `docs/AGENTIC-ZCODE-SETUP.md` — setup guide
- `npm run mcp:demo` — live demo
- `docs/LAUNCH-HN-REDDIT.md` — HN/Reddit launch kit + Show HN draft
- vertikálne 9:16 video (bc5900c1)
