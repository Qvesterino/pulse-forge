import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { EffectIntentPreviewEndReason } from "../audio-engine/AudioEngine";
import type { EffectInstance, ProjectDocument } from "../project-model/types";
import { applyEffectIntentProposal } from "../effect-intent/apply";
import { supportsEffectIntent } from "../effect-intent/catalog";
import { parseEffectIntent } from "../effect-intent/parser";
import { isEffectIntentProposalCurrent, planEffectIntent } from "../effect-intent/planner";
import type { EffectChangeProposal } from "../effect-intent/types";
import { useServices } from "./context";

type ActivePreview = {
  baseDoc: ProjectDocument;
  proposal: EffectChangeProposal;
};

type ProposalBase = { proposal: EffectChangeProposal; doc: ProjectDocument };

export function EffectIntentAssistant({
  trackId,
  effect,
  fallbackReason,
}: {
  trackId: string;
  effect: EffectInstance;
  fallbackReason?: string;
}) {
  const services = useServices();
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState("");
  const [proposal, setProposal] = useState<EffectChangeProposal | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [message, setMessage] = useState("");
  const previewRef = useRef<ActivePreview | null>(null);
  const proposalRef = useRef<ProposalBase | null>(null);
  const mountedRef = useRef(false);

  const cancelPreview = useCallback(
    (updateUi = true) => {
      const active = previewRef.current;
      if (!active) return;
      previewRef.current = null;
      services.engine.cancelEffectIntentPreview();
      if (updateUi) setPreviewing(false);
    },
    [services.engine],
  );

  const onPreviewEnded = useCallback((reason: EffectIntentPreviewEndReason) => {
    previewRef.current = null;
    setPreviewing(false);
    if (!mountedRef.current) return;
    if (reason === "projectChanged") {
      proposalRef.current = null;
      setProposal(null);
      setMessage("Projekt sa zmenil. Preview sa obnovilo a návrh treba vytvoriť znova.");
    } else if (reason === "transportStarted") {
      setMessage("Preview sa zastavilo pri spustení prehrávania; projekt sa nezmenil.");
    } else if (reason === "restoreFailed") {
      if (proposalRef.current && services.store.getDoc() !== proposalRef.current.doc) {
        proposalRef.current = null;
        setProposal(null);
      }
      setMessage("Plugin odmietol obnoviť pôvodné audio hodnoty. Projekt sa nezmenil; zastav prehrávanie a znovu načítaj zariadenie.");
    } else {
      setMessage("Preview zastavené; projekt ostal nezmenený.");
    }
  }, [services.store]);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = services.store.subscribe(() => {
      const currentDoc = services.store.getDoc();
      if (proposalRef.current && currentDoc !== proposalRef.current.doc) {
        cancelPreview();
        proposalRef.current = null;
        setProposal(null);
        setMessage("Projekt sa zmenil. Návrh treba vytvoriť znova.");
      } else if (previewRef.current && currentDoc !== previewRef.current.baseDoc) {
        cancelPreview();
      }
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      cancelPreview(false);
    };
  }, [cancelPreview, services.store]);

  if (!supportsEffectIntent(effect.type)) return null;

  const buildProposal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    cancelPreview();
    setProposal(null);
    proposalRef.current = null;
    setMessage("");
    const parsed = parseEffectIntent(request);
    if (parsed.status !== "ready") {
      setMessage(parsed.diagnostics.join(" "));
      return;
    }
    const result = planEffectIntent(
      services.store.getDoc(),
      { trackId, fxId: effect.id, effectType: effect.type },
      parsed.intent,
    );
    if (result.status !== "ready") {
      setMessage(result.diagnostics.join(" "));
      return;
    }
    setProposal(result.proposal);
    proposalRef.current = { proposal: result.proposal, doc: services.store.getDoc() };
    setMessage("Návrh je pripravený. Projekt sa zatiaľ nezmenil.");
  };

  const togglePreview = () => {
    if (!proposal) return;
    if (previewRef.current) {
      cancelPreview();
      setMessage("Preview zastavené; projekt ostal nezmenený.");
      return;
    }
    const doc = services.store.getDoc();
    if (services.transport.playing) {
      setMessage("Pred preview zastav prehrávanie, aby sa nebilo s automatizáciou parametrov.");
      return;
    }
    if (proposalRef.current?.proposal !== proposal || proposalRef.current.doc !== doc || !isEffectIntentProposalCurrent(doc, proposal)) {
      proposalRef.current = null;
      setProposal(null);
      setMessage("Zariadenie sa zmenilo. Vytvor nový návrh z aktuálneho stavu.");
      return;
    }
    const values = Object.fromEntries(proposal.changes.map((change) => [change.paramId, change.after]));
    if (!services.engine.beginEffectIntentPreview(trackId, effect.id, values, onPreviewEnded)) {
      setMessage("Live audio preview nie je dostupný. Návrh môžeš stále skontrolovať a aplikovať.");
      return;
    }
    previewRef.current = { baseDoc: doc, proposal };
    setPreviewing(true);
    setMessage("Počúvaš dočasný návrh. Projekt sa nemení, kým nestlačíš Apply.");
  };

  const applyProposal = () => {
    if (!proposal) return;
    const doc = services.store.getDoc();
    if (proposalRef.current?.proposal !== proposal || proposalRef.current.doc !== doc || !isEffectIntentProposalCurrent(doc, proposal)) {
      cancelPreview();
      proposalRef.current = null;
      setProposal(null);
      setMessage("Návrh je zastaraný. Vytvor ho znova z aktuálneho stavu.");
      return;
    }
    cancelPreview();
    proposalRef.current = null;
    try {
      services.store.execute(applyEffectIntentProposal(doc, proposal));
      setProposal(null);
      setMessage("Zmeny aplikované ako jedna vratná operácia.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Návrh sa nepodarilo aplikovať.");
    }
  };

  const closeAssistant = () => {
    cancelPreview();
    proposalRef.current = null;
    setOpen(false);
    setProposal(null);
    setMessage("");
  };

  return (
    <div className="effect-intent-assistant">
      <button
        type="button"
        className="btn btn-small effect-intent-trigger"
        aria-expanded={open}
        onClick={() => {
          if (open) closeAssistant();
          else setOpen(true);
        }}
      >
        ✦ Ask FX
      </button>
      {open && (
        <section className="effect-intent-panel" aria-label={`Ask FX — ${effect.type}`}>
          <div className="effect-intent-heading">
            <div>
              <strong>Uprav zvuk pomocou zámeru</strong>
              <span>{effect.type.toUpperCase()} · iba toto zariadenie · offline</span>
            </div>
            <button type="button" className="btn btn-small" onClick={closeAssistant} aria-label="Close FX intent">
              ×
            </button>
          </div>
          <form className="effect-intent-form" onSubmit={buildProposal}>
            <label htmlFor={`effect-intent-${effect.id}`}>Čo chceš zmeniť?</label>
            <input
              id={`effect-intent-${effect.id}`}
              value={request}
              maxLength={500}
              onChange={(event) => setRequest(event.target.value)}
              placeholder="Napr. trochu teplejšie, ale nechaj výšky tak"
              autoComplete="off"
            />
            <button type="submit" className="btn btn-small" disabled={!request.trim()}>
              Navrhnúť zmenu
            </button>
          </form>

          {fallbackReason && <p className="effect-intent-warning">Audio beží cez fallback: {fallbackReason}</p>}
          {message && <p className="effect-intent-message" role="status" aria-live="polite">{message}</p>}

          {proposal && (
            <div className="effect-intent-proposal">
              <div className="effect-intent-summary">{proposal.summary}</div>
              <ul>
                {proposal.changes.map((change) => (
                  <li key={change.paramId}>
                    <div className="effect-intent-change">
                      <strong>{change.label}</strong>
                      <span>{change.beforeText} <span aria-hidden="true">→</span> {change.afterText}</span>
                    </div>
                    <small>{change.rationale}</small>
                  </li>
                ))}
              </ul>
              {proposal.warnings.map((warning) => (
                <p className="effect-intent-warning" key={warning}>{warning}</p>
              ))}
              <div className="effect-intent-actions">
                <button
                  type="button"
                  className={`btn btn-small${previewing ? " active" : ""}`}
                  disabled={effect.bypassed}
                  title={effect.bypassed ? "Najprv zapni zariadenie, aby sa dalo vypočuť" : "Dočasne vypočuť bez zmeny projektu"}
                  onClick={togglePreview}
                >
                  {previewing ? "Zastaviť preview" : "Vypočuť"}
                </button>
                <button type="button" className="btn btn-small btn-primary" onClick={applyProposal}>
                  Apply zmeny
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    cancelPreview();
                    proposalRef.current = null;
                    setProposal(null);
                    setMessage("Návrh zahodený; projekt ostal nezmenený.");
                  }}
                >
                  Zahodiť
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
