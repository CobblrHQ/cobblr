// The end of a no-account sandbox, and of the trial it can become.
// Replaces the whole workspace shell.
//
// This used to be a strip at the foot of the page under a dashboard that kept
// painting (2026-09-14); a frozen workspace is not a place with a bar on it,
// and the page says so with nothing else on it.
//
// What it says is the product (#3254, the owner's design, three doors):
//
//   1. Keep this trial so I can keep playing: it stays on this demo box for a
//      length the person picks from a bounded set (a week, two weeks, a
//      month) and then ends, the same way. Never "forever": the demo box is
//      not for running things for real.
//   2. Start for real, from scratch: a blank account on the hosted product.
//   3. Bring what I built to a real account: the ledger replay. Shown as a
//      door only where the server says it can be kept (carry_available);
//      until then it is one honest line under door 2, never a promise on a
//      path that does not exist.
//
// Door 1 needs something to keep, so a sandbox past its hour is FROZEN for a
// decision window (the server's decision_hours, approved at 24 by the owner
// on 2026-09-20) rather than deleted at once. The page says exactly that: what
// is held, for how long, and that doing nothing deletes it. The window is a
// parameter; at 0 the page reads as it did before, with no door 1.
//
// The person stays signed in on this page (the keep route needs the session
// and the frozen workspace answers 410 to everything else); only "start
// another sandbox" signs out first.
import { useEffect, useState } from "react";
import { DEFAULT_TRIAL_LENGTH, type TrialLengthDays } from "@cobblr/platform-contract/trial-length";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { sandboxKeptAtTheEnd, type EndingKind } from "../lib/sandbox-session";
import { TrialLengthPicker, trialLengthPhrase } from "../components/TrialLengthPicker";
import { BuiltHere } from "../components/BuiltHere";
import type { SandboxLedger } from "../lib/api";

const PRIMARY = "rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white font-medium px-4 py-2 transition";
const SECONDARY = "rounded-md border border-line dark:border-slate-700 px-4 py-2 font-medium hover:bg-subtle transition";

export interface EndingPaths {
  cloud_url: string | null;
  selfhost_url: string | null;
  decision_hours: number;
  carry_available: boolean;
}

/** "24 hours", "one hour", "3 days": the hold, said plainly. */
export function holdPhrase(hours: number): string {
  if (hours % 24 === 0 && hours >= 48) return `${hours / 24} days`;
  if (hours === 24) return "24 hours";
  if (hours === 1) return "one hour";
  return `${hours} hours`;
}

export function SandboxEnded({
  kind = "sandbox",
  preview,
  ledgerPreview,
}: {
  kind?: EndingKind;
  preview?: EndingPaths;
  /** The preview route's ledger; `null` shows the page as a box that cannot answer. */
  ledgerPreview?: SandboxLedger | null;
}) {
  const { logout } = useAuth();
  const [paths, setPaths] = useState<EndingPaths | null>(preview ?? null);

  useEffect(() => {
    if (preview) return;
    // A deployment with neither door configured, or one that cannot be asked,
    // still has the front door.
    void api
      .sandboxPaths()
      .then((p) => setPaths({ cloud_url: p.cloud_url, selfhost_url: p.selfhost_url, decision_hours: p.decision_hours ?? 0, carry_available: p.carry_available === true }))
      .catch(() => setPaths({ cloud_url: null, selfhost_url: null, decision_hours: 0, carry_available: false }));
  }, [preview]);

  const another = () => {
    // The guest account goes with the sandbox; a new one is handed out fresh.
    logout();
    window.location.assign("/api/v1/try");
  };

  const held = kind === "sandbox" && (paths?.decision_hours ?? 0) > 0;

  return (
    <div className="min-h-screen grid place-items-center bg-canvas text-content px-6 py-10" data-testid="sandbox-ended" data-ending={kind}>
      <div className="max-w-lg w-full">
        <p className="font-mono text-xs uppercase tracking-widest text-faint">{kind === "trial" ? "trial" : "sandbox"}</p>
        {kind === "trial" ? (
          <>
            <h1 className="mt-2 text-2xl font-bold text-slate-700 dark:text-mortar-100">Your trial has ended.</h1>
            <p className="mt-2 text-muted">
              You kept this workspace for the time you chose, and that time is up. This was a trial on our demo box, not
              a place to run things for real, so it stops here and is deleted soon. Cobblr itself keeps everything, for
              as long as you like.
            </p>
          </>
        ) : held ? (
          <>
            <h1 className="mt-2 text-2xl font-bold text-slate-700 dark:text-mortar-100">Your hour is up.</h1>
            <p className="mt-2 text-muted">
              This sandbox is frozen: nothing more can be added to it. What you made is held for{" "}
              <strong className="text-content dark:text-mortar-100">{holdPhrase(paths!.decision_hours)}</strong> so you can
              decide what happens to it. Do nothing and it is deleted after that, and nothing you did stays on our server.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-2 text-2xl font-bold text-slate-700 dark:text-mortar-100">Your hour is up.</h1>
            <p className="mt-2 text-muted">
              Sandboxes only last an hour, on purpose: nothing you did is still sitting on our server. Cobblr itself
              keeps everything, for as long as you like.
            </p>
          </>
        )}

        {/* What they built, read back: for both endings, whether or not the
            carry door is lit. The doors below decide what happens to it. */}
        <BuiltHere preview={preview ? (ledgerPreview ?? null) : undefined} />

        <div className="mt-6 space-y-3">
          {held && <KeepDoor />}
          <FreshDoor paths={paths} />
          {paths?.carry_available && kind === "sandbox" && held ? <CarryDoor /> : <CarryNote />}
          {paths?.selfhost_url && (
            <p className="text-sm text-muted">
              Or{" "}
              <a href={paths.selfhost_url} target="_blank" rel="noreferrer" className="underline hover:text-content">
                run it yourself
              </a>
              .
            </p>
          )}
        </div>

        <p className="mt-8 text-sm">
          <button type="button" onClick={another} className="text-muted underline hover:text-content">
            or start another sandbox
          </button>
        </p>
      </div>
    </div>
  );
}

