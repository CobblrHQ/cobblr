// Kysely types for a tenant DB. Mirrors migrations/tenant-base/*.sql.
// Modules will declare their own table types in module.ts when they
// land; for now the only shared table is platform_local.

import type { Generated } from "kysely";

export interface PlatformLocalTable {
  key: string;
  value: unknown; // JSONB — narrow at the call site
  updated_at: Generated<Date>;
}

export interface MigrationsTable {
  id: Generated<number>;
  name: string;
  applied_at: Generated<Date>;
}

export interface TenantDB {
  platform_local: PlatformLocalTable;
  migrations: MigrationsTable;
}
