// Kysely table types for the labels module's tenant tables.
// Mirrors migrations/0001_init.sql.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface LabelsTemplatesTable {
  id: Generated<string>;
  entity_kind: string;
  description_template: string;
  is_default: Generated<boolean>;
  updated_at: Generated<Date>;
}

export interface LabelsQueueTable {
  id: Generated<string>;
  user_id: string | null;
  module_name: string;
  entity_type: string;
  entity_id: string;
  qr_payload: string;
  description: string;
  qty: Generated<number>;
  created_at: Generated<Date>;
}

export interface LabelsBatchesTable {
  id: Generated<string>;
  user_id: string | null;
  created_at: Generated<Date>;
  printed_at: Date | null;
}

export interface LabelsPrintsTable {
  id: Generated<string>;
  batch_id: string;
  module_name: string;
  entity_type: string;
  entity_id: string;
  qr_payload: string;
  description: string;
  qty: number;
  printed_at: Generated<Date>;
}

// Human-readable label codes (see migrations/0002_codes.sql).
export interface LabelsCodeConfigTable {
  entity_kind: string;
  group_field: Generated<string>;
  // Draw the human-readable code inside the QR center for this kind. Default
  // true; a user turns it off for singular kinds (see 0003_overlay_center.sql).
  overlay_center: Generated<boolean>;
  updated_at: Generated<Date>;
}

export interface LabelsCodePrefixesTable {
  group_key: string;
  entity_kind: string;
  prefix: string;
  label: string | null;
  next_seq: Generated<number>;
  frozen: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LabelsCodesTable {
  entity_kind: string;
  entity_id: string;
  group_key: string;
  prefix: string;
  seq: number;
  code: string;
  created_at: Generated<Date>;
}

/** A workspace-defined label size (migration 0005). Stores DIMENSIONS only, in
 *  inches; the col x row grid is derived (deriveGrid), never stored. */
export interface LabelsCustomSizesTable {
  id: Generated<string>;
  name: string;
  media_w: string; // numeric comes back from pg as a string
  media_h: string;
  label_w: string;
  label_h: string;
  margin_t: Generated<string>;
  margin_l: Generated<string>;
  col_gap: Generated<string>;
  row_gap: Generated<string>;
  created_by_user_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Per-user accumulate-then-print policy (migration 0006). One row per user; the
 *  queue-insert handler evaluates flush-policy.ts against it. */
export interface LabelsAutoflushTable {
  user_id: string;
  enabled: Generated<boolean>;
  printer_id: string | null;
  size_key: string | null;
  fire_mode: Generated<string>;
  fire_count: Generated<number>;
  last_fired_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LabelsDB {
  labels_templates: LabelsTemplatesTable;
  labels_queue: LabelsQueueTable;
  labels_batches: LabelsBatchesTable;
  labels_prints: LabelsPrintsTable;
  labels_code_config: LabelsCodeConfigTable;
  labels_code_prefixes: LabelsCodePrefixesTable;
  labels_codes: LabelsCodesTable;
  labels_custom_sizes: LabelsCustomSizesTable;
  labels_autoflush: LabelsAutoflushTable;
}

export type OrgRole = "owner" | "admin" | "member" | "guest";

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRole;
    db: unknown;
  };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<LabelsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("labels route called without tenant context");
  return t.db as Kysely<LabelsDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("labels route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request) {
  const s = (req as unknown as RequestWithTenant).session;
  if (!s) throw new Error("labels route called without session");
  return s;
}
