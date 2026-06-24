// /configuration/portal — admin-only. Edits the workspace's portal
// branding (display name, logo path) + pinned-view list shown in the
// member portal at /portal/:slug.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronUp, ChevronDown, ExternalLink, X } from "lucide-react";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api, type AppTheme, type PortalConfig } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ThemeEditor } from "../components/ThemeEditor";

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
  const appsQ = useQuery({
    queryKey: ["portal-config-apps", activeSlug],
    queryFn: () => api.listApps(activeSlug),
  });

  const [displayName, setDisplayName] = useState("");
  const [logoPath, setLogoPath] = useState("");
  const [theme, setTheme] = useState<"light" | "dark" | "auto">("auto");
  const [welcomeMd, setWelcomeMd] = useState("");
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [defaultApp, setDefaultApp] = useState("");
  const [themeTokens, setThemeTokens] = useState<AppTheme | null>(null);
  const [adminTheme, setAdminTheme] = useState<AppTheme | null>(null);

  useEffect(() => {
    if (!configQ.data) return;
    const c = configQ.data.config;
    setDisplayName(c.display_name ?? "");
    setLogoPath(c.logo_path ?? "");
    setTheme(c.theme ?? "auto");
    setWelcomeMd(c.welcome_markdown ?? "");
    setPinnedIds(c.pinned_views);
    setDefaultApp(c.default_app ?? "");
    setThemeTokens(c.theme_tokens ?? null);
    setAdminTheme(c.admin_theme ?? null);
  }, [configQ.data]);

  // What the launcher would INHERIT if there's no override — the default
  // app's, else the sole app's, theme. Drives the editor's hint.
  const apps = appsQ.data?.items ?? [];
  const inheritApp =
    (defaultApp && apps.find((a) => a.slug === defaultApp)) ||
    (apps.length === 1 ? apps[0] : undefined);

  const save = useMutation({
    mutationFn: () => {
      const body: PortalConfig = {
        display_name: displayName.trim() || undefined,
        logo_path: logoPath.trim() || null,
        theme,
        welcome_markdown: welcomeMd.trim() || undefined,
        pinned_views: pinnedIds,
        default_app: defaultApp || null,
        theme_tokens: themeTokens,
        admin_theme: adminTheme,
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
    <div className="space-y-5 max-w-3xl mx-auto">
      <div className="flex items-baseline justify-between border-b border-line dark:border-slate-700 pb-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
            portal config
          </h1>
          <span className="page-subtitle">
            branding + pinned views shown to members at{" "}
            <code className="font-mono">/portal/{activeSlug}</code>
          </span>
        </div>
        <Link
          to={`/portal/${activeSlug}`}
          target="_blank"
          className="text-[11px] font-mono uppercase tracking-widest text-accent hover:text-accent transition inline-flex items-center gap-1"
        >
          preview <ExternalLink size={10} />
        </Link>
      </div>

      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
          // branding
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
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
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              Logo URL
            </span>
            <input
              value={logoPath}
              onChange={(e) => setLogoPath(e.target.value)}
              placeholder="https://…"
              className="input"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              Members land in
            </span>
            <select value={defaultApp} onChange={(e) => setDefaultApp(e.target.value)} className="input">
              <option value="">Launcher (this portal)</option>
              {(appsQ.data?.items ?? []).map((a) => (
                <option key={a.slug} value={a.slug}>{a.name}</option>
              ))}
            </select>
            <span className="block text-[10px] text-faint dark:text-slate-500 mt-1">
              The app a member opens directly instead of this portal. (A lone app auto-lands even when this is blank.)
            </span>
          </label>
          <label className="block col-span-2">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
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

      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
          // launcher theme
        </div>
        <p className="text-[11px] text-faint dark:text-slate-500">
          {themeTokens ? (
            <>This portal launcher uses its own theme below.</>
          ) : inheritApp ? (
            <>
              The launcher currently <strong>inherits</strong> the{" "}
              <strong>{inheritApp.name}</strong> app's theme. Set one below to override it.
            </>
          ) : (
            <>The launcher uses Cobblr's default look. Set a theme below to brand it.</>
          )}
        </p>
        {themeTokens ? (
          <ThemeEditor
            theme={themeTokens}
            onChange={(patch) =>
              setThemeTokens(patch === null ? null : { ...(themeTokens ?? {}), ...patch })
            }
            helpText="Brands the member launcher (the page at /portal/:slug). Tokens only; Save to apply."
          />
        ) : (
          <button
            type="button"
            onClick={() => setThemeTokens(inheritApp?.theme ?? {})}
            className="text-xs rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-1.5 hover:border-accent dark:hover:border-cobble-600 transition text-content dark:text-mortar-200"
          >
            {inheritApp ? "Override the inherited theme" : "Give the launcher its own theme"}
          </button>
        )}
      </div>

      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
          // admin dashboard theme
        </div>
        <p className="text-[11px] text-faint dark:text-slate-500">
          Brands <strong>this</strong> admin dashboard (the shell you're in now): the whole thing
          recolors — page, header bar, every card / table / label — plus your workspace logo beside
          the Cobblr mark, which always stays. Buttons and form inputs stay neutral so actions stay
          legible on any palette. Save, then reload the dashboard.
        </p>
        {adminTheme ? (
          <ThemeEditor
            theme={adminTheme}
            onChange={(patch) =>
              setAdminTheme(patch === null ? null : { ...(adminTheme ?? {}), ...patch })
            }
            helpText="Recolors the whole admin dashboard. Save, then reload the dashboard."
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdminTheme({})}
            className="text-xs rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-1.5 hover:border-accent dark:hover:border-cobble-600 transition text-content dark:text-mortar-200"
          >
            Brand the admin dashboard
          </button>
        )}
      </div>

      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
          // pinned views
        </div>
        {pinnedViews.length === 0 && (
          <div className="text-xs text-faint italic">
            No views pinned. Add some below.
          </div>
        )}
        <ul className="space-y-1">
          {pinnedViews.map((v, i) => (
            <li
              key={v.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded border border-line dark:border-slate-700 bg-subtle/50 dark:bg-slate-800/50"
            >
              <span className="text-[10px] font-mono text-faint w-5">
                {i + 1}.
              </span>
              <span className="flex-1 text-sm text-content dark:text-mortar-100 truncate">
                {v.name}{" "}
                <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
                  ({v.entity_kind})
                </span>
              </span>
              <button
                type="button"
                onClick={() => move(v.id, -1)}
                disabled={i === 0}
                className="text-faint hover:text-accent transition p-1 disabled:opacity-30"
              >
                <ChevronUp size={12} />
              </button>
              <button
                type="button"
                onClick={() => move(v.id, 1)}
                disabled={i === pinnedViews.length - 1}
                className="text-faint hover:text-accent transition p-1 disabled:opacity-30"
              >
                <ChevronDown size={12} />
              </button>
              <button
                type="button"
                onClick={() => setPinnedIds((p) => p.filter((x) => x !== v.id))}
                className="text-faint hover:text-ember-500 transition p-1"
                title="Unpin"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>

        {unpinnedViews.length > 0 && (
          <div className="pt-2 border-t border-line dark:border-slate-800">
            <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-2">
              + available saved views
            </div>
            <div className="flex flex-wrap gap-1.5">
              {unpinnedViews.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setPinnedIds((p) => [...p, v.id])}
                  className="text-xs rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1 hover:border-accent dark:hover:border-cobble-600 transition text-content dark:text-mortar-200"
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
