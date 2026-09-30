// Editing a record from a view: a card dragged to another column of a board,
// a bar dragged along a gantt, an entry dragged to another day (#4173). Every
// view shows records of kinds it did not define, so the write goes where the
// kind itself says (its manifest-declared update endpoint, entityEndpointPath)
// and a kind that declares none is honestly not editable here.
//
// The move shows at once: every cached view's copy of the row is patched in
// place, the write goes, and a refused write puts the row back and says why.
// The server's answer is then read again, so a value it normalised (a label,
// a derived date) is what stays on screen.
import { useQuery, useQueryClient, type InfiniteData, type QueryKey } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { entityEndpointPath } from "@cobblr/platform-contract/entity-endpoints";
import { api, ApiError, type ViewDataResponse } from "./api";

type Row = { kind: string; id: string; title?: string };

/** A kind's declared writer, read from the entity-kinds registry. */
export function useKindWriter(slug: string) {
  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    staleTime: 60_000,
    enabled: !!slug,
  });
  const kindOf = (id: string) => kinds.data?.items.find((k) => k.id === id);
  return {
    ready: !!kinds.data,
    /** Can a record of this kind be written from a view at all? */
    writable: (kind: string) => entityEndpointPath(kindOf(kind), "update", "_") !== null,
    write: async (kind: string, id: string, body: Record<string, unknown>) => {
      const path = entityEndpointPath(kindOf(kind), "update", id);
      if (!path) throw new ApiError(400, "not_writable", "This kind of record can't be changed from a view.");
      return api.request("PATCH", `/orgs/${slug}/${path}`, body);
    },
  };
}

/** A view row's fields with `changes` applied the way the view reads them
 *  (fieldVal: `<key>_label`, then `<key>`, then `metadata[key]`). */
export function withChanges(fields: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...fields };
  // custom-fields-apart-ok: two objects, not one bag; each copy is patched where the key already lives.
  const meta = fields.metadata && typeof fields.metadata === "object" ? { ...(fields.metadata as Record<string, unknown>) } : null;
  for (const [k, v] of Object.entries(changes)) {
    next[k] = v;
    delete next[`${k}_label`];
    if (meta && k in meta) meta[k] = v;
  }
  if (meta) next.metadata = meta;
  return next;
}

/** Edit one row of a view: shown at once, written, rolled back when refused. */
export function useViewRecordEdit(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const writer = useKindWriter(slug);
  const key: QueryKey = ["view-data", slug];
  const edit = async (row: Row, changes: Record<string, unknown>, done?: string): Promise<boolean> => {
    const before = qc.getQueriesData<InfiniteData<ViewDataResponse>>({ queryKey: key });
    qc.setQueriesData<InfiniteData<ViewDataResponse>>({ queryKey: key }, (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              items: p.items.map((it) => (it.id === row.id && it.kind === row.kind ? { ...it, fields: withChanges(it.fields, changes) } : it)),
            })),
          }
        : old,
    );
    try {
      await writer.write(row.kind, row.id, changes);
      if (done) toast.success(done);
      void qc.invalidateQueries({ queryKey: key });
      return true;
    } catch (e) {
      for (const [k, data] of before) qc.setQueryData(k, data);
      toast.error(`${row.title ? `${row.title}: ` : ""}${e instanceof ApiError ? e.message : String(e)}`);
      return false;
    }
  };
  return { edit, writable: writer.writable, ready: writer.ready };
}

/** The stamps a server writes on every record; no view moves them. */
const SERVER_STAMPED = new Set(["created_at", "updated_at"]);

/** Can a view set this field by dragging? Only a field the kind is known to
 *  carry (so nothing is dragged before the kind has loaded) that a person
 *  sets: not a server stamp, not a computed field. */
export function isSettableField(def: { name: string; type?: string; system?: boolean } | undefined): boolean {
  return !!def && !def.system && !SERVER_STAMPED.has(def.name) && def.type !== "computed";
}
