# LAUNCH KIT — HN / Reddit (MCP killer feature)

> Marketing tah #3. Všetko tu je claim-accurate: každé tvrdenie je overené
> kódom, živým testom alebo videom. Placeholder-y `[...]` vyplň pred postom.
> Repo: https://github.com/Qvesterino/pulse-forge (PUBLIC ✓)

---

## 0. PRE-FLIGHT CHECKLIST (urob PRESNE v tomto poradí, deň pred postom)

- [ ] **GitHub repo popis + topics**: `Browser DAW with a native MCP server — your AI co-producer, everything undoable` + topics: `mcp`, `daw`, `webaudio`, `claude`, `ai-agents`, `music-production`
- [ ] **LICENSE súbor** — bez neho HN prvé upvote pôjde na "it's closed source?" — rozhodni: MIT/Apache-2.0 ak chceš komunitu, alebo "source-available" písomne v README
- [ ] **Deployed URL živý** — `[DEPLOYED-URL]` musí otvoriť štúdio v mobile aj desktope (testuj cez 4G, nie len WiFi)
- [ ] **`npm run mcp:demo` behne na čerstvom clone** — to je tvoj "it works" dôkaz keď niekto spamuje
- [ ] **Claude Desktop connect** prejdený na čerstvom stroji podľa `/agents` stránky — presne ako návštevník, žiadne skratky
- [ ] **Video na YouTube** (unlisted-ok, ale nie private): horizontálne + vertikálne — HN komentáre chcú link ktorý sa dá pozrieť bez build-u
- [ ] **Timing**: HN — utorok/štvrtek 7:00–9:00 ET (nevylieza z Nového), NEPOSTOVAŤ keď beží veľká akcia (OpenAI/Anthropic launch day = pochovaný). Reddit — nestaň sa postu cez noc, sub-moderátori sedia v EUR

---

## 1. HACKER NEWS — Show HN

### Title (vyber JEDEN, A/B v hlave):

1. `Show HN: KYX – a browser DAW your AI agent can drive over MCP`
2. `Show HN: I gave my DAW an MCP server so Claude Desktop can produce beats`
3. `Show HN: KYX – 26-tool MCP server in a DAW, every agent step undoable`

→ Odporúčam **1** (faktický, žiadny hype, "browser DAW" je hák). **2** ak chceš founder-story energy. **3** ak cítiš, že tools-count je hák pre MCP crowd.

### Body (toto dáš do text políčka — HN má rád text-posty s linkmi v tele):

```
Hi HN — I built KYX (https://github.com/Qvesterino/pulse-forge), a
browser-first DAW whose native MCP server lets Claude Desktop — or any
MCP client — produce music inside it: read the project, generate
patterns, edit steps, mix, arrange full song forms. Live demo video:
[YOUTUBE-URL]

The part I'm proud of is not the generation. It's that the agent can't
break your track:

- Every mutating tool returns a verification read-back of the actual
  resulting state — the agent proves what it did, it never guesses.
- Named checkpoints before experiments; one-step restore.
- Destructive operations (deleting tracks/takes) are locked behind an
  explicit user consent flag — the agent gets an honest refusal, never
  a silent pass-through.
- Every mutation is one undo step, through the same deterministic
  command layer my own UI edits use. Batches fold into one undo entry.

Architecture in one line: MCP client → (stdio loopback on desktop, or
HTTPS+WS relay on web) → the KYX window → deterministic command layer →
project store. The MCP layer is a transport, never a bypass — the agent
gets exactly the same guardrails as a human clicking the UI.

The embarrassing part: our unit suite was green while the whole web
transport was dead. The hub sent raw JSON-RPC to the window while the
bridge expected a relay frame, the server never marked the session as
connected, and relay sockets fell into the collab-room handler. Three
defects, none visible to ~140 specs. A 30-line live end-to-end harness
(npm run mcp:demo) caught all of them in one run — it replays a real
agent session over the real protocol and asserts every read-back. It's
now a permanent gate. Details in commit 726cc9a5.

What it is / isn't: the music engine (generation, samples, mixing) runs
locally and deterministically — no cloud model in the audio path. The
"AI" is whichever MCP client you connect; I didn't want the lock-in of
being my own model vendor. Think of it as a studio that speaks an open
protocol, not an AI wrapper.

Try it: [DEPLOYED-URL] (browser, no install) — and /agents has the
2-minute Claude Desktop setup. Desktop build for Windows is here:
https://github.com/Qvesterino/pulse-forge/releases/latest

Happy to answer architecture questions — the interesting bits are the
relay auth model, the read-back contract, and why I refuse to let the
agent touch the audio thread directly.
```

### First comment (tvoj own comment hneď po poste — technický depth):

```
Stack details for the curious:

- DAW core: TypeScript, React 18, Web Audio + AudioWorklet (custom DSP
  worklets for reverb/dynamics/FX), IndexedDB persistence. All local,
  works offline (PWA). Desktop shell is Electron (Windows build).
- MCP surface: 26 tools + resources, including kyx://playbook — a
  pinned producer manual the agent reads on connect so it doesn't burn
  tokens guessing the vocabulary.
- The interesting contract: read-backs. `kyx_fx {action: more}` doesn't
  return "ok" — it returns the landed native parameter value read from
  the post-execution document ("mix 0.3→0.34 on Drums"). Clamps
  included. This is what makes agents reliable: they self-correct
  against measured state, not against their own optimism.
- Checkpoints are session-scoped (last 8), auto-saved before risky
  ops, restore is itself one undo step — so even the rollback is
  reversible.
- The live harness (npm run mcp:demo) boots a real server, plays BOTH
  roles (window + agent) over the real protocol, and asserts the full
  16-step workflow including a checkpoint rollback verified by state
  reads. If any future change breaks the agent loop, this script breaks.

Happy to go deeper on any layer.
```

