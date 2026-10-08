import { AsyncLocalStorage } from "node:async_hooks";
import type { Kysely } from "kysely";
import { SecretPresencePlugin, type SecretPresence } from "@cobblr/platform-contract/secret-presence-sql";

const scope = new AsyncLocalStorage<{ orgId: string; table: string; fields: readonly SecretPresence[] }>();
export function runSecretPresence<T>(orgId: string, table: string, fields: readonly SecretPresence[], run: () => T): T {
  return scope.run({ orgId, table, fields }, run);
}
export function secretPresenceDb<T>(orgId: string, db: Kysely<T>): Kysely<T> {
  const current = scope.getStore();
  return current?.orgId === orgId ? db.withPlugin(new SecretPresencePlugin(current.table, current.fields)) : db;
}
