// /verify/:token — confirm an email address from a verification link. Public
// (the token is the secret). Consumes the token on mount and shows the result.

import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2, XCircle } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";
import { CobblestoneMark } from "../CobblestoneMark";

type State = "working" | "ok" | "error";

export function VerifyEmailPage() {
  usePageTitle("Verify email");
  const { token = "" } = useParams();
  const [state, setState] = useState<State>("working");
  const [detail, setDetail] = useState("");
  // StrictMode double-invokes effects in dev; guard so we only consume once.
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    let cancelled = false;
    api
      .verifyEmail({ token })
      .then((r) => {
        if (!cancelled) {
          setState("ok");
          setDetail(r.email);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setState("error");
          setDetail(err instanceof ApiError ? err.message : "This verification link didn't work.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas dark:bg-slate-900 p-6">
      <div className="w-full max-w-sm rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 space-y-4 text-center">
        <div className="flex flex-col items-center gap-3">
          <CobblestoneMark size={48} />
          {state === "working" && (
            <>
              <div
                className="h-8 w-8 rounded-full border-2 border-cobble-200 border-t-cobble-600 animate-spin"
                aria-hidden
              />
              <p className="text-sm text-muted dark:text-slate-400">Verifying your email…</p>
            </>
          )}
          {state === "ok" && (
            <>
              <CheckCircle2 size={36} className="text-emerald-500" />
              <h1 className="font-display text-xl font-bold text-content dark:text-mortar-100">
                Email verified
              </h1>
              <p className="text-sm text-muted dark:text-slate-400">
                <strong className="text-content dark:text-mortar-200">{detail}</strong> is confirmed.
              </p>
            </>
          )}
          {state === "error" && (
            <>
              <XCircle size={36} className="text-ember-500" />
              <h1 className="font-display text-xl font-bold text-content dark:text-mortar-100">
                Couldn't verify
              </h1>
              <p className="text-sm text-muted dark:text-slate-400">{detail}</p>
              <p className="text-xs text-faint dark:text-slate-500">
                The link may have expired or already been used. You can request a new one from your
                account once signed in.
              </p>
            </>
          )}
        </div>
        {state !== "working" && (
          <a
            href="/"
            className="inline-block w-full rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium py-2 transition"
          >
            Continue to Cobblr
          </a>
        )}
      </div>
    </div>
  );
}
