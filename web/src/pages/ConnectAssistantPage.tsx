// /configuration/connect-assistant: connect Claude (or another MCP client) to
// this workspace. The endpoint URL, a one-click token, and a paste-ready
// snippet per client, with clients that cannot connect yet named as such.
import { productName } from "@cobblr/platform-web";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Check, KeyRound, Link2, Plug } from "lucide-react";
import { StatusRow, useLater, useToast, usePageTitle } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import { assistantClients, mcpEndpoint } from "../lib/assistant-connect";

const SECTION = "rounded-lg border border-line dark:border-slate-600 p-4";

export function ConnectAssistantPage() {
  usePageTitle("Connect an AI assistant");
  const { activeSlug } = useActiveOrg();
  const slug = activeSlug ?? "";
  const toast = useToast();
  const later = useLater();
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Whether a connector (claude.ai) can sign in here, and the URL it signs in
  // at. The server answers: it knows its public address and whether it is a
  // sandbox with nobody to sign in as.
  const signIn = useQuery({ queryKey: ["oauth-status", slug], queryFn: () => api.oauthStatus(slug), enabled: !!slug, staleTime: 5 * 60_000 });

  const mint = useMutation({
    mutationFn: () =>
      api.createApiToken({
        name: `AI assistant (${slug})`,
        source: "connect-assistant",
        meta: { workspace: slug },
        // This workspace only, and able to make changes: never the whole
        // account for a token that exists to reach one workspace.
        workspace: slug,
        access: "change",
        expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      }),
    onSuccess: (r) => setToken(r.token),
    onError: (e) => toast.error(`Couldn't create a token: ${(e as Error).message}`),
  });

  if (!slug) return <div className="text-sm text-faint">No active workspace.</div>;
  const endpoint = mcpEndpoint(window.location.origin, slug);
  const clients = assistantClients(endpoint, token, signIn.data ? { available: signIn.data.available, url: signIn.data.mcp_url } : null);

  const copy = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(id);
    later.after("copied", 1400, () => setCopied((c) => (c === id ? null : c)));
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-content dark:text-mortar-200">
        Let your own Claude read and work in <strong>this workspace</strong> over MCP (Model Context Protocol). It acts as you, in this workspace only: it can read and change records and run actions, never the workspace's settings, members or connections.
      </p>

      <section className={SECTION + " space-y-2"}>
        <div className="flex items-center gap-2 text-sm font-medium text-content dark:text-slate-100">
          <Plug size={15} className="text-cobble-500" /> Server URL
        </div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-md border border-line dark:border-slate-600 bg-subtle dark:bg-slate-800 px-2 py-1.5 text-xs">{endpoint}</code>
          <button type="button" onClick={() => copy("url", endpoint)} className="shrink-0 text-xs text-accent hover:underline">
            {copied === "url" ? "Copied" : "Copy"}
          </button>
        </div>
      </section>

      <section className={SECTION + " space-y-2"}>
        <div className="flex items-center gap-2 text-sm font-medium text-content dark:text-slate-100">
          <KeyRound size={15} className="text-cobble-500" /> Token
        </div>
        <StatusRow
          state={token ? "made" : "none"}
          className="space-y-2"
          testId="assistant-token"
          states={{
            made: (
              <p className="text-xs text-content dark:text-slate-300">
                <Check size={12} className="mr-1 inline text-emerald-500" />
                Created, for this workspace only, able to look and make changes. It is already filled into the steps below, and this is the only time it is shown. It expires in a year.
              </p>
            ),
            none: (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => mint.mutate()}
                  disabled={mint.isPending}
                  className="rounded-md bg-cobble-600 px-3 py-1.5 text-sm text-white hover:bg-cobble-700 disabled:opacity-60"
                >
                  {mint.isPending ? "Creating…" : "Create a token for my assistant"}
                </button>
                <span className="text-xs text-muted dark:text-slate-400">The steps below fill it in for you.</span>
              </div>
            ),
          }}
          // Before one is made and right after: where tokens are seen and revoked (#5774).
          always={
            <p className="text-xs text-muted dark:text-slate-400">
              See or revoke tokens any time under{" "}
              <Link to="/configuration/tokens" className="text-accent hover:underline">API tokens</Link>.
            </p>
          }
        />
      </section>

      {clients.map((c) => (
        <section key={c.id} className={SECTION + " space-y-2"} data-client={c.id} data-status={c.status}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-sm font-medium text-content dark:text-slate-100">{c.label}</div>
            <span className={"text-[11px] " + (c.status === "ready" ? "text-faint dark:text-slate-500" : "text-amber-800 dark:text-amber-300")}>
              {c.status === "ready" ? c.where : "Not available yet"}
            </span>
          </div>
          {c.steps.map((s) => (
            <p key={s} className="text-xs text-muted dark:text-slate-400">{s}</p>
          ))}
          {c.snippet && (
            <div className="relative">
              <button
                type="button"
                onClick={() => copy(c.id, c.snippet!)}
                className="absolute right-2 top-2 z-10 rounded border border-line dark:border-slate-600 bg-surface/80 dark:bg-slate-900/80 px-2 py-1 text-xs text-muted hover:text-content"
              >
                {copied === c.id ? "Copied" : "Copy"}
              </button>
              <pre tabIndex={0} className="overflow-x-auto rounded-md border border-line dark:border-slate-700 bg-slate-950 p-4 pr-16 text-xs leading-relaxed text-slate-200"><code>{c.snippet}</code></pre>
            </div>
          )}
        </section>
      ))}

      {signIn.data?.available && <ConnectedApps />}
    </div>
  );
}

/** The connectors that signed in as you (claude.ai, say), each held to one
 *  workspace and an access level, and the way to end one. */
function ConnectedApps() {
  const qc = useQueryClient();
  const toast = useToast();
  const grants = useQuery({ queryKey: ["oauth-grants"], queryFn: api.myOAuthGrants });
  const disconnect = useMutation({
    mutationFn: (id: string) => api.revokeOAuthGrant(id),
    onSuccess: () => {
      toast.success(`Disconnected. It can no longer reach ${productName()}.`);
      void qc.invalidateQueries({ queryKey: ["oauth-grants"] });
    },
    onError: (e) => toast.error(`Couldn't disconnect it: ${(e as Error).message}`),
  });
  const items = grants.data?.items ?? [];
  return (
    <section className={SECTION + " space-y-2"} data-testid="connected-apps">
      <div className="flex items-center gap-2 text-sm font-medium text-content dark:text-slate-100">
        <Link2 size={15} className="text-cobble-500" /> Connected apps
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted dark:text-slate-400">
          {grants.isLoading ? "Checking…" : "None yet. A connector you approve shows here, in every workspace it can reach."}
        </p>
      ) : (
        <ul className="divide-y divide-line dark:divide-slate-700">
          {items.map((g) => (
            <li key={g.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-content dark:text-mortar-100">{g.client_name || g.redirect_host || "An AI assistant"}</div>
                <div className="text-[11px] text-muted dark:text-slate-400">
                  {g.org_name} · {g.access === "look" ? "look only" : "look and make changes"} ·{" "}
                  {g.last_used_at ? `last used ${new Date(g.last_used_at).toLocaleDateString()}` : "not used yet"}
                </div>
              </div>
              <button
                type="button"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate(g.id)}
                className="shrink-0 rounded border border-line dark:border-slate-600 px-2.5 py-1 text-xs text-muted hover:text-ember-500 hover:border-ember-400 disabled:opacity-50"
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
