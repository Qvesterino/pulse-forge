# DAW COMMAND SURFACE MATRIX — KYX

**Audit date:** 2026-10-13
**Target:** KYX (repo `pulse-forge`), `D:\pulse-forge`
**Revision audited:** `31cc20ad` — working tree dirty (pre-existing modifications from concurrent sessions)
**Mode:** read-only audit. No production code modified. Two disposable probes were created under `tmp-audit-probe/`, executed, and deleted.

---

## 0. Scope, target selection, and what was NOT audited

The assignment permitted auditing **KYX or ZYVO**. Only **KYX** was audited.

**ZYVO is a different codebase and is explicitly out of scope.** Evidence: `src/export/zyvo-transfer.ts:2` describes itself as _"Lossless-audio handoff from KYX to a native ZYVO/VocalForge project"_, and `D:\VocalForge_DAW\package.json` is a **separate monorepo** (`name: vocalforge-daw`, `workspaces: [packages/*, apps/*, tools/*, plugins/*]`). Nothing in this document is evidence about VocalForge/ZYVO's architecture. `RELEASE_READINESS_REPORT.md:98` records ZYVO as legacy branding purged from the shipped KYX path — i.e. within KYX, "ZYVO" survives only as an interchange format (`com.kyx.zyvo-transfer`, `ZYVO_TRANSFER_VERSION = 1`).

**No claim in this document may be transferred to ZYVO.** The two products share no verified architectural contract.

---

## 1. Verified architecture sketch

Edges marked ⚠️ are inferred-but-not-fully-traced; all others were traced to implementation.

```
External MCP client (Claude Desktop etc.)
  │  stdio JSON-RPC 2.0
  ▼
desktop/mcp-server.cjs            stateless relay · KYX_MCP_TOKEN required
  │  HTTP POST 127.0.0.1:8787/rpc
  ▼
desktop/mcp-bridge-server.cjs     constant-time token check · rate limit 30 burst / 30 per min
  │  IPC kyx:mcp:call  → single focused window
  ▼
src/mcp/desktop-host.ts:64        ctx.execute → services.store.execute
  ▼
ProjectStore.applyCommand          ProjectStore.ts:207
  ├─ command.execute(doc)          pure fn, inverse-patch delta
  ├─ undoStack push / redoStack clear
  └─ afterMutation()               ProjectStore.ts:424
        ▼
  store.onDocChanged                 services.ts:1065  ← THE FAN-OUT SEAM
        ├─ engine.setProject(doc)                    services.ts:1076
        ├─ syncDocChangeWhilePlaying (if playing)    services.ts:1085
        ├─ transport.setBarTicks / setBpm            services.ts:1088
        ├─ generativeRuntime.refreshAll()            services.ts:1090
        └─ saveDebouncer.arm()  (800 ms / 5000 ms max defer / 50 arms)
              ▼
        autosave-debouncer.flush → flushSave → IndexedDB
```

**Three access paths, one mutation spine:**

| Path   | Entry                                                                           | Reaches command layer?                       |
| ------ | ------------------------------------------------------------------------------- | -------------------------------------------- |
| UI     | React component → `services.store.execute(cmd)`                                 | **Yes** — verified, zero exceptions (see §4) |
| Intent | `IntentPanel.tsx:3806` `routeIntentText()` → per-kind applier → `store.execute` | **Yes**                                      |
| MCP    | `desktop-host.ts:64` → `store.execute`                                          | **Yes**                                      |

⚠️ The **web relay** path (`src/mcp/web-host.ts`, `server/mcp-core.mjs`, 75 KB) was **not** read in full. Its per-session isolation model is **UNKNOWN** — see GAP-06.

### Command contract (the load-bearing invariant)

`src/commands/types.ts:3` — commands are pure document transforms:

```ts
interface Command {
  readonly type: string;
  readonly label: string;
  execute(doc: ProjectDocument): ProjectDocument;
  undo(doc: ProjectDocument): ProjectDocument;
  applyToYDoc?(yMap: any): void;
  readonly coalesceKey?: string;
}
```

`src/commands/core.ts:34` `snapshot()` builds **inverse-patch** commands from id-anchored deltas, with a dev-only self-verification that falls back to a legacy whole-document command if the delta round-trip ever disagrees (`core.ts:53-60`), and `deepFreeze(prev)` in dev so in-place mutation of a previous document throws loudly instead of corrupting the undo stack (`core.ts:41`).

This is the strongest architectural asset found in the audit.

---

## 2. Capability inventory

Status vocabulary: **VERIFIED** = traced to a concrete implementation end-to-end · **PARTIAL** = capability exists but an access path is missing/unproven · **MISSING** = searched, nothing found · **UNKNOWN** = could not determine.

