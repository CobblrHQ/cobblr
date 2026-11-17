// "Yarn is new: find it here." A one-time pointer at the table a first filing
// went to, on the menu that holds it (#3789); "New" only when it made it (#9484).
//
// Installing a table on the way to filing adds a word to the navigation that
// nobody told them about: on a phone it is one of ten entries behind the
// menu button. The first filing ever points at it: the menu button carries a
// dot, and inside the menu that table carries "New", until the menu is opened.
// Per workspace, per browser; losing it (private window, cleared storage)
// costs only the hint.

import { useEffect, useState } from "react";

const KEY = (slug: string) => `cobblr.nav-pointer.${slug}`;
// Set only when the filing set the table up; a table the workspace already had
// is pointed at as "Here", never "New" (#9484).
const NEW_KEY = (slug: string) => `cobblr.nav-pointer-new.${slug}`;
const EVENT = "cobblr:nav-pointer";

/** Point at `label` in this workspace's navigation until the menu is opened. */
export function pointAtInNav(slug: string, label: string, madeTheTable: boolean): void {
  try {
    localStorage.setItem(KEY(slug), label);
    if (madeTheTable) localStorage.setItem(NEW_KEY(slug), "1");
    else localStorage.removeItem(NEW_KEY(slug));
  } catch {
    /* only the hint is lost */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: slug }));
}

function read(slug: string): { label: string | null; isNew: boolean } {
  try {
    return { label: localStorage.getItem(KEY(slug)), isNew: localStorage.getItem(NEW_KEY(slug)) === "1" };
  } catch {
    return { label: null, isNew: false };
  }
}

/** The label the navigation should point at, whether the filing made that
 *  table, and the way to say it was seen. */
export function useNavPointer(slug: string | null | undefined): { label: string | null; isNew: boolean; seen: () => void } {
  const [at, setAt] = useState<{ label: string | null; isNew: boolean }>(() => (slug ? read(slug) : { label: null, isNew: false }));
  useEffect(() => {
    if (!slug) return;
    setAt(read(slug));
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === slug) setAt(read(slug));
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [slug]);
  return {
    label: at.label,
    isNew: at.isNew,
    seen: () => {
      if (!slug) return;
      try {
        localStorage.removeItem(KEY(slug));
        localStorage.removeItem(NEW_KEY(slug));
      } catch {
        /* nothing to clear */
      }
      setAt({ label: null, isNew: false });
    },
  };
}
