// A list's search is kept with the page's place in the browser's history, so
// going back to the list finds it as it was left (#4115).
//
// On a phone, a parts list searched for "M3", a record opened from it and Back
// pressed (or an iPhone's swipe from the left edge) came back to the whole
// list: the search was the page's own state, gone when the page was. It is
// kept in the history entry's own state now, which the browser hands back with
// the page on Back. Never in the address: an address is sent on as a Referer,
// recorded by analytics at the edge and pasted into chats, and what someone
// searched their workspace for is theirs (the coordinator, 2026-11-20).
// Typing replaces the entry rather than adding one, so Back still leaves the
// list, never steps through each letter.
import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

type Kept = { listSearch?: Record<string, string> } & Record<string, unknown>;

/** The list's search and its setter, kept in this history entry under `name`. */
export function useListSearch(name = "q"): [string, (next: string) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const kept = (location.state ?? {}) as Kept;
  const value = kept.listSearch?.[name] ?? "";
  const set = useCallback(
    (next: string) => {
      const state = (location.state ?? {}) as Kept;
      const listSearch = { ...(state.listSearch ?? {}) };
      if (next) listSearch[name] = next;
      else delete listSearch[name];
      navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: { ...state, listSearch } });
    },
    [name, location, navigate],
  );
  return [value, set];
}
