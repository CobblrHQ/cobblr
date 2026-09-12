// The strip at the foot of the page that says what kind of workspace this is.
//
// Three states, one component:
//   sandbox  "You have 41 minutes left" and the one button that stops that
//            being true. Quiet until the last stretch, then present.
//   trial    "Yours until 12 Oct." For a workspace kept from a sandbox, whose
//            owner has no real door yet, it also carries the two: send the
//            sign-in link again, or choose a password right here.
//   ended    the sandbox's hour is up and it was deleted; the two real doors
//            lead, and another sandbox follows.
//
// This was SandboxBar, and it rendered nothing once the workspace was kept:
// the localStorage key it counted down from was cleared and nothing replaced
// it, so the person who had just given their email was left in a workspace
// still called Sandbox, as a user still called Guest, with no line anywhere
// saying what had happened or for how long. And an ordinary account trial
// never had a line at all. The kind now comes from the server
// (GET /orgs/:slug/trial); the localStorage hint the landing page writes is
// kept only so a sandbox paints on the first frame, and so a sandbox that has
// already been deleted can still show its ending.
//
// Portaled to <body>, per the house rule: the header's backdrop-blur creates a
// containing block that traps a position:fixed child, so a bar rendered inside
// the layout tree would be clipped or mispositioned rather than pinned to the
// viewport. Because it IS fixed it would sit OVER the last rows of every list,
// so it measures itself and pays for its own space.
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { sandboxExpiry, clearSandboxExpiry } from "../lib/sandbox-session";
import { SandboxSaveModal } from "./SandboxSaveModal";

/** Below this, the sandbox bar is always visible. Above it, only the small chip is. */
const URGENT_MS = 15 * 60_000;

export interface WorkspaceState {
  kind: "sandbox" | "trial";
  /** When it ends. Null only for a trial with no end (never, in practice). */
  expiresAt: number | null;
  /** The address the sign-in link went to; null for a sandbox. */
  email: string | null;
  /** True while the anonymous link is the only real door: offer the two. */
  linkOpen: boolean;
  /** False only when keep just reported that the sign-in link did not go;
   *  unknown after a reload, which reads as sent. */
  emailed?: boolean;
}

function human(msLeft: number): string {
  const mins = Math.max(0, Math.round(msLeft / 60_000));
  if (mins <= 1) return "less than a minute";
  if (mins < 60) return `${mins} minutes`;
  return "an hour";
}

