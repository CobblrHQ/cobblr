// Public, un-authenticated read of a workspace surface. Token-only:
// the URL path /p/:token is the access. Renders the JSON payload
// from /api/v1/public/:token as a TV-friendly gallery / list — same
// surface a builder publishes from /configuration/surfaces.
//
// Three scope-types map to three renderers:
//   entity     → one big detail card (image + title + subtitle)
//   view       → grid / list of items from the saved view
//   collection → grid / list of items from the ad-hoc query
//
// No login required, no chrome from AppLayout, no workspace
// switcher. Designed to look fine on a TV mounted in the workshop
// or pinned tab on the lego-collector's wiki.
//
// Defaults to tile rendering since the public consumer is typically
// looking AT things; list is available via the ?view=list query.

import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { CobblestoneMark } from "../CobblestoneMark";
import { EntityTile, EntityThumb, usePageTitle } from "@cobblr/platform-web";
import {
  PublicAppPlayer,
  type PublicAppPayload,
  type PublicAppData,
} from "../components/PublicAppPlayer";

interface SurfaceItem {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  image_path?: string;
  fields?: Record<string, unknown>;
}

interface SurfaceSection {
  title: string;
  entity_kind: string;
  view_type: string;
  items: SurfaceItem[];
}

interface SurfaceResponse {
  surface: {
    name: string;
    scope_type: "view" | "entity" | "collection" | "board" | "app";
    config: Record<string, unknown>;
  };
  view?: { name: string; entity_kind: string; view_type: string };
  collection?: { kind: string; query: Record<string, unknown> };
  entity?: SurfaceItem | null;
  items?: SurfaceItem[];
  sections?: SurfaceSection[];
  app?: PublicAppPayload;
  data?: PublicAppData;
}

interface SurfaceTheme {
  /** "dark" / "light" / "auto" (default). When "dark" the whole
   *  page renders with the dark palette regardless of OS preference;
   *  "light" forces light. */
  theme?: "dark" | "light" | "auto";
  /** "tiles" (default) / "list" — overrides the ?view URL param
   *  when set so the publisher's choice wins. */
  layout?: "tiles" | "list";
  /** Optional cover banner image — large, sits above the title. */
  banner_image?: string;
  /** Optional footer text — copyright / "powered by" / etc. */
  footer?: string;
  /** Auto-refresh cadence in seconds. Default 60. 0 = never re-fetch — for a
   *  static panel (e-paper) that shouldn't flicker/ghost on a timer. */
  refresh_seconds?: number;
  /** E-paper mode: forces a light, high-contrast palette (reflective panels
   *  need black-on-white) regardless of theme — for view/board surfaces here
   *  AND app surfaces (passed to the App Player). Pairs with refresh_seconds=0
   *  via the editor's "E-paper" preset. */
  epaper?: boolean;
}

export function PublicSurfacePage() {
  usePageTitle("Public surface");
  const { token } = useParams<{ token: string }>();
  const [params] = useSearchParams();

  const surface = useQuery({
    queryKey: ["public-surface", token],
    queryFn: async (): Promise<SurfaceResponse> => {
      const res = await fetch(`/api/v1/public/${token}`);
      if (res.status === 404) throw new Error("not_found");
      if (res.status === 410) throw new Error("expired");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as SurfaceResponse;
    },
    enabled: !!token,
    retry: false,
    // Re-fetch so a wall-mounted screen picks up new items without anyone
    // touching the page. Cadence is per-surface (config.refresh_seconds,
    // default 60); 0 = never — for a static e-paper panel that mustn't ghost on
    // a timer. Function form so it reads the just-fetched config.
    refetchInterval: (query) => {
      const cfg = (query.state.data?.surface.config ?? {}) as SurfaceTheme;
      const secs = cfg.refresh_seconds ?? 60;
      return secs <= 0 ? false : secs * 1000;
    },
  });

  const rawTheme = (surface.data?.surface.config as SurfaceTheme | undefined) ?? {};
  // E-paper forces the light palette (reflective panels need black-on-white).
  const theme: SurfaceTheme = rawTheme.epaper ? { ...rawTheme, theme: "light" } : rawTheme;
  // Theme.layout (publisher's choice) > ?view= (visitor's choice) > tiles.
  const layout: "list" | "tiles" =
    theme.layout ?? (params.get("view") === "list" ? "list" : "tiles");

  if (surface.isLoading) {
    return <PublicShell theme={theme}>Loading…</PublicShell>;
  }
  if (surface.error) {
    const e = (surface.error as Error).message;
    return (
      <PublicShell theme={theme}>
        <div className="text-center py-12">
          <h1 className="font-display text-3xl font-extrabold text-content dark:text-mortar-100 page-title mb-2">
            {e === "not_found"
              ? "not found"
              : e === "expired"
                ? "expired"
                : "error"}
          </h1>
          <p className="text-sm text-muted dark:text-slate-400">
            {e === "not_found"
              ? "this surface doesn't exist or has been revoked."
              : e === "expired"
                ? "this surface's token has expired."
                : `${e} — try refreshing.`}
          </p>
        </div>
      </PublicShell>
    );
  }
  const data = surface.data;
  if (!data) return <PublicShell theme={theme}>—</PublicShell>;

  // scope_type "app" renders a full-bleed, themed, read-only App Player —
  // its own header/theme, no PublicShell chrome.
  if (data.surface.scope_type === "app" && data.app && data.data) {
    return <PublicAppPlayer app={data.app} data={data.data} epaper={!!rawTheme.epaper} />;
  }

  return (
    <PublicShell title={data.surface.name} theme={theme}>
      {theme.banner_image && (
        <div className="aspect-[3/1] rounded-xl overflow-hidden mb-6 bg-subtle dark:bg-slate-800">
          <img
            src={theme.banner_image}
            alt={data.surface.name}
            className="w-full h-full object-cover"
          />
        </div>
      )}
      {data.surface.scope_type === "entity" && data.entity && (
        <EntityCard item={data.entity} />
      )}
      {data.surface.scope_type === "board" && (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {(data.sections ?? []).map((section, i) => (
            <div key={`${section.title}-${i}`}>
              <header className="mb-3 flex items-baseline gap-2 border-b border-line dark:border-slate-700 pb-2">
                <h2 className="font-display text-lg font-extrabold text-content dark:text-mortar-100 page-title">
                  {section.title}
                </h2>
                <span className="text-xs text-faint">{section.items.length}</span>
              </header>
              <ListGrid items={section.items} />
            </div>
          ))}
          {(data.sections ?? []).length === 0 && (
            <div className="text-sm text-muted italic py-12 text-center sm:col-span-2 lg:col-span-3">
              nothing here yet.
            </div>
          )}
        </div>
      )}
      {(data.surface.scope_type === "view" ||
        data.surface.scope_type === "collection") && (
        <>
          <header className="mb-4 flex items-baseline gap-3">
            <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
              {data.view?.entity_kind ?? data.collection?.kind ?? "items"}
            </span>
            <span className="text-xs text-faint">
              {(data.items ?? []).length} items
            </span>
          </header>
          {layout === "tiles" ? (
            <TileGrid items={data.items ?? []} />
          ) : (
            <ListGrid items={data.items ?? []} />
          )}
        </>
      )}
      {theme.footer && (
        <footer className="mt-12 pt-6 border-t border-line dark:border-slate-700 text-center text-xs text-faint">
          {theme.footer}
        </footer>
      )}
    </PublicShell>
  );
}

