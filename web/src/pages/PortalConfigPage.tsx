// /configuration/portal — admin-only. Edits the workspace's portal
// branding (display name, logo path) + pinned-view list shown in the
// member portal at /portal/:slug.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronUp, ChevronDown, ExternalLink, X } from "lucide-react";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api, type PortalConfig } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function PortalConfigPage() {
  usePageTitle("Portal config");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();

  const configQ = useQuery({
    queryKey: ["portal-config", activeSlug],
    queryFn: () => api.getPortalConfig(activeSlug),
  });
  const viewsQ = useQuery({
    queryKey: ["all-saved-views", activeSlug],
    queryFn: () => api.listSavedViews(activeSlug),
  });

  const [displayName, setDisplayName] = useState("");
  const [logoPath, setLogoPath] = useState("");
  const [theme, setTheme] = useState<"light" | "dark" | "auto">("auto");
  const [welcomeMd, setWelcomeMd] = useState("");
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!configQ.data) return;
    const c = configQ.data.config;
    setDisplayName(c.display_name ?? "");
    setLogoPath(c.logo_path ?? "");
    setTheme(c.theme ?? "auto");
    setWelcomeMd(c.welcome_markdown ?? "");
    setPinnedIds(c.pinned_views);
  }, [configQ.data]);

  const save = useMutation({
    mutationFn: () => {
      const body: PortalConfig = {
        display_name: displayName.trim() || undefined,
        logo_path: logoPath.trim() || null,
        theme,
        welcome_markdown: welcomeMd.trim() || undefined,
        pinned_views: pinnedIds,
      };
      return api.updatePortalConfig(activeSlug, body);
    },
    onSuccess: () => {
      toast.success("Portal config saved.");
      void qc.invalidateQueries({ queryKey: ["portal-config", activeSlug] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't save"),
  });

  const allViews = viewsQ.data?.items ?? [];
  const pinnedSet = new Set(pinnedIds);
  const unpinnedViews = allViews.filter((v) => !pinnedSet.has(v.id));
  const pinnedViews = pinnedIds
    .map((id) => allViews.find((v) => v.id === id))
    .filter((v): v is NonNullable<typeof v> => !!v);

  function move(id: string, dir: -1 | 1) {
    setPinnedIds((prev) => {
      const i = prev.indexOf(id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-baseline justify-between border-b border-slate-200 dark:border-slate-700 pb-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
            portal config
          </h1>
          <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
            branding + pinned views shown to members at{" "}
            <code className="font-mono">/portal/{activeSlug}</code>
          </span>
        </div>
        <Link
          to={`/portal/${activeSlug}`}
          target="_blank"
          className="text-[11px] font-mono uppercase tracking-widest text-cobble-600 hover:text-cobble-700 transition inline-flex items-center gap-1"
        >
          preview <ExternalLink size={10} />
        </Link>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500">
          // branding
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Display name
            </span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={configQ.data?.org_name ?? ""}
              className="input"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Logo URL
            </span>
            <input
              value={logoPath}
              onChange={(e) => setLogoPath(e.target.value)}
              placeholder="https://…"
              className="input"
            />
          </label>
          <label className="block col-span-2">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Welcome markdown
            </span>
            <textarea
              value={welcomeMd}
              onChange={(e) => setWelcomeMd(e.target.value)}
              placeholder="# Welcome to the club…"
              rows={4}
              className="input font-mono text-xs"
            />
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500">
          // pinned views
        </div>
        {pinnedViews.length === 0 && (
          <div className="text-xs text-slate-400 italic">
            No views pinned. Add some below.
          </div>
        )}
        <ul className="space-y-1">
          {pinnedViews.map((v, i) => (
            <li
              key={v.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-mortar-50/50 dark:bg-slate-800/50"
            >
              <span className="text-[10px] font-mono text-slate-400 w-5">
                {i + 1}.
              </span>
              <span className="flex-1 text-sm text-slate-700 dark:text-mortar-100 truncate">
                {v.name}{" "}
                <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
                  ({v.entity_kind})
                </span>
              </span>
              <button
                type="button"
                onClick={() => move(v.id, -1)}
                disabled={i === 0}
                className="text-slate-400 hover:text-cobble-600 transition p-1 disabled:opacity-30"
              >
                <ChevronUp size={12} />
              </button>
              <button
                type="button"
                onClick={() => move(v.id, 1)}
                disabled={i === pinnedViews.length - 1}
                className="text-slate-400 hover:text-cobble-600 transition p-1 disabled:opacity-30"
              >
                <ChevronDown size={12} />
              </button>
              <button
                type="button"
                onClick={() => setPinnedIds((p) => p.filter((x) => x !== v.id))}
                className="text-slate-400 hover:text-ember-500 transition p-1"
                title="Unpin"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>

        {unpinnedViews.length > 0 && (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-2">
              + available saved views
            </div>
            <div className="flex flex-wrap gap-1.5">
              {unpinnedViews.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setPinnedIds((p) => [...p, v.id])}
                  className="text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 hover:border-cobble-400 dark:hover:border-cobble-600 transition text-slate-600 dark:text-mortar-200"
                >
                  + {v.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-4 py-2 transition disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
