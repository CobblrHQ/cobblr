// Everything that belongs to one person, across every collection (#3787).
//
// "What does Alex own", "My things", and the list a leaving member's things are
// handed on from all ask the same question, so it is answered once, here: every
// kind the workspace has, every person field on it (its own or one scoped to it
// by traits, through the one field-def resolver), every record whose value is
// that person.
//
// A module's list resolver decides which filter keys it understands and may
// ignore one it does not, so each page is checked again here: a resolver that
// ignored the filter must not make everything in the collection look like
// Alex's.
import { resolveFieldDefsForKind } from "./field-defs.js";
import { detailPathForEntity, getEntityWriterFor, list, listKindsForOrg } from "./entities.js";

export interface PersonThingsGroup {
  kind: string;
  label: string;
  field: string;
  field_label: string;
  /** `path` is the item's page in the workspace, when its kind has one. */
  items: Array<{ id: string; title: string; path: string | null }>;
}

const PAGE = 500;

function valueOf(fields: Record<string, unknown>, name: string): unknown {
  const md = fields.metadata;
  const fromMeta = md && typeof md === "object" ? (md as Record<string, unknown>)[name] : undefined;
  return fields[name] ?? fromMeta;
}

export async function thingsOfPerson(
  orgId: string,
  personId: string,
  viewer?: { userId?: string; role?: string },
): Promise<PersonThingsGroup[]> {
  const out: PersonThingsGroup[] = [];
  for (const k of await listKindsForOrg(orgId)) {
    let defs;
    try {
      defs = (await resolveFieldDefsForKind(orgId, k.id)).filter((d) => d.type === "person");
    } catch {
      continue;
    }
    for (const d of defs) {
      const res = await list(orgId, k.id, { filter: { [d.name]: personId }, limit: PAGE }, viewer).catch(() => ({ items: [] }));
      const mine = res.items.filter((e) => valueOf(e.fields as Record<string, unknown>, d.name) === personId);
      const items = await Promise.all(
        mine.map(async (e) => ({ id: e.id, title: e.title, path: (await detailPathForEntity(orgId, k.id, e.id).catch(() => undefined)) ?? null })),
      );
      if (items.length > 0) {
        out.push({ kind: k.id, label: k.display_name_plural ?? k.display_name, field: d.name, field_label: d.display_label, items });
      }
    }
  }
  return out;
}

export interface HandOffResult {
  /** Records now naming the new person. */
  moved: number;
  /** Records that could not be rewritten: their kind has no way to set a
   *  field from outside its module. Named, so nobody is told "done" over
   *  things that stayed. */
  kept: Array<{ kind: string; id: string; title: string }>;
}

/**
 * Hand everything one person owns to another: a member leaving hands their
 * things on, or someone who left earlier has theirs passed on now. Written
 * field by field through the kernel's mergeMetadata, so each record keeps
 * everything else it has, and the owning module stays the one that writes it.
 */
export async function handOffThings(orgId: string, fromPersonId: string, toPersonId: string): Promise<HandOffResult> {
  const out: HandOffResult = { moved: 0, kept: [] };
  for (const g of await thingsOfPerson(orgId, fromPersonId)) {
    for (const it of g.items) {
      const w = await getEntityWriterFor(orgId, g.kind);
      const ok = w?.mergeMetadata
        ? await w.mergeMetadata(orgId, it.id, { [g.field]: toPersonId }).then(() => true, () => false)
        : false;
      if (ok) out.moved += 1;
      else out.kept.push({ kind: g.kind, id: it.id, title: it.title });
    }
  }
  return out;
}
