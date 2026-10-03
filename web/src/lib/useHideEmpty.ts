import { useCallback, useSyncExternalStore } from "react";
import { useAuth } from "../auth/AuthContext";

const EVENT = "cobblr:hide-empty";
function subscribe(changed: () => void) {
  window.addEventListener(EVENT, changed);
  window.addEventListener("storage", changed);
  return () => {
    window.removeEventListener(EVENT, changed);
    window.removeEventListener("storage", changed);
  };
}

export function useHideEmpty(page: "locations" | "tags"): [boolean, (value: boolean) => void] {
  const { user } = useAuth();
  const key = user ? `cobblr.hide-empty.${user.id}.${page}` : null;
  const read = useCallback(() => {
    try { return !!key && localStorage.getItem(key) === "1"; }
    catch { return false; }
  }, [key]);
  const value = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => {
    if (!key) return;
    try { localStorage.setItem(key, next ? "1" : "0"); }
    catch { return; }
    window.dispatchEvent(new Event(EVENT));
  }, [key]);
  return [value, set];
}
