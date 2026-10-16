// A record's items from the person's outside libraries, as a universal
// contributed panel: the receipts and manuals in Paperless-ngx, the games in
// RomM, whatever a library adapter brings, each under its own heading.
//
// It opens with everything already there. What is linked, and what was
// matched in the background, are read from this workspace with no call to the
// document system; only Find, Link and the thumbnails reach it, through
// Cobblr, so the browser never holds its address or token. With no document
// system connected the panel is not there at all.

import { productName } from "@cobblr/platform-web";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageIcon, Search, X } from "lucide-react";
import { Link } from "react-router-dom";
import { SearchInput, relativeTime, useConfirm, useToast, type EntityDetailPanelCtx } from "@cobblr/platform-web";
import { api, fetchAuthBlobUrl, type DocumentFindSystem, type DocumentRow, type RecordDocuments } from "../../lib/api";
import { useActiveOrg } from "../../auth/ActiveOrgContext";

const key = (slug: string, kind: string, id: string) => ["record-documents", slug, kind, id];
/** How often an open record looks again for items a library pushed. */
export const PUSHED_EVERY_MS = 10_000;

/** Add a service, opened on the library a link was made through: its program,
 *  its name and its address. The token is asked for again, never carried. */
export function reconnectHref(label: string, at: DocumentRow["reconnect"]): string {
  const q = new URLSearchParams({ add: "service" });
  if (at?.provider) q.set("provider", at.provider.startsWith("adapter:") ? at.provider : `adapter:${at.provider}`);
  q.set("label", label);
  if (at?.address) q.set("address", at.address);
  return `/me/connections?${q.toString()}`;
}

