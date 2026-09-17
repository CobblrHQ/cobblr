// The workspace's scan menu as the row-state resolver reads it: the
// destination shape (instance, module, label, kind, the bundle it installs)
// beside the fit shape the router reads (noun, fields, scan_keywords,
// category_field), because the better-table question is answered by the
// router's one rule (scanBetterTable, #3136) and a table handed in without
// the fit shape can be filed into and labelled, never nudged to. One
// builder, so the card, the page's file-all check and a filed row's hint
// hand the resolver the same tables.
import type { ScanResolverTable } from "@cobblr/platform-contract/scan-triage";
import type { ScanMenuEntry } from "./api";

export function scanResolverTables(menu: readonly ScanMenuEntry[] | null | undefined): ScanResolverTable[] {
  return (menu ?? []).map((m) => ({
    ...m,
    instance_name: m.instance ?? m.module,
    display_name: m.label,
    module_name: m.module,
    keywords: m.scan_keywords ?? [],
    kind: m.kind,
    bundle_external_id: (m as { bundle_external_id?: string | null }).bundle_external_id ?? null,
  }));
}
