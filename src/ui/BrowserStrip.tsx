import { Suspense, lazy, useEffect, useState } from "react";
import { useServices } from "./context";
import { setInstrumentSample, setPadParams } from "../commands/commands";
import { FACTORY_ASSETS } from "../sample-library/manifest";
import type { Track } from "../project-model/types";

const SampleBrowser = lazy(() => import("./SampleBrowser").then((m) => ({ default: m.SampleBrowser })));

const STRIP_STORAGE_KEY = "pf-browser-strip-v1";

function loadStripOpen(): boolean {
  try {
    return JSON.parse(localStorage.getItem(STRIP_STORAGE_KEY) ?? "true") !== false;
  } catch {
    return true;
  }
}

/**
 * Left sounds strip (ROADMAP-UI-2027, Vlna 4) — the FL-Studio browser
 * lesson: the library is ALWAYS one glance away, never a dialog. Clicking a
 * sound assigns it to the current target (selected drum pad, or the selected
 * instrument track's sample slot) and previews it; dragging drops onto
 * sequencer rows and track tabs.
 *
 * Lazy: the browser (and its DropZone/Freesound/intake chunk) mounts on
 * first expand — a session that never opens sounds pays nothing. The
 * collapsed state is a slim labelled rail, so reopening is one click.
 */
export function BrowserStrip({ track, selectedPadId }: { track: Track; selectedPadId: string }) {
  const services = useServices();
  const [open, setOpen] = useState(loadStripOpen);

  useEffect(() => {
    try {
      localStorage.setItem(STRIP_STORAGE_KEY, JSON.stringify(open));
    } catch {
      /* cosmetic preference — quota/private mode stays silent */
    }
  }, [open]);

  const doc = services.store.getDoc();
  const drumPad =
    track.kind === "drum" ? (track.pads.find((pad) => pad.id === selectedPadId) ?? track.pads[0] ?? null) : null;
  const instrumentTarget = track.kind === "instrument" ? track : null;
  const currentId = drumPad ? drumPad.assetId : instrumentTarget ? instrumentTarget.sampleId : null;

  const assign = (assetId: string | null) => {
    // The strip has no target of its own — it borrows the selection: the
    // selected drum pad first, then the selected instrument track. Preview
    // already fired inside the browser's apply(); this is just the write.
    if (drumPad) {
      services.store.execute(setPadParams(doc, drumPad.id, { assetId }));
      return;
    }
    if (instrumentTarget) {
      services.store.execute(setInstrumentSample(doc, instrumentTarget.id, assetId));
    }
  };

  if (!open) {
    return (
      <aside className="browser-strip collapsed" aria-label="Sounds (collapsed)">
        <button
          type="button"
          className="browser-strip-rail"
          onClick={() => setOpen(true)}
          aria-label="Open sounds browser"
          title="Sounds — open the browser strip"
        >
          <span className="browser-strip-rail-label">SOUNDS</span>
          <span aria-hidden="true">▸</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="browser-strip" aria-label="Sounds">
      <div className="browser-strip-head">
        <span className="panel-kicker">SOUNDS</span>
        <span className="browser-strip-target" title="Clicking a sound assigns to this target and previews it">
          {drumPad ? `→ ${drumPad.name}` : instrumentTarget ? `→ ${instrumentTarget.name}` : "no target"}
        </span>
        <button
          type="button"
          className="browser-strip-collapse"
          onClick={() => setOpen(false)}
          aria-label="Collapse sounds browser"
          title="Collapse the sounds strip"
        >
          ◂
        </button>
      </div>
      <div className="browser-strip-body">
        <Suspense fallback={<div className="panel-loading">Loading sounds…</div>}>
          <SampleBrowser
            assets={FACTORY_ASSETS}
            currentId={currentId}
            onSelect={assign}
            allowNone={Boolean(drumPad || instrumentTarget)}
            showDropZone
          />
        </Suspense>
      </div>
    </aside>
  );
}
