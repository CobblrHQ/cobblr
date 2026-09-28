// /oauth/authorize — the screen an AI assistant's connector (claude.ai, the
// Claude phone apps) sends a person to when they add Cobblr. They choose ONE
// workspace and whether the assistant may only look or also make changes;
// the server has already checked the request (client, redirect, PKCE,
// resource) before anything is shown, and hands back where to go next.
import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { usePageTitle } from "@cobblr/platform-web";
import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import { TOKEN_ACCESS_LABEL, TOKEN_ACCESS_MEANS } from "@cobblr/platform-contract/token-access";


const CARD = "w-full max-w-md rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-4";

export function OAuthConsentPage() {
  usePageTitle("Connect an AI assistant");
  const { user } = useAuth();
  const loc = useLocation();
  const params = useMemo(() => new URLSearchParams(loc.search), [loc.search]);
  const [workspace, setWorkspace] = useState<string>("");
  // Null until the person picks: what the connector asked for decides the
  // starting point, and a request that asked only to look starts at look.
  const [picked, setAccess] = useState<"look" | "change" | null>(null);

  const check = useQuery({
    queryKey: ["oauth-authorize-check", loc.search],
    queryFn: () => api.oauthAuthorizeCheck(params.toString()),
    enabled: !!user,
    retry: false,
  });

  const access: "look" | "change" = picked ?? (check.data?.wants_changes ? "change" : "look");

  const decide = useMutation({
    mutationFn: (decision: "allow" | "deny") =>
      api.oauthApprove({
        ...Object.fromEntries(params.entries()),
        decision,
        workspace: workspace || check.data?.workspaces[0]?.id,
        access,
      }),
    onSuccess: (r) => window.location.assign(r.redirect),
  });

  // Signed out is the route's business (App.tsx OAuthRoute): it signs the
  // person in on this URL, then renders this.
  if (!user) return null;

  if (check.isLoading) return <div className="min-h-screen grid place-items-center text-sm text-muted">Checking the request…</div>;
  if (check.isError || !check.data) {
    const why = check.error instanceof ApiError ? check.error.message : "This sign-in request could not be checked.";
    return (
      <div className="min-h-screen grid place-items-center p-4">
        <div className={CARD}>
          <h1 className="text-lg font-semibold text-content dark:text-mortar-100">This connection can't continue</h1>
          <p className="text-sm text-muted dark:text-slate-400">{why}</p>
          <p className="text-xs text-faint">Nothing was shared. Close this tab and try adding the connector again.</p>
        </div>
      </div>
    );
  }

  const d = check.data;
  const name = d.client_name?.trim() || "An AI assistant";
  return (
    <div className="min-h-screen grid place-items-center p-4">
      <div className={CARD}>
        <div>
          <h1 className="text-lg font-semibold text-content dark:text-mortar-100">Connect to Cobblr</h1>
          <p className="text-sm text-muted dark:text-slate-400 mt-1">
            <strong className="text-content dark:text-mortar-100">{name}</strong> (it calls itself that; it is sending you back to{" "}
            <span className="font-mono">{d.redirect_host}</span>) wants to use Cobblr as you.
          </p>
        </div>

        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Workspace</span>
          <select className="input" value={workspace || d.workspaces[0]?.id || ""} onChange={(e) => setWorkspace(e.target.value)}>
            {d.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="space-y-1.5">
          <legend className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">What it can do</legend>
          {(["look", "change"] as const).map((a) => (
            <label
              key={a}
              className={
                "flex items-start gap-2 rounded-md border p-2 cursor-pointer text-sm " +
                (access === a ? "border-cobble-300 dark:border-cobble-700 bg-cobble-50/50 dark:bg-cobble-900/20" : "border-line dark:border-slate-700")
              }
            >
              <input type="radio" name="oauth-access" checked={access === a} onChange={() => setAccess(a)} className="accent-cobble-500 mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="font-medium text-content dark:text-mortar-100">{TOKEN_ACCESS_LABEL[a]}</span>
                <span className="block text-xs text-muted dark:text-slate-400">{TOKEN_ACCESS_MEANS[a]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <p className="text-xs text-muted dark:text-slate-400">
          You can disconnect it any time under Configuration → Connect an AI assistant.
        </p>
        {decide.isError && (
          <p className="text-xs text-ember-500">{decide.error instanceof ApiError ? decide.error.message : "That did not go through."}</p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button type="button" className="btn-secondary" disabled={decide.isPending} onClick={() => decide.mutate("deny")}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={decide.isPending || d.workspaces.length === 0} onClick={() => decide.mutate("allow")}>
            {decide.isPending ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
