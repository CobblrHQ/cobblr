// "Filed in Yarn." The one notice a one-tap filing leaves on the page it
// opens (#3789): the scan sheet files the item and opens the table it went
// to, which says what just happened, once, with the record one tap away. The
// first filing ever also says where that table lives in the menu. It stays
// until dismissed or until the person moves to another page. Never on a
// timer.

import { useEffect, useState } from "react";

export interface JustFiled {
  label: string;
  firstEver: boolean;
  /** What an install on the way set up, when there was one. */
  installed: string | null;
  /** The record it made, for "Open it". */
  record: string | null;
  /** The page the notice belongs to. */
  path: string;
}

const KEY = "cobblr.just-filed";
const EVENT = "cobblr:just-filed";

export function announceJustFiled(note: JustFiled): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(note));
  } catch {
    /* the notice is lost, the filing is not */
  }
  window.dispatchEvent(new Event(EVENT));
}

function read(): JustFiled | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as JustFiled) : null;
  } catch {
    return null;
  }
}

/** The notice for the page at `path`, and its dismissal. Leaving that page
 *  drops it. */
export function useJustFiled(path: string): { note: JustFiled | null; dismiss: () => void } {
  const [note, setNote] = useState<JustFiled | null>(read);
  useEffect(() => {
    const on = () => setNote(read());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const dismiss = () => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* nothing to clear */
    }
    setNote(null);
  };
  useEffect(() => {
    if (note && note.path !== path) dismiss();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  return { note: note && note.path === path ? note : null, dismiss };
}
