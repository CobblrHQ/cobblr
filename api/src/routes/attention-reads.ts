import { resolveKind } from "../platform/entities.js";

type Field = { name: string; type: string; display_label?: string; field_role?: string | null };
type Read = <T>(path: string) => Promise<T | null>;

export async function readAttentionCollection(orgId: string, slug: string, inst: { instance_name: string; is_default: boolean }, limit: number, read: Read) {
  const items = await read<{ items: Array<Record<string, unknown>> }>(`/orgs/${slug}/instances/${encodeURIComponent(inst.instance_name)}/items?limit=${limit}`);
  const rowsOf = items?.items ?? [];
  if (rowsOf.length === 0) return null;
  // A default collection uses its registered kind, not the instance alias.
  const recordKind = inst.is_default
    ? (await resolveKind(orgId, `${inst.instance_name}:item`).catch(() => ({ base: `${inst.instance_name}:item` }))).base
    : `${inst.instance_name}:item`;
  const defs = await read<{ items: Field[] }>(`/orgs/${slug}/field-defs?kind=${encodeURIComponent(recordKind)}&effective=1`);
  return { recordKind, rowsOf, defs };
}
