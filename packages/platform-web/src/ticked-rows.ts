// The rows a person has ticked on a list, kept through a reload.
//
// Every checkbox list kept its ticks in component state, so a refresh threw
// them away: eleven inbox items ticked to ask Cobb about "these" were all
// unticked by the reload that was meant to show the result (#4587).
//
// So the ticks live in this tab's sessionStorage, keyed by the page and the
// filters in its address: a new tab starts empty, another list or another
// filter has its own. What the page no longer shows (deleted, filed, moved
// away) is dropped as soon as the page knows its rows, so a restored
// selection never names a row that is not there. And the rows a selection
// bar handed to Cobb follow the ticks: unticking all of them, or a row
// leaving the page, takes it out of Cobb's chip too (chat-context).

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useLocation } from "react-router-dom";
import { clearBarSelection, trimBarSelection } from "./chat-context";

const PREFIX = "cobblr.ticked:";

function read(key: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(key);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function write(key: string, ids: ReadonlySet<string>): void {
  try {
    if (ids.size === 0) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    /* storage refused (private window, quota): the ticks still work, they just do not outlive the page */
  }
}

/** The page plus its filters, as the address carries them. */
export function tickedRowsKey(pathname: string, search: string, list?: string): string {
  return PREFIX + pathname + search + (list ? `#${list}` : "");
}

/** Clear the ticks for a bulk action that finished, and get back the function
 *  its Undo calls to tick them again. */
export type ClearForUndo = () => () => void;

/** How long rows an Undo ticked again may be missing from the page while it
 *  fetches them back, before they count as gone. */
const UNDO_GRACE_MS = 10_000;

/** useState for a list's ticked ids, kept for this tab through a reload.
 *
 *  `shownIds` is every row the page has loaded, or null while it is still
 *  loading: a restored id the page does not show is dropped, and nothing is
 *  dropped before the page knows what it has. The third value clears the
 *  ticks after a bulk action and returns what its Undo calls to put them
 *  back. */
export function useTickedRows(
  shownIds: readonly string[] | null,
  /** Which list, when one page shows several. */
  list?: string,
): [Set<string>, Dispatch<SetStateAction<Set<string>>>, ClearForUndo] {
  const { pathname, search } = useLocation();
  const key = tickedRowsKey(pathname, search, list);
  const [state, setState] = useState(() => ({ key, ids: read(key) }));
  // Another list, or another filter, under the same component: its own ticks.
  const ids = state.key === key ? state.ids : read(key);
  if (state.key !== key) setState({ key, ids });

  const set = useCallback<Dispatch<SetStateAction<Set<string>>>>(
    (next) => {
      setState((cur) => {
        const prev = cur.key === key ? cur.ids : read(key);
        const ids = typeof next === "function" ? next(prev) : next;
        write(key, ids);
        // Nothing ticked any more (×, a finished bulk action): Cobb is not
        // about them either.
        if (ids.size === 0 && prev.size > 0) queueMicrotask(clearBarSelection);
        return { key, ids };
      });
    },
    [key],
  );

  // Rows an Undo just ticked again, which the page may not have fetched back
  // yet: not dropped as gone until they show or the grace runs out.
  const returning = useRef<{ ids: Set<string>; until: number } | null>(null);

  const shownKey = shownIds ? shownIds.join("\n") : null;
  useEffect(() => {
    if (shownKey === null) return;
    const shown = new Set(shownKey ? shownKey.split("\n") : []);
    const back = returning.current;
    if (back) {
      for (const id of back.ids) if (shown.has(id)) back.ids.delete(id);
      if (back.ids.size === 0 || Date.now() > back.until) returning.current = null;
    }
    const keep = (id: string) => shown.has(id) || !!returning.current?.ids.has(id);
    trimBarSelection(new Set([...shown, ...(returning.current?.ids ?? [])]));
    set((cur) => {
      if ([...cur].every(keep)) return cur;
      return new Set([...cur].filter(keep));
    });
  }, [shownKey, set]);

  const clearForUndo = useCallback<ClearForUndo>(() => {
    const before = new Set(ids);
    set(new Set());
    return () => {
      returning.current = { ids: new Set(before), until: Date.now() + UNDO_GRACE_MS };
      set(before);
    };
  }, [ids, set]);

  return [ids, set, clearForUndo];
}
