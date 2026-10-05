import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useSelectionStore, useServices } from "./context";
import { notifyOnboardingProgress } from "./OnboardingHint";
import { warmFactoryPresets } from "../presets/factory-loader";
import { parseIntentText, styleCandidatesForPrompt } from "../intent/text-parser";
import { generateAsyncResult, resultForCandidate } from "../intent/pipeline";
import { parseChaseIntent } from "../intent/chaseIntent";
import { parsePluginFinderIntent } from "../intent/pluginFinderIntent";
import { parseToneIntent } from "../intent/toneIntent";
import { mcpAllowDestructive, setMcpAllowDestructive } from "../mcp/flags";
import { mcpRelayEnabled, mcpRelayServerUrl, setMcpRelayEnabled, setMcpRelayToken } from "../mcp/relayConfig";
import type { McpDesktopStatus } from "../mcp/desktop-host";
import type { DesktopMcpApi } from "../mcp/desktop-host";
// Lazy MCP bridge: the whole web-host module (and the 31-tool surface it
// carries) loads on first toggle — an opt-in feature has no business in the
// studio boot graph. The config helper, connected-poll and start/stop all
// read the module through the same lazy accessor below.
import { getSharedPcmPlayback } from "../audio-engine/pcmPlayback";
import { formatSmpTe } from "../midi/smpte";
import { parseProductionIntent, productionReadback, resolveProductionTargets } from "../intent/production";
import { parseSectionRequests, type SectionParse } from "../intent/sections";
import { reviseSectionProduction } from "../intent/section-production";
import {
  applySessionCandidateCommand,
  lastGeneration,
  promptHistory,
  rememberGeneration,
  rememberPrompt,
  resolveSessionReference,
} from "../intent/session-context";
import {
  applyExactIntentCommand,
  applyGenerationResultCommand,
  applyGenerationResultWithFxCommand,
  applyProductionIntentCommand,
  exactReadback,
  setMasterConfig,
  duplicateTimeRange,
} from "../commands/commands";
import {
  applyArrangeOps,
  applyClipArrangeOps,
  parseSelectedClipArrangeIntent,
  parseSelectedTimeRangeIntent,
  selectedClipGrooveChangeCount,
  selectedTimeRangeIntentError,
  type ClipArrangeOp,
  type SelectedTimeRangeOperation,
} from "../intent/arrangeWords";
import {
  reviseSection,
  reviseSectionFlow,
  replacePatternInPlaceCommand,
  applySongCommand,
  type SongBuild,
  type SongBuildSection,
} from "../intent/song";
import type { SearchLane } from "../intent/candidate-search";
import { fxWordsForArtist } from "../intent/artists";
import { consolidateRangeToAudio } from "../services/rangeConsolidation";
import { artistMixProfileOf } from "../intent/artist-mix";
import { morphPatterns } from "../intent/morph";
import { pushGhost, listGhosts, getGhost, removeGhost, type GhostVersion } from "../intent/versions";
import { composeFullTrack, type ComposeResult } from "../intent/compose";
import { buildTheatrePlan, stageLabel, type TheatreRun } from "../intent/producer-theatre";
import { personaBySlug } from "../intent/producer-personas";
import { mutateBeat } from "../gallery/lineage";
import { applyFaderIntent, applyTempoIntent, faderReadback } from "../intent/conversation";
import { applyCompoundIntent, compoundReadback } from "../intent/compound";
import {
  applyAutomateIntent,
  applyGrooveIntent,
  applyMarkerIntent,
  applySectionGrooveIntent,
  grooveReadback,
  markerReadback,
} from "../intent/studio-words";
import { applySoundSwapIntent, applyStepEditIntent, soundSwapReadback } from "../intent/sound-words";
import { assistThinSelectionCommand, assistVarySelectionCommand } from "../commands/assistSelectionCommands";
import { planSelectedStepInstruction, type SelectedStepInstructionPlan } from "../assist/selected-step-plan";
import { parseSelectedStepIntent, type SelectedStepIntent } from "../assist/selected-step-intent";
import type { StepSelection } from "../store/SelectionStore";
import { applyPresetIntentCommand, presetReadback } from "../intent/preset-intent";
import { analyzeAudioReference } from "../intent/audio-reference";
import { analyzeVoiceIdea } from "../intent/voice-idea";
import { resolveVocalTake } from "../vocal/resolve";
import { analyzeVocalTake } from "../vocal/analyzer-client";
import { applyVocalHookCommand, applyVocalKeyCommand, applyVocalTempoCommand } from "../vocal/adapt";
import { summarizeVocalProfile } from "../vocal/notes";
import { planVocalComp } from "../vocal/comping";
import { applyVocalCompCommand } from "../vocal/comp-apply";
import { VocalCompStrip } from "./VocalCompStrip";
import type { VocalProfile } from "../vocal/types";
import { PcmMicRecorder } from "../audio-engine/PcmMicRecorder";
import { patternLengthTicks } from "../midi/hum-to-notes";
import { extractGrooveGrid, grooveRowsForPads, type GrooveExtraction } from "../intent/groove-extraction";
import { inferPadRole } from "../ai/pad-roles";
import { setAudioReferenceConditioning } from "../intent/semantic-conditioning";
import { computeMasterMatchEq, referenceLoudnessTrim, setMatchEqReference } from "../intent/match-eq";
import { chordsTrackOf, snapMelodyToChordsCommand } from "../intent/chord-snap";
import { applyMasterMatchEqCommand } from "../commands/commands";
import {
  planVariantIntents,
  producerSessionSummary,
  producerSessionState,
  recordIntentDecisions,
  bumpGenerationCount,
  resolveProducerFollowUp,
  resetProducerSession,
} from "../intent/producer-session";
import { compileBriefContract } from "../intent/brief-contract";
import {
  createProjectBriefFromContract,
  mergeProjectProducerBrief,
  projectBriefCorrectionsFor,
} from "../intent/project-brief";
import {
  clearProjectProducerBriefCommand,
  removeProjectProducerBriefFactCommand,
  saveProjectProducerBriefCommand,
} from "../commands/producerBriefCommands";
import { evaluateBriefCompliance } from "../intent/brief-gate";
import { compileIteration } from "../intent/iteration";
import { BriefContractSummary } from "./BriefContractSummary";
import { ProjectProducerBriefManager } from "./ProjectProducerBriefManager";
import { downmixToMono, resampleLinear } from "../sample-library/audio-index";
import { hashString } from "../shared/rng";
import {
  applyBypassIntent,
  applyEffectIntent,
  applyMixIntent,
  applySendIntent,
  bypassReadback,
  effectReadback,
  planMixProfile,
  sendReadback,
} from "../intent/mix";
import { applyLoudnessIntent, measurePreviewLoudness, type LoudnessRecommendation } from "../intent/loudness";
import { analyzeLoudnessBuffer } from "../audio-engine/kweighting";
import {
  reviewSongAudio,
  analyzeSongSections,
  suggestSectionRevivals,
  type SongAudioReview,
  type SongSectionSuggestion,
} from "../intent/song-audio-review";
import { routeIntentText, REVISE_DELTA, type ReviseAttribute, type RoutedIntent } from "../intent/route";
import { destructiveCheckpointName, routeIsDestructive } from "../intent/route-guard";
import { restoreIntentCheckpoint, saveIntentCheckpoint } from "../intent/checkpoints";
import { snapshot } from "../commands/core";
import { getIntentModelProvider, tryModelRoute } from "../intent/model-resolver";
import { isCreativeBriefRoute } from "../intent/model-fallback-policy";
import { installIntentFailureDevtools, logIntentMiningEvent } from "../intent/failure-log";
import { diagnoseComplaint } from "../intent/complaints";
import type { SongSectionMeter } from "../intent/song-audio-review";
import { createVoiceCapture } from "../intent/voice-capture";
import { createWebSpeechCapture, isWebSpeechSupported } from "../intent/stt-web-speech";
import { isMicRecordingActive } from "../audio-engine/PcmMicRecorder";
import type { IntentModelState } from "../intent/model-loader-types";
import { normalizeIntent } from "../intent/normalize";
import type { IntentInput } from "../intent/types";
import type { NoteEvent } from "../project-model/types";
import { BAR_TICKS, PPQ } from "../project-model/types";
import { rankerMode } from "../ai/ranking/ranker-client";
import { playAuditionBuffer, renderAuditionBuffer, renderSongAuditionBuffer, stopAudition } from "../intent/audition";
import { resetSemanticCorpusCache, semanticIntentFor } from "../intent/semantic";
import { takeIntentPrefill, takeRegenFlag } from "../landing/handoff";
import { freshRegenSeed, intentSnapshotOfDoc, promptFromIntent } from "../gallery/intentCarry";
import { PublishToGalleryButton } from "../gallery/PublishButton";
import { renderProject } from "../rendering/renderer";
import { sanitizeFilename, encodeWav } from "../rendering/wav";
import { quickBounceDownload } from "../export/quick-bounce";
import { canExportVideo, recordVideo } from "../export/video";
import { downloadBlob } from "../export/download";
import { encodeShareCode, shareAppUrl } from "../export/shareCode";
import { funnelEvent } from "../services/funnel";
import type { Command } from "../commands/types";
import type { GenerationResult, RankedCandidate } from "../intent/types";
import type { ArrangementClip, DrumTrack, Pattern, ProjectDocument } from "../project-model/types";
import { ProducerDnaCompare } from "./ProducerDnaCompare";
import { CandidateLaneReceipt } from "./CandidateLaneReceipt";
import { runPersonalTrainingFromShipped } from "../intent/personal-melodic-flow";
import {
  automaticStyleLearningEnabled,
  clearStyleExamples,
  countStyleExamples,
  recordStyleExample,
  setAutomaticStyleLearningEnabled,
  setPreferredStyleGenre,
  STYLE_EXAMPLES_CHANGED_EVENT,
} from "../intent/style-example-ledger";
import { patternStyleExampleFromProject } from "../intent/pattern-style-example";
import {
  personalStyleDescription,
  personalStyleCorrectionSummary,
  personalStyleIntentSuggestions,
  personalStyleProfile,
} from "../intent/personal-style";
import {
  clearPreferenceLedger,
  PREFERENCE_LEDGER_CHANGED_EVENT,
  readPreferenceLedger,
} from "../intent/preference-ledger";
import { resetStyleVector } from "../intent/style-vector";

// The Audiotool connector is an explicit opt-in path. Keep its UI and adapter
// out of the regular Intent bundle until the user chooses to export a take.
const AudiotoolNexusExport = lazy(() =>
  import("./AudiotoolNexusExport").then((module) => ({ default: module.AudiotoolNexusExport })),
);

/**
 * INTENT dock panel — the "hlavný ťahák" (VISION §10): type what you want,
 * the engine generates + ranks candidates and you AUDITION them before choosing.
 *
 * The UI only orchestrates: parse the text → request generation through the
 * canonical Intent Engine entry point (with the full candidate bank) →
 * play any candidate offline through the real render chain → apply the chosen
 * one as one undoable command. All candidate generation, invariant gating,
 * ranking and provenance live behind the engine boundary; this panel never
 * regenerates or re-validates engine output.
 */

/** B1: a `?regen=1` arrival auto-runs exactly one generation per page load —
    StrictMode must not double-fire it. */
let regenAutoRan = false;
const BRIEF_CONFLICT_BLOCK_MESSAGE =
  "Zadanie si protirečí. Uprav konfliktné požiadavky v texte alebo odstráň ochranný čip pred generovaním.";

interface SelectedStepPromptPreview {
  source: string;
  intent: SelectedStepIntent;
  pattern: Pattern;
  drumTrack: DrumTrack;
  selection: StepSelection;
  plan: SelectedStepInstructionPlan;
  seed: string;
  amount: number;
}

type SelectedArrangementPromptPreview =
  | {
      kind: "clip";
      source: string;
      clip: ArrangementClip;
      ops: ClipArrangeOp[];
      lines: string[];
      sourcePatternHash?: string | null;
    }
  | {
      kind: "range";
      source: string;
      range: { fromTick: number; toTick: number };
      operation: SelectedTimeRangeOperation;
      description: string;
    };

function selectedClipPatternHash(doc: ProjectDocument, clip: ArrangementClip): string | null {
  const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
  const pattern = scene && doc.patterns.find((candidate) => candidate.id === scene.patternId);
  return pattern ? hashString(JSON.stringify(pattern)).toString(36) : null;
}

function selectedClipEditPreviewLines(doc: ProjectDocument, clip: ArrangementClip, ops: ClipArrangeOp[]): string[] {
  return ops.map((op) => {
    if (op.op === "clipGroove") {
      const count = selectedClipGrooveChangeCount(doc, clip.id, op);
      const description =
        op.direction === "set"
          ? `set swing to ${op.swingPercent}%`
          : op.direction === "swingUp"
            ? "increase swing"
            : op.direction === "swingDown"
              ? "reduce swing"
              : "tighten the groove";
      const sceneName = doc.scenes.find((scene) => scene.id === clip.sceneId)?.name ?? "source scene";
      return `Create an isolated variation of “${sceneName}” for this clip only; ${description} on ${count} offbeat drum hits.`;
    }
    if (op.op === "copyClip") return `Copy from bar ${clip.startBar + 1} to bar ${op.toBar + 1}`;
    if (op.op === "moveClip") return `Move from bar ${clip.startBar + 1} to bar ${op.toBar + 1}`;
    if (op.op === "resizeClip") return `Resize from ${clip.lengthBars} to ${op.bars} bars`;
    return `Delete clip at bar ${clip.startBar + 1}`;
  });
}

function selectedRangeEditDescription(
  range: { fromTick: number; toTick: number },
  operation: SelectedTimeRangeOperation,
): string {
  const fromBar = Math.min(range.fromTick, range.toTick) / BAR_TICKS;
  const toBar = Math.max(range.fromTick, range.toTick) / BAR_TICKS;
  const count = toBar - fromBar;
  return operation === "duplicate"
    ? `Duplicate bars ${fromBar + 1}–${toBar} (${count} bars), including musical and audio clips, markers, pattern notes, and drum steps; shift later clips/markers.`
    : `Render bars ${fromBar + 1}–${toBar} (${count} bars) to one audio print, replacing the selected arrangement and audio clips.`;
}

/** LOCAL INTENT MODEL chip tooltips per availability state. */
const INTENT_MODEL_CHIP_TITLES: Record<IntentModelState, string> = {
  off: "Lokálny intent model je VYPNUTÝ. Klikni pre zapnutie — model sa raz stiahne a potom beží offline.",
  loading: "Lokálny intent model sa načítava…",
  ready:
    "Lokálny intent model aktívny — nerozpoznané formulácie smerujú cez neho (výstup vždy cez validáciu a príkazy).",
  unavailable: "Lokálny intent model nie je na tomto serveri (chýba artifact). Klikni pre opätovný pokus.",
  error: "Lokálny intent model zlyhal. Klikni pre opätovný pokus.",
};

