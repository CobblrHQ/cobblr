// /configuration/x/:panelId — the ONE generic renderer for hosted settings
// panels (billing, Slack, …). The panel's content is a declarative view fetched
// from the API (contributed by the cloud overlay); this component renders it and
// dispatches actions. No panel-specific (proprietary) code lives here — a
// self-hosted instance has no panels, so this page is simply never linked.

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePageTitle, useToast, useConfirm } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { iconForName } from "../lib/panel-icons";

interface PanelSummary {
  id: string;
  label: string;
  icon?: string;
  group?: string;
}
type PanelBlock =
  | { kind: "text"; text: string; tone?: "muted" | "warning" }
  | { kind: "status"; label: string; value: string; active?: boolean }
  | { kind: "input"; key: string; label: string; placeholder?: string; secret?: boolean; value?: string }
  | { kind: "button"; label: string; action: string; style?: "primary" | "default" | "danger"; confirm?: string; submit?: boolean }
  | {
      kind: "select";
      label: string;
      action: string;
      value: string | null;
      options: Array<{ value: string; label: string }>;
      placeholder?: string;
      hint?: string;
    };
interface PanelView {
  blocks: PanelBlock[];
}
interface PanelActionResult {
  redirect?: string;
  refresh?: boolean;
  toast?: string;
}

export function HostedPanelPage() {
  const { panelId = "" } = useParams();
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();

  // Generic OAuth/checkout round-trip surfacing: a panel may redirect out and
  // back with ?panel_ok=… / ?panel_error=…; show a toast and refresh.
  useEffect(() => {
    const ok = params.get("panel_ok");
    const err = params.get("panel_error");
    if (ok) {
      toast.success(decodeURIComponent(ok));
      void qc.invalidateQueries({ queryKey: ["hosted-panel", activeSlug, panelId] });
    }
    if (err) toast.error(decodeURIComponent(err));
    if (ok || err) {
      params.delete("panel_ok");
      params.delete("panel_error");
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const panelsQ = useQuery({
    queryKey: ["hosted-panels", activeSlug],
    queryFn: () => api.request<{ panels: PanelSummary[] }>("GET", `/orgs/${activeSlug}/hosted-panels`),
    enabled: !!activeSlug,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const summary = panelsQ.data?.panels.find((p) => p.id === panelId);
  usePageTitle(summary?.label ?? "Settings");

  const viewQ = useQuery({
    queryKey: ["hosted-panel", activeSlug, panelId],
    queryFn: () => api.request<PanelView>("GET", `/orgs/${activeSlug}/hosted-panels/${panelId}`),
    enabled: !!activeSlug && !!panelId,
    retry: false,
  });

  // Live values for input blocks (seeded from each block's `value`).
  const [inputs, setInputs] = useState<Record<string, string>>({});

  const actionM = useMutation({
    mutationFn: (v: { action: string; value?: string | null; values?: Record<string, string> }) =>
      api.request<PanelActionResult>("POST", `/orgs/${activeSlug}/hosted-panels/${panelId}/action`, {
        action: v.action,
        input:
          v.value !== undefined || v.values !== undefined
            ? { ...(v.value !== undefined ? { value: v.value } : {}), ...(v.values ? { values: v.values } : {}) }
            : undefined,
      }),
    onSuccess: (r) => {
      if (r.redirect) {
        window.location.assign(r.redirect);
        return;
      }
      if (r.toast) toast.success(r.toast);
      if (r.refresh) {
        setInputs({}); // server view is authoritative again; drop local edits (incl. secrets)
        void qc.invalidateQueries({ queryKey: ["hosted-panel", activeSlug, panelId] });
      }
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const Icon = iconForName(summary?.icon);
  const Header = (
    <header className="flex items-center gap-3">
      <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
        <Icon className="h-5 w-5" /> {summary?.label ?? "Settings"}
      </h1>
    </header>
  );

  if (viewQ.isLoading) {
    return (
      <div className="space-y-6">
        {Header}
        <div className="text-sm text-muted">Loading…</div>
      </div>
    );
  }
  if (viewQ.isError || !viewQ.data) {
    return (
      <div className="space-y-6">
        {Header}
        <div className="text-sm text-muted border border-dashed rounded p-4 dark:border-slate-700">
          This settings panel isn’t available on this instance.
        </div>
      </div>
    );
  }

  const runButton = async (b: Extract<PanelBlock, { kind: "button" }>) => {
    if (b.confirm) {
      const ok = await confirm({
        title: b.label,
        message: b.confirm,
        confirmLabel: b.label,
        destructive: b.style === "danger",
      });
      if (!ok) return;
    }
    if (b.submit) {
      // Gather every input block's current value (live edit, or its seeded value).
      const values: Record<string, string> = {};
      for (const blk of viewQ.data?.blocks ?? []) {
        if (blk.kind === "input") values[blk.key] = inputs[blk.key] ?? blk.value ?? "";
      }
      actionM.mutate({ action: b.action, values });
      return;
    }
    actionM.mutate({ action: b.action });
  };

  return (
    <div className="space-y-6">
      {Header}
      <section className="border rounded-xl p-4 dark:border-slate-700 space-y-3">
        {viewQ.data.blocks.map((b, i) => {
          if (b.kind === "text") {
            return (
              <div
                key={i}
                className={
                  "text-sm " + (b.tone === "warning" ? "text-amber-600" : "text-muted")
                }
              >
                {b.text}
              </div>
            );
          }
          if (b.kind === "status") {
            return (
              <div key={i} className="flex items-center gap-2">
                <span className="text-sm text-muted">{b.label}:</span>
                <span className="text-sm font-semibold">{b.value}</span>
                {b.active !== undefined && (
                  <span
                    className={
                      "text-xs px-2 py-0.5 rounded-full " +
                      (b.active
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "bg-subtle text-muted dark:bg-slate-800")
                    }
                  >
                    {b.active ? "active" : "inactive"}
                  </span>
                )}
              </div>
            );
          }
          if (b.kind === "input") {
            return (
              <div key={i}>
                <label className="block text-sm font-medium mb-1">{b.label}</label>
                <input
                  type={b.secret ? "password" : "text"}
                  value={inputs[b.key] ?? b.value ?? ""}
                  placeholder={b.placeholder}
                  onChange={(e) => setInputs((prev) => ({ ...prev, [b.key]: e.target.value }))}
                  disabled={actionM.isPending}
                  className="w-full max-w-md px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900 font-mono"
                />
              </div>
            );
          }
          if (b.kind === "button") {
            const cls =
              b.style === "primary"
                ? "bg-cobble-600 hover:bg-cobble-700 text-white"
                : b.style === "danger"
                  ? "text-red-500 hover:bg-red-50 dark:hover:bg-red-900/40"
                  : "border text-content hover:bg-subtle dark:border-slate-700 dark:hover:bg-slate-800";
            return (
              <button
                key={i}
                type="button"
                onClick={() => void runButton(b)}
                disabled={actionM.isPending}
                className={"inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded disabled:opacity-50 mr-2 " + cls}
              >
                {b.label}
              </button>
            );
          }
          // select
          return (
            <div key={i}>
              <label className="block text-sm font-medium mb-1">{b.label}</label>
              <select
                value={b.value ?? ""}
                onChange={(e) => actionM.mutate({ action: b.action, value: e.target.value })}
                disabled={actionM.isPending}
                className="w-full max-w-sm px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
              >
                {b.placeholder && <option value="">{b.placeholder}</option>}
                {b.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {b.hint && <div className="text-xs text-amber-600 mt-1">{b.hint}</div>}
            </div>
          );
        })}
      </section>
    </div>
  );
}