/** "12 Oct", in the viewer's locale. The year only when it is not this one. */
export function untilDate(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
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

const BAR = "fixed bottom-0 inset-x-0 z-40 border-t px-4 py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-2 justify-center ";
const QUIET = "bg-surface dark:bg-slate-900 border-line dark:border-slate-700";
const LOUD = "bg-ember-50 dark:bg-ember-950/40 border-ember-300 dark:border-ember-800";
const PRIMARY = "rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-3 py-1 transition";
const SECONDARY = "rounded-md border border-line dark:border-slate-600 px-3 py-1 font-medium hover:bg-subtle transition";

export function WorkspaceStateBar({ slug }: { slug: string }) {
  // The localStorage hint paints a sandbox on the first frame; the server
  // answer replaces it. A workspace that is neither reads null and draws nothing.
  const [state, setState] = useState<WorkspaceState | null>(() => {
    const e = sandboxExpiry();
    return e == null ? null : { kind: "sandbox", expiresAt: e, email: null, linkOpen: false };
  });
  const [now, setNow] = useState(() => Date.now());
  const [modal, setModal] = useState<null | "save" | "password">(null);
  const [resend, setResend] = useState<null | "sending" | "sent" | "failed">(null);
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  // The two doors out, for the ended state. Public endpoint: it describes the
  // deployment, not the (by then dead) session.
  const [paths, setPaths] = useState<{ cloud_url: string | null; selfhost_url: string | null } | null>(null);
  const { refreshMe } = useAuth();
  useReserveSpace(bar);

  const load = useCallback(async () => {
    if (!slug) return;
    try {
      const t = await api.workspaceTrial(slug);
      setState(
        t.kind === "none"
          ? null
          : {
              kind: t.kind,
              expiresAt: t.expires_at ? Date.parse(t.expires_at) : null,
              email: t.email,
              linkOpen: t.link_open,
            },
      );
    } catch {
      // A deleted sandbox answers 404 here; the hint it left behind still says
      // when it ended, which is the one thing worth showing.
    }
  }, [slug]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state?.kind !== "sandbox") return;
    // Once a minute is enough for a minute-resolution countdown, and it keeps
    // this off the render path of everything else.
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [state?.kind]);

  const over = state?.kind === "sandbox" && state.expiresAt != null && state.expiresAt - now <= 0;
  useEffect(() => {
    if (!over) return;
    void api.sandboxPaths().then(setPaths).catch(() => setPaths(null));
  }, [over]);

  if (state == null) return null;

  // ── trial ────────────────────────────────────────────────────────────────
  // One modal element, rendered at the same place in the tree whichever
  // state the strip is in. It used to live inside each branch, so the moment
  // keep succeeded the strip switched branches, the modal that had just said
  // "Saved" unmounted with it, and the person saw the dialog close on them.
  const modalEl = (
    <SandboxSaveModal
      open={modal !== null}
      initial={modal === "password" ? "password" : "save"}
      email={state.email}
      onClose={() => setModal(null)}
      onKept={(kept) => {
        // The hint was the sandbox's; the workspace is not one any more. The
        // shell re-reads the user and the workspace so "Guest" and "Sandbox"
        // go from the header at the same moment as from this strip.
        clearSandboxExpiry();
        setState({
          kind: "trial",
          expiresAt: Date.parse(kept.expires_at),
          email: kept.email,
          linkOpen: true,
          emailed: kept.emailed,
        });
        void refreshMe().catch(() => undefined);
      }}
      onPasswordSet={() => setState((s) => (s ? { ...s, linkOpen: false } : s))}
    />
  );

  if (state.kind === "trial") {
    const ended = state.expiresAt != null && state.expiresAt <= now;
    const until = state.expiresAt == null ? null : untilDate(state.expiresAt, now);
    return createPortal(
      <>
        <div ref={setBar} className={BAR + QUIET} data-testid="workspace-state">
          <span className="text-muted">
            {ended ? `Your trial ended ${until}.` : until ? `Yours until ${until}.` : "Yours."}
            {!ended && state.linkOpen && state.email && (
              <>
                {" "}
                {state.emailed === false ? "We could not send your sign-in link to " : "Sign-in link sent to "}
                <span className="font-medium text-content dark:text-mortar-100">{state.email}</span>.
              </>
            )}
          </span>
          {!ended && state.linkOpen && (
            <>
              <button
                type="button"
                disabled={resend === "sending"}
                onClick={() => {
                  setResend("sending");
                  void api
                    .resendSandboxLink()
                    .then((r) => setResend(r.emailed ? "sent" : "failed"))
                    .catch(() => setResend("failed"));
                }}
                className={SECONDARY}
              >
                {resend === "sent" ? "Sent again" : resend === "failed" ? "Could not send" : resend === "sending" ? "Sending…" : "Resend"}
              </button>
              <button type="button" onClick={() => setModal("password")} className={PRIMARY}>
                Set a password
              </button>
            </>
          )}
        </div>
        {modalEl}
      </>,
      document.body,
    );
  }

  // ── sandbox, ended ───────────────────────────────────────────────────────
  //
  // This used to be "This sandbox has ended. Start another", which is the wrong
  // offer at the only moment it gets made: somebody has just spent an hour
  // building something and the single thing on offer is to do the demo again.
  // The work cannot be rescued here (expiry hard-deletes the workspace and
  // drops its database, so offering recovery would be a lie) but the person is
  // as decided as they will ever be, and the honest next step is the product.
  if (over) {
    return createPortal(
      <div ref={setBar} className={BAR.replace("py-2 ", "py-2.5 ") + LOUD} data-testid="workspace-state">
        <span className="text-ember-700 dark:text-ember-300 font-medium">
          Your hour is up, and this sandbox was deleted.
        </span>
        {paths?.cloud_url && (
          <a href={paths.cloud_url} target="_blank" rel="noreferrer" className={PRIMARY}>
            Get your own, hosted
          </a>
        )}
        {paths?.selfhost_url && (
          <a href={paths.selfhost_url} target="_blank" rel="noreferrer" className={SECONDARY}>
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

  // ── sandbox, live ────────────────────────────────────────────────────────
  const left = (state.expiresAt ?? now) - now;
  const urgent = left <= URGENT_MS;

  return createPortal(
    <>
      <div ref={setBar} className={BAR + (urgent ? LOUD : QUIET)} data-testid="workspace-state">
        <span className={urgent ? "text-ember-700 dark:text-ember-300 font-medium" : "text-muted"}>
          {urgent ? "Nearly done: " : "This is a sandbox. "}
          {human(left)} left.
        </span>
        {/* One door, not two. These used to open different things and each hid
            the other, so whichever you pressed first was the only one you knew
            about. They are two answers to one question, so they share a modal. */}
        <button type="button" onClick={() => setModal("save")} className={PRIMARY}>
          Keep this workspace
        </button>
        <button type="button" onClick={() => setModal("save")} className={SECONDARY}>
          Take your work
        </button>
      </div>
      {modalEl}
    </>,
    document.body,
  );
}
