// Phone-side landing for QR pair-login: /pair?code=… . The desktop minted the
// code (POST /auth/pair/start) and rendered it as a QR; the phone scans it,
// opens this page, and claims the code for a real session — signed in as the
// SAME user, dropped into the SAME workspace, ready to scan with its camera.
//
// This route lives OUTSIDE the /w/:handle workspace basename (it's reached
// unauthenticated), so it consumes the code, stores the token + active
// workspace, then does a FULL navigation into /w/<handle>/scan/camera — which
// re-bootstraps AuthContext from the freshly-stored token.
//
// Two ways here: (1) scan the QR — ?code= is read + claimed automatically;
// (2) open /pair and paste the code (fallback when the QR won't scan).

import { useEffect, useState } from "react";
import { CheckCircle2, Smartphone } from "lucide-react";
import { api, ApiError, setToken, type AuthResponse, type OrgMembership } from "../lib/api";
import { urlHandleFor, pickDefaultOrg } from "../auth/ActiveOrgContext";

const ACTIVE_ORG_KEY = "cobblr.activeOrgSlug";

type Phase = "claiming" | "success" | "error" | "manual";

/** After a successful claim, store the session + active workspace and hard-
 *  navigate into the scanner. A full navigation (not router push) is deliberate:
 *  this page is outside the workspace basename, and the reload re-reads the
 *  token through AuthProvider. */
function landInWorkspace(res: AuthResponse & { target_org_slug: string | null }) {
  setToken(res.token);
  const orgs = res.orgs as OrgMembership[];
  const target = res.target_org_slug
    ? orgs.find((o) => o.slug === res.target_org_slug)
    : null;
  const org = target ?? pickDefaultOrg(orgs);
  if (!org) {
    // No workspace at all (shouldn't happen for a real account) — just land home.
    window.location.assign("/");
    return;
  }
  try {
    localStorage.setItem(ACTIVE_ORG_KEY, org.slug);
  } catch {
    /* private mode / storage disabled — the URL handle still routes us right */
  }
  // The scanner the desktop is already showing. Full reload bootstraps auth.
  window.location.assign(`/w/${urlHandleFor(org, orgs)}/scan/camera`);
}

export function PairPage() {
  const codeFromUrl = new URLSearchParams(window.location.search).get("code") ?? "";
  const [phase, setPhase] = useState<Phase>(codeFromUrl ? "claiming" : "manual");
  const [error, setError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");

  useEffect(() => {
    if (phase !== "claiming") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.pairClaim(codeFromUrl);
        if (cancelled) return;
        setPhase("success");
        landInWorkspace(res);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "This pair code is invalid or has expired.");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, codeFromUrl]);

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    const code = manualCode.trim();
    if (!code) return;
    setError(null);
    setPhase("claiming");
    try {
      const res = await api.pairClaim(code);
      setPhase("success");
      landInWorkspace(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "This pair code is invalid or has expired.");
      setPhase("error");
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-4 py-10 sm:py-12">
      <div className="w-full max-w-sm">
        <div className="bg-surface dark:bg-slate-900/70 backdrop-blur border border-line dark:border-slate-700 rounded-2xl shadow-sm p-7 text-content dark:text-mortar-100">
          <div className="flex items-center gap-2 mb-4">
            <Smartphone size={16} className="text-accent" />
            <span className="font-display font-semibold">Pair this phone</span>
          </div>

          {phase === "claiming" && (
            <div className="py-10 text-center text-sm text-muted dark:text-slate-400">
              Verifying pair code…
            </div>
          )}

          {phase === "success" && (
            <div className="py-10 text-center">
              <CheckCircle2 size={36} className="mx-auto text-emerald-500 mb-2" />
              <div className="text-sm font-medium">Signed in</div>
              <div className="text-xs text-faint dark:text-slate-500 mt-1">Opening the scanner…</div>
            </div>
          )}

          {(phase === "manual" || phase === "error") && (
            <form onSubmit={submitManual} className="space-y-3">
              {phase === "error" && (
                <div className="bg-ember-50 dark:bg-ember-500/10 border border-ember-200 dark:border-ember-500/30 text-ember-600 dark:text-ember-300 px-3 py-2 rounded-lg text-sm">
                  {error ?? "Pair code expired or already used."}
                </div>
              )}
              <p className="text-sm text-muted dark:text-slate-400">
                On your computer, open Cobblr and tap <em>Pair phone</em> on the
                Scan card, then scan the QR with your camera. Or paste the code
                below.
              </p>
              <label className="block">
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                  Pair code
                </span>
                <input
                  autoFocus
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  placeholder="Paste the code"
                  className="input font-mono"
                />
              </label>
              <button
                type="submit"
                disabled={!manualCode.trim()}
                className="w-full rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2 transition disabled:opacity-50"
              >
                Sign in
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
