// What the toast says after a feature change: which features moved, and what
// the api READ BACK about the bundle's tables afterwards. The old toast said
// "Features updated." over a change that had just deleted two records (#2889);
// this one repeats the api's own count, so it can only say "stayed" when
// something did.

export interface FeatureChangeResult {
  features: { turned_on: string[]; turned_off: string[] };
  kept: Array<{ instance_name: string; records: number | null }>;
  removed_empty: string[];
  incomplete?: { message: string };
}

const names = (keys: string[], declared: ReadonlyArray<{ key: string; name?: string }>) =>
  keys.map((k) => declared.find((f) => f.key === k)?.name ?? k);

export function featureChangeToast(r: FeatureChangeResult, declared: ReadonlyArray<{ key: string; name?: string }>): string {
  if (r.incomplete) return `Features updated, but not cleanly: ${r.incomplete.message}`;
  const parts: string[] = [];
  if (r.features.turned_on.length) parts.push(`${names(r.features.turned_on, declared).join(", ")} on`);
  if (r.features.turned_off.length) parts.push(`${names(r.features.turned_off, declared).join(", ")} off`);
  const head = parts.length ? `Features updated: ${parts.join("; ")}.` : "Features updated.";
  const records = r.kept.reduce((n, k) => n + (k.records ?? 0), 0);
  const tail =
    r.kept.length === 0
      ? ""
      : records === 0
        ? ` Your ${r.kept.length === 1 ? "table" : "tables"} stayed as ${r.kept.length === 1 ? "it was" : "they were"}.`
        : ` Your ${records} ${records === 1 ? "record" : "records"} stayed where ${records === 1 ? "it was" : "they were"}.`;
  const removed = r.removed_empty.length ? ` Removed the empty ${r.removed_empty.join(", ")} table${r.removed_empty.length === 1 ? "" : "s"}.` : "";
  return head + tail + removed;
}
