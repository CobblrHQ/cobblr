// The dashboard arrives at once (#6563).
//
// It drew in five waves: about forty requests, each section on screen when
// its own answer landed and the page growing and shrinking under the reader
// (CLS 0.4 on a desk, 1.0 on a phone). Now:
//
//   - one request: the server answers every section's reads in one snapshot
//     (GET /orgs/:slug/dashboard), and each section's own query is answered
//     from it (platform-web primed-reads), so no section asks on its own;
//   - instant paint: the page as it last stood is kept on this device, per
//     person and workspace, and drawn from at once; the snapshot then brings
//     every section up to date in the same moment, never one by one;
//   - a first visit shows one skeleton for the page, then all of it.
//
// What is kept is what this person's own browser already showed them; it is
// never kept while viewing as someone else, and signing out forgets it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { dehydrate, hydrate, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { clearPrimedReads, holdPrimedReads, primeReads } from "@cobblr/platform-web";
import { dayHere } from "@cobblr/platform-contract/day";
import { api } from "../lib/api";
import { getImpersonationToken } from "../lib/impersonation";
import { getShareViewToken } from "../lib/share-view";
import { COPY_PREFIX, isPlainJson, readCopy, writeCopy } from "./device-copy";
import { upNextWindow } from "../lib/up-next";

/** A snapshot that has not come by then is given up on: each section asks for itself. */
export const SNAPSHOT_WAIT_MS = 8_000;
/** The first visit's whole page is shown by then, settled or not. */
export const REVEAL_CAP_MS = 2_500;
/** A copy is taken once the page has been still this long. */
const SAVE_AFTER_MS = 3_000;

/** Keeping a copy is this person's own browser, signed in as themselves. */
function mayKeep(): boolean {
  return !getImpersonationToken() && !getShareViewToken();
}

function PageSkeleton() {
  // One shape for the whole page: the header line, a row of jump-to tiles,
  // the at-a-glance grid and a list, all quiet.
  const block = "rounded-xl bg-subtle/60 dark:bg-slate-800/60";
  return (
    <div aria-busy="true" aria-label="Dashboard" className="space-y-6" data-testid="dashboard-skeleton">
      <div className={`${block} h-10 w-2/3`} />
      <div className="grid grid-cols-2 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${block} h-14`} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${block} h-16`} />
        ))}
      </div>
      <div className={`${block} h-40`} />
    </div>
  );
}

/** The page's own code that loads beside it (a lazy panel, a module's
 *  tile), started as the page's chunk loads: `ready` once it has. */
export interface PageCode {
  ready: boolean;
  loaded: Promise<unknown>;
}
export function startPageCode(load: () => Promise<unknown>): PageCode {
  const code: PageCode = { ready: false, loaded: Promise.resolve() };
  code.loaded = load().then(
    () => void (code.ready = true),
    () => void (code.ready = true),
  );
  return code;
}

/** The snapshot for a workspace, asked once however many times the gate
 *  renders (React draws a first render twice in development). While it is on
 *  its way, every read of the workspace waits for it (primed-reads). */
let asking: { slug: string; at: number; primed: Promise<void> } | null = null;
function askSnapshot(slug: string): Promise<void> {
  if (asking && asking.slug === slug && Date.now() - asking.at < 1_000) return asking.primed;
  const ask = api.getDashboardSnapshot(slug, { today: dayHere(), ...upNextWindow(new Date()) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("snapshot late")), SNAPSHOT_WAIT_MS);
  });
  // Primed before anything held is let go, so a held read finds its answer.
  const primed = Promise.race([ask, late])
    .then((s) => primeReads(s.entries))
    .finally(() => clearTimeout(timer));
  holdPrimedReads(slug, primed);
  asking = { slug, at: Date.now(), primed };
  return primed;
}

export function DashboardSnapshotGate({
  slug,
  userId,
  code,
  className = "",
  children,
}: {
  slug: string;
  userId: string | null;
  /** Loaded before the page is shown, so nothing appears after it. */
  code: PageCode;
  /** The page's own layout (its section spacing). */
  className?: string;
  children: ReactNode;
}) {
  const qc = useQueryClient();
  const key = userId && mayKeep() ? `${COPY_PREFIX}${userId}:${slug}` : null;
  // In the first render, before any section or the shell asks: the device's
  // copy drawn into the page's queries, and the one request on its way.
  const [start] = useState(() => {
    const copy = key ? readCopy(key) : null;
    if (copy) hydrate(qc, copy.state);
    return { warm: !!copy, primed: askSnapshot(slug) };
  });
  const [answered, setAnswered] = useState(start.warm);
  const [codeReady, setCodeReady] = useState(code.ready);
  const [shown, setShown] = useState(start.warm && code.ready);

  useEffect(() => {
    let live = true;
    void start.primed.then(
      () => live && setAnswered(true),
      () => live && setAnswered(true),
    );
    void code.loaded.then(() => live && setCodeReady(true));
    return () => {
      live = false;
      clearPrimedReads();
    };
  }, [start, code]);

  // Shown whole: the page has mounted out of sight and nothing in it still
  // says it is busy (a section's placeholder, a lazy panel's, all marked
  // aria-busy). A first visit also waits for nothing to be asking; a visit
  // drawn from the device's copy is already answered by it.
  const fetching = useIsFetching();
  const page = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (shown || !answered || !codeReady) return;
    if (!start.warm && fetching > 0) return;
    let frame = 0;
    const look = () => {
      if (page.current && !page.current.querySelector('[aria-busy="true"]')) setShown(true);
      else frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [shown, answered, codeReady, fetching, start.warm]);
  useEffect(() => {
    if (shown || !answered) return;
    const t = setTimeout(() => setShown(true), REVEAL_CAP_MS);
    return () => clearTimeout(t);
  }, [shown, answered]);

  // The copy the next visit draws from: what the page shows once it is still.
  useEffect(() => {
    if (!shown || !key) return;
    const save = () =>
      writeCopy(key, {
        v: 1,
        at: Date.now(),
        state: dehydrate(qc, { shouldDehydrateQuery: (q) => q.state.status === "success" && q.getObserversCount() > 0 && isPlainJson(q.state.data) }),
      });
    const t = setTimeout(save, SAVE_AFTER_MS);
    window.addEventListener("pagehide", save);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pagehide", save);
    };
  }, [shown, key, qc]);

  if (!answered) return <PageSkeleton />;
  // One wrapper whether shown or not, so showing it moves nothing in the tree
  // and nothing on the page mounts twice. The page lays out in its own place
  // while out of sight, under the skeleton: showing it changes what is
  // visible, never where anything is.
  return (
    <div className="relative">
      <div ref={page} aria-hidden={shown ? undefined : true} className={shown ? className : `${className} invisible pointer-events-none`}>
        {children}
      </div>
      {!shown && (
        <div className="absolute inset-x-0 top-0 bg-canvas dark:bg-slate-950">
          <PageSkeleton />
        </div>
      )}
    </div>
  );
}