export function DocumentsPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const kind = ctx.kind ?? "";
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [found, setFound] = useState<DocumentFindSystem[] | null>(null);
  const [query, setQuery] = useState("");
  const [writeBack, setWriteBack] = useState(false);

  const docs = useQuery({
    queryKey: key(activeSlug, kind, ctx.entityId),
    queryFn: () => api.recordDocuments(activeSlug, kind, ctx.entityId),
    enabled: !!activeSlug && !!kind,
    // While the background is still matching this record, look again soon.
    // A library that pushes new items brings them within seconds, so an open
    // record looks again while one is connected: this read asks no library,
    // and a hidden tab does not poll (#5884).
    refetchInterval: (q) => (q.state.data?.matching ? 5_000 : q.state.data?.systems.some((x) => x.push_setup) ? PUSHED_EVERY_MS : false),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: key(activeSlug, kind, ctx.entityId) });
  const refreshHistory = () => void qc.invalidateQueries({ queryKey: ["record-history", activeSlug, kind, ctx.entityId] });
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));
  const identity = useRef({ id: ctx.entityId, title: ctx.entityTitle });

  useEffect(() => {
    const before = identity.current;
    identity.current = { id: ctx.entityId, title: ctx.entityTitle };
    if (before.id !== ctx.entityId || before.title === ctx.entityTitle) return;
    setFound(null);
    qc.setQueryData<RecordDocuments>(key(activeSlug, kind, ctx.entityId), (old) =>
      old ? { ...old, suggestions: [], matching: true, unanswered: null } : old,
    );
    void api.rematchDocuments(activeSlug, kind, ctx.entityId).then(refresh).catch(fail);
  }, [activeSlug, ctx.entityId, ctx.entityTitle, kind]);

  const find = useMutation({
    mutationFn: (q?: string) => api.findDocuments(activeSlug, kind, ctx.entityId, q),
    onSuccess: (r) => {
      setFound(r.systems);
      refresh();
    },
    onError: fail,
  });
  const link = useMutation({
    mutationFn: (d: DocumentRow) => api.linkDocument(activeSlug, kind, ctx.entityId, { connection_id: d.connection_id, ref: d.ref, write_back: writeBack }),
    onSuccess: (r) => {
      toast.success(r.already ? `"${r.linked.title}" was linked already` : `Linked "${r.linked.title}"`);
      setFound((f) => f?.map((s) => ({ ...s, items: s.items.filter((d) => d.title !== r.linked.title) })) ?? null);
      refresh();
      refreshHistory();
    },
    onError: fail,
  });
  const unlink = useMutation({
    mutationFn: (d: DocumentRow) => api.unlinkDocument(activeSlug, kind, ctx.entityId, d),
    onSuccess: () => {
      toast.success("Unlinked. It is still in your library.");
      refresh();
      refreshHistory();
    },
    onError: fail,
  });
  const dismiss = useMutation({
    mutationFn: (d: DocumentRow) => api.dismissDocument(activeSlug, kind, ctx.entityId, d),
    onSuccess: refresh,
    onError: fail,
  });
  // A copy shared Files refused as a personal document: the row offers the
  // Vault in place of the copy button, never a dead end (#5871).
  const [personal, setPersonal] = useState<Set<string>>(() => new Set());
  const rowKey = (d: { connection_id: string; ref: string }) => `${d.connection_id}|${d.ref}`;
  const copy = useMutation({
    mutationFn: async (d: DocumentRow & { to?: "files" | "vault" }) => {
      const started = await api.copyDocument(activeSlug, kind, ctx.entityId, { connection_id: d.connection_id, ref: d.ref, ...(d.to ? { to: d.to } : {}) });
      for (let attempt = 0; attempt < 120; attempt++) {
        const job = await api.getServiceJob(activeSlug, started.job.id);
        if (job.status === "done") return { job, to: d.to ?? "files" };
        if (job.error?.code === "personal_document") {
          setPersonal((had) => new Set(had).add(rowKey(d)));
          return null;
        }
        if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error?.message ?? "The copy did not finish.");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("The copy is still running. You can check it in Services.");
    },
    onSuccess: (done) => {
      if (!done) return;
      toast.success(done.to === "vault" ? "Kept in your Vault, in Personal documents." : "Copied to this record.");
      void qc.invalidateQueries({ queryKey: ["file-attachments", activeSlug, kind.split(":", 2)[1], ctx.entityId] });
      void qc.invalidateQueries({ queryKey: ["record-history", activeSlug, kind, ctx.entityId] });
      refresh();
    },
    onError: fail,
  });
  const retry = useMutation({
    mutationFn: () => api.rematchDocuments(activeSlug, kind, ctx.entityId),
    onSuccess: refresh,
    onError: fail,
  });

  const data = docs.data;
  if (!kind || !data || (!data.available && data.linked.length === 0)) return null;
  // Suggestions belong to the facts they were matched against. While a new
  // identity is being matched, linked items still belong here but the old
  // suggestions do not.
  const suggestions = data.matching ? [] : data.suggestions;
  const labelOf = new Map(data.systems.map((x) => [x.connection_id, x.label]));
  const canOf = new Map(data.systems.map((x) => [x.connection_id, x]));
  const disconnected = [...new Map(
    data.linked
      .filter((d) => d.connected === false && !d.library_of)
      .map((d) => [d.system || "Library", reconnectHref(d.system || "Library", d.reconnect)] as const),
  )];
  const othersLibraries = [...new Map(data.linked.filter((d) => d.library_of).map((d) => [d.system || "Library", d.library_of!] as const))];
  const where = data.systems.length === 1 ? data.systems[0]!.label : "your libraries";
  const linkedRefs = new Set(data.linked.map((d) => `${d.connection_id}|${d.ref}`));
  // One section per kind of item (Documents, Games), in the order they first
  // appear, linked ones first: a cartridge with a ROM and a manual reads as
  // both, each under its own heading.
  const groups = [...new Set([...data.linked, ...suggestions].map((d) => d.type_label))];
  const offersLinkBack = data.systems.some((x) => x.can_link_back);
  const countLine = (rows: DocumentRow[], label: string) => {
    const systems = [...new Set(rows.map((d) => labelOf.get(d.connection_id) ?? where))];
    return `${rows.length} possible ${rows.length === 1 ? singular(label) : label.toLowerCase()} in ${systems.length === 1 ? systems[0] : "your libraries"}`;
  };

  return (
    <section data-testid="documents-panel">
      {disconnected.map(([system, href]) => (
        <div key={system} className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100" data-testid="library-disconnected">
          <p><strong>{system} is disconnected.</strong> Existing links stay here, and copies already brought into {productName()} stay with this record. Reconnect to refresh matches or previews, or to make new links and copies.</p>
          <Link to={href} className="mt-1 inline-flex min-h-8 items-center font-medium text-accent" data-testid="library-reconnect">
            Reconnect {system}
          </Link>
        </div>
      ))}
      {othersLibraries.map(([system, owner]) => (
        <p key={system} className="mb-3 text-xs text-muted" data-testid="library-of-another">
          <strong className="text-content dark:text-mortar-100">{system} is {owner}'s own library.</strong> What they linked shows here for everyone; only {owner} can search it, preview from it or bring copies in.
        </p>
      ))}
      {groups.length === 0 && (
        <>
          <h3 className="mb-2 text-[10px] uppercase tracking-widest text-accent">from your libraries</h3>
          <p className="text-xs text-faint italic mb-2">{data.matching ? `Looking in ${where}…` : data.unanswered ? null : `Nothing in ${where} looks like this yet.`}</p>
        </>
      )}

      {groups.map((label) => {
        const linked = data.linked.filter((d) => d.type_label === label);
        const suggested = suggestions.filter((d) => d.type_label === label);
        return (
          <div key={label} className="mb-3" data-testid={`library-group-${label.toLowerCase()}`}>
            <div className="flex items-center justify-between mb-2 gap-2">
              <h3 className="text-[10px] uppercase tracking-widest text-accent">{label.toLowerCase()}</h3>
              {suggested.length > 0 && (
                <span className="text-xs text-muted" data-testid="documents-count">
                  {countLine(suggested, label)}
                </span>
              )}
            </div>
            {linked.length > 0 && (
              <ul className="space-y-1.5 mb-1.5" data-testid="documents-linked">
                {linked.map((d) => (
                  <DocumentLine key={`${d.connection_id}|${d.ref}`} slug={activeSlug} doc={d}>
                    {d.copied_vault_file_id ? (
                      <span className="text-xs text-muted" title={d.copied_filename ?? undefined} data-testid="documents-in-vault">
                        In your Vault, in Personal documents
                      </span>
                    ) : d.vault_of ? (
                      <span className="text-xs text-muted" data-testid="documents-in-their-vault">
                        Kept in {d.vault_of}'s Vault, private to them
                      </span>
                    ) : personal.has(rowKey(d)) && !d.copied_at ? (
                      <span className="basis-full flex flex-wrap items-center gap-x-2 text-xs" data-testid="documents-personal">
                        <span className="text-muted">This is a personal document, so it can't be a shared file.</span>
                        <button type="button" className="font-medium text-accent min-h-8" onClick={() => copy.mutate({ ...d, to: "vault" })} disabled={copy.isPending}>
                          {copy.isPending ? "Keeping…" : "Keep it in your Vault instead"}
                        </button>
                      </span>
                    ) : d.copied_at && d.copied_file_id ? (
                      <Link to={`/files/${d.copied_file_id}`} className="text-xs text-accent min-h-8 inline-flex items-center" title={d.copied_filename ?? undefined} data-testid="documents-open-copy">
                        Open the copy
                      </Link>
                    ) : d.copied_at ? (
                      <span className="text-xs text-muted" title={d.copied_filename ?? undefined}>
                        Copied into {productName()}
                      </span>
                    ) : canOf.get(d.connection_id)?.can_copy ? (
                      <button type="button" className="text-xs text-accent min-h-8" onClick={() => copy.mutate(d)} disabled={copy.isPending}>
                        {copy.isPending ? "Copying…" : `Bring a copy into ${productName()}`}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Unlink ${d.title}`}
                      title="Unlink"
                      className="text-faint hover:text-ember-500 transition min-h-8"
                      onClick={async () => {
                        const at = labelOf.get(d.connection_id) ?? d.system ?? "your library";
                        if (await confirm({ title: `Unlink this ${d.type}?`, message: `It stays in ${at}; only the link to this record goes.`, confirmLabel: "Unlink", destructive: true })) unlink.mutate(d);
                      }}
                    >
                      <X size={14} />
                    </button>
                  </DocumentLine>
                ))}
              </ul>
            )}
            {suggested.length > 0 && (
              <ul className="space-y-1.5" data-testid="documents-suggested">
                {suggested.map((d) => (
                  <DocumentLine key={`${d.connection_id}|${d.ref}`} slug={activeSlug} doc={d} dashed>
                    <button type="button" className={`text-xs min-h-8 ${d.conflict ? "text-muted" : "font-medium text-accent"}`} onClick={() => link.mutate(d)} disabled={link.isPending} data-testid="documents-link">
                      {d.conflict ? "Link anyway" : "Link"}
                    </button>
                    <button type="button" className="text-xs text-muted min-h-8" onClick={() => dismiss.mutate(d)}>
                      Not this one
                    </button>
                  </DocumentLine>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {data.systems.length > 0 && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            find.mutate(query.trim() || undefined);
          }}
        >
          <div className="flex-1 min-w-0">
            <SearchInput value={query} onChange={setQuery} placeholder={`Search ${where}`} aria-label={`Search ${where}`} />
          </div>
          <button type="submit" className="min-h-9 shrink-0 rounded-md border border-line dark:border-slate-600 px-3 text-sm inline-flex items-center gap-1 text-content dark:text-mortar-100 hover:border-cobble-500 hover:text-accent disabled:opacity-50" disabled={find.isPending} data-testid="documents-find">
            <Search size={14} /> {find.isPending ? "Finding…" : "Find"}
          </button>
        </form>
      )}
      {offersLinkBack && (
        <label className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={writeBack} onChange={(e) => setWriteBack(e.target.checked)} />
          When I link, also put a link back to this record in the library, where it can keep one
        </label>
      )}

      {found && (
        <div className="mt-3 space-y-2" data-testid="documents-found">
          {found.map((s) => (
            <div key={s.connection_id}>
              {s.error ? (
                <p className="text-xs text-muted">
                  {s.label} didn't answer.{" "}
                  <button type="button" className="text-accent" onClick={() => find.mutate(query.trim() || undefined)}>
                    Retry
                  </button>
                </p>
              ) : s.items.filter((d) => !linkedRefs.has(`${s.connection_id}|${d.ref}`)).length === 0 ? (
                <p className="text-xs text-faint italic">Nothing else in {s.label} for that.</p>
              ) : (
                <ul className="space-y-1.5">
                  {s.items
                    .filter((d) => !linkedRefs.has(`${s.connection_id}|${d.ref}`))
                    .map((d) => (
                      <DocumentLine key={d.ref} slug={activeSlug} doc={{ ...d, connection_id: s.connection_id }}>
                        <button type="button" className={`text-xs min-h-8 ${d.conflict ? "text-muted" : "font-medium text-accent"}`} onClick={() => link.mutate({ ...d, connection_id: s.connection_id })} disabled={link.isPending}>
                          {d.conflict ? "Link anyway" : "Link"}
                        </button>
                      </DocumentLine>
                    ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {data.systems.some((x) => x.push_setup) && <InstantSetup slug={activeSlug} setup={data.systems.find((x) => x.push_setup)!.push_setup!} />}

      {data.unanswered && !data.matching && (
        <p className="mt-2 text-xs text-muted" data-testid="documents-unanswered">
          {data.unanswered}.{" "}
          <button type="button" className="text-accent" onClick={() => retry.mutate()} disabled={retry.isPending}>
            Retry
          </button>
        </p>
      )}
    </section>
  );
}

/** "Games" → "game", for "1 possible game". */
function singular(label: string): string {
  const l = label.toLowerCase();
  return l.endsWith("ies") ? `${l.slice(0, -3)}y` : l.endsWith("s") ? l.slice(0, -1) : l;
}

/** The inbound webhook that makes a new item arrive within seconds: the
 *  workspace's door for the "item added" push, and the library's own steps
 *  for pointing its webhook at it. Without it, the daily catch-up finds new
 *  items a day later. */
function InstantSetup({ slug, setup }: { slug: string; setup: RecordDocuments["systems"][number]["push_setup"] & object }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const tokens = useQuery({
    queryKey: ["inbound-tokens", slug],
    queryFn: () => api.listInboundTokens(slug),
    enabled: open && !!slug,
    retry: false,
    // Open, it shows the library's last call as it arrives.
    refetchInterval: open ? PUSHED_EVERY_MS : false,
  });
  const make = useMutation({
    mutationFn: () => api.createInboundToken(slug, { connector_id: ITEM_ADDED_DOOR, label: `New items from ${setup.library}` }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["inbound-tokens", slug] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const door = tokens.data?.items.find((t) => t.connector_id === ITEM_ADDED_DOOR && t.enabled);
  const url = door ? `${window.location.origin}/api/v1/integrations/${door.connector_id}/${door.token}/webhook` : null;
  return (
    <details className="mt-3 text-xs" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-testid="documents-instant">
      <summary className="cursor-pointer text-muted hover:text-accent">{`Get ${setup.arrives} from ${setup.library} within seconds`}</summary>
      <div className="mt-2 space-y-2 text-muted">
        {tokens.isError ? (
          <p>An owner or admin of this workspace can set this up.</p>
        ) : url ? (
          <>
            <ol className="list-decimal pl-5 space-y-1">
              {setup.before.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded bg-cobble-50 dark:bg-slate-800 px-2 py-1">{url}</code>
              <button
                type="button"
                className="text-accent shrink-0 min-h-8"
                onClick={() => {
                  void navigator.clipboard?.writeText(url);
                  toast.success("Copied");
                }}
              >
                Copy
              </button>
            </div>
            <ol className="list-decimal pl-5 space-y-1" start={setup.before.length + 1}>
              {setup.after.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p data-testid="documents-instant-heard">
              {door?.last_hit_at
                ? `Last heard from ${setup.library} ${relativeTime(door.last_hit_at)}.`
                : `Not heard from ${setup.library} yet. Add a document there to try it.`}
            </p>
            <p>{`Without it, ${setup.arrives} are found once a day.`}</p>
          </>
        ) : (
          <button type="button" className="text-accent min-h-8" onClick={() => make.mutate()} disabled={make.isPending || tokens.isLoading}>
            Set it up
          </button>
        )}
      </div>
    </details>
  );
}

/** The inbound door an "item added" push rings (core-documents). */
const ITEM_ADDED_DOOR = "document-added";

/** One document: its thumbnail, title and date, where to open it, and what
 *  can be done with it here. */
function DocumentLine({ slug, doc, dashed = false, children }: { slug: string; doc: DocumentRow; dashed?: boolean; children: React.ReactNode }) {
  return (
    // The title keeps at least 10rem; on a phone the actions wrap under it
    // rather than squeezing it to a few letters.
    <li className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 px-2 py-1.5 text-xs rounded border ${dashed ? "border-dashed border-accent/50" : "border-line dark:border-slate-700"}`} data-testid="document-row">
      <Thumb slug={slug} doc={doc} />
      <div className="min-w-0 flex-1 basis-40">
        <div className="font-medium text-content dark:text-mortar-100 truncate" title={doc.title}>
          {doc.title}
        </div>
        <div className="text-muted truncate">
          {[doc.subtitle, doc.created, doc.tags.slice(0, 3).join(", "), doc.because && !doc.conflict ? `matched by ${doc.because}` : null].filter(Boolean).join(" · ")}
        </div>
        {/* What on it says it is another thing's paperwork: always said, and
            never a match (#5870). A year only warns. */}
        {doc.conflict && <div className="text-danger" data-document-conflict>Not this record's: {doc.conflict}</div>}
        {!doc.conflict && doc.warning && <div className="text-amber-700 dark:text-amber-300" data-document-warning>{doc.warning}</div>}
      </div>
      <div className="ml-auto flex min-w-0 flex-wrap items-center gap-x-3">
        {doc.open_url && (
          <a href={doc.open_url} target="_blank" rel="noreferrer" className="text-xs text-accent min-h-8 inline-flex items-center">
            {doc.open_label || "Open"}
          </a>
        )}
        {children}
      </div>
    </li>
  );
}

function Thumb({ slug, doc }: { slug: string; doc: DocumentRow }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!doc.has_thumb || doc.connected === false) return;
    let url: string | null = null;
    let live = true;
    void fetchAuthBlobUrl(api.documentThumbPath(slug, doc)).then((u) => {
      url = u;
      if (live) setSrc(u);
      else if (u) URL.revokeObjectURL(u);
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [slug, doc.connection_id, doc.ref, doc.has_thumb, doc.connected]);
  return src ? (
    <img src={src} alt="" className="h-10 w-8 shrink-0 rounded object-cover bg-cobble-50 dark:bg-slate-800" />
  ) : (
    <span className="h-10 w-8 shrink-0 rounded bg-cobble-50 dark:bg-slate-800 inline-flex items-center justify-center text-faint">
      <ImageIcon size={14} />
    </span>
  );
}
