// A thing lent out, and back (#6335).
//
// One door for every kind, and an overlay, never an edit: the kernel writes
// the loan into the record's own metadata (LOAN_KEY) and touches nothing
// else. Its place stays the place it returns to, its state stays what it was;
// "lent out" is read from the open loan. The owner's Dremel went to Sam
// Lai for a repair, and recording that by clearing the location and
// overwriting the state is what this replaces. History keeps every loan.

import { switchFaceOn } from "./faces.js";
import { platform } from "@cobblr/platform-contract";
import { LOAN_KEY, loanOfFields, readRecordLoan, sayLoan, type RecordLoan } from "@cobblr/platform-contract/loan";
import * as activity from "./activity.js";
import { sql, type Kysely } from "kysely";
import type { CalendarEvent, EntityWriter } from "@cobblr/platform-contract";
import { personNamesFor } from "./people.js";
import { registerSource } from "./calendar-registry.js";
import { baseKindOf, detailPathForEntity, getEntityWriterFor, listKindsForOrg, lookup, titleForEntity } from "./entities.js";

export interface LendDetails {
  /** Who has it, as said; filled from the People entry when only holder_id is given. */
  holder?: string | null;
  holder_id?: string | null;
  reason?: string | null;
  since?: string | null;
  due_back?: string | null;
  note?: string | null;
}

export interface CustodyOutcome {
  id: string;
  title: string;
  /** The loan before this call, so an undo puts exactly that back. */
  before: RecordLoan | null;
}

export const LENT = "record_lent";

/** A kind can be lent when its writer keeps metadata AND names its table: a
 *  loan written where listOpenLoans cannot find it would never come due,
 *  never show as lent out, and never pause anything. */
export function isLendable(writer: { mergeMetadata?: unknown; table?: string } | null | undefined): boolean {
  return !!writer?.mergeMetadata && !!writer.table;
}
export const RETURNED = "record_returned";

async function refOf(orgId: string, kind: string, id: string) {
  const [module, type] = (await baseKindOf(orgId, kind)).split(":");
  return { module: module ?? null, entityType: type ?? kind, entityId: id };
}

type Found = Awaited<ReturnType<typeof lookup>> & {};

async function found(orgId: string, kind: string, ids: readonly string[]): Promise<{ ents: Found[]; writer: EntityWriter } | { error: string; ents?: undefined }> {
  const writer = await platform().entities.getWriter(orgId, kind).catch(() => null);
  if (!writer || !isLendable(writer)) return { error: `${kind} records cannot be lent out here` };
  const out: Found[] = [];
  for (const id of ids) {
    const ent = await lookup(orgId, kind, id);
    if (!ent) return { error: `no ${kind} record with id ${id}` };
    out.push(ent);
  }
  return { ents: out, writer };
}

const DAY = /^\d{4}-\d{2}-\d{2}/;

/** Lend these records to someone. Refuses the whole call, before writing,
 *  when a record is missing: half a batch lent is worse than none. Lending a
 *  thing that is already out to someone else replaces the loan (it moved on);
 *  the History keeps both. */
export async function lend(
  orgId: string,
  userId: string | null,
  kind: string,
  ids: readonly string[],
  details: LendDetails,
): Promise<{ ok: true; done: CustodyOutcome[]; holder: string } | { ok: false; error: string }> {
  const holderId = details.holder_id?.trim() || null;
  const holder = details.holder?.trim() || (holderId ? ((await personNamesFor(orgId).catch(() => new Map<string, string>())).get(holderId) ?? "") : "");
  if (!holder) return { ok: false, error: holderId ? "no one on the People list has that id" : "who has it (holder) is required" };
  if (details.due_back && !DAY.test(details.due_back)) return { ok: false, error: "due_back is a day, YYYY-MM-DD" };
  const f = await found(orgId, kind, ids);
  if (!f.ents) return { ok: false, error: f.error };
  const today = await platform().accounts.dayFor(userId);
  // A kind nobody lent before wears the Lending face from now on.
  await switchFaceOn(orgId, kind, "lendable").catch((err) => console.error(`[custody] Lending face for ${kind}:`, (err as Error).message));
  const done: CustodyOutcome[] = [];
  for (const ent of f.ents) {
    const fields = (ent.fields ?? {}) as Record<string, unknown>;
    const before = loanOfFields(fields);
    const loan: RecordLoan = {
      holder,
      holder_id: holderId,
      reason: details.reason?.trim() || null,
      since: details.since && DAY.test(details.since) ? details.since.slice(0, 10) : today,
      due_back: details.due_back ? details.due_back.slice(0, 10) : null,
      note: details.note?.trim() || null,
    };
    await platform().entities.mergeMetadata(orgId, kind, ent.id, { [LOAN_KEY]: loan });
    await f.writer.onLoan?.(orgId, ent.id, { holder_id: loan.holder_id, due_back: loan.due_back });
    await activity.log({ orgId, userId, action: LENT, ref: await refOf(orgId, kind, ent.id), diff: { name: ent.title, said: sayLoan(loan), ...loan } });
    done.push({ id: ent.id, title: ent.title, before });
  }
  return { ok: true, done, holder };
}

/** It is back: the loan ends, and the record is as it was, at its own place,
 *  in its own state. A record that was not out is refused by name. */
