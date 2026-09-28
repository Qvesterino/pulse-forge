import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthenticatedClient, OfflineDocument, PopupAuthResult, SyncedDocument } from "@audiotool/nexus";
import type { Pattern, TimeSignature, Track } from "../project-model/types";
import {
  audiotoolProjectIdFromUrl,
  audiotoolProjectUrl,
  buildAudiotoolWritePlan,
  type AudiotoolWritePlan,
} from "../integrations/audiotool-nexus/mapping";
import { writeAudiotoolPlan, type AudiotoolWriteReceipt } from "../integrations/audiotool-nexus/writer";
import { readAudiotoolProjectTempo } from "../integrations/audiotool-nexus/tempo";

type NexusSdk = Pick<typeof import("@audiotool/nexus"), "audiotoolPopup" | "createOfflineDocument">;

/** A document we can write into: synced to Audiotool, or fully offline. */
type WritableDocument = SyncedDocument | OfflineDocument;

interface AudiotoolNexusExportProps {
  pattern: Pattern;
  tracks: readonly Track[];
  timeSignature: TimeSignature;
  sourceBpm: number;
  candidateLabel: string;
  isSourceCurrent: () => boolean;
  onClose: () => void;
  clientId?: string;
  /**
   * Allow the offline path, which writes into a real NEXUS document held in
   * this tab. Same entity schema, same validation, same transaction layer as
   * a synced document — it simply never syncs anywhere. This is the only
   * available route until an Audiotool application is registered, so it
   * defaults to on.
   */
  allowOffline?: boolean;
}

const CLIENT_ID = (import.meta.env.VITE_AUDIOTOOL_NEXUS_CLIENT_ID ?? "").trim();

/** Project id for an offline document. Nothing leaves the tab. */
const OFFLINE_PROJECT_ID = "offline";

