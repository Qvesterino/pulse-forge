import { lazy, Suspense, useEffect, useState } from "react";
import { currentMixPreviewLane, onMixPreviewLane } from "../mcp/mix-preview";

// The eager DAW chunk carries only the ~1 kB lane listener; the card (and
// its renderer import graph) loads the first time an agent arms a preview.
const MixPreviewChip = lazy(() => import("./MixPreviewChipLazy").then((m) => ({ default: m.MixPreviewChipLazy })));

/**
 * Eager mount point for the MIX PREVIEW card: subscribes to the session
 * lane registry and pulls the actual card in only while a lane exists.
 */
export function MixPreviewMount() {
  // Once opened, keep the card mounted through Apply's asynchronous render:
  // the registry is cleared immediately to prevent a second Apply, while the
  // card owns the post-apply result until the user dismisses it.
  const [opened, setOpened] = useState(currentMixPreviewLane() != null);
  useEffect(
    () =>
      onMixPreviewLane((lane) => {
        if (lane) setOpened(true);
      }),
    [],
  );
  if (!opened) return null;
  return (
    <Suspense fallback={null}>
      <MixPreviewChip />
    </Suspense>
  );
}
