import { linkDateSummary, type LinkDateSummary } from "@cobblr/platform-contract/link-date-summary";
// A record's links, both ways round, in words, and the door to add one.
//
// One component for every page: the web app's own pages mount it through
// EntityAttachments, module-owned pages (a part, a project, a list) receive it
// as the universal "Links" panel. Before, the list was a web-app component, so
// a part had no Link at all, and it asked for links under one spelling of the
// record's kind, so a mod linked to a printer from the printer's table never
// appeared on the printer (#3875).
//
// A table can declare the links its records make ("installed on" a printer,
// "uses part" a part). Those are offered first, and picking one lists the
// things it can point at straight away: one tap links. Anything else is
// "related to", found by search.
import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Plus, X } from "lucide-react";
import { Modal, useConfirm, useToast, SearchInput } from "@cobblr/platform-web";
import { ApiError, api } from "../../lib/api";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import { useDetailRoute } from "../../lib/useDetailRoute";
import { useKindLabels } from "../../lib/useKindLabels";
import { SearchIncomplete } from "../../components/SearchIncomplete";
import { LIBRARY_LINK_REL } from "@cobblr/platform-contract/library";

type Offered = { kind: string; label: string; to: string[]; reverse: boolean };
type Words = Record<string, { label: string; inverse: string; date_summary?: LinkDateSummary }>;

/** How a link reads from this record. Declared words when there are any;
 *  otherwise the stored key as words ("related-to" → "related to"). */
export function linkPhrase(row: { relationship_kind: string; direction: "in" | "out" }, words: Words): { before: string; after: string } {
  const w = words[row.relationship_kind];
  const plain = row.relationship_kind.replace(/[-_]+/g, " ").trim();
  if (row.direction === "out") return { before: w?.label ?? plain, after: "" };
  if (w) return { before: w.inverse, after: "" };
  return { before: "", after: `${plain} this` };
}

const linksKey = (slug: string, kind: string, id: string) => ["links", slug, kind, id];

