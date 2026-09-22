// A timer a component starts dies with the component.
//
// `setTimeout(() => setFlash(null), 1200)` in a hook outlives the component
// that owns it: unmount inside the 1.2s and the callback runs anyway. In a
// browser that is a wasted update; in a test run it fires after the
// environment is torn down, React reaches for `window`, and the whole suite
// is red on a run where every test passed (#3463). So a hook schedules its
// later work through this: one pending timer per key (a new flash replaces
// the old one's timer instead of racing it), all of them cleared on unmount,
// and `alive` for a promise continuation that lands after it.

import { useEffect, useMemo, useRef } from "react";

export interface Later {
  /** Run `fn` in `ms`, replacing whatever was pending under `key`. Never
   *  runs once the component is gone. */
  after(key: string, ms: number, fn: () => void): void;
  /** False once the component is gone: a promise that answers after it
   *  checks this before touching state. */
  readonly alive: boolean;
}

export function useLater(): Later {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const pending = timers.current;
    return () => {
      alive.current = false;
      for (const handle of pending.values()) clearTimeout(handle);
      pending.clear();
    };
  }, []);
  return useMemo<Later>(
    () => ({
      after(key, ms, fn) {
        const pending = timers.current;
        const prev = pending.get(key);
        if (prev !== undefined) clearTimeout(prev);
        pending.set(
          key,
          setTimeout(() => {
            pending.delete(key);
            if (alive.current) fn();
          }, ms),
        );
      },
      get alive() {
        return alive.current;
      },
    }),
    [],
  );
}
