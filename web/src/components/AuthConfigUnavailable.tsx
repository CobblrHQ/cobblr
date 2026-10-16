// The sign-in surfaces could not learn what this deployment allows. Say WHY,
// honestly, and offer to ask again when asking again can work; never draw a
// form the server may refuse (#2804).
//
// Why matters: a sign-in page refused with 429 and Retry-After: 300 used to
// say "Couldn't reach Cobblr. Check your connection" beside an instant Try
// again (#3622). The connection was fine, and every press was refused again.
// A wait is now a wait, with the time it takes, and Try again counts down.
import { productName } from "@cobblr/platform-web";
import { useEffect, useState } from "react";
import type { RequestFailure } from "../lib/request-failure";
import { waitWords } from "../lib/request-wait";

const BUTTON =
  "w-full rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 disabled:hover:bg-cobble-600 text-white text-sm font-medium px-3 py-2.5 transition";

function copyFor(failure: RequestFailure, left: number | null): { headline: string; detail: string } {
  switch (failure.kind) {
    case "busy":
      return {
        headline: "Too many attempts from this network",
        detail:
          left && left > 0
            ? `${productName()} is fine, it is asking this network to slow down. Try again in ${waitWords(left)}.`
            : `${productName()} is fine, it is asking this network to slow down. Wait a little, then try again.`,
      };
    case "server":
      return {
        headline: `${productName()} is having trouble right now`,
        detail: "It answered, but could not say how signing in works here. Try again in a moment.",
      };
    case "refused":
      return { headline: `${productName()} turned the request down`, detail: failure.message };
    case "unreachable":
      return {
        headline: `Couldn't reach ${productName()}`,
        detail: "Nothing came back, so check your connection, then try again.",
      };
  }
}

export function AuthConfigUnavailable({ failure, onRetry }: { failure: RequestFailure; onRetry: () => void }) {
  const waitSec = failure.kind === "busy" ? failure.retryAfterSec : null;
  const [until] = useState(() => (waitSec ? Date.now() + waitSec * 1000 : 0));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [until]);
  const left = until ? Math.max(0, Math.ceil((until - now) / 1000)) : null;
  const waiting = left !== null && left > 0;
  const { headline, detail } = copyFor(failure, left);
  return (
    <div
      role="alert"
      data-testid="auth-config-unavailable"
      data-failure={failure.kind}
      className="space-y-3 rounded-xl border border-line dark:border-slate-700 p-5 bg-white dark:bg-slate-900 text-center"
    >
      <p className="text-sm text-content dark:text-mortar-100">
        <strong>{headline}</strong>
      </p>
      <p className="text-xs text-muted dark:text-slate-400">{detail}</p>
      <button type="button" onClick={onRetry} disabled={waiting} className={BUTTON}>
        {waiting ? `Try again in ${left! >= 60 ? `${Math.ceil(left! / 60)} min` : `${left}s`}` : "Try again"}
      </button>
    </div>
  );
}
