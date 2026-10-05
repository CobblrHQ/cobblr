export interface FiledSelection {
  filed: Array<{ item_id: string; entity_id: string; entity_kind: string; name: string; item?: unknown }>;
  failed: Array<{ item_id: string; reason: string }>;
}

export async function fileSelected(
  ids: readonly string[],
  kind: string,
  confirm: (id: string) => Promise<{ item?: { target_kind?: string | null }; created?: { id?: string; name?: unknown; title?: unknown } }>,
): Promise<FiledSelection> {
  const result: FiledSelection = { filed: [], failed: [] };
  for (const id of new Set(ids)) {
    try {
      const { created, item } = await confirm(id);
      result.filed.push({ item_id: id, entity_id: String(created?.id ?? ""), entity_kind: kind || item?.target_kind || "", item, name: String(created?.name ?? created?.title ?? "") });
    } catch (err) {
      result.failed.push({ item_id: id, reason: err instanceof Error ? err.message : "It could not be added" });
    }
  }
  return result;
}
