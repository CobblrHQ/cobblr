// /configuration/catalogs/match?source_kind=...&source_id=...
//
// The destination for the `core-catalogs:match-to-catalog` action's
// invokeRoute. Lists installed catalogs in the left column; selected
// catalog's entries (with fuzzy-search) in the right column. Picking
// an entry writes a pairing with relationship_kind='matches' and
// navigates back.

import { useState, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Library, ArrowLeft } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { ApiError, api, type CatalogEntry, type Catalog } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function CatalogMatchPage() {
  const { activeSlug } = useActiveOrg();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const sourceKind = params.get("source_kind") ?? "";
  const sourceId = params.get("source_id") ?? "";

  const catalogsQ = useQuery({
    queryKey: ["core-catalogs", activeSlug],
    queryFn: () => api.listCatalogs(activeSlug),
    enabled: !!activeSlug,
  });
  const catalogs: Catalog[] = catalogsQ.data?.items ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && catalogs.length > 0) setSelectedId(catalogs[0]!.id);
  }, [catalogs, selectedId]);

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const entriesQ = useQuery({
    queryKey: ["core-catalog-entries", activeSlug, selectedId, debounced],
    queryFn: () =>
      api.listCatalogEntries(activeSlug, selectedId!, {
        q: debounced || undefined,
        limit: 50,
      }),
    enabled: !!selectedId,
  });
  const entries: CatalogEntry[] = entriesQ.data?.items ?? [];
  const titleColumn = entriesQ.data?.title_column ?? "name";

  const selectedCatalog = useMemo(
    () => catalogs.find((c) => c.id === selectedId) ?? null,
    [catalogs, selectedId],
  );

  const matchMut = useMutation({
    mutationFn: (entry: CatalogEntry) =>
      api.request("POST", `/orgs/${activeSlug}/pairings`, {
        source_kind: sourceKind,
        source_id: sourceId,
        target_kind: "core-catalogs:entry",
        target_id: entry.id,
        relationship_kind: "matches",
      }),
    onSuccess: () => {
      toast.success("Match created.");
      void qc.invalidateQueries({ queryKey: ["pairings"] });
      // Navigate back to the originating entity's detail page if its
      // kind has a detailRoute we can interpolate; else /configuration.
      void resolveBackRoute(activeSlug, sourceKind, sourceId).then((r) => {
        navigate(r);
      });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : String(err));
    },
  });

  if (!sourceKind || !sourceId) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100">
          Match to catalog
        </h1>
        <p className="text-sm text-ember-500">
          Missing <code>source_kind</code> / <code>source_id</code> query
          params. This page expects to be opened by clicking the "Match to
          catalog" action on an entity's detail page.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-[10px] font-mono uppercase tracking-widest text-slate-400 hover:text-cobble-500 transition inline-flex items-center gap-1"
        >
          <ArrowLeft size={10} /> back
        </button>
      </div>
      <div className="border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100">
          Match to catalog
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-1">
          {sourceKind} · {sourceId}
        </p>
      </div>

      {catalogs.length === 0 && (
        <div className="text-sm italic text-slate-500 dark:text-slate-400">
          No catalogs installed yet. Add one at{" "}
          <button
            onClick={() => navigate("/configuration/catalogs")}
            className="text-cobble-600 hover:underline"
          >
            /configuration/catalogs
          </button>
          .
        </div>
      )}

      {catalogs.length > 0 && (
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-3 space-y-1">
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Catalogs
            </div>
            {catalogs.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={
                  "w-full text-left rounded border px-2 py-1.5 text-sm transition " +
                  (selectedId === c.id
                    ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-900/30 text-cobble-700 dark:text-cobble-200"
                    : "border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-mortar-100")
                }
              >
                <div className="flex items-center gap-2">
                  <Library size={12} />
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="text-[10px] font-mono text-slate-400">
                    {c.entry_count}
                  </span>
                </div>
              </button>
            ))}
          </div>
          <div className="col-span-9 space-y-2">
            {selectedCatalog && (
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${selectedCatalog.name} by ${titleColumn}…`}
                className="w-full px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
                autoFocus
              />
            )}
            {entriesQ.isLoading && (
              <div className="text-sm text-slate-500">Loading…</div>
            )}
            {entries.length === 0 && !entriesQ.isLoading && debounced && (
              <div className="text-sm italic text-slate-500 dark:text-slate-400">
                No entries match "{debounced}".
              </div>
            )}
            {entries.length === 0 &&
              !entriesQ.isLoading &&
              !debounced &&
              selectedCatalog?.entry_count === 0 && (
                <div className="text-sm italic text-slate-500 dark:text-slate-400">
                  This catalog has no entries yet. Import a CSV at{" "}
                  <button
                    onClick={() => navigate(`/configuration/catalogs/${selectedId}`)}
                    className="text-cobble-600 hover:underline"
                  >
                    its detail page
                  </button>
                  .
                </div>
              )}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
              {entries.map((entry) => {
                const imageCol = String(selectedCatalog?.schema?.image_column ?? "image_url");
                const title = String(entry.payload[titleColumn] ?? entry.external_id);
                const image =
                  imageCol && typeof entry.payload[imageCol] === "string"
                    ? (entry.payload[imageCol] as string)
                    : null;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={matchMut.isPending}
                    onClick={() => matchMut.mutate(entry)}
                    className="text-left rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 hover:border-cobble-400 dark:hover:border-cobble-700 transition flex gap-2 disabled:opacity-50"
                  >
                    {image && (
                      <img
                        src={image}
                        alt={title}
                        className="w-12 h-12 rounded object-cover border border-slate-200 dark:border-slate-700 shrink-0"
                        loading="lazy"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-700 dark:text-mortar-100 truncate">
                        {title}
                      </div>
                      <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 truncate">
                        #{entry.external_id}
                      </div>
                    </div>
                    <Check
                      size={14}
                      className="text-cobble-500 opacity-0 group-hover:opacity-100 shrink-0"
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Best-effort: look up the source kind in /entity-kinds and use its
// detail_route to send the user back. Fall back to /configuration.
async function resolveBackRoute(
  slug: string,
  kind: string,
  id: string,
): Promise<string> {
  try {
    const { items } = await api.listEntityKinds(slug);
    const ent = items.find((k) => k.id === kind);
    if (ent?.detail_route) return ent.detail_route.replace("{id}", id);
  } catch {
    /* fall through */
  }
  return "/configuration";
}