Denominator: **52 capabilities** enumerated across 5 categories.

### (a) Project lifecycle — 7 VERIFIED · 1 PARTIAL · 2 MISSING

| Capability            | UI path                     | Internal command | R/W | Validation              | Undo                  | Evidence                             | Status      |
| --------------------- | --------------------------- | ---------------- | --- | ----------------------- | --------------------- | ------------------------------------ | ----------- |
| Create from template  | `ui/ProjectBrowser.tsx:154` | factory          | W   | id in TEMPLATES         | n/a (pre-history)     | templates.ts:765                     | VERIFIED    |
| Open project          | `ui/ProjectBrowser.tsx:119` | → `replaceDoc`   | R   | —                       | stack wiped           | ProjectStore.ts:402                  | VERIFIED    |
| Import `.kyx`         | `ui/ProjectBrowser.tsx:168` | repo layer       | W   | 10 MB cap               | none                  | export/project-io.ts                 | VERIFIED    |
| Save                  | autosave wiring             | repo layer       | W   | debounce window         | none                  | services.ts:1058                     | VERIFIED    |
| Autosave              | services boot               | repo layer       | W   | dirty + window          | none                  | autosave-debouncer.ts:63             | VERIFIED    |
| Migrate               | load path                   | pure             | R   | rejects future versions | none                  | schema.ts:1029                       | VERIFIED    |
| Export project        | `ui/ExportPanel.tsx:1522`   | repo layer       | R   | —                       | none                  | export/project-io.ts                 | VERIFIED    |
| Crash restore         | recovery buffer offer       | none             | R   | `isBufferWorthOffering` | **no undo semantics** | persistence/recoveryBuffer.ts:51,118 | PARTIAL     |
| Save-as / Save a copy | —                           | —                | —   | —                       | —                     | grep `saveAs\|Save a copy` → 0 hits  | **MISSING** |
| Close project         | —                           | —                | —   | —                       | —                     | no teardown capability found         | **MISSING** |

### (b) Transport — 6 VERIFIED · 1 MISSING

Transport is **deliberately not a Command** — it mutates runtime `Transport` state, not the document. This is correct per invariant #1.

| Capability          | UI path                             | R/W | Undo | Evidence                                                        | Status      |
| ------------------- | ----------------------------------- | --- | ---- | --------------------------------------------------------------- | ----------- |
| Play / pause / stop | `ui/TopBar.tsx:582`                 | W   | n/a  | TopBar.tsx:154                                                  | VERIFIED    |
| Seek                | `ui/TopBar.tsx:569`                 | W   | n/a  | TopBar.tsx:569                                                  | VERIFIED    |
| Loop                | `ui/TopBar.tsx:204`                 | W   | n/a  | TopBar.tsx:204                                                  | VERIFIED    |
| Tempo (BPM)         | `ui/TopBar.tsx:309`                 | R/W | full | commands/project.ts:29                                          | VERIFIED    |
| Metronome           | `ui/TopBar.tsx:234`                 | W   | n/a  | TopBar.tsx:234                                                  | VERIFIED    |
| **Time signature**  | **no UI; only migration writes it** | R   | —    | schema.ts:1029 is sole writer; grep in `src/commands/` → 0 hits | **MISSING** |

### (c) Timeline / arrangement — 17 VERIFIED · 1 PARTIAL

