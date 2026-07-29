// /configuration/catalogs — list of imported reference datasets +
// "+ New catalog" affordance. Clicking a row opens the detail page.

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Library, Plus, Trash2 } from "lucide-react";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api, type Catalog } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function CatalogsPage() {
  usePageTitle("Catalogs");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: ["core-catalogs", activeSlug],
    queryFn: () => api.listCatalogs(activeSlug),
    enabled: !!activeSlug,
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteCatalog(activeSlug, id),
    onSuccess: () => {
      toast.success("Catalog deleted");
      void qc.invalidateQueries({ queryKey: ["core-catalogs", activeSlug] });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : String(err));
    },
  });

  const items = list.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">
          Catalogs
        </h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} {items.length === 1 ? "catalog" : "catalogs"}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> New catalog
        </button>
      </div>

      <p className="text-sm text-content dark:text-mortar-200">
        Reference datasets your entities match against. Rebrickable's Lego
        catalog comes with the Lego setup; bring your own as a CSV - any table
        with a stable id and a name (a parts list, a product export, a
        collection inventory). Your own entities (parts, machines, assets) can
        <em>match</em> a row in a catalog; once matched, the catalog's photo +
        metadata is shown alongside your entity.
      </p>

      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm italic text-muted dark:text-slate-400">
          No catalogs yet. Click "New catalog" to start one - give it a name,
          then upload a CSV.
        </div>
      )}

      <div className="space-y-2">
        {items.map((c) => (
          <CatalogCard
            key={c.id}
            catalog={c}
            onDelete={async () => {
              const ok = await confirm({
                title: "Delete catalog?",
                message:
                  c.source === "hosted"
                    ? `${c.name} will be removed from this workspace (its data stays in Cobblr's shared catalog). Existing matches from your entities to it will become dangling.`
                    : `${c.name} and all ${c.entry_count} entries will be removed. Existing matches from your entities to entries in this catalog will become dangling.`,
                confirmLabel: "Delete",
                destructive: true,
              });
              if (ok) del.mutate(c.id);
            }}
          />
        ))}
      </div>

      {createOpen && (
        <CreateCatalogModal
          slug={activeSlug}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ["core-catalogs", activeSlug] });
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}

function CatalogCard({
  catalog,
  onDelete,
}: {
  catalog: Catalog;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
      <div className="px-4 py-3 bg-subtle dark:bg-slate-800/50 border-b border-line dark:border-slate-700 flex items-center gap-3">
        <Library size={18} className="text-accent shrink-0" />
        <Link
          to={`/configuration/catalogs/${catalog.id}`}
          className="flex-1 min-w-0 hover:text-accent transition"
        >
          <div className="font-medium text-content dark:text-mortar-100 truncate">
            {catalog.name}
          </div>
          {catalog.description && (
            <div className="text-xs text-muted dark:text-slate-400 truncate">
              {catalog.description}
            </div>
          )}
        </Link>
        {catalog.source === "hosted" ? (
          // Hosted catalogs keep their rows in Cobblr's shared reference-catalog
          // service, so the local entry_count is 0 by design — showing "0
          // entries" reads as broken. Say "Hosted" instead: it's ready to match
          // against, nothing to import.
          <span
            title="Served from Cobblr's shared reference catalog - ready to match against, nothing to import."
            className="text-[10px] font-mono uppercase tracking-widest text-accent dark:text-cobble-400 rounded bg-accent/10 dark:bg-cobble-400/10 px-1.5 py-0.5"
          >
            Hosted
          </span>
        ) : (
          <span className="text-[10px] font-mono text-accent dark:text-cobble-400">
            {catalog.entry_count} {catalog.entry_count === 1 ? "entry" : "entries"}
          </span>
        )}
        {catalog.puller_id && (
          <span className="text-[10px] uppercase font-mono tracking-widest text-faint dark:text-slate-500">
            {catalog.puller_id}
          </span>
        )}
        <button
          type="button"
          onClick={onDelete}
          title="Delete catalog"
          className="text-faint hover:text-ember-500 transition p-1"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

function CreateCatalogModal({
  slug,
  onClose,
  onCreated,
}: {
  slug: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const toast = useToast();

  return (
    <Modal open onClose={onClose} title="New catalog">
      <form
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          if (!name.trim()) return;
          try {
            await api.createCatalog(slug, {
              name: name.trim(),
              description: description.trim() || null,
              source_url: sourceUrl.trim() || null,
            });
            toast.success("Catalog created");
            onCreated();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : String(err));
          }
        }}
        className="space-y-3"
      >
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Rebrickable parts"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Description (optional)
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Source URL (optional)
          </span>
          <input
            type="url"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://rebrickable.com/downloads/"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
          <div className="text-[10px] text-muted mt-1">
            Just for your reference. The actual import is the CSV upload on
            the detail page.
          </div>
        </label>
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
            disabled={!name.trim()}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
