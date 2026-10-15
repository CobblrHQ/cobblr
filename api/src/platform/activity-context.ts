import { sql, type Kysely } from "kysely";
import type { TenantDB } from "../db/tenant-schema.js";
import type { ActivityEntry } from "./activity.js";

export interface ActivityFileContext {
  scan?: { id: string; name: string | null; barcode: string | null; kind: string | null; recordId: string | null };
  record?: { kind: string; id: string };
  photoId?: string;
}

export async function activityFileContexts(db: Kysely<TenantDB>, items: readonly ActivityEntry[]): Promise<Map<string, ActivityFileContext>> {
  const files = [...new Set(items.filter(i => i.action === "file_created").map(i => i.entity_id))];
  const scans = [...new Set(items.filter(i => i.action === "scan_committed" || i.action === "scan_received").map(i => i.entity_id))];
  const out = new Map<string, ActivityFileContext>();
  if (!files.length && !scans.length) return out;
  const tables = await sql<{ scans: string | null; attachments: string | null }>`select to_regclass('core_scan_inbox_items')::text as scans, to_regclass('core_files_attachments')::text as attachments`.execute(db);
  if (tables.rows[0]?.scans) {
    const result = await sql<{ id: string; image_file_id: string | null; catalog_image_file_id: string | null; name: string | null; barcode: string | null; kind: string | null; record_id: string | null }>`
      select id, image_file_id, catalog_image_file_id, suggested_name as name, barcode_text as barcode,
        case when target_module is not null and target_kind is not null then target_module || ':' || target_kind else null end as kind,
        target_entity_id as record_id
      from core_scan_inbox_items
      where id::text = any(${scans}::text[]) or image_file_id::text = any(${files}::text[])
      order by created_at desc`.execute(db);
    for (const r of result.rows) {
      // Its own photo, else the catalog's picture a barcode found (#6564: a
      // day of barcode scans read as letter tiles).
      const photo = r.image_file_id ?? r.catalog_image_file_id;
      const context: ActivityFileContext = { scan: { id: r.id, name: r.name, barcode: r.barcode, kind: r.kind, recordId: r.record_id }, ...(photo ? { photoId: photo } : {}) };
      out.set(`scan_committed:${r.id}`, context);
      out.set(`scan_received:${r.id}`, context);
      if (r.image_file_id && !out.has(`file_created:${r.image_file_id}`)) out.set(`file_created:${r.image_file_id}`, context);
    }
  }
  if (files.length && tables.rows[0]?.attachments) {
    const result = await sql<{ file_id: string; source_module: string; source_type: string; source_id: string }>`
      select file_id, source_module, source_type, source_id from core_files_attachments
      where file_id::text = any(${files}::text[]) order by created_at desc`.execute(db);
    for (const r of result.rows) {
      const key = `file_created:${r.file_id}`;
      if (!out.has(key)) out.set(key, { record: { kind: `${r.source_module}:${r.source_type}`, id: r.source_id }, photoId: r.file_id });
    }
  }
  return out;
}