### Očakávané otázky + tvoje odpovede (nauč sa, nekopíruj slovo od slova):

| Kde | Odpoveď (hrať vlastnú vlnu) |
|---|---|
| „How is this different from Suno/Udio?" | „They're generation black boxes — you get a WAV and a prayer. KYX is a DAW the agent operates: every step is a command with a read-back, checkpointed and undoable. You produce WITH the agent; you don't gamble with one. And the protocol is open — swap Claude for any MCP client." |
| „Web Audio = toy latency, no?" | „For production it's an offline-capable engine — the export renders offline through the same engine, bit-identical to what you hear. Live monitoring latency exists like in any DAW; this isn't (yet) a recording-studio replacement for native I/O — that's on the roadmap behind a separate ADR." |
| „Does the audio go to the cloud?" | „No. Generation, mixing, rendering — all local and deterministic. The only network is the MCP client you deliberately connect, token-authed." |
| „Why MCP instead of a plugin API?" | „One protocol, every client, zero per-vendor integration — and the agent story composes with tools people already have. CLAP plugin hosting exists on desktop too; they're not mutually exclusive." |
| „License?" | `[PODĽA ROZHODNUTIA — rozhodni PRE-FLIGHT]` |
| „Is this a wrapper around ChatGPT?" | „No model in the audio path at all. The composition engine is deterministic (seeded), runs in the browser. The connected agent is the director, not the instrument." |

---

## 2. REDDIT

### r/ClaudeAI (najvyšší konverzný potenciál — ľudia ktorí už majú Claude Desktop)

**Title:** `I built a DAW that Claude Desktop can control over MCP — 26 tools, checkpoints, everything undoable`

**Body:**
```
I've been building KYX, a browser-first DAW, and I wired it up so Claude
Desktop can actually produce music in it over MCP — not "generate a
prompt", but drive the studio: read the project state, generate drum
patterns, edit individual 16th steps, apply a measured mix profile,
arrange a full song form, send buses to reverb.

The design rule that made it work: every tool returns a verification
read-back of the resulting state ("tempo 128 · 4/4", "mix 0.3→0.34 on
Drums"), risky operations are checkpoint-protected, and anything
destructive stays locked until you explicitly allow it in the app. So
the agent experiments freely and can't wreck the session — watch it
blow the tempo, admit it, and roll back a checkpoint in this 29s video:
[YOUTUBE-VERTICAL-URL]

Setup is literally 2 minutes (paste one JSON config):
[AGENTS-PAGE-URL]

There's also a one-command demo that replays a full agent session over
the real protocol if you want to see the machinery without Claude:
npm run mcp:demo in the repo → https://github.com/Qvesterino/pulse-forge

Happy to answer anything about the architecture.
```

### r/LocalLLaMA (open-protocol / no-lock-in uhol)

**Title:** `KYX: an open-protocol DAW (MCP server, 26 tools) any local model client can drive — no cloud in the audio path`

**Body:** skrátená verzia ClaudeAI postu + zdôrazni: „The DAW deliberately has NO model in the music path — generation is seeded and deterministic, runs in your browser. The agent is whichever MCP client you point at it, so local-model clients work the same as Claude. I didn't want to be my own model vendor; I wanted a studio that speaks a protocol." + repo + demo command.

### r/edmproduction alebo r/musicproduction (producer-first,techno-minimal)

**Title:** `I made a DAW where you can plug an AI copilot (Claude) into the actual mixer/pattern editor — with checkpoints so it can't ruin your session`

**Body:** producer angle: „You keep the taste, it does the hands." → video → „it edits steps, rides sends, applies genre-referenced mixes — and every step is undoable; it literally rolled back its own bad idea in the video." → soft CTA na /agents. **POZOR:** tieto suby majú self-promo pravidlá — čítaj sidebar, prípadne postuj v [Self-Promo] formáte alebo najprv komentuj týždeň.

---

## 3. POSTING PLAYBOOK

1. **Deň 0 (dnes)**: pre-flight checklist + LICENSE + repo popis + YouTube uploady
2. **Deň 1**: HN post (uto/štvr 7–9 ET). Drž sa pri thread-e 6–8 hodín, odpovedaj na KAŽDÝ komentár do 30 min. Žiadny self-upvote z druhého účtu — HN to detekuje.
3. **Deň 2–3**: Reddit (ClaudeAI → LocalLLaMA → music sub s odstupom 12 h). Odpovedaj v komentároch, nie v editoch.
4. **Nikdy** nekrižuj ten istý text — každý sub dostane svoju verziu ( Higher-upy živia sa autenticitou).
5. **Metrika úspechu nie je upvote count** — je to: počet `npm run mcp:demo` runov / /agents návštevy / GitHub starov v prvých 48 h.

## 4. Ak sa post chytí (frontend-page na HN)

- priprav **rýchly hotfix budget** — ľudia nájdu bugy, ktoré ty nie. Branch `launch-hotfix`, merge do 2 h.
- pin komentár s „known issues" — honesty je u HN liek na everything.
- NEPRIDÁVAJ features počas launchu. Len fixuj.
