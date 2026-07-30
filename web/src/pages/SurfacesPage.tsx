// /configuration/surfaces — list + revoke public-share URLs for the
// workspace. Each surface points at a saved view (or one entity);
// anyone with the token can read it without an account.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  Copy,
  ExternalLink,
  Globe,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { ApiError, api, type SavedView, type SurfaceRecord } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import { ConfigHeaderActions } from "../components/ConfigPageHeader";

export function SurfacesPage() {
  usePageTitle("Public surfaces");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [statsFor, setStatsFor] = useState<SurfaceRecord | null>(null);
  const [editFor, setEditFor] = useState<SurfaceRecord | null>(null);

  const list = useQuery({
    queryKey: ["surfaces", activeSlug],
    queryFn: () => api.listSurfaces(activeSlug),
    enabled: !!activeSlug,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeSurface(activeSlug, id),
    onSuccess: () => {
      toast.success("Surface revoked - URL is now 404");
      void qc.invalidateQueries({ queryKey: ["surfaces", activeSlug] });
    },
  });

  const items = list.data?.items ?? [];

  return (
    <div className="space-y-4">
      <ConfigHeaderActions>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} active
        </span>
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> Publish
        </button>
      </ConfigHeaderActions>

      <p className="text-sm text-muted dark:text-slate-400">
        Share a saved view's data over a long-random URL - no account
        required to view. Cross-module readers go through{" "}
        <code className="font-mono">exposableFields</code> projection
        so private fields stay private.
      </p>

      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm text-muted dark:text-slate-400 italic">
          No public surfaces. Hit Publish to share a view.
        </div>
      )}

      <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
        {items.map((s) => (
          <li key={s.id} className="px-3 py-2 text-sm space-y-1">
            <div className="flex items-baseline gap-2">
              <Globe size={14} className="text-faint" />
              <span className="font-medium">{s.name}</span>
              <span className="text-xs text-muted dark:text-slate-400">
                {s.scope_type}
              </span>
              {!s.enabled && (
                <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                  paused
                </span>
              )}
              {s.expires_at && (
                <span
                  className="text-[10px] font-mono text-faint"
                  title={new Date(s.expires_at).toLocaleString()}
                >
                  expires {new Date(s.expires_at).toLocaleDateString()}
                </span>
              )}
              <div className="flex-1" />
              <button
                onClick={() => setEditFor(s)}
                className="text-faint hover:text-accent transition"
                title="Edit"
              >
                <Pencil size={14} />
              </button>
              <a
                href={`/p/${s.token}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-faint hover:text-accent transition"
                title="Open public page"
              >
                <ExternalLink size={14} />
              </a>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(
                    `${window.location.origin}/p/${s.token}`,
                  );
                  toast.success("Public URL copied");
                }}
                className="text-faint hover:text-accent transition"
                title="Copy public URL"
              >
                <Copy size={14} />
              </button>
              <button
                onClick={() => setStatsFor(s)}
                className="text-faint hover:text-accent transition"
                title="View stats"
              >
                <BarChart3 size={14} />
              </button>
              <button
                onClick={async () => {
                  const ok = await confirm({
                    title: "Revoke this surface?",
                    message: `${s.name} — the public URL will 404 immediately.`,
                    confirmLabel: "Revoke",
                    destructive: true,
                  });
                  if (ok) revoke.mutate(s.id);
                }}
                className="text-faint hover:text-ember-500 transition"
                title="Revoke"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="font-mono text-xs text-muted dark:text-slate-400 truncate">
              /p/{s.token}
            </div>
          </li>
        ))}
      </ul>

      {createOpen && (
        <CreateSurfaceModal
          slug={activeSlug}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ["surfaces", activeSlug] });
            setCreateOpen(false);
          }}
        />
      )}
      {statsFor && (
        <SurfaceStatsModal
          slug={activeSlug}
          surface={statsFor}
          onClose={() => setStatsFor(null)}
        />
      )}
      {editFor && (
        <EditSurfaceModal
          slug={activeSlug}
          surface={editFor}
          onClose={() => setEditFor(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["surfaces", activeSlug] });
            setEditFor(null);
          }}
        />
      )}
    </div>
  );
}

// datetime-local <-> ISO helpers. The input wants "YYYY-MM-DDTHH:mm"
// in local time; the API wants ISO-8601 (or null to clear the expiry).
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function EditSurfaceModal({
  slug,
  surface,
  onClose,
  onSaved,
}: {
  slug: string;
  surface: SurfaceRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(surface.name);
  const [enabled, setEnabled] = useState(surface.enabled);
  const [expiresInput, setExpiresInput] = useState(
    isoToLocalInput(surface.expires_at),
  );
  const cfg = surface.config as {
    theme?: "auto" | "dark" | "light";
    layout?: "tiles" | "list";
    footer?: string;
    refresh_seconds?: number;
    epaper?: boolean;
  };
  const [theme, setTheme] = useState<"auto" | "dark" | "light">(
    cfg.theme ?? "auto",
  );
  const [layout, setLayout] = useState<"tiles" | "list">(cfg.layout ?? "tiles");
  const [footer, setFooter] = useState(cfg.footer ?? "");
  const [refresh, setRefresh] = useState<number>(cfg.refresh_seconds ?? 60);
  const [epaper, setEpaper] = useState<boolean>(cfg.epaper ?? false);
  // The "E-paper" preset: reflective panels want light + no auto-refresh (no
  // ghosting on a timer). One click sets all three; each stays editable.
  function applyEpaper(on: boolean) {
    setEpaper(on);
    if (on) {
      setTheme("light");
      setRefresh(0);
    }
  }

  const save = useMutation({
    mutationFn: () => {
      // Preserve any config keys we don't edit here (e.g. a collection's
      // `query`); only overwrite the theming knobs this form owns.
      const config: Record<string, unknown> = {
        ...(surface.config as Record<string, unknown>),
      };
      if (theme === "auto") delete config.theme;
      else config.theme = theme;
      if (layout === "tiles") delete config.layout;
      else config.layout = layout;
      if (footer.trim()) config.footer = footer.trim();
      else delete config.footer;
      if (refresh !== 60) config.refresh_seconds = refresh;
      else delete config.refresh_seconds;
      if (epaper) config.epaper = true;
      else delete config.epaper;
      return api.updateSurface(slug, surface.id, {
        name: name.trim(),
        enabled,
        expires_at: expiresInput ? new Date(expiresInput).toISOString() : null,
        config,
      });
    },
    onSuccess: () => {
      toast.success("Surface updated");
      onSaved();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't save"),
  });

  return (
    <Modal open onClose={onClose} title={`Edit — ${surface.name}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
        className="space-y-3"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">Name (internal)</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
        </label>

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            data-testid="surface-enabled"
          />
          <span className="text-sm text-content dark:text-mortar-100">
            Enabled
          </span>
          <span className="text-xs text-faint">
             - uncheck to pause (URL stays valid, 404s while paused)
          </span>
        </label>

        <label className="block">
          <div className="text-xs text-muted mb-1">
            Expires (optional - blank = never)
          </div>
          <div className="flex items-center gap-2">
            <input
              type="datetime-local"
              value={expiresInput}
              onChange={(e) => setExpiresInput(e.target.value)}
              className="px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              data-testid="surface-expires"
            />
            {expiresInput && (
              <button
                type="button"
                onClick={() => setExpiresInput("")}
                className="text-xs text-muted hover:text-ember-500"
              >
                clear
              </button>
            )}
          </div>
        </label>

        <div className="border-t border-line dark:border-slate-700 pt-3 space-y-3">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted">
            theming
          </div>
          <label className="block">
            <div className="text-xs text-muted mb-1">Theme</div>
            <div className="flex gap-1">
              {(["auto", "light", "dark"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTheme(t)}
                  className={`flex-1 px-3 py-1 text-xs rounded transition ${
                    theme === t
                      ? "bg-cobble-600 text-white"
                      : "bg-subtle dark:bg-slate-800 text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-700"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Default layout</div>
            <div className="flex gap-1">
              {(["tiles", "list"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setLayout(t)}
                  className={`flex-1 px-3 py-1 text-xs rounded transition ${
                    layout === t
                      ? "bg-cobble-600 text-white"
                      : "bg-subtle dark:bg-slate-800 text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-700"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Footer text</div>
            <input
              type="text"
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Auto-refresh</div>
            <select
              value={refresh}
              onChange={(e) => setRefresh(Number(e.target.value))}
              className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            >
              <option value={0}>Off - static (e-paper)</option>
              <option value={30}>Every 30 seconds</option>
              <option value={60}>Every minute</option>
              <option value={300}>Every 5 minutes</option>
              <option value={900}>Every 15 minutes</option>
              <option value={3600}>Every hour</option>
            </select>
          </label>
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={epaper}
              onChange={(e) => applyEpaper(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm text-content dark:text-mortar-100">E-paper mode</span>
              <span className="block text-xs text-faint">
                Light (black-on-white) palette + auto-refresh off - for a reflective panel
                in a cabinet that shouldn't ghost on a timer.
              </span>
            </span>
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || save.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
            data-testid="surface-save"
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SurfaceStatsModal({
  slug,
  surface,
  onClose,
}: {
  slug: string;
  surface: SurfaceRecord;
  onClose: () => void;
}) {
  const stats = useQuery({
    queryKey: ["surface-stats", slug, surface.id],
    queryFn: () => api.surfaceStats(slug, surface.id),
  });
  const s = stats.data;
  return (
    <Modal open onClose={onClose} title={`Stats — ${surface.name}`} size="lg">
      {stats.isLoading && (
        <div className="text-sm text-muted">Loading…</div>
      )}
      {s && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-3">
            <StatCard label="All-time" value={s.views_total} />
            <StatCard label="Last 24h" value={s.views_24h} />
            <StatCard label="Last 7d" value={s.views_7d} />
            <StatCard label="Last 30d" value={s.views_30d} />
          </div>
          <div className="text-xs text-muted">
            {s.first_viewed ? (
              <>
                First view{" "}
                <span className="font-mono">
                  {new Date(s.first_viewed).toLocaleString()}
                </span>{" "}
                · last{" "}
                <span className="font-mono">
                  {s.last_viewed ? new Date(s.last_viewed).toLocaleString() : "—"}
                </span>
              </>
            ) : (
              "No views yet."
            )}
          </div>
          {s.recent.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-content dark:text-slate-300 mb-1">
                Recent hits ({s.recent.length})
              </h3>
              <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800 max-h-72 overflow-y-auto">
                {s.recent.map((r, i) => (
                  <li key={i} className="px-3 py-1.5 text-xs flex items-baseline gap-3">
                    <span className="font-mono text-muted shrink-0">
                      {new Date(r.viewed_at).toLocaleString()}
                    </span>
                    {r.referer && (
                      <span className="truncate text-content dark:text-slate-300">
                        ← {hostname(r.referer)}
                      </span>
                    )}
                    {!r.referer && r.ua_hint && (
                      <span className="truncate text-faint italic">
                        {browserName(r.ua_hint)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-line dark:border-slate-700 rounded p-3">
      <div className="text-[10px] uppercase font-mono text-muted tracking-wider">
        {label}
      </div>
      <div className="text-2xl font-semibold text-content dark:text-mortar-100 mt-0.5">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function hostname(referer: string): string {
  try {
    return new URL(referer).hostname;
  } catch {
    return referer;
  }
}

function browserName(ua: string): string {
  if (/firefox/i.test(ua)) return "Firefox";
  if (/edg/i.test(ua)) return "Edge";
  if (/chrome/i.test(ua)) return "Chrome";
  if (/safari/i.test(ua)) return "Safari";
  if (/curl/i.test(ua)) return "curl";
  return ua.slice(0, 32);
}

function CreateSurfaceModal({
  slug,
  onClose,
  onCreated,
}: {
  slug: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [scopeType, setScopeType] = useState<"view" | "collection" | "app">("view");
  const [viewId, setViewId] = useState("");
  const [appSlug, setAppSlug] = useState("");
  const [collectionKind, setCollectionKind] = useState("inventory:part");
  const [collectionFilterRaw, setCollectionFilterRaw] = useState("");
  const [theme, setTheme] = useState<"auto" | "dark" | "light">("auto");
  const [layout, setLayout] = useState<"tiles" | "list">("tiles");
  const [footer, setFooter] = useState("");
  const toast = useToast();

  const views = useQuery({
    queryKey: ["saved-views", slug],
    queryFn: () => api.listSavedViews(slug),
    enabled: !!slug,
  });
  const entityKinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug && scopeType === "collection",
  });
  const apps = useQuery({
    queryKey: ["apps", slug],
    queryFn: () => api.listApps(slug),
    enabled: !!slug && scopeType === "app",
  });

  const items: SavedView[] = views.data?.items ?? [];
  const kindList = entityKinds.data?.items ?? [];
  const appList = apps.data?.items ?? [];

  const canSubmit =
    name.trim() !== "" &&
    (scopeType === "view" ? !!viewId : scopeType === "app" ? !!appSlug : !!collectionKind);

  return (
    <Modal open onClose={onClose} title="Publish a public surface">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!canSubmit) return;
          let filter: Record<string, string> | undefined;
          if (scopeType === "collection" && collectionFilterRaw.trim()) {
            filter = {};
            for (const piece of collectionFilterRaw.split(",")) {
              const [k, v] = piece.split("=").map((s) => s.trim());
              if (k && v) filter[k] = v;
            }
            if (Object.keys(filter).length === 0) filter = undefined;
          }
          // Build the config blob: per-surface theming (read by /p/:token)
          // + ad-hoc query (when scope_type=collection).
          const config: Record<string, unknown> = {};
          if (theme !== "auto") config.theme = theme;
          if (layout !== "tiles") config.layout = layout;
          if (footer.trim()) config.footer = footer.trim();
          if (scopeType === "collection") {
            config.query = filter ? { filter } : {};
          }
          try {
            const created = await api.createSurface(slug, {
              name: name.trim(),
              scope_type: scopeType,
              scope_id:
                scopeType === "view"
                  ? viewId
                  : scopeType === "app"
                    ? appSlug
                    : collectionKind,
              config: Object.keys(config).length > 0 ? config : undefined,
            });
            toast.success("Published");
            void navigator.clipboard.writeText(
              `${window.location.origin}/p/${created.token}`,
            );
            toast.info("Public URL copied to clipboard");
            onCreated();
          } catch (err) {
            const msg = err instanceof ApiError ? err.message : String(err);
            toast.error(msg);
          }
        }}
        className="space-y-3"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">Name (internal)</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sarah's collection (public)"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Source</div>
          <div className="flex gap-1">
            {(["view", "collection", "app"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setScopeType(t)}
                className={`flex-1 px-3 py-1.5 text-xs rounded transition ${
                  scopeType === t
                    ? "bg-cobble-600 text-white"
                    : "bg-subtle dark:bg-slate-800 text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-700"
                }`}
              >
                {t === "view" ? "Saved view" : t === "collection" ? "Ad-hoc collection" : "App"}
              </button>
            ))}
          </div>
        </label>
        {scopeType === "view" && (
          <>
            <label className="block">
              <div className="text-xs text-muted mb-1">View to publish</div>
              <select
                value={viewId}
                onChange={(e) => setViewId(e.target.value)}
                className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              >
                <option value=""> - pick a saved view - </option>
                {items.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.entity_kind})
                  </option>
                ))}
              </select>
            </label>
            {items.length === 0 && (
              <p className="text-xs text-muted italic">
                No saved views yet - create one from the Views page or
                switch to "Ad-hoc collection" above.
              </p>
            )}
          </>
        )}
        {scopeType === "collection" && (
          <>
            <label className="block">
              <div className="text-xs text-muted mb-1">Entity kind</div>
              <select
                value={collectionKind}
                onChange={(e) => setCollectionKind(e.target.value)}
                className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              >
                {kindList.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.display_name} ({k.id})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <div className="text-xs text-muted mb-1">
                Filter (comma-separated <code>field=value</code>, optional)
              </div>
              <input
                type="text"
                value={collectionFilterRaw}
                onChange={(e) => setCollectionFilterRaw(e.target.value)}
                placeholder="state=active, location_id=…, _tag=urgent"
                className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
              <div className="text-[11px] text-faint mt-1">
                Native columns + metadata fields + <code>_tag</code> are
                supported (resolver-dependent). Blank = list every entity
                of this kind.
              </div>
            </label>
          </>
        )}
        {scopeType === "app" && (
          <>
            <label className="block">
              <div className="text-xs text-muted mb-1">App to publish</div>
              <select
                value={appSlug}
                onChange={(e) => setAppSlug(e.target.value)}
                className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              >
                <option value=""> - pick an app - </option>
                {appList.map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[11px] text-faint">
              Renders the whole app read-only, no login: markdown, stat tiles,
              views, and custom blocks. Write blocks (forms, action buttons,
              scan) are dropped, and the app's own theme is used.
            </p>
          </>
        )}
        <div className="border-t border-line dark:border-slate-700 pt-3 space-y-3">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted">
            theming (optional)
          </div>
          <label className="block">
            <div className="text-xs text-muted mb-1">Theme</div>
            <div className="flex gap-1">
              {(["auto", "light", "dark"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTheme(t)}
                  className={`flex-1 px-3 py-1 text-xs rounded transition ${
                    theme === t
                      ? "bg-cobble-600 text-white"
                      : "bg-subtle dark:bg-slate-800 text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-700"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Default layout</div>
            <div className="flex gap-1">
              {(["tiles", "list"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setLayout(t)}
                  className={`flex-1 px-3 py-1 text-xs rounded transition ${
                    layout === t
                      ? "bg-cobble-600 text-white"
                      : "bg-subtle dark:bg-slate-800 text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-700"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Footer text (optional)</div>
            <input
              type="text"
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="© 2026 your name · contact: hi@you.com"
              className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            Publish
          </button>
        </div>
      </form>
    </Modal>
  );
}
