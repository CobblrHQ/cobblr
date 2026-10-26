import { useCan } from "../lib/can";
// /tags/:id: one tag, and everything that carries it, across every kind.
//
// core-tags declared this as the tag's detail route and nothing drew it, so a
// tag chip, a search hit or the assistant's link to a tag opened the app's
// not-found page. The tags list used to show what a tag held in a modal of
// kind ids and uuids; here each record is named and opens, grouped by what it
// is, and the tag can be edited, merged into another or deleted by anyone
// the tag routes let write (owner, admin, member).
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Pin, Tag as TagIcon, Trash2 } from "lucide-react";
import { CustomFieldsPanel, useConfirm, useToast, usePageTitle, editOf } from "@cobblr/platform-web";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { countOf } from "@cobblr/platform-contract/plural";
import { ApiError, api, type TagAttachment } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useDetailRoute } from "../lib/useDetailRoute";
import { EditTagModal } from "../components/EditTagModal";
import { EntityAttachments } from "../components/EntityAttachments";
import { ContributedDetailPanels, ContributedTagToolbar } from "../panels/registry";

export function TagDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { activeSlug, activeOrg } = useActiveOrg();
  const mayMerge = !!useCan("core-tags:merge");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const routeFor = useDetailRoute(activeSlug);
  const [editing, setEditing] = useState(false);
  const canWrite = roleSatisfies(activeOrg?.role, ["owner", "admin", "member"]);

  const tags = useQuery({ queryKey: ["tags", activeSlug], queryFn: () => api.listTags(activeSlug), enabled: !!activeSlug });
  const tag = tags.data?.items.find((t) => t.id === id) ?? null;
  const parent = tag?.parent_id ? tags.data?.items.find((t) => t.id === tag.parent_id) ?? null : null;
  const children = (tags.data?.items ?? []).filter((t) => t.parent_id === id);
  usePageTitle(tag ? tag.name : "Tag");

  const attached = useQuery({
    queryKey: ["tag-attachments", activeSlug, id],
    queryFn: () => api.listTagAttachments(activeSlug, { tag_id: id! }),
    enabled: !!activeSlug && !!id,
  });
  const kinds = useQuery({
    queryKey: ["entity-kinds", activeSlug],
    queryFn: () => api.listEntityKinds(activeSlug),
    enabled: !!activeSlug,
    staleTime: 5 * 60_000,
  });

  // What carries the tag, grouped by what it is, most first.
  const groups = useMemo(() => {
    const names = new Map((kinds.data?.items ?? []).map((k) => [k.id, k.display_name_plural ?? k.display_name]));
    const owners = new Map((kinds.data?.items ?? []).map((k) => [k.id, { module: k.module_name, collection: k.instance_name ?? null }]));
    const by = new Map<string, TagAttachment[]>();
    for (const a of attached.data?.items ?? []) {
      const kind = `${a.source_module}:${a.source_type}`;
      by.set(kind, [...(by.get(kind) ?? []), a]);
    }
    return [...by.entries()]
      .map(([kind, items]) => ({ kind, label: names.get(kind) ?? kind, owner: owners.get(kind) ?? null, items }))
      .sort((x, y) => y.items.length - x.items.length || x.label.localeCompare(y.label));
  }, [attached.data, kinds.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tags", activeSlug] });
    void qc.invalidateQueries({ queryKey: ["tag-attachments"] });
  };
  const setField = useMutation({
    mutationFn: (metadata: Record<string, unknown>) => api.updateTag(activeSlug, tag!.id, editOf(tag, { metadata })),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const pin = useMutation({
    mutationFn: () => api.updateTag(activeSlug, tag!.id, editOf(tag, { pinned: !tag!.pinned })),
    onSuccess: () => {
      toast.success(tag!.pinned ? `Unpinned ${tag!.name}` : `Pinned ${tag!.name}`);
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const del = useMutation({
    mutationFn: () => api.deleteTag(activeSlug, tag!.id),
    onSuccess: (gone) => {
      const id = tag!.id;
      refresh();
      toast.action(`Deleted the tag ${gone.name}${gone.assignments ? `, taken off ${countOf(gone.assignments, "record")}` : ""}.`, {
        actionLabel: "Undo",
        onAction: async () => {
          try {
            const back = await api.restoreTag(activeSlug, id);
            refresh();
            toast.success(`Put ${back.name} back on ${countOf(back.assignments, "record")}.`);
            navigate(`/tags/${id}`);
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
        },
      });
      navigate("/tags");
    },
    // A member refused opens the blocked-action sheet by itself (api.ts).
    onError: (e) => {
      if (e instanceof ApiError && e.blocked) return;
      toast.error(e instanceof ApiError ? e.message : String(e));
    },
  });

  // The page draws once it knows what carries the tag and what those things
  // are (on a first try; a failed read does not hold it): drawn first, the
  // groups arrived and moved the controls under them 180 to 540 px (#7799).
  const asking = [tags, attached, kinds].some((q) => q.isLoading && q.failureCount === 0);
  if (asking) return <div className="text-sm text-muted">Loading…</div>;
  if (!tag) {
    return (
      <div className="space-y-3 max-w-3xl mx-auto">
        <p className="text-sm text-content dark:text-slate-200">This tag is not here any more. It may have been deleted or merged into another.</p>
        <Link to="/tags" className="text-sm text-accent hover:underline">
          See every tag
        </Link>
      </div>
    );
  }

  const total = attached.data?.items.length ?? 0;
  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <Link to="/tags" className="inline-flex items-center gap-1 text-sm text-muted hover:text-accent">
        <ArrowLeft size={14} /> All tags
      </Link>

      <header className="flex flex-wrap items-center gap-3">
        <span
          className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-lg font-semibold text-content dark:text-mortar-100"
          style={{ borderColor: tag.color ?? undefined, background: tag.color ? `${tag.color}22` : undefined }}
        >
          {tag.icon ? <span className="leading-none">{tag.icon}</span> : <TagIcon size={16} style={{ color: tag.color ?? undefined }} />}
          {tag.name}
        </span>
        {parent && (
          <span className="text-sm text-muted dark:text-slate-400">
            inside{" "}
            <Link to={`/tags/${parent.id}`} className="text-accent hover:underline">
              {parent.name}
            </Link>
          </span>
        )}
        <div className="flex-1" />
        {canWrite && (
          // Its three actions wrap: held on one line, Delete ran 67 px past a
          // phone at 200% text (#8430).
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => pin.mutate()}
              className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-2.5 py-1 text-sm text-muted hover:text-content"
            >
              <Pin size={13} /> {tag.pinned ? "Unpin" : "Pin"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-2.5 py-1 text-sm text-muted hover:text-content"
            >
              <Pencil size={13} /> Edit or merge
            </button>
            <button
              type="button"
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete the tag ${tag.name}?`,
                  message:
                    total > 0
                      ? `It comes off the ${countOf(total, "record")} that carry it. The records themselves stay.${children.length ? ` The tags inside it move to the top level.` : ""} You can undo this straight after.`
                      : "Nothing carries it. You can undo this straight after.",
                  confirmLabel: "Delete tag",
                  destructive: true,
                });
                if (ok) del.mutate();
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-2.5 py-1 text-sm text-muted hover:text-ember-500"
            >
              <Trash2 size={13} /> Delete
            </button>
          </div>
        )}
      </header>

      {children.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted dark:text-slate-400">Tags inside it:</span>
          {children.map((c) => (
            <Link key={c.id} to={`/tags/${c.id}`} className="rounded-full border border-line dark:border-slate-600 px-2.5 py-0.5 text-content dark:text-slate-200 hover:border-accent">
              {c.icon ? `${c.icon} ` : ""}
              {c.name}
            </Link>
          ))}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">
          {attached.isLoading ? "Carried by…" : total === 0 ? "Nothing carries this tag yet" : `Carried by ${countOf(total, "record")}`}
        </h2>
        {total === 0 && !attached.isLoading && (
          <p className="text-sm text-muted dark:text-slate-400">Add it from any record's page, where the tags are.</p>
        )}
        {groups.map((g) => (
          <div key={g.kind} className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 space-y-2">
            {/* A finger's height held for what a module adds here: the recount
                arrives a moment after the group, and on a phone it grew this
                line and moved the records under it 28 px (#7799). */}
            <div className="flex flex-wrap items-center justify-between gap-2 [@media(pointer:coarse)]:min-h-11">
              <div className="text-xs font-medium uppercase tracking-wide text-muted dark:text-slate-400">
                {g.label} · {g.items.length}
              </div>
              {/* What the module owning these records offers over them (a recount); this page names none. */}
              <ContributedTagToolbar
                module={g.owner?.module}
                ctx={{ slug: activeSlug, kind: g.kind, collection: g.owner?.collection ?? null, ids: g.items.map((a) => a.source_id), tagName: tag.name }}
              />
            </div>
            <TaggedRecords kind={g.kind} items={g.items} to={(sourceId) => routeFor(g.kind, sourceId)} />
          </div>
        ))}
      </section>

      {/* The tag's own fields, as a bundle or a person defines them. */}
      <CustomFieldsPanel entityKind="core-tags:tag" entityId={tag.id} values={tag.metadata ?? {}} onCommit={(name, value) => setField.mutate({ [name]: value })} />

      {/* Files and notes on the tag; discussion and links come with the panels below, and a tag is not itself tagged. */}
      <EntityAttachments kind="core-tags:tag" entityId={tag.id} omit={["tags", "discussion", "pairings"]} />

      {/* Whatever enabled modules add to a tag's page; this page names none.
          Last: the panels come a moment after the page, and above the files
          they moved Add 540 px under a finger (#7799). */}
      <ContributedDetailPanels target="core-tags:tag" ctx={{ slug: activeSlug, entityId: tag.id, entityTitle: tag.name }} />

      {editing && (
        <EditTagModal
          mayMerge={mayMerge}
          slug={activeSlug}
          tag={tag}
          onClose={() => setEditing(false)}
          onSaved={() => {
            refresh();
            setEditing(false);
          }}
          onMerged={(intoId) => {
            refresh();
            setEditing(false);
            navigate(`/tags/${intoId}`);
          }}
          onUndone={(id) => {
            refresh();
            navigate(`/tags/${id}`);
          }}
        />
      )}
    </div>
  );
}

/** One record that carries the tag, by its name, opening it. A record deleted
 *  since says so rather than showing an id. */
/** A group's records, drawn once each has its name: a chip saying "…" and
 *  growing to its name pushed the chips after it 44 to 58 px along under a
 *  finger (#7799). */
function TaggedRecords({ kind, items, to }: { kind: string; items: TagAttachment[]; to: (sourceId: string) => string | null }) {
  const { activeSlug } = useActiveOrg();
  const reads = useQueries({
    queries: items.map((a) => ({
      queryKey: ["entity", activeSlug, kind, a.source_id],
      queryFn: () => api.lookupEntity(activeSlug, kind, a.source_id),
      enabled: !!activeSlug,
      staleTime: 60_000,
      retry: false,
    })),
  });
  if (reads.some((q) => q.isLoading)) return <div className="h-8 [@media(pointer:coarse)]:h-11 text-xs text-faint">…</div>;
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((a, i) => (
        <li key={a.id}>
          <TaggedRecord q={reads[i]!} to={to(a.source_id)} />
        </li>
      ))}
    </ul>
  );
}

function TaggedRecord({ q, to }: { q: { isError: boolean; data?: { title?: string | null } | null }; to: string | null }) {
  const label = q.isError ? "(deleted)" : (q.data?.title ?? "…");
  const cls = "inline-flex rounded-md border border-line dark:border-slate-600 bg-subtle dark:bg-slate-800 px-2 py-1 text-sm text-content dark:text-slate-200";
  return to && !q.isError ? (
    <Link to={to} className={`${cls} hover:border-accent`}>
      {label}
    </Link>
  ) : (
    <span className={cls}>{label}</span>
  );
}
