import { useEffect, useState } from "react";

// "The view I picked should still be there after a refresh." A generic,
// per-device localStorage-backed useState for small UI selections — the tab
// you're on, a chosen grouping, a layout. Same idea as useViewMode (list/tiles),
// generalized so any page can persist its selected view without re-implementing
// the storage dance. Drop-in for useState: same [value, setValue] shape.
//
// Scope: UI selections only (tabs/views/filters), never data or secrets. Keys
// are namespaced under `cobblr.ui.` so they're easy to spot + clear.
export function usePersistedState<T>(key: string, initial: T): [T, (v: T) => void] {
  const storageKey = `cobblr.ui.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* private mode / quota — fine, just won't persist */
    }
  }, [storageKey, value]);
  return [value, setValue];
}