export function IntentPanel() {
  const services = useServices();
  const selection = useSelectionStore();
  const doc = services.store.getDoc();
  const [text, setText] = useState("");
  const [useProjectBrief, setUseProjectBrief] = useState(() => Boolean(doc.producerBrief));
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // W3 "Nauč sa ma" — the personal prior button runs a full in-browser
  // fine-tune; `personalBusy` gates the button, `personalStatus` reports the
  // honest outcome (installed / refused + why).
  const [personalBusy, setPersonalBusy] = useState(false);
  const [personalStatus, setPersonalStatus] = useState<string | null>(null);
  const [learnedPatternCount, setLearnedPatternCount] = useState(countStyleExamples);
  const [styleMemoryMessage, setStyleMemoryMessage] = useState<string | null>(null);
  const [automaticLearning, setAutomaticLearning] = useState(automaticStyleLearningEnabled);
  const [styleMemoryRevision, setStyleMemoryRevision] = useState(0);
  // A1 audition state — the ranked bank lives on the result; buffers are
  // cached per candidate so replaying is instant after the first render.
  const [bankResult, setBankResult] = useState<GenerationResult | null>(null);
  const [audiotoolExport, setAudiotoolExport] = useState<{
    candidateIndex: number;
    pattern: Pattern;
    sourceDoc: ProjectDocument;
  } | null>(null);
  const [semanticChip, setSemanticChip] = useState<string | null>(null);
  // Prompt history strip (vibe-code wave 2): reactivity tick over the
  // module-level session history.
  const [historyTick, setHistoryTick] = useState(0);
  const [historyReplayTick, setHistoryReplayTick] = useState(0);
  const historyReplayRef = useRef<string | null>(null);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [renderingIndex, setRenderingIndex] = useState<number | null>(null);
  const buffersRef = useRef<Map<number, AudioBuffer>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const playTokenRef = useRef(0);
  // Fáza 2 stale guard — the document revision the current preview was
  // computed against; USE blocks while the store's doc has moved on.
  const previewDocRef = useRef<ProjectDocument | null>(null);
  // Audition-first section proposal. Pattern edits and scene-FX edits share
  // one stale-guarded command; the preview callback renders exactly what the
  // stored command would apply.
  const [sectionProposal, setSectionProposal] = useState<{
    label: string;
    docRef: ProjectDocument;
    command: Command;
    render: () => Promise<AudioBuffer>;
  } | null>(null);
  const sectionAuditionTokenRef = useRef(0);
  const [sectionPlaying, setSectionPlaying] = useState(false);

  const auditionSectionProposal = async (render: () => Promise<AudioBuffer>) => {
    const token = ++sectionAuditionTokenRef.current;
    try {
      const buffer = await render();
      if (token !== sectionAuditionTokenRef.current) return;
      playAuditionBuffer(buffer, () => setSectionPlaying(false));
      setSectionPlaying(true);
    } catch (err) {
      if (token === sectionAuditionTokenRef.current) {
        setError(`náhľad sekcie zlyhal: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const confirmSectionProposal = () => {
    const proposal = sectionProposal;
    if (!proposal) return;
    // Fáza 2 stale-guard semantics: any command since the preview invalidates it.
    if (services.store.getDoc() !== proposal.docRef) {
      stopAudition();
      setSectionPlaying(false);
      setSectionProposal(null);
      setError("Projekt sa zmenil od náhľadu — návrh je zastaraný. Spusť zmenu znova.");
      return;
    }
    services.store.execute(proposal.command);
    stopAudition();
    setSectionPlaying(false);
    setSectionProposal(null);
    setStatus(`✓ ${proposal.label} — aplikované (jeden undo)`);
  };

  const dismissSectionProposal = () => {
    stopAudition();
    setSectionPlaying(false);
    setSectionProposal(null);
    setStatus("Návrh sekcie odmietnutý — projekt ostal nezmenený.");
  };

  const proposeSectionChange = (
    label: string,
    docRef: ProjectDocument,
    command: Command,
    render: () => Promise<AudioBuffer>,
  ) => {
    setSectionProposal({ label, docRef, command, render });
    void auditionSectionProposal(render);
  };

  const proposeSectionPattern = (
    outcome: { patternId: string; pattern: Pattern; label: string },
    baseDoc: ProjectDocument,
  ) => {
    const render = () => renderAuditionBuffer(baseDoc, services.bank, outcome.pattern, null);
    proposeSectionChange(
      outcome.label,
      baseDoc,
      replacePatternInPlaceCommand(baseDoc, outcome.patternId, outcome.pattern),
      render,
    );
  };
  // Ghost versions (time machine) — every pattern USE pushes its applied
  // content; A/B + slider audition and morph between takes. Buffers cache
  // per ghost id; the morph preview holds one slot keyed by A:B:t.
  const [ghosts, setGhosts] = useState<readonly GhostVersion[]>(() => listGhosts());
  const [ghostAId, setGhostAId] = useState<string | null>(null);
  const [ghostBId, setGhostBId] = useState<string | null>(null);
  const [morphT, setMorphT] = useState(50);
  const [morphPlaying, setMorphPlaying] = useState(false);
  const [morphRendering, setMorphRendering] = useState(false);
  const [ghostPlayingId, setGhostPlayingId] = useState<string | null>(null);
  const [ghostRenderingId, setGhostRenderingId] = useState<string | null>(null);
  const ghostBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const morphBufferRef = useRef<{ key: string; buffer: AudioBuffer } | null>(null);
  const ghostTokenRef = useRef(0);

  // A pending generation must not touch state after unmount (or after a
  // newer generate() superseded it) — the AbortController + token make the
  // continuation a no-op. Audition playback must not outlive the panel.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      stopAudition();
    };
  }, []);

  // LOCAL INTENT MODEL — warm + availability chip. The loader module is
  // dynamic (it owns a lazily-spawned worker); when the flag is on, the
  // model starts loading in the background so the first unmatched prompt
  // finds the provider already registered. OFF (the default) costs nothing.
  // The DESKTOP Ollama bridge (SFT model, active-by-default with probe as
  // the real gate) warms through the same panel mount — it refuses when a
  // provider is already registered, so the artifact loader keeps priority.
  const [modelState, setModelState] = useState<IntentModelState>("off");
  useEffect(() => {
    // Warm the factory preset bank (a lazy ~130 KB chunk): this panel is one
    // of the few surfaces a preset ask can enter, and the sync preset
    // parsers read the bank only after the warm resolves.
    void warmFactoryPresets();
    let unsubscribe: (() => void) | null = null;
    let disposed = false;
    void import("../intent/model-loader").then((loader) => {
      if (disposed) return;
      loader.warmIntentModelProvider();
      unsubscribe = loader.onIntentModelStateChange((state) => setModelState(state));
    });
    void import("../intent/model-ollama").then((ollama) => {
      if (disposed) return;
      void ollama.ensureOllamaIntentProvider().catch(() => undefined);
    });
    // MINING console handle — `__kyxIntentFailures.export()` in devtools
    installIntentFailureDevtools();
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const toggleIntentModel = () => {
    void import("../intent/model-loader").then((loader) => {
      if (modelState === "off") {
        loader.setIntentModelMode("on");
        loader.warmIntentModelProvider();
        return;
      }
      if (modelState === "unavailable" || modelState === "error") {
        // Retry: drop the memoized probe/breaker, re-enable, warm again.
        loader.resetIntentModelLoader();
        loader.setIntentModelMode("on");
        loader.warmIntentModelProvider();
        return;
      }
      loader.setIntentModelMode("off");
    });
  };

  // DESKTOP MCP (Phase D2) — opt-in loopback bridge + stdio forwarder in the
  // desktop shell. The chip is desktop-only: enabling starts the bridge in
  // main and reveals the client config (Claude Desktop & co. point their MCP
  // config at it); forwarded calls execute through startMcpDesktopHost —
  // the same deterministic command layer as every intent in this panel.
  // Lazy desktop accessor: `getDesktopMcpApi` lives in the desktop-host
  // module (which carries the whole MCP surface) — resolve it after load so
  // the opt-in bridge stays out of the boot graph. Null until then (and on
  // web forever), which is the chip's hidden state anyway.
  const [desktopMcp, setDesktopMcp] = useState<DesktopMcpApi | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("../mcp/desktop-host").then((m) => {
      if (!cancelled) setDesktopMcp(m.getDesktopMcpApi());
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [mcpStatus, setMcpStatus] = useState<McpDesktopStatus | null>(null);
  const [mcpDestructive, setMcpDestructive] = useState(() => mcpAllowDestructive());
  const mcpConfigText = useMemo(
    () => (mcpStatus?.clientConfig ? JSON.stringify(mcpStatus.clientConfig, null, 2) : ""),
    [mcpStatus],
  );
  useEffect(() => {
    if (!desktopMcp) return;
    let disposed = false;
    void desktopMcp
      .status()
      .then((status) => {
        if (!disposed) setMcpStatus(status);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [desktopMcp]);
  const toggleDesktopMcp = () => {
    if (!desktopMcp) return;
    void (mcpStatus?.enabled ? desktopMcp.disable() : desktopMcp.enable())
      .then(() => desktopMcp.status())
      .then((status) => setMcpStatus(status))
      .catch(() => setMcpStatus(null));
  };

  // WEB MCP (Phase D3) — the ⚡ chip's browser branch: starts/stops the
  // /mcp-relay WebSocket bridge against the ACTIVE collab server. The
  // operator's MCP_TOKEN authenticates BOTH this window's relay socket and
  // the external client's streamable-HTTP calls; without it nothing starts.
  const [webMcpEnabled, setWebMcpEnabled] = useState(() => mcpRelayEnabled());
  const [webMcpConnected, setWebMcpConnected] = useState(false);
  const [webTokenDraft, setWebTokenDraft] = useState("");
  const webMcpServer = useMemo(() => mcpRelayServerUrl(), []);
  const [webMcpConfigText, setWebMcpConfigText] = useState("");
  // One shared lazy accessor — every bridge touch goes through here, so the
  // module (and its 31-tool surface) stays out of the eager chunk.
  const webHost = useMemo(() => import("../mcp/web-host"), []);
  useEffect(() => {
    let cancelled = false;
    void webHost.then((m) => {
      if (!cancelled) setWebMcpConfigText(m.mcpConfigText(webMcpServer));
    });
    return () => {
      cancelled = true;
    };
  }, [webHost, webMcpServer]);
  useEffect(() => {
    if (!webMcpEnabled) return;
    let stopped = false;
    const poll = setInterval(() => {
      void webHost.then((m) => {
        if (!stopped) setWebMcpConnected(m.mcpWebBridgeConnected());
      });
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(poll);
    };
  }, [webMcpEnabled, webHost]);
  const toggleWebMcp = async () => {
    const m = await webHost;
    if (webMcpEnabled) {
      setMcpRelayEnabled(false);
      m.stopMcpWebBridge();
      setWebMcpEnabled(false);
      setWebMcpConnected(false);
      return;
    }
    if (webTokenDraft.trim() !== "") setMcpRelayToken(webTokenDraft);
    const started = m.startMcpWebBridge(services);
    if (!started) return; // no token yet — the config row asks for it
    setMcpRelayEnabled(true);
    setWebMcpEnabled(true);
    setWebTokenDraft("");
  };
  const applyWebToken = () => {
    if (webTokenDraft.trim() === "") return;
    setMcpRelayToken(webTokenDraft);
    setWebTokenDraft("");
    if (webMcpEnabled) {
      void webHost.then((m) => m.startMcpWebBridge(services)); // restart with the new token
    }
  };

  // Audit 13 D2: a PROJECT SWITCH swaps `services` while this panel stays
  // mounted — abort the in-flight generation and drop its candidate bank so
  // the old project's proposal can never be applied into the new project.
  useEffect(() => {
    abortRef.current?.abort();
    stopAudition();
    songTokenRef.current++;
    sectionTokenRef.current++;
    setSongRendering(false);
    songBufferRef.current = null;
    sectionBuffersRef.current = new Map();
    setBankResult(null);
    setPlayingIndex(null);
    setPlayingSectionId(null);
    setRenderingSectionId(null);
    setSongDraft(null);
    setSongSuggestions([]);
    setJustApplied(false);
    // GOAL 03 (re-run 4): the vocal-take card is the same race class as the
    // candidate bank — a profile analyzed from the OLD project's take must
    // never survive a project switch (apply buttons read the CURRENT doc).
    takeTokenRef.current += 1;
    setTakeProfile(null);
    setTakeRef(null);
  }, [services]);

  // Landing handoff (viral growth plan A2): the prompt that forged the beat
  // now playing pre-fills the field, so "tweak it and Forge another" is one
  // edit away. Take-semantics — the stash clears on read.
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const prefill = takeIntentPrefill();
    if (!prefill) return;
    setText(prefill);
    setStatus("Your beat is loaded below — tweak the prompt or forge another.");
    promptInputRef.current?.focus();
  }, []);

  // B1 gallery REGEN: `?regen=1` opened the studio with a beat that carries
  // intent provenance — pre-fill the field with the beat's own character and
  // auto-run ONE fresh-seed generation ("another one like this"). StrictMode
  // double-mounts this effect; the module-level guard keeps it single-shot.
  // runGeneration is declared below — a mount-time call reads it fine (hoisted
  // const via closure at effect-run time), so this effect sits here beside the
  // prefill one it mirrors.
  useEffect(() => {
    if (!takeRegenFlag()) return;
    if (regenAutoRan) return;
    regenAutoRan = true;
    const snapshot = intentSnapshotOfDoc(doc);
    if (!snapshot) {
      setStatus("This beat carries no intent provenance — describe your variation instead.");
      return;
    }
    setText(promptFromIntent(snapshot) || "regenerated take");
    setStatus("🎲 Regenerating — same character, fresh take…");
    void runGeneration({ ...(snapshot as IntentInput), seed: freshRegenSeed() }, new AbortController());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Live parse preview — shows what the engine understood from the text. */
  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    return parseIntentText(text);
  }, [text]);

  useEffect(() => {
    if (parsed?.input.genre) setPreferredStyleGenre(parsed.input.genre);
  }, [parsed?.input.genre]);

  useEffect(() => {
    const refreshStyleMemory = (): void => {
      setLearnedPatternCount(countStyleExamples());
      setAutomaticLearning(automaticStyleLearningEnabled());
      setStyleMemoryRevision((revision) => revision + 1);
    };
    window.addEventListener(STYLE_EXAMPLES_CHANGED_EVENT, refreshStyleMemory);
    window.addEventListener(PREFERENCE_LEDGER_CHANGED_EVENT, refreshStyleMemory);
    return () => {
      window.removeEventListener(STYLE_EXAMPLES_CHANGED_EVENT, refreshStyleMemory);
      window.removeEventListener(PREFERENCE_LEDGER_CHANGED_EVENT, refreshStyleMemory);
    };
  }, []);

  const learnedStyle = useMemo(
    () => personalStyleProfile(parsed?.input.genre),
    [learnedPatternCount, parsed?.input.genre, styleMemoryRevision],
  );
  const learningGenre = parsed?.input.genre ?? learnedStyle?.genre ?? null;
  const correctionSummary = useMemo(
    () => (learningGenre ? personalStyleCorrectionSummary(learningGenre, readPreferenceLedger()) : null),
    [learningGenre, styleMemoryRevision],
  );
  const personalIntents = useMemo(
    () => personalStyleIntentSuggestions(learnedStyle, correctionSummary?.directions ?? []),
    [learnedStyle, correctionSummary],
  );

  const learnActivePattern = () => {
    const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    if (!pattern) {
      setStyleMemoryMessage("Aktívny pattern sa nenašiel.");
      return;
    }
    const example = patternStyleExampleFromProject(doc, pattern, parsed?.input.genre);
    if (!example) {
      setStyleMemoryMessage("Pattern je prázdny; najprv doň pridaj noty alebo bicie.");
      return;
    }
    if (!recordStyleExample(example)) {
      setStyleMemoryMessage("Príklad sa nepodarilo uložiť do lokálnej pamäte.");
      return;
    }
    const count = countStyleExamples();
    setLearnedPatternCount(count);
    setStyleMemoryMessage(`Zapamätané lokálne · ${example.genre} · ${count} príkladov štýlu.`);
  };

  const forgetLearnedPatterns = () => {
    if (learnedPatternCount === 0 && (correctionSummary?.correctionCount ?? 0) === 0) return;
    if (
      !window.confirm(
        "Vymazať všetky lokálne príklady štýlu aj Producer DNA preferencie vrátane ručných opráv? Túto akciu nemožno vrátiť.",
      )
    )
      return;
    if (!clearStyleExamples()) {
      setStyleMemoryMessage("Pamäť sa nepodarilo vymazať.");
      return;
    }
    clearPreferenceLedger();
    resetStyleVector();
    resetSemanticCorpusCache();
    setLearnedPatternCount(0);
    setStyleMemoryMessage("Lokálny Producer DNA profil aj preferencie z ručných opráv boli vymazané.");
  };

  const toggleAutomaticLearning = () => {
    const next = !automaticLearning;
    if (!setAutomaticStyleLearningEnabled(next)) {
      setStyleMemoryMessage("Nastavenie učenia sa nepodarilo uložiť v tomto prehliadači.");
      return;
    }
    setAutomaticLearning(next);
    setStyleMemoryMessage(
      next
        ? "Automatické lokálne učenie je zapnuté. KYX si po ručných úpravách zapamätá iba hudobné súhrny."
        : "Automatické učenie je pozastavené. Doterajšie lokálne príklady zostali uložené.",
    );
  };

  const savedBriefAt = doc.producerBrief?.savedAt ?? null;
  useEffect(() => {
    setUseProjectBrief(Boolean(doc.producerBrief));
  }, [doc.id, savedBriefAt]);

  // Fáza 1 brief contract: "TOTO SOM POCHOPIL" — confirmable reading of the
  // prompt. User fixes ride in their own patch state; a NEW prompt invalidates
  // them (they described the previous reading, not this one).
  const [briefFixes, setBriefFixes] = useState<IntentInput>({});
  useEffect(() => {
    setBriefFixes({});
  }, [text]);
  const activeProjectBrief = useProjectBrief ? (doc.producerBrief ?? null) : null;
  const projectBriefCorrections = useMemo(
    () => projectBriefCorrectionsFor(parsed, activeProjectBrief),
    [parsed, activeProjectBrief],
  );
  const briefContract = useMemo(
    () =>
      compileBriefContract(parsed, {
        project: doc,
        session: producerSessionState(),
        projectBrief: activeProjectBrief,
        defaultRoles: ["drums", "bass"],
        corrections: briefFixes,
      }),
    [parsed, doc, briefFixes, activeProjectBrief],
  );
  const briefInput = useMemo<IntentInput>(
    () => ({ ...(parsed?.input ?? {}), ...projectBriefCorrections, ...briefFixes }),
    [parsed, projectBriefCorrections, briefFixes],
  );
  const canSaveProjectBrief = useMemo(
    () => createProjectBriefFromContract(briefContract, briefInput, "2026-10-02T00:00:00.000Z") !== null,
    [briefContract, briefInput],
  );
  const rejectUnresolvedBriefConflicts = () => {
    if (briefContract.conflicts.length === 0) return false;
    setError(BRIEF_CONFLICT_BLOCK_MESSAGE);
    return true;
  };

  const candidates = bankResult?.bank ?? null;

  // Fáza 2: truthful per-fact compliance of the preview against the brief —
  // ✓ provable from the pattern, · plan-enforced/unset. Never a quality score.
  const bankCompliance = useMemo(
    () => (bankResult?.proposal ? evaluateBriefCompliance(bankResult, doc) : []),
    [bankResult, doc],
  );

  // C2 revise: the intent of the LAST generation — "more energetic" re-runs
  // THIS intent with a shifted slider (same seed = same beat, new character).
  const lastIntentRef = useRef<IntentInput | null>(null);

  // A3 share moment: right after USE the beat belongs to the user — that is
  // the moment of pride and the moment to share. The CTA row appears after
  // every successful apply and hides when a new generation starts.
  const [justApplied, setJustApplied] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);
  const videoSupported = useMemo(() => canExportVideo(), []);

  const runGeneration = async (intentInput: IntentInput, controller: AbortController, promptText = text) => {
    try {
      const result: GenerationResult = await generateAsyncResult(
        doc,
        {
          ...intentInput,
          seed: intentInput.seed || `intent-${Date.now()}`,
          candidateCount: intentInput.candidateCount ?? 3,
          // T2: two extra candidates sampled from the ONNX symbolic drum
          // prior join the same bank; a missing model just shrinks the bank.
          symbolicCandidates: intentInput.symbolicCandidates ?? 2,
          roles: intentInput.roles ?? ["drums", "bass"],
        },
        { mode: "apply", signal: controller.signal, includeBank: true, sound: { bank: services.bank } },
      );
      if (controller.signal.aborted) return;
      if (!result.proposal) {
        const reason = result.diagnostics.errors[0] ?? result.diagnostics.fallbackReason ?? "generation rejected";
        setError(`Generation failed: ${reason} — try a different intent.`);
        return;
      }
      lastIntentRef.current = result.plan.intent;
      // Session context (vibe-code wave 2): the bank stays addressable —
      // "that second one, darker" resolves against it next prompt.
      rememberGeneration({
        text: intentInput.seed ? promptText.trim() || intentInput.seed : promptText.trim(),
        intent: intentInput,
        candidates: (result.bank ?? []).map((entry, index) => ({
          index,
          pattern: entry.pattern,
          intent: result.plan.intent,
        })),
        appliedIndex: null,
        docId: doc.id,
        at: Date.now(),
      });
      rememberPrompt(promptText);
      setHistoryTick((tick) => tick + 1);
      setBankResult(result);
      // Fáza 2 stale guard: the preview belongs to THIS document revision.
      // Any command applied afterwards makes the bank stale — USE must not
      // write a preview computed against an older project.
      previewDocRef.current = doc;
      recordIntentDecisions(intentInput, promptText);
      bumpGenerationCount();
      setSessionTick((tick) => tick + 1);
      const count = result.bank?.length ?? 0;
      setStatus(
        count > 0
          ? `✓ ${count} candidates — ▶ to audition, USE to apply`
          : `✓ pattern generated (${rankerModeLabel()})`,
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const generate = async (requestedText = text) => {
    const promptText = requestedText.trim();
    const promptParsed = promptText === text.trim() ? parsed : promptText ? parseIntentText(promptText) : null;
    const promptCorrections = promptText === text.trim() ? briefFixes : {};
    const promptProjectCorrections = projectBriefCorrectionsFor(promptParsed, activeProjectBrief);
    const promptBriefInput: IntentInput = {
      ...(promptParsed?.input ?? {}),
      ...promptProjectCorrections,
      ...promptCorrections,
    };
    const promptBriefContract =
      promptText === text.trim()
        ? briefContract
        : compileBriefContract(promptParsed, {
            project: doc,
            session: producerSessionState(),
            projectBrief: activeProjectBrief,
            defaultRoles: ["drums", "bass"],
            corrections: promptCorrections,
          });
    if ((!promptText && !activeProjectBrief) || busy) return;
    if (promptBriefContract.conflicts.length > 0) {
      setError(BRIEF_CONFLICT_BLOCK_MESSAGE);
      return;
    }
    // User actually used the AI path — the onboarding hint can advance.
    notifyOnboardingProgress("intent-generated");
    setBusy(true);
    setError(null);
    setStatus(null);
    setBankResult(null);
    setAudiotoolExport(null);
    setPlayingIndex(null);
    setJustApplied(false);
    stopAudition();
    setSongDraft(null);
    setSongSuggestions([]);
    setSongPlaying(false);
    setPlayingSectionId(null);
    setRenderingSectionId(null);
    buffersRef.current = new Map();
    // A pending SONG draft is superseded by a fresh DO IT — without this
    // bump its awaited continuations would install a stale draft from the
    // abandoned prompt after this generation lands (GOAL 07, re-run 4;
    // the token's own design comment lists superseding actions, DO IT was
    // the missing one).
    songTokenRef.current++;
    sectionTokenRef.current++;
    setSongRendering(false);
    songBufferRef.current = null;
    sectionBuffersRef.current = new Map();
    // SESSION REFERENCE (vibe-code wave 2): "that second one, darker" —
    // apply the referenced candidate from the last generation, then run the
    // residual words through the normal pipeline (production/verbs/song).
    const last = lastGeneration();
    const reference = last ? resolveSessionReference(promptText, last.candidates) : null;
    if (reference && last) {
      if (last.docId !== doc.id) {
        setError("Tento session kandidát patrí inému projektu. Vygeneruj kandidátov znova v aktuálnom projekte.");
        setBusy(false);
        return;
      }
      // Fáza 3 iteration: a residual CHANGE (mood/energy/bpm/… or a preserve
      // clause) becomes a TARGETED PROPOSAL on the referenced candidate —
      // audition first, USE applies (one undo). Scope is stated in the
      // summary, never implicit. A pure reference ("ten druhý") keeps the
      // instant re-apply below.
      const iteration = compileIteration(promptText, last, doc);
      if (iteration) {
        rememberPrompt(promptText);
        if (!iteration.result.proposal) {
          setError(iteration.result.diagnostics.errors[0] ?? "Návrh iterácie neprešiel kontrolou briefu.");
          setBusy(false);
          return;
        }
        setBankResult(iteration.result);
        previewDocRef.current = doc;
        buffersRef.current = new Map();
        setStatus(`↻ ${iteration.summary} — ▶ náhľad, USE na aplikovanie`);
        setBusy(false);
        return;
      }
      const candidate = last.candidates[reference.index];
      services.store.execute(applySessionCandidateCommand(doc, candidate.pattern));
      rememberPrompt(promptText);
      let statusText = `✓ candidate #${reference.index + 1} re-applied from session context`;
      const residualText = reference.rest;
      if (residualText) {
        const production = parseProductionIntent(residualText);
        if (production) {
          try {
            services.store.execute(applyProductionIntentCommand(doc, production));
            statusText += ` + ${production.goals.map((g) => g.concept).join(" + ")}`;
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }
      }
      setStatus(statusText);
      setBusy(false);
      return;
    }
    // TONE VERB (ADR 0016/0018 intent surface): "play the tone" / "tune
    // tone to 880" / "stop the tone" — the CLAP tone fixture through the
    // EXT PCM chain (shared controller: the chip reflects it).
    const toneIntent = parseToneIntent(promptText);
    if (toneIntent) {
      services.engine.ensureContext();
      const ctx = services.engine.getLiveAudioContext();
      if (!ctx) {
        setError("Audio engine not ready.");
        setBusy(false);
        return;
      }
      const controller = getSharedPcmPlayback(() => ctx);
      try {
        if (toneIntent.kind === "stop") {
          await controller.stop();
          setStatus("✓ Tone stopped.");
        } else {
          await controller.start("clap-player", ["--set", String(toneIntent.freq), "--realtime", "--seconds", "300"]);
          setStatus(`✓ CLAP tone @ ${toneIntent.freq} Hz — beží (stop: "stop the tone")`);
        }
      } catch (err) {
        setError(`Tone source: ${err instanceof Error ? err.message : String(err)}`);
      }
      setBusy(false);
      return;
    }
    // PLUGIN FINDER VERB (ADR 0016 intent surface): "aké clapy mám?" runs
    // the desktop crash-isolated CLAP scan; the web build answers honestly
    // that plugins live behind the desktop shell.
    const pluginFinder = parsePluginFinderIntent(promptText);
    if (pluginFinder) {
      const desktop = (
        window as unknown as {
          kyxDesktop?: {
            clap?: {
              scan?: () => Promise<{
                status: string;
                plugins: Array<{ name: string; vendor?: string; id: string }>;
                scannedDirectories?: string[];
              }>;
            };
          };
        }
      ).kyxDesktop;
      const scan = desktop?.clap?.scan;
      if (typeof scan !== "function") {
        setStatus(
          "✓ CLAP pluginy sa skenujú v desktop shelli (Electron) — prehliadač nemá natívny prístup k pluginom.",
        );
        setBusy(false);
        return;
      }
      setStatus("Skenujem CLAP pluginy…");
      try {
        const result = await scan();
        if (result.status !== "ok") {
          setError(`CLAP scan zlyhal (${result.status}) — pozri desktop log.`);
        } else if (result.plugins.length === 0) {
          setStatus(
            `✓ Žiadne CLAP pluginy v štandardných adresároch (${(result.scannedDirectories ?? []).join(" · ")})`,
          );
        } else {
          const shown = result.plugins.slice(0, 6).map((p) => `${p.name}${p.vendor ? ` — ${p.vendor}` : ""}`);
          const more =
            result.plugins.length > shown.length ? ` · +${result.plugins.length - shown.length} ďalších` : "";
          setStatus(`✓ ${result.plugins.length} CLAP pluginov: ${shown.join(" · ")}${more}`);
        }
      } catch (err) {
        setError(`CLAP scan zlyhal: ${String(err)}`);
      }
      setBusy(false);
      return;
    }
    // CHASE VERB (ADR 0017 wave 2 intent surface): "chase my timecode" /
    // "sleduj timecode" arms the chaser, "go to 1:23" seeks the playhead to
    // a timecode position at the current BPM. Transport-domain action (like
    // clock sync) — immediate, not an undoable document command.
    const chaseIntent = parseChaseIntent(promptText);
    if (chaseIntent) {
      const chaser = services.mtcChaser;
      if (chaseIntent.kind === "arm") {
        chaser.armed = true;
        setStatus("✓ MTC chase ARMED — transport sleduje externý timecode (full frames skáču okamžite)");
      } else if (chaseIntent.kind === "disarm") {
        chaser.armed = false;
        setStatus("✓ MTC chase vypnutý — transport behá na svojom čase");
      } else if (chaseIntent.kind === "offset") {
        chaser.offsetSeconds = chaseIntent.seconds;
        setStatus(
          chaseIntent.seconds === 0
            ? "✓ Timecode offset vynulovaný — TC 00:00:00:00 = začiatok projektu"
            : `✓ Timecode offset: ${chaseIntent.seconds} s — TC ${chaseIntent.seconds >= 0 ? "začína" : "končí"} na začiatku projektu`,
        );
      } else if (chaser.seekToTimecode(chaseIntent.tc)) {
        setStatus(`✓ playhead → ${formatSmpTe(chaseIntent.tc)} (TC @ ${services.store.getDoc().bpm} BPM)`);
      } else {
        setError("Nepodarilo sa namapovať timecode — skontroluj formát (hh:mm:ss:ff).");
      }
      setBusy(false);
      return;
    }
    // Production intents (master doc §4.3): "make the bass deeper" tweaks the
    // EXISTING track's sound through effects — one undoable command group —
    // instead of generating a new pattern. Detection is comparative/
    // imperative phrasing, so "dark techno" still generates. A GENRE signal
    // (or section vocabulary) flips the same FX words into generation-time
    // FX instead: "wobbly drill" GENERATES with the mangler, it doesn't
    // re-tune the old pattern.
    const production = parseProductionIntent(promptText);
    const sectionParse = parseSectionRequests(promptText);
    const remainingFxText = sectionParse?.remainingText ?? promptText;
    const genreSignal = Boolean(promptBriefInput.genre || promptParsed?.detected.some((chip) => chip.startsWith("♪")));
    if (production && !genreSignal && !sectionParse) {
      try {
        const cmd = applyProductionIntentCommand(doc, production);
        services.store.execute(cmd);
        setStatus(`✓ ${cmd.label} — applied (one undo step)`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setBusy(false);
      return;
    }
    // Section vocabulary in the sentence → the SONG path directly
    // ("wobbly drill with a 16-bar intro and a vinyl break" is a song
    // request, not a one-bar pattern).
    if (sectionParse) {
      setBusy(false);
      await runSongBuild(sectionParse);
      return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const intentInput = {
      ...promptBriefInput,
      ...(refPatch ?? {}),
      ...promptCorrections,
      ...(consumeOneShotPatch() ?? {}),
    };
    // Wave 1 — FX words remaining after section parsing ride WITH the
    // generation ("wobbly drill"): candidates carry them, USE applies
    // pattern + FX as one step.
    const globalFx = genreSignal ? parseProductionIntent(remainingFxText) : null;
    // Artist FX hints (Vlna 8 polish): the matched preset's own devices
    // ride along ONLY when the user typed no FX of their own — user words
    // always win over the artist signature.
    const artistFx = globalFx ? null : parseProductionIntent(fxWordsForArtist(intentInput.artist).join(" "));
    const effectiveFx = globalFx ?? artistFx;
    // T1 krok 2 semantic layer: when the keyword parse is WEAK (no genre
    // word, no artist preset), ask the embedding model for the nearest
    // curated reference. Confident keyword parses skip it — zero latency
    // cost when the parser already understands.
    let finalInput = intentInput;
    if (promptText && !intentInput.genre && !promptParsed?.detected.some((chip) => chip.startsWith("♪"))) {
      setStatus("🧠 semantic…");
      const match = await semanticIntentFor(promptText);
      if (controller.signal.aborted) return;
      if (match) {
        finalInput = { ...intentInput, ...match.input };
        setSemanticChip(`🧠 ${match.label} (${Math.round(match.score * 100)}%)`);
      } else {
        setSemanticChip(null);
      }
    } else {
      setSemanticChip(null);
    }
    if (effectiveFx) finalInput = { ...finalInput, fx: effectiveFx };
    await runGeneration(finalInput, controller, promptText);
  };

  useEffect(() => {
    const replayText = historyReplayRef.current;
    if (replayText === null) return;
    if (replayText !== text) {
      historyReplayRef.current = null;
      return;
    }
    if (Object.keys(briefFixes).length > 0) return;
    historyReplayRef.current = null;
    void generate();
  }, [text, briefFixes, historyReplayTick]);

  const toggleAudition = async (candidate: RankedCandidate) => {
    if (playingIndex === candidate.candidateIndex) {
      stopAudition();
      setPlayingIndex(null);
      return;
    }
    const token = ++playTokenRef.current;
    setRenderingIndex(candidate.candidateIndex);
    try {
      let buffer = buffersRef.current.get(candidate.candidateIndex);
      if (!buffer) {
        // Wave: the audition HEARS the FX — the candidate's fx requests are
        // folded into the ghost document, so what you preview is what USE
        // installs. Buffers cache per candidate (fx rides the plan).
        const picked = bankResult ? resultForCandidate(bankResult, candidate.candidateIndex) : null;
        const fx = picked?.plan.intent.fx ?? null;
        buffer = await renderAuditionBuffer(doc, services.bank, candidate.pattern, fx);
        buffersRef.current.set(candidate.candidateIndex, buffer);
      }
      if (playTokenRef.current !== token) return; // superseded meanwhile
      playAuditionBuffer(buffer, () => setPlayingIndex(null));
      setPlayingIndex(candidate.candidateIndex);
      const withFx = bankResult
        ? (resultForCandidate(bankResult, candidate.candidateIndex)?.plan.intent.fx ?? null)
        : null;
      setStatus(`▶ auditioning candidate #${candidate.candidateIndex + 1}${withFx ? " — with FX" : ""}`);
    } catch (err) {
      if (playTokenRef.current === token) {
        setError(`audition failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (playTokenRef.current === token) setRenderingIndex(null);
    }
  };

  const useCandidate = (candidate: RankedCandidate | null) => {
    if (!bankResult?.proposal) return;
    // Fáza 2 stale guard: the project changed since this preview was
    // generated (user edit, collab peer). Applying would write content
    // computed against an older document — block with a clear message and
    // keep the bank listenable instead of silently regenerating.
    if (previewDocRef.current && services.store.getDoc() !== previewDocRef.current) {
      stopAudition();
      setPlayingIndex(null);
      setError("Návrh je zastaraný — projekt sa zmenil počas náhľadu. Vygeneruj znova.");
      return;
    }
    stopAudition();
    setPlayingIndex(null);
    setSongDraft(null);
    setSongSuggestions([]);
    setSongPlaying(false);
    setPlayingSectionId(null);
    setRenderingSectionId(null);
    // USE supersedes a pending SONG draft (same token contract as DROP and
    // DO IT — GOAL 07, re-run 4): the draft's awaited continuations must
    // not install after the user already applied a candidate.
    songTokenRef.current++;
    sectionTokenRef.current++;
    setSongRendering(false);
    songBufferRef.current = null;
    sectionBuffersRef.current = new Map();
    const picked = candidate ? resultForCandidate(bankResult, candidate.candidateIndex) : bankResult;
    const fx = picked.plan.intent.fx ?? null;
    // Artist mix signature (Vlna 8): when the generation intent carries a
    // signed artist, the mix decisions land WITH the pattern — both inside
    // ONE undo frame, so Ctrl+Z removes pattern + mix together.
    const artistSigned = artistMixProfileOf(normalizeIntent({ ...picked.plan.intent }));
    const mixProfile = artistSigned ? planMixProfile(normalizeIntent({ ...picked.plan.intent })) : null;
    const mixWanted = (mixProfile?.decisions.length ?? 0) > 0;
    services.store.beginUndoFrame("Generate + artist mix");
    services.store.execute(
      fx
        ? applyGenerationResultWithFxCommand(doc, picked, picked.plan.intent.genre || undefined)
        : applyGenerationResultCommand(doc, picked, picked.plan.intent.genre || undefined),
    );
    if (mixWanted) {
      services.store.execute(applyMixIntent(services.store.getDoc(), mixProfile!));
    }
    services.store.endUndoFrame();
    setBankResult(null);
    buffersRef.current = new Map();
    setStatus(
      candidate
        ? `✓ applied candidate #${candidate.candidateIndex + 1} (${candidate.source})${fx ? " + FX" : ""}${
            mixWanted ? " + artist mix" : ""
          }`
        : `✓ pattern applied${fx ? " + FX" : ""}${mixWanted ? " + artist mix" : ""}`,
    );
    // Ghost versions: remember the applied content (read back post-execute
    // for exactness — the command may rename) for A/B + morph later.
    const appliedDoc = services.store.getDoc();
    const appliedPattern = appliedDoc.patterns.find((p) => p.id === appliedDoc.activePatternId);
    if (appliedPattern) {
      pushGhost(appliedPattern, nextGhostLabel(appliedPattern.name), text.trim() || null);
      const grown = listGhosts();
      setGhosts(grown);
      setGhostAId((prev) => prev ?? grown[grown.length - 2]?.id ?? grown[0]?.id ?? null);
      setGhostBId((prev) => prev ?? grown[grown.length - 1]?.id ?? null);
    }
    // A3: the applied beat is the share moment — reveal Publish/Video/Copy.
    setJustApplied(true);
  };

  /** Stable V-numbers across remounts and cap eviction (max existing + 1). */
  function nextGhostLabel(patternName: string): string {
    let max = 0;
    for (const g of listGhosts()) {
      const match = /\bV(\d+)\b/.exec(g.label);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `V${max + 1} · ${patternName}`;
  }

  /** Stop every other audition channel before starting a ghost one. */
  function silenceOthers(): void {
    stopAudition();
    setPlayingIndex(null);
    setSongPlaying(false);
    setPlayingSectionId(null);
    setMorphPlaying(false);
    setGhostPlayingId(null);
  }

  const toggleGhostAudition = async (ghost: GhostVersion) => {
    if (ghostPlayingId === ghost.id) {
      stopAudition();
      setGhostPlayingId(null);
      return;
    }
    silenceOthers();
    const token = ++ghostTokenRef.current;
    setGhostRenderingId(ghost.id);
    try {
      let buffer = ghostBuffersRef.current.get(ghost.id);
      if (!buffer) {
        buffer = await renderAuditionBuffer(services.store.getDoc(), services.bank, ghost.pattern, null);
        ghostBuffersRef.current.set(ghost.id, buffer);
      }
      if (ghostTokenRef.current !== token) return;
      playAuditionBuffer(buffer, () => setGhostPlayingId(null));
      setGhostPlayingId(ghost.id);
      setStatus(`👻 auditioning ${ghost.label}`);
    } catch (err) {
      if (ghostTokenRef.current === token) {
        setError(`ghost audition failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (ghostTokenRef.current === token) setGhostRenderingId(null);
    }
  };

  const restoreGhost = (ghost: GhostVersion) => {
    const current = services.store.getDoc();
    silenceOthers();
    services.store.execute(replacePatternInPlaceCommand(current, current.activePatternId, ghost.pattern));
    setStatus(`👻 restored ${ghost.label} (one undo step)`);
    setJustApplied(true);
  };

  const dropGhost = (ghost: GhostVersion) => {
    removeGhost(ghost.id);
    ghostBuffersRef.current.delete(ghost.id);
    morphBufferRef.current = null;
    setGhosts(listGhosts());
    setGhostAId((prev) => (prev === ghost.id ? null : prev));
    setGhostBId((prev) => (prev === ghost.id ? null : prev));
    if (ghostPlayingId === ghost.id) {
      stopAudition();
      setGhostPlayingId(null);
    }
  };

  function morphPair(): { a: GhostVersion; b: GhostVersion } | null {
    const a = ghostAId ? getGhost(ghostAId) : null;
    const b = ghostBId ? getGhost(ghostBId) : null;
    return a && b ? { a, b } : null;
  }

  const previewMorph = async () => {
    const pair = morphPair();
    if (!pair) {
      setStatus("👻 pick ghost A and B first (need two takes to morph)");
      return;
    }
    if (pair.a.id === pair.b.id) {
      setStatus("👻 A and B are the same take — pick two different ghosts");
      return;
    }
    const t = morphT / 100;
    const morphed = morphPatterns(pair.a.pattern, pair.b.pattern, t);
    if (!morphed) {
      setError("👻 morph needs equal-length patterns — these takes differ in bars");
      return;
    }
    silenceOthers();
    const key = `${pair.a.id}:${pair.b.id}:${morphT}`;
    const token = ++ghostTokenRef.current;
    setMorphRendering(true);
    try {
      let buffer = morphBufferRef.current?.key === key ? morphBufferRef.current.buffer : null;
      if (!buffer) {
        buffer = await renderAuditionBuffer(services.store.getDoc(), services.bank, morphed, null);
        morphBufferRef.current = { key, buffer };
      }
      if (ghostTokenRef.current !== token) return;
      playAuditionBuffer(buffer, () => setMorphPlaying(false));
      setMorphPlaying(true);
      setStatus(`👻 morph ${pair.a.label} ⟷ ${pair.b.label} @ ${morphT}%`);
    } catch (err) {
      if (ghostTokenRef.current === token) {
        setError(`morph preview failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (ghostTokenRef.current === token) setMorphRendering(false);
    }
  };

  const useMorph = () => {
    const pair = morphPair();
    if (!pair || pair.a.id === pair.b.id) {
      setStatus("👻 pick two different ghosts for A and B first");
      return;
    }
    const t = morphT / 100;
    const morphed = morphPatterns(pair.a.pattern, pair.b.pattern, t);
    if (!morphed) {
      setError("👻 morph needs equal-length patterns — these takes differ in bars");
      return;
    }
    silenceOthers();
    const current = services.store.getDoc();
    services.store.execute(replacePatternInPlaceCommand(current, current.activePatternId, morphed));
    const appliedDoc = services.store.getDoc();
    const appliedPattern = appliedDoc.patterns.find((p) => p.id === appliedDoc.activePatternId);
    if (appliedPattern) {
      pushGhost(appliedPattern, nextGhostLabel(`morph ${morphT}%`), text.trim() || null);
      setGhosts(listGhosts());
    }
    setStatus(`👻 morph applied @ ${morphT}% — and ghosted as a new take (one undo step)`);
    setJustApplied(true);
  };

  /** Copy a share link that opens the whole project in another tab. */
  const copyShareLink = async () => {
    funnelEvent("share_copy");
    const url = shareAppUrl(encodeShareCode(services.store.getDoc()), location.origin);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setStatus("✓ Share link copied — anyone opening it gets this project");
    } catch {
      // Clipboard permission denied / insecure context — surface the link
      // the manual way instead of failing silently (or lying about success).
      window.prompt("Copy this share link:", url);
      setStatus("Share link shown — copy it from the dialog");
    }
  };

  /** Render the applied beat and record a vertical social clip. */
  const exportVideo = async () => {
    if (videoBusy) return;
    setVideoBusy(true);
    setError(null);
    funnelEvent("share_video");
    try {
      setStatus("Rendering your beat…");
      const buffer = await renderProject(services.store.getDoc(), services.bank, {
        mode: services.playback.getSnapshot(),
        sampleRate: 44100,
      });
      setStatus("Recording video…");
      const result = await recordVideo(buffer, {
        title: services.store.getDoc().name,
        bpm: services.store.getDoc().bpm,
        seconds: buffer.duration,
        onProgress: (f) => setStatus(`Recording video… ${Math.round(f * 100)}%`),
      });
      downloadBlob(result.blob, `${sanitizeFilename(services.store.getDoc().name)}-clip.${result.ext}`);
      setStatus(`✓ Video exported — ${result.ext.toUpperCase()}, ready for Reels/Shorts/TikTok`);
    } catch (err) {
      setError(`video export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setVideoBusy(false);
    }
  };

  // A2 song builder: one intent → full arranged song (one undo step).
  // Wave 2+3 — the sentence's section vocabulary shapes the form ("16-bar
  // intro", "chorus twice", "no break") and scopes FX ("vinyl break"); the
  // intent's remaining FX words become global song chains.
  // SUNO MODE — one sentence through the FULL pipeline: song (sections,
  // transitions, scoped FX, length words) + mix profile + loudness pass.
  // Undo per stage; the loudness render must run AFTER install.
  const [songBusy, setSongBusy] = useState(false);
  // SONG DRAFT (audition-before-apply): compose builds the song + mix off to
  // the side, the user HEARS the whole arrangement through the offline
  // renderer first, then USE installs it (fresh commands against the latest
  // doc so undo stays correct). Discard drops everything, nothing applied.
  // The loudness runner is stored on the draft and runs only on USE — the
  // previous flow measured loudness but never executed its trim command.
  interface SongDraft {
    result: ComposeResult;
    /** Exact whole-song candidate currently auditioned and eligible for USE. */
    activeBuild: SongBuild;
    /** null means the legacy best-per-section composition. */
    activeLane: SearchLane | null;
    /** A selected coherent lane cannot be applied until its full-song render succeeds. */
    previewReady: boolean;
    /** Doc the draft was composed against — USE reuses the auditioned mix
        only while the doc is untouched (reference-equal); after interim
        edits the mix re-plans against the current doc (rebase). */
    baseDoc: ProjectDocument;
    previewDoc: ProjectDocument;
    mixNote: string;
    lengthNote: string;
    seconds: number;
    /** Preview loudness trim (master.loudnessTrimDb) — FÁZA 6: this is the
        RECOMMENDED trim until the user confirms; USE installs it only when
        loudnessApplied is true (confirm re-renders the audition trimmed). */
    trimDb: number;
    loudnessTarget: number;
    measuredBefore: number | null;
    /** Gated LUFS measured on the audition buffer itself (the free verify). */
    measuredAfter: number | null;
    loudnessApplied: boolean;
    /** Structured report (goal/evidence/trade-off) behind the recommendation. */
    loudnessRecommendation: LoudnessRecommendation | null;
    audioReview: SongAudioReview | null;
  }
  const [songDraft, setSongDraft] = useState<SongDraft | null>(null);
  const [songPlaying, setSongPlaying] = useState(false);
  const [songRendering, setSongRendering] = useState(false);
  const songBufferRef = useRef<AudioBuffer | null>(null);
  const songTokenRef = useRef(0);
  const songTextRef = useRef("");
  // SESSION THEATRE — NAJMI KAPELU: each producer = one full composeFullTrack
  // session on the same brief. While the session runs the cards stream stage
  // labels UNDER THEIR REAL NAMES (you watch the band work); the finále vote
  // is BLIND (cards mask to "Take A/B") and only the revealed winner hands
  // its draft to the normal USE flow below. A take IS a SongDraft, so the
  // winner needs zero new apply code.
  interface TheatreTake {
    run: TheatreRun;
    draft: SongDraft | null;
    buffer: AudioBuffer | null;
    stage: number;
    label: string;
    failed: string | null;
  }
  const [theatre, setTheatre] = useState<TheatreTake[] | null>(null);
  const [theatreBusy, setTheatreBusy] = useState(false);
  /** Blind finále bracket: current pair + queued challengers (tournament). */
  const [theatrePair, setTheatrePair] = useState<{ a: number; b: number; queue: number[] } | null>(null);
  const [theatrePlaying, setTheatrePlaying] = useState<number | null>(null);
  const [theatreWinner, setTheatreWinner] = useState<number | null>(null);
  const [theatreRetake, setTheatreRetake] = useState("");
  const theatreTokenRef = useRef(0);
  // Per-section audition — each built section pattern renders through the
  // same candidate-audition path (ghost doc off the draft's base doc, the
  // section's own scoped FX folded in), buffers cached per pattern id.
  const [playingSectionId, setPlayingSectionId] = useState<string | null>(null);
  const [renderingSectionId, setRenderingSectionId] = useState<string | null>(null);
  // Fáza 5 — evidence-based section revival suggestions from the song
  // preview's per-section meters; a chip compiles into the audition-first
  // section proposal flow (never applied automatically).
  const [songSuggestions, setSongSuggestions] = useState<SongSectionSuggestion[]>([]);

  const applySongSuggestion = (suggestion: SongSectionSuggestion) => {
    const outcome = reviseSection(doc, suggestion.role as never, suggestion.attribute, suggestion.delta);
    if (!outcome.ok) {
      setStatus(`⟡ ${outcome.error}`);
      return;
    }
    stopAudition();
    proposeSectionPattern(outcome, doc);
    setStatus(`⟡ ${suggestion.reason} → ${outcome.label} — ▶ náhľad, ✓ potvrdiť alebo ✗ ponechať`);
  };
  const sectionBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const sectionTokenRef = useRef(0);
  useEffect(() => {
    if (briefContract.conflicts.length === 0) return;
    // A conflict supersedes any previous preview: do not leave an older bank
    // auditionable under a newly contradictory brief, and stop in-flight work.
    abortRef.current?.abort();
    stopAudition();
    setBusy(false);
    setSongBusy(false);
    setBankResult(null);
    setPlayingIndex(null);
    setRenderingIndex(null);
    buffersRef.current.clear();
    setSongDraft(null);
    setSongSuggestions([]);
    setSongPlaying(false);
    setSongRendering(false);
    setPlayingSectionId(null);
    setRenderingSectionId(null);
    setJustApplied(false);
    setStatus(null);
    songTokenRef.current++;
    sectionTokenRef.current++;
    songBufferRef.current = null;
    sectionBuffersRef.current.clear();
  }, [briefContract.conflicts]);

  const invalidateBriefResults = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    playTokenRef.current++;
    stopAudition();
    setBusy(false);
    setSongBusy(false);
    setBankResult(null);
    setPlayingIndex(null);
    setRenderingIndex(null);
    buffersRef.current.clear();
    setSongDraft(null);
    setSongSuggestions([]);
    setSongPlaying(false);
    setSongRendering(false);
    setPlayingSectionId(null);
    setRenderingSectionId(null);
    setJustApplied(false);
    setSemanticChip(null);
    setError(null);
    setStatus(null);
    previewDocRef.current = null;
    songTokenRef.current++;
    sectionTokenRef.current++;
    songBufferRef.current = null;
    sectionBuffersRef.current.clear();
  };

  const applyBriefPatch = (patch: IntentInput) => {
    invalidateBriefResults();
    setBriefFixes((previous) => ({ ...previous, ...patch }));
  };

  const saveCurrentProjectBrief = () => {
    const draft = createProjectBriefFromContract(briefContract, briefInput);
    if (!draft) {
      setStatus("Nothing explicit to save — defaults and guesses stay out of the project brief.");
      return;
    }
    try {
      const merged = mergeProjectProducerBrief(doc.producerBrief, draft);
      services.store.execute(saveProjectProducerBriefCommand(doc, merged));
      setUseProjectBrief(true);
      setStatus(`✓ Project Producer Brief saved (${merged.facts.length} facts; one undo step).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const clearSavedProjectBrief = () => {
    services.store.execute(clearProjectProducerBriefCommand(doc));
    setUseProjectBrief(false);
    setStatus("Project Producer Brief cleared (one undo step).");
  };

  const replacePrompt = (nextText: string, replay = false) => {
    invalidateBriefResults();
    setBriefFixes((previous) => (Object.keys(previous).length > 0 ? {} : previous));
    setText(nextText);
    historyReplayRef.current = replay ? nextText : null;
    if (replay) setHistoryReplayTick((tick) => tick + 1);
  };

  // Audio reference ("sprav to ako tento WAV"): patch merges into every
  // generation path, the 16-dim conditioning installs for the v2 priors.
  const [refPatch, setRefPatch] = useState<IntentInput | null>(null);
  const [refSummary, setRefSummary] = useState<string | null>(null);
  const [refBusy, setRefBusy] = useState(false);
  // Vocal-ready mode: loop the active pattern with a click so a solo artist
  // can rehearse/record vocals, plus a beat-only bounce (no master chain).
  const [vocalMode, setVocalMode] = useState(false);
  // Producer session (bod 3): decisions HUD + B/C variant chips + follow-up
  // resolve ("ten istý, len pomalšie") before the generic routes.
  const [sessionTick, setSessionTick] = useState(0);
  const oneShotPatchRef = useRef<IntentInput | null>(null);
  /** Pre-routed re-entry for the local-model fallback (see routeAndExecute). */
  const preRoutedRef = useRef<RoutedIntent | null>(null);
  /** One-shot: variant chips / follow-ups plant a patch, the NEXT generation
   *  consumes it once. */
  const consumeOneShotPatch = (): IntentInput | null => {
    const patch = oneShotPatchRef.current;
    oneShotPatchRef.current = null;
    return patch;
  };
  const sessionSummary = producerSessionSummary();
  const [bounceBusy, setBounceBusy] = useState(false);
  // 🎤 TAKE card — the producer listens to the arrangement take: analyze the
  // longest clip (or the chosen one), show what was heard, apply key/tempo,
  // and feed the measured profile into the next SONG draft (bent sections +
  // pocket mix via compose vocal-wiring).
  const [takeProfile, setTakeProfile] = useState<VocalProfile | null>(null);
  const [takeBusy, setTakeBusy] = useState(false);
  // Bumped on project switch (effect above): an in-flight take analysis must
  // not install a stale profile after the switch cleared the card.
  const takeTokenRef = useRef(0);
  // The staged take's bank pointer (resolveVocalTake) — the ⭐ HOOK command
  // needs it to point the vocalchop track at the USER'S OWN take audio.
  const [takeRef, setTakeRef] = useState<{ bufferId: string } | null>(null);
  const [refGroove, setRefGroove] = useState<GrooveExtraction | null>(null);
  // Voice idea (Fázy 1+2): the artist hums/sings — patch carries their tempo
  // + key, humNotes become the LEAD of the SUNO MODE song.
  const [voiceIdea, setVoiceIdea] = useState<{
    notes: NoteEvent[];
    loopTicks: number;
    key: string | null;
    summary: string;
    harmonize?: boolean;
  } | null>(null);
  const [ideaRecording, setIdeaRecording] = useState(false);
  // Hum & harmonize — the SUNO build stacks the diatonic backing pair under
  // the hummed hook (one "Hum Harmony" track, one undo step with the song).
  const [ideaHarmonize, setIdeaHarmonize] = useState(false);
  // Take history for the comp strip — the last few analyzed takes with their
  // staged buffer ids, so the comp plan can compare AND assemble them.
  const [takeHistory, setTakeHistory] = useState<{ profile: VocalProfile; bufferId: string }[]>([]);
  const [compBusy, setCompBusy] = useState(false);
  const [ideaMicMonitor, setIdeaMicMonitor] = useState(false);
  const ideaRecorderRef = useRef<PcmMicRecorder | null>(null);
  const ideaBeatSyncRef = useRef(false);
  const ideaStartTickRef = useRef<number | null>(null);
  const ideaTransportRestoreRef = useRef<{ startedByIdea: boolean; metronomeBefore: boolean } | null>(null);
  const referenceInputRef = useRef<HTMLInputElement | null>(null);
  const clearReference = () => {
    setRefPatch(null);
    setRefSummary(null);
    setRefGroove(null);
    setVoiceIdea(null);
    setAudioReferenceConditioning(null);
    setMatchEqReference(null);
    setStatus("🎧 reference cleared — back to text-only intent");
  };
  // MATCH EQ ("znej ako ref"): measure the current pattern against the
  // retained reference and install the corrective curve on the master.
  const handleMatchEq = async () => {
    if (refBusy) return;
    setRefBusy(true);
    setStatus("🎯 matching the reference…");
    try {
      const curve = await computeMasterMatchEq(services.store.getDoc(), services.bank);
      if (!curve) {
        setError("🎯 match EQ: reference too short or render failed");
        return;
      }
      // Level half of the match: the reference's own BS.1770 loudness drives
      // the master trim (clamped ±6), alongside the tonal curve.
      const loudness = referenceLoudnessTrim();
      const command = applyMasterMatchEqCommand(services.store.getDoc(), curve, loudness?.trimDb);
      services.store.execute(command);
      const levelNote = loudness ? ` — reference sits at ${loudness.refLufs.toFixed(1)} LUFS` : "";
      setStatus(`🎯 ${command.label} — master matched to the reference${levelNote}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefBusy(false);
    }
  };
  // SNAP TO CHORDS (snap-to-chord-tone wave): deterministic post-process —
  // every lead-track note moves to the nearest chord-tone pitch of the
  // chords track. One undo; no re-render needed (pure document edit).
  const handleSnapToChords = () => {
    const doc = services.store.getDoc();
    const chordTrack = chordsTrackOf(doc);
    if (!chordTrack) {
      setError("🎹 snap to chords: no chords track in this project");
      return;
    }
    const leadTrack = doc.tracks.find(
      (track) =>
        track.kind === "instrument" &&
        track.id !== chordTrack.id &&
        doc.patterns.some((p) => p.notes[track.id]?.length),
    );
    if (!leadTrack) {
      setError("🎹 snap to chords: no melody track with notes");
      return;
    }
    try {
      const command = snapMelodyToChordsCommand(doc, leadTrack.id, chordTrack.id);
      services.store.execute(command);
      setStatus(`🎹 ${command.label}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReferenceFile = async (file: File | null) => {
    if (!file || refBusy) return;
    setRefBusy(true);
    setStatus("🎧 listening to the reference…");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const ctx = new AudioContext();
      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(arrayBuffer);
      } finally {
        await ctx.close();
      }
      const pcm = resampleLinear(downmixToMono(buffer), buffer.sampleRate, 16000);
      setMatchEqReference(pcm);
      const result = await analyzeAudioReference(pcm);
      if (!result) {
        setError("🎧 reference: audio models unavailable (fetch them or try later)");
        return;
      }
      const groove = extractGrooveGrid(pcm, 16000);
      setRefGroove(groove);
      setRefPatch(result.patch);
      setRefSummary(result.summary);
      setAudioReferenceConditioning(result.conditioning);
      setStatus(
        `🎧 reference: ${result.summary}${groove ? ` — groove ${groove.summary}` : ""} — patch + conditioning live`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefBusy(false);
    }
  };
  // Voice idea: record the artist humming/singing via MediaRecorder, decode,
  // then analyze — tempo + key become the patch, the hum becomes the LEAD.
  const restoreIdeaTransport = () => {
    const restore = ideaTransportRestoreRef.current;
    ideaTransportRestoreRef.current = null;
    if (!restore) return;
    if (restore.startedByIdea && services.transport.playing) services.playback.playPause();
    if (restore.startedByIdea || !services.transport.playing) {
      services.transport.setMetronome(restore.metronomeBefore);
    }
  };
  const teardownIdeaRecorder = async () => {
    const rec = ideaRecorderRef.current;
    ideaRecorderRef.current = null;
    if (rec) await rec.cancel().catch(() => undefined);
  };
  const setIdeaMicMonitoring = (enabled: boolean) => {
    setIdeaMicMonitor(enabled);
    ideaRecorderRef.current?.setMonitoring(enabled);
  };
  const startIdeaRecording = async () => {
    if (ideaRecording) return;
    try {
      services.engine.ensureContext();
      const ctx = services.engine.getLiveAudioContext();
      if (!ctx) {
        setError("🎤 audio engine not ready yet — try again in a second");
        return;
      }
      // Beat-synced hum: roll the transport first so there IS a beat to hum
      // to (pattern + click). Outside pattern playback: free-time fallback.
      const beatSync = services.playback.mode === "pattern" && typeof services.transport.position === "number";
      ideaBeatSyncRef.current = beatSync;
      ideaStartTickRef.current = null;
      ideaTransportRestoreRef.current = null;
      if (beatSync) {
        const startedByIdea = !services.transport.playing;
        ideaTransportRestoreRef.current = {
          startedByIdea,
          metronomeBefore: services.transport.metronome,
        };
        if (startedByIdea) {
          services.transport.setMetronome(true);
          services.playback.playPause();
        }
      }
      const docBpm = services.store.getDoc().bpm;
      const rec = new PcmMicRecorder({ ctx, recovery: services.recordingRecovery });
      ideaRecorderRef.current = rec;
      rec.setMonitoring(ideaMicMonitor);
      rec.onError = (message) => {
        setError(message);
        void teardownIdeaRecorder()
          .catch(() => undefined)
          .then(() => {
            restoreIdeaTransport();
            setIdeaRecording(false);
          });
      };
      await rec.start(() => {
        // Sample the transport tick as close to the first captured sample as
        // possible — the grid quantize absorbs the residue.
        if (beatSync) ideaStartTickRef.current = Math.max(0, services.transport.position);
        return {
          projectId: services.store.getDoc().id,
          trackId: "",
          trackName: "voice idea",
          placeOnTimeline: false,
          startBar: 0,
          bpm: docBpm,
        };
      });
      setIdeaRecording(true);
      const bpmNote = beatSync ? `the beat at ${docBpm} BPM` : "free time (nothing playing)";
      setStatus(`🎤 recording with ${bpmNote} — hum the hook, press stop`);
    } catch (err) {
      void teardownIdeaRecorder();
      restoreIdeaTransport();
      setError(`🎤 mic unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const stopIdeaRecording = async () => {
    if (!ideaRecording) return;
    setIdeaRecording(false);
    const rec = ideaRecorderRef.current;
    ideaRecorderRef.current = null;
    const startTick = ideaStartTickRef.current;
    const beatSync = ideaBeatSyncRef.current;
    ideaStartTickRef.current = null;
    restoreIdeaTransport();
    if (!rec) return;
    try {
      const take = await rec.stop();
      if (!take || take.buffer.length === 0) {
        setError("🎤 nothing was captured — check that the microphone is not muted");
        return;
      }
      try {
        await services.recordingRecovery.remove(take.session.id);
      } catch {
        /* recovery cleanup is best-effort */
      }
      const channel = take.buffer.getChannelData(0);
      const doc = services.store.getDoc();
      const activePattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
      const result = await analyzeVoiceIdea(channel, take.buffer.sampleRate, {
        ...(beatSync ? { bpm: doc.bpm } : {}),
        ...(beatSync && startTick !== null ? { transportStartTick: startTick } : {}),
        ...(beatSync && activePattern ? { patternLengthTicks: patternLengthTicks(activePattern) } : {}),
      });
      if (!result) {
        setError("🎤 idea: could not analyze the recording — try again, hum louder");
        return;
      }
      setRefPatch(result.patch);
      if (result.noteCount > 0) {
        setVoiceIdea({
          notes: result.notes,
          loopTicks: result.loopTicks,
          key: result.key,
          summary: result.summary,
          harmonize: ideaHarmonize,
        });
        setStatus(
          `🎤 idea: ${result.summary} — hook live${ideaHarmonize ? " + harmony stack" : ""}, ♪ SONG builds around it`,
        );
      } else {
        setVoiceIdea(null);
        setStatus(`🎤 idea: ${result.summary} — patch live (no steady melody detected)`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const toggleIdeaRecording = () => void (ideaRecording ? stopIdeaRecording() : startIdeaRecording());

  // Groove install: transcribed band hits become REAL rows on the active
  // pattern's drum track (one undo step).
  const installGroove = () => {
    if (!refGroove) return;
    const drumTrack = doc.tracks.find((track) => track.kind === "drum");
    if (!drumTrack || drumTrack.kind !== "drum" || drumTrack.pads.length === 0) {
      setError("🥁 groove: no drum track with pads in this project");
      return;
    }
    const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    if (!pattern) {
      setError("🥁 groove: no active pattern to install into");
      return;
    }
    const pads = drumTrack.pads.map((pad, index) => ({ id: pad.id, role: inferPadRole(pad.name, index) }));
    const rows = grooveRowsForPads(refGroove.hits, pads, refGroove.steps);
    services.store.execute(replacePatternInPlaceCommand(doc, pattern.id, { ...pattern, rows }));
    setStatus(`🥁 groove installed — ${refGroove.summary} (one undo step)`);
  };
  // Vocal-ready: loop the ACTIVE pattern with a click so the artist can
  // rehearse/record vocals over it; OFF restores transport to clean state.
  const toggleVocalMode = () => {
    const next = !vocalMode;
    setVocalMode(next);
    const activePattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    const ticks = activePattern ? patternLengthTicks(activePattern) : 16 * 120;
    if (next) {
      services.transport.setLoop(true, 0, ticks);
      services.transport.setMetronome(true);
      if (!services.transport.playing) services.playback.playPause();
      setStatus(`🎧 vocal mode — loop ${Math.round(ticks / 1920)} bars @ ${doc.bpm} BPM, click on. Spievaj!`);
    } else {
      if (services.transport.playing) services.playback.playPause();
      services.transport.setMetronome(false);
      services.transport.setLoop(false, 0, 0);
      setStatus("🎧 vocal mode off");
    }
  };
  // W3 "NAUČ SA MA" — fine-tune the personal melodic prior from the ★ ledger,
  // IN THE BROWSER, and install it only when the measured A/B proof beats the
  // shipped model. The status line is the honest report (installed / refused).
  const trainPersonalPrior = async () => {
    if (personalBusy) return;
    setPersonalBusy(true);
    setPersonalStatus("🧠 trénujem z tvojich ★…");
    try {
      const run = await runPersonalTrainingFromShipped();
      setPersonalStatus(run.summary);
      setStatus(run.installed ? `🧠 ${run.summary}` : `🧠 ${run.summary}`);
      if (run.ranker && run.ranker.groupCount > 0) {
        // The ranker preference groups are report-only here (offline retrain
        // consumes them via `npm run favorites:retrain`).
        setStatus((current) =>
          `${current ?? ""} · ranker pack: ${run.ranker!.groupCount} skupín pripravených na offline retrain`.trim(),
        );
      }
    } catch (err) {
      setPersonalStatus(`tréning zlyhal: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPersonalBusy(false);
    }
  };
  // Beat-only bounce: full pattern render WITHOUT the master chain — the raw
  // bed a vocalist wants to sing over (master squash fights the voice).
  const bounceBeatOnly = async () => {
    if (bounceBusy) return;
    setBounceBusy(true);
    try {
      const currentDoc = services.store.getDoc();
      setStatus("⬇ bouncing beat-only (no master chain)…");
      const buffer = await renderProject(currentDoc, services.bank, {
        mode: "pattern",
        sampleRate: 44100,
        tailSeconds: 1.5,
        masterProcessing: false,
      });
      downloadBlob(
        new Blob([encodeWav(buffer, 16)], { type: "audio/wav" }),
        `${sanitizeFilename(currentDoc.name)}-beat-only.wav`,
      );
      setStatus("✓ beat-only bounce — nahraj na tom hlas kdekoľvek");
    } catch (err) {
      setError(`bounce failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBounceBusy(false);
    }
  };
  // Analyze the arrangement take (longest clip) into a VocalProfile card.
  const analyzeTake = async () => {
    if (takeBusy) return;
    setTakeBusy(true);
    setError(null);
    const takeToken = takeTokenRef.current;
    try {
      const currentDoc = services.store.getDoc();
      const resolved = resolveVocalTake(currentDoc, services.bank, {});
      if (!resolved.ok) {
        setError(`🎤 take: ${resolved.error}`);
        return;
      }
      setStatus("🎤 listening to the take…");
      const outcome = await analyzeVocalTake(resolved.take.pcm, resolved.take.sampleRate, currentDoc.bpm);
      if (!outcome.ok) {
        setError(`🎤 analyze failed: ${outcome.error}`);
        return;
      }
      if (takeToken !== takeTokenRef.current) return; // project switched mid-analysis
      setTakeProfile(outcome.profile);
      setTakeRef({ bufferId: resolved.take.bufferId });
      setTakeHistory((history) =>
        [...history, { profile: outcome.profile, bufferId: resolved.take.bufferId }].slice(-3),
      );
      setStatus(`🎤 take heard — ${summarizeVocalProfile(outcome.profile).join(" · ")}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTakeBusy(false);
    }
  };
  const applyTakeKey = () => {
    if (!takeProfile?.keyMeasured) return;
    try {
      services.store.execute(applyVocalKeyCommand(services.store.getDoc(), takeProfile));
      setStatus(`✓ vocal key ${takeProfile.key} applied (one undo step)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const applyTakeHook = () => {
    if (!takeProfile || !takeRef) return;
    try {
      const cmd = applyVocalHookCommand(services.store.getDoc(), {
        bufferId: takeRef.bufferId,
        profile: takeProfile,
      });
      services.store.execute(cmd);
      setStatus(`⭐ ${cmd.label} — chopped from YOUR voice (one undo step)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const applyTakeTempo = (useAlt = false) => {
    if (!takeProfile?.tempoMeasured) return;
    try {
      services.store.execute(applyVocalTempoCommand(services.store.getDoc(), takeProfile, { useAlt }));
      const applied = useAlt ? takeProfile.tempoAltBpm : takeProfile.tempoBpm;
      setStatus(`✓ vocal tempo ${applied} BPM applied (one undo step)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const clearTake = () => {
    setTakeProfile(null);
    setTakeRef(null);
    setStatus("🎤 take cleared");
  };
  const buildSongDraft = async (sections?: SectionParse, reviseInput?: IntentInput) => {
    setError(null);
    setStatus(null);
    setBankResult(null);
    setJustApplied(false);
    stopAudition();
    setSongPlaying(false);
    setPlayingSectionId(null);
    songBufferRef.current = null;
    sectionBuffersRef.current = new Map();
    sectionTokenRef.current++;
    setSongRendering(false);
    // Guard token: a superseding build, DROP or USE during the awaits below
    // bumps songTokenRef and this run must not install a stale draft.
    const buildToken = ++songTokenRef.current;
    try {
      const baseDoc = services.store.getDoc();
      const intentInput = { ...briefInput, ...(refPatch ?? {}), ...briefFixes, ...(reviseInput ?? {}) };
      const globalFx = reviseInput?.fx ?? parseProductionIntent(sections?.remainingText ?? text);
      const result = await composeFullTrack(baseDoc, songTextRef.current || text, {
        ...(sections ? { sections } : {}),
        input: { ...intentInput, ...(globalFx ? { fx: globalFx } : {}) },
        ...(reviseInput?.seed ? { seed: reviseInput.seed } : {}),
        ...(voiceIdea
          ? {
              hum: {
                notes: voiceIdea.notes,
                loopTicks: voiceIdea.loopTicks,
                key: voiceIdea.key,
                ...(voiceIdea.harmonize ? { harmonize: true } : {}),
              },
            }
          : {}),
        ...(takeProfile?.measured ? { vocalProfile: takeProfile } : {}),
        bank: services.bank,
        candidateCount: 3,
        onProgress: (label) => setStatus(`⚡ SUNO MODE — ${label}`),
      });
      // Preview doc for the audition render only — nothing is applied yet.
      // Song command is whole-doc; mix is a delta — fold mix over the song
      // so the preview hears exactly what USE would install.
      let preview: ProjectDocument = result.commands.song.execute(baseDoc);
      if (result.commands.mix) {
        try {
          preview = result.commands.mix.execute(preview);
        } catch {
          /* garnish must not block the preview */
        }
      }
      if (songTokenRef.current !== buildToken) return;
      // FÁZA 6 loudness-in-preview: MEASURE ONLY — the trim becomes a
      // structured recommendation the user accepts explicitly (▶ hear it,
      // ✓ apply + re-render). Nothing auto-masters: the audition plays the
      // UNtrimmed preview and USE installs a trim only after confirmation.
      setStatus("⚡ SUNO MODE — loudness measure…");
      const loud = await measurePreviewLoudness(preview, services.bank, songTextRef.current || text);
      if (songTokenRef.current !== buildToken) return;
      const seconds = Math.round((result.build.totalBars * 4 * 60) / (result.build.resolvedBpm ?? 120));
      const lengthNote = ` ≈ ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      const mixNote = result.mixSummary ? ` · mix: ${result.mixSummary}` : "";
      const loudNote =
        loud.recommendedTrim !== null
          ? ` · 🔊 ${loud.measured ?? "?"} → cieľ ${loud.target} LUFS (návrh trim ${loud.recommendedTrim} dB — potvrď)`
          : loud.measured !== null
            ? ` · 🔊 ${loud.measured} LUFS (v cieli)`
            : "";
      setSongDraft({
        result,
        activeBuild: result.build,
        activeLane: null,
        previewReady: false,
        baseDoc,
        previewDoc: preview,
        mixNote,
        lengthNote,
        seconds,
        trimDb: loud.recommendedTrim ?? 0,
        loudnessTarget: loud.target,
        measuredBefore: loud.measured,
        measuredAfter: null,
        loudnessApplied: false,
        loudnessRecommendation: loud.recommendation,
        audioReview: null,
      });
      const fxNote = result.build.baseIntent.fx || result.build.sections.some((s) => s.fx) ? " + FX" : "";
      const skipNote = result.skipped.length > 0 ? ` (skipped: ${result.skipped.length})` : "";
      setStatus(
        `✓ SUNO MODE — ${result.build.name} — ${result.build.sections.length} sections, ${result.build.totalBars} bars${lengthNote}${fxNote}${mixNote}${loudNote}${skipNote} — ▶ to audition, USE to keep`,
      );
      // Background audition render — PLAY enables when done.
      const token = ++songTokenRef.current;
      setSongRendering(true);
      try {
        const buffer = await renderSongAuditionBuffer(services.bank, preview);
        if (songTokenRef.current !== token) return;
        songBufferRef.current = buffer;
        const audioReview = reviewSongAudio(buffer);
        setSongDraft((prev) => (prev && prev.result === result ? { ...prev, audioReview, previewReady: true } : prev));
        // Fáza 5 — per-section meters → evidence-based revival suggestions.
        const sectionMeters = analyzeSongSections(
          buffer,
          result.build.sections.map((section) => ({ role: section.role, bars: section.bars })),
          result.build.resolvedBpm ?? doc.bpm,
        );
        setSongSuggestions(suggestSectionRevivals(sectionMeters));
        // Free verify: measure what the preview actually plays.
        try {
          const channels: Float32Array[] = [];
          for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
          const reading = analyzeLoudnessBuffer(channels, buffer.sampleRate);
          if (reading.measured) {
            const after = Math.round(reading.integrated * 10) / 10;
            setSongDraft((prev) => (prev && prev.result === result ? { ...prev, measuredAfter: after } : prev));
          }
        } catch {
          /* display-only — the buffer still plays */
        }
      } catch (err) {
        if (songTokenRef.current === token) {
          setError(`song preview render failed: ${err instanceof Error ? err.message : String(err)} — USE still works`);
        }
      } finally {
        if (songTokenRef.current === token) setSongRendering(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const selectSongLane = async (lane: SearchLane | null) => {
    const draft = songDraft;
    if (!draft || songBusy || songRendering || (draft.activeLane === lane && draft.previewReady)) return;
    const alternative = lane ? draft.result.build.alternatives.find((candidate) => candidate.lane === lane) : null;
    if (lane !== null && !alternative) return;
    const activeBuild: SongBuild = alternative
      ? { ...draft.result.build, sections: alternative.sections }
      : draft.result.build;

    setError(null);
    songTokenRef.current++;
    const token = songTokenRef.current;
    sectionTokenRef.current++;
    stopAudition();
    setSongPlaying(false);
    setPlayingSectionId(null);
    setRenderingSectionId(null);
    songBufferRef.current = null;
    sectionBuffersRef.current = new Map();
    setSongRendering(true);
    setSongDraft((current) =>
      current?.result === draft.result
        ? { ...current, activeBuild, activeLane: lane, previewReady: false, measuredAfter: null, audioReview: null }
        : current,
    );

    try {
      // Re-compose the selected complete lane from the same immutable base.
      // The preview and later USE both execute this exact build plus mix.
      let preview = applySongCommand(draft.baseDoc, activeBuild).execute(draft.baseDoc);
      if (draft.result.commands.mix) {
        try {
          preview = draft.result.commands.mix.execute(preview);
        } catch {
          /* mix is optional garnish; the selected song remains auditionable */
        }
      }
      const loud = await measurePreviewLoudness(preview, services.bank, songTextRef.current || text);
      if (songTokenRef.current !== token) return;
      setSongDraft((current) =>
        current?.result === draft.result
          ? {
              ...current,
              activeBuild,
              activeLane: lane,
              previewDoc: preview,
              trimDb: loud.recommendedTrim ?? 0,
              loudnessTarget: loud.target,
              measuredBefore: loud.measured,
              measuredAfter: null,
              loudnessApplied: false,
              loudnessRecommendation: loud.recommendation,
              audioReview: null,
            }
          : current,
      );
      setStatus(
        `⚡ SUNO MODE — rendering ${lane ? `${lane.toUpperCase()} full-song direction` : "best-per-section song"}…`,
      );
      const buffer = await renderSongAuditionBuffer(services.bank, preview);
      if (songTokenRef.current !== token) return;
      songBufferRef.current = buffer;
      const audioReview = reviewSongAudio(buffer);
      let measuredAfter: number | null = null;
      try {
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
          buffer.getChannelData(channel),
        );
        const reading = analyzeLoudnessBuffer(channels, buffer.sampleRate);
        if (reading.measured) measuredAfter = Math.round(reading.integrated * 10) / 10;
      } catch {
        /* display-only — the rendered buffer remains valid for audition */
      }
      setSongDraft((current) =>
        current?.result === draft.result && current.activeBuild === activeBuild
          ? { ...current, audioReview, measuredAfter, previewReady: true }
          : current,
      );
      setStatus(
        `✓ ${lane ? lane.toUpperCase() : "BEST-PER-SECTION"} full-song preview ready — ${activeBuild.sections.length} sections, ${activeBuild.totalBars} bars. USE installs this exact arrangement.`,
      );
    } catch (err) {
      if (songTokenRef.current === token) {
        setError(
          `song direction preview failed: ${err instanceof Error ? err.message : String(err)} — retry this preview or select another direction`,
        );
      }
    } finally {
      if (songTokenRef.current === token) setSongRendering(false);
    }
  };
  const runSongBuild = async (sections?: SectionParse) => {
    songTextRef.current = text;
    await buildSongDraft(sections);
  };
  const generateSong = async () => {
    if ((!text.trim() && !activeProjectBrief) || songBusy || busy) return;
    if (rejectUnresolvedBriefConflicts()) return;
    setSongBusy(true);
    try {
      await runSongBuild(parseSectionRequests(text) ?? undefined);
    } finally {
      setSongBusy(false);
    }
  };
  // ─── SESSION THEATRE — NAJMI KAPELU ────────────────────────────────────
  // The theatre is a SUPERSET of the SUNO build: the same composeFullTrack
  // call, the same loudness measure, the SAME SongDraft shape — only the
  // orchestration differs (one producer at a time, flavored prompt + pinned
  // seed, blind A/B tournament on top). A take that wins the finále is
  // handed to songDraft verbatim, so USE/loudness/DO-IT-revision need zero
  // new code. Theatre takes are instrumental full-band sessions — hum and
  // vocal-profile conditioning stay in the direct ♪ SONG lane.
  const theatrePlaceholder = (run: TheatreRun): TheatreTake => ({
    run,
    draft: null,
    buffer: null,
    stage: 0,
    label: stageLabel(run, 0),
    failed: null,
  });
  const openTheatreBracket = (
    entries: TheatreTake[],
    firstIdx?: number,
  ): { a: number; b: number; queue: number[] } | null => {
    let ready = entries.map((take, i) => (take.buffer ? i : -1)).filter((i) => i >= 0);
    if (firstIdx !== undefined) ready = [firstIdx, ...ready.filter((i) => i !== firstIdx)];
    if (ready.length < 2) return null;
    return { a: ready[0], b: ready[1], queue: ready.slice(2) };
  };
  const runTheatreTake = async (
    baseDoc: ProjectDocument,
    run: TheatreRun,
    briefText: string,
    intentInput: IntentInput,
    onLabel: (label: string) => void,
  ): Promise<TheatreTake> => {
    const sections = parseSectionRequests(briefText);
    const globalFx = parseProductionIntent(sections?.remainingText ?? run.prompt);
    const result = await composeFullTrack(baseDoc, run.prompt, {
      ...(sections ? { sections } : {}),
      input: { ...intentInput, ...(globalFx ? { fx: globalFx } : {}) },
      seed: run.seed,
      bank: services.bank,
      candidateCount: 2,
      onProgress: onLabel,
    });
    // Preview doc for the audition render only — same fold as the SUNO build.
    let preview: ProjectDocument = result.commands.song.execute(baseDoc);
    if (result.commands.mix) {
      try {
        preview = result.commands.mix.execute(preview);
      } catch {
        /* garnish must not block the preview */
      }
    }
    onLabel(`${run.name}: loudness pass…`);
    const loud = await measurePreviewLoudness(preview, services.bank, briefText);
    const seconds = Math.round((result.build.totalBars * 4 * 60) / (result.build.resolvedBpm ?? 120));
    const draft: SongDraft = {
      result,
      activeBuild: result.build,
      activeLane: null,
      previewReady: false,
      baseDoc,
      previewDoc: preview,
      mixNote: result.mixSummary ? ` · mix: ${result.mixSummary}` : "",
      lengthNote: ` ≈ ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
      seconds,
      trimDb: loud.recommendedTrim ?? 0,
      loudnessTarget: loud.target,
      measuredBefore: loud.measured,
      measuredAfter: null,
      loudnessApplied: false,
      loudnessRecommendation: loud.recommendation,
      audioReview: null,
    };
    const take: TheatreTake = {
      run,
      draft,
      buffer: null,
      stage: run.stages.length - 1,
      label: `${run.name}: rendering audition…`,
      failed: null,
    };
    take.buffer = await renderSongAuditionBuffer(services.bank, preview);
    draft.previewReady = true;
    take.label = `${run.name}: ready`;
    return take;
  };
  const hireTheBand = async () => {
    if ((!text.trim() && !activeProjectBrief) || busy || songBusy || theatreBusy) return;
    if (rejectUnresolvedBriefConflicts()) return;
    stopAudition();
    setSongPlaying(false);
    setPlayingSectionId(null);
    setTheatrePlaying(null);
    setTheatreWinner(null);
    setTheatrePair(null);
    setTheatreRetake("");
    setSongDraft(null); // a hired band supersedes any standing SUNO draft
    songTokenRef.current++; // an in-flight SUNO build/render is superseded too
    songBufferRef.current = null; // the shared audition channel now belongs to the theatre
    const briefText = songTextRef.current || text;
    const baseDoc = services.store.getDoc();
    const intentInput = { ...briefInput, ...(refPatch ?? {}) };
    const plan = buildTheatrePlan({ brief: briefText });
    const token = ++theatreTokenRef.current;
    setTheatreBusy(true);
    setError(null);
    setJustApplied(false);
    setStatus(`🎬 SESSION THEATRE — ${plan.length} producentov berie tvôj brief…`);
    const current: TheatreTake[] = plan.map(theatrePlaceholder);
    setTheatre([...current]);
    try {
      for (let i = 0; i < plan.length; i++) {
        const run = plan[i];
        if (theatreTokenRef.current !== token) return;
        try {
          const take = await runTheatreTake(baseDoc, run, briefText, intentInput, (label) => {
            current[i] = { ...current[i], label, stage: Math.min(current[i].stage + 1, run.stages.length - 1) };
            setTheatre([...current]);
          });
          if (theatreTokenRef.current !== token) return;
          current[i] = take;
        } catch (err) {
          current[i] = {
            ...current[i],
            failed: err instanceof Error ? err.message : String(err),
            label: "session failed",
          };
        }
        setTheatre([...current]);
      }
      setTheatrePair(openTheatreBracket(current));
      setStatus(
        openTheatreBracket(current)
          ? "🎬 Kapela odohrala — SLEPÉ FINÁLE: prehraj Take A a Take B, hlasuj ktorý je lepší"
          : current.some((take) => take.buffer)
            ? "🎬 Kapela odohrala — jediný hotový take je pripravený"
            : "🎬 Kapela skončila — žiadny take sa nepodaril (pozri ⚠ na kartách)",
      );
    } finally {
      if (theatreTokenRef.current === token) setTheatreBusy(false);
    }
  };
  const playTheatreTake = (index: number) => {
    const take = theatre?.[index];
    if (!take?.buffer || theatreBusy) return;
    if (theatrePlaying === index) {
      stopAudition();
      setTheatrePlaying(null);
      return;
    }
    stopAudition();
    setSongPlaying(false);
    playAuditionBuffer(take.buffer, () => setTheatrePlaying(null));
    setTheatrePlaying(index);
  };
  const voteTheatre = (winnerIdx: number) => {
    if (!theatre || !theatrePair || theatreBusy) return;
    stopAudition();
    setTheatrePlaying(null);
    const [next, queue] = [theatrePair.queue[0], theatrePair.queue.slice(1)];
    if (next !== undefined) {
      setTheatrePair({ a: winnerIdx, b: next, queue });
      setStatus("🎬 Víťaz duelu postupuje — ďalšie slepé kolo");
      return;
    }
    // Finále: reveal the names and hand the winner to the normal USE flow.
    const take = theatre[winnerIdx];
    setTheatreWinner(winnerIdx);
    setTheatrePair(null);
    if (take.draft && take.buffer) {
      songBufferRef.current = take.buffer;
      setSongDraft(take.draft);
    }
    setStatus(`👑 Slepé finále: vyhral ${take.run.name} — draft dole: ▶ počúvaj, USE patrí tebe`);
  };
  const retakeTheatreWinner = async () => {
    const entries = theatre;
    if (!entries || theatreWinner === null || theatreBusy || busy || songBusy) return;
    const idx = theatreWinner;
    const persona = personaBySlug(entries[idx].run.producerSlug);
    if (!persona) return;
    const note = theatreRetake.trim();
    const version = (Number(/v(\d+)$/.exec(entries[idx].run.seed)?.[1] ?? 0) || 0) + 1;
    const [fresh] = buildTheatrePlan({
      brief: songTextRef.current || text,
      cast: [persona],
      interjections: note ? [{ producerSlug: persona.slug, note }] : [],
      retake: version,
    });
    const baseDoc = services.store.getDoc();
    const intentInput = { ...briefInput, ...(refPatch ?? {}) };
    const token = ++theatreTokenRef.current;
    setTheatreBusy(true);
    setError(null);
    stopAudition();
    setTheatrePlaying(null);
    setTheatreWinner(null);
    setTheatrePair(null);
    setSongDraft(null);
    songTokenRef.current++;
    songBufferRef.current = null;
    setStatus(`🎬 RETAKE — ${persona.name} ${note ? `berie pripomienku „${note}“` : "ide znova, nový draft"}…`);
    const current = entries.map((take, k) => (k === idx ? theatrePlaceholder(fresh) : take));
    setTheatre([...current]);
    try {
      try {
        const take = await runTheatreTake(baseDoc, fresh, songTextRef.current || text, intentInput, (label) => {
          current[idx] = { ...current[idx], label, stage: Math.min(current[idx].stage + 1, fresh.stages.length - 1) };
          setTheatre([...current]);
        });
        if (theatreTokenRef.current !== token) return;
        current[idx] = take;
      } catch (err) {
        current[idx] = {
          ...current[idx],
          failed: err instanceof Error ? err.message : String(err),
          label: "session failed",
        };
      }
      setTheatre([...current]);
      const bracket = openTheatreBracket(current, idx);
      setTheatrePair(bracket);
      setStatus(
        bracket
          ? "🎬 Retake hotový — SLEPÉ FINÁLE znova: nový take bráni ako Take A"
          : "🎬 Retake hotový — take je pripravený",
      );
    } finally {
      if (theatreTokenRef.current === token) setTheatreBusy(false);
    }
  };
  // Remix-DNA MUTATE — one click forks the CURRENT beat into a child project
  // (same seed family, small deterministic variation) and opens it. The
  // sibling counter keeps same-session children distinct; replaceDoc starts
  // a fresh undo history for the newborn (autosave persists it as its own
  // project). Stale previews reference the old doc, so they are dropped.
  const [mutateBusy, setMutateBusy] = useState(false);
  const mutateSiblingRef = useRef(0);
  const mutate = () => {
    if (busy || songBusy || mutateBusy) return;
    setMutateBusy(true);
    setError(null);
    try {
      const current = services.store.getDoc();
      const {
        doc: child,
        variedPatterns,
        lineage,
      } = mutateBeat(current, {
        amount: 0.1,
        sibling: mutateSiblingRef.current++,
        prompt: text.trim() || null,
      });
      stopAudition();
      songTokenRef.current++;
      sectionTokenRef.current++;
      setSongRendering(false);
      setPlayingIndex(null);
      setBankResult(null);
      setSongDraft(null);
      setSongSuggestions([]);
      songBufferRef.current = null;
      services.store.replaceDoc(child);
      setStatus(
        `🧬 Mutate #${lineage.depth} — child of "${current.name}" · ${variedPatterns} patterns varied · same seed family. Tweak + GENERATE, or publish it.`,
      );
      setJustApplied(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutateBusy(false);
    }
  };
  const toggleSongAudition = () => {
    if (songPlaying) {
      stopAudition();
      setSongPlaying(false);
      return;
    }
    const buffer = songBufferRef.current;
    if (!buffer) return;
    // Full-song and section auditions share one playback channel.
    setPlayingSectionId(null);
    playAuditionBuffer(buffer, () => setSongPlaying(false));
    setSongPlaying(true);
    setStatus(`▶ auditioning full song — ${songDraft?.activeBuild.sections.length ?? 0} sections`);
  };
  const toggleSectionAudition = async (section: SongBuildSection) => {
    if (!songDraft) return;
    const id = section.pattern.id;
    if (playingSectionId === id) {
      stopAudition();
      setPlayingSectionId(null);
      return;
    }
    stopAudition();
    setSongPlaying(false);
    const token = ++sectionTokenRef.current;
    setRenderingSectionId(id);
    try {
      let buffer = sectionBuffersRef.current.get(id);
      if (!buffer) {
        buffer = await renderAuditionBuffer(
          songDraft.baseDoc,
          services.bank,
          section.pattern,
          section.fx ?? songDraft.activeBuild.baseIntent.fx ?? null,
        );
        sectionBuffersRef.current.set(id, buffer);
      }
      if (sectionTokenRef.current !== token) return;
      playAuditionBuffer(buffer, () => setPlayingSectionId(null));
      setPlayingSectionId(id);
      setStatus(`▶ auditioning ${section.label} (${section.bars} bars · ${section.roles.join("+")})`);
    } catch (err) {
      if (sectionTokenRef.current === token) {
        setError(`section preview failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (sectionTokenRef.current === token) setRenderingSectionId(null);
    }
  };
  // FÁZA 6 — the loudness trim is a RECOMMENDATION: ▶ you heard the
  // untrimmed preview; ✓ applies the trim to the preview doc and re-renders
  // the audition so preview == USE stays true; ✗ (or no answer) installs
  // nothing. setMasterConfig is a real command — USE carries it as one undo.
  const acceptLoudnessTrim = async () => {
    const draft = songDraft;
    if (!draft || draft.loudnessApplied || !draft.trimDb) return;
    const trimmed = setMasterConfig(draft.previewDoc, { loudnessTrimDb: draft.trimDb }).execute(draft.previewDoc);
    setSongDraft((current) =>
      current?.result === draft.result ? { ...current, previewDoc: trimmed, loudnessApplied: true } : current,
    );
    const token = ++songTokenRef.current;
    setSongRendering(true);
    try {
      const buffer = await renderSongAuditionBuffer(services.bank, trimmed);
      if (songTokenRef.current !== token) return;
      songBufferRef.current = buffer;
      const audioReview = reviewSongAudio(buffer);
      let measuredAfter: number | null = null;
      try {
        const channels: Float32Array[] = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
        const reading = analyzeLoudnessBuffer(channels, buffer.sampleRate);
        if (reading.measured) measuredAfter = Math.round(reading.integrated * 10) / 10;
      } catch {
        /* display-only — the trimmed buffer still plays */
      }
      setSongDraft((current) =>
        current?.result === draft.result ? { ...current, audioReview, measuredAfter, previewReady: true } : current,
      );
      setStatus(`🔊 trim ${draft.trimDb} dB prijatý — náhľad prehráva trimnutú verziu, USE ju nainštaluje`);
    } catch (err) {
      if (songTokenRef.current === token) {
        setError(`trimnutý náhľad zlyhal: ${err instanceof Error ? err.message : String(err)} — trim ostáva prijatý`);
      }
    } finally {
      if (songTokenRef.current === token) setSongRendering(false);
    }
  };
  const declineLoudnessTrim = () => {
    setSongDraft((current) => (current ? { ...current, loudnessApplied: false, trimDb: 0 } : current));
    setStatus("Trim neprijatý — USE nainštaluje netrimnutú verziu.");
  };
  const discardSongDraft = () => {
    songTokenRef.current++;
    sectionTokenRef.current++;
    stopAudition();
    setSongRendering(false);
    setSongPlaying(false);
    setPlayingSectionId(null);
    songBufferRef.current = null;
    sectionBuffersRef.current = new Map();
    setSongDraft(null);
    setSongSuggestions([]);
    setStatus("Song draft discarded — nothing applied.");
  };
  const useSongDraft = async () => {
    if (!songDraft || songBusy || songRendering || (songDraft.activeLane !== null && !songDraft.previewReady)) return;
    songTokenRef.current++;
    sectionTokenRef.current++;
    stopAudition();
    setSongPlaying(false);
    setPlayingSectionId(null);
    setSongBusy(true);
    try {
      // Fresh commands against the CURRENT doc — a draft may sit open while
      // the user keeps editing; rebasing keeps undo correct.
      const current = services.store.getDoc();
      const songCmd = applySongCommand(current, songDraft.activeBuild);
      services.store.execute(songCmd);
      let afterSong = services.store.getDoc();
      // P4 preview==USE: the audition rendered the COMPOSED mix, so install
      // exactly that while the doc is untouched since the draft (same track
      // resolution, zero re-planning). After interim edits, re-plan against
      // the current doc so new tracks are covered (rebase).
      const draftUntouched = current === songDraft.baseDoc;
      const composedMix = draftUntouched ? songDraft.result.commands.mix : null;
      let rebased = !draftUntouched;
      try {
        if (composedMix) {
          services.store.execute(composedMix);
        } else {
          const profile = planMixProfile(songDraft.activeBuild.baseIntent);
          const mixCmd = applyMixIntent(afterSong, profile);
          services.store.execute(mixCmd);
        }
        afterSong = services.store.getDoc();
      } catch {
        /* no mix decisions — song alone is complete */
      }
      // Stored preview trim — no re-render: USE installs exactly what the
      // audition played. After interim edits the mix was re-planned, so the
      // trim is an estimate carried from the preview (flagged honestly).
      let loudnessNote = "";
      if (songDraft.loudnessApplied) {
        try {
          services.store.execute(setMasterConfig(services.store.getDoc(), { loudnessTrimDb: songDraft.trimDb }));
          const sign = songDraft.trimDb >= 0 ? "+" : "";
          const heard = songDraft.measuredAfter ?? songDraft.measuredBefore ?? "?";
          loudnessNote = ` — loudness ≈${heard} LUFS (trim ${sign}${songDraft.trimDb} dB${
            rebased ? ", from preview" : ""
          })`;
        } catch {
          /* master trim is garnish — the song stands without it */
        }
      }
      const fxNote =
        songDraft.activeBuild.baseIntent.fx || songDraft.activeBuild.sections.some((s) => s.fx) ? " + FX" : "";
      songBufferRef.current = null;
      sectionBuffersRef.current = new Map();
      setSongDraft(null);
      setSongSuggestions([]);
      setJustApplied(true);
      setStatus(
        `✓ SUNO MODE — ${songDraft.activeBuild.name} — ${songDraft.activeBuild.sections.length} sections, ${songDraft.activeBuild.totalBars} bars${songDraft.lengthNote}${fxNote}${songDraft.mixNote}${rebased ? " · mix re-planned after edits" : ""}${loudnessNote} — Tip: "make bridge more energetic" + ⚡ DO IT revises one section.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSongBusy(false);
    }
  };
  // Global draft revise — same seed, shifted content slider. The song keeps
  // its identity (sections, seeds, form), only the character moves. Runs as
  // a fresh draft build so the user can still audition before USE.
  const reviseSongDraft = async (attribute: "energy" | "density", delta: number) => {
    if (!songDraft || songBusy) return;
    const base = songDraft.activeBuild.baseIntent;
    const fallback = attribute === "energy" ? 0.7 : 0.5;
    const current = typeof base[attribute] === "number" ? (base[attribute] as number) : fallback;
    const next = Math.max(0, Math.min(1, current + delta));
    setSongBusy(true);
    try {
      await buildSongDraft(parseSectionRequests(songTextRef.current) ?? undefined, {
        ...base,
        [attribute]: next,
        seed: base.seed,
      });
      setStatus(
        `⚡ song ${attribute} ${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)} — same seed, audition before USE`,
      );
    } finally {
      setSongBusy(false);
    }
  };

  // D3 unified bar: route the text to the right executor — arrange ops,
  // mix profile, or (default) candidate generation.
  const [routeBusy, setRouteBusy] = useState(false);
  const [selectedStepPreview, setSelectedStepPreview] = useState<SelectedStepPromptPreview | null>(null);
  const [selectedArrangementPreview, setSelectedArrangementPreview] = useState<SelectedArrangementPromptPreview | null>(
    null,
  );
  const [rangeConsolidating, setRangeConsolidating] = useState(false);
  // `prompt` rides along for MINING only (which ask produced these chips) —
  // the diagnosis path leaves it unset; picked chips log against it.
  const [clarify, setClarify] = useState<{ reason: string; suggestions: string[]; prompt?: string } | null>(null);
  const loudnessBusyRef = useRef(false);
  // VOICE CAPTURE (pipeline [A], docs/LOCAL-INTENT-MODEL.md §6): the mic tap
  // fills the intent BAR — the transcript is text the user sees and edits
  // before anything routes. No auto-execution, by design.
  const voiceCaptureRef = useRef<ReturnType<typeof createVoiceCapture> | null>(null);
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");

  const applySelectedStepPromptPreview = () => {
    const preview = selectedStepPreview;
    if (!preview) return;
    const currentDoc = services.store.getDoc();
    const currentPattern = currentDoc.patterns.find((candidate) => candidate.id === preview.pattern.id);
    const currentDrumTrack = currentDoc.tracks.find(
      (track): track is DrumTrack => track.kind === "drum" && track.id === preview.drumTrack.id,
    );
    const currentSelection = selection.getState().stepSelection;
    const currentIntent = parseSelectedStepIntent(text);
    const sameSelection = Boolean(
      currentSelection &&
      currentSelection.from === preview.selection.from &&
      currentSelection.to === preview.selection.to &&
      currentSelection.padIds.length === preview.selection.padIds.length &&
      currentSelection.padIds.every((padId, index) => padId === preview.selection.padIds[index]),
    );
    if (
      text.trim() !== preview.source ||
      currentDoc.activePatternId !== preview.pattern.id ||
      currentPattern !== preview.pattern ||
      currentDrumTrack !== preview.drumTrack ||
      !sameSelection ||
      currentIntent?.operation !== preview.intent.operation ||
      currentIntent?.target !== preview.intent.target ||
      currentIntent?.reason !== preview.intent.reason ||
      !preview.plan.scope
    ) {
      setSelectedStepPreview(null);
      setError("Project, prompt, or step selection changed — run DO IT again to review a fresh preview.");
      return;
    }

    try {
      const command =
        preview.intent.operation === "thin"
          ? assistThinSelectionCommand(currentDoc, preview.pattern.id, preview.drumTrack.id, preview.plan.scope)
          : assistVarySelectionCommand(
              currentDoc,
              preview.pattern.id,
              preview.drumTrack.id,
              preview.plan.scope,
              preview.seed,
              preview.amount,
            );
      services.store.execute(command);
      setSelectedStepPreview(null);
      setJustApplied(false);
      setError(null);
      setStatus(`✓ ${command.label} (one undo step)`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const applySelectedArrangementPromptPreview = async () => {
    const preview = selectedArrangementPreview;
    if (!preview) return;
    const currentDoc = services.store.getDoc();
    if (preview.kind === "clip") {
      const currentClipSelection = selection.getState().clipIds;
      const liveClip = currentDoc.arrangement.clips.find((clip) => clip.id === preview.clip.id);
      const currentOps = parseSelectedClipArrangeIntent(preview.source, currentDoc, preview.clip.id);
      const hasGrooveEdit = preview.ops.some((op) => op.op === "clipGroove");
      const livePatternHash = hasGrooveEdit && liveClip ? selectedClipPatternHash(currentDoc, liveClip) : undefined;
      if (
        text.trim() !== preview.source ||
        currentClipSelection.length !== 1 ||
        currentClipSelection[0] !== preview.clip.id ||
        !liveClip ||
        liveClip.sceneId !== preview.clip.sceneId ||
        liveClip.startBar !== preview.clip.startBar ||
        liveClip.lengthBars !== preview.clip.lengthBars ||
        (hasGrooveEdit && livePatternHash !== preview.sourcePatternHash) ||
        !currentOps ||
        JSON.stringify(currentOps) !== JSON.stringify(preview.ops)
      ) {
        setSelectedArrangementPreview(null);
        setError("Project, prompt, or clip selection changed — run DO IT again to review a fresh preview.");
        return;
      }
      try {
        const command = applyClipArrangeOps(currentDoc, currentOps);
        if (!command) {
          setError("The selected clip is no longer available.");
          return;
        }
        services.store.execute(command);
        if (currentOps.some((op) => op.op === "deleteClip")) {
          const updated = services.store.getDoc();
          selection.retainClips([
            ...updated.arrangement.clips.map((clip) => clip.id),
            ...(updated.arrangement.audioClips ?? []).map((clip) => clip.id),
          ]);
        }
        setSelectedArrangementPreview(null);
        setJustApplied(false);
        setError(null);
        setStatus(`✓ ${command.label} (one undo step)`);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const currentRange = selection.getState().timeRange;
    const currentOperation = parseSelectedTimeRangeIntent(preview.source);
    if (
      text.trim() !== preview.source ||
      !currentRange ||
      currentRange.fromTick !== preview.range.fromTick ||
      currentRange.toTick !== preview.range.toTick ||
      currentOperation !== preview.operation
    ) {
      setSelectedArrangementPreview(null);
      setError("Project, prompt, or time selection changed — run DO IT again to review a fresh preview.");
      return;
    }
    const rangeError = selectedTimeRangeIntentError(currentDoc, preview.range, preview.operation);
    if (rangeError) {
      setSelectedArrangementPreview(null);
      setError(rangeError);
      return;
    }
    if (preview.operation === "consolidate") {
      setRangeConsolidating(true);
      try {
        const command = await consolidateRangeToAudio(services, preview.range, () => {
          const liveRange = selection.getState().timeRange;
          return (
            promptInputRef.current?.value.trim() === preview.source &&
            liveRange != null &&
            liveRange.fromTick === preview.range.fromTick &&
            liveRange.toTick === preview.range.toTick &&
            parseSelectedTimeRangeIntent(promptInputRef.current?.value ?? "") === "consolidate"
          );
        });
        setSelectedArrangementPreview(null);
        setJustApplied(false);
        setError(null);
        setStatus(`✓ ${command.label} (one undo step)`);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        setRangeConsolidating(false);
      }
      return;
    }
    try {
      const command = duplicateTimeRange(currentDoc, preview.range.fromTick, preview.range.toTick);
      services.store.execute(command);
      setSelectedArrangementPreview(null);
      setJustApplied(false);
      setError(null);
      setStatus(`✓ ${command.label} (one undo step)`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleVoiceCapture = async () => {
    if (voiceState === "recording") {
      setVoiceState("transcribing");
      const capture = voiceCaptureRef.current;
      const transcript = capture ? await capture.stopAndTranscribe() : null;
      setVoiceState("idle");
      if (transcript == null) {
        setError("hlas sa nepodarilo prepísať — skús znova alebo píš");
        return;
      }
      replacePrompt(transcript, true);
      setStatus(`🎙 ${transcript}`);
      return;
    }
    // W0.3 (killer-feature plan): prefer the browser-native Web Speech
    // recognizer when the browser has one (Chrome/Edge) — zero download,
    // live transcription, no 1.2 GB Whisper fetch. The PCM capture +
    // Whisper path stays as the fallback (Firefox/Safari = today's state,
    // honestly reported). Both satisfy the same capture contract, and the
    // transcript is a TEXT SOURCE either way: it lands in the intent bar
    // where the user sees and edits it before anything routes.
    const webSpeech = isWebSpeechSupported() ? createWebSpeechCapture(navigator.language || "en-US") : null;
    if (webSpeech) {
      const started = await webSpeech.start();
      if (started) {
        voiceCaptureRef.current = webSpeech;
        setVoiceState("recording");
        setStatus("🎙 nahrávam (prehliadačová reč)… znova klikni pre stop + prepis");
        return;
      }
      // start() failed (mic denied) — fall through to the PCM path, whose
      // getUserMedia error is the clearer report.
    }
    const capture = createVoiceCapture();
    const started = await capture.start();
    if (!started) {
      setError("mikrofón nie je dostupný — povoľ prístup v prehliadači");
      return;
    }
    voiceCaptureRef.current = capture;
    setVoiceState("recording");
    setStatus("🎙 nahrávam… znova klikni pre stop + prepis");
  };
  // `override` lets the clarification chips re-run the router against a
  // suggested phrasing in the same tick (React state would still be stale).
  const routeAndExecute = async (override?: string) => {
    const source = (override ?? text).trim();
    if (!source || routeBusy) return;
    setRouteBusy(true);
    setSelectedStepPreview(null);
    setSelectedArrangementPreview(null);
    setError(null);
    setJustApplied(false);
    setClarify(null);
    try {
      // Pre-routed entry: the local-model fallback (below) re-enters with an
      // adapted route so the big dispatch chain runs exactly once.
      const routeSelection = selection.getState();
      const route =
        preRoutedRef.current ??
        routeIntentText(source, doc, {
          hasSelectedStepSelection: Boolean(routeSelection.stepSelection),
          selectedClipId: routeSelection.clipIds.length === 1 ? routeSelection.clipIds[0] : null,
          selectedRange: routeSelection.timeRange,
        });
      preRoutedRef.current = null;
      if (route.kind === "revise" && rejectUnresolvedBriefConflicts()) return;
      if (lastGeneration() && resolveProducerFollowUp(source, lastGeneration()?.intent ?? null)) {
        const followUp = resolveProducerFollowUp(source, lastGeneration()?.intent ?? null)!;
        const merged: IntentInput = {
          ...(lastGeneration()?.intent ?? {}),
          ...(parsed?.input ?? {}),
          ...followUp.patch,
        };
        oneShotPatchRef.current = merged;
        setStatus(`🎛 session follow-up — ${followUp.reroll ? "reroll" : "modifikátor live"}`);
        await generate();
        return;
      }
      // DESTRUCTIVE-INTENT CHECKPOINT (signal-flow audit re-run): removeTrack
      // / deleteClip / scene-remove / effect-remove execute immediately — the
      // bounded undo stack evicts the pre-delete state in a long session, so
      // a durable checkpoint is saved first (same database the MCP agent
      // checkpoints use). Undo stays the primary recovery; "restore
      // checkpoint" is the second net.
      let checkpointNote = "";
      if (routeIsDestructive(route)) {
        const cpName = destructiveCheckpointName(route);
        await saveIntentCheckpoint(cpName, doc);
        checkpointNote = ` · 🛟 checkpoint '${cpName}'`;
      }
      if (route.kind === "transport") {
        // Bare-word transport commands — runtime SERVICE state, not document
        // state: dispatch is the whole operation, nothing to undo.
        if (route.action === "play") {
          stopAudition();
          services.transport.play();
          setStatus("⚡ transport: play");
        } else if (route.action === "pause") {
          services.transport.pause();
          setStatus("⚡ transport: pause");
        } else if (route.action === "stop") {
          stopAudition();
          services.transport.stop();
          setStatus("⚡ transport: stop");
        } else if (route.action === "metronomeOn") {
          services.transport.setMetronome(true);
          setStatus("⚡ metronome on");
        } else if (route.action === "loopOn") {
          // Preserve the existing loop range; a fresh project has none, so
          // loop the first 4 bars (4/4 at PPQ 480) as the bounded default.
          const t = services.transport;
          const end = t.loopEnd > t.loopStart ? t.loopEnd : t.loopStart + 4 * 4 * PPQ;
          t.setLoop(true, t.loopStart, end);
          setStatus(`⚡ loop on [${t.loopStart}–${end}]`);
        } else if (route.action === "loopOff") {
          services.transport.setLoop(false, 0, 0);
          setStatus("⚡ loop off");
        } else {
          // metronomeOff — the only remaining TransportAction
          services.transport.setMetronome(false);
          setStatus("⚡ metronome off");
        }
      } else if (route.kind === "save") {
        // "save" — flush the autosave lifecycle. Persistence side-effect,
        // not document state; the save status reports the honest result.
        try {
          await services.flushSave();
          setStatus(`✓ saved (${services.store.getSaveStatus()})`);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } else if (route.kind === "export") {
        // "export wav" / "export mp3" — the shared quick-bounce pipeline
        // (also what the MCP kyx_export tool drives). Async, cancellable by
        // re-routing.
        stopAudition();
        const fmt = route.format;
        setStatus(`⏳ exporting ${fmt.toUpperCase()}…`);
        try {
          setStatus(`✓ ${await quickBounceDownload(doc, services.bank, { format: fmt })}`);
        } catch (err) {
          setError(err instanceof Error ? `export failed: ${err.message}` : String(err));
        }
      } else if (route.kind === "record") {
        // "record" / "stop recording" — arm/disarm the pattern recorder.
        // Runtime service state: arming is the operation; takes land through
        // the recorder's own ONE-undo-frame lifecycle.
        services.patternRecorder.setArmed(route.arm);
        setStatus(route.arm ? "⏺ REC armed — play to lay it in, stop ends the take" : "⏹ recording disarmed");
      } else if (route.kind === "complaintIntent") {
        // LISTENING LOOP (Phase C): complaint → measured diagnosis →
        // executable bounded proposals as verified chips. Nothing mutates
        // until a chip is picked (audition-first by construction).
        stopAudition();
        const meters: SongSectionMeter[] = [];
        const diagnosis = diagnoseComplaint(route.intent, meters);
        if (diagnosis == null) {
          setError("complaint sa nepodarilo vyhodnotiť");
          return;
        }
        const verified = diagnosis.proposals
          .map((proposal) => proposal.instruction)
          .filter((instruction) => {
            const probe = routeIntentText(instruction, doc);
            return probe.kind !== "pattern" && probe.kind !== "clarify";
          });
        setClarify({
          reason: `Diagnóza: ${diagnosis.diagnosis}${diagnosis.measurement ? ` — ${diagnosis.measurement}` : ""}`,
          suggestions: verified,
        });
        setStatus(`👂 ${diagnosis.diagnosis}${diagnosis.measurement ? ` — ${diagnosis.measurement}` : ""}`);
      } else if (route.kind === "undoIntent") {
        // SESSION CONTROL — undo/redo through the store. A live mic take
        // pins the stack: rewinding under a recording would corrupt its
        // undo frame (Audit 09 lesson), so the ask is declined honestly.
        if (route.intent.kind === "undo") {
          if (isMicRecordingActive()) {
            setError("nahrávka beží — undo až po stop");
            return;
          }
          // Honest counting (audit re-run): report what ACTUALLY undid — the
          // old text echoed the requested step count even when the stack ran
          // out (or a command's undo threw) after fewer steps.
          let done = 0;
          let failure: string | null = null;
          const labels: string[] = [];
          for (let i = 0; i < route.intent.steps; i++) {
            const before = services.store.undoStackLength;
            try {
              services.store.undo();
            } catch (err) {
              failure = err instanceof Error ? err.message : String(err);
              break;
            }
            if (services.store.undoStackLength === before) break;
            done += 1;
            labels.unshift(services.store.lastCommandLabel ?? "");
          }
          const labelPart = labels.length > 0 ? ` — ${labels.filter(Boolean).join(" · ")}` : "";
          const shortfall = done < route.intent.steps ? ` (${done}/${route.intent.steps} possible)` : "";
          const failPart = failure ? ` — step failed: ${failure}` : "";
          setStatus(`↩ undone ${done} step(s)${shortfall}${labelPart}${failPart}`);
        } else {
          let done = 0;
          let failure: string | null = null;
          for (let i = 0; i < route.intent.steps; i++) {
            const before = services.store.undoStackLength;
            try {
              services.store.redo();
            } catch (err) {
              failure = err instanceof Error ? err.message : String(err);
              break;
            }
            if (services.store.undoStackLength === before) break;
            done += 1;
          }
          const shortfall = done < route.intent.steps ? ` (${done}/${route.intent.steps} possible)` : "";
          const failPart = failure ? ` — step failed: ${failure}` : "";
          setStatus(`↪ redone ${done} step(s)${shortfall}${failPart}`);
        }
      } else if (route.kind === "checkpointIntent") {
        // Safety-net restore: brings back the state the destructive-intent
        // checkpoint captured. One undoable snapshot — the restore itself
        // can be undone.
        const restored = await restoreIntentCheckpoint(doc.id, route.intent.name ?? undefined);
        if (!restored) {
          setError("no checkpoint found — destructive intents save one automatically");
          return;
        }
        const command = snapshot("restoreIntentCheckpoint", `Restore checkpoint '${restored.name}'`, doc, restored.doc);
        services.store.execute(command);
        setStatus(`↻ checkpoint '${restored.name}' restored — one undo step returns back`);
      } else if (route.kind === "queryIntent") {
        // READ-ONLY queries — answers from the current doc + store history,
        // never a mutation.
        const d = services.store.getDoc();
        const q = route.intent;
        if (q.subject === "lastAction") {
          const entry = services.store.history[services.store.history.length - 1];
          setStatus(entry ? `⚙ last action: ${entry.label}` : "žiadna akcia v tejto relácii");
        } else if (q.subject === "tempo") {
          setStatus(
            `⏱ ${d.bpm} BPM · ${d.key ?? "key unset"} · ${d.timeSignature.numerator}/${d.timeSignature.denominator}`,
          );
        } else if (q.subject === "key") {
          setStatus(`🎼 ${d.key ?? "key unset"}`);
        } else if (q.subject === "tracks") {
          setStatus(`🎚 ${d.tracks.length} tracks: ${d.tracks.map((t) => t.name).join(", ")}`);
        } else if (q.subject === "markers") {
          setStatus(
            d.markers.length > 0
              ? `📍 ${d.markers.map((m) => `${m.name}@${Math.round(m.tick / 480 / 4) + 1}`).join(", ")}`
              : "žiadne markery",
          );
        } else if (q.subject === "groove") {
          setStatus(`🥁 ${grooveReadback(d) || "groove neutrálny"}`);
        } else {
          const named = q.target;
          const tracks = d.tracks.filter((t) => {
            if (t.kind === "group") return false;
            const inst = t.kind === "instrument" ? t.instrument : "";
            if (named != null) {
              return (
                (["bass", "808", "logdrum"].includes(inst) && named === "bass") ||
                (inst === "keys" && named === "chords") ||
                new RegExp(`${named}`, "i").test(t.name)
              );
            }
            return true;
          });
          const lines = tracks.map((t) => {
            const chain = t.effects.map((fx) => `${fx.type}${fx.bypassed ? " (bypassed)" : ""}`).join(", ");
            return `${t.name}: ${chain || "no FX"}`;
          });
          setStatus(`🎛 ${lines.slice(0, 6).join(" · ") || "žiadne FX"}`);
        }
      } else if (route.kind === "sectionGrooveIntent") {
        // "more swing in the drop" — the swing DELTA baked into the section
        // pattern's odd 16ths (microtiming), one undo step.
        const command = applySectionGrooveIntent(doc, route.intent);
        if (!command) {
          setError(`no pattern for the "${route.intent.role}" section`);
          return;
        }
        services.store.execute(command);
        setStatus(`🥁 ${command.label} (one undo step)`);
      } else if (route.kind === "selectedStepAssist") {
        const currentDoc = services.store.getDoc();
        const selected = selection.getState().stepSelection;
        const pattern = currentDoc.patterns.find((candidate) => candidate.id === currentDoc.activePatternId) ?? null;
        const drumTrack =
          selected && selected.padIds.length > 0
            ? (currentDoc.tracks.find(
                (track): track is DrumTrack =>
                  track.kind === "drum" && selected.padIds.every((padId) => track.pads.some((pad) => pad.id === padId)),
              ) ?? null)
            : null;
        const selectionSnapshot = selected
          ? { padIds: [...selected.padIds], from: selected.from, to: selected.to }
          : null;
        const selectedRows =
          pattern && selectionSnapshot
            ? selectionSnapshot.padIds.map((padId) => `${padId}:${(pattern.rows[padId] ?? []).join(",")}`).join("|")
            : "no-valid-pattern";
        const amount = 0.6;
        const seed = `producer-step-${hashString(
          `${pattern?.id ?? "missing"}|${route.intent.operation}|${route.intent.target ?? "all"}|${
            selectionSnapshot?.from ?? "?"
          }:${selectionSnapshot?.to ?? "?"}|${selectedRows}`,
        ).toString(36)}`;
        const plan = planSelectedStepInstruction({
          text: source,
          pattern,
          drumTrack,
          selection: selectionSnapshot,
          seed,
          amount,
          bars: 4,
          target: route.intent.target ?? "hats",
          style: "house",
        });
        if (
          plan.error ||
          !plan.scope ||
          !pattern ||
          !drumTrack ||
          !selectionSnapshot ||
          plan.intent?.operation !== route.intent.operation ||
          plan.intent?.target !== route.intent.target ||
          plan.intent?.reason !== route.intent.reason
        ) {
          setError(plan.error ?? "Could not prepare a safe selected-step preview.");
          return;
        }
        setSelectedStepPreview({
          source,
          intent: route.intent,
          pattern,
          drumTrack,
          selection: selectionSnapshot,
          plan,
          seed,
          amount,
        });
        setStatus("Preview ready — inspect the exact selected-cell changes, then apply or cancel.");
      } else if (route.kind === "selectedClipArrange") {
        const currentDoc = services.store.getDoc();
        const currentClipSelection = selection.getState().clipIds;
        const clip = currentDoc.arrangement.clips.find((candidate) => candidate.id === route.clipId);
        const ops = clip ? parseSelectedClipArrangeIntent(source, currentDoc, clip.id) : null;
        if (
          currentClipSelection.length !== 1 ||
          currentClipSelection[0] !== route.clipId ||
          !clip ||
          !ops ||
          JSON.stringify(ops) !== JSON.stringify(route.ops)
        ) {
          setError("The selected clip changed or the request no longer resolves. Review the selection and try again.");
          return;
        }
        const grooveOp = ops.find((op): op is Extract<ClipArrangeOp, { op: "clipGroove" }> => op.op === "clipGroove");
        if (grooveOp && selectedClipGrooveChangeCount(currentDoc, clip.id, grooveOp) === 0) {
          setError("This clip has no offbeat drum hits that can be changed by that groove request.");
          return;
        }
        setSelectedArrangementPreview({
          kind: "clip",
          source,
          clip,
          ops,
          lines: selectedClipEditPreviewLines(currentDoc, clip, ops),
          ...(grooveOp ? { sourcePatternHash: selectedClipPatternHash(currentDoc, clip) } : {}),
        });
        setStatus("Clip preview ready — inspect the exact arrangement change, then apply or cancel.");
      } else if (route.kind === "selectedRangeArrange") {
        const currentDoc = services.store.getDoc();
        const currentRange = selection.getState().timeRange;
        const operation = parseSelectedTimeRangeIntent(source);
        if (
          !currentRange ||
          currentRange.fromTick !== route.range.fromTick ||
          currentRange.toTick !== route.range.toTick ||
          operation !== route.operation
        ) {
          setError("The time selection changed or the request no longer resolves. Review the range and try again.");
          return;
        }
        const rangeError = selectedTimeRangeIntentError(currentDoc, route.range, operation);
        if (rangeError) {
          setError(rangeError);
          return;
        }
        setSelectedArrangementPreview({
          kind: "range",
          source,
          range: { ...route.range },
          operation,
          description: selectedRangeEditDescription(route.range, operation),
        });
        setStatus("Range preview ready — inspect the source and destination, then apply or cancel.");
      } else if (route.kind === "stepEditIntent") {
        // "remove the kick on beat 3 of bar 2" — per-step edit folded into
        // one snapshot; out-of-range bars fail explicitly.
        const command = applyStepEditIntent(doc, route.intent);
        if (!command) {
          setError(route.intent.action === "remove" ? "na tejto pozícii nie je žiadny hit" : "nič na úpravu");
          return;
        }
        services.store.execute(command);
        setStatus(`✓ ${command.label} (one undo step)`);
      } else if (route.kind === "soundSwapIntent") {
        // "swap the snare to something fatter" — descriptor-scored factory
        // asset within the pad family; no candidate → explicit error.
        const command = applySoundSwapIntent(doc, route.intent);
        if (!command) {
          setError(`žiadny ${route.intent.descriptor} kandidát v rodine ${route.intent.family}`);
          return;
        }
        services.store.execute(command);
        setStatus(
          `✓ ${command.label} — ${soundSwapReadback(services.store.getDoc(), route.intent.family)} (one undo step)`,
        );
      } else if (route.kind === "grooveIntent") {
        // "more swing" / "tighter groove" / "swing 60%" — project groove,
        // ONE undo step, read-back shows the landing values.
        const command = applyGrooveIntent(doc, route.intent);
        services.store.execute(command);
        setStatus(`🥁 ${command.label} — ${grooveReadback(services.store.getDoc())} (one undo step)`);
      } else if (route.kind === "automateIntent") {
        // "automate the volume from 0 to 100" — track-gain ramp lane,
        // spanning the whole arrangement (v1; role spans come with spans).
        stopAudition();
        const command = applyAutomateIntent(doc, route.intent, null);
        if (!command) {
          setError("no track to automate");
          return;
        }
        services.store.execute(command);
        setStatus(`✓ ${command.label} (one undo step)`);
      } else if (route.kind === "markerIntent") {
        // "add a marker at bar 8" / "delete the marker at bar 8"
        const command = applyMarkerIntent(doc, route.intent);
        if (!command) {
          setError(`no marker at bar ${route.intent.bar}`);
          return;
        }
        services.store.execute(command);
        const readback = markerReadback(services.store.getDoc(), route.intent);
        setStatus(`✓ ${command.label}${readback ? ` — ${readback}` : ""} (one undo step)`);
      } else if (route.kind === "select") {
        // Explicit track selection — UI state (SelectionStore), not document
        // state: no undo, no mutation. Family → ids via the production
        // resolver; "mix"/pads never reach this branch (parser declines).
        const ids = resolveProductionTargets(doc, [route.target as never]);
        if (ids.length === 0) {
          setError(`no track matches "${route.target}"`);
          return;
        }
        selection.setTracks(ids, "replace");
        setStatus(`⚡ selected: ${route.target}`);
      } else if (route.kind === "preset") {
        // "load the Warm Sub preset on the bass" — canonical
        // applyInstrumentPreset folded over the target family, one undo.
        stopAudition();
        try {
          const command = applyPresetIntentCommand(doc, route.intent);
          services.store.execute(command);
          const readback = presetReadback(services.store.getDoc(), route.intent);
          setStatus(`✓ ${command.label}${readback ? ` — ${readback}` : ""} (one undo step)`);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } else if (route.kind === "presetUnknown") {
        // Explicit unknown-preset response — never a silent generation.
        setError(
          `unknown preset "${route.name}"${
            route.suggestions.length > 0 ? ` — try: ${route.suggestions.join(", ")}` : ""
          }`,
        );
      } else if (route.kind === "arrange") {
        stopAudition();
        services.store.execute(applyArrangeOps(doc, route.ops));
        setStatus(`⚡ arranged — ${route.ops.length} op${route.ops.length === 1 ? "" : "s"}${checkpointNote}`);
      } else if (route.kind === "clips") {
        // Clip-level trim/copy/move/delete at absolute positions — one
        // undoable command, NO relayout (the user placed clips on purpose).
        stopAudition();
        const command = applyClipArrangeOps(doc, route.ops);
        if (!command) {
          setError("clip changed under the request — try again");
          return;
        }
        services.store.execute(command);
        setStatus(`⚡ ${command.label}${checkpointNote}`);
      } else if (route.kind === "exact") {
        // Exact mixer commands ("mute the drums", "pan the bass left 30") —
        // one undoable command group.
        stopAudition();
        const command = applyExactIntentCommand(doc, route.plan);
        services.store.execute(command);
        // `removeTrack` ops go through the same pure `deleteTrack` command the
        // mixer's delete button uses, so the plan cannot reach the
        // SelectionStore either. Reconcile it against the document that just
        // landed: a selection naming a deleted track survives into
        // `bounceZoneToClick`, which forwards it unfiltered and then renders
        // silence while reporting success. No-ops when no track was removed.
        selection.retainTracks(services.store.getDoc().tracks.map((t) => t.id));
        const readback = exactReadback(doc, services.store.getDoc(), route.plan);
        setStatus(`⚡ ${route.plan.label}${readback ? ` — ${readback}` : ""}${checkpointNote}`);
      } else if (route.kind === "effectIntent") {
        // D1 v2a: targeted effect × target × direction
        stopAudition();
        const command = applyEffectIntent(doc, route.intent);
        services.store.execute(command);
        const readback = effectReadback(doc, services.store.getDoc(), route.intent);
        setStatus(`⚡ ${route.intent.detected.join(" · ")}${readback ? ` — ${readback}` : ""}${checkpointNote}`);
      } else if (route.kind === "sendIntent") {
        // "more reverb send on the lead" — send level per the matching return
        stopAudition();
        try {
          const command = applySendIntent(doc, route.intent);
          services.store.execute(command);
          const readback = sendReadback(services.store.getDoc(), route.intent);
          setStatus(`✓ ${command.label}${readback ? ` — ${readback}` : ""} (one undo step)`);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } else if (route.kind === "bypassIntent") {
        // "bypass the delay on the lead" — the bypass FLAG on every instance
        // across the family; the command throws when nothing exists.
        stopAudition();
        try {
          const command = applyBypassIntent(doc, route.intent);
          services.store.execute(command);
          const readback = bypassReadback(services.store.getDoc(), route.intent);
          setStatus(`✓ ${command.label}${readback ? ` — ${readback}` : ""} (one undo step)`);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } else if (route.kind === "production") {
        // Production intent with an explicit target ("make the drums
        // darker") — same executor as the GENERATE path: track FX, one
        // undo step. The router only sends texts that name a target track.
        stopAudition();
        try {
          const cmd = applyProductionIntentCommand(doc, route.intent);
          services.store.execute(cmd);
          const readback = productionReadback(doc, services.store.getDoc(), route.intent);
          setStatus(`✓ ${cmd.label}${readback ? ` — ${readback}` : ""} (one undo step)`);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } else if (route.kind === "fader") {
        // GOAL 38/40: "zníž basu" / "kick ťažší" / "hlasnejšie bicie" — real
        // pad + track gain changes with amount modifiers, ONE undo step.
        const command = applyFaderIntent(doc, route.intent);
        if (!command) {
          setError("no matching track or pad for the fader intent");
          return;
        }
        services.store.execute(command);
        const readback = faderReadback(doc, services.store.getDoc(), route.intent);
        setStatus(`${command.label}${readback ? ` — ${readback}` : ""} (one undo step)`);
      } else if (route.kind === "compound") {
        // Cross-executor compound ("zníž tempo a zvýš lead") — every clause
        // parsed on its own; all clauses fold into ONE undoable snapshot.
        stopAudition();
        const command = applyCompoundIntent(doc, route.parts);
        if (!command) {
          setError("compound intent changed nothing — every clause already matches");
          return;
        }
        services.store.execute(command);
        const readback = compoundReadback(doc, services.store.getDoc(), route.parts);
        setStatus(`${command.label}${readback ? ` — ${readback}` : ""} (one undo step)${checkpointNote}`);
      } else if (route.kind === "tempo") {
        // GOAL 38: "zníž tempo" / "na 128" — project BPM with one undo step
        services.store.execute(applyTempoIntent(doc, route.intent));
        const newBpm = services.store.getDoc().bpm;
        setStatus(`⚡ tempo: ${newBpm} BPM (one undo step)`);
      } else if (route.kind === "loudness") {
        // D1 loudness loop: measure → trim → verify
        stopAudition();
        if (loudnessBusyRef.current) return;
        loudnessBusyRef.current = true;
        setError(null);
        setStatus("🔊 measuring loudness…");
        try {
          const outcome = await applyLoudnessIntent(doc, services.bank, route.parse);
          if (!outcome.ok) {
            setError(outcome.error);
          } else {
            setStatus(
              `⚡ loudness: ${outcome.report.measuredBefore} → ${outcome.report.measuredAfter ?? "?"} LUFS (trim ${outcome.report.trim >= 0 ? "+" : ""}${outcome.report.trim} dB)`,
            );
          }
        } finally {
          loudnessBusyRef.current = false;
        }
      } else if (route.kind === "mix") {
        stopAudition();
        const intentInput = {
          ...(parsed?.input ?? {}),
          ...(refPatch ?? {}),
          ...briefFixes,
          ...(consumeOneShotPatch() ?? {}),
        };
        const profile = planMixProfile(normalizeIntent(intentInput), route.overrides);
        services.store.execute(applyMixIntent(doc, profile));
        setStatus(`⚡ mix: ${profile.summary.join(" · ") || `${profile.decisions.length} updates`}`);
      } else if (route.kind === "sectionProduction" || route.kind === "sectionFlow") {
        stopAudition();
        if (busy) return;
        setBusy(true);
        setError(null);
        setStatus(null);
        try {
          const outcome =
            route.kind === "sectionProduction"
              ? reviseSectionProduction(doc, route.targetRole, route.intent)
              : reviseSectionFlow(doc, route.targetRole, route.flow);
          if (!outcome.ok) {
            setStatus(`⚡ ${outcome.error}`);
            return;
          }
          const auditionDoc = "auditionDoc" in outcome ? outcome.auditionDoc : doc;
          const command =
            "command" in outcome
              ? outcome.command
              : replacePatternInPlaceCommand(doc, outcome.patternId, outcome.pattern);
          const render = () => renderAuditionBuffer(auditionDoc, services.bank, outcome.pattern, null);
          proposeSectionChange(outcome.label, doc, command, render);
          setStatus(`↻ ${outcome.label} — náhľad sekcie, ✓ potvrdiť alebo ✗ ponechať`);
        } finally {
          setBusy(false);
        }
      } else if (route.kind === "revise") {
        // C2: shift a content slider on the LAST generation and re-run with
        // the SAME seed — the beat keeps its identity, the character moves.
        stopAudition();
        if (busy) return;
        setBusy(true);
        setError(null);
        setStatus(null);
        setBankResult(null);
        setPlayingIndex(null);
        buffersRef.current = new Map();
        const controller = new AbortController();
        abortRef.current?.abort();
        abortRef.current = controller;
        const last = lastIntentRef.current;
        const delta = route.direction === "more" ? REVISE_DELTA : -REVISE_DELTA;
        const fallbackDefaults: Record<ReviseAttribute, number> = { energy: 0.7, density: 0.5 };
        if (route.targetRole) {
          // C3 TARGETED revise: the role word names the section — regenerate
          // THAT scene's pattern from its own provenance intent (same seed).
          // Fáza 5: audition-first — the outcome becomes a PREVIEW proposal
          // (▶ heard before commit; ✓ applies the same one-undo in-place
          // swap, ✗ leaves the project untouched). No silent write.
          try {
            const attribute = route.attribute as "energy" | "density";
            const outcome = reviseSection(doc, route.targetRole as never, attribute, delta);
            if (!outcome.ok) {
              setStatus(`⚡ ${outcome.error}`);
              return;
            }
            stopAudition();
            proposeSectionPattern(outcome, doc);
            setStatus(`↻ ${outcome.label} — ▶ náhľad, ✓ potvrdiť alebo ✗ ponechať`);
          } finally {
            // Unlike global revisions, this synchronous targeted path does
            // not enter runGeneration(), whose finally normally releases busy.
            setBusy(false);
          }
        } else if (last) {
          const current = last[route.attribute] ?? fallbackDefaults[route.attribute];
          await runGeneration({ ...last, [route.attribute]: Math.max(0, Math.min(1, current + delta)) }, controller);
          setStatus(`⚡ ${route.attribute} ${route.direction === "more" ? "+0.15" : "−0.15"} — same seed`);
        } else {
          // Nothing generated yet — apply the attribute to the parsed intent.
          const intentInput: IntentInput = {
            ...briefInput,
            ...(refPatch ?? {}),
            ...briefFixes,
            ...(consumeOneShotPatch() ?? {}),
          };
          const current = intentInput[route.attribute] ?? fallbackDefaults[route.attribute];
          intentInput[route.attribute] = Math.max(0, Math.min(1, current + delta));
          await runGeneration(intentInput, controller);
          setStatus(`⚡ ${route.attribute} → ${intentInput[route.attribute]?.toFixed(2)} (fresh pattern)`);
        }
      } else if (route.kind === "clarify") {
        // Declined intent (conflict / no target / unaddressable param) —
        // offer the nearest executable interpretations, mutate nothing.
        // MINING: a clarify is a real sentence both layers failed on — the
        // #1 corpus signal for the next round.
        stopAudition();
        setClarify({ reason: route.reason, suggestions: route.suggestions, prompt: source });
        logIntentMiningEvent({ prompt: source, outcome: "clarify", reason: route.reason });
        setStatus(route.reason);
      } else {
        // The registered local model is trained for editor actions, not for
        // composing music. Keep creative briefs on the generation path and
        // avoid probing/starting Ollama for a request the action schema cannot
        // represent.
        if (isCreativeBriefRoute(source, route)) {
          await generate(source);
          return;
        }
        // LOCAL-MODEL FALLBACK: the deterministic layer came up empty — let
        // the registered intent model try the instruction before falling to
        // generation. A hit re-enters with the adapted route (one dispatch);
        // a miss (no provider / invalid output / unresolvable refs) keeps
        // today's behavior unchanged. A missing provider retries registration
        // once here: the mount-time warm can lose a race against a busy
        // machine (probe timeout) and this is the cheapest self-heal.
        if (!getIntentModelProvider()) {
          const ollama = await import("../intent/model-ollama");
          await ollama.ensureOllamaIntentProvider().catch(() => null);
        }
        const modelRoute = await tryModelRoute(source, doc, route);
        if (modelRoute) {
          preRoutedRef.current = modelRoute;
          // MINING: what the model caught (kind drift monitoring — a kind
          // takeover here that users keep undoing is a wrongKind in hiding)
          logIntentMiningEvent({ prompt: source, outcome: "model-hit", routeKind: modelRoute.kind });
          setStatus("🤖 lokálny model — akcia rozpoznaná");
          void routeAndExecute();
          return;
        }
        // MINING: no provider answered or nothing validated — the sentence
        // fell through to generation; that is exactly the row a corpus
        // round (or a parser sibling) should learn from
        logIntentMiningEvent({ prompt: source, outcome: "model-miss" });
        await generate();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRouteBusy(false);
    }
  };

  const detectedText = parsed?.detected.length ? parsed.detected.map((d) => `● ${d}`).join("  ") : null;

  return (
    <div className="intent-panel" aria-label="Intent Engine">
      <div className="intent-header">
        <span className="intent-title">INTENT</span>
        <span className="intent-subtitle">describe → audition → choose</span>
        <button
          type="button"
          className="intent-model-chip"
          data-state={modelState}
          onClick={toggleIntentModel}
          title={INTENT_MODEL_CHIP_TITLES[modelState]}
          aria-label={`Local intent model: ${modelState}`}
        >
          🤖
        </button>
        {desktopMcp && (
          <button
            type="button"
            className="intent-model-chip"
            data-state={mcpStatus?.enabled ? "ready" : "off"}
            onClick={toggleDesktopMcp}
            title={
              mcpStatus?.enabled
                ? "MCP server beží — externý klient môže ovládať KYX. Klikni pre vypnutie."
                : "MCP server (desktop): externý MCP klient (Claude Desktop) ovláda KYX cez deterministickú command vrstvu. Klikni pre zapnutie."
            }
            aria-label={`MCP server: ${mcpStatus?.enabled ? "on" : "off"}`}
          >
            ⚡
          </button>
        )}
        {!desktopMcp && (
          <button
            type="button"
            className="intent-model-chip"
            data-state={webMcpEnabled ? (webMcpConnected ? "ready" : "loading") : "off"}
            onClick={toggleWebMcp}
            title={
              webMcpEnabled
                ? `MCP relay (${webMcpConnected ? "pripojené" : "pripájam…"}) — klikni pre vypnutie.`
                : "MCP relay (web): pripoj KYX ku collab serveru /mcp-relay, aby externý MCP klient mohol ovládať tento projekt. Vyžaduje MCP token servera."
            }
            aria-label={`MCP relay: ${webMcpEnabled ? "on" : "off"}`}
          >
            ⚡
          </button>
        )}
      </div>
      {!desktopMcp && webMcpEnabled && (
        <div className="intent-mcp-config" aria-label="MCP relay config">
          <span className="intent-history-label">MCP</span>
          <pre>{webMcpConfigText}</pre>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              void navigator.clipboard?.writeText(webMcpConfigText).catch(() => {});
            }}
            title="Copy the streamable-HTTP config for an external MCP client"
          >
            KOPIÍROVAŤ
          </button>
          <input
            type="password"
            className="intent-mcp-token-input"
            placeholder="MCP token"
            value={webTokenDraft}
            onChange={(event) => setWebTokenDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyWebToken();
            }}
            onBlur={applyWebToken}
            aria-label="MCP relay token"
          />
          <span className="intent-history-label">{webMcpConnected ? "● LIVE" : "○ …"}</span>
        </div>
      )}
      {desktopMcp && mcpStatus?.enabled && mcpConfigText && (
        <div className="intent-mcp-config" aria-label="MCP client config">
          <span className="intent-history-label">MCP</span>
          <pre>{mcpConfigText}</pre>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              void navigator.clipboard?.writeText(mcpConfigText).catch(() => {});
            }}
            title="Copy the config to your MCP client (Claude Desktop & co.)"
          >
            KOPIÍROVAŤ
          </button>
          <button
            type="button"
            className={`btn btn-small${mcpDestructive ? " intent-mcp-destructive-on" : ""}`}
            onClick={() => {
              const next = !mcpDestructive;
              setMcpAllowDestructive(next);
              setMcpDestructive(next);
            }}
            title={
              mcpDestructive
                ? "Mazanie (tracky/sekcie/FX) cez MCP je POVOLENÉ — externý klient môže mazať."
                : "Mazanie cez MCP je zamknuté (odporúčané) — externý klient môže len pridávať/upravovať."
            }
          >
            {mcpDestructive ? "🔓 MAZANIE" : "🔒 MAZANIE"}
          </button>
        </div>
      )}
      <textarea
        ref={promptInputRef}
        className="intent-textarea"
        title="Describe the beat you want — genre, mood, tempo, bars, instruments, arrangement. Ctrl/Cmd+Enter generates."
        placeholder="dark rolling techno at 140 with lead… · tmavé rolujúce techno na 140, 8 taktov…"
        value={text}
        onChange={(e) => {
          replacePrompt(e.target.value);
          if (selectedStepPreview || selectedArrangementPreview) setStatus(null);
          setSelectedStepPreview(null);
          setSelectedArrangementPreview(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void generate();
        }}
        rows={3}
        aria-label="Intent description"
      />
      <div className="intent-voice-row">
        <button
          type="button"
          className={`btn intent-voice-btn${voiceState === "recording" ? " intent-voice-rec" : ""}`}
          disabled={voiceState === "transcribing"}
          title={voiceState === "recording" ? "Stop and transcribe" : "Voice input — speak and transcribe"}
          aria-label={voiceState === "recording" ? "Stop voice capture" : "Start voice capture"}
          onClick={() => void toggleVoiceCapture()}
        >
          {voiceState === "recording" ? "⏺ REC" : voiceState === "transcribing" ? "…prepisujem" : "🎙 HOVOR"}
        </button>
      </div>
      <div className="intent-history" aria-label="Personal style memory">
        <span className="intent-history-label">
          OSOBNÝ VKUS · {learnedPatternCount} príkladov · {correctionSummary?.correctionCount ?? 0} opráv ·{" "}
          {automaticLearning ? "AUTO ON" : "AUTO OFF"} · iba lokálne
        </span>
        <button
          type="button"
          className="btn btn-small"
          aria-pressed={automaticLearning}
          onClick={toggleAutomaticLearning}
          title="Po krátkej pauze po ručnej úprave v Piano Roll, Step Sequenceri alebo MIDI nahrávaní porovná KYX hudobné črty pred a po úprave. Generované a vzdialené zmeny sa nezapočítajú; lokálne sa ukladajú iba číselné črty a hash, nie noty ani prompt."
        >
          {automaticLearning ? "POZASTAVIŤ UČENIE" : "ZAPNÚŤ UČENIE"}
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={learnActivePattern}
          title="Uloží odvodený súhrn hudobných vlastností aktívneho patternu do lokálnej pamäte pre sémanticky podmienené generovanie."
        >
          NAUČ SA Z AKTÍVNEHO PATTERNU
        </button>
        {(learnedPatternCount > 0 || (correctionSummary?.correctionCount ?? 0) > 0) && (
          <button type="button" className="btn btn-small" onClick={forgetLearnedPatterns}>
            ZABUDNÚŤ NAUČENÉ
          </button>
        )}
      </div>
      {learnedStyle && learnedStyle.exampleCount >= 3 && (
        <div className="intent-history" aria-label="Personalized intent suggestions">
          <span className="intent-history-label">
            TVOJ ZVUK · {learnedStyle.genre} · {personalStyleDescription(learnedStyle, correctionSummary?.directions)}
            {correctionSummary && (
              <>
                <br />
                {correctionSummary.modelReady && correctionSummary.rankerEnabled
                  ? `Producer DNA ranker aktívny · ${correctionSummary.learnedComparisonCount} naučených porovnaní`
                  : correctionSummary.modelReady
                    ? "Producer DNA ranker je pozastavený"
                    : "Ranker sa kalibruje z tvojich ručných opráv a A/B volieb"}
              </>
            )}
          </span>
          {personalIntents.map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              className="intent-history-chip"
              title={`Použiť osobný návrh: ${suggestion.prompt}`}
              onClick={() => setText(suggestion.prompt)}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      )}
      {styleMemoryMessage && (
        <div role="status" className="intent-detected">
          {styleMemoryMessage}
        </div>
      )}
      {doc.producerBrief && (
        <>
          <div className="intent-history" aria-label="Project Producer Brief memory">
            <label className="intent-history-label">
              <input
                type="checkbox"
                checked={useProjectBrief}
                onChange={(event) => setUseProjectBrief(event.target.checked)}
                aria-label="Use saved project Producer Brief for generation"
              />
              PROJECT BRIEF {useProjectBrief ? "ON" : "OFF"}
            </label>
          </div>
          <ProjectProducerBriefManager
            brief={doc.producerBrief}
            onRemove={(field) => services.store.execute(removeProjectProducerBriefFactCommand(doc, field))}
            onClear={clearSavedProjectBrief}
          />
        </>
      )}
      {historyTick >= 0 && promptHistory().length > 0 && (
        <div className="intent-history" aria-label="Prompt history">
          <span className="intent-history-label">RECENT</span>
          {promptHistory()
            .slice(0, 8)
            .map((entry) => (
              <button
                key={entry.at}
                type="button"
                className="intent-history-chip"
                title="Re-run this prompt"
                onClick={() => replacePrompt(entry.text, true)}
              >
                {entry.text.length > 42 ? entry.text.slice(0, 40) + "…" : entry.text}
              </button>
            ))}
        </div>
      )}
      {detectedText && (
        <div className="intent-detected" aria-label="Detected keywords">
          {detectedText}
        </div>
      )}
      {(() => {
        // Ambiguity chips — when the prompt touches two-plus style lanes,
        // the parser's first-wins order silently picks one. The chips name
        // the picked lane and its honest alternatives; one click rides the
        // chosen style into the next generation (one-shot patch).
        const candidates = text.trim() ? styleCandidatesForPrompt(text) : [];
        if (candidates.length < 2 || !parsed?.input.genre) return null;
        const picked = parsed.input.style ?? candidates[0]!;
        const prettify = (style: string) => style.charAt(0).toUpperCase() + style.slice(1);
        return (
          <div className="intent-lane-chips" aria-label="Lane alternatives">
            {candidates.slice(0, 4).map((style) => (
              <button
                key={style}
                type="button"
                className={`btn btn-small intent-lane-chip${style === picked ? " picked" : ""}`}
                title={`Route this prompt to the ${prettify(style)} lane (one generation)`}
                onClick={() => {
                  setRefPatch({ style });
                  setStatus(`⚡ lane: ${prettify(style)} — ${parsed.input.genre} generation rides this style`);
                }}
              >
                {style === picked ? `● ${prettify(style)}` : prettify(style)}
              </button>
            ))}
          </div>
        );
      })()}
      {(text.trim() !== "" || activeProjectBrief) && (
        <>
          <BriefContractSummary
            contract={briefContract}
            input={briefInput}
            fixes={briefFixes}
            defaultRoles={["drums", "bass"]}
            onPatch={applyBriefPatch}
          />
          <div className="intent-history" aria-label="Save structured Producer Brief">
            <span className="intent-history-label">
              SAVES ONLY EXPLICIT FACTS + YOUR CORRECTIONS — NO RAW PROMPT, LYRICS OR AUDIO
            </span>
            <button
              type="button"
              className="btn btn-small"
              disabled={!canSaveProjectBrief}
              onClick={saveCurrentProjectBrief}
              title="Save or update this project-local brief as one undoable change"
            >
              {doc.producerBrief ? "UPDATE PROJECT BRIEF" : "SAVE TO PROJECT"}
            </button>
          </div>
        </>
      )}
      {semanticChip && (
        <div className="intent-detected" aria-label="Semantic match">
          {semanticChip}
        </div>
      )}
      {error && (
        <div className="intent-error" role="alert">
          {error}
        </div>
      )}
      {selectedStepPreview && (
        <div className="intent-history" role="region" aria-label="Selected-cell intent preview">
          <span className="intent-history-label">
            {selectedStepPreview.intent.reason === "vocal-space"
              ? "VOCAL SPACE · HATS-ONLY THIN"
              : `SELECTED STEPS · ${selectedStepPreview.intent.operation.toUpperCase()}`}
          </span>
          <div>
            {selectedStepPreview.drumTrack.name} · bar{" "}
            {Math.floor(Math.min(selectedStepPreview.selection.from, selectedStepPreview.selection.to) / 16) + 1}, steps{" "}
            {Math.min(selectedStepPreview.selection.from, selectedStepPreview.selection.to) + 1}–
            {Math.max(selectedStepPreview.selection.from, selectedStepPreview.selection.to) + 1} ·{" "}
            {selectedStepPreview.plan.beforeHits} → {selectedStepPreview.plan.afterHits} hits
          </div>
          {selectedStepPreview.plan.changes.slice(0, 8).map((change) => (
            <div key={`${change.padId}-${change.step}`}>
              Step {change.step + 1} · {change.padName} · {Math.round(change.before * 100)}% →{" "}
              {Math.round(change.after * 100)}%
            </div>
          ))}
          {selectedStepPreview.plan.changes.length > 8 && (
            <div>+ {selectedStepPreview.plan.changes.length - 8} more cell changes</div>
          )}
          <div className="intent-actions">
            <button type="button" className="btn intent-route-btn" onClick={applySelectedStepPromptPreview}>
              APPLY · ONE UNDO STEP
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setSelectedStepPreview(null);
                setStatus("Selected-step preview cancelled; project unchanged.");
              }}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
      {selectedArrangementPreview && (
        <div
          className="intent-history"
          role="region"
          aria-label={
            selectedArrangementPreview.kind === "clip"
              ? "Selected clip intent preview"
              : "Selected range intent preview"
          }
        >
          <span className="intent-history-label">
            {selectedArrangementPreview.kind === "clip"
              ? "ARRANGEMENT · SELECTED CLIP"
              : `ARRANGEMENT · SELECTED RANGE · ${selectedArrangementPreview.operation.toUpperCase()}`}
          </span>
          {selectedArrangementPreview.kind === "clip" ? (
            <>
              <div>
                Target locked · bar {selectedArrangementPreview.clip.startBar + 1} ·{" "}
                {selectedArrangementPreview.clip.lengthBars} bars
              </div>
              {selectedArrangementPreview.lines.map((line, index) => (
                <div key={`${index}-${line}`}>{line}</div>
              ))}
            </>
          ) : (
            <>
              <div>{selectedArrangementPreview.description}</div>
              {selectedArrangementPreview.operation === "consolidate" && (
                <div role="note">
                  This renders the full mix to one audio print and replaces the source clips. Undo restores them.
                </div>
              )}
            </>
          )}
          <div className="intent-actions">
            <button
              type="button"
              className="btn intent-route-btn"
              disabled={rangeConsolidating}
              onClick={() => void applySelectedArrangementPromptPreview()}
            >
              {rangeConsolidating ? "RENDERING PRINT…" : "APPLY "}{" "}
              {selectedArrangementPreview.kind === "clip"
                ? "CLIP EDIT"
                : selectedArrangementPreview.operation.toUpperCase()}{" "}
              · ONE UNDO STEP
            </button>
            <button
              type="button"
              className="btn"
              disabled={rangeConsolidating}
              onClick={() => {
                setSelectedArrangementPreview(null);
                setStatus("Arrangement preview cancelled; project unchanged.");
              }}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
      {clarify && clarify.suggestions.length > 0 && (
        <div className="intent-history" aria-label="Nearest interpretations">
          <span className="intent-history-label">INTENT?</span>
          {clarify.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="intent-history-chip"
              title="Apply this interpretation"
              onClick={() => {
                // MINING: the chip the user picked reveals what the failed
                // ask actually meant — the strongest label in the whole log
                logIntentMiningEvent({
                  prompt: clarify.prompt ?? "(diagnóza)",
                  outcome: "clarify-picked",
                  reason: clarify.reason,
                  pickedSuggestion: suggestion,
                });
                replacePrompt(suggestion, true);
                void routeAndExecute(suggestion);
              }}
            >
              {suggestion.length > 42 ? suggestion.slice(0, 40) + "…" : suggestion}
            </button>
          ))}
        </div>
      )}
      {status && (
        <div className="intent-status" role="status">
          {status}
        </div>
      )}
      {personalStatus && (
        <div className="intent-status intent-personal-status" role="status">
          {personalStatus}
        </div>
      )}
      {justApplied && (
        <div className="intent-share" aria-label="Share your beat">
          <span className="intent-share-label">Yours. Share it:</span>
          <div className="intent-share-actions">
            <PublishToGalleryButton />
            {videoSupported && (
              <button type="button" className="btn" disabled={videoBusy} onClick={() => void exportVideo()}>
                {videoBusy ? "…" : "VIDEO"}
              </button>
            )}
            <button type="button" className="btn" onClick={() => void copyShareLink()}>
              COPY LINK
            </button>
          </div>
        </div>
      )}
      <div className="intent-actions">
        <button
          type="button"
          className="btn intent-route-btn"
          disabled={!text.trim() || routeBusy}
          onClick={() => void routeAndExecute()}
          title="Smart route: arrange words → arrangement · mix words → mix · everything else → generate candidates"
        >
          {routeBusy ? "…" : "⚡ DO IT"}
        </button>
        <button
          type="button"
          className="btn intent-generate-btn"
          disabled={(!text.trim() && !activeProjectBrief) || busy || songBusy}
          onClick={() => void generate()}
          title={activeProjectBrief && !text.trim() ? "Generate from the saved project brief" : undefined}
        >
          {busy ? "GENERATING…" : "GENERATE"}
        </button>
        <button
          type="button"
          className="btn intent-song-btn"
          disabled={(!text.trim() && !activeProjectBrief) || busy || songBusy}
          onClick={() => void generateSong()}
          title="Build a full arranged song from this intent (intro → build → drop → break → drop → outro)"
        >
          {songBusy ? "BUILDING…" : "♪ SONG"}
        </button>
        <button
          type="button"
          className="btn intent-theatre-btn"
          disabled={(!text.trim() && !activeProjectBrief) || busy || songBusy || theatreBusy}
          onClick={() => void hireTheBand()}
          title="Session Theatre: traja AI producenti nahrajú tú istú pesničku každý po svojom, ty si potom slepo vyberieš víťaza"
        >
          {theatreBusy ? "🎬…" : "🎬 KAPELU"}
        </button>
        <button
          type="button"
          className="btn intent-mutate-btn"
          disabled={busy || songBusy || mutateBusy}
          onClick={() => mutate()}
          title="Remix-DNA mutate: fork the current beat into a child project — same seed family, small variation, fresh undo history"
        >
          {mutateBusy ? "MUTATING…" : "🧬 MUTATE"}
        </button>
        <label
          className="intent-monitor-toggle"
          title="Hum & harmonize: the SUNO build stacks diatonic backing vocals (third above + below) under your hummed hook on a 'Hum Harmony' track"
        >
          <input type="checkbox" checked={ideaHarmonize} onChange={(event) => setIdeaHarmonize(event.target.checked)} />
          🎶
        </label>
        <label
          className="intent-monitor-toggle"
          title="Hear yourself through the app — HEADPHONES ONLY (speakers feed back into the mic)"
        >
          <input
            type="checkbox"
            checked={ideaMicMonitor}
            onChange={(event) => setIdeaMicMonitoring(event.target.checked)}
          />
          🔊
        </label>
        <button
          type="button"
          className={`btn intent-idea-btn${ideaRecording ? " recording" : ""}`}
          disabled={refBusy}
          onClick={() => void toggleIdeaRecording()}
          title="Voice idea — record yourself humming/singing the hook; the beat builds around YOUR tempo, key and melody"
        >
          {ideaRecording ? "■ STOP" : "🎤 IDEA"}
        </button>
        <button
          type="button"
          className="btn intent-ref-btn"
          disabled={refBusy}
          onClick={() => referenceInputRef.current?.click()}
          title="Audio reference — drop a WAV and the engine listens: genre + energy patch, plus a semantic conditioning vector for the v2 priors"
        >
          {refBusy ? "🎧…" : "🎧 REF"}
        </button>
        <button
          type="button"
          className="btn intent-personal-btn"
          disabled={personalBusy || busy || songBusy}
          onClick={() => void trainPersonalPrior()}
          title="NAUČ SA MA — fine-tune your personal melodic prior from your ★ rolls, in the browser. Installs only when it beats the shipped model on your own ★ (local, offline, one click)."
        >
          {personalBusy ? "🧠…" : "🧠 NAUČ SA MA"}
        </button>
        <button
          type="button"
          className="btn intent-vocal-btn"
          onClick={() => toggleVocalMode()}
          title="Vocal-ready mode — loop the active pattern with a click so you can rehearse or record vocals"
        >
          {vocalMode ? "🎧 VOCAL ON" : "🎧 VOCAL"}
        </button>
        <button
          type="button"
          className="btn intent-take-btn"
          disabled={takeBusy}
          onClick={() => void analyzeTake()}
          title="Analyze the arrangement take — key, tempo, energy and phrases, then apply key/tempo or bend a SONG around it"
        >
          {takeBusy ? "🎤…" : "🎤 TAKE"}
        </button>
        <button
          type="button"
          className="btn intent-groove-btn"
          disabled={!refGroove || refBusy}
          onClick={installGroove}
          title="Install the extracted groove (kick/snare/hat rows) into the active pattern"
        >
          🥁→DRUMS
        </button>
        <input
          ref={referenceInputRef}
          type="file"
          accept="audio/*"
          style={{ display: "none" }}
          onChange={(event) => {
            void handleReferenceFile(event.target.files?.[0] ?? null);
            event.target.value = "";
          }}
        />
      </div>
      {refPatch && (
        <div className="intent-ref-chip" role="status">
          <span className="intent-ref-chip-label">🎧 ref: {refSummary ?? "active"}</span>
          <span className="intent-ref-chip-hint">shapes every generation</span>
          <button
            type="button"
            className="intent-ref-chip-clear"
            aria-label="Match master EQ to reference"
            title="Match EQ — measure the mix against the reference and correct the master (znej ako ref)"
            onClick={handleMatchEq}
          >
            🎯
          </button>
          <button
            type="button"
            className="intent-ref-chip-clear"
            aria-label="Clear audio reference"
            title="Clear the reference — back to text-only intent"
            onClick={clearReference}
          >
            ×
          </button>
        </div>
      )}
      {sessionSummary !== null && sessionTick >= 0 && (
        <div className="producer-session-hud" aria-label="Producer session">
          <span className="producer-session-chip">🎛 {sessionSummary}</span>
          {bankResult &&
            bankResult.bank &&
            bankResult.bank.length > 0 &&
            planVariantIntents(lastGeneration()?.intent ?? parsed?.input ?? {}).map((variant) => (
              <button
                key={variant.label}
                type="button"
                className="btn btn-small producer-variant-chip"
                title={`Generate a ${variant.label} direction off this intent`}
                onClick={() => {
                  oneShotPatchRef.current = variant.patch;
                  void generate();
                }}
              >
                {variant.chip}
              </button>
            ))}
          <button
            type="button"
            className="btn btn-small producer-session-reset"
            title="Clear the producer session memory"
            onClick={() => {
              resetProducerSession();
              setSessionTick((tick) => tick + 1);
              setStatus("🎛 session cleared");
            }}
          >
            ✕
          </button>
        </div>
      )}
      {vocalMode && (
        <div className="vocal-hud" aria-label="Vocal-ready HUD">
          <span className="vocal-hud-bpm">{doc.bpm} BPM</span>
          <span className="vocal-hud-key">{refPatch?.key ?? parsed?.input?.key ?? doc.key ?? "—"}</span>
          <span className="vocal-hud-loop">
            looping{" "}
            {Math.max(
              1,
              Math.round(
                (doc.patterns.find((candidate) => candidate.id === doc.activePatternId)
                  ? patternLengthTicks(doc.patterns.find((candidate) => candidate.id === doc.activePatternId)!)
                  : 1920) / 1920,
              ),
            )}{" "}
            bars
          </span>
          <span className="vocal-hud-click">click ON</span>
          <button
            type="button"
            className="btn btn-small"
            disabled={bounceBusy}
            onClick={() => void bounceBeatOnly()}
            title="Render this pattern WITHOUT the master chain — the raw bed for recording vocals"
          >
            {bounceBusy ? "…" : "⬇ BEAT ONLY"}
          </button>
        </div>
      )}
      {takeProfile && (
        <div className="intent-take-card" role="status" aria-label="Vocal take analysis">
          <span className="intent-take-lines">{summarizeVocalProfile(takeProfile).join(" · ")}</span>
          {(() => {
            // The comp strip: when two-plus takes are analyzed, the plan
            // shows who WINS each bar (the singer keeps every best moment).
            const plan = takeHistory.length >= 2 ? planVocalComp(takeHistory.map((h) => h.profile)) : null;
            if (!plan) return null;
            const labels = takeHistory.map((_, index) => `Take ${String.fromCharCode(65 + index)}`);
            return (
              <>
                <VocalCompStrip plan={plan} labels={labels} />
                <div style={{ marginTop: 4 }}>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={compBusy || busy || plan.sungBars === 0}
                    onClick={() => {
                      if (compBusy) return;
                      setCompBusy(true);
                      try {
                        const cmd = applyVocalCompCommand(services.store.getDoc(), takeHistory, plan);
                        services.store.execute(cmd);
                        setStatus(`✓ ${cmd.label} (one undo step)`);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      } finally {
                        setCompBusy(false);
                      }
                    }}
                    title={
                      plan.sungBars === 0
                        ? "No bar has a sung take to comp — analyze takes that actually sing"
                        : "Assemble the winning bars into one comped vocal — one undo step"
                    }
                  >
                    {compBusy ? "…" : "🎹 BUILD COMP"}
                  </button>
                </div>
              </>
            );
          })()}
          <div className="intent-take-actions">
            <button
              type="button"
              className="btn btn-small"
              disabled={!takeProfile.keyMeasured}
              onClick={applyTakeKey}
              title="Set the project key from the take (transposes melodic notes, one undo step)"
            >
              KEY
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={!takeProfile.tempoMeasured}
              onClick={() => applyTakeTempo(false)}
              title="Match the transport tempo to the take flow (one undo step)"
            >
              TEMPO
            </button>
            {takeProfile.tempoAltBpm ? (
              <button
                type="button"
                className="btn btn-small"
                onClick={() => applyTakeTempo(true)}
                title={`Apply the alternative reading (${takeProfile.tempoAltBpm} BPM half/double-time feel, one undo step)`}
              >
                ALT
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-small"
              disabled={!takeProfile.measured || songBusy || busy}
              onClick={() => void generateSong()}
              title="Build a SONG bent to this take — sections follow the phrasing, mix opens the vocal pocket (needs a text prompt)"
            >
              ♪ SONG
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={!takeProfile || !takeRef || busy}
              onClick={applyTakeHook}
              title="⭐ Make a HOOK from this take — a pitched-up vocalchop track playing YOUR voice, notes follow the measured phrases (one undo step)"
            >
              ⭐ HOOK
            </button>
            <button
              type="button"
              className="btn btn-small intent-take-clear"
              onClick={clearTake}
              aria-label="Clear take analysis"
              title="Clear the take analysis"
            >
              ×
            </button>
          </div>
        </div>
      )}
      {bankCompliance.length > 0 && (
        <div className="intent-compliance" aria-label="Brief compliance">
          {bankCompliance.map((item) => (
            <span
              key={item.id}
              className={
                "intent-compliance-item" +
                (item.satisfied === false ? " bad" : item.satisfied === true ? " ok" : " muted")
              }
              title={
                item.detail ??
                (item.satisfied === true
                  ? "splnené"
                  : item.satisfied === false
                    ? "porušené"
                    : "vynútené plánom / nezadané")
              }
            >
              {item.satisfied === false ? "✗" : item.satisfied === true ? "✓" : "·"} {item.label}
              {item.detail && item.satisfied !== true ? ` (${item.detail})` : ""}
            </span>
          ))}
        </div>
      )}
      {bankResult && (
        <CandidateLaneReceipt
          plan={bankResult.plan}
          candidates={bankResult.bank ?? []}
          warnings={bankResult.diagnostics.warnings}
          selection={bankResult.selection}
        />
      )}
      {sectionProposal && (
        <div className="section-proposal" aria-label="Section change proposal">
          <span className="section-proposal-label">↻ {sectionProposal.label}</span>
          <span className="section-proposal-actions">
            <button
              type="button"
              className="btn btn-small"
              title={sectionPlaying ? "Stop náhľad" : "Náhľad upravenej sekcie"}
              onClick={() =>
                sectionPlaying
                  ? (stopAudition(), setSectionPlaying(false))
                  : void auditionSectionProposal(sectionProposal.render)
              }
            >
              {sectionPlaying ? "■" : "▶"}
            </button>
            <button type="button" className="btn btn-small section-proposal-apply" onClick={confirmSectionProposal}>
              ✓ POTVRDIŤ
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={dismissSectionProposal}
              title="Decline — nothing changes"
            >
              ✗
            </button>
          </span>
        </div>
      )}
      <div className="intent-actions" aria-label="Harmony post-process">
        <button
          type="button"
          className="btn"
          title="Snap every lead-track note to the nearest chord-tone pitch of the chords track (one undo)"
          onClick={handleSnapToChords}
        >
          🎹 SADNI NA AKORDY
        </button>
      </div>
      {songSuggestions.length > 0 && !sectionProposal && (
        <div className="song-suggestions" aria-label="Evidence-based section suggestions">
          {songSuggestions.map((suggestion) => (
            <button
              key={`${suggestion.role}:${suggestion.attribute}`}
              type="button"
              className="song-suggestion-chip"
              title={`${suggestion.reason} — spusti náhľad úpravy`}
              onClick={() => applySongSuggestion(suggestion)}
            >
              ⟡ {suggestion.reason} — navrhnúť {suggestion.attribute} +{suggestion.delta}
            </button>
          ))}
        </div>
      )}
      {candidates && candidates.length > 1 && (
        <div className="intent-detected" aria-label="Candidate ranking explanation">
          Poradie zohľadňuje plnenie briefu aj mieru hudobnej odlišnosti; nejde o objektívnu známku.
        </div>
      )}
      {candidates && candidates.length > 0 && (
        <div className="intent-candidates" aria-label="Candidate bank">
          {candidates.map((candidate) => {
            const isWinner = candidate.candidateIndex === bankResult?.bank?.[0]?.candidateIndex;
            const isPlaying = playingIndex === candidate.candidateIndex;
            const isRendering = renderingIndex === candidate.candidateIndex;
            return (
              <div key={candidate.candidateIndex} className={`intent-candidate-row${isWinner ? " winner" : ""}`}>
                <button
                  type="button"
                  className="btn btn-small intent-audition-btn"
                  onClick={() => void toggleAudition(candidate)}
                  title={isPlaying ? "Stop audition" : "Audition this candidate"}
                >
                  {isRendering ? "…" : isPlaying ? "■" : "▶"}
                </button>
                <span className="intent-candidate-meta">
                  <span className="intent-candidate-index">#{candidates.indexOf(candidate) + 1}</span>
                  <span
                    className={`intent-candidate-source ${candidate.source}`}
                    title={
                      candidate.source === "symbolic-prior"
                        ? "PRIOR — drums came from the symbolic-prior model (semantic/v2/v3 conditioning on your prompt, falling back to the genre+style one-hot). The model chose the grid."
                        : "TPL — drums came from the groove template, not the model. Happens when the groove is outside the prior's fixed vocabulary and no semantic conditioning is available; the generator never guesses a grid, it falls back safely."
                    }
                  >
                    {candidate.source === "symbolic-prior" ? "PRIOR" : "TPL"}
                  </span>
                  {candidate.search && (
                    <span
                      className={`intent-candidate-lane ${candidate.search.lane}`}
                      title={`Search policy: ${candidate.search.mode}; family: ${candidate.search.family}${
                        candidate.search.melodyFamily ? `; melody: ${candidate.search.melodyFamily}` : ""
                      }${candidate.search.family === "personal-groove" ? "; selected for your learned groove preference" : ""}${
                        candidate.search.grooveId ? ` (${candidate.search.grooveId})` : ""
                      }${
                        candidate.search.melodyFamily === "evolving-hook"
                          ? "; repeating lead motif with alternating cadence space"
                          : ""
                      }`}
                    >
                      {candidate.search.lane.toUpperCase()}
                      {candidate.search.grooveId && " · GROOVE"}
                      {candidate.search.melodyFamily === "repeating-hook" && " · HOOK"}
                      {candidate.search.melodyFamily === "evolving-hook" && " · HOOK VARIATION"}
                    </span>
                  )}
                  {isWinner && <span className="intent-candidate-win">★ best</span>}
                  {candidate.status === "repaired" && <span className="intent-candidate-fixed">fixed</span>}
                </span>
                <button
                  type="button"
                  className="btn btn-small intent-use-btn"
                  onClick={() => useCandidate(candidate)}
                  title="Apply this candidate to the project (one undo step)"
                >
                  USE
                </button>
                {!window.kyxDesktop?.isDesktop && (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      if (!previewDocRef.current || services.store.getDoc() !== previewDocRef.current) {
                        setError("Návrh je zastaraný — projekt sa zmenil počas náhľadu. Vygeneruj znova.");
                        return;
                      }
                      setAudiotoolExport({
                        candidateIndex: candidate.candidateIndex,
                        pattern: candidate.pattern,
                        sourceDoc: doc,
                      });
                    }}
                    title="Review and explicitly send this exact candidate to an Audiotool project"
                  >
                    AUDIOTOOL
                  </button>
                )}
              </div>
            );
          })}
          <p className="intent-candidate-legend">
            <span className="intent-candidate-source symbolic-prior">PRIOR</span> bicie z modelu
            {" · "}
            <span className="intent-candidate-source template">TPL</span> bicie zo šablóny — groove je mimo slovníka
            prioru a bez sémantického podmienenia. Generátor nikdy nedohaduje mriežku, bezpečne padá späť.
          </p>
        </div>
      )}
      {audiotoolExport && (
        <Suspense
          fallback={
            <div className="intent-song-draft" role="status">
              Načítavam Audiotool connector…
            </div>
          }
        >
          <AudiotoolNexusExport
            key={audiotoolExport.candidateIndex}
            pattern={audiotoolExport.pattern}
            tracks={audiotoolExport.sourceDoc.tracks}
            timeSignature={audiotoolExport.sourceDoc.timeSignature}
            sourceBpm={audiotoolExport.sourceDoc.bpm}
            candidateLabel={`#${audiotoolExport.candidateIndex + 1}`}
            isSourceCurrent={() => services.store.getDoc() === audiotoolExport.sourceDoc}
            onClose={() => setAudiotoolExport(null)}
          />
        </Suspense>
      )}
      {bankResult && candidates && candidates.length > 1 && (
        <ProducerDnaCompare
          project={doc}
          result={bankResult}
          onAudition={(candidate) => {
            void toggleAudition(candidate);
          }}
        />
      )}
      {candidates && candidates.length === 0 && bankResult?.proposal && (
        <button type="button" className="btn intent-generate-btn" onClick={() => useCandidate(null)}>
          USE RESULT
        </button>
      )}
      {ghosts.length > 0 && (
        <div className="intent-song-draft" aria-label="Ghost versions">
          <div className="intent-detected">👻 Ghosts — every USE remembered. Audition takes, pick A/B, morph.</div>
          <div className="intent-song-sections" aria-label="Ghost takes">
            {ghosts.map((ghost) => {
              const isPlaying = ghostPlayingId === ghost.id;
              const isRendering = ghostRenderingId === ghost.id;
              return (
                <div key={ghost.id} className="intent-candidate-row">
                  <button
                    type="button"
                    className="btn btn-small intent-audition-btn"
                    disabled={isRendering}
                    onClick={() => void toggleGhostAudition(ghost)}
                    title={isPlaying ? `Stop ${ghost.label}` : `Audition ${ghost.label}`}
                  >
                    {isRendering ? "…" : isPlaying ? "■" : "▶"}
                  </button>
                  <span className="intent-candidate-score" title={ghost.prompt ?? ghost.label}>
                    {ghost.label} · {new Date(ghost.createdAt).toLocaleTimeString()}
                    {ghostAId === ghost.id ? " · [A]" : ""}
                    {ghostBId === ghost.id ? " · [B]" : ""}
                  </span>
                  <button
                    type="button"
                    className={`btn btn-small${ghostAId === ghost.id ? " intent-use-btn" : ""}`}
                    onClick={() => setGhostAId(ghost.id)}
                    title="Use this take as morph source A"
                  >
                    A
                  </button>
                  <button
                    type="button"
                    className={`btn btn-small${ghostBId === ghost.id ? " intent-use-btn" : ""}`}
                    onClick={() => setGhostBId(ghost.id)}
                    title="Use this take as morph source B"
                  >
                    B
                  </button>
                  <button
                    type="button"
                    className="btn btn-small intent-use-btn"
                    onClick={() => restoreGhost(ghost)}
                    title="Restore this take into the active pattern (one undo step)"
                  >
                    USE
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => dropGhost(ghost)}
                    title="Forget this ghost"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
          <div className="intent-share-actions" aria-label="Morph controls">
            <input
              type="range"
              min={0}
              max={100}
              value={morphT}
              onChange={(e) => setMorphT(Number(e.target.value))}
              aria-label="Morph position A to B"
              title={`Morph ${morphT}% from A to B`}
              style={{ flex: 1 }}
            />
            <span className="intent-candidate-score">{morphT}%</span>
            <button
              type="button"
              className="btn btn-small"
              disabled={morphRendering}
              onClick={() => {
                if (morphPlaying) {
                  stopAudition();
                  setMorphPlaying(false);
                  return;
                }
                void previewMorph();
              }}
              title="Audition the A⟷B blend at the slider position"
            >
              {morphRendering ? "…" : morphPlaying ? "■" : "▶ MORPH"}
            </button>
            <button
              type="button"
              className="btn btn-small intent-use-btn"
              onClick={useMorph}
              title="Apply the A⟷B blend into the active pattern (ghosted as a new take)"
            >
              USE MORPH
            </button>
          </div>
        </div>
      )}
      {theatre && (
        <div className="intent-theatre" aria-label="Session theatre — hired AI producers">
          <div className="intent-theatre-head">
            <span className="intent-theatre-title">🎬 SESSION THEATRE</span>
            <span className="intent-candidate-score">
              {theatreBusy
                ? "kapela nahráva — sleduj session…"
                : theatreWinner !== null
                  ? "slepé finále vyhodnotené — víťaz je dole v drafte"
                  : theatrePair
                    ? "SLEPÉ FINÁLE — prehraj Take A a Take B, hlasuj LEPŠIE"
                    : "session hotová"}
            </span>
          </div>
          <div className="intent-theatre-cast">
            {theatre.map((take, i) => {
              const masked = theatreWinner === null && theatrePair !== null;
              const inPair = theatrePair != null && (theatrePair.a === i || theatrePair.b === i);
              const pairLabel = theatrePair?.a === i ? "A" : "B";
              const isWinner = theatreWinner === i;
              return (
                <div
                  key={`${take.run.producerSlug}|${take.run.seed}`}
                  className={`intent-theatre-card${isWinner ? " intent-theatre-card-winner" : ""}${
                    inPair && masked ? " intent-theatre-card-duel" : ""
                  }`}
                >
                  {masked ? (
                    <span className="intent-theatre-name">
                      🎭 Take {pairLabel}
                      {inPair ? "" : " (čaká)"}
                    </span>
                  ) : (
                    <span className="intent-theatre-name">
                      {take.run.avatar} {take.run.name}
                      {isWinner ? " 👑" : ""}
                    </span>
                  )}
                  {!masked && <span className="intent-theatre-tagline">{take.run.tagline}</span>}
                  <span className="intent-theatre-stage">
                    {take.failed ? `⚠ ${take.failed}` : theatreBusy || take.buffer ? take.label : "čaká v zelené"}
                  </span>
                  {take.buffer && (
                    <span className="intent-theatre-actions">
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={theatreBusy}
                        onClick={() => playTheatreTake(i)}
                        title={masked ? `Audition Take ${pairLabel}` : `Audition ${take.run.name}`}
                      >
                        {theatrePlaying === i ? "■" : "▶"}
                      </button>
                      {inPair && masked && (
                        <button
                          type="button"
                          className="btn btn-small intent-use-btn"
                          disabled={theatreBusy}
                          onClick={() => voteTheatre(i)}
                          title="Tento take je lepší — postupuje do ďalšieho kola"
                        >
                          LEPŠIE
                        </button>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {theatreWinner !== null && theatre[theatreWinner] && (
            <div className="intent-theatre-retake">
              <input
                value={theatreRetake}
                onChange={(e) => setTheatreRetake(e.target.value)}
                placeholder={`pripomienka pre ${theatre[theatreWinner].run.name} — „menej hi-hatov“, „hraj užšie“… a RETAKE`}
                disabled={theatreBusy}
                aria-label="Retake note for the winning producer"
              />
              <button
                type="button"
                className="btn btn-small"
                disabled={theatreBusy || busy || songBusy}
                onClick={() => void retakeTheatreWinner()}
                title="Nový draft od víťaza (pripomienka mení prompt, RETAKE mení seed) — potom slepé finále znova"
              >
                🎬 RETAKE
              </button>
            </div>
          )}
        </div>
      )}
      {songDraft && (
        <div className="intent-song-draft" aria-label="Song draft preview">
          <div className="intent-candidate-row winner">
            <button
              type="button"
              className="btn btn-small intent-audition-btn"
              disabled={songRendering || !songBufferRef.current}
              onClick={toggleSongAudition}
              title={songPlaying ? "Stop song audition" : "Audition the full song"}
            >
              {songRendering ? "…" : songPlaying ? "■" : "▶"}
            </button>
            <span className="intent-candidate-meta">
              <span className="intent-candidate-index">{songDraft.activeBuild.name}</span>
              <span className="intent-candidate-score">
                {songDraft.activeBuild.sections.length} sections · {songDraft.activeBuild.totalBars} bars
                {songDraft.lengthNote} · {Math.round(songDraft.activeBuild.resolvedBpm ?? 120)} BPM ·{" "}
                {songDraft.activeBuild.candidateCount} candidates/section
                {songDraft.activeLane
                  ? ` · ${songDraft.activeLane.toUpperCase()} full-song lane`
                  : " · best per section"}
                {songDraft.loudnessApplied &&
                  (songDraft.measuredAfter != null
                    ? ` · plays ≈${songDraft.measuredAfter} LUFS`
                    : " · loudness trim set")}
              </span>
            </span>
            {!songDraft.loudnessApplied && songDraft.trimDb !== 0 && songDraft.loudnessRecommendation && (
              <span className="loudness-recommendation" aria-label="Loudness recommendation">
                <span className="loudness-recommendation-text">
                  🔊 {songDraft.loudnessRecommendation.evidence} · cieľ {songDraft.loudnessRecommendation.goal} —{" "}
                  <b>navrhovaný trim {songDraft.trimDb} dB</b> ({songDraft.loudnessRecommendation.tradeOff})
                </span>
                <button
                  type="button"
                  className="btn btn-small section-proposal-apply"
                  disabled={songRendering}
                  onClick={() => void acceptLoudnessTrim()}
                >
                  ✓ PRIJAŤ TRIM
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={songRendering}
                  onClick={declineLoudnessTrim}
                  title="USE installs the untrimmed version"
                >
                  ✗
                </button>
              </span>
            )}
            <button
              type="button"
              className="btn btn-small intent-use-btn"
              disabled={songBusy || songRendering}
              onClick={() => void useSongDraft()}
              title="Apply this song to the project (song + mix + loudness, undoable)"
            >
              USE SONG
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={songBusy}
              onClick={discardSongDraft}
              title="Discard this draft — nothing is applied"
            >
              DROP
            </button>
          </div>
          {songDraft.result.build.candidateCount > 1 && (
            <div className="intent-share-actions" aria-label="Full-song directions">
              <button
                type="button"
                className={`btn btn-small${songDraft.activeLane === null ? " intent-use-btn" : ""}`}
                aria-pressed={songDraft.activeLane === null}
                disabled={songBusy || songRendering}
                onClick={() => void selectSongLane(null)}
                title="Use the current best-ranked choice independently selected for each section"
              >
                BEST PER SECTION
              </button>
              {songDraft.result.build.alternatives.map((alternative) => {
                const modeNote =
                  alternative.mode === "cold-start"
                    ? " · cold start"
                    : alternative.mode === "personalized"
                      ? " · learned taste"
                      : alternative.mode === "mixed"
                        ? " · mixed context"
                        : "";
                const label = `${alternative.lane.toUpperCase()}${modeNote}`;
                return (
                  <button
                    key={alternative.lane}
                    type="button"
                    className={`btn btn-small${songDraft.activeLane === alternative.lane ? " intent-use-btn" : ""}`}
                    aria-label={`Use ${label} full-song direction`}
                    aria-pressed={songDraft.activeLane === alternative.lane}
                    disabled={songBusy || songRendering}
                    onClick={() => void selectSongLane(alternative.lane)}
                    title={`Audition the complete ${alternative.lane} direction, with the same lane carried through every section`}
                  >
                    {label}
                  </button>
                );
              })}
              <small>
                Only complete, musically distinct alternatives are shown. USE stays disabled until a selected lane
                renders.
              </small>
            </div>
          )}
          {songDraft.result.build.candidateCount > 1 && songDraft.result.build.alternatives.length === 0 && (
            <div className="intent-detected" role="status">
              No complete alternate lane survived every section; this song uses the best-ranked candidate per section.
            </div>
          )}
          {songDraft.audioReview && (
            <div className="intent-song-audio-review" aria-label="Technical audio review">
              <div className="intent-song-audio-metrics">
                <strong>RENDER CHECK</strong>
                <span>Peak {songDraft.audioReview.peakDbfs.toFixed(1)} dBFS</span>
                <span>RMS {songDraft.audioReview.rmsDbfs.toFixed(1)} dBFS</span>
                <span>Crest {songDraft.audioReview.crestFactor.toFixed(2)}:1</span>
                <span title="Low-frequency energy proxy below approximately 200 Hz">
                  Bass {Math.round(songDraft.audioReview.lowBandRatio * 100)}%
                </span>
              </div>
              {songDraft.audioReview.findings.length > 0 ? (
                <ul>
                  {songDraft.audioReview.findings.map((finding) => (
                    <li key={finding.code} title={finding.evidence}>
                      {finding.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <span>No signal-health flags detected.</span>
              )}
              <small>Technical checks only — these metrics do not grade musicality.</small>
            </div>
          )}
          <div className="intent-song-sections" aria-label="Song sections">
            {songDraft.activeBuild.sections.map((section) => {
              const id = section.pattern.id;
              const isPlaying = playingSectionId === id;
              const isRendering = renderingSectionId === id;
              return (
                <div key={id} className="intent-candidate-row">
                  <button
                    type="button"
                    className="btn btn-small intent-audition-btn"
                    disabled={songBusy || songRendering || isRendering}
                    onClick={() => void toggleSectionAudition(section)}
                    title={isPlaying ? `Stop ${section.label} preview` : `Audition ${section.label} alone`}
                  >
                    {isRendering ? "…" : isPlaying ? "■" : "▶"}
                  </button>
                  <span className="intent-candidate-score" title={section.roles.join("+")}>
                    {section.label} · {section.bars}b · {section.roles.join("+")}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="intent-share-actions" aria-label="Revise song draft">
            <button
              type="button"
              className="btn btn-small"
              disabled={songBusy}
              onClick={() => void reviseSongDraft("energy", 0.15)}
              title="Same seed, more energy — audition again before USE"
            >
              E+
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={songBusy}
              onClick={() => void reviseSongDraft("energy", -0.15)}
              title="Same seed, calmer — audition again before USE"
            >
              E−
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={songBusy}
              onClick={() => void reviseSongDraft("density", 0.15)}
              title="Same seed, denser — audition again before USE"
            >
              D+
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={songBusy}
              onClick={() => void reviseSongDraft("density", -0.15)}
              title="Same seed, sparser — audition again before USE"
            >
              D−
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={songBusy}
              onClick={() => void buildSongDraft(parseSectionRequests(songTextRef.current) ?? undefined)}
              title="Fresh seed — a different take on the same sentence"
            >
              ↻ FRESH
            </button>
          </div>
          <div className="intent-detected">
            After USE: type “make bridge more energetic” + ⚡ DO IT to revise one section in place.
          </div>
        </div>
      )}
    </div>
  );
}

function rankerModeLabel(): string {
  const mode = rankerMode();
  return mode === "active" ? "ONNX active" : mode === "shadow" ? "shadow (heuristic)" : "ranker off";
}
