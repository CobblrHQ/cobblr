// /configuration/catalogs/:id — one catalog's detail page.
// Shows schema, lets the user upload a CSV, browse entries with
// fuzzy search.

import { useMemo, useState, type ChangeEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Library, Upload } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { ApiError, api, type CatalogEntry, type CatalogSchema } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

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
  const entriesQ = useQuery({
    queryKey: ["core-catalog-entries", activeSlug, id, debounced],
    queryFn: () =>
      api.listCatalogEntries(activeSlug, id!, { q: debounced || undefined, limit: 100 }),
    enabled: !!activeSlug && !!id,
  });

  if (!id) return null;

  const catalog = catalogQ.data;
  const entries = entriesQ.data?.items ?? [];
  const titleCol = entriesQ.data?.title_column ?? "name";

  return (
    <div className="space-y-4">
      <div>
        <Link
          to="/configuration/catalogs"
          className="text-[10px] font-mono uppercase tracking-widest text-slate-400 hover:text-cobble-500 transition inline-flex items-center gap-1"
        >
          <ArrowLeft size={10} /> back to catalogs
        </Link>
      </div>
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <Library size={20} className="text-cobble-500" />
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100">
          {catalog?.name ?? "…"}
        </h1>
        {catalog && (
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {catalog.entry_count} {catalog.entry_count === 1 ? "entry" : "entries"}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setImportOpen(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Upload size={14} /> Import CSV
        </button>
      </div>

      {catalog?.description && (
        <p className="text-sm text-slate-600 dark:text-mortar-200">
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

      <div className="flex items-center gap-2 border-t border-slate-100 dark:border-slate-700 pt-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search entries by ${titleCol}…`}
          className="flex-1 px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
        />
      </div>

      {entries.length === 0 && !entriesQ.isLoading && (
        <div className="text-sm italic text-slate-500 dark:text-slate-400">
          No entries{debounced ? ` matching "${debounced}"` : " yet"}.
          {!debounced && catalog?.entry_count === 0 && " Click 'Import CSV' to start."}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        {entries.map((entry) => (
          <EntryCard key={entry.id} entry={entry} titleColumn={titleCol} catalog={catalog ?? null} />
        ))}
      </div>

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
      <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-0.5">
        {label}
      </div>
      <div className="text-slate-700 dark:text-mortar-100 truncate">{children}</div>
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
  const imageCol = String(catalog?.schema?.image_column ?? "image_url");
  const title = String(entry.payload[titleColumn] ?? entry.external_id);
  const image =
    imageCol && typeof entry.payload[imageCol] === "string"
      ? (entry.payload[imageCol] as string)
      : null;
  const otherKeys = Object.keys(entry.payload)
    .filter((k) => k !== titleColumn && k !== imageCol)
    .slice(0, 3);
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 flex gap-3">
      {image && (
        <img
          src={image}
          alt={title}
          className="w-16 h-16 rounded object-cover border border-slate-200 dark:border-slate-700 shrink-0"
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
        {otherKeys.map((k) => (
          <div key={k} className="text-xs text-slate-500 dark:text-mortar-200 truncate">
            <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
              {k}:{" "}
            </span>
            {String(entry.payload[k])}
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
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
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
            <summary className="cursor-pointer text-slate-500">
              Preview ({csvText.length} chars)
            </summary>
            <pre className="mt-2 p-2 bg-mortar-50 dark:bg-slate-800 rounded text-[10px] max-h-32 overflow-auto">
              {csvText.slice(0, 600)}
              {csvText.length > 600 ? "\n…" : ""}
            </pre>
          </details>
        )}
        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              ID column
            </span>
            <input
              type="text"
              value={idColumn}
              onChange={(e) => setIdColumn(e.target.value)}
              placeholder="(auto-detect)"
              className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Title column
            </span>
            <input
              type="text"
              value={titleColumn}
              onChange={(e) => setTitleColumn(e.target.value)}
              placeholder="name"
              className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Image column
            </span>
            <input
              type="text"
              value={imageColumn}
              onChange={(e) => setImageColumn(e.target.value)}
              placeholder="image_url"
              className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-700">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
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
