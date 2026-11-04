// The one rule every bulk door holds a row to (#9179). "Add all 29 to Spices" held
// agave syrup and sugar cubes. A row's card may still offer that table, whoever
// chose it, because one tap there files one thing the person can see. A bulk door
// files what they have not looked at, so it takes only rows whose own words tie
// them to the table.

import type { ScanResolverTable } from "@cobblr/platform-contract/scan-triage";
import { makeLexicalScorer, nounSaysWhatItIs, type FitTable } from "@cobblr/platform-contract/table-fit";

export interface BulkDoubtRow {
  suggested_name?: string | null;
  suggested_metadata?: unknown;
}

/** Why a bulk door leaves this row for a person, or null when it may file it. Only
 *  a table that says what its things are can be judged: a catch-all, or a table
 *  with no vocabulary of its own, has nothing to hold a row against. */
export function bulkDoubt(row: BulkDoubtRow, destination: { module?: string | null; instance?: string | null } | null | undefined, tables: readonly ScanResolverTable[]): string | null {
  if (!destination?.instance) return null;
  const table = tables.find((t) => t.module_name === destination.module && t.instance_name === destination.instance) as (ScanResolverTable & FitTable) | undefined;
  if (!table?.noun || (!nounSaysWhatItIs(table) && !table.scan_keywords?.length)) return null;
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const name = String(row.suggested_name ?? "");
  const evidence = makeLexicalScorer({
    name,
    category: typeof meta.category === "string" ? meta.category : null,
    manufacturer: typeof meta.manufacturer === "string" ? meta.manufacturer : null,
    description: typeof meta.description === "string" ? meta.description : null,
  }).scoreEntry({ ...table, fields: table.fields ?? [] });
  if (evidence.plausible || evidence.nounHit || evidence.categoryNames) return null;
  return `nothing about "${name || "this"}" says it belongs in ${table.label ?? table.instance_name}; file it on its own if it does`;
}
