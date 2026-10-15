import { sql } from "kysely";

export function poolGroupCondition(config: "config" | "p.config" = "config") {
  return sql<boolean>`${sql.ref(config)} ->> 'run_id' is null`;
}
