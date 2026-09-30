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
// The page is ONE decision (the owner's review, 2026-09-27): one primary card,
// "Keep what you made", whose button is the only filled one; a secondary card
// to keep playing on the demo box; everything else in one row of text links.
// It used to be three cards and two trailing links, two of the cards made an
// account, two unrelated actions shared one card with wrapping buttons, a
// greyed button looked dead until the email was valid, and every card carried
// an uppercase eyebrow repeating its own button. It fits one phone screen.
//
// The person stays signed in on this page (the keep route needs the session
// and the frozen workspace answers 410 to everything else); only "start
// another sandbox" signs out first.
import { useEffect, useState, type ReactElement } from "react";
import { trialLengthMorePhrase, trialLengthPhrase } from "@cobblr/platform-contract/trial-length";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { sandboxKeptAtTheEnd, type EndingKind } from "../lib/sandbox-session";
import { AddedLine } from "../components/BuiltHere";
import { KeepExamples } from "../components/KeepExamples";
import { lifetimeSentence, type SandboxLifetime } from "@cobblr/platform-contract/sandbox-lifetime";
import { carryUrl, makeItYours } from "../lib/make-it-yours";
import { endedCopy, holdPhrase } from "../lib/workspace-state-copy";
import type { SandboxLedger } from "../lib/api";

const PRIMARY = "w-full rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-4 py-2.5 transition";
const SECONDARY = "w-full rounded-md border border-line dark:border-slate-700 font-medium px-4 py-2.5 hover:bg-subtle transition";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EndingPaths {
  cloud_url: string | null;
  selfhost_url: string | null;
  decision_hours: number;
  carry_available: boolean;
  /** How long keeping makes it a trial: the server's setting. Absent from a
   *  server that predates it, which then answers with its own length. */
  trial_days?: number;
}

export { holdPhrase };

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
  // One address for the page: typed once, used by whichever of the two things
  // that need it the person picks (keep playing, or the file).
  const [email, setEmail] = useState("");
  // What is true of the sandbox's work right now, in the sentence the take
  // email also carries (#4217: the page said "saved for 24 hours" while the
  // email said "already gone").
  const [lifetime, setLifetime] = useState<SandboxLifetime | null>(null);
  useEffect(() => {
    if (preview || kind !== "sandbox") return;
    void api.sandboxLifetime().then(setLifetime).catch(() => setLifetime(null));
  }, [preview, kind]);

  useEffect(() => {
    if (preview) return;
    // A deployment with neither door configured, or one that cannot be asked,
    // still has the front door.
    void api
      .sandboxPaths()
      .then((p) => setPaths({ cloud_url: p.cloud_url, selfhost_url: p.selfhost_url, decision_hours: p.decision_hours ?? 0, carry_available: p.carry_available === true, trial_days: p.trial_days }))
      .catch(() => setPaths({ cloud_url: null, selfhost_url: null, decision_hours: 0, carry_available: false }));
  }, [preview]);

  const another = () => {
    // The guest account goes with the sandbox; a new one is handed out fresh.
    logout();
    window.location.assign("/api/v1/try");
  };

  const held = kind === "sandbox" && (paths?.decision_hours ?? 0) > 0;
  const carry = held && !!paths?.carry_available;
  const copy = endedCopy(kind === "trial" ? { kind: "trial" } : { kind: "sandbox", holdHours: held ? paths!.decision_hours : 0 });

  return (
    <div className="min-h-screen grid place-items-center bg-canvas text-content px-4 py-8" data-testid="sandbox-ended" data-ending={kind}>
      <div className="max-w-md w-full">
        <h1 className="text-2xl font-bold text-slate-700 dark:text-mortar-100">{copy.heading}</h1>
        <p className="mt-1.5 text-muted" data-testid="ending-lifetime">{lifetime ? lifetimeSentence(lifetime) : copy.body}</p>

        {/* What they made, in one line. The cards below decide what happens to it. */}
        <AddedLine preview={preview ? (ledgerPreview ?? null) : undefined} />

        <div className="mt-5 space-y-3">
          {carry && <MakeYoursCard />}
          {held && <KeepPlayingCard trialDays={paths?.trial_days} email={email} setEmail={setEmail} primary={!carry} />}
          {!held && <FreshCard paths={paths} />}
        </div>

        <MoreLinks paths={paths} held={held} fresh={held} email={email} setEmail={setEmail} onAnother={another} />
        {held && !carry && <CarryNote />}
      </div>
    </div>
  );
}

