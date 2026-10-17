import { useState } from "react";
import { useDoc } from "../ui/context";
import { encodeProjectForGallery, PUBLISH_CODE_KEY, setRemixParent } from "./galleryApi";
import { GALLERY_RENDER_KEY, provenanceFromStamp } from "./galleryProvenance";
import { lastRenderStamp } from "../export/renderManifest";
import { funnelEvent } from "../services/funnel";

/**
 * PUBLISH TO GALLERY — hands the current project to /gallery via
 * sessionStorage (keeps the URL clean) and opens the gallery in a new tab,
 * where the publish form is pre-filled. When the studio was entered through
 * a gallery FORK (?import=…&remixOf=<id>), the chain travels along so the
 * published beat links back to its parent.
 */
export function PublishToGalleryButton() {
  const doc = useDoc();
  const [error, setError] = useState<string | null>(null);
  const publish = () => {
    funnelEvent("share_publish");
    let code: string;
    try {
      code = encodeProjectForGallery(doc);
    } catch {
      setError("This project is too large to hand off — export it as a file instead.");
      return;
    }
    try {
      sessionStorage.setItem(PUBLISH_CODE_KEY, code);
    } catch {
      // sessionStorage blocked (private mode, quota). Opening the gallery would
      // silently show an EMPTY publish form — the old comment promised a
      // "URL hand-off below" that never existed. Say what happened instead.
      setError("The browser blocked temporary storage — allow site data, or export the project instead.");
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
      <button
        type="button"
        className="btn btn-export"
        title="Drop this beat into the public Beat Gallery (tags + playable embed)"
        onClick={publish}
      >
        PUBLISH TO GALLERY
      </button>
      {error && (
        <span className="save-status save-error" role="alert" title={error}>
          {error}
        </span>
      )}
    </>
  );
}
