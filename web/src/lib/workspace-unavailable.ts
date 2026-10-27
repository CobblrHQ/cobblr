import { useSyncExternalStore } from "react";
import { onSessionChange } from "./session-identity";

const unavailable = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
onSessionChange(() => { unavailable.clear(); notify(); });

export function markWorkspaceUnavailable(slug: string): void {
  if (unavailable.has(slug)) return;
  unavailable.add(slug);
  notify();
}

export function useWorkspaceUnavailable(slug: string): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => unavailable.has(slug),
    () => false,
  );
}
