// /oauth/authorize — the screen an AI assistant's connector (claude.ai, the
// Claude phone apps) sends a person to when they add Cobblr. They choose ONE
// workspace and whether the assistant may only look or also make changes;
// the server has already checked the request (client, redirect, PKCE,
// resource) before anything is shown, and hands back where to go next.
import { productName } from "@cobblr/platform-web";
import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { usePageTitle, SegmentedChoice } from "@cobblr/platform-web";
import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import { TOKEN_ACCESS_LABEL, TOKEN_ACCESS_MEANS } from "@cobblr/platform-contract/token-access";


// Padded in px, as the page around it: in rem both doubled at 200% text and
// the card ran 40 px past a phone (#8431).
const CARD = "w-full max-w-md min-w-0 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-[20px] space-y-4";

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
      <div className="min-h-screen grid place-items-center p-[16px]">
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
    <div className="min-h-screen grid place-items-center p-[16px]">
      <div className={CARD}>
        <div>
          <h1 className="text-lg font-semibold text-content dark:text-mortar-100">Connect to {productName()}</h1>
          <p className="text-sm text-muted dark:text-slate-400 mt-1">
            <strong className="text-content dark:text-mortar-100">{name}</strong> (it calls itself that; it is sending you back to{" "}
            <span className="font-mono">{d.redirect_host}</span>) wants to use {productName()} as you.
          </p>
        </div>

        <label className="block">
          <span className="block text-[10px] uppercase tracking-widest text-faint mb-1">Workspace</span>
          <select className="input" value={workspace || d.workspaces[0]?.id || ""} onChange={(e) => setWorkspace(e.target.value)}>
            {d.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-1.5">
          <span className="block text-[10px] uppercase tracking-widest text-faint mb-1">What it can do</span>
          <SegmentedChoice
            stack
            label="What it can do"
            value={access}
            onChange={setAccess}
            options={(["look", "change"] as const).map((a) => ({ value: a, label: TOKEN_ACCESS_LABEL[a], hint: TOKEN_ACCESS_MEANS[a] }))}
          />
        </div>

        <p className="text-xs text-muted dark:text-slate-400">
          You can disconnect it any time under Configuration → Connect an AI assistant.
        </p>
        {decide.isError && (
          <p className="text-xs text-ember-500">{decide.error instanceof ApiError ? decide.error.message : "That did not go through."}</p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button type="button" className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 text-sm px-3 py-1.5 transition disabled:opacity-50" disabled={decide.isPending} onClick={() => decide.mutate("deny")}>
            Cancel
          </button>
          <button type="button" className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-1.5 transition disabled:opacity-50" disabled={decide.isPending || d.workspaces.length === 0} onClick={() => decide.mutate("allow")}>
            {decide.isPending ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