export function AudiotoolNexusExport({
  pattern,
  tracks,
  timeSignature,
  sourceBpm,
  candidateLabel,
  isSourceCurrent,
  onClose,
  clientId: configuredClientId,
  allowOffline = true,
}: AudiotoolNexusExportProps) {
  const clientId = (configuredClientId ?? CLIENT_ID).trim();
  /** Without a client id there is no OAuth, so offline is the only route. */
  const offlineOnly = clientId.length === 0;
  const [sdk, setSdk] = useState<NexusSdk | null>(null);
  const [auth, setAuth] = useState<AuthenticatedClient | null>(null);
  const [unauthenticated, setUnauthenticated] = useState<Extract<
    PopupAuthResult,
    { status: "unauthenticated" }
  > | null>(null);
  const [session, setSession] = useState<WritableDocument | null>(null);
  const sessionRef = useRef<WritableDocument | null>(null);
  const lifecycleRef = useRef(0);
  const [isOffline, setIsOffline] = useState(false);
  const [projectUrl, setProjectUrl] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AudiotoolWriteReceipt | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [tempoRefreshVersion, setTempoRefreshVersion] = useState(0);

  const result = useMemo(
    () => (projectId ? buildAudiotoolWritePlan({ pattern, tracks, timeSignature, sourceBpm, projectId }) : null),
    [pattern, tracks, timeSignature, sourceBpm, projectId],
  );
  const plan: AudiotoolWritePlan | null = result?.ok ? result.plan : null;
  const targetTempo = useMemo(
    () => (session ? readAudiotoolProjectTempo(session) : null),
    [session, tempoRefreshVersion],
  );
  const targetTempoMismatch =
    plan !== null &&
    targetTempo !== null &&
    (Math.abs(targetTempo.bpm - plan.sourceBpm) > 0.01 ||
      targetTempo.timeSignature.numerator !== plan.timeSignature.numerator ||
      targetTempo.timeSignature.denominator !== plan.timeSignature.denominator);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    return () => {
      if (lifecycleRef.current === lifecycle) lifecycleRef.current += 1;
      const current = sessionRef.current;
      sessionRef.current = null;
      // Only a synced document has a transport to stop. An offline document
      // was never connected and has nothing to tear down.
      if (current && "stop" in current) void current.stop().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setIsConnected(false);
      return;
    }
    // An offline document has no connection state — it is always writable,
    // because it lives in this tab. A synced one reports its own.
    if (!("connected" in session)) {
      setIsConnected(true);
      return;
    }
    const subscription = session.connected.subscribe(setIsConnected, true);
    return () => subscription.terminate();
  }, [session]);

  const loadSdk = async () => {
    if (busy || sdk) return;
    const lifecycle = lifecycleRef.current;
    setBusy(true);
    setError(null);
    try {
      const loaded = await import("@audiotool/nexus");
      if (lifecycleRef.current !== lifecycle) return;
      setSdk({
        audiotoolPopup: loaded.audiotoolPopup,
        createOfflineDocument: loaded.createOfflineDocument,
      });
    } catch {
      if (lifecycleRef.current === lifecycle) {
        setError("Audiotool connector sa nepodarilo načítať. Skontroluj sieť a skús to znova.");
      }
    } finally {
      if (lifecycleRef.current === lifecycle) setBusy(false);
    }
  };

  /**
   * Create a real NEXUS document offline and prepare it for writing.
   *
   * This is not a mock or a stub: `createOfflineDocument` returns the same
   * document type the SDK uses against a live project, validated by the same
   * wasm schema, and `writeAudiotoolPlan` writes into it through the same
   * transaction layer. What it does not do is sync to Audiotool's backend,
   * because that requires an OAuth client registered on
   * developer.audiotool.com. Once that client id exists the caller should
   * use the synced path instead and nothing here changes.
   *
   * Setting `projectId` after the document exists is deliberate: the write
   * plan is derived from it, so the normal derived-plan path then runs
   * unchanged for the actual export.
   */
  const openOffline = async () => {
    if (!sdk?.createOfflineDocument || busy) return;
    const lifecycle = lifecycleRef.current;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const offline = (await sdk.createOfflineDocument()) as OfflineDocument;
      if (lifecycleRef.current !== lifecycle) return;
      sessionRef.current = offline;
      setSession(offline);
      setIsOffline(true);
      setProjectId(OFFLINE_PROJECT_ID);
      // An offline document is local and complete on creation, so there is
      // nothing to preview-and-confirm against a remote session first.
      setConfirmed(true);
    } catch {
      if (lifecycleRef.current === lifecycle) {
        sessionRef.current = null;
        setError("Offline Audiotool dokument sa nepodarilo vytvoriť. Skús to znova.");
      }
    } finally {
      if (lifecycleRef.current === lifecycle) setBusy(false);
    }
  };

  const connect = async () => {
    if (!sdk || !clientId || busy) return;
    const lifecycle = lifecycleRef.current;
    setBusy(true);
    setError(null);
    setUnauthenticated(null);
    try {
      // Invoke synchronously from the click handler so browser popup blockers
      // recognize the user gesture. Keep it in the try block for sync failures too.
      const result = await sdk.audiotoolPopup({
        clientId,
        scope: "project:write",
        targetOrigin: window.location.origin,
      });
      if (lifecycleRef.current !== lifecycle) return;
      if (result.status === "authenticated") {
        setAuth(result);
      } else {
        setUnauthenticated(result);
        const reason = result.error?.message ?? "";
        setError(
          reason.includes("Popup was blocked")
            ? "Prehliadač zablokoval prihlasovacie okno. Povoľ pop-upy pre KYX a skús znova."
            : "Prihlásenie bolo zrušené alebo zlyhalo. Skontroluj Audiotool povolenie a skús znova.",
        );
      }
    } catch {
      if (lifecycleRef.current === lifecycle) {
        setError("Audiotool prihlásenie sa nepodarilo. Skontroluj sieť a konfiguráciu aplikácie.");
      }
    } finally {
      if (lifecycleRef.current === lifecycle) setBusy(false);
    }
  };

  const openProject = async () => {
    if (!auth || busy) return;
    const id = audiotoolProjectIdFromUrl(projectUrl);
    if (!id) {
      setError("Vlož platný odkaz na projekt https://beta.audiotool.com/studio?project=… .");
      return;
    }
    const lifecycle = lifecycleRef.current;
    setBusy(true);
    setError(null);
    setReceipt(null);
    setConfirmed(false);
    let openingDocument: SyncedDocument | null = null;
    try {
      openingDocument = await auth.open(audiotoolProjectUrl(id));
      if (lifecycleRef.current !== lifecycle) {
        await openingDocument.stop().catch(() => {});
        return;
      }
      sessionRef.current = openingDocument;
      await openingDocument.start();
      if (lifecycleRef.current !== lifecycle) {
        if (sessionRef.current === openingDocument) {
          sessionRef.current = null;
          await openingDocument.stop().catch(() => {});
        }
        return;
      }
      setSession(openingDocument);
      setProjectId(id);
    } catch {
      if (openingDocument && sessionRef.current === openingDocument) {
        sessionRef.current = null;
        await openingDocument.stop().catch(() => {});
      }
      if (lifecycleRef.current === lifecycle) {
        setError("Projekt sa nepodarilo otvoriť. Over prístup k nemu a skús znova.");
      }
    } finally {
      if (lifecycleRef.current === lifecycle) setBusy(false);
    }
  };

  const disconnectProject = async () => {
    const lifecycle = lifecycleRef.current;
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setProjectId(null);
    setReceipt(null);
    setConfirmed(false);
    setIsOffline(false);
    setError(null);
    // An offline document has nothing to stop — it was never connected.
    if (current && "stop" in current) {
      setBusy(true);
      try {
        await current.stop();
      } catch {
        if (lifecycleRef.current === lifecycle) {
          setError("Audiotool sync sa nepodarilo čisto ukončiť. Zatvor projekt aj v Audiotool Studiu.");
        }
      } finally {
        if (lifecycleRef.current === lifecycle) setBusy(false);
      }
    }
  };

  const sendToAudiotool = async () => {
    if (!session || !plan || !confirmed || !isSourceCurrent() || !isConnected || busy || receipt) return;
    const lifecycle = lifecycleRef.current;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const written = await writeAudiotoolPlan(session, plan, { isWriteStillAuthorized: isSourceCurrent });
      if (lifecycleRef.current === lifecycle) setReceipt(written);
    } catch (cause) {
      if (lifecycleRef.current !== lifecycle) return;
      const message = cause instanceof Error ? cause.message : "";
      setError(
        message.includes("KYX source changed")
          ? "KYX projekt sa pred zápisom zmenil. Zavri export a vytvor kandidáta znova."
          : message.includes("partial KYX import marker") || message.includes("did not confirm")
            ? "SDK nahlásilo možný čiastočný zápis. Projekt skontroluj v Audiotool; zatiaľ neposielaj ten istý nápad znova."
            : message.includes("disconnected")
              ? "Audiotool session je offline. Znovu ju otvor a pred opakovaním skontroluj projekt."
              : "Zápis zlyhal alebo sa nepotvrdil. Skontroluj Audiotool projekt pred prípadným opakovaním.",
      );
    } finally {
      if (lifecycleRef.current === lifecycle) setBusy(false);
    }
  };

  return (
    <section className="audiotool-nexus-export" aria-label="Audiotool Nexus export">
      <header className="audiotool-nexus-export__header">
        <div>
          <strong>Poslať {candidateLabel} do Audiotoolu</strong>
          <div className="audiotool-nexus-export__subhead">
            Vybraný KYX beat · MIDI a podporované drum roly · bez automatickej synchronizácie
          </div>
        </div>
        <button
          type="button"
          className="btn btn-small"
          onClick={onClose}
          disabled={busy}
          aria-label="Zavrieť Audiotool export"
        >
          ✕
        </button>
      </header>

      {!sdk ? (
        <div className="audiotool-nexus-export__actions">
          <p>Connector sa stiahne až po tomto kliknutí; KYX zatiaľ nič neposiela a nemení.</p>
          <button type="button" className="btn btn-small intent-use-btn" onClick={() => void loadSdk()} disabled={busy}>
            {busy ? "NAČÍTAVAM…" : "NAČÍTAŤ AUDIOTOOL CONNECTOR"}
          </button>
        </div>
      ) : !session && offlineOnly ? (
        allowOffline ? (
          <div className="audiotool-nexus-export__actions">
            <p>
              Audiotool cloud zápis vyžaduje zaregistrovaný OAuth client. Zatiaľ môžeš vytvoriť lokálny NEXUS dokument
              so skutočnou SDK schémou a validáciou; projekt sa do Audiotoolu nesynchronizuje.
            </p>
            <button
              type="button"
              className="btn btn-small intent-use-btn"
              onClick={() => void openOffline()}
              disabled={busy}
            >
              {busy ? "VYTVÁRAM…" : "VYTVORIŤ OFFLINE DOKUMENT"}
            </button>
          </div>
        ) : (
          <div className="audiotool-nexus-export__notice" role="note">
            Nexus ešte nie je nakonfigurovaný. V Developer Portal zaregistruj aplikáciu so scope{" "}
            <code>project:write</code> a nastav verejný <code>VITE_AUDIOTOOL_NEXUS_CLIENT_ID</code> pre origin{" "}
            <code>{window.location.origin}</code>.
          </div>
        )
      ) : !session && !auth ? (
        <div className="audiotool-nexus-export__actions">
          <p>
            Prihlásenie žiada iba scope <code>project:write</code>. V registrácii Audiotool aplikácie povoľ Redirect URI
            s originom <code>{window.location.origin}</code>. KYX token neukladá ani neposiela na svoj server.
          </p>
          <button type="button" className="btn btn-small intent-use-btn" onClick={() => void connect()} disabled={busy}>
            {busy ? "ČAKÁM NA AUDIOTOOL…" : "PRIHLÁSIŤ A PRIPOJIŤ"}
          </button>
          {unauthenticated && (
            <button type="button" className="btn btn-small" onClick={() => void connect()} disabled={busy}>
              SKÚSIŤ ZNOVA
            </button>
          )}
        </div>
      ) : !session && auth ? (
        <form
          className="audiotool-nexus-export__actions"
          onSubmit={(event) => {
            event.preventDefault();
            void openProject();
          }}
        >
          <p>
            Prihlásený ako <strong>{auth.userName}</strong>. Vlož odkaz na svoj Audiotool Studio projekt.
          </p>
          <label>
            Odkaz na projekt
            <input
              type="url"
              value={projectUrl}
              onChange={(event) => setProjectUrl(event.target.value)}
              placeholder="https://beta.audiotool.com/studio?project=…"
              autoComplete="url"
              maxLength={2048}
              required
            />
          </label>
          <button type="submit" className="btn btn-small intent-use-btn" disabled={busy}>
            {busy ? "OTVÁRAM…" : "OTVORIŤ PROJEKT"}
          </button>
        </form>
      ) : session ? (
        <div className="audiotool-nexus-export__actions">
          <div className="audiotool-nexus-export__destination">
            Cieľ: <code>{isOffline ? "lokálny dokument" : projectId?.slice(-12)}</code> ·{" "}
            {isOffline
              ? "OFFLINE — bez synchronizácie"
              : `${auth?.userName ?? "Audiotool"} · ${isConnected ? "ONLINE" : "OFFLINE"}`}
            {!isOffline && projectId ? (
              <a href={audiotoolProjectUrl(projectId)} target="_blank" rel="noopener noreferrer">
                Otvoriť v Audiotool Studiu ↗
              </a>
            ) : null}
          </div>

          {plan ? (
            <div className="audiotool-nexus-export__preview" aria-label="Preview exportu">
              <strong>
                {plan.parts.length} MIDI part{plan.parts.length === 1 ? "" : "y"} · {plan.noteCount} nôt · {plan.bars}{" "}
                takt{plan.bars === 1 ? "" : "ov"}
                {plan.drumPattern ? ` · ${plan.drumHitCount} Beatbox8 drum hitov` : ""}
              </strong>
              <ul>
                {plan.parts.map((part, index) => (
                  <li key={`${part.name}:${index}`}>
                    {part.name} · {part.notes.length} nôt · nový Heisenberg
                  </li>
                ))}
              </ul>
              <p>
                Cieľové tempo: <strong>{targetTempo?.bpm ?? 125} BPM</strong> ·{" "}
                {targetTempo?.timeSignature.numerator ?? 4}/{targetTempo?.timeSignature.denominator ?? 4}
                {targetTempo?.isDefault ? " (Audiotool predvolené; config chýba)" : " (načítané z projektu)"}. KYX
                zdroj:{" "}
                <strong>
                  {plan.sourceBpm} BPM · {plan.timeSignature.numerator}/{plan.timeSignature.denominator}
                </strong>
                . Tempo cieľového projektu nemeníme.
              </p>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setTempoRefreshVersion((version) => version + 1)}
                disabled={busy}
              >
                OBNOVIŤ TEMPO PROJEKTU
              </button>
              {targetTempoMismatch && (
                <p className="audiotool-nexus-export__warning">
                  Tempo alebo takt sa líši od KYX zdroja; Audiotool nastavenie zostane nezmenené.
                </p>
              )}
              {plan.drumPattern && (
                <p>
                  Drums sa prenesú ako jeden editovateľný Beatbox8 pattern s internými zvukmi Audiotoolu, nie KYX
                  samplami. Presná velocity, ratchety, probability a microtiming sa nezachovajú; velocity od 0.75 zapne
                  spoločný step-wide accent.
                </p>
              )}
              {plan.unsupportedDrumHits > 0 && (
                <p className="audiotool-nexus-export__warning">
                  {plan.unsupportedDrumHits} drum hitov sa neprenesie (nepodporený pad alebo krok mimo limitu 64).
                </p>
              )}
              {plan.collapsedDrumHits > 0 && (
                <p className="audiotool-nexus-export__warning">
                  {plan.collapsedDrumHits} súbežných hitov sa zlúči: Beatbox8 má iba jeden hit pre každú rolu v jednom
                  kroku.
                </p>
              )}
              {plan.drumPattern && plan.drumPattern.sourceStepCount > 64 && (
                <p className="audiotool-nexus-export__warning">
                  KYX pattern má {plan.drumPattern.sourceStepCount} krokov; Beatbox8 prenesie prvých 64 a drum región sa
                  ukončí po 64 krokoch (16 štvrťových dobách).
                </p>
              )}
              {plan.unsupportedNoteCount > 0 && (
                <p className="audiotool-nexus-export__warning">
                  {plan.unsupportedNoteCount} nôt z nepodporovaných KYX trackov sa neprenesie.
                </p>
              )}
              {!isSourceCurrent() && (
                <p className="audiotool-nexus-export__warning" role="alert">
                  KYX projekt sa od vytvorenia návrhu zmenil. Tento export je zablokovaný; zavri ho a kandidáta vytvor
                  znova.
                </p>
              )}
              {!isOffline && !isConnected && (
                <p className="audiotool-nexus-export__warning" role="alert">
                  Audiotool práve nie je pripojený. Počkaj na obnovenie spojenia pred potvrdením zápisu.
                </p>
              )}
              <label className="audiotool-nexus-export__confirm">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                {isOffline
                  ? "Rozumiem, že vytvorím entity iba v tomto lokálnom dokumente; nič sa nesynchronizuje do Audiotool účtu."
                  : "Rozumiem, že pridám nové zariadenia, MIDI/drum tracky a mixer kanály do vzdialeného Audiotool projektu."}
              </label>
              <div className="audiotool-nexus-export__actions-row">
                <button
                  type="button"
                  className="btn btn-small intent-use-btn"
                  onClick={() => void sendToAudiotool()}
                  disabled={
                    busy || !confirmed || !isSourceCurrent() || (!isOffline && !isConnected) || receipt !== null
                  }
                >
                  {busy
                    ? "ZAPISUJEM…"
                    : receipt?.status === "created"
                      ? isOffline
                        ? "VLOŽENÉ LOKÁLNE"
                        : "ODOSLANÉ"
                      : receipt?.status === "already-imported"
                        ? "UŽ PRIDANÉ"
                        : isOffline
                          ? "VLOŽIŤ DO LOKÁLNEHO DOKUMENTU"
                          : plan.drumPattern
                            ? "PRIDAŤ MIDI A DRUMS DO AUDIOTOOLU"
                            : "PRIDAŤ MIDI DO AUDIOTOOLU"}
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => void disconnectProject()}
                  disabled={busy}
                >
                  ODPOJIŤ PROJEKT
                </button>
              </div>
            </div>
          ) : (
            <div className="audiotool-nexus-export__notice" role="note">
              {result && !result.ok ? result.error : "Vytváram preview…"}
            </div>
          )}
          {receipt?.status === "created" && (
            <div className="audiotool-nexus-export__success" role="status">
              Pridané: {receipt.parts} MIDI part{receipt.parts === 1 ? "" : "y"}, {receipt.notes} nôt
              {receipt.drumPatterns > 0 ? ` a Beatbox8 s ${receipt.drumHits} drum hitmi` : ""}; spolu{" "}
              {receipt.mixerChannels} mixer kanálov.
            </div>
          )}
          {receipt?.status === "already-imported" && (
            <div className="audiotool-nexus-export__notice" role="status">
              Tento plán už v projekte je; nič ďalšie sa nevytvorilo.
            </div>
          )}
        </div>
      ) : null}

      {error && (
        <p className="audiotool-nexus-export__error" role="alert">
          {error}
        </p>
      )}
      <footer className="audiotool-nexus-export__footer">
        Nexus syncuje Audiotool session nezávisle od KYX prehrávania; tento export nie je live MIDI streaming. Offline
        dokument sa do Audiotoolu nesynchronizuje.
      </footer>
    </section>
  );
}
