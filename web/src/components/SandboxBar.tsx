// "You have 41 minutes left" — and the one button that stops that being true.
//
// A sandbox is deliberately temporary, which only works if the visitor knows
// it. Told once on the way in and never again, the ending is a surprise and
// the work is gone; told constantly, it nags. So: quiet until the last
// stretch, then present, and always one tap from keeping the thing.
//
// Nothing here asks the server on a timer. The expiry was handed over when the
// link was redeemed and stashed in localStorage, so this is arithmetic.
//
// Portaled to <body>, per the house rule: the header's backdrop-blur creates a
// containing block that traps a position:fixed child, so a bar rendered inside
// the layout tree would be clipped or mispositioned rather than pinned to the
// viewport.
//
// Because it IS fixed, it sat OVER the page rather than in it, so the last rows
// of every list were underneath it. Worst on a phone, where the bar wraps to
// two lines and what it covers is whatever you just scrolled down to reach. So
// the bar now measures itself and pays for its own space.
import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { sandboxExpiry, clearSandboxExpiry } from "../lib/sandbox-session";
import { SandboxSaveModal } from "./SandboxSaveModal";

/** Below this, the bar is always visible. Above it, only the small chip is. */
const URGENT_MS = 15 * 60_000;

function human(msLeft: number): string {
  const mins = Math.max(0, Math.round(msLeft / 60_000));
  if (mins <= 1) return "less than a minute";
  if (mins < 60) return `${mins} minutes`;
  return "an hour";
}

/** Reserve exactly the bar's own height at the foot of the page. Measured
 *  rather than guessed: it is one line on a desktop and two or three on a
 *  phone, and any constant would be wrong on most of them. */
function useReserveSpace(el: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (!el) return;
    const apply = () => {
      document.body.style.paddingBottom = `${el.getBoundingClientRect().height}px`;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.body.style.paddingBottom = "";
    };
  }, [el]);
}

export function SandboxBar() {
  const [expiry] = useState<number | null>(sandboxExpiry);
  const [now, setNow] = useState(() => Date.now());
  const [saving, setSaving] = useState(false);
  const [kept, setKept] = useState(false);
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  // The two doors out, for the ended state. Public endpoint: it describes the
  // deployment, not the (by then dead) session.
  const [paths, setPaths] = useState<{ cloud_url: string | null; selfhost_url: string | null } | null>(null);
  useReserveSpace(bar);

  useEffect(() => {
    if (expiry == null) return;
    // Once a minute is enough for a minute-resolution countdown, and it keeps
    // this off the render path of everything else.
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [expiry]);

  const over = expiry != null && !kept && expiry - now <= 0;
  useEffect(() => {
    if (!over) return;
    void api.sandboxPaths().then(setPaths).catch(() => setPaths(null));
  }, [over]);

  if (expiry == null || kept) return null;
  const left = expiry - now;

  // What to say once it is actually over.
  //
  // This used to be "This sandbox has ended. Start another", which is the wrong
  // offer at the only moment it gets made: somebody has just spent an hour
  // building something and the single thing on offer is to do the demo again.
  // The work cannot be rescued here — expiry hard-deletes the workspace and
  // drops its database, so offering recovery would be a lie — but the person is
  // as decided as they will ever be, and the honest next step is the product.
  // So the two real doors lead, and another sandbox follows.
  if (left <= 0) {
    return createPortal(
      <div
        ref={setBar}
        className="fixed bottom-0 inset-x-0 z-40 border-t border-ember-300 dark:border-ember-800 bg-ember-50 dark:bg-ember-950/40 px-4 py-2.5 text-sm flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5"
      >
        <span className="text-ember-700 dark:text-ember-300 font-medium">
          Your hour is up, and this sandbox was deleted.
        </span>
        {paths?.cloud_url && (
          <a
            href={paths.cloud_url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-3 py-1 transition"
          >
            Get your own, hosted
          </a>
        )}
        {paths?.selfhost_url && (
          <a
            href={paths.selfhost_url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-line dark:border-slate-600 px-3 py-1 font-medium hover:bg-subtle transition"
          >
            Run it yourself
          </a>
        )}
        <a href="/api/v1/try" className="text-muted underline">
          or start another sandbox
        </a>
      </div>,
      document.body,
    );
  }

  const urgent = left <= URGENT_MS;

  return createPortal(
    <>
      <div
        ref={setBar}
        className={
          "fixed bottom-0 inset-x-0 z-40 border-t px-4 py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-2 justify-center " +
          (urgent
            ? "bg-ember-50 dark:bg-ember-950/40 border-ember-300 dark:border-ember-800"
            : "bg-surface dark:bg-slate-900 border-line dark:border-slate-700")
        }
      >
        <span className={urgent ? "text-ember-700 dark:text-ember-300 font-medium" : "text-muted"}>
          {urgent ? "Nearly done: " : "This is a sandbox. "}
          {human(left)} left.
        </span>
        {/* One door, not two. These used to open different things and each hid
            the other, so whichever you pressed first was the only one you knew
            about. They are two answers to one question, so they share a modal. */}
        <button
          type="button"
          onClick={() => setSaving(true)}
          className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-3 py-1 transition"
        >
          Keep this workspace
        </button>
        <button
          type="button"
          onClick={() => setSaving(true)}
          className="rounded-md border border-line dark:border-slate-600 px-3 py-1 font-medium hover:bg-subtle transition"
        >
          Take your work
        </button>
      </div>
      <SandboxSaveModal
        open={saving}
        onClose={() => setSaving(false)}
        onKept={() => {
          clearSandboxExpiry();
          setKept(true);
        }}
      />
    </>,
    document.body,
  );
}
