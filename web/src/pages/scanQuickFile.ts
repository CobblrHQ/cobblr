// One tap files a scanned row where it belongs, installing its table on the
// way when the workspace does not have it yet (#3789).
//
// Two surfaces offer the tap: the inbox row's Add / Install & add, and the
// scan sheet's "Add to Yarn" right after the camera reads the code. They file
// the same way through this one function, so a scan filed from the sheet and
// one filed from the inbox cannot end up different. The destination is the
// row's own, as the contract's row state resolves it (scanRowState).

import { api, type BundleInstallSummary, type ScanCandidate, type ScanInboxItem } from "../lib/api";
import { entryKey } from "../lib/scanDestination";
import { resolveInstanceForFiling } from "./scanInstall";
import { baseKind } from "./scanFileAll";

/** A row's candidates as every surface reads them: each once by label (the
 *  richer one kept), and a candidate stored without fields treated as having
 *  none rather than taking the page down (#3392). */
export function cleanCandidates(item: Pick<ScanInboxItem, "suggested_candidates">): ScanCandidate[] {
  const byKey = new Map<string, ScanCandidate>();
  for (const raw of item.suggested_candidates ?? []) {
    const c = raw.fields ? raw : { ...raw, fields: {} };
    const key = (c.label ?? "").trim().toLowerCase() || `${c.module}::${c.instance ?? ""}`;
    const prev = byKey.get(key);
    if (!prev || Object.keys(c.fields ?? {}).length > Object.keys(prev.fields ?? {}).length) byKey.set(key, c);
  }
  return [...byKey.values()];
}

/** Named but not yet routed: the router answers a moment after the lookup,
 *  and the one-tap destination is made of that answer. */
export function stillRouting(item: Pick<ScanInboxItem, "suggested_name" | "suggested_candidates">): boolean {
  return !!item.suggested_name && !(item.suggested_candidates ?? []).length;
}

/** Where one tap files this row: the candidate the row state resolved to,
 *  else the top one. Null when there is nothing to file into. */
export function oneTapDestination(
  item: Pick<ScanInboxItem, "suggested_candidates">,
  resolved:
    | { module: string; instance: string | null; kind?: string | null; label?: string; bundle_external_id?: string | null }
    | null
    | undefined,
): ScanCandidate | null {
  const cands = cleanCandidates(item);
  if (!resolved) return cands[0] ?? null;
  // The resolved destination is where the inbox files this row and what it
  // names, so the one tap files there under the same name. The first
  // candidate stood in when the destination was not among them, and the
  // camera said "Add to Inventory" (and filed there) for a grocery the inbox
  // would put in Groceries (#4146).
  const key = entryKey(resolved.module, resolved.instance);
  const match = cands.find((c) => entryKey(c.module, c.instance) === key);
  if (match) return resolved.label ? { ...match, label: resolved.label } : match;
  return {
    module: resolved.module,
    instance: resolved.instance,
    kind: resolved.kind ?? baseKind(resolved.module),
    label: resolved.label ?? resolved.module,
    confidence: 0,
    name: cands[0]?.name ?? "",
    fields: {},
    ...(resolved.bundle_external_id ? { bundle_external_id: resolved.bundle_external_id } : {}),
  } as ScanCandidate;
}

/** Install the destination's table if it is not there yet, then file the row
 *  with its scanned values as they are. */
export async function quickFileRow(
  slug: string,
  item: ScanInboxItem,
  dest: Pick<ScanCandidate, "module" | "instance" | "fields" | "quantity" | "bundle_external_id">,
): Promise<{ installed: BundleInstallSummary | null; filed: { item: ScanInboxItem; created: { id: string } } }> {
  if (!item.suggested_name) throw new Error("not ready to file: it has no name yet");
  let installed: BundleInstallSummary | null = null;
  const instance = await resolveInstanceForFiling(slug, dest.bundle_external_id, dest.instance, (sum) => {
    installed = sum;
  });
  const meta = (item.suggested_metadata as Record<string, unknown> | null) ?? {};
  const serial = String((meta as { serial_number?: unknown }).serial_number ?? "");
  const extras = {
    ...(item.suggested_manufacturer ? { manufacturer: item.suggested_manufacturer } : {}),
    ...(serial ? { serial_number: serial } : {}),
    ...(dest.fields && Object.keys(dest.fields).length ? { metadata: dest.fields } : {}),
  };
  const filed = await api.confirmScanItem(slug, item.id, {
    target_module: dest.module,
    target_kind: baseKind(dest.module),
    instance,
    name: item.suggested_name,
    quantity: item.quantity ?? dest.quantity ?? undefined,
    location_id: item.target_location_id ?? undefined,
    extras: Object.keys(extras).length ? extras : undefined,
  });
  return { installed: installed as BundleInstallSummary | null, filed };
}
