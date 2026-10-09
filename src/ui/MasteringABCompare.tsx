import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BufferSummary } from "../audio-engine/metering";
import { formatAuditionTrim, getLoudnessMatchGain, resolveLoudnessMatchTarget } from "../mastering/audition";
import { analyzeMasterBufferAsync } from "../mastering/analysisClient";
import { tryAcquireMasteringWork } from "../mastering/workGate";
import { awaitMasteringSampleBankReady } from "../mastering/readiness";
import { resolveDeliveryTarget } from "../mastering/profiles";
import {
  captureMasteringSnapshot,
  loadMasteringABSession,
  replaceSnapshot,
  saveMasteringABSession,
  type MasteringABSession,
  type MasteringABSlot,
} from "../mastering/snapshots";
import { projectRevisionIdFor } from "../mastering/report";
import { estimateRenderPcmBytes, renderProject } from "../rendering/renderer";
import type { ProjectDocument } from "../project-model/types";
import { useServices } from "./context";
import { MasteringAssistant } from "./MasteringAssistant";
import { MasteringLevelMatchControl } from "./MasteringLevelMatchControl";
import { MasteringReferenceCompare } from "./MasteringReferenceCompare";
import {
  MASTERING_RENDER_SAMPLE_RATE_LABELS,
  MASTERING_RENDER_SAMPLE_RATES,
  type MasteringRenderSampleRate,
} from "../mastering/sampleRates";

interface ComparedMaster {
  buffer: AudioBuffer;
  summary: BufferSummary;
}

interface Comparison {
  revisionId: string;
  sampleBankRevision: number;
  snapshotAId: string;
  snapshotBId: string;
  sampleRate: number;
  a: ComparedMaster;
  b: ComparedMaster;
}

interface LiveBypassMatch {
  revisionId: string;
  sampleBankRevision: number;
  sampleRate: number;
  processedLufs: number;
  bypassedLufs: number;
}

type BlindPreference = "first" | "second" | "none";

interface BlindListenSession {
  first: MasteringABSlot;
  preference: BlindPreference | null;
  revealed: boolean;
}

const MAX_COMPARE_BYTES = 256 * 1024 * 1024;
const MAX_SHARED_COMPARE_BYTES = 320 * 1024 * 1024;

function formatDb(value: number, suffix: string): string {
  return Number.isFinite(value) && value > -120 ? `${value.toFixed(1)} ${suffix}` : `−∞ ${suffix}`;
}

function formatMeasuredLufs(value: number): string {
  return Number.isFinite(value) && value > -119 ? `${value.toFixed(1)} LUFS-I` : "not measured";
}

function randomizedFirstSlot(): MasteringABSlot {
  const draw = new Uint8Array(1);
  let randomized = false;
  try {
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      globalThis.crypto.getRandomValues(draw);
      randomized = true;
    }
  } catch {
    // The local fallback still gives a randomized audition order if Web Crypto is unavailable.
  }
  if (!randomized) draw[0] = Math.floor(Math.random() * 256);
  return draw[0]! % 2 === 0 ? "A" : "B";
}

function sameComparison(
  comparison: Comparison | null,
  revisionId: string,
  aId: string | undefined,
  bId: string | undefined,
  sampleRate: number,
  sampleBankRevision: number,
): comparison is Comparison {
  return Boolean(
    comparison &&
    aId &&
    bId &&
    comparison.revisionId === revisionId &&
    comparison.snapshotAId === aId &&
    comparison.snapshotBId === bId &&
    comparison.sampleRate === sampleRate &&
    comparison.sampleBankRevision === sampleBankRevision,
  );
}

function currentRevision(services: ReturnType<typeof useServices>, projectId: string): string | null {
  const current = services.store.getDoc();
  return current.id === projectId ? projectRevisionIdFor(current) : null;
}

