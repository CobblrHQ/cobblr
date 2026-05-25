// Set document.title for the current page. Falls back to "cobblr"
// when the page unmounts so leftover tabs don't keep a stale title.
// Pages call this once at the top of the component:
//
//   usePageTitle("Locations");
//   usePageTitle(`Bin 1 · Locations`);  // detail pages get specific
//
// The hook prefixes "cobblr · " automatically so every tab title in a
// multi-tab session is identifiable at a glance.

import { useEffect } from "react";

export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} · cobblr` : "cobblr";
    return () => {
      document.title = previous;
    };
  }, [title]);
}
