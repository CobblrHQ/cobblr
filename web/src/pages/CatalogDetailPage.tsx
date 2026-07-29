// /configuration/catalogs/:id — one catalog's detail page.
// Shows schema, lets the user upload a CSV, browse entries with
// fuzzy search.

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Library, Upload } from "lucide-react";
import { BackToTop, Modal, useToast, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api, type CatalogEntry, type CatalogSchema } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { CatalogFieldValue, NoImage } from "../components/CatalogFieldValue";

export function CatalogDetailPage() {
  const { activeSlug } = useActiveOrg();
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  // Tiny debounce so we don't query on every keystroke.
  useMemo(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const catalogQ = useQuery({
    queryKey: ["core-catalog", activeSlug, id],
    queryFn: () => api.getCatalog(activeSlug, id!),
    enabled: !!activeSlug && !!id,
  });
  const toast = useToast();
  // The built-in puller: one-tap import from the catalog's source_url (a
  // bundle-shipped shell, e.g. Rebrickable), instead of hand-running a script.
  const pullMut = useMutation({
    mutationFn: () => api.pullCatalog(activeSlug, id!),
    onSuccess: (r) => {
      toast.success(`Imported ${r.imported.toLocaleString()} entries from source.`);
      void qc.invalidateQueries({ queryKey: ["core-catalog", activeSlug, id] });
      void qc.invalidateQueries({ queryKey: ["core-catalog-entries", activeSlug, id] });
    },
    onError: () =>
      toast.error("Couldn't pull from the source - check the catalog's source URL (large datasets like the BOM use the bulk seeder)."),
  });
  const PAGE_SIZE = 60;
  const entriesQ = useInfiniteQuery({
    queryKey: ["core-catalog-entries", activeSlug, id, debounced],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.listCatalogEntries(activeSlug, id!, {
        q: debounced || undefined,
        limit: PAGE_SIZE,
        offset: pageParam as number,
      }),
    getNextPageParam: (last, all) => {
      // Server returns at most `limit` items per page. A short
      // page = exhausted.
      if (last.items.length < PAGE_SIZE) return undefined;
      return all.flatMap((p) => p.items).length;
    },
    enabled: !!activeSlug && !!id,
  });

  // IntersectionObserver sentinel — when it enters the viewport,
  // fetch the next page. The observer keeps firing as the user
  // scrolls, but useInfiniteQuery short-circuits if a fetch is
  // already in flight or there's no next page.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && entriesQ.hasNextPage && !entriesQ.isFetchingNextPage) {
          void entriesQ.fetchNextPage();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [entriesQ]);

  // usePageTitle is a hook — it must run before the conditional
  // `return null` below, or the hook order changes when :id appears/
  // disappears between renders and React crashes the page.
  usePageTitle(catalogQ.data?.name ?? "Catalog");

  if (!id) return null;

  const catalog = catalogQ.data;
  const entries = entriesQ.data?.pages.flatMap((p) => p.items) ?? [];
  const titleCol =
    entriesQ.data?.pages[0]?.title_column ?? "name";

  return (
    <div className="space-y-4">
      <div>
        <Link
          to="/configuration/catalogs"
          className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-accent transition inline-flex items-center gap-1"
        >
          <ArrowLeft size={10} /> back to catalogs
        </Link>
      </div>
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <Library size={20} className="text-accent" />
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">
          {catalog?.name ?? "…"}
        </h1>
        {catalog && (
          <span className="text-sm text-muted dark:text-slate-400">
            {catalog.source === "hosted" ? (
              <span
                title="Served from Cobblr's shared reference catalog - ready to match against, nothing to import."
                className="text-[11px] font-mono uppercase tracking-widest text-accent dark:text-cobble-400 rounded bg-accent/10 dark:bg-cobble-400/10 px-1.5 py-0.5"
              >
                Hosted
              </span>
            ) : (
              `${catalog.entry_count} ${catalog.entry_count === 1 ? "entry" : "entries"}`
            )}
          </span>
        )}
        <div className="flex-1" />
        {/* Hosted catalogs are served centrally — the local import/pull paths
            would create a confusing per-workspace copy, so hide them. */}
        {catalog?.source !== "hosted" && catalog?.source_url && (
          <button
            onClick={() => pullMut.mutate()}
            disabled={pullMut.isPending}
            title={`Pull rows from ${catalog.source_url}`}
            className="inline-flex items-center gap-2 rounded border border-line dark:border-slate-600 hover:bg-subtle dark:hover:bg-slate-800 text-content dark:text-mortar-100 px-3 py-1.5 text-sm transition disabled:opacity-50"
          >
            <Download size={14} /> {pullMut.isPending ? "Pulling…" : "Pull from source"}
          </button>
        )}
        {catalog?.source !== "hosted" && (
          <button
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
          >
            <Upload size={14} /> Import CSV
          </button>
        )}
      </div>

      {catalog?.description && (
        <p className="text-sm text-content dark:text-mortar-200">
          {catalog.description}
        </p>
      )}
      {catalog && (
        <dl className="grid grid-cols-4 gap-3 text-xs">
          <Stat label="ID column">{String(catalog.schema.id_column ?? "—")}</Stat>
          <Stat label="Title column">{String(catalog.schema.title_column ?? "name")}</Stat>
          <Stat label="Image column">{String(catalog.schema.image_column ?? "image_url")}</Stat>
          <Stat label="Last sync">
            {catalog.last_sync_at
              ? new Date(catalog.last_sync_at).toLocaleString()
              : "never"}
          </Stat>
        </dl>
      )}

      <div className="flex items-center gap-2 border-t border-line dark:border-slate-700 pt-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search entries by ${titleCol}…`}
          className="flex-1 px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
      </div>

      {entries.length === 0 && !entriesQ.isLoading && (
        <div className="text-sm italic text-muted dark:text-slate-400">
          {entriesQ.data?.pages[0]?.browsable === false ? (
            // Hosted but not browsable here (the ~5M-row set bill-of-materials).
            <>
              Served from Cobblr's shared reference catalog. This one powers
              Disassemble behind the scenes and isn't browsed directly - match
              against it from your items and the details come along.
            </>
          ) : (
            <>
              No entries{debounced ? ` matching "${debounced}"` : " yet"}.
              {!debounced && catalog?.source !== "hosted" && catalog?.entry_count === 0 && " Click 'Import CSV' to start."}
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        {entries.map((entry) => (
          <EntryCard key={entry.id} entry={entry} titleColumn={titleCol} catalog={catalog ?? null} />
        ))}
      </div>

      <div ref={sentinelRef} className="py-4 text-center text-xs text-faint">
        {entriesQ.isFetchingNextPage && "loading more…"}
        {!entriesQ.isFetchingNextPage && entriesQ.hasNextPage && entries.length > 0 && (
          <span>scroll for more</span>
        )}
        {!entriesQ.hasNextPage && entries.length > 0 && (
          <span> - end of catalog ({entries.length} loaded) - </span>
        )}
      </div>

      <BackToTop />


      {importOpen && catalog && (
        <ImportCsvModal
          slug={activeSlug}
          catalogId={catalog.id}
          existingSchema={catalog.schema}
          onClose={() => setImportOpen(false)}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ["core-catalog", activeSlug, id] });
            void qc.invalidateQueries({ queryKey: ["core-catalog-entries", activeSlug, id] });
            void qc.invalidateQueries({ queryKey: ["core-catalogs", activeSlug] });
            setImportOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-0.5">
        {label}
      </div>
      <div className="text-content dark:text-mortar-100 truncate">{children}</div>
    </div>
  );
}

function EntryCard({
  entry,
  titleColumn,
  catalog,
}: {
  entry: CatalogEntry;
  titleColumn: string;
  catalog: { schema: CatalogSchema } | null;
}) {
  const schema = catalog?.schema ?? {};
  const imageCol = String(schema.image_column ?? "image_url");
  const heroField = schema.hero_field;
  const heroRenderer = schema.hero_renderer;
  const renderers = schema.field_renderers ?? {};
  const labels = schema.field_labels ?? {};
  const title = String(entry.payload[titleColumn] ?? entry.external_id);
  const imageVal =
    imageCol && typeof entry.payload[imageCol] === "string"
      ? (entry.payload[imageCol] as string)
      : null;

  // Filter out columns we're already drawing as the hero or in
  // the header — avoids "rgb: #FF0000" appearing alongside the
  // big swatch.
  const skip = new Set<string>([titleColumn, imageCol]);
  if (heroField) skip.add(heroField);
  const otherKeys = Object.keys(entry.payload)
    .filter((k) => !skip.has(k))
    .slice(0, 3);

  // The hero block: either the configured hero_field+renderer,
  // OR the image_column (with a graceful fallback), OR a "no
  // image" placeholder. Either way we render the slot so the
  // visual rhythm of the grid is consistent.
  const hero = heroField ? (
    <div className="shrink-0">
      <CatalogFieldValue
        fieldName={heroField}
        value={entry.payload[heroField]}
        renderer={heroRenderer ?? "text"}
        size="block"
      />
    </div>
  ) : imageVal ? (
    <CatalogFieldValue
      fieldName={imageCol}
      value={imageVal}
      renderer="image-url"
      size="block"
    />
  ) : (
    <NoImage size="block" title="No image in this catalog" />
  );

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 flex gap-3">
      <div className="w-32 h-32 shrink-0 flex items-center justify-center">
        {hero}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-content dark:text-mortar-100 truncate">
          {title}
        </div>
        <div className="text-[10px] font-mono text-faint dark:text-slate-500 truncate">
          #{entry.external_id}
        </div>
        {otherKeys.map((k) => (
          <div
            key={k}
            className="text-xs text-muted dark:text-mortar-200 truncate flex items-center gap-1"
          >
            <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
              {labels[k] ?? k}:
            </span>
            <CatalogFieldValue
              fieldName={k}
              value={entry.payload[k]}
              renderer={renderers[k]}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ImportCsvModal({
  slug,
  catalogId,
  existingSchema,
  onClose,
  onDone,
}: {
  slug: string;
  catalogId: string;
  existingSchema: CatalogSchema;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [csvText, setCsvText] = useState("");
  const [idColumn, setIdColumn] = useState(existingSchema.id_column ?? "");
  const [titleColumn, setTitleColumn] = useState(
    existingSchema.title_column ?? "name",
  );
  const [imageColumn, setImageColumn] = useState(
    existingSchema.image_column ?? "image_url",
  );

  const importMut = useMutation({
    mutationFn: () =>
      api.importCatalogCsv(slug, catalogId, {
        csv: csvText,
        schema: {
          id_column: idColumn || undefined,
          title_column: titleColumn || undefined,
          image_column: imageColumn || undefined,
        },
      }),
    onSuccess: (r) => {
      toast.success(`Imported ${r.imported} of ${r.total} total entries.`);
      onDone();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : String(err));
    },
  });

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setCsvText(text);
      // Auto-detect headers and pick sensible defaults if the schema
      // hasn't been set.
      const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
      const headers = firstLine.split(",").map((h) => h.trim());
      if (!idColumn && headers.length > 0) setIdColumn(headers[0]!);
      if (!titleColumn && headers.includes("name")) setTitleColumn("name");
    };
    reader.readAsText(file);
  }

  return (
    <Modal open onClose={onClose} title="Import CSV" size="lg">
      <div className="space-y-3">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            CSV file
          </span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            className="text-sm"
          />
        </label>
        {csvText && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted">
              Preview ({csvText.length} chars)
            </summary>
            <pre className="mt-2 p-2 bg-subtle dark:bg-slate-800 rounded text-[10px] max-h-32 overflow-auto">
              {csvText.slice(0, 600)}
              {csvText.length > 600 ? "\n…" : ""}
            </pre>
          </details>
        )}
        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              ID column
            </span>
            <input
              type="text"
              value={idColumn}
              onChange={(e) => setIdColumn(e.target.value)}
              placeholder="(auto-detect)"
              className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              Title column
            </span>
            <input
              type="text"
              value={titleColumn}
              onChange={(e) => setTitleColumn(e.target.value)}
              placeholder="name"
              className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              Image column
            </span>
            <input
              type="text"
              value={imageColumn}
              onChange={(e) => setImageColumn(e.target.value)}
              placeholder="image_url"
              className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!csvText || importMut.isPending}
            onClick={() => importMut.mutate()}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {importMut.isPending ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
