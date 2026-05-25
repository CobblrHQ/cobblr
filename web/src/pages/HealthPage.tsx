// /configuration/health — rollup of every module's health probes.
// 503 HTTP status when any probe is error.

import { useQuery } from "@tanstack/react-query";
import { HeartPulse, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { usePageTitle } from "@cobblr/platform-web";

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
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <HeartPulse size={20} className="text-cobble-600" />
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100">
          Healthcheck
        </h1>
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
      </div>

      <p className="text-sm text-slate-500 dark:text-slate-400">
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

      <div className="border border-slate-200 dark:border-slate-700 rounded divide-y divide-slate-100 dark:divide-slate-800">
        {Object.entries(probes).map(([name, p]) => (
          <div key={name} className="px-3 py-2 text-sm flex items-baseline gap-3">
            {p.status === "ok" ? (
              <CheckCircle2 size={14} className="text-emerald-500" />
            ) : (
              <AlertTriangle size={14} className="text-ember-500" />
            )}
            <span className="font-mono">{name}</span>
            <span className="text-xs uppercase tracking-wide text-slate-500">
              {p.status}
            </span>
            {p.message && (
              <span className="text-xs text-slate-500 italic truncate">
                {p.message}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
