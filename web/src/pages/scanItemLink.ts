// A link to one scan-inbox row (`/scan?item=<id>`): what the page does with it.
//
// The doors that link to a row are a search result (#3823's palette) and the
// dashboard's captured-item card (#3049). On a desk the page already shows the
// row, so it opens THAT card in place: scrolled to, expanded, outlined for a
// moment. It used to open the full-screen review over the page too ("All items
// · 67 of 144"), which the owner read as being taken somewhere twice (#3909).
// On a phone a row opens as its item screen, as it does from the list.
//
// The link stays in the address, so Back and a reload land on the same card.
// It is acted on once per value, so the list's poll does not reopen it.
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

export interface ScanItemLink {
  /** The desk: the card to open in place, with a counter that changes each
   *  time it should open (the card watches it). */
  openInPlace: { id: string; signal: number } | null;
  /** The phone: the row whose item screen to open. */
  openScreen: string | null;
  /** Mark it in the list (scroll to it, outline it for a moment). */
  highlight: string | null;
}

export function useScanItemLink(items: ReadonlyArray<{ id: string }>, handheld: boolean): ScanItemLink {
  const [params] = useSearchParams();
  const linked = params.get("item");
  const handled = useRef<string | null>(null);
  const [link, setLink] = useState<ScanItemLink>({ openInPlace: null, openScreen: null, highlight: null });
  useEffect(() => {
    if (!linked) {
      handled.current = null;
      return;
    }
    if (handled.current === linked || !items.some((i) => i.id === linked)) return;
    handled.current = linked;
    setLink((prev) =>
      handheld
        ? { openInPlace: null, openScreen: linked, highlight: linked }
        : { openInPlace: { id: linked, signal: (prev.openInPlace?.signal ?? 0) + 1 }, openScreen: null, highlight: linked },
    );
  }, [linked, items, handheld]);
  return link;
}
