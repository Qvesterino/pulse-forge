import { useState } from "react";
import { useDoc } from "../ui/context";
import { encodeProjectForGallery, PUBLISH_CODE_KEY, setRemixParent } from "./galleryApi";
import { GALLERY_RENDER_KEY, provenanceFromStamp } from "./galleryProvenance";
import { lastRenderStamp } from "../export/renderManifest";
import { funnelEvent } from "../services/funnel";
import { t, useLocale } from "../i18n";

/**
 * PUBLISH TO GALLERY — hands the current project to /gallery via
 * sessionStorage (keeps the URL clean) and opens the gallery in a new tab,
 * where the publish form is pre-filled. When the studio was entered through
 * a gallery FORK (?import=…&remixOf=<id>), the chain travels along so the
 * published beat links back to its parent.
 *
 * i18n PATTERN PANEL (src/i18n/index.ts): every user-facing string here goes
 * through `t()`, so this panel both stays English by default and demonstrates
 * the migration pattern for the next panel.
 */
export function PublishToGalleryButton() {
  const doc = useDoc();
  useLocale(); // re-render when the language changes
  const [error, setError] = useState<string | null>(null);
  const publish = () => {
    funnelEvent("share_publish");
    let code: string;
    try {
      code = encodeProjectForGallery(doc);
    } catch {
      setError(t("publish.tooLarge"));
      return;
    }
    try {
      sessionStorage.setItem(PUBLISH_CODE_KEY, code);
    } catch {
      // sessionStorage blocked (private mode, quota). Opening the gallery would
      // silently show an EMPTY publish form — the old comment promised a
      // "URL hand-off below" that never existed. Say what happened instead.
      setError(t("publish.storageBlocked"));
      return;
    }
    setError(null);
    // Render provenance travels beside the code: the SHA-256 of the export's
    // PCM plus the AI receipts, so the gallery can show a claim a reader can
    // check. Optional by design — no export stamp, no claim (and a stale one
    // from a previous publish is cleared rather than reused).
    const provenance = provenanceFromStamp(lastRenderStamp());
    try {
      if (provenance != null) sessionStorage.setItem(GALLERY_RENDER_KEY, JSON.stringify(provenance));
      else sessionStorage.removeItem(GALLERY_RENDER_KEY);
    } catch {
      /* provenance is a bonus; the hand-off below is the essential part */
    }
    const remixOf = new URLSearchParams(location.search).get("remixOf");
    if (remixOf) setRemixParent({ id: remixOf, title: "your forked beat" });
    window.open("/gallery", "_blank", "noopener");
  };
  return (
    <>
      <button type="button" className="btn btn-export" title={t("publish.title")} onClick={publish}>
        {t("publish.cta")}
      </button>
      {error && (
        <span className="save-status save-error" role="alert" title={error}>
          {error}
        </span>
      )}
    </>
  );
}
