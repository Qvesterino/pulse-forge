import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BufferSummary } from "../audio-engine/metering";
import { analyzeMasterBufferAsync } from "../mastering/analysisClient";
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
import { MasteringReferenceCompare } from "./MasteringReferenceCompare";

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

function normalizeGain(summary: BufferSummary, targetLufs: number | null, enabled: boolean): number {
  if (!enabled || targetLufs === null || summary.lufsIntegrated <= -119) return 1;
  return Math.min(1, Math.pow(10, (targetLufs - summary.lufsIntegrated) / 20));
}

function gainLabel(gain: number): string {
  return `${(20 * Math.log10(Math.max(1e-12, gain))).toFixed(1)} dB`;
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

export function MasteringABCompare({ doc, revisionId }: { doc: ProjectDocument; revisionId: string }) {
  const services = useServices();
  const [sampleBankRevision, setSampleBankRevision] = useState(services.bank.revision);
  const [session, setSession] = useState<MasteringABSession>(() => loadMasteringABSession(doc));
  const [sampleRate, setSampleRate] = useState(48000);
  const [levelMatch, setLevelMatch] = useState(true);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [storageNotice, setStorageNotice] = useState("");
  const [playing, setPlaying] = useState<MasteringABSlot | null>(null);
  const [blindListen, setBlindListen] = useState<BlindListenSession | null>(null);
  const [referenceBytes, setReferenceBytes] = useState(0);
  const [referenceProjectBytes, setReferenceProjectBytes] = useState(0);
  const [assistantBytes, setAssistantBytes] = useState(0);
  const [abRenderEpoch, setAbRenderEpoch] = useState(0);
  const [comparisonEpoch, setComparisonEpoch] = useState(0);
  const playingRef = useRef<MasteringABSlot | null>(null);
  const [masterBypassed, setMasterBypassed] = useState(() => services.engine.isMasterBypassed());
  const abortRef = useRef<AbortController | null>(null);
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
    const loudnessA = comparison.a.summary.lufsIntegrated;
    const loudnessB = comparison.b.summary.lufsIntegrated;
    if (loudnessA <= -119 || loudnessB <= -119) return null;
    return Math.min(loudnessA, loudnessB);
  }, [comparison, comparisonReady]);
  const gainA = comparisonReady ? normalizeGain(comparison.a.summary, matchTarget, levelMatch) : 1;
  const gainB = comparisonReady ? normalizeGain(comparison.b.summary, matchTarget, levelMatch) : 1;
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
    if (playingRef.current) {
      services.engine.stopPreview();
      setPlaying(null);
    }
    setComparison(null);
    setBlindListen(null);
    setAbRenderEpoch((epoch) => epoch + 1);
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
    if (!snapshotA || !snapshotB || busy) return;
    const revisionAtStart = currentRevision(services, doc.id);
    let bankRevisionAtStart = services.bank.revision;
    if (!revisionAtStart || revisionAtStart !== revisionId) {
      setError("Projekt sa práve zmenil. Počkaj na aktualizáciu pracoviska a skús render znova.");
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
    }
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

  const stopComparePreview = () => {
    services.engine.stopPreview();
    setPlaying(null);
  };

  const startBlindListen = () => {
    if (!comparisonReady) return;
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
                <dd>{levelMatch && matchTarget === null ? "unavailable" : gainLabel(gain)}</dd>
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
            <dd>{levelMatch && matchTarget === null ? "unavailable" : gainLabel(gain)}</dd>
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
          reservedPcmBytes={referenceBytes + referenceProjectBytes + comparisonBytes}
          referencePcmBytes={referenceBytes}
          comparisonEpoch={comparisonEpoch}
          onBeforeRender={() => {
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
            disabled={busy || Boolean(blindListen)}
            onChange={(event) => setSampleRate(Number(event.target.value))}
          >
            <option value={44100}>44.1 kHz</option>
            <option value={48000}>48 kHz</option>
          </select>
        </label>
        <label className="master-ab-match">
          <input
            type="checkbox"
            checked={levelMatch}
            disabled={busy || Boolean(blindListen)}
            onChange={(event) => setLevelMatch(event.target.checked)}
          />
          Match audition loudness
        </label>
        <button
          type="button"
          onClick={() => void renderComparison()}
          disabled={!snapshotA || !snapshotB || busy || Boolean(blindListen)}
        >
          {busy ? "Rendering…" : "Render A/B"}
        </button>
        <button type="button" onClick={startBlindListen} disabled={!comparisonReady || busy || Boolean(blindListen)}>
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
          sampleRate={sampleRate}
          levelMatch={levelMatch}
          abRenderEpoch={abRenderEpoch}
          comparisonBytes={comparisonBytes}
          onBeforeRender={() => {
            setComparison(null);
            setPlaying(null);
            setAbRenderEpoch((epoch) => epoch + 1);
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
