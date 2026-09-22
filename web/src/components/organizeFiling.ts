// The pure half of "I did it" on a sorting-plan group: which rows file now,
// which the page has not loaded and must be fetched first, and which are
// held back and why. The plan covers up to 200 items while the inbox pages
// by 50, so "not loaded" is a property of the component, never of the item;
// it is a fetch instruction here, and the summary has no slot for it, so
// the message that once read "18 need identifying first" for 18 unscrolled
// rows cannot be written (#1567, #3291). A fetch that fails is a failure
// with its error, not a nameless row.

export interface FilingRow {
  id: string;
  suggested_name: string | null;
  quantity?: number | null;
  target_location_id?: string | null;
  suggested_candidates?: Array<{ module: string; kind: string; instance?: string | null; fields?: Record<string, unknown>; quantity?: number; bundle_external_id?: string }> | null;
}

export type FilingBlockReason = "no-name" | "no-destination";
export interface FilingBlock {
  id: string;
  reason: FilingBlockReason;
}

export interface FilingSplit<R extends FilingRow> {
  /** Rows the caller can file now: named, with a table to go to. */
  ready: R[];
  /** Ids the page has not loaded: fetch them, then split again. */
  needsFetch: string[];
  /** Rows held back, each with its one reason. */
  blocked: FilingBlock[];
}

export function splitForFiling<R extends FilingRow>(ids: readonly string[], loaded: ReadonlyMap<string, R>, excluded: ReadonlySet<string>): FilingSplit<R> {
  const out: FilingSplit<R> = { ready: [], needsFetch: [], blocked: [] };
  for (const id of ids) {
    if (excluded.has(id)) continue;
    const row = loaded.get(id);
    if (!row) {
      out.needsFetch.push(id);
      continue;
    }
    const reason = blockReason(row);
    if (reason) out.blocked.push({ id, reason });
    else out.ready.push(row);
  }
  return out;
}

/** Why a LOADED row cannot file, or null when it can. */
export function blockReason(row: FilingRow): FilingBlockReason | null {
  if (!row.suggested_name) return "no-name";
  if (!row.suggested_candidates?.[0]) return "no-destination";
  return null;
}

export interface FilingFailure {
  id: string;
  error: string;
}

/** The toast after a group files: what filed, what was held back and why,
 *  what failed and how. "Not loaded" is not an input: by the time this is
 *  written every row was either loaded, fetched, or failed to fetch. */
export function filingSummary(r: { filed: number; blocked: readonly FilingBlock[]; failed: readonly FilingFailure[]; destName: string }): string {
  const parts: string[] = [];
  if (r.filed) parts.push(`${r.filed} filed to ${r.destName}`);
  const noName = r.blocked.filter((b) => b.reason === "no-name").length;
  const noDest = r.blocked.filter((b) => b.reason === "no-destination").length;
  if (noName) parts.push(`${noName} need${noName === 1 ? "s" : ""} identifying first`);
  if (noDest) parts.push(`${noDest} ${noDest === 1 ? "has" : "have"} nowhere to go yet`);
  if (r.failed.length) {
    const last = r.failed[r.failed.length - 1]!.error;
    parts.push(`${r.failed.length} failed${last ? ` - ${last}` : ""}`);
  }
  return parts.join(" · ") || "Nothing to file yet";
}
