// The AI change ledger — the standing rule: auto-apply is only safe standing on
// perfect tracking + undo. EVERY write Ask Cobb executes (user-confirmed or
// auto-applied) goes through performWrite(), which captures a BEFORE-IMAGE and
// records a core_ai_chat_writes row; undoWrite() is then mechanical:
//   create → delete the record
//   update → restore exactly the fields that were changed, from the image
//   delete → recreate from the image (a NEW id — stated honestly)
//   action → recorded, NOT undoable (arbitrary side effects: print, adjust…)
// An undo is itself a ledger row (undo_of) — undoing an undo works.

import type { Kysely } from "kysely";
import { getTool, fetchKinds, resolveUpdatePath, resolveDeletePath, type WorkspaceApi } from "@cobblr/workspace-tools";
import type { CoreAiDB } from "../db.js";

export interface WriteRequest {
  tool: "create" | "update" | "delete" | "action";
  entity_kind: string;
  entity_id?: string;
  fields?: Record<string, unknown>;
  action_id?: string;
  args?: Record<string, unknown>;
}

export interface WriteOutcome {
  ok: boolean;
  message: string;
  entity?: { kind: string; id?: string };
  ledger_id?: string;
  undoable?: boolean;
}

interface RecordImage {
  title?: string;
  name?: string;
  fields?: Record<string, unknown>;
  [k: string]: unknown;
}

async function imageOf(wsApi: WorkspaceApi, kind: string, id: string): Promise<RecordImage | null> {
  const r = await getTool("get_record")!.execute(wsApi, { kind, id });
  return r.ok ? (r.data as RecordImage) : null;
}

function labelOfImage(img: RecordImage | null, fallback: string): string {
  return String(img?.title ?? img?.name ?? img?.fields?.title ?? img?.fields?.name ?? fallback);
}

/** Can this ledger row be undone? (Its own state + the kind's declared routes.) */
export function undoableOf(
  row: { tool: string; entity_kind: string; entity_id: string | null; undone_at: Date | null; before: unknown },
  kinds: Parameters<typeof resolveUpdatePath>[2],
): boolean {
  if (row.undone_at) return false;
  switch (row.tool) {
    case "create":
      return !!row.entity_id && resolveDeletePath(row.entity_kind, row.entity_id, kinds) !== null;
    case "update":
      return !!row.entity_id && !!row.before && resolveUpdatePath(row.entity_kind, row.entity_id, kinds) !== null;
    case "delete":
      return !!row.before; // recreate needs the image (create route re-checked at undo time)
    default:
      return false; // actions: side effects have no inverse
  }
}

/** Execute one write through the SHARED registry executors, capturing the
 *  before-image and recording the ledger row. The ONLY way chat writes run. */
export async function performWrite(
  wsApi: WorkspaceApi,
  db: Kysely<CoreAiDB>,
  userId: string,
  req: WriteRequest,
  opts: { auto: boolean; undoOf?: string },
): Promise<WriteOutcome> {
  const { tool, entity_kind } = req;

  if (tool === "action") {
    const r = await getTool("invoke_action")!.execute(wsApi, {
      action_id: req.action_id ?? "",
      entity_kind,
      entity_id: req.entity_id ?? "",
      args: req.args,
    });
    if (!r.ok) return { ok: false, message: r.error ?? "Action failed." };
    const row = await db
      .insertInto("core_ai_chat_writes")
      .values({
        user_id: userId,
        tool: "action",
        entity_kind,
        entity_id: req.entity_id ?? null,
        entity_label: req.action_id ?? "",
        before: null,
        payload: JSON.stringify({ action_id: req.action_id, args: req.args ?? null }) as unknown,
        auto_applied: opts.auto,
        undone_at: null,
        undo_of: opts.undoOf ?? null,
      })
      .returning("id")
      .executeTakeFirst();
    return { ok: true, message: "Done.", ledger_id: row?.id, undoable: false };
  }

  if (tool === "create") {
    const r = await getTool("create_record")!.execute(wsApi, { kind: entity_kind, fields: req.fields ?? {} });
    if (!r.ok) return { ok: false, message: r.error ?? "Create failed." };
    const created = r.data as { id?: string; name?: string; title?: string };
    const label = String(created.title ?? created.name ?? req.fields?.title ?? req.fields?.name ?? entity_kind);
    const row = await db
      .insertInto("core_ai_chat_writes")
      .values({
        user_id: userId,
        tool: "create",
        entity_kind,
        entity_id: created.id ? String(created.id) : null,
        entity_label: label,
        before: null,
        payload: JSON.stringify(req.fields ?? {}) as unknown,
        auto_applied: opts.auto,
        undone_at: null,
        undo_of: opts.undoOf ?? null,
      })
      .returning("id")
      .executeTakeFirst();
    return {
      ok: true,
      message: `Created ${label}.`,
      entity: { kind: entity_kind, id: created.id ? String(created.id) : undefined },
      ledger_id: row?.id,
      undoable: !!created.id,
    };
  }

  // update / delete need the record's id + a before-image FIRST.
  const id = String(req.entity_id ?? "");
  if (!id) return { ok: false, message: "Missing record id." };
  const before = await imageOf(wsApi, entity_kind, id);
  if (!before) return { ok: false, message: "Couldn't read the record before changing it: nothing was done." };
  const label = labelOfImage(before, id);

  if (tool === "update") {
    const r = await getTool("update_record")!.execute(wsApi, { kind: entity_kind, id, fields: req.fields ?? {} });
    if (!r.ok) return { ok: false, message: r.error ?? "Update failed." };
    const row = await db
      .insertInto("core_ai_chat_writes")
      .values({
        user_id: userId,
        tool: "update",
        entity_kind,
        entity_id: id,
        entity_label: label,
        before: JSON.stringify(before) as unknown,
        payload: JSON.stringify(req.fields ?? {}) as unknown,
        auto_applied: opts.auto,
        undone_at: null,
        undo_of: opts.undoOf ?? null,
      })
      .returning("id")
      .executeTakeFirst();
    return { ok: true, message: "Updated.", entity: { kind: entity_kind, id }, ledger_id: row?.id, undoable: true };
  }

  // delete
  const r = await getTool("delete_record")!.execute(wsApi, { kind: entity_kind, id });
  if (!r.ok) return { ok: false, message: r.error ?? "Delete failed." };
  const row = await db
    .insertInto("core_ai_chat_writes")
    .values({
      user_id: userId,
      tool: "delete",
      entity_kind,
      entity_id: id,
      entity_label: label,
      before: JSON.stringify(before) as unknown,
      payload: null,
      auto_applied: opts.auto,
      undone_at: null,
      undo_of: opts.undoOf ?? null,
    })
    .returning("id")
    .executeTakeFirst();
  return { ok: true, message: `Deleted ${label}.`, entity: { kind: entity_kind, id }, ledger_id: row?.id, undoable: true };
}