export function MasteringABCompare({
  doc,
  revisionId,
  blockNewWork = false,
  onBusyChange,
}: {
  doc: ProjectDocument;
  revisionId: string;
  blockNewWork?: boolean;
  onBusyChange?(busy: boolean): void;
}) {
  const services = useServices();
  const [sampleBankRevision, setSampleBankRevision] = useState(services.bank.revision);
  const [session, setSession] = useState<MasteringABSession>(() => loadMasteringABSession(doc));
  const [sampleRate, setSampleRate] = useState<MasteringRenderSampleRate>(48_000);
  const [levelMatch, setLevelMatch] = useState(true);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [liveBypassMatch, setLiveBypassMatch] = useState<LiveBypassMatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [bypassMatchBusy, setBypassMatchBusy] = useState(false);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [referenceExcerptPending, setReferenceExcerptPending] = useState(false);
  const [status, setStatus] = useState("");
  const [bypassMatchStatus, setBypassMatchStatus] = useState("");
  const [error, setError] = useState("");
  const [storageNotice, setStorageNotice] = useState("");
  const [playing, setPlaying] = useState<MasteringABSlot | null>(null);
  const [blindListen, setBlindListen] = useState<BlindListenSession | null>(null);
  const [masterTestToneActive, setMasterTestToneActive] = useState(false);
  const [masterTestToneStatus, setMasterTestToneStatus] = useState("");
  const [referenceBytes, setReferenceBytes] = useState(0);
  const [referenceProjectBytes, setReferenceProjectBytes] = useState(0);
  const [assistantBytes, setAssistantBytes] = useState(0);
  const [abRenderEpoch, setAbRenderEpoch] = useState(0);
  const [comparisonEpoch, setComparisonEpoch] = useState(0);
  const playingRef = useRef<MasteringABSlot | null>(null);
  const masterTestToneMountedRef = useRef(false);
  const masterTestToneGenerationRef = useRef(0);
  const comparisonControlsBusy = busy || bypassMatchBusy || assistantBusy || referenceBusy;
  const comparisonWorkBusy = comparisonControlsBusy || referenceExcerptPending;
  const reportReferenceBusy = useCallback((referenceWorkBusy: boolean, excerptPending: boolean) => {
    setReferenceBusy(referenceWorkBusy);
    setReferenceExcerptPending(excerptPending);
  }, []);
  const cancelReferenceLoudnessMatch = useCallback(() => setLevelMatch(false), []);
  const [masterBypassed, setMasterBypassed] = useState(() => services.engine.isMasterBypassed());
  const abortRef = useRef<AbortController | null>(null);
  const bypassMatchAbortRef = useRef<AbortController | null>(null);
  const observedBankRevisionRef = useRef(sampleBankRevision);
  playingRef.current = playing;
  const activeSession = session.projectId === doc.id ? session : loadMasteringABSession(doc);
  const snapshotA = activeSession.a;
  const snapshotB = activeSession.b;
  const comparisonReady = sameComparison(
    comparison,
    revisionId,
    snapshotA?.id,
    snapshotB?.id,
    sampleRate,
    sampleBankRevision,
  );
  const matchTarget = useMemo(() => {
    if (!comparisonReady) return null;
    return resolveLoudnessMatchTarget([comparison.a.summary.lufsIntegrated, comparison.b.summary.lufsIntegrated]);
  }, [comparison, comparisonReady]);
  const gainA = comparisonReady
    ? getLoudnessMatchGain(comparison.a.summary.lufsIntegrated, matchTarget, levelMatch)
    : 1;
  const gainB = comparisonReady
    ? getLoudnessMatchGain(comparison.b.summary.lufsIntegrated, matchTarget, levelMatch)
    : 1;
  const liveBypassMatchReady = Boolean(
    liveBypassMatch &&
    liveBypassMatch.revisionId === revisionId &&
    liveBypassMatch.sampleBankRevision === sampleBankRevision &&
    liveBypassMatch.sampleRate === sampleRate,
  );
  const liveBypassMatchTarget =
    liveBypassMatchReady && liveBypassMatch
      ? resolveLoudnessMatchTarget([liveBypassMatch.processedLufs, liveBypassMatch.bypassedLufs])
      : null;
  const liveBypassProcessedGain =
    liveBypassMatchReady && liveBypassMatch
      ? getLoudnessMatchGain(liveBypassMatch.processedLufs, liveBypassMatchTarget, liveBypassMatchTarget !== null)
      : 1;
  const liveBypassDryGain =
    liveBypassMatchReady && liveBypassMatch
      ? getLoudnessMatchGain(liveBypassMatch.bypassedLufs, liveBypassMatchTarget, liveBypassMatchTarget !== null)
      : 1;
  const comparisonBytes = comparison
    ? comparison.a.buffer.length * comparison.a.buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT +
      comparison.b.buffer.length * comparison.b.buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT
    : 0;

  useEffect(() => {
    if (session.projectId !== doc.id) setSession(loadMasteringABSession(doc));
  }, [doc, session.projectId]);

  useEffect(() => services.bank.onRevisionChanged(setSampleBankRevision), [services.bank]);

  useEffect(() => {
    abortRef.current?.abort();
    masterTestToneGenerationRef.current += 1;
    services.engine.stopMasterMonitorTestTone();
    setMasterTestToneActive(false);
    setMasterTestToneStatus("");
    if (playingRef.current) {
      services.engine.stopPreview();
      setPlaying(null);
    }
    setComparison(null);
    setBlindListen(null);
    setComparisonEpoch((epoch) => epoch + 1);
    setStatus("");
    setError("");
  }, [revisionId, snapshotA?.id, snapshotB?.id, sampleRate, sampleBankRevision, services.engine]);

  useEffect(() => {
    if (observedBankRevisionRef.current === sampleBankRevision) return;
    observedBankRevisionRef.current = sampleBankRevision;
    if (comparison && comparison.sampleBankRevision !== sampleBankRevision) {
      setStatus("Sample bank changed. Render A/B again to compare the current project audio.");
      setError("");
    }
  }, [comparison, sampleBankRevision]);

  useEffect(() => () => abortRef.current?.abort(), [services.engine]);

  useEffect(() => {
    masterTestToneMountedRef.current = true;
    return () => {
      masterTestToneMountedRef.current = false;
      masterTestToneGenerationRef.current += 1;
      services.engine.stopMasterMonitorTestTone();
    };
  }, [services.engine]);

  useEffect(() => {
    onBusyChange?.(comparisonWorkBusy);
  }, [comparisonWorkBusy, onBusyChange]);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    bypassMatchAbortRef.current?.abort();
    setLiveBypassMatch(null);
    setBypassMatchStatus("");
    services.engine.setMasterBypassMatchGains(1, 1);
  }, [revisionId, sampleBankRevision, sampleRate, services.engine]);

  useEffect(() => {
    if (!liveBypassMatch) return;
    services.engine.setMasterBypassMatchGains(
      liveBypassMatchReady ? liveBypassProcessedGain : 1,
      liveBypassMatchReady ? liveBypassDryGain : 1,
    );
  }, [liveBypassDryGain, liveBypassMatch, liveBypassMatchReady, liveBypassProcessedGain, services.engine]);

  useEffect(
    () => () => {
      bypassMatchAbortRef.current?.abort();
      services.engine.setMasterBypassMatchGains(1, 1, true);
    },
    [services.engine],
  );

  useEffect(() => {
    if (playing === "A") services.engine.updateMasterComparePreview(gainA, false);
    if (playing === "B") services.engine.updateMasterComparePreview(gainB, false);
  }, [gainA, gainB, playing, services.engine]);

  const updateSession = (next: MasteringABSession) => {
    setSession(next);
    const saved = saveMasteringABSession(next);
    setStorageNotice(
      saved
        ? "A/B snapshots are saved for this browser tab."
        : "Browser session storage is unavailable; snapshots will be lost when this panel closes.",
    );
  };

  const reportReferenceBytes = useCallback((bytes: number) => setReferenceBytes(bytes), []);
  const reportReferenceProjectBytes = useCallback((bytes: number) => setReferenceProjectBytes(bytes), []);
  const reportAssistantBytes = useCallback((bytes: number) => setAssistantBytes(bytes), []);

  const capture = (slot: MasteringABSlot) => {
    abortRef.current?.abort();
    const liveDoc = services.store.getDoc();
    if (liveDoc.id !== doc.id) return;
    const base = activeSession.projectId === liveDoc.id ? activeSession : loadMasteringABSession(liveDoc);
    const next = replaceSnapshot(base, slot, captureMasteringSnapshot(liveDoc.master));
    updateSession(next);
  };

  const clearSlot = (slot: MasteringABSlot) => {
    abortRef.current?.abort();
    const next = replaceSnapshot(activeSession, slot, null);
    updateSession(next);
  };

  const renderComparison = async () => {
    if (!snapshotA || !snapshotB || comparisonWorkBusy || blockNewWork || blindListen) return;
    const revisionAtStart = currentRevision(services, doc.id);
    let bankRevisionAtStart = services.bank.revision;
    if (!revisionAtStart || revisionAtStart !== revisionId) {
      setError("Projekt sa práve zmenil. Počkaj na aktualizáciu pracoviska a skús render znova.");
      return;
    }
    const releaseMasteringWork = tryAcquireMasteringWork();
    if (!releaseMasteringWork) {
      setError("Another MASTER audio task is in progress. Try the comparison again when it finishes.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    services.engine.stopPreview();
    setPlaying(null);
    setBusy(true);
    setError("");
    setComparison(null);
    setAbRenderEpoch((epoch) => epoch + 1);
    setComparisonEpoch((epoch) => epoch + 1);
    try {
      setStatus("Preparing sample audio for a consistent A/B render…");
      await awaitMasteringSampleBankReady(services.core.initialSampleBankHydration, controller.signal);
      bankRevisionAtStart = services.bank.revision;
      if (currentRevision(services, doc.id) !== revisionAtStart) {
        throw new Error("Projekt sa počas prípravy sample banku zmenil. Starý A/B render bol zahodený.");
      }
      const docA = { ...doc, master: snapshotA.config };
      const docB = { ...doc, master: snapshotB.config };
      const estimatedPairBytes =
        estimateRenderPcmBytes(docA, { mode: "song", sampleRate }) +
        estimateRenderPcmBytes(docB, { mode: "song", sampleRate });
      const otherPcmBytes = referenceBytes + referenceProjectBytes + assistantBytes;
      if (estimatedPairBytes > MAX_COMPARE_BYTES || estimatedPairBytes + otherPcmBytes > MAX_SHARED_COMPARE_BYTES) {
        throw new Error(
          `This A/B render needs ${(estimatedPairBytes / 1024 / 1024).toFixed(0)} MiB plus ${(otherPcmBytes / 1024 / 1024).toFixed(0)} MiB of other comparison audio. Clear a preview, shorten the song, or lower the sample rate if it exceeds the 320 MiB budget.`,
        );
      }
      const render = async (slot: MasteringABSlot, config: typeof snapshotA.config) => {
        setStatus(`Rendering ${slot} · SONG · ${sampleRate / 1000} kHz · Studio HQ…`);
        const renderDoc = { ...doc, master: config };
        const buffer = await renderProject(renderDoc, services.bank, {
          mode: "song",
          sampleRate,
          quality: "studio",
          masterBypassed: false,
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw new DOMException("Comparison cancelled", "AbortError");
        if (currentRevision(services, doc.id) !== revisionAtStart) {
          throw new Error("Projekt sa počas renderu zmenil. Stará A/B verzia bola zahodená.");
        }
        if (services.bank.revision !== bankRevisionAtStart) {
          throw new Error("Sample bank sa počas A/B renderu zmenil. Staré porovnanie bolo zahodené.");
        }
        return buffer;
      };

      const bufferA = await render("A", snapshotA.config);
      setStatus("Analyzing A · preparing mastering measurements…");
      const analysisA = await analyzeMasterBufferAsync(bufferA, resolveDeliveryTarget(snapshotA.config), {
        signal: controller.signal,
        onProgress: ({ progress, stage }) => setStatus(`Analyzing A · ${Math.round(progress * 100)}% · ${stage}…`),
      });
      const bufferB = await render("B", snapshotB.config);
      const actualPairBytes =
        bufferA.length * bufferA.numberOfChannels * Float32Array.BYTES_PER_ELEMENT +
        bufferB.length * bufferB.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
      if (actualPairBytes > MAX_COMPARE_BYTES || actualPairBytes + otherPcmBytes > MAX_SHARED_COMPARE_BYTES) {
        throw new Error(
          "A/B rendery prekročili dostupnú pamäť porovnania. Skús kratšiu skladbu alebo nižší sample rate.",
        );
      }
      setStatus("Analyzing B · preparing mastering measurements…");
      const analysisB = await analyzeMasterBufferAsync(bufferB, resolveDeliveryTarget(snapshotB.config), {
        signal: controller.signal,
        onProgress: ({ progress, stage }) => setStatus(`Analyzing B · ${Math.round(progress * 100)}% · ${stage}…`),
      });
      if (services.bank.revision !== bankRevisionAtStart) {
        throw new Error("Sample bank sa počas A/B analýzy zmenil. Staré porovnanie bolo zahodené.");
      }
      if (currentRevision(services, doc.id) !== revisionAtStart) {
        throw new Error("Projekt sa počas porovnania zmenil. Staré výsledky boli zahodené.");
      }
      setComparison({
        revisionId: revisionAtStart,
        sampleBankRevision: bankRevisionAtStart,
        snapshotAId: snapshotA.id,
        snapshotBId: snapshotB.id,
        sampleRate,
        a: { buffer: bufferA, summary: analysisA.measurements },
        b: { buffer: bufferB, summary: analysisB.measurements },
      });
      setStatus("Hotovo. Obe verzie používajú rovnaký SONG render a Studio HQ kvalitu.");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.includes("cancelled")) setStatus("Render bol zrušený.");
      else setError(message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
      releaseMasteringWork();
    }
  };

  const matchLiveBypassLoudness = async () => {
    if (comparisonWorkBusy || blockNewWork || blindListen) return;
    const sourceDoc = services.store.getDoc();
    const revisionAtStart = sourceDoc.id === doc.id ? projectRevisionIdFor(sourceDoc) : null;
    if (!revisionAtStart || revisionAtStart !== revisionId) {
      setError("Projekt sa práve zmenil. Počkaj na aktualizáciu pracoviska a skús meranie znova.");
      return;
    }

    const releaseMasteringWork = tryAcquireMasteringWork();
    if (!releaseMasteringWork) {
      setError("Another MASTER audio task is in progress. Try loudness matching again when it finishes.");
      return;
    }
    const controller = new AbortController();
    bypassMatchAbortRef.current = controller;
    let bankRevisionAtStart = services.bank.revision;
    const ensureCurrent = () => {
      if (controller.signal.aborted) throw new DOMException("Bypass loudness match cancelled", "AbortError");
      if (currentRevision(services, doc.id) !== revisionAtStart) {
        throw new Error("Projekt sa počas bypass merania zmenil. Výsledok bol zahodený.");
      }
      if (services.bank.revision !== bankRevisionAtStart) {
        throw new Error("Sample bank sa počas bypass merania zmenil. Výsledok bol zahodený.");
      }
    };

    setBypassMatchBusy(true);
    setBypassMatchStatus("Preparing a matched live-bypass audition…");
    setError("");
    try {
      await awaitMasteringSampleBankReady(services.core.initialSampleBankHydration, controller.signal);
      bankRevisionAtStart = services.bank.revision;
      ensureCurrent();

      const estimatedPcmBytes = estimateRenderPcmBytes(sourceDoc, { mode: "song", sampleRate });
      const otherPcmBytes = comparisonBytes + referenceBytes + referenceProjectBytes + assistantBytes;
      if (estimatedPcmBytes > MAX_COMPARE_BYTES || estimatedPcmBytes + otherPcmBytes > MAX_SHARED_COMPARE_BYTES) {
        throw new Error(
          `Bypass matching needs about ${(estimatedPcmBytes / 1024 / 1024).toFixed(0)} MiB for a SONG render plus ${(otherPcmBytes / 1024 / 1024).toFixed(0)} MiB of other comparison audio. Clear a preview, shorten the song, or lower the sample rate if it exceeds the 320 MiB comparison budget.`,
        );
      }

      const measure = async (label: string, masterBypassed: boolean): Promise<number> => {
        setBypassMatchStatus(`Rendering ${label} · SONG · ${sampleRate / 1000} kHz · Studio HQ…`);
        let buffer: AudioBuffer | null = await renderProject(sourceDoc, services.bank, {
          mode: "song",
          sampleRate,
          quality: "studio",
          masterBypassed,
          signal: controller.signal,
        });
        ensureCurrent();
        const outputBytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
        if (outputBytes > MAX_COMPARE_BYTES || outputBytes + otherPcmBytes > MAX_SHARED_COMPARE_BYTES) {
          throw new Error(
            "A bypass loudness render exceeded the available comparison memory. Shorten the song or lower the sample rate.",
          );
        }
        setBypassMatchStatus(`Analyzing ${label} loudness…`);
        let lastProgressStep = -1;
        const analysis = await analyzeMasterBufferAsync(buffer, resolveDeliveryTarget(sourceDoc.master), {
          signal: controller.signal,
          onProgress: ({ progress }) => {
            const step = Math.floor(progress * 10);
            if (step > lastProgressStep) {
              lastProgressStep = step;
              setBypassMatchStatus(`Analyzing ${label} loudness · ${Math.round(progress * 100)}%…`);
            }
          },
        });
        ensureCurrent();
        const loudness = analysis.measurements.lufsIntegrated;
        buffer = null;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        ensureCurrent();
        return loudness;
      };

      const processedLufs = await measure("processed master", false);
      const bypassedLufs = await measure("monitor bypass", true);
      const targetLufs = resolveLoudnessMatchTarget([processedLufs, bypassedLufs]);
      const processedGain = getLoudnessMatchGain(processedLufs, targetLufs, targetLufs !== null);
      const bypassedGain = getLoudnessMatchGain(bypassedLufs, targetLufs, targetLufs !== null);
      const result = {
        revisionId: revisionAtStart,
        sampleBankRevision: bankRevisionAtStart,
        sampleRate,
        processedLufs,
        bypassedLufs,
      };
      setLiveBypassMatch(result);
      setBypassMatchStatus(
        targetLufs === null
          ? "Loudness matching is unavailable for these readings; live bypass uses native monitor levels."
          : `Monitor match ready · processed master ${formatAuditionTrim(processedGain)} · bypass mix ${formatAuditionTrim(bypassedGain)}. This trim affects monitoring only.`,
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (controller.signal.aborted || (caught instanceof DOMException && caught.name === "AbortError")) {
        const previousMatchRemainsCurrent = Boolean(
          liveBypassMatch &&
          currentRevision(services, doc.id) === liveBypassMatch.revisionId &&
          services.bank.revision === liveBypassMatch.sampleBankRevision &&
          sampleRate === liveBypassMatch.sampleRate,
        );
        setBypassMatchStatus(
          previousMatchRemainsCurrent
            ? "Remeasurement was cancelled; the previous measured bypass match remains active."
            : "Bypass loudness matching was cancelled; live bypass uses native monitor levels.",
        );
      } else {
        setBypassMatchStatus(
          liveBypassMatchReady ? "Remeasurement failed; the previous measured bypass match remains active." : "",
        );
        setError(message);
      }
    } finally {
      if (bypassMatchAbortRef.current === controller) bypassMatchAbortRef.current = null;
      setBypassMatchBusy(false);
      releaseMasteringWork();
    }
  };

  const clearLiveBypassMatch = () => {
    bypassMatchAbortRef.current?.abort();
    setLiveBypassMatch(null);
    setBypassMatchStatus("Live bypass uses native monitor levels.");
    services.engine.setMasterBypassMatchGains(1, 1);
  };

  const play = (slot: MasteringABSlot) => {
    if (!comparisonReady) return;
    const side = slot === "A" ? comparison.a : comparison.b;
    const gain = slot === "A" ? gainA : gainB;
    services.engine.stopPreview();
    setPlaying(slot);
    services.engine.previewMasterCompare(side.buffer, gain, () => setPlaying(null));
  };

  const toggleMonitorBypass = () => {
    const next = !masterBypassed;
    services.engine.setMasterBypassed(next);
    setMasterBypassed(next);
  };

  const toggleMasterTestTone = () => {
    if (masterTestToneActive) {
      services.engine.stopMasterMonitorTestTone();
      setMasterTestToneStatus("Stopping test tone…");
      return;
    }
    if (playingRef.current) {
      services.engine.stopPreview();
      setPlaying(null);
    }
    const generation = ++masterTestToneGenerationRef.current;
    const result = services.engine.playMasterMonitorTestTone(2.5, () => {
      if (!masterTestToneMountedRef.current || generation !== masterTestToneGenerationRef.current) return;
      setMasterTestToneActive(false);
      setMasterTestToneStatus("Test tone ended.");
    });
    if (result.status === "error") {
      setMasterTestToneActive(false);
      setMasterTestToneStatus(result.message ?? "Could not start the master-path test tone.");
      return;
    }
    setMasterTestToneActive(true);
    setMasterTestToneStatus("Playing 440 Hz for up to 2.5 seconds. Toggle Live monitor bypass to compare paths.");
  };

  const stopComparePreview = () => {
    services.engine.stopPreview();
    setPlaying(null);
  };

  const startBlindListen = () => {
    if (!comparisonReady || comparisonWorkBusy || blockNewWork || blindListen) return;
    masterTestToneGenerationRef.current += 1;
    services.engine.stopMasterMonitorTestTone();
    setMasterTestToneActive(false);
    services.engine.stopPreview();
    setPlaying(null);
    setBlindListen({ first: randomizedFirstSlot(), preference: null, revealed: false });
  };

  const endBlindListen = () => {
    services.engine.stopPreview();
    setPlaying(null);
    setBlindListen(null);
  };

  const renderBlindSide = (label: "1" | "2", slot: MasteringABSlot) => {
    if (!comparison) return null;
    const side = slot === "A" ? comparison.a : comparison.b;
    const gain = slot === "A" ? gainA : gainB;
    const snapshot = slot === "A" ? snapshotA : snapshotB;
    return (
      <article className="master-ab-side master-ab-blind-side" aria-label={`Blind version ${label}`} key={label}>
        <header>
          <strong>VERSION {label}</strong>
          <span>{blindListen?.revealed ? `Snapshot ${slot}` : "Identity hidden"}</span>
        </header>
        {blindListen?.revealed ? (
          <>
            <dl>
              <div>
                <dt>Integrated</dt>
                <dd>{formatDb(side.summary.lufsIntegrated, "LUFS")}</dd>
              </div>
              <div>
                <dt>True peak</dt>
                <dd>{formatDb(side.summary.truePeakDb, "dBTP")}</dd>
              </div>
              <div>
                <dt>Audition trim</dt>
                <dd>{levelMatch && matchTarget === null ? "unavailable" : formatAuditionTrim(gain)}</dd>
              </div>
            </dl>
            <small>
              {snapshot ? `Captured ${new Date(snapshot.capturedAt).toLocaleString()}` : "Snapshot unavailable"}
            </small>
          </>
        ) : (
          <p>Measurements hidden until you reveal the snapshot identities.</p>
        )}
        <button type="button" onClick={() => play(slot)} disabled={!comparisonReady}>
          {playing === slot ? `Playing version ${label}…` : `Listen to version ${label}`}
        </button>
      </article>
    );
  };

  const renderSide = (slot: MasteringABSlot, side: ComparedMaster, gain: number) => {
    const snapshot = slot === "A" ? snapshotA : snapshotB;
    return (
      <article className="master-ab-side" aria-label={`Master snapshot ${slot}`}>
        <header>
          <strong>{slot}</strong>
          <span>{snapshot ? new Date(snapshot.capturedAt).toLocaleString() : ""}</span>
        </header>
        <dl>
          <div>
            <dt>Integrated</dt>
            <dd>{formatDb(side.summary.lufsIntegrated, "LUFS")}</dd>
          </div>
          <div>
            <dt>True peak</dt>
            <dd>{formatDb(side.summary.truePeakDb, "dBTP")}</dd>
          </div>
          <div>
            <dt>Audition trim</dt>
            <dd>{levelMatch && matchTarget === null ? "unavailable" : formatAuditionTrim(gain)}</dd>
          </div>
        </dl>
        <button type="button" onClick={() => play(slot)} disabled={!comparisonReady}>
          {playing === slot ? `Playing ${slot}…` : `Play ${slot}`}
        </button>
      </article>
    );
  };

  return (
    <section className="master-ab-section" aria-label="Master A/B compare">
      <header className="master-ab-heading">
        <div>
          <span className="mastering-panel-kicker">COMPARE</span>
          <h3>Master A/B</h3>
          <p>
            Snapshots contain the complete master setup, including profile and inserts. They stay in this browser tab
            and never change the project.
          </p>
        </div>
        {!blindListen && (
          <label className="master-ab-bypass">
            <input type="checkbox" checked={masterBypassed} onChange={toggleMonitorBypass} />
            <span>Live monitor bypass</span>
          </label>
        )}
      </header>
      {!blindListen && (
        <p className="master-ab-bypass-note">
          Bypass skips master trim and processing for live monitoring. The final limiter stays in the path with its
          current settings; exports use the saved master setup.
        </p>
      )}
      {!blindListen && (
        <section className="master-ab-monitor-tone" aria-label="Master output path test">
          <p>
            Play a quiet 440 Hz tone through the live master chain for 2.5 seconds. Stop transport playback first for a
            clean check; use native levels if bypass loudness matching is active. The tone never changes the project or
            its exports.
          </p>
          <div>
            <button
              type="button"
              onClick={toggleMasterTestTone}
              disabled={!masterTestToneActive && (comparisonWorkBusy || blockNewWork)}
            >
              {masterTestToneActive ? "Stop test tone" : "Play master-path test tone"}
            </button>
          </div>
          <p role="status" aria-live="polite" aria-atomic="true">
            {masterTestToneStatus}
          </p>
        </section>
      )}
      {!blindListen && (
        <section className="master-ab-bypass-match" aria-label="Live monitor bypass loudness match">
          <p>
            Measure full SONG LUFS-I for the processed master and bypass mix at the selected sample rate. Matching trims
            the louder monitor output after the safety limiter; MASTER meters and export remain untrimmed.
          </p>
          <div>
            <button
              type="button"
              onClick={() => void matchLiveBypassLoudness()}
              disabled={comparisonWorkBusy || blockNewWork || Boolean(blindListen)}
            >
              {bypassMatchBusy
                ? "Measuring bypass match…"
                : liveBypassMatchReady
                  ? "Re-measure bypass match"
                  : "Match bypass loudness"}
            </button>
            {liveBypassMatchReady && (
              <button
                type="button"
                onClick={clearLiveBypassMatch}
                disabled={comparisonWorkBusy || blockNewWork || Boolean(blindListen)}
              >
                Use native levels
              </button>
            )}
            {bypassMatchBusy && (
              <button
                type="button"
                onClick={() => {
                  setBypassMatchStatus("Cancellation requested; an active offline render must finish first.");
                  bypassMatchAbortRef.current?.abort();
                }}
              >
                Cancel match
              </button>
            )}
          </div>
          <p role="status" aria-live="polite" aria-atomic="true">
            {bypassMatchBusy
              ? bypassMatchStatus
              : liveBypassMatchReady && liveBypassMatch
                ? liveBypassMatchTarget === null
                  ? bypassMatchStatus
                  : `${bypassMatchStatus} Processed ${formatMeasuredLufs(liveBypassMatch.processedLufs)}; bypass ${formatMeasuredLufs(liveBypassMatch.bypassedLufs)}.`
                : bypassMatchStatus || "Live bypass currently uses native monitor levels."}
          </p>
        </section>
      )}
      {blindListen ? (
        <div className="master-ab-blind-shield" role="status">
          {blindListen.revealed
            ? "Snapshot identities are revealed. Capture times, assistant suggestions, live bypass controls and reference controls stay hidden until you end the session."
            : "Blind listening is active. Snapshot names, capture times, measurements, assistant suggestions, live bypass controls and reference controls are hidden until you end the session or reveal the mapping."}
        </div>
      ) : (
        <div className="master-ab-snapshots">
          {(["A", "B"] as const).map((slot) => {
            const snapshot = slot === "A" ? snapshotA : snapshotB;
            return (
              <div className="master-ab-snapshot" key={slot}>
                <div>
                  <strong>Snapshot {slot}</strong>
                  <span>{snapshot ? new Date(snapshot.capturedAt).toLocaleString() : "Empty"}</span>
                </div>
                <button type="button" onClick={() => capture(slot)}>
                  Capture current
                </button>
                {snapshot && (
                  <button type="button" onClick={() => clearSlot(slot)}>
                    Clear
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div hidden={Boolean(blindListen)}>
        <MasteringAssistant
          doc={doc}
          revisionId={revisionId}
          sampleRate={sampleRate}
          blockNewWork={comparisonWorkBusy || blockNewWork || Boolean(blindListen)}
          onBusyChange={setAssistantBusy}
          reservedPcmBytes={referenceBytes + referenceProjectBytes + comparisonBytes}
          referencePcmBytes={referenceBytes}
          comparisonEpoch={comparisonEpoch}
          onBeforeRender={() => {
            bypassMatchAbortRef.current?.abort();
            setComparison(null);
            setPlaying(null);
            setAbRenderEpoch((epoch) => epoch + 1);
            services.engine.stopPreview();
          }}
          onPreviewBytes={reportAssistantBytes}
        />
      </div>
      <div className="master-ab-controls">
        <label>
          Compare sample rate
          <select
            value={sampleRate}
            disabled={comparisonWorkBusy || blockNewWork || Boolean(blindListen)}
            onChange={(event) => setSampleRate(Number(event.target.value) as MasteringRenderSampleRate)}
          >
            {MASTERING_RENDER_SAMPLE_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {MASTERING_RENDER_SAMPLE_RATE_LABELS[rate]}
              </option>
            ))}
          </select>
        </label>
        <MasteringLevelMatchControl
          checked={levelMatch}
          disabled={comparisonControlsBusy || blockNewWork || Boolean(blindListen)}
          labelClassName="master-ab-match"
          onChange={setLevelMatch}
        />
        <button
          type="button"
          onClick={() => void renderComparison()}
          disabled={!snapshotA || !snapshotB || comparisonWorkBusy || blockNewWork || Boolean(blindListen)}
        >
          {busy ? "Rendering…" : "Render A/B"}
        </button>
        <button
          type="button"
          onClick={startBlindListen}
          disabled={!comparisonReady || comparisonWorkBusy || blockNewWork || Boolean(blindListen)}
        >
          Blind listen
        </button>
        {busy && (
          <button type="button" onClick={() => abortRef.current?.abort()}>
            Cancel compare
          </button>
        )}
        {playing && (
          <button type="button" onClick={stopComparePreview}>
            Stop audition
          </button>
        )}
      </div>
      <p className="master-ab-status" role="status" aria-live="polite">
        {status}
      </p>
      {error && (
        <p className="master-ab-error" role="alert">
          {error}
        </p>
      )}
      {storageNotice && <p className="master-ab-storage">{storageNotice}</p>}
      {comparisonReady && (
        <div className="master-ab-results">
          {blindListen ? (
            <div className="master-ab-blind-session">
              <header>
                <strong>Blind listen · {blindListen.revealed ? "mapping revealed" : "identities hidden"}</strong>
                <button type="button" onClick={endBlindListen}>
                  End blind listen
                </button>
              </header>
              <p>
                {levelMatch && matchTarget !== null
                  ? "Both versions use the same audition loudness. Listen to each, then record a preference if you want."
                  : "Loudness matching is unavailable for this material or turned off. Listen to each, then record a preference if you want."}{" "}
                Your choice is shown here only and never changes the project or snapshots.
              </p>
              <div className="master-ab-blind-sides">
                {renderBlindSide("1", blindListen.first)}
                {renderBlindSide("2", blindListen.first === "A" ? "B" : "A")}
              </div>
              <fieldset className="master-ab-blind-choice" disabled={blindListen.revealed}>
                <legend>Which version sounds better?</legend>
                {(["first", "second", "none"] as const).map((preference) => (
                  <button
                    type="button"
                    key={preference}
                    aria-pressed={blindListen.preference === preference}
                    onClick={() => setBlindListen((current) => (current ? { ...current, preference } : current))}
                  >
                    {preference === "first" ? "Version 1" : preference === "second" ? "Version 2" : "No preference"}
                  </button>
                ))}
              </fieldset>
              {!blindListen.revealed ? (
                <button
                  type="button"
                  className="master-ab-blind-reveal"
                  onClick={() => setBlindListen((current) => (current ? { ...current, revealed: true } : current))}
                >
                  Reveal snapshot identities
                </button>
              ) : (
                <p className="master-ab-blind-reveal-note" role="status">
                  Version 1 was snapshot {blindListen.first}; version 2 was snapshot{" "}
                  {blindListen.first === "A" ? "B" : "A"}.
                  {blindListen.preference
                    ? ` Your preference: ${blindListen.preference === "first" ? "version 1" : blindListen.preference === "second" ? "version 2" : "no preference"}.`
                    : " No preference was recorded."}
                </p>
              )}
            </div>
          ) : (
            <>
              {renderSide("A", comparison.a, gainA)}
              {renderSide("B", comparison.b, gainB)}
              <p>
                Level match uses preview-only gain and attenuates the louder version to the quieter LUFS-I reading.
                Audio files and project settings are unchanged.
              </p>
            </>
          )}
        </div>
      )}
      <div hidden={Boolean(blindListen)}>
        <MasteringReferenceCompare
          doc={doc}
          revisionId={revisionId}
          sampleBankRevision={sampleBankRevision}
          sampleRate={sampleRate}
          levelMatch={levelMatch}
          abRenderEpoch={abRenderEpoch}
          blockNewWork={comparisonWorkBusy || blockNewWork || Boolean(blindListen)}
          onBusyChange={reportReferenceBusy}
          onCancelLoudnessMatch={cancelReferenceLoudnessMatch}
          comparisonBytes={comparisonBytes}
          onBeforeRender={() => {
            bypassMatchAbortRef.current?.abort();
            setComparison(null);
            setPlaying(null);
            setComparisonEpoch((epoch) => epoch + 1);
            services.engine.stopPreview();
          }}
          onReferenceBytes={reportReferenceBytes}
          assistantBytes={assistantBytes}
          onProjectMasterBytes={reportReferenceProjectBytes}
        />
      </div>
    </section>
  );
}
