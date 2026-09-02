import { useDoc } from "../ui/context";
import { encodeProjectForGallery, setRemixParent } from "./galleryApi";

const PUBLISH_CODE_KEY = "pf-publish-code";

/**
 * PUBLISH TO GALLERY — hands the current project to /gallery via
 * sessionStorage (keeps the URL clean) and opens the gallery in a new tab,
 * where the publish form is pre-filled. When the studio was entered through
 * a gallery FORK (?import=…&remixOf=<id>), the chain travels along so the
 * published beat links back to its parent.
 */
export function PublishToGalleryButton() {
  const doc = useDoc();
  const publish = () => {
    try {
      sessionStorage.setItem(PUBLISH_CODE_KEY, encodeProjectForGallery(doc));
    } catch {
      // storage blocked — fall back to the URL hand-off below
    }
    const remixOf = new URLSearchParams(location.search).get("remixOf");
    if (remixOf) setRemixParent({ id: remixOf, title: "your forked beat" });
    window.open("/gallery", "_blank", "noopener");
  };
  return (
    <button
      type="button"
      className="btn btn-export"
      title="Drop this beat into the public Beat Gallery (tags + playable embed)"
      onClick={publish}
    >
      PUBLISH TO GALLERY
    </button>
  );
}