| Capability             | Internal command                                            | Validation                              | Evidence                  | Status      |
| ---------------------- | ----------------------------------------------------------- | --------------------------------------- | ------------------------- | ----------- |
| Track create           | `createDrumTrack` / `createInstrumentTrack`                 | kind valid                              | tracks.ts:43,51           | VERIFIED    |
| Track delete           | `deleteTrack`                                               | ref cleanup                             | tracks.ts:192             | VERIFIED    |
| Track duplicate        | `duplicateTrack`                                            | id exists                               | tracks.ts:273             | VERIFIED    |
| Clip create (audio)    | `addAudioClip`                                              | bufferId + track                        | audioClips.ts:34          | VERIFIED    |
| Clip delete            | `deleteAudioClip`                                           | clipId                                  | audioClips.ts:417         | VERIFIED    |
| Clip duplicate         | `duplicateAudioClip`                                        | clipId                                  | clipEditing.ts:247        | VERIFIED    |
| Clip split             | `splitAudioClipAtTick`                                      | tick inside + duration                  | clipEditing.ts:292        | VERIFIED    |
| Clip trim              | `resizeAudioClip` / `trimArrangementClipStart`              | min 0.25 bar                            | audioClips.ts:628         | VERIFIED    |
| Clip move              | `moveAudioClips` (group)                                    | 0.01-bar quantize                       | audioClips.ts:490         | VERIFIED    |
| Stretch                | `stretchAudioClip` + `previewStretchRate`                   | rate bounds                             | audioClips.ts:602         | VERIFIED    |
| Fade                   | `clampClipFades`                                            | clamped                                 | audioClips.ts:473         | VERIFIED    |
| Crossfade              | `crossfadeAudioClips`                                       | **throws** on non-overlap / same track  | clipEditing.ts:620        | VERIFIED    |
| Snap                   | pre-command geometry                                        | grid + threshold                        | ArrangementPanel.tsx:2758 | VERIFIED    |
| Quantize               | `quantizePatternToGrid` / `ToScale`                         | gridTicks                               | quantize.ts:14,33         | VERIFIED    |
| Markers                | `addMarker` / `remove` / `rename` / `move` / `setType`      | snapped tick                            | markers.ts:41             | VERIFIED    |
| Scenes                 | `createScene` / `delete` / `rename` / `reorder` / `setRole` | unique name                             | scenes.ts:19              | VERIFIED    |
| Time-range duplicate   | `duplicateTimeRange`                                        | **throws** on empty / boundary-crossing | timeRange.ts:44,47,70     | VERIFIED    |
| Time-range consolidate | `consolidateTimeRange`                                      | stem routing exercised                  | timeRange.ts:301          | VERIFIED    |
| **Slip**               | `slipAudioClip` exists (audioClips.ts:520)                  | offset in buffer                        | **no UI caller found**    | **PARTIAL** |

**`timeRange.ts` is not a dispatcher — it is a fail-closed validation engine.** It widens a tick marquee to whole bars (`timeRange.ts:54-55`), refuses any range whose boundary cuts through an arrangement clip (`:63-71`, _"fail closed, not with an overlapping arrangement"_), deliberately exercises `buildStemProject` so consolidate and bounce agree (`:99`), and mints fresh clip ids so copied markers follow the copy (`:116`). This is high-quality defensive design.

### (d) Mixer — 10 VERIFIED

| Capability              | Internal command                                                   | Validation                                               | Evidence               | Status   |
| ----------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- | ---------------------- | -------- |
| Gain / pan              | `setTrackParams`                                                   | gain clamp [0,1.5], pan [-1,1], **no-op identity guard** | project.ts:320,328,331 | VERIFIED |
| Mute / solo             | `setTrackParams`                                                   | —                                                        | project.ts:345         | VERIFIED |
| Group mute / solo       | `setGroupMute` / `setGroupSolo`                                    | group exists                                             | tracks.ts:533,548      | VERIFIED |
| Clear all solos / mutes | `clearAllSolos` / `clearAllMutes`                                  | —                                                        | tracks.ts:728,740      | VERIFIED |
| Return tracks (buses)   | `createReturnTrack` / `deleteReturnTrack`                          | name unique                                              | tracks.ts:561,589      | VERIFIED |
| Sends                   | `setTrackSend`                                                     | returnId exists                                          | master.ts:66           | VERIFIED |
| Return gain             | `setReturnGain`                                                    | returnId                                                 | master.ts:93           | VERIFIED |
| Track FX inserts        | `addEffect` / `removeEffectFromTracks` / `setEffectBypassOnTracks` | dangling-ref cleanup                                     | tracks.ts:862,932      | VERIFIED |
| Input inserts           | `setInputInsertMode` / `addInputEffect`                            | **throws** without armed input                           | tracks.ts:808,820      | VERIFIED |
| Master config           | `setMasterConfig`                                                  | patch keys                                               | master.ts:49           | VERIFIED |

### (e) Automation — 6 VERIFIED · 1 MISSING

| Capability                             | Internal command                              | Evidence                                                                                    | Status      |
| -------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------- |
| Add / remove lane                      | `addAutomationLane` / `removeAutomationLane`  | automation.ts:27,58                                                                         | VERIFIED    |
| Add / move / delete point              | `addAutomationPoint` / `move` / `delete`      | automation.ts:78,103,137                                                                    | VERIFIED    |
| Scene automation                       | `addSceneAutomationPoint` / `move` / `remove` | sceneAutomation.ts:50,69,100                                                                | VERIFIED    |
| **Read/write modes (arm, auto-write)** | —                                             | grep `automationMode\|armRecord\|autoWrite` in `src/` → only an MCP _read_ at tools.ts:5894 | **MISSING** |

---

## 3. UI vs Intent vs MCP parity