function parseJsonb<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === "object") return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return null;
  }
}

/** Revert one ledger row. The undo runs through performWrite itself, so it is
 *  ledgered too (undo_of) — undoing an undo works. */
export async function undoWrite(
  wsApi: WorkspaceApi,
  db: Kysely<CoreAiDB>,
  userId: string,
  writeId: string,
): Promise<WriteOutcome> {
  const row = await db
    .selectFrom("core_ai_chat_writes")
    .selectAll()
    .where("id", "=", writeId)
    .executeTakeFirst();
  if (!row) return { ok: false, message: "No such change." };
  if (row.undone_at) return { ok: false, message: "Already undone." };

  const before = parseJsonb<RecordImage>(row.before);
  const payload = parseJsonb<Record<string, unknown>>(row.payload);
  let outcome: WriteOutcome;

  switch (row.tool) {
    case "create": {
      if (!row.entity_id) return { ok: false, message: "This create can't be undone (no record id)." };
      outcome = await performWrite(
        wsApi,
        db,
        userId,
        { tool: "delete", entity_kind: row.entity_kind, entity_id: row.entity_id },
        { auto: false, undoOf: row.id },
      );
      break;
    }
    case "update": {
      if (!row.entity_id || !before) return { ok: false, message: "This update can't be undone (no before-image)." };
      // Restore exactly the fields the write changed, from the image.
      const changedKeys = Object.keys(payload ?? {});
      const fields: Record<string, unknown> = {};
      for (const k of changedKeys) fields[k] = (before.fields ?? before)[k] ?? null;
      outcome = await performWrite(
        wsApi,
        db,
        userId,
        { tool: "update", entity_kind: row.entity_kind, entity_id: row.entity_id, fields },
        { auto: false, undoOf: row.id },
      );
      break;
    }
    case "delete": {
      if (!before) return { ok: false, message: "This delete can't be undone (no before-image)." };
      const image = (before.fields ?? before) as Record<string, unknown>;
      // Recreate with only the kind's DECLARED fields — the resolved image also
      // carries system/computed keys the create schema would reject.
      const kinds = await fetchKinds(wsApi).catch(() => []);
      const declared = new Set((kinds.find((k) => k.id === row.entity_kind)?.fields ?? []).map((f) => f.name));
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(image)) {
        if ((declared.size === 0 || declared.has(k)) && v !== undefined && v !== null && k !== "id") fields[k] = v;
      }
      outcome = await performWrite(
        wsApi,
        db,
        userId,
        { tool: "create", entity_kind: row.entity_kind, fields },
        { auto: false, undoOf: row.id },
      );
      if (outcome.ok) outcome.message = `Recreated ${row.entity_label} (as a new record).`;
      break;
    }
    default:
      return { ok: false, message: "Actions can't be undone: they have real-world side effects." };
  }

  if (outcome.ok) {
    await db
      .updateTable("core_ai_chat_writes")
      .set({ undone_at: new Date() })
      .where("id", "=", row.id)
      .execute();
  }
  return outcome;
}

export { fetchKinds };
