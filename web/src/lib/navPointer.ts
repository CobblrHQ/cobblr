// "Yarn is new: find it here." A one-time pointer at a table the person just
// got, on the menu that holds it (#3789).
//
// Installing a table on the way to filing adds a word to the navigation that
// nobody told them about: on a phone it is one of ten entries behind the
// menu button. The first filing ever points at it: the menu button carries a
// dot, and inside the menu that table carries "New", until the menu is opened.
// Per workspace, per browser; losing it (private window, cleared storage)
// costs only the hint.

import { useEffect, useState } from "react";

const KEY = (slug: string) => `cobblr.nav-pointer.${slug}`;
const EVENT = "cobblr:nav-pointer";

/** Point at `label` in this workspace's navigation until the menu is opened. */
export function pointAtInNav(slug: string, label: string): void {
  try {
    localStorage.setItem(KEY(slug), label);
  } catch {
    /* only the hint is lost */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: slug }));
}

function read(slug: string): string | null {
  try {
    return localStorage.getItem(KEY(slug));
  } catch {
    return null;
  }
}

/** The label the navigation should point at, and the way to say it was seen. */
export function useNavPointer(slug: string | null | undefined): { label: string | null; seen: () => void } {
  const [label, setLabel] = useState<string | null>(() => (slug ? read(slug) : null));
  useEffect(() => {
    if (!slug) return;
    setLabel(read(slug));
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === slug) setLabel(read(slug));
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [slug]);
  return {
    label,
    seen: () => {
      if (!slug) return;
      try {
        localStorage.removeItem(KEY(slug));
      } catch {
        /* nothing to clear */
      }
      setLabel(null);
    },
  };
}
