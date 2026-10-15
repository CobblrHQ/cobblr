export type SplitItem = { id: string; status: string; image_file_id: string | null; suggested_name: string; quantity: number; created_at: string; suggested_metadata: Record<string, unknown> };

// Detached picture and lookup passes can stamp bookkeeping between reads.
// Compare the split's owned state, including every split marker, instead.
export function splitState(row: SplitItem): SplitItem {
  return {
    id: row.id,
    status: row.status,
    image_file_id: row.image_file_id,
    suggested_name: row.suggested_name,
    quantity: row.quantity,
    created_at: row.created_at,
    suggested_metadata: Object.fromEntries(Object.entries(row.suggested_metadata ?? {}).filter(([key]) => key.startsWith("split_"))),
  };
}