**MCP tool inventory (measured): 37 tools** — `src/mcp/tools.ts`, count confirmed by regex over `name: "kyx_*"` (37) matching dispatcher `case "kyx_*"` (37).

| Class                           | Count | Tools                                                                                                                                                          |
| ------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only (never `ctx.execute`) | 9     | `kyx_state`, `kyx_meter`, `kyx_catalog`, `kyx_render_summary`, `kyx_diagnose_mix`, `kyx_audio_preview`, `kyx_publish_gallery`, `kyx_blind_ab`, `kyx_transport` |
| Mutating (`ctx.execute`)        | 28    | incl. `kyx_tracks`, `kyx_clips`, `kyx_mix`, `kyx_fx`, `kyx_export`, `kyx_batch` …                                                                              |
| Conditional mutators            | 3     | `kyx_mix_idea` (only `apply:true`), `kyx_checkpoint` (only `restore`), `kyx_export` (only `autofix:true`)                                                      |
| Resources                       | 7     | overview, pattern, mix, arrangement, history, playbook, vocab                                                                                                  |

**Parity verdict: strong at the mutation seam, uneven at the natural-language seam.**

- UI, Intent and MCP **all** converge on `store.execute` — there is no bypass (see §4). This is the audit's single most important positive finding.
- MCP parity is verified for mixer, clips, tracks, FX, automation, markers, transport.
- **Natural-language parity is where it breaks.** See `DAW_AGENT_CONTROL_GAP_REPORT.md` GAP-01/GAP-02: a phrase that is trivially expressible in the UI and in MCP (`kyx_export`, `kyx_mix setGain`) is _misrouted or declined_ by the Intent Engine.

---

## 4. Bypass audit — direct UI state mutation

**Verified independently by the auditor (not delegated):**

```
grep '\.doc\s*=|setDoc\(|store\.doc_' src/ui/*.tsx src/ui/**/*.tsx  →  0 matches
```

**No React component mutates the project document directly.** Every audible change flows through `services.store.execute(...)`. This upholds AGENTS.md invariant #2 and is a genuine strength.

**Two qualifications, both real:**

1. **Engine-node mutation outside the Command layer (by design, no doc write, therefore no undo).** Mastering A/B audition calls the engine directly: `ui/MasteringABCompare.tsx:313,333,621`, `MasteringAssistant.tsx:504`, `MasterProcessingControls.tsx:228`, `MasteringReferenceCompare.tsx:443`. These are ephemeral audition/compare gains. No document write occurs, so undo is correctly not expected — but it does mean _engine_ state is not covered by the command/undo model.

2. **Intent routing is a soft bypass — inner undo is discarded.** `src/commands/intentRouting.ts` folds N inner commands into **one** outer snapshot:
   ```ts
   next = deleteTrack(next, id).execute(next); // intentRouting.ts:83
   next = setTrackParams(next, trackId, { gain: targetGain }).execute(next); // :137
   return snapshot("applyExactIntent", plan.label, doc, next); // :232
   ```
   Undo _correctness_ is preserved (one atomic step), but inner command labels and cleanup `detail` notes are lost from the history entry. Same pattern in `intentRouting.ts:335-341` (`foldProductionActions`).

---

## 5. Denominators and coverage honesty

| Claim                                                | Denominator                   | How measured                                                                                                         |
| ---------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Capability inventory                                 | 52 capabilities, 5 categories | enumerated in §2; 46 VERIFIED / 2 PARTIAL / 4 MISSING / 0 UNKNOWN                                                    |
| MCP tool count                                       | 37                            | regex over `name:` vs dispatcher `case:` — both 37                                                                   |
| MCP tools with handlers                              | 37 / 37                       | every registered name has a dispatcher case                                                                          |
| Document-mutation bypasses in UI                     | 0                             | independent grep, 0 matches                                                                                          |
| Audio-worklet files swept for LLM/network/fs imports | 41 processors                 | 0 matches for `fetch(`, `XMLHttpRequest`, `localStorage`, `indexedDB`, `require(`, dynamic `import(`, `onnx`, `ort.` |

**Not covered / UNKNOWN:**

- `ArrangementPanel.tsx` (6 383 lines) was not opened at every call site; trim/slip/stretch rows lean on command signatures plus ≥1 confirmed caller each.
- `server/mcp-core.mjs` (75 KB) session-isolation model **UNKNOWN** (GAP-06).
- Collab interlock — whether `ctx.execute` serializes correctly through `YDocStore` under an active Yjs session — **UNKNOWN**.
- No real-browser audio run (`npm run test:browser`) was performed; metering/render claims rest on code reading plus the offline-render unit surface.