export async function returnLoan(
  orgId: string,
  userId: string | null,
  kind: string,
  ids: readonly string[],
): Promise<{ ok: true; done: CustodyOutcome[] } | { ok: false; error: string }> {
  const f = await found(orgId, kind, ids);
  if (!f.ents) return { ok: false, error: f.error };
  const home = f.ents.find((e) => !loanOfFields(e.fields));
  if (home) return { ok: false, error: `${home.title} is not lent out.` };
  const done: CustodyOutcome[] = [];
  for (const ent of f.ents) {
    const before = loanOfFields(ent.fields)!;
    await platform().entities.mergeMetadata(orgId, kind, ent.id, { [LOAN_KEY]: null });
    await f.writer.onLoan?.(orgId, ent.id, null);
    await activity.log({
      orgId,
      userId,
      action: RETURNED,
      ref: await refOf(orgId, kind, ent.id),
      diff: { name: ent.title, said: `Back from ${before.holder}`, holder: before.holder, reason: before.reason, since: before.since },
    });
    done.push({ id: ent.id, title: ent.title, before });
  }
  return { ok: true, done };
}

export interface OpenLoan {
  kind: string;
  id: string;
  title: string;
  loan: RecordLoan;
  /** The kind dates it in a field of its own (EntityWriter.loanDueField),
   *  which reaches the calendar and Needs you already. */
  dueElsewhere: boolean;
}

/** Every thing lent out in a workspace, whatever kind: the one read behind
 *  attention, the calendar, the "lent out" filter and what a loan pauses. A
 *  loan lives in each record's own table (LOAN_KEY in its metadata), so this
 *  asks each table the workspace's kinds write to, once, and a kind whose
 *  module is off (its table absent) contributes nothing. */
export async function listOpenLoans(orgId: string, opts: { kind?: string } = {}): Promise<OpenLoan[]> {
  const kinds = (await listKindsForOrg(orgId).catch(() => []))
    .map((r) => ({ kind: r.id.includes(":") ? r.id : `${r.module_name}:${r.id}`, module: r.module_name }))
    // A module's own kind before its instances (a Bookshelf shares the parts
    // table), so a row is named by the kind that owns its table.
    .sort((a, b) => Number(!a.kind.startsWith(`${a.module}:`)) - Number(!b.kind.startsWith(`${b.module}:`)));
  const tables = new Map<string, { kind: string; dueElsewhere: boolean }>();
  for (const { kind } of kinds) {
    if (opts.kind && kind !== opts.kind) continue;
    const writer = await getEntityWriterFor(orgId, kind).catch(() => null);
    const table = writer?.table;
    if (table && /^[a-z_][a-z0-9_]*$/.test(table) && !tables.has(table)) tables.set(table, { kind, dueElsewhere: !!writer?.loanDueField });
  }
  if (!tables.size) return [];
  const db = (await platform().tenants.getDb(orgId)) as Kysely<Record<string, never>>;
  const out: OpenLoan[] = [];
  for (const [table, { kind, dueElsewhere }] of tables) {
    let rows: Array<{ id: string; loan: unknown }>;
    try {
      rows = (
        await sql<{ id: string; loan: unknown }>`select id::text as id, metadata -> ${LOAN_KEY} as loan from ${sql.table(table)} where jsonb_typeof(metadata -> ${LOAN_KEY}) = 'object'`.execute(db)
      ).rows;
    } catch (err) {
      if (/does not exist/.test((err as Error).message)) continue;
      throw err;
    }
    for (const r of rows) {
      const loan = readRecordLoan({ [LOAN_KEY]: r.loan });
      if (!loan) continue;
      out.push({ kind, id: r.id, title: (await titleForEntity(orgId, kind, r.id).catch(() => null)) ?? kind, loan, dueElsewhere });
    }
  }
  return out;
}

/** The loan on one record, or null while it is home. */
export async function loanOf(orgId: string, kind: string, id: string): Promise<RecordLoan | null> {
  const ent = await lookup(orgId, kind, id).catch(() => null);
  return ent ? loanOfFields(ent.fields) : null;
}

/** A thing due back is a day on the calendar: "Dremel due back from Sam Lee". */
export async function loanCalendarEvents(orgId: string, fromISO: string, toISO: string): Promise<CalendarEvent[]> {
  const from = fromISO.slice(0, 10);
  const to = toISO.slice(0, 10);
  const due = (await listOpenLoans(orgId)).filter((l) => !l.dueElsewhere && l.loan.due_back && l.loan.due_back >= from && l.loan.due_back <= to);
  return Promise.all(
    due.map(async (l) => {
      const [entityModule, entityType] = l.kind.split(":");
      return {
        id: `loans:${l.id}:${l.loan.due_back}`,
        title: `${l.title} due back from ${l.loan.holder}`,
        date: l.loan.due_back!,
        allDay: true,
        source: "loans",
        sourceLabel: "Lent out",
        direction: "due" as const,
        category: "loans",
        entityModule,
        entityType,
        entityId: l.id,
        detailUrl: (await detailPathForEntity(orgId, l.kind, l.id).catch(() => undefined)) ?? undefined,
      };
    }),
  );
}

export function registerLoanCalendar(): void {
  registerSource("loans", loanCalendarEvents);
}
