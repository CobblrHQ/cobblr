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
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "../lib/api";
import { useToast } from "@cobblr/platform-web";
import { sandboxExpiry, clearSandboxExpiry } from "../lib/sandbox-session";
import { TakeYourWorkModal } from "./TakeYourWorkModal";

/** Below this, the bar is always visible. Above it, only the small chip is. */
const URGENT_MS = 15 * 60_000;

function human(msLeft: number): string {
  const mins = Math.max(0, Math.round(msLeft / 60_000));
  if (mins <= 1) return "less than a minute";
  if (mins < 60) return `${mins} minutes`;
  return "an hour";
}

export function SandboxBar() {
  const [expiry] = useState<number | null>(sandboxExpiry);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [kept, setKept] = useState(false);
  const [taking, setTaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (expiry == null) return;
    // Once a minute is enough for a minute-resolution countdown, and it keeps
    // this off the render path of everything else.
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [expiry]);

  if (expiry == null || kept) return null;
  const left = expiry - now;
  if (left <= 0) {
    // Expired while they were looking at it. The next request will 401 anyway;
    // saying so first is kinder than a silent failure.
    return createPortal(
      <div className="fixed bottom-0 inset-x-0 z-40 bg-ember-600 text-white text-sm px-4 py-2 text-center">
        This sandbox has ended.{" "}
        <a href="/api/v1/try" className="underline font-medium">
          Start another
        </a>
      </div>,
      document.body,
    );
  }

  const urgent = left <= URGENT_MS;

  async function keep(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      const res = await api.keepSandbox(email.trim());
      setKept(true);
      clearSandboxExpiry();
      // Only promise an inbox when something was actually sent to it. If the
      // link could not go out, the sandbox link is still alive on purpose, so
      // the honest instruction is to keep the page.
      toast.success(
        res.emailed
          ? "Saved. This workspace is yours now - check your email for the link back in."
          : "Saved, but we could not send your sign-in link. Keep this tab open and this page's address: it still works.",
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 409
          ? "That email already has an account. Sign in with it instead."
          : "Could not save that. Try again?",
      );
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
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
      {/* The smaller door, and for most people the likelier one: an address to
          send one file to, rather than committing to an account. Always offered
          beside Keep, not hidden behind it. */}
      <button
        type="button"
        onClick={() => setTaking(true)}
        className="rounded-md border border-line dark:border-slate-600 px-3 py-1 font-medium hover:bg-subtle transition"
      >
        Take your work
      </button>
      <TakeYourWorkModal open={taking} onClose={() => setTaking(false)} />
      {open ? (
        <form onSubmit={keep} className="flex items-center gap-2">
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="input !py-1 !w-56"
            aria-label="Your email"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white font-medium px-3 py-1 transition"
          >
            {busy ? "Saving…" : "Keep it"}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-3 py-1 transition"
        >
          Keep this workspace
        </button>
      )}
    </div>,
    document.body,
  );
}
