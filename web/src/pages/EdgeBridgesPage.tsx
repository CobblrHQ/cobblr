// /configuration/edge — the edge-bridge pane of glass. GENERIC by design: a
// bridge is kernel infrastructure (one tunnel from your site), and modules are
// merely its consumers. So this page renders three data-driven sections and
// hardcodes no module anywhere:
//
//   · connected right now  — workspace bridges + your personal (account) agent
//   · set up a bridge      — mint the token + copy the run command, right here
//   · what can use it      — one card per REGISTERED edge consumer; a consumer
//                            whose module is off renders greyed with Enable, so
//                            enabling e.g. digifab later just attaches it to
//                            the bridge that's already connected.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Activity, Cable, CheckCircle2, ChevronRight, Plug, User, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { EdgeBridgeInstall } from "../components/EdgeBridgeInstall";

export function EdgeBridgesPage() {
  usePageTitle("Edge bridges");
  const { activeSlug } = useActiveOrg();
  const slug = activeSlug ?? "";
  const toast = useToast();
  const qc = useQueryClient();

  const status = useQuery({
    queryKey: ["edge-status", slug],
    queryFn: () => api.getEdgeStatus(slug),
    enabled: !!slug,
    refetchInterval: 10_000,
  });
  const consumers = useQuery({
    queryKey: ["edge-consumers", slug],
    queryFn: () => api.getEdgeConsumers(slug),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const enableMut = useMutation({
    mutationFn: (name: string) => api.enableModule(slug, name),
    onSuccess: () => {
      toast.success("Enabled — it can use your bridge now.");
      void qc.invalidateQueries({ queryKey: ["edge-consumers", slug] });
      void qc.invalidateQueries({ queryKey: ["org-modules", slug] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't enable it"),
  });

  const agents = status.data?.agents ?? [];
  const personal = status.data?.personal?.connected ?? false;
  const personalBacks = status.data?.personal?.backs ?? [];
  const staleMs = status.data?.stale_after_ms ?? 60_000;
  const nothingConnected = agents.length === 0 && !personal;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title flex items-center gap-2">
          <Cable size={22} className="text-accent" /> Edge bridges
        </h1>
        <p className="text-sm text-muted dark:text-slate-400 mt-1">
          A bridge is a small program on your own network that connects Cobblr to things the cloud can't reach.
          Set one up once — everything that needs your site attaches to it.
        </p>
      </div>

      {/* Connected right now */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-accent" />
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100 flex-1">Connected right now</h2>
          <span className="text-[11px] text-faint dark:text-slate-500">auto-refreshes</span>
        </div>
        {nothingConnected ? (
          <p className="text-sm text-faint dark:text-slate-400">
            No bridge is connected. Set one up below — the moment it dials in, it appears here.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {agents.map((a) => {
              const fresh = a.last_seen_ms < staleMs;
              return (
                <li key={a.bridge ?? "default"} className="flex items-center gap-3 rounded-lg border border-line dark:border-slate-800 px-3 py-2 text-sm">
                  {fresh ? <CheckCircle2 size={15} className="text-emerald-500 shrink-0" /> : <XCircle size={15} className="text-red-500 shrink-0" />}
                  <span className="font-medium text-content dark:text-mortar-100">{a.bridge ?? "main edge bridge"}</span>
                  <span className="text-[10px] font-mono uppercase rounded-full px-1.5 py-0.5 bg-subtle dark:bg-slate-800 text-muted dark:text-slate-400">workspace</span>
                  <span className="text-xs text-faint dark:text-slate-400 flex-1">
                    polled {Math.round(a.last_seen_ms / 1000)}s ago
                    {a.parked ? " · idle, waiting for work" : a.in_flight > 0 ? ` · ${a.in_flight} request${a.in_flight === 1 ? "" : "s"} in flight` : ""}
                    {a.queued > 0 ? ` · ${a.queued} queued` : ""}
                  </span>
                </li>
              );
            })}
            {personal && (
              <li className="flex items-center gap-3 rounded-lg border border-line dark:border-slate-800 px-3 py-2 text-sm">
                <CheckCircle2 size={15} className="text-emerald-500 shrink-0" />
                <span className="font-medium text-content dark:text-mortar-100 inline-flex items-center gap-1.5">
                  <User size={13} className="text-accent" /> main edge bridge
                </span>
                <span className="text-[10px] font-mono uppercase rounded-full px-1.5 py-0.5 bg-cobble-100 dark:bg-cobble-900/40 text-accent">account</span>
                <span className="text-xs text-faint dark:text-slate-400 flex-1">
                  runs on your own machine; follows your account into every workspace you route it to (manage in{" "}
                  <Link to="/me/connections" className="text-accent hover:underline">Your connections</Link>)
                  {personalBacks.length > 0 ? <> · backing: {personalBacks.join(", ")}</> : null}
                </span>
              </li>
            )}
          </ul>
        )}
      </section>

      {/* Set up a bridge — right here, no module required */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Plug size={15} className="text-accent" />
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Set up a bridge</h2>
        </div>
        <EdgeBridgeInstall slug={slug} />
      </section>

      {/* What can use it — data-driven from the consumer registry */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">What can use your bridge</h2>
        {(consumers.data?.consumers ?? []).length === 0 ? (
          <p className="text-sm text-faint dark:text-slate-400">Nothing registered yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {(consumers.data?.consumers ?? []).map((c) => (
              <li
                key={`${c.module}:${c.label}`}
                className={
                  "rounded-lg border px-3 py-2.5 " +
                  (c.enabled
                    ? "border-line dark:border-slate-800"
                    : "border-dashed border-line dark:border-slate-800 opacity-70")
                }
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-content dark:text-mortar-100">{c.label}</div>
                    <div className="text-xs text-muted dark:text-slate-400">{c.description}</div>
                  </div>
                  {c.enabled ? (
                    <Link
                      to={c.href}
                      className="shrink-0 inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-content dark:text-mortar-100 hover:border-accent transition"
                    >
                      Manage <ChevronRight size={12} />
                    </Link>
                  ) : (
                    <button
                      type="button"
                      disabled={enableMut.isPending}
                      onClick={() => enableMut.mutate(c.module)}
                      className="shrink-0 rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs font-medium px-2.5 py-1"
                    >
                      {enableMut.isPending && enableMut.variables === c.module ? "Enabling…" : "Enable"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
