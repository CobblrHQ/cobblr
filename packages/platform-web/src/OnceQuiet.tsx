// The part of a page that fills in from several answers of its own, shown
// whole once the page has stopped asking (#7790, #7791).
//
// A page's lower half (a place's fields, what other modules add, its files,
// the buttons at the foot) is made of parts that each ask for something and
// grow when the answer comes. Drawn as each came, every answer pushed the
// buttons below it down under a finger. Laid out at once, so every read
// starts with the page's and every part is measured at its real size, but
// invisible until nothing has been in flight for a moment: then all of it
// shows together, and stays.

import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

/** How long nothing may be in flight before it counts as quiet: one answer
 *  often starts the next ask, and the gap between the two is not quiet. */
export const QUIET_MS = 150;

// A part still loading its own code (a panel another module adds, drawn
// lazily) is not a read, so it says it is still coming while its fallback is
// on screen.
const holding = new Set<symbol>();
const told = new Set<() => void>();
const tell = () => told.forEach((f) => f());

/** Put in a Suspense fallback: the page is not quiet while it shows. */
export function HoldsQuiet() {
  useEffect(() => {
    const me = Symbol("holds quiet");
    holding.add(me);
    tell();
    return () => {
      holding.delete(me);
      tell();
    };
  }, []);
  return null;
}

/** True from the first moment no read has been in flight (a read that has
 *  failed once is not waited for), and no part has been loading its code,
 *  for QUIET_MS, and from then on. Judged from the
 *  client's own count, never from the first render: then the parts below have
 *  not started asking yet. */
export function useOnceQuiet(): boolean {
  const qc = useQueryClient();
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    if (quiet) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A read asking again after a failure is not waited for: the part it
    // fills says it failed, and the page is not held through its retries.
    const asking = () => qc.getQueryCache().findAll({ fetchStatus: "fetching" }).filter((q) => q.state.fetchFailureCount === 0).length;
    const still = () => asking() === 0 && holding.size === 0;
    const check = () => {
      clearTimeout(timer);
      if (still()) timer = setTimeout(() => still() && setQuiet(true), QUIET_MS);
    };
    check();
    const stop = qc.getQueryCache().subscribe(check);
    told.add(check);
    return () => {
      stop();
      told.delete(check);
      clearTimeout(timer);
    };
  }, [qc, quiet]);
  return quiet;
}

export function OnceQuiet({ children, className }: { children: ReactNode; className?: string }) {
  const quiet = useOnceQuiet();
  return (
    <div className="relative">
      {!quiet && <p aria-busy="true" className="absolute inset-x-0 top-0 text-sm text-faint dark:text-slate-500">loading…</p>}
      <div className={`${className ?? ""}${quiet ? "" : " invisible"}`} aria-hidden={quiet ? undefined : true}>
        {children}
      </div>
    </div>
  );
}
