import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthenticatedClient, PopupAuthResult, SyncedDocument } from "@audiotool/nexus";
import type { Pattern, TimeSignature, Track } from "../project-model/types";
import {
  audiotoolProjectIdFromUrl,
  audiotoolProjectUrl,
  buildAudiotoolWritePlan,
  type AudiotoolWritePlan,
} from "../integrations/audiotool-nexus/mapping";
import { writeAudiotoolPlan, type AudiotoolWriteReceipt } from "../integrations/audiotool-nexus/writer";

type NexusSdk = Pick<typeof import("@audiotool/nexus"), "audiotoolPopup">;

interface AudiotoolNexusExportProps {
  pattern: Pattern;
  tracks: readonly Track[];
  timeSignature: TimeSignature;
  sourceBpm: number;
  candidateLabel: string;
  isSourceCurrent: () => boolean;
  onClose: () => void;
  clientId?: string;
}

const CLIENT_ID = (import.meta.env.VITE_AUDIOTOOL_NEXUS_CLIENT_ID ?? "").trim();

export function AudiotoolNexusExport({
  pattern,
  tracks,
  timeSignature,
  sourceBpm,
  candidateLabel,
  isSourceCurrent,
  onClose,
  clientId: configuredClientId,
}: AudiotoolNexusExportProps) {
  const clientId = (configuredClientId ?? CLIENT_ID).trim();
  const [sdk, setSdk] = useState<NexusSdk | null>(null);
  const [auth, setAuth] = useState<AuthenticatedClient | null>(null);
  const [unauthenticated, setUnauthenticated] = useState<Extract<
    PopupAuthResult,
    { status: "unauthenticated" }
  > | null>(null);
  const [session, setSession] = useState<SyncedDocument | null>(null);
  const sessionRef = useRef<SyncedDocument | null>(null);
  const lifecycleRef = useRef(0);
  const [projectUrl, setProjectUrl] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AudiotoolWriteReceipt | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  const result = useMemo(
    () => (projectId ? buildAudiotoolWritePlan({ pattern, tracks, timeSignature, sourceBpm, projectId }) : null),
    [pattern, tracks, timeSignature, sourceBpm, projectId],
  );
  const plan: AudiotoolWritePlan | null = result?.ok ? result.plan : null;

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    return () => {
      if (lifecycleRef.current === lifecycle) lifecycleRef.current += 1;
      const current = sessionRef.current;
      sessionRef.current = null;
      if (current) void current.stop().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setIsConnected(false);
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
      setSdk({ audiotoolPopup: loaded.audiotoolPopup });
    } catch {
      if (lifecycleRef.current === lifecycle) {
        setError("Audiotool connector sa nepodarilo načítať. Skontroluj sieť a skús to znova.");
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
      const result = await sdk.audiotoolPopup({ clientId, scope: "project:write" });
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
    setError(null);
    if (current) {
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
            Vybraný KYX MIDI návrh · bez automatickej synchronizácie
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

      {!clientId ? (
        <div className="audiotool-nexus-export__notice" role="note">
          Nexus ešte nie je nakonfigurovaný. Zaregistruj Audiotool aplikáciu s oprávnením <code>project:write</code> a
          nastav verejný <code>VITE_AUDIOTOOL_NEXUS_CLIENT_ID</code>. Kým to neurobíš, generovanie KYX zostáva bez
          zmeny.
        </div>
      ) : !sdk ? (
        <div className="audiotool-nexus-export__actions">
          <p>Connector sa stiahne až po tomto kliknutí; KYX zatiaľ nič neposiela a nemení.</p>
          <button type="button" className="btn btn-small intent-use-btn" onClick={() => void loadSdk()} disabled={busy}>
            {busy ? "NAČÍTAVAM…" : "NAČÍTAŤ AUDIOTOOL CONNECTOR"}
          </button>
        </div>
      ) : !auth ? (
        <div className="audiotool-nexus-export__actions">
          <p>
            Prihlásenie žiada iba scope <code>project:write</code>. KYX nepýta ani neposiela token na svoj server.
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
      ) : !session ? (
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
      ) : (
        <div className="audiotool-nexus-export__actions">
          <div className="audiotool-nexus-export__destination">
            Cieľ: <code>{projectId?.slice(-12)}</code> · {auth.userName} · {isConnected ? "ONLINE" : "OFFLINE"}
            <a href={audiotoolProjectUrl(projectId ?? "")} target="_blank" rel="noopener noreferrer">
              Otvoriť v Audiotool Studiu ↗
            </a>
          </div>

          {plan ? (
            <div className="audiotool-nexus-export__preview" aria-label="Preview exportu">
              <strong>
                {plan.parts.length} MIDI part{plan.parts.length === 1 ? "" : "y"} · {plan.noteCount} nôt · {plan.bars}{" "}
                takt{plan.bars === 1 ? "" : "ov"}
              </strong>
              <ul>
                {plan.parts.map((part, index) => (
                  <li key={`${part.name}:${index}`}>
                    {part.name} · {part.notes.length} nôt · nový Heisenberg
                  </li>
                ))}
              </ul>
              <p>
                Noty budú hrať podľa tempa Audiotool projektu; jeho tempo nemeníme. Zdrojový KYX brief bol pri{" "}
                <strong>{plan.sourceBpm} BPM</strong>. Drums a ostatné nepodporované stopy zostanú v KYX.
              </p>
              {plan.unsupportedDrumHits > 0 && (
                <p className="audiotool-nexus-export__warning">
                  {plan.unsupportedDrumHits} drum hitov sa zatiaľ neprenesie.
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
              {!isConnected && (
                <p className="audiotool-nexus-export__warning" role="alert">
                  Audiotool práve nie je pripojený. Počkaj na obnovenie spojenia pred potvrdením zápisu.
                </p>
              )}
              <label className="audiotool-nexus-export__confirm">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                Rozumiem, že potvrdenie pridá nové zariadenia, MIDI party a mixer kanály do vzdialeného Audiotool
                projektu.
              </label>
              <div className="audiotool-nexus-export__actions-row">
                <button
                  type="button"
                  className="btn btn-small intent-use-btn"
                  onClick={() => void sendToAudiotool()}
                  disabled={busy || !confirmed || !isSourceCurrent() || !isConnected || receipt !== null}
                >
                  {busy
                    ? "ZAPISUJEM…"
                    : receipt?.status === "created"
                      ? "ODOSLANÉ"
                      : receipt?.status === "already-imported"
                        ? "UŽ PRIDANÉ"
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
              Pridané: {receipt.parts} MIDI part{receipt.parts === 1 ? "" : "y"}, {receipt.notes} nôt a{" "}
              {receipt.mixerChannels} výstupných kanálov.
            </div>
          )}
          {receipt?.status === "already-imported" && (
            <div className="audiotool-nexus-export__notice" role="status">
              Tento plán už v projekte je; nič ďalšie sa nevytvorilo.
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="audiotool-nexus-export__error" role="alert">
          {error}
        </p>
      )}
      <footer className="audiotool-nexus-export__footer">
        Nexus syncuje Audiotool session nezávisle od KYX prehrávania; tento export nie je live MIDI streaming.
      </footer>
    </section>
  );
}
