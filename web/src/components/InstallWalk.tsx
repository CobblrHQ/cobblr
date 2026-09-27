// The walk to putting Cobblr on the home screen, as the tour's step and as
// the one-time offer after a first scan. The taps happen inside the browser's
// own sheets, where a page cannot point, so each step is numbered and drawn
// (a sketch of the sheet, not a picture of the browser), and a real arrow
// points only at the first tap, on the browser's own bar.
import { useEffect, useState, type ReactNode } from "react";
import { FloatingChrome, Modal } from "@cobblr/platform-web";
import { InstallPointer } from "./InstallPointer";
import { ArrowLeft, ArrowRight, Bookmark, BookOpen, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, Glasses, MoreHorizontal, Plus, Search, Share, SquarePlus, Star, X } from "lucide-react";
import { dismissInstall, installRoute, installWalk, noteInstallOfferedAfterScan, promptInstall, readInstallEnv, shouldOfferInstallAfterScan, type InstallArt, type InstallRoute } from "../lib/install-app";

// A steady ring: a pulse faded the very words the step asks you to find.
const HI = "ring-2 ring-blue-500 ring-offset-2 ring-offset-white dark:ring-offset-slate-900";

/** A sketch of the screen a step happens on, the thing to tap ringed. */
function Art({ art }: { art: InstallArt }) {
  const frame = (children: ReactNode, align = "justify-end") => (
    <div data-install-art={art} className={`mx-auto flex h-32 w-56 flex-col ${align} gap-1.5 overflow-hidden rounded-xl border border-slate-300 bg-slate-50 p-2 dark:border-slate-600 dark:bg-slate-800`}>
      {children}
    </div>
  );
  const row = (label: ReactNode, hi = false) => (
    <div className={`flex items-center gap-2 rounded-md bg-white px-2 py-1 text-[11px] text-slate-700 dark:bg-slate-700 dark:text-slate-100 ${hi ? HI : ""}`}>{label}</div>
  );
  switch (art) {
    case "safari-compact-bar":
      // Three separate pieces: back, the address pill, ⋯.
      return frame(
        <div className="flex items-center gap-1.5">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white text-slate-500 shadow dark:bg-slate-700"><ChevronLeft size={14} /></span>
          <div className="flex-1 truncate rounded-full bg-white px-2 py-1.5 text-center text-[10px] text-slate-500 shadow dark:bg-slate-700 dark:text-slate-300">{typeof window === "undefined" ? "" : window.location.host}</div>
          <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full bg-white text-slate-700 shadow dark:bg-slate-700 dark:text-slate-100 ${HI}`}><MoreHorizontal size={14} /></span>
        </div>,
      );
    case "safari-toolbar":
      return frame(
        <div className="flex items-center justify-around rounded-lg bg-white px-1 py-1.5 text-slate-500 shadow dark:bg-slate-700">
          <ChevronLeft size={14} />
          <ChevronRight size={14} />
          <span className={`inline-flex h-6 w-6 items-center justify-center rounded-md text-blue-600 dark:text-blue-300 ${HI}`}><Share size={14} /></span>
          <BookOpen size={14} />
          <Copy size={14} />
        </div>,
      );
    case "safari-more-menu":
      return frame(
        <div className="ml-auto w-40 space-y-1">
          {row(<><Share size={12} /> Share</>, true)}
          {row(<><Bookmark size={12} /> Add to Bookmarks</>)}
          {row(<><BookOpen size={12} /> Add Bookmark to…</>)}
          {row(<><Plus size={12} /> New Tab</>)}
        </div>,
        "justify-start",
      );
    case "share-sheet-view-more":
      // The share sheet's round buttons: Add to Home Screen is behind the last.
      return frame(
        <div className="space-y-2">
          <div className="flex justify-around">
            {Array.from({ length: 4 }).map((_, i) => <span key={i} className="h-7 w-7 rounded-lg bg-slate-200 dark:bg-slate-600" />)}
          </div>
          <div className="flex justify-around text-slate-600 dark:text-slate-200">
            {[Copy, Bookmark, Glasses].map((I, i) => (
              <span key={i} className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white dark:bg-slate-700"><I size={13} /></span>
            ))}
            <span className={`inline-flex h-8 w-8 items-center justify-center rounded-full bg-white dark:bg-slate-700 ${HI}`}><ChevronDown size={14} /></span>
          </div>
          <div className="text-right text-[9px] text-slate-500 dark:text-slate-400 pr-1">View More</div>
        </div>,
        "justify-center",
      );
    case "share-sheet-more-list":
      return frame(
        <div className="space-y-1">
          {row(<><Star size={12} /> Add to Favorites</>)}
          {row(<><Search size={12} /> Find on Page</>)}
          {row(<><SquarePlus size={12} /> Add to Home Screen</>, true)}
        </div>,
      );
    case "share-sheet":
      return frame(
        <div className="space-y-1">
          {row(<><Copy size={12} /> Copy</>)}
          {row(<><BookOpen size={12} /> Add to Reading List</>)}
          {row(<><Plus size={12} /> Add to Home Screen</>, true)}
        </div>,
      );
    case "add-sheet":
    case "add-sheet-web-app":
      return frame(
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px] text-slate-500">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white dark:bg-slate-700"><X size={10} /></span>
            <span className="font-semibold text-slate-700 dark:text-slate-100">Add to Home Screen</span>
            <span className={`rounded-full bg-blue-500 px-2 py-0.5 font-semibold text-white ${HI}`}>Add</span>
          </div>
          <div className="flex items-center gap-2 rounded-md bg-white px-2 py-1.5 dark:bg-slate-700">
            <img src="/app-icon.svg" alt="" className="h-6 w-6 rounded-md" />
            <span className="text-[11px] text-slate-700 dark:text-slate-100">Cobblr</span>
          </div>
          {art === "add-sheet-web-app" && (
            <div className="flex items-center justify-between rounded-md bg-white px-2 py-1 text-[11px] text-slate-700 dark:bg-slate-700 dark:text-slate-100">
              Open as Web App
              <span className="inline-flex h-4 w-7 items-center justify-end rounded-full bg-emerald-500 px-0.5"><span className="h-3 w-3 rounded-full bg-white dark:bg-slate-100" /></span>
            </div>
          )}
        </div>,
        "justify-start",
      );
    case "browser-menu":
      return frame(
        <div className="ml-auto w-36 space-y-1">
          {row(<><Plus size={12} /> New tab</>)}
          {row(<><Download size={12} /> Install app</>, true)}
          {row(<><Share size={12} /> Share</>)}
        </div>,
        "justify-start",
      );
    case "install-dialog":
      return frame(
        <div className="mx-auto w-44 space-y-2 rounded-lg bg-white p-2 text-center shadow dark:bg-slate-700">
          <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-100">Install app?</div>
          <div className="flex justify-end gap-2 text-[10px]">
            <span className="text-slate-500">Cancel</span>
            <span className={`rounded px-1.5 font-semibold text-blue-600 dark:text-blue-300 ${HI}`}>Install</span>
          </div>
        </div>,
        "justify-center",
      );
    case "home-screen":
      return frame(
        <div className="grid grid-cols-4 gap-2 px-2">
          {Array.from({ length: 7 }).map((_, n) => (
            <span key={n} className="h-8 w-8 rounded-lg bg-slate-200 dark:bg-slate-600" />
          ))}
          <img src="/app-icon.svg" alt="Cobblr" className={`h-8 w-8 rounded-lg ${HI}`} />
        </div>,
        "justify-center",
      );
  }
}


const pri = "inline-flex items-center gap-1.5 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-sm font-semibold px-4 py-2 transition";
const ghost = "inline-flex items-center gap-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-100 text-sm font-semibold px-4 py-2 transition";
const quiet = "text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 text-xs px-1 py-1.5 transition";

/** The card's contents: the steps for this browser, or the browser's own
 *  Install button where it has one. `onDone` after the last step or the
 *  prompt; `onNotNow` when the person declines. */
export function InstallWalkBody({ route, onDone, onNotNow }: { route: InstallRoute; onDone: () => void; onNotNow: () => void }) {
  const walk = installWalk(route);
  const [n, setN] = useState(0);
  if (!walk) {
    return (
      <div className="text-center" data-testid="install-walk">
        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-blue-600 dark:text-blue-300 mb-2">Cobblr</div>
        <h3 className="text-base font-semibold">Put Cobblr on your home screen</h3>
        <p className="text-sm mt-1.5 leading-relaxed text-slate-500 dark:text-slate-400">Install Cobblr and it opens full screen from your home screen, like any other app, with no address bar in the way.</p>
        <div className="flex flex-wrap items-center justify-center gap-3 mt-4">
          <button type="button" className={ghost} onClick={onNotNow}>Not now</button>
          <button type="button" className={pri} onClick={() => void promptInstall().finally(onDone)}><Download size={14} /> Install</button>
        </div>
      </div>
    );
  }
  const step = walk.steps[n]!;
  const last = n === walk.steps.length - 1;
  return (
    <div className="text-center" data-testid="install-walk" data-install-step={n + 1}>
      {n === 0 && walk.pointer && <InstallPointer {...walk.pointer} />}
      <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-blue-600 dark:text-blue-300 mb-1">Put Cobblr on your home screen</div>
      <div className="text-xs text-slate-500 dark:text-slate-400">Step {n + 1} of {walk.steps.length}</div>
      <h3 className="text-base font-semibold mt-1 mb-2">
        <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 text-[11px] text-white align-[2px]">{n + 1}</span>
        {step.title}
      </h3>
      <Art art={step.art} />
      {step.body && <p className="text-sm mt-2 leading-relaxed text-slate-500 dark:text-slate-400">{step.body}</p>}
      {n === 0 && walk.aside && <p className="text-xs mt-1.5 leading-relaxed text-slate-400 dark:text-slate-500">{walk.aside}</p>}
      <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
        <button type="button" className={quiet} onClick={onNotNow}>Not now</button>
        {n > 0 && <button type="button" className={ghost} onClick={() => setN(n - 1)}><ArrowLeft size={14} /> Back</button>}
        <button type="button" className={pri} onClick={() => (last ? onDone() : setN(n + 1))}>
          {last ? "Done" : <>Next <ArrowRight size={14} /></>}
        </button>
      </div>
    </div>
  );
}

/** Once, after the first scan that lands on this phone: a slim line under the
 *  bar (never over the result that just landed) offering the walk. Asked once
 *  whatever the answer; "not now" also keeps the tour from asking. */
export function InstallOfferAfterScan({ landed }: { landed: boolean }) {
  const [route] = useState(() => installRoute(readInstallEnv()));
  const [phase, setPhase] = useState<"idle" | "offered" | "walking" | "gone">("idle");
  useEffect(() => {
    if (phase !== "idle" || !landed || !shouldOfferInstallAfterScan(route)) return;
    noteInstallOfferedAfterScan();
    setPhase("offered");
  }, [landed, phase, route]);
  if (phase === "offered") {
    return (
      <FloatingChrome anchor="top" data-testid="install-offer" className="inset-x-3 top-[max(4.25rem,calc(env(safe-area-inset-top)+3.75rem))] z-[60] flex items-center gap-2 rounded-xl border border-blue-200 bg-white/95 px-3 py-2 text-sm shadow-lg dark:border-blue-900 dark:bg-slate-900/95">
        <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-200">It landed. Put Cobblr on your home screen?</span>
        <button type="button" className={quiet} onClick={() => { dismissInstall(); setPhase("gone"); }}>Not now</button>
        <button type="button" className="shrink-0 rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white" onClick={() => setPhase("walking")}>Show me</button>
      </FloatingChrome>
    );
  }
  if (phase === "walking") {
    return (
      <Modal open onClose={() => setPhase("gone")} size="sm">
        <InstallWalkBody route={route} onDone={() => setPhase("gone")} onNotNow={() => { dismissInstall(); setPhase("gone"); }} />
      </Modal>
    );
  }
  return null;
}