/** The one way to keep what you made, where the carry is on: an account on
 *  Cobblr, made on the other side, and everything moves into it. */
function MakeYoursCard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await makeItYours();
    } catch {
      setError("We could not start that. Please try again.");
      setBusy(false);
    }
  }
  return (
    <section className="rounded-xl border-2 border-cobble-400 dark:border-cobble-600 bg-surface dark:bg-slate-900 p-4" data-testid="door-carry">
      <h2 className="font-display text-xl font-bold text-content dark:text-mortar-100">Move it to your own account</h2>
      <p className="mt-1 text-sm text-muted">Create a Cobblr account and everything you made moves in, photos too.</p>
      <button type="button" onClick={() => void go()} disabled={busy} className={"mt-3 " + PRIMARY}>
        {busy ? "One moment…" : "Create my account"}
      </button>
      {error && <p className="mt-2 text-sm text-ember-600 dark:text-ember-400">{error}</p>}
    </section>
  );
}

/** Keep playing on this demo box, for the length it sets: an email, then the
 *  workspace opens again as a trial. The button always looks like a button; an
 *  address that is not one is said on the tap, not by greying it out. */
function KeepPlayingCard({
  trialDays,
  email,
  setEmail,
  primary,
}: {
  trialDays?: number;
  email: string;
  setEmail: (v: string) => void;
  /** The only way to keep it on this box (no carry): its button is the filled one. */
  primary: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kept, setKept] = useState<{ email: string; emailed: boolean; days: number; joining?: boolean } | null>(null);
  const length = trialDays ? trialLengthPhrase(trialDays) : null;
  const more = trialDays ? trialLengthMorePhrase(trialDays) : null;

  async function keep() {
    if (busy) return;
    const to = email.trim();
    if (!EMAIL.test(to)) {
      setError("Enter your email address first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.keepSandbox(to);
      if (r.kind === "join_pending") {
        // The address keeps a trial here already: this sandbox joins it once
        // the address says yes. Nothing reopens until then. Unsent, the form
        // stays so asking again is one tap.
        if (!r.emailed) {
          setError("That address already keeps a trial here, and we could not send it the link. Try again in a minute.");
          return;
        }
        setKept({ email: to, emailed: true, days: r.days, joining: true });
        return;
      }
      setKept({ email: to, emailed: r.emailed, days: r.days });
      // The latch opens and the shell can draw the workspace again; a full
      // load, so nothing cached from the frozen hour is painted.
      sandboxKeptAtTheEnd();
      // TIMER-OUTLIVES-COMPONENT: the latch above lets the shell redraw, which can unmount this page, and the full load must still happen.
      window.setTimeout(() => window.location.assign("/"), 1500);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? err.message
          : err instanceof ApiError && err.status === 410
            ? "The hold has run out, and this sandbox is gone. You can start another one below."
            : "We could not keep it. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  // Beside moving it to an account, this is more time; where an account
  // cannot take the work yet, it is the way to keep it.
  const title = primary ? "Keep your sandbox" : "Want more time first?";
  const line = `Keep using this sandbox${more ? ` for ${more}` : ""}. We'll email you the link to get back in.`;
  return (
    <section
      className={"rounded-xl bg-surface dark:bg-slate-900 p-4 " + (primary ? "border-2 border-cobble-400 dark:border-cobble-600" : "border border-line dark:border-slate-700")}
      data-testid="door-keep"
    >
      <h2 className={primary ? "font-display text-xl font-bold text-content dark:text-mortar-100" : "text-base font-semibold text-content dark:text-mortar-100"}>{title}</h2>
      {!kept && <p className="mt-1 text-sm text-muted">{line}</p>}
      {kept ? (
        kept.joining ? (
          <p className="mt-1.5 text-sm text-muted" data-testid="kept-joining">
            {kept.email} already keeps a trial here.{" "}
            {`We sent it a link: open it to add this sandbox beside that one, for ${trialLengthPhrase(kept.days)} of its own. This sandbox waits until then.`}
          </p>
        ) : (
        <p className="mt-1.5 text-sm text-muted" data-testid="kept-at-the-end">
          Saved for {trialLengthPhrase(kept.days)}.{" "}
          {kept.emailed ? `We sent a sign-in link to ${kept.email}.` : "We could not send your sign-in link, but this page's address still works."}{" "}
          Opening your workspace…
        </p>
        )
      ) : (
        <form
          noValidate
          className="mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void keep();
          }}
        >
          <input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            placeholder="you@example.com"
            aria-label="Your email"
            autoComplete="email"
            className="input w-full"
          />
          <button type="submit" disabled={busy} className={primary ? PRIMARY : SECONDARY}>
            {busy ? "Saving…" : length ? `Give me ${length}` : "Email me a link"}
          </button>
          {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
        </form>
      )}
    </section>
  );
}

/** Where nothing is held (a trial's end, or a box with no hold): a new account. */
function FreshCard({ paths }: { paths: EndingPaths | null }) {
  const href = paths?.cloud_url ?? "/?mode=signup";
  return (
    <section className="rounded-xl border-2 border-cobble-400 dark:border-cobble-600 bg-surface dark:bg-slate-900 p-4" data-testid="door-fresh">
      <h2 className="font-display text-xl font-bold text-content dark:text-mortar-100">Start for real</h2>
      <p className="mt-1 text-sm text-muted">A new account on Cobblr that is yours to keep.</p>
      <a href={href} className={"mt-3 block text-center " + PRIMARY}>
        Make an account
      </a>
    </section>
  );
}

/** Everything else, as one quiet row: the file, an empty account, another
 *  sandbox, running it yourself. */
function MoreLinks({
  paths,
  held,
  fresh,
  email,
  setEmail,
  onAnother,
}: {
  paths: EndingPaths | null;
  held: boolean;
  /** Offer "Start from scratch" here (the fresh card is not drawn). */
  fresh: boolean;
  email: string;
  setEmail: (v: string) => void;
  onAnother: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const link = "underline hover:text-content";
  const items: ReactElement[] = [];
  if (held) {
    items.push(
      <button key="take" type="button" className={link} onClick={() => setAsking((v) => !v)}>
        Download what I made
      </button>,
    );
  }
  if (fresh) {
    items.push(
      <a key="fresh" href={paths?.cloud_url ?? "/?mode=signup"} className={link}>
        Start with an empty account
      </a>,
    );
  }
  items.push(
    <button key="another" type="button" className={link} onClick={onAnother}>
      Try a new sandbox
    </button>,
  );
  if (paths?.selfhost_url) {
    items.push(
      <a key="self" href={paths.selfhost_url} target="_blank" rel="noreferrer" className={link}>
        Self-host Cobblr
      </a>,
    );
  }
  return (
    <>
      {/* One link per line: a row of four wrapped two to a line on a phone. */}
      <ul className="mt-5 text-sm text-muted text-center space-y-2" data-testid="more-links">
        {items.map((el, i) => (
          <li key={`item-${i}`}>{el}</li>
        ))}
      </ul>
      {asking && <TakeYourWork email={email} setEmail={setEmail} />}
    </>
  );
}

/** The file of everything they made, emailed (the take route needs the
 *  address to send it to). */
function TakeYourWork({ email, setEmail }: { email: string; setEmail: (v: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<{ emailed: boolean; link: string; days: number } | null>(null);
  const [examples, setExamples] = useState(false);
  async function take() {
    if (busy) return;
    const to = email.trim();
    if (!EMAIL.test(to)) {
      setError("Enter your email address first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.takeSandboxWork(to, examples);
      setTaken({ emailed: r.emailed, link: r.link, days: r.days });
    } catch {
      setError("We could not build your file. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      noValidate
      className="mt-3 space-y-2"
      data-testid="take-your-work"
      onSubmit={(e) => {
        e.preventDefault();
        void take();
      }}
    >
      {taken ? (
        <p className="text-sm text-muted" data-testid="taken-at-the-end">
          {taken.emailed ? (
            `We sent a link to your file. It works for ${taken.days} days.`
          ) : (
            <>
              We could not send the email, so here is{" "}
              <a href={taken.link} className="underline hover:text-content">
                the link to your file
              </a>
              . It works for {taken.days} days.
            </>
          )}
        </p>
      ) : (
        <>
          <input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            placeholder="Where should we send the file?"
            aria-label="Email for your file"
            autoComplete="email"
            className="input w-full"
          />
          <KeepExamples checked={examples} onChange={setExamples} />
          <button type="submit" disabled={busy} className={SECONDARY}>
            {busy ? "Packing it up…" : "Email me the file"}
          </button>
          {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
        </>
      )}
    </form>
  );
}

export { carryUrl };

/** Where the carry is off: one honest line, never a promise on a path that
 *  does not exist. */
function CarryNote() {
  return (
    <p className="mt-3 text-xs text-faint text-center" data-testid="carry-note">
      Bringing what you added into a Cobblr account is coming soon.
    </p>
  );
}
