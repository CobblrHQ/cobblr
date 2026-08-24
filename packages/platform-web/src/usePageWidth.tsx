// Let a page ask for the whole screen.
//
// Every page is centred in a max-w-6xl column, which is right for a form, a
// record, a settings panel: prose and fields are unreadable at 2000px. It is
// wrong for a wide TABLE. The inventory list has an id, a thumbnail, a name, a
// category, a location and up to five more columns, and at 6xl the name column
// either truncates a real product title or shoves the last column off the edge.
// A 27in monitor sits there with 900px of empty margin on each side while the
// table it is showing scrolls sideways.
//
// So a page opts in, the same shape as usePageTitle next door: a hook with a
// DOM side effect and a cleanup, no provider to thread through and nothing for
// a module-owned page to import from web/src.
//
//   usePageWidth("wide");   // at the top of the component
//
// The class lives in CSS rather than on the container's className because the
// container is rendered by AppLayout and the page is several levels below it.
// Toggling an attribute on <body> is the one channel they already share.

import { useEffect } from "react";

export type PageWidth = "default" | "wide";

export function usePageWidth(width: PageWidth): void {
  useEffect(() => {
    if (width === "default") return;
    // Counted, not a boolean: two pages can be mounted for a moment while one
    // navigates to the other, and the leaver's cleanup would otherwise narrow
    // the page the arriver just widened.
    const n = Number(document.body.dataset.wideCount ?? "0") + 1;
    document.body.dataset.wideCount = String(n);
    document.body.dataset.pageWidth = "wide";
    return () => {
      const left = Number(document.body.dataset.wideCount ?? "1") - 1;
      document.body.dataset.wideCount = String(Math.max(0, left));
      if (left <= 0) delete document.body.dataset.pageWidth;
    };
  }, [width]);
}
