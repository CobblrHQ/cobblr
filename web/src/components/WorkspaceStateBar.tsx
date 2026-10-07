// The strip at the foot of the page that says what kind of workspace this is.
//
// Two states, one component:
//   sandbox  "You have 41 minutes left" and the one button that stops that
//            being true. Quiet until the last stretch, then present.
//   trial    "This workspace is yours until 12 Oct." For a workspace kept from a sandbox, whose
//            owner has no real door yet, it also carries the two: send the
//            sign-in link again, or choose a password right here.
//
// A sandbox's END is not a state of this strip. It was, once: "Your hour is
// up, and this sandbox was deleted" under a dashboard that kept painting its
// cache, with the first-run tour opening on top (2026-09-14). The hour's end
// is terminal, so the strip only SAYS it is over (markSandboxEnded), and the
// workspace shell is replaced by SandboxEnded, whole.
//
// This was SandboxBar, and it rendered nothing once the workspace was kept:
// the localStorage key it counted down from was cleared and nothing replaced
// it, so the person who had just given their email was left in a workspace
// still called Sandbox, as a user still called Guest, with no line anywhere
// saying what had happened or for how long. And an ordinary account trial
// never had a line at all. The kind now comes from the server
// (GET /orgs/:slug/trial); the localStorage hint the landing page writes is
// kept only so a sandbox paints on the first frame.
//
// A bottom-anchored FloatingChrome: it joins the bottom dock, which stacks it
// with any other bar at the foot, makes the page pay for the stack once as
// body padding, and publishes the sum (--bottom-chrome-height) for the corner
// pieces above it. It yields while any overlay is open, the way every piece of
// chrome does by default; it once sat over the camera's shutter (#3012).
import { useCallback, useEffect, useState } from "react";
import { FloatingChrome, lazyOverlay } from "@cobblr/platform-web";
import { api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { sandboxExpiry, clearSandboxExpiry, markSandboxEnded } from "../lib/sandbox-session";
const SandboxSaveModal = lazyOverlay(() => import("./SandboxSaveModal").then((m) => ({ default: m.SandboxSaveModal })));
import { sandboxLine, signInLinkLead, trialLine } from "../lib/workspace-state-copy";
import { makeItYours } from "../lib/make-it-yours";

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

/** "12 Oct", in the viewer's locale. The year only when it is not this one. */
export function untilDate(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

// Over the base page, under every overlay. Every colour here is OPAQUE: a
// translucent strip let the page's chips show through the sentence on a phone.
// Its height reaches the page foot through the bottom dock, so it never sits on
// top of the last thing on the page.
const BAR = "z-40 border-t px-4 py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-2 justify-center ";
// A strip with two doors: the sentence on its own full-width line, and the two
// buttons side by side below it, sharing the width (the owner's layout). The
// row of doors is capped so a desktop does not stretch them edge to edge.
const STACK = "z-40 border-t px-4 py-2.5 text-sm flex flex-col items-stretch gap-2 ";
const DOORS = "flex w-full max-w-md self-center gap-2";
const QUIET = "bg-surface dark:bg-slate-900 border-line dark:border-slate-700";
const LOUD = "bg-ember-50 dark:bg-ember-950 border-ember-300 dark:border-ember-800";
const PRIMARY = "rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-3 py-1 transition";
const SECONDARY =
  "rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-1 font-medium hover:bg-subtle transition";
const DOOR = " flex-1 min-w-0 py-2 leading-tight";

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
  const { refreshMe } = useAuth();

  const load = useCallback(async () => {
    if (!slug) return;
    try {
      const t = await api.workspaceTrial(slug);
      // The hint was written for a sandbox; a workspace the server says is
      // not one any more (kept from another tab, say) must not end on it.
      if (t.kind !== "sandbox") clearSandboxExpiry();
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
      // quiet: an expired sandbox answers 410 here, which the api client has already
      // turned into the ending; a deleted one answers 404, and the hint it
      // left behind says when it ended.
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

  // Whether this box carries a sandbox into the hosted product. Asked once,
  // for a sandbox only: the answer is the operator's and does not change.
  const [carry, setCarry] = useState(false);
  const [leaving, setLeaving] = useState<null | "going" | "failed">(null);
  useEffect(() => {
    if (state?.kind !== "sandbox") return;
    let gone = false;
    void api
      .sandboxPaths()
      .then((p) => !gone && setCarry(p.carry_available === true))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [state?.kind]);

  // The strip's own clock reaching zero is the third teller of the end (the
  // hint and the server are the others); the shell above replaces everything,
  // this strip included, so there is no ended branch to draw here.
  const over = state?.kind === "sandbox" && state.expiresAt != null && state.expiresAt - now <= 0;
  // A kept trial's chosen length running out is the other ending (#3254):
  // the door refuses it from that minute, and the clock here says so first.
  const trialOver = state?.kind === "trial" && state.expiresAt != null && state.expiresAt - now <= 0;
  useEffect(() => {
    if (over) markSandboxEnded("sandbox");
    else if (trialOver) markSandboxEnded("trial");
  }, [over, trialOver]);

  if (state == null || over || trialOver) return null;

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
    const until = state.expiresAt == null ? null : untilDate(state.expiresAt, now);
    return (
      <>
        <FloatingChrome
          anchor="bottom"
          className={(state.linkOpen ? STACK : BAR) + QUIET}
          data-testid="workspace-state"
          data-strip={state.linkOpen ? "full" : "chip"}
        >
          <span className={"text-muted" + (state.linkOpen ? " text-center leading-snug" : "")}>
            {trialLine(until)}
            {state.linkOpen && state.email && (
              <>
                {" "}
                {signInLinkLead(state.emailed)}
                <span className="font-medium text-content dark:text-mortar-100">{state.email}</span>.
              </>
            )}
          </span>
          {state.linkOpen && (
            <div className={DOORS}>
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
                className={SECONDARY + DOOR}
              >
                {resend === "sent" ? "Sent again" : resend === "failed" ? "Could not send" : resend === "sending" ? "Sending…" : "Resend"}
              </button>
              <button type="button" onClick={() => setModal("password")} className={PRIMARY + DOOR}>
                Set a password
              </button>
            </div>
          )}
        </FloatingChrome>
        {modalEl}
      </>
    );
  }

  // ── sandbox, live ────────────────────────────────────────────────────────
  //
  // Two shapes, as the file's rule says: quiet until the last stretch, then
  // present. Above URGENT_MS the strip is ONE line (the chip): the time and
  // one small door, since Keep and Take open the same modal anyway. On a phone
  // that is ~48px instead of the three rows the full bar wraps to, which was
  // half the screen's foot for the whole hour (#3012). Under URGENT_MS the
  // full bar, with both doors named.
  //
  // One ROW, not one line: the sentence wraps beside the button rather than
  // being cut. Ellipsised, "This is a sandbox. You have 41 minutes left." lost
  // its time on a 390px phone and most of itself on a 320px one; the number is
  // the one part the strip exists to say.
  const left = (state.expiresAt ?? now) - now;
  const urgent = left <= URGENT_MS;

  // Where the box carries a sandbox into the hosted product, that is the first
  // door for the whole hour, with Keep it beside it: the owner's two-row
  // layout, the sentence on its own line and the doors below.
  if (carry) {
    return (
      <>
        <FloatingChrome anchor="bottom" className={STACK + (urgent ? LOUD : QUIET)} data-testid="workspace-state" data-strip={urgent ? "full" : "chip"}>
          <span className={urgent ? "text-ember-700 dark:text-ember-300 font-medium text-center leading-snug" : "text-muted text-center leading-snug"}>
            {leaving === "failed" ? "We could not start that. Please try again." : sandboxLine(left, urgent)}
          </span>
          <div className={DOORS}>
            <button
              type="button"
              disabled={leaving === "going"}
              onClick={() => {
                setLeaving("going");
                makeItYours().catch(() => setLeaving("failed"));
              }}
              className={PRIMARY + DOOR}
            >
              {leaving === "going" ? "One moment…" : "Make this yours on Cobblr"}
            </button>
            <button type="button" onClick={() => setModal("save")} className={SECONDARY + DOOR}>
              Keep it
            </button>
          </div>
        </FloatingChrome>
        {modalEl}
      </>
    );
  }

  return (
    <>
      <FloatingChrome
        anchor="bottom"
        className={urgent ? STACK + LOUD : BAR + QUIET + " flex-nowrap"}
        data-testid="workspace-state"
        data-strip={urgent ? "full" : "chip"}
      >
        <span className={urgent ? "text-ember-700 dark:text-ember-300 font-medium text-center leading-snug" : "text-muted min-w-0 leading-snug"}>
          {sandboxLine(left, urgent)}
        </span>
        {urgent ? (
          <div className={DOORS}>
            {/* One door, not two. These used to open different things and each
                hid the other, so whichever you pressed first was the only one
                you knew about. They are two answers to one question, so they
                share a modal. */}
            <button type="button" onClick={() => setModal("save")} className={PRIMARY + DOOR}>
              Keep this workspace
            </button>
            <button type="button" onClick={() => setModal("save")} className={SECONDARY + DOOR}>
              Take your work
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setModal("save")} className={PRIMARY + " shrink-0 whitespace-nowrap"}>
            Keep it
          </button>
        )}
      </FloatingChrome>
      {modalEl}
    </>
  );
}
