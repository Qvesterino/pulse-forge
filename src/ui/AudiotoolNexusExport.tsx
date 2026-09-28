import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthenticatedClient, PopupAuthResult, SyncedDocument } from "@audiotool/nexus";
import type { Pattern, TimeSignature, Track } from "../project-model/types";
import {
  audiotoolProjectIdFromUrl,
  audiotoolProjectUrl,
  buildAudiotoolWritePlan,
  type AudiotoolWritePlan,
} from "../integrations/audiotool-nexus/mapping";
import { readAudiotoolProjectTempo, type AudiotoolProjectTempo } from "../integrations/audiotool-nexus/tempo";
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
  const [targetTempo, setTargetTempo] = useState<AudiotoolProjectTempo | null>(null);
  const sessionRef = useRef<SyncedDocument | null>(null);
  const lifecycleRef = useRef(0);
  const [projectUrl, setProjectUrl] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [gmProgramByTrackId, setGmProgramByTrackId] = useState<Record<string, number>>({});
  const [useGakkiSounds, setUseGakkiSounds] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AudiotoolWriteReceipt | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  const result = useMemo(
    () =>
      projectId
        ? buildAudiotoolWritePlan({
            pattern,
            tracks,
            timeSignature,
            sourceBpm,
            projectId,
            instrumentMode: useGakkiSounds ? "gakki" : "heisenberg",
            gmProgramByTrackId,
          })
        : null,
    [pattern, tracks, timeSignature, sourceBpm, projectId, gmProgramByTrackId, useGakkiSounds],
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
      setTargetTempo(readTargetTempo(openingDocument));
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
    setTargetTempo(null);
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
    if (!auth || !session || !plan || !confirmed || !isSourceCurrent() || !isConnected || busy || receipt) return;
    const lifecycle = lifecycleRef.current;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const gakkiPresets =
        plan.instrumentMode === "gakki"
          ? new Map<number, Awaited<ReturnType<typeof auth.presets.getInstrument>>>()
          : undefined;
      if (gakkiPresets) {
        const selectedPrograms = [...new Set(plan.parts.map((part) => part.gmProgram))];
        await Promise.all(
          selectedPrograms.map(async (program) => {
            const instrument = auth.presets.gmInstruments.find((candidate) => candidate.program === program);
            if (!instrument) throw new Error(`GM preset ${program + 1} is not available.`);
            try {
              gakkiPresets.set(program, await auth.presets.getInstrument(instrument));
            } catch {
              throw new Error(`GM preset ${program + 1} could not be loaded.`);
            }
          }),
        );
      }
      if (lifecycleRef.current !== lifecycle) return;
      const written = await writeAudiotoolPlan(session, plan, {
        isWriteStillAuthorized: isSourceCurrent,
        ...(gakkiPresets ? { gakkiPresets } : {}),
      });
      if (lifecycleRef.current === lifecycle) setReceipt(written);
    } catch (cause) {
      if (lifecycleRef.current !== lifecycle) return;
      const message = cause instanceof Error ? cause.message : "";
      setError(
        message.includes("GM preset")
          ? "Audiotool GM sound sa nepodarilo načítať. Skontroluj pripojenie a skús to znova; do projektu sa nič nezapísalo."
          : message.includes("KYX source changed")
            ? "KYX projekt sa pred zápisom zmenil. Zavri export a vytvor kandidáta znova."
            : message.includes("partial") || message.includes("did not confirm")
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
            KYX MIDI {useGakkiSounds ? "s Audiotool GM zvukmi" : "s Heisenbergom"} + podporované Beatbox8 drums · bez
            automatickej synchronizácie
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
          Nexus ešte nie je nakonfigurovaný. V Audiotool Developer Portal zaregistruj aplikáciu so scope{" "}
          <code>project:write</code> a Redirect URI, ktorého origin sa zhoduje s <code>{window.location.origin}</code>.
          Nastav verejný <code>VITE_AUDIOTOOL_NEXUS_CLIENT_ID</code>; pre lokálny vývoj zaregistruj aj Redirect URI{" "}
          <code>http://127.0.0.1:5173/</code>. Kým to neurobíš, generovanie KYX zostáva bez zmeny.
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
                {plan.parts.length} MIDI part{plan.parts.length === 1 ? "" : "y"} · {plan.noteCount} nôt
                {plan.drumPattern ? ` · Beatbox8 ${plan.drumPattern.hitCount} drum hitov` : ""} · {plan.bars} takt
                {plan.bars === 1 ? "" : "ov"}
              </strong>
              <ul>
                {plan.parts.map((part, index) => (
                  <li key={`${part.name}:${index}`}>
                    {part.name} · {part.notes.length} nôt ·{" "}
                    {plan.instrumentMode === "gakki" ? (
                      <label>
                        Audiotool GM zvuk
                        <select
                          aria-label={`Audiotool GM zvuk pre ${part.name}`}
                          value={part.gmProgram}
                          onChange={(event) =>
                            setGmProgramByTrackId((current) => ({
                              ...current,
                              [part.sourceTrackId]: Number(event.target.value),
                            }))
                          }
                          disabled={busy}
                        >
                          {auth.presets.gmInstruments.map((instrument) => (
                            <option key={instrument.program} value={instrument.program}>
                              {instrument.displayName} · {instrument.category}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      "nový Heisenberg"
                    )}
                  </li>
                ))}
                {plan.drumPattern && (
                  <li>Beatbox 8 · {plan.drumPattern.length} 16th steps · vstavané Audiotool zvuky</li>
                )}
              </ul>
              <p>
                Audiotool cieľ:{" "}
                <strong>
                  {targetTempo
                    ? `${targetTempo.bpm} BPM · ${timeSignatureText(targetTempo.timeSignature)}`
                    : "tempo sa nepodarilo prečítať"}
                </strong>
                {targetTempo?.isDefault
                  ? " (zobrazené sú Audiotool defaulty, pretože project config nebol čitateľný)"
                  : ""}
                . KYX zdroj:{" "}
                <strong>
                  {plan.sourceBpm} BPM · {timeSignatureText(plan.timeSignature)}
                </strong>
                . Cieľové tempo ani takt nemeníme.
              </p>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setTargetTempo(readTargetTempo(session))}
                disabled={busy || !isConnected}
              >
                OBNOVIŤ AUDIOTOOL BPM/TAKT
              </button>
              {plan.parts.length > 0 && (
                <label className="audiotool-nexus-export__confirm">
                  <input
                    type="checkbox"
                    aria-label="Použiť vybrané Audiotool GM zvuky"
                    checked={useGakkiSounds}
                    disabled={busy}
                    onChange={(event) => setUseGakkiSounds(event.target.checked)}
                  />
                  Použiť Audiotool GM zvuky (odporúčané; vypnutím sa použije jednoduchý Heisenberg oscilátor)
                </label>
              )}
              {targetTempo &&
                (targetTempo.bpm !== plan.sourceBpm ||
                  targetTempo.timeSignature.numerator !== plan.timeSignature.numerator ||
                  targetTempo.timeSignature.denominator !== plan.timeSignature.denominator) && (
                  <p className="audiotool-nexus-export__warning" role="note">
                    Audiotool tempo určuje rýchlosť prehrávania. KYX tickové rozloženie nemeníme; pri odlišnom takte sa
                    môžu posunúť hranice taktov.
                  </p>
                )}
              {plan.drumPattern && (
                <p className="audiotool-nexus-export__warning">
                  KYX sample-y a presné drum timbre sa neprenášajú. Použijú sa vstavané Beatbox8 zvuky; presná velocity,
                  ratchety, probability a microtiming sa nezachovajú.
                </p>
              )}
              {plan.instrumentMode === "gakki" && plan.parts.length > 0 && (
                <p className="audiotool-nexus-export__warning">
                  MIDI party používajú vybrané Audiotool Gakki General MIDI zvuky. KYX syntéza, efekty a presný
                  instrument patch sa nekopírujú; zvuk môžeš po importe ďalej upraviť v Audiotool Studiu.
                </p>
              )}
              {plan.drumPattern && plan.drumPattern.sourceStepCount > 64 && (
                <p className="audiotool-nexus-export__warning">
                  Beatbox8 podporuje najviac 64 krokov. Dlhší KYX pattern sa odreže po prvých 64 krokoch.
                </p>
              )}
              {plan.unsupportedDrumHits > 0 && (
                <p className="audiotool-nexus-export__warning">
                  {plan.unsupportedDrumHits} drum hitov sa neprenesie (nepodporený pad alebo krok mimo exportovaného
                  rozsahu).
                </p>
              )}
              {plan.collapsedDrumHits > 0 && (
                <p className="audiotool-nexus-export__warning">
                  {plan.collapsedDrumHits} drum hitov sa zlúčilo: Beatbox8 má pre jednu rolu iba jeden trigger na krok.
                  Accent platí pre všetky aktívne roly v kroku.
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
                <input
                  type="checkbox"
                  aria-label="Potvrdiť vzdialený zápis do Audiotoolu"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Rozumiem, že potvrdenie pridá nové MIDI/{plan.instrumentMode === "gakki" ? "Gakki" : "Heisenberg"}/
                Beatbox8 zariadenia, tracky, patterns a mixer kanály do vzdialeného Audiotool projektu.
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
                        : plan.drumPattern
                          ? plan.parts.length > 0
                            ? "PRIDAŤ MIDI + DRUMS DO AUDIOTOOLU"
                            : "PRIDAŤ DRUMS DO AUDIOTOOLU"
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
              Pridané: {receipt.parts} MIDI part{receipt.parts === 1 ? "" : "y"}, {receipt.notes} nôt,{" "}
              {receipt.drumHits} Beatbox8 hitov a {receipt.mixerChannels} výstupných kanálov.
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

function readTargetTempo(session: SyncedDocument): AudiotoolProjectTempo | null {
  try {
    return readAudiotoolProjectTempo(session);
  } catch {
    return null;
  }
}

function timeSignatureText(signature: TimeSignature): string {
  return `${signature.numerator}/${signature.denominator}`;
}
