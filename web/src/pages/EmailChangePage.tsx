// /email-change/:token and /email-change/revert/:token: the two links of a
// change of sign-in address (api/src/platform/email-change.ts). Public: the
// token is the proof. Neither signs anybody in; the person signs in again.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CheckCircle2, XCircle } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";
import { CobblestoneMark } from "../CobblestoneMark";

export function EmailChangePage({ mode }: { mode: "confirm" | "revert" }) {
  usePageTitle(mode === "confirm" ? "Confirm your new address" : "Take your account back");
  const { token = "" } = useParams();
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [detail, setDetail] = useState("");
  const [reset, setReset] = useState<string | null>(null);
  const navigate = useNavigate();
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const call = mode === "confirm" ? api.confirmEmailChange({ token }) : api.revertEmailChange({ token });
    call
      .then((r) => {
        setState("ok");
        setDetail(r.email);
        const resetToken = (r as { reset_token?: string }).reset_token;
        if (resetToken) setReset(resetToken);
      })
      .catch((err) => {
        setState("error");
        setDetail(err instanceof ApiError ? err.message : "This link didn't work.");
      });
  }, [mode, token]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas dark:bg-slate-900 p-6">
      <div className="w-full max-w-sm rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 space-y-4 text-center" data-testid="email-change-page">
        <div className="flex flex-col items-center gap-3">
          <CobblestoneMark size={48} />
          {state === "working" && <p className="text-sm text-muted dark:text-slate-400">One moment…</p>}
          {state === "ok" && (
            <>
              <CheckCircle2 size={36} className="text-emerald-500" />
              <h1 className="font-display text-xl font-bold text-content dark:text-mortar-100">
                {mode === "confirm" ? "Address changed" : "Your account is back"}
              </h1>
              <p className="text-sm text-muted dark:text-slate-400">
                {mode === "confirm" ? (
                  <>
                    You now sign in with <strong className="text-content dark:text-mortar-200">{detail}</strong>. Every device was
                    signed out, so sign in again.
                  </>
                ) : (
                  <>
                    It signs in with <strong className="text-content dark:text-mortar-200">{detail}</strong> again. Every device
                    was signed out, its API tokens and connected apps were cut off, and its old password no longer works,
                    because whoever changed the address knew it. Choose a new one now.
                  </>
                )}
              </p>
              {mode === "revert" && reset ? (
                <button
                  type="button"
                  data-testid="email-change-revert-set-password"
                  onClick={() => navigate(`/reset/${reset}`)}
                  className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium"
                >
                  Choose a new password
                </button>
              ) : (
                <Link to="/" className="text-sm font-medium text-accent hover:underline">
                  Sign in
                </Link>
              )}
            </>
          )}
          {state === "error" && (
            <>
              <XCircle size={36} className="text-ember-500" />
              <h1 className="font-display text-xl font-bold text-content dark:text-mortar-100">That link didn't work</h1>
              <p className="text-sm text-muted dark:text-slate-400">{detail}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
