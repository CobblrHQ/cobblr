// The one SQL for a partial write to a jsonb bag (contract: jsonb-merge.ts).
// `coalesce(col,'{}') || {set}` then `- key` for each removal: evaluated
// against the live row inside the UPDATE, so two edits to different keys of
// one record both land however close together they arrive (#3625).
import { sql, type RawBuilder } from "kysely";
import { jsonbMergePlan } from "@cobblr/platform-contract/jsonb-merge";

export function mergeJsonb(column: string, fields: Record<string, unknown>): RawBuilder<Record<string, unknown>> {
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) throw new Error(`mergeJsonb: not a column name: ${column}`);
  const plan = jsonbMergePlan(fields);
  // Each step in its own parens: `-` binds tighter than `||` in Postgres, so
  // `a || b - 'k'` removes k from b (where it never is) and leaves it on a.
  let expr = sql<Record<string, unknown>>`coalesce(${sql.ref(column)}, '{}'::jsonb)`;
  if (Object.keys(plan.set).length > 0) expr = sql<Record<string, unknown>>`(${expr} || ${JSON.stringify(plan.set)}::jsonb)`;
  for (const k of plan.remove) expr = sql<Record<string, unknown>>`(${expr} - ${k}::text)`;
  return expr;
}
