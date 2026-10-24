import { platform } from "@cobblr/platform-contract";
import { changesIn } from "@cobblr/platform-contract/activity-changes";
import { referenceStem } from "@cobblr/platform-contract/activity-said";
import { historyBag } from "./record-history.js";

export function historyReferenceKind(field: string, own: string[], kinds: ReadonlyArray<{ id: string; module_name: string }>): string | null {
  const stem = referenceStem(field);
  if (!stem) return null;
  if (stem === "parent") return own[own.length - 1] ?? null;
  const modules = own.map((k) => k.split(":")[0]);
  return kinds.find((k) => k.id.endsWith(`:${stem}`) && modules.includes(k.module_name))?.id
    ?? kinds.find((k) => k.id.endsWith(`:${stem}`))?.id ?? null;
}

export async function keepActivityReferenceTitles(orgId: string, own: string[], diff: unknown): Promise<unknown> {
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) return diff;
  const bag = historyBag(diff);
  const changes = changesIn(diff);
  const refs = Object.entries(bag).filter(([field, value]) => (field === "from" || field === "to") && typeof historyBag(value).kind === "string" && typeof historyBag(value).id === "string");
  if (!refs.length && !changes?.some((c) => !c.secret && referenceStem(c.field))) return diff;
  const kinds = changes?.length ? await platform().entities.listKindsForOrg(orgId) : [];
  const titles = new Map<string, Promise<string | undefined>>();
  const titleOf = (kind: string, id: string) => {
    const key = `${kind} ${id}`;
    if (!titles.has(key)) titles.set(key, platform().entities.lookupMany(orgId, [{ kind, id }]).then((found) => found[0]?.title));
    return titles.get(key)!;
  };
  const out = { ...bag };
  if (changes) out.changes = await Promise.all(changes.map(async (c) => {
    if (c.secret) return c;
    const kind = historyReferenceKind(c.field, own, kinds);
    if (!kind) return c;
    const reference_titles: { from?: string; to?: string } = {};
    for (const side of ["from", "to"] as const) {
      const value = c[side];
      if (typeof value === "string" && value) {
        const title = await titleOf(kind, value);
        if (title) reference_titles[side] = title;
      }
    }
    return { ...c, reference_titles };
  }));
  for (const [field, value] of refs) {
    const ref = historyBag(value);
    out[field] = { ...ref, title: await titleOf(ref.kind as string, ref.id as string) };
  }
  return out;
}