/** Door 1: an email and a length, then the workspace opens again as a trial. */
function KeepDoor() {
  const [email, setEmail] = useState("");
  const [length, setLength] = useState<TrialLengthDays>(DEFAULT_TRIAL_LENGTH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kept, setKept] = useState<{ email: string; emailed: boolean } | null>(null);

  async function keep() {
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const to = email.trim();
      const r = await api.keepSandbox(to, length);
      setKept({ email: to, emailed: r.emailed });
      // The latch opens and the shell can draw the workspace again; a full
      // load, so nothing cached from the frozen hour is painted.
      sandboxKeptAtTheEnd();
      // TIMER-OUTLIVES-COMPONENT: the latch above lets the shell redraw, which can unmount this page, and the full load must still happen.
      window.setTimeout(() => window.location.assign("/"), 1500);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "That email already has an account. Sign in with it instead."
          : err instanceof ApiError && err.status === 410
            ? "The hold has run out; this sandbox is gone. Start another one below."
            : "Could not keep it. Try again?",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border-2 border-cobble-400 dark:border-cobble-600 bg-surface dark:bg-slate-900 p-4" data-testid="door-keep">
      <h2 className="text-[11px] font-mono uppercase tracking-widest text-accent">Keep this trial so I can keep playing</h2>
      {kept ? (
        <p className="mt-1.5 text-sm text-muted" data-testid="kept-at-the-end">
          Saved for {trialLengthPhrase(length)}.{" "}
          {kept.emailed ? `A sign-in link went to ${kept.email}.` : "We could not send your sign-in link; this page's address still works."}{" "}
          Opening your workspace…
        </p>
      ) : (
        <form
          className="mt-1.5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void keep();
          }}
        >
          <p className="text-sm text-muted">
            It stays here, exactly as it is, for a length you choose. When that time is up it ends the same way, since
            this is a demo box and not a place to run things for real.
          </p>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            aria-label="Your email"
            className="input w-full"
          />
          <TrialLengthPicker value={length} onChange={setLength} disabled={busy} />
          <button type="submit" disabled={busy || !email.trim()} className={PRIMARY}>
            {busy ? "Saving…" : `Keep it for ${trialLengthPhrase(length)}`}
          </button>
          {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
        </form>
      )}
    </section>
  );
}

/** Door 2: a blank account on the hosted product. */
function FreshDoor({ paths }: { paths: EndingPaths | null }) {
  const href = paths?.cloud_url ?? "/?mode=signup";
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4" data-testid="door-fresh">
      <h2 className="text-[11px] font-mono uppercase tracking-widest text-accent">I'm ready to go for real, from scratch</h2>
      <p className="mt-1.5 text-sm text-muted">A blank account on Cobblr, with nothing carried over. Kept for as long as you like.</p>
      <a href={href} className={"mt-3 inline-block " + SECONDARY}>
        Make an account
      </a>
    </section>
  );
}

/** Door 3, where the replay exists: keep it for the full month so there is
 *  something to read, get the person's own grant to read it, and leave for the
 *  real account's /carry page, which signs them up and brings it in. */
export function carryUrl(cloudUrl: string | null, here: string, grant: { token: string; source: string }): string {
  const url = new URL("/carry", new URL(cloudUrl || "/", here));
  url.searchParams.set("token", grant.token);
  url.searchParams.set("from", grant.source);
  return url.toString();
}

function CarryDoor() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.keepSandbox(email.trim(), 30);
      sandboxKeptAtTheEnd();
      const [p, grant] = await Promise.all([api.sandboxPaths(), api.startCarry()]);
      window.location.assign(carryUrl(p.cloud_url, window.location.origin, grant));
    } catch {
      setError("Could not keep it to bring along. Try again?");
      setBusy(false);
    }
  }
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4" data-testid="door-carry">
      <h2 className="text-[11px] font-mono uppercase tracking-widest text-accent">Bring what I built to a real account</h2>
      <p className="mt-1.5 text-sm text-muted">What you built here, as listed above, comes with you into a new account on Cobblr.</p>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Your email" className="input flex-1 min-w-[12rem]" />
        <button type="submit" disabled={busy || !email.trim()} className={SECONDARY}>
          {busy ? "One moment…" : "Bring it along"}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-ember-600 dark:text-ember-400">{error}</p>}
    </section>
  );
}

/** The third door while the replay does not exist: one honest line. */
function CarryNote() {
  return (
    <p className="text-sm text-muted" data-testid="carry-note">
      Bringing what you built here into a real account is coming. For now a real account starts fresh.
    </p>
  );
}