function PublicShell({
  title,
  children,
  theme,
}: {
  title?: string;
  children: React.ReactNode;
  theme?: SurfaceTheme;
}) {
  // Honor explicit theme override; otherwise let the OS preference
  // win via Tailwind's dark: variants.
  const themeClass =
    theme?.theme === "dark"
      ? "dark"
      : theme?.theme === "light"
        ? "light"
        : "";
  return (
    <div className={`min-h-screen bg-subtle dark:bg-slate-950 text-content dark:text-mortar-100 ${themeClass}`}>
      <header className="border-b border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center gap-3">
          <CobblestoneMark size={26} />
          <span className="font-display font-extrabold text-content dark:text-mortar-100">
            Cobblr
          </span>
          {title && (
            <>
              <span className="text-faint dark:text-slate-600">/</span>
              <span className="text-content dark:text-mortar-100 truncate">
                {title}
              </span>
            </>
          )}
          <div className="flex-1" />
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
            public · read-only
          </span>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}

function TileGrid({ items }: { items: SurfaceItem[] }) {
  if (items.length === 0) {
    return (
      <div className="text-sm text-muted italic py-12 text-center">
        nothing here yet.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
      {items.map((i) => (
        <EntityTile
          key={`${i.kind}:${i.id}`}
          src={i.image_path}
          title={i.title}
          subtitle={i.subtitle ?? null}
        />
      ))}
    </div>
  );
}

function ListGrid({ items }: { items: SurfaceItem[] }) {
  if (items.length === 0) {
    return (
      <div className="text-sm text-muted italic py-12 text-center">
        nothing here yet.
      </div>
    );
  }
  return (
    <ul className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-800">
      {items.map((i) => (
        <li
          key={`${i.kind}:${i.id}`}
          className="px-4 py-3 flex items-center gap-3"
        >
          <EntityThumb src={i.image_path} alt={i.title} size={48} />
          <div className="min-w-0">
            <div className="font-medium text-content dark:text-mortar-100 truncate">
              {i.title}
            </div>
            {i.subtitle && (
              <div className="text-xs text-muted truncate">{i.subtitle}</div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function EntityCard({ item }: { item: SurfaceItem }) {
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden max-w-3xl mx-auto">
      <div className="aspect-video bg-subtle dark:bg-slate-800 flex items-center justify-center">
        {item.image_path ? (
          <EntityThumb src={item.image_path} alt={item.title} size={512} className="!w-full !h-full" />
        ) : (
          <span className="text-6xl font-mono text-faint">
            {item.title.slice(0, 1).toUpperCase()}
          </span>
        )}
      </div>
      <div className="p-6">
        <h2 className="text-2xl font-display font-extrabold text-content dark:text-mortar-100 page-title">
          {item.title}
        </h2>
        {item.subtitle && (
          <div className="text-sm text-muted mt-1">{item.subtitle}</div>
        )}
      </div>
    </div>
  );
}