export function LinksSection({
  kind,
  entityId,
  collection,
  compact = false,
}: {
  kind: string;
  entityId: string;
  /** The table the record is in (`3d-printers:item`) when the page knows it:
   *  its declared links are offered first. Defaults to `kind`. */
  collection?: string;
  compact?: boolean;
}) {
  const offerKind = collection ?? kind;
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const links = useQuery({
    queryKey: linksKey(activeSlug, kind, entityId),
    queryFn: () => api.recordLinks(activeSlug, kind, entityId),
    enabled: !!activeSlug,
  });
  const kinds = useQuery({
    queryKey: ["link-kinds", activeSlug, offerKind],
    queryFn: () => api.linkKinds(activeSlug, offerKind),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const words = kinds.data?.words ?? {};
  const fixed = new Set(kinds.data?.fixed ?? []);
  // An item linked from an outside library (a document, a game) is a link
  // too, but it is not a record here: the library panel shows it, with its
  // title and where to open it, and removing it there also takes it off the
  // panel's list.
  const rows = (links.data?.items ?? []).filter((p) => p.relationship_kind !== LIBRARY_LINK_REL);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["links", activeSlug] });
  const del = useMutation({
    mutationFn: (id: string) => api.deletePairing(activeSlug, id),
    onSuccess: () => {
      refresh();
      toast.success("Link removed");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const dialog = open && (
    <LinkDialog kind={kind} entityId={entityId} offered={kinds.data?.offered ?? []} onClose={() => setOpen(false)} onLinked={refresh} />
  );

  if (compact && rows.length === 0) {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border border-dashed border-line dark:border-slate-600 text-muted hover:border-cobble-500 hover:text-accent transition"
          data-testid="link-add"
        >
          <Link size={10} /> Link
        </button>
        {dialog}
      </>
    );
  }

  return (
    <section className={compact ? "w-full" : undefined} data-testid="links-section">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent">// links</h3>
        <button type="button" onClick={() => setOpen(true)} className="text-xs text-accent inline-flex items-center gap-1 min-h-8" data-testid="link-add">
          <Plus size={12} /> Link
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-faint italic">Nothing linked yet.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((p) => {
            const phrase = linkPhrase(p, words);
            const otherKind = p.direction === "out" ? p.target_kind : p.source_kind;
            const otherId = p.direction === "out" ? p.target_id : p.source_id;
            return (
              <li key={p.id} className="flex items-center gap-2 px-2 py-1.5 text-xs border border-line dark:border-slate-700 rounded group" data-testid="link-row">
                {phrase.before && <span className="text-muted shrink-0">{phrase.before}</span>}
                <LinkedName kind={otherKind} id={otherId} summary={p.direction === "in" ? words[p.relationship_kind]?.date_summary : undefined} />
                {phrase.after && <span className="text-muted shrink-0">{phrase.after}</span>}
                <div className="flex-1" />
                {p.notes && (
                  <span className="text-muted italic truncate max-w-[200px]" title={p.notes}>
                    {p.notes}
                  </span>
                )}
                {!fixed.has(p.relationship_kind) && (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await confirm({ title: "Remove this link?", message: "Both things stay; only the link between them goes.", confirmLabel: "Remove", destructive: true });
                    if (ok) del.mutate(p.id);
                  }}
                  className="text-faint hover:text-ember-500 transition"
                  title="Remove link"
                  aria-label="Remove link"
                >
                  <X size={12} />
                </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {dialog}
    </section>
  );
}

/** The other end of a link, by name, opening it. A link can outlive what it
 *  points at, and says so. */
function LinkedName({ kind, id, summary }: { kind: string; id: string; summary?: LinkDateSummary }) {
  const { activeSlug } = useActiveOrg();
  const detailRoute = useDetailRoute(activeSlug ?? "");
  const q = useQuery({
    queryKey: ["entity", activeSlug, kind, id],
    queryFn: () => api.lookupEntity(activeSlug, kind, id),
    enabled: !!activeSlug,
    staleTime: 60_000,
    retry: false,
  });
  const to = detailRoute(kind, id);
  const dateSummary = summary && q.data?.fields ? linkDateSummary(summary, q.data.fields) : null;
  const label = q.isError ? "(deleted)" : (q.data?.title ?? "…");
  const cls = "font-medium text-content dark:text-mortar-100 truncate";
  return to && !q.isError ? (
    <RouterLink to={to} className={cls + " hover:underline"}>
      {label}{dateSummary && <span className="block text-xs text-muted">{dateSummary}</span>}
    </RouterLink>
  ) : (
    <span className={cls}>{label}</span>
  );
}

const RELATED = "related-to";

function LinkDialog({
  kind,
  entityId,
  offered,
  onClose,
  onLinked,
}: {
  kind: string;
  entityId: string;
  offered: Offered[];
  onClose: () => void;
  onLinked: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const labels = useKindLabels(activeSlug);
  const toast = useToast();
  const [how, setHow] = useState<Offered | null>(offered[0] ?? null);
  const [query, setQuery] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);

  // A declared link lists what it can point at without a search; "related to"
  // searches everything.
  const candidates = useQuery({
    queryKey: ["link-candidates", activeSlug, how?.to.join(",") ?? "", query],
    queryFn: async () => {
      const lists = await Promise.all(how!.to.map((t) => api.listEntities(activeSlug, t, query.trim() || undefined).catch(() => ({ items: [] }))));
      const seen = new Set<string>();
      return lists.flatMap((l) => l.items).filter((e) => !seen.has(e.id) && !!seen.add(e.id));
    },
    enabled: !!activeSlug && !!how,
  });
  const search = useQuery({
    queryKey: ["pairing-search", activeSlug, query],
    queryFn: () => api.search(activeSlug, query),
    enabled: !!activeSlug && !how && query.trim().length >= 2,
  });
  const hits: Array<{ kind: string; id: string; title: string }> = how
    ? (candidates.data ?? []).map((e) => ({ kind: e.kind, id: e.id, title: e.title }))
    : (search.data?.items ?? []).map((h) => ({ kind: h.kind, id: h.id, title: h.title }));
  const others = hits.filter((h) => h.id !== entityId);

  const link = useMutation({
    mutationFn: (target: { kind: string; id: string }) => {
      const rel = how?.kind ?? RELATED;
      const here = { kind, id: entityId };
      const [source, dest] = how?.reverse ? [target, here] : [here, target];
      return api.createPairing(activeSlug, {
        source_kind: source.kind,
        source_id: source.id,
        target_kind: dest.kind,
        target_id: dest.id,
        relationship_kind: rel,
        notes: null,
      });
    },
    onSuccess: () => {
      toast.success("Linked");
      onLinked();
      onClose();
    },
    onError: (e) => setRefusal(e instanceof ApiError || e instanceof Error ? e.message : String(e)),
  });

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1.5 text-sm min-h-9 transition ${active ? "border-accent bg-cobble-50 dark:bg-cobble-900/30 text-accent" : "border-line dark:border-slate-600 text-content dark:text-mortar-200"}`;

  return (
    <Modal open onClose={onClose} title="Link to something">
      <div className="space-y-3">
        <div>
          <div className="text-xs text-muted mb-1.5">How are they linked?</div>
          <div className="flex flex-wrap gap-1.5">
            {offered.map((o) => (
              <button key={`${o.kind}:${o.reverse}`} type="button" className={chip(how === o)} onClick={() => { setHow(o); setRefusal(null); }} data-testid="link-kind">
                {o.label}
              </button>
            ))}
            <button type="button" className={chip(!how)} onClick={() => { setHow(null); setRefusal(null); }} data-testid="link-kind">
              related to
            </button>
          </div>
        </div>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={how ? "Filter…" : "Search for what it is linked to…"}
          aria-label={how ? "Filter" : "Search for what it is linked to"}
        />
        {!how && <SearchIncomplete compact failed={search.data?.kinds_failed} />}
        {refusal && (
          <p role="alert" className="text-xs text-ember-600 dark:text-ember-400" data-testid="mutation-error">
            {refusal}
          </p>
        )}
        {others.length > 0 ? (
          <ul className="border border-line dark:border-slate-700 rounded max-h-72 overflow-y-auto divide-y divide-line dark:divide-slate-800">
            {others.slice(0, 30).map((h) => (
              <li key={`${h.kind}:${h.id}`}>
                <button
                  type="button"
                  disabled={link.isPending}
                  onClick={() => link.mutate({ kind: h.kind, id: h.id })}
                  className="w-full px-3 py-2.5 text-left hover:bg-subtle dark:hover:bg-slate-800 flex items-center gap-2 disabled:opacity-50"
                  data-testid="link-candidate"
                >
                  <span className="text-sm truncate flex-1">{h.title}</span>
                  <span className="text-[10px] text-faint shrink-0">{labels.collection(h.kind)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-faint italic">
            {how ? (candidates.isLoading ? "Loading…" : "Nothing to link to yet.") : query.trim().length >= 2 ? "No matches." : "Type to search."}
          </p>
        )}
      </div>
    </Modal>
  );
}
