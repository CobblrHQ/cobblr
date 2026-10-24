import { z } from "zod";
import type { FilterPredicate } from "@cobblr/platform-contract";

type ListWhereQuery = { where: FilterPredicate[] | undefined; error?: never }
  | { error: { code: "invalid_query"; message: string }; where?: never };

const text = z.record(z.string().max(200));
const presence = z.record(z.enum(["empty", "has_value"]));

export function listWhereQuery(query: Record<string, unknown>): ListWhereQuery {
  const where: FilterPredicate[] = [];
  for (const name of ["presence", "contains", "not_contains"] as const) {
    if (query[name] === undefined) continue;
    const parsed = (name === "presence" ? presence : text).safeParse(query[name]);
    if (!parsed.success) {
      const syntax = name === "presence"
        ? "Use presence[field]=empty or presence[field]=has_value."
        : `Use ${name}[field]=value with text up to 200 characters.`;
      return { error: { code: "invalid_query", message: syntax } };
    }
    for (const [col, value] of Object.entries(parsed.data)) {
      where.push(name === "presence"
        ? { col, op: value === "empty" ? "empty" : "not_empty" }
        : { col, op: name, value });
    }
  }
  return { where: where.length ? where : undefined };
}
