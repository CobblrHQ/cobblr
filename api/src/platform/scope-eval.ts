// Which records a scope selects (ScopeDef in @cobblr/platform-contract/share-scope):
// the one answer a share's mirror and a public page both read, and the count
// the scope editor shows while it is being built ("69 things match").
//
// Records that left (sold, given away) are not in any scope: a list leaves
// them out by default and so does this. Hand-picked records are in whatever
// the rules say; excluded ones are out whatever the rules say; a container in
// scope brings what is in it, when the scope asks, a few levels deep.

import { platform } from "@cobblr/platform-contract";
import type { ScopeDef, ScopeRef } from "@cobblr/platform-contract/share-scope";
import { meta } from "../db/meta.js";
import { lookupMany } from "./entities.js";
import { saidLabel } from "@cobblr/platform-contract/activity-said";

/** Past this many a scope is a whole workspace, and the editor says so. */
export const SCOPE_CAP = 5000;
const CONTENTS_DEPTH = 4;

// A record by its id alone: the same record reached by a collection (its
// collection's kind) and by a hand-pick (its module's kind) is one record,
// shared once (#4689). Ids are uuids, unique across kinds; the first way in
// (the rules, which name the most specific kind) keeps its kind.
export const scopeKey = (r: ScopeRef) => r.id;
const key = scopeKey;

/** The fields that say who has a thing now (role `assignee`, a `person`
 *  field): what "lent to them" reads. */
async function whoHasItFields(orgId: string): Promise<Array<{ entity_kind: string; name: string }>> {
  return meta.selectFrom("module_field_defs").select(["entity_kind", "name"]).where("org_id", "=", orgId).where("field_role", "=", "assignee").where("type", "=", "person").execute();
}

export async function recordsInScope(orgId: string, scope: ScopeDef, opts: { cap?: number; person?: string | null } = {}): Promise<{ refs: ScopeRef[]; complete: boolean }> {
  const cap = opts.cap ?? SCOPE_CAP;
  const out = new Map<string, ScopeRef>();
  let complete = true;
  const add = (r: ScopeRef) => {
    if (out.size >= cap) {
      complete = false;
      return;
    }
    if (!out.has(key(r))) out.set(key(r), r);
  };
  for (const rule of scope.rules) {
    const query = rule.type === "field" ? { filter: { [rule.field]: rule.equals } } : {};
    const res = await platform()
      .entities.listAll(orgId, rule.entity_kind, query, undefined, { cap })
      .catch(() => ({ items: [], complete: false, total: 0 }));
    if (!res.complete) complete = false;
    for (const it of res.items) add({ entity_kind: rule.entity_kind, id: it.id });
  }
  if (scope.lent_to_them && opts.person) {
    for (const f of await whoHasItFields(orgId)) {
      const res = await platform()
        .entities.listAll(orgId, f.entity_kind, { filter: { [f.name]: opts.person } }, undefined, { cap })
        .catch(() => ({ items: [], complete: false, total: 0 }));
      if (!res.complete) complete = false;
      for (const it of res.items) add({ entity_kind: f.entity_kind, id: it.id });
    }
  }
  if (scope.picks.length) {
    const found = await lookupMany(orgId, scope.picks.map((p) => ({ kind: p.entity_kind, id: p.id })));
    for (const f of found) add({ entity_kind: f.kind, id: f.id });
  }
  if (scope.with_contents) {
    let frontier = [...out.values()];
    for (let depth = 0; depth < CONTENTS_DEPTH && frontier.length; depth++) {
      const next: ScopeRef[] = [];
      for (const c of frontier) {
        const inside = await platform()
          .placement.contents({ orgId, container: { kind: c.entity_kind, id: c.id } })
          .catch(() => []);
        for (const i of inside) {
          const r = { entity_kind: i.kind, id: i.id };
          if (out.has(key(r))) continue;
          add(r);
          next.push(r);
        }
      }
      frontier = next;
    }
  }
  for (const x of scope.excluded) out.delete(key(x));
  return { refs: [...out.values()], complete };
}

/** What the scope editor shows: how many, and the first few by name. */
export async function previewScope(orgId: string, scope: ScopeDef, person: string | null = null): Promise<{ count: number; complete: boolean; sample: Array<{ entity_kind: string; id: string; title: string }> }> {
  const r = await recordsInScope(orgId, scope, { person });
  const first = r.refs.slice(0, 8);
  const titled = first.length ? await lookupMany(orgId, first.map((f) => ({ kind: f.entity_kind, id: f.id }))) : [];
  return {
    count: r.refs.length,
    complete: r.complete,
    sample: titled.map((t) => ({ entity_kind: t.kind, id: t.id, title: t.title })),
  };
}

/** The fields gated to a permission in this workspace (the ones a share or a
 *  public page shows only when the owner names them), with the words a person reads for each (its declared label or a
 *  workspace relabel, else the name spelt out: never the column as written). */
export async function gatedFields(orgId: string): Promise<Array<{ name: string; label: string }>> {
  const declared = await meta
    .selectFrom("entity_kinds")
    .select(["fields", "field_read_scopes"])
    .where("field_read_scopes", "is not", null)
    .execute();
  const labels = new Map<string, string>();
  for (const k of declared) {
    const fields = (Array.isArray(k.fields) ? k.fields : []) as Array<{ name?: string; label?: string }>;
    for (const name of Object.keys((k.field_read_scopes as Record<string, string> | null) ?? {})) {
      if (!labels.has(name)) labels.set(name, saidLabel(name, fields.find((f) => f.name === name)?.label));
    }
  }
  const perOrg = await meta
    .selectFrom("workspace_field_scopes as s")
    .leftJoin("module_field_defs as d", (j) => j.onRef("d.org_id", "=", "s.org_id").onRef("d.entity_kind", "=", "s.kind").onRef("d.name", "=", "s.field"))
    .select(["s.field", "d.display_label"])
    .where("s.org_id", "=", orgId)
    .execute();
  for (const r of perOrg) if (!labels.has(r.field)) labels.set(r.field, saidLabel(r.field, r.display_label));
  return [...labels].map(([name, label]) => ({ name, label })).sort((a, b) => a.label.localeCompare(b.label));
}
