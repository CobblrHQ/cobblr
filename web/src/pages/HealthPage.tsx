// /configuration/health — rollup of every module's health probes.
// 503 HTTP status when any probe is error.

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { usePageTitle } from "@cobblr/platform-web";
import { QueryError } from "../components/QueryError";
import { ConfigHeaderActions } from "../components/ConfigPageHeader";

export function HealthPage() {
  usePageTitle("Health");
  const { activeSlug } = useActiveOrg();

  const snap = useQuery({
    queryKey: ["health-snapshot", activeSlug],
    queryFn: () => api.healthSnapshot(activeSlug),
    enabled: !!activeSlug,
    refetchInterval: 30_000,
  });

  const overall = snap.data?.status ?? "loading";
  const probes = snap.data?.probes ?? {};

  return (
    <div className="space-y-4">
      {snap.isError && (
        <QueryError what="health probes" onRetry={() => snap.refetch()} />
      )}
      <ConfigHeaderActions>
        <span
          className={`text-sm uppercase tracking-wide font-medium ${
            overall === "ok"
              ? "text-emerald-600 dark:text-emerald-400"
              : overall === "degraded"
                ? "text-amber-600 dark:text-amber-400"
                : "text-ember-600 dark:text-ember-400"
          }`}
        >
          {overall}
        </span>
      </ConfigHeaderActions>

      <p className="text-sm text-muted dark:text-slate-400">
        Each module can register a probe via{" "}
        <code className="font-mono text-xs">
          platform().health.registerProbe()
        </code>{" "}
        in its <code className="font-mono text-xs">onBoot</code>. This
        page polls{" "}
        <code className="font-mono text-xs">
          /modules/core-healthcheck/snapshot
        </code>{" "}
        every 30s. Auto-deploy verification scripts check the same
        endpoint and look at the HTTP status (503 ⇒ red).
      </p>

      <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
        {"// module probes"}
      </div>
      {snap.isLoading && <div className="text-xs text-faint">loading…</div>}
      {snap.data && Object.keys(probes).length === 0 && (
        <div className="text-xs text-faint dark:text-slate-500 italic">
          No probes registered - a module adds one in its onBoot.
        </div>
      )}
      {Object.keys(probes).length > 0 && (
      <div className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
        {Object.entries(probes).map(([name, p]) => (
          <div key={name} className="px-3 py-2 text-sm flex items-baseline gap-3">
            {p.status === "ok" ? (
              <CheckCircle2 size={14} className="text-emerald-500" />
            ) : (
              <AlertTriangle size={14} className="text-ember-500" />
            )}
            <span className="font-mono">{name}</span>
            <span className="text-xs uppercase tracking-wide text-muted">
              {p.status}
            </span>
            {p.message && (
              <span className="text-xs text-muted italic truncate">
                {p.message}
              </span>
            )}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
