// Where a View as through a share lands (docs/design-decisions/share-spaces.md §14):
// the link the owner's Cobblr made carries the grant and the share space in
// its fragment (never sent to a server, never in a log). This tab keeps the
// grant and opens the share space; the banner takes it from there.

import { useEffect, useState } from "react";
import { setShareViewToken } from "../lib/share-view";
import { markPageLeaving } from "../lib/page-leaving";

export function ViewAsPage() {
  const [bad, setBad] = useState(false);
  useEffect(() => {
    const p = new URLSearchParams(window.location.hash.slice(1));
    const t = p.get("t");
    const w = p.get("w");
    if (!t || !w || !/^[a-z0-9-]+$/i.test(w)) {
      setBad(true);
      return;
    }
    // This page's own polls would go out with the share's grant, which reads
    // only the share space, and be refused: it asks nothing more first.
    markPageLeaving();
    setShareViewToken(t);
    window.location.replace(`/w/${w}/`);
  }, []);
  return (
    <div className="mx-auto mt-16 max-w-md text-center text-sm text-muted" data-testid="view-as-landing">
      {bad ? "This view link is not complete. Open View as again from Settings, Sharing." : "Opening the view…"}
    </div>
  );
}
