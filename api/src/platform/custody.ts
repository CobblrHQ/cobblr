// A thing lent out, and back (#6335).
//
// One door for every kind, and an overlay, never an edit: the kernel writes
// the loan into the record's own metadata (LOAN_KEY) and touches nothing
// else. Its place stays the place it returns to, its state stays what it was;
// "lent out" is read from the open loan. The owner's Dremel went to Sam
// Lai for a repair, and recording that by clearing the location and
// overwriting the state is what this replaces. History keeps every loan.

import { switchFaceOn } from "./faces.js";
import { platform, PLATFORM_OWNER } from "@cobblr/platform-contract";
import { LOAN_KEY, loanOfFields, readRecordLoan, sayLoan, type RecordLoan } from "@cobblr/platform-contract/loan";
import * as activity from "./activity.js";
import { sql, type Kysely } from "kysely";
import type { CalendarEvent, EntityWriter } from "@cobblr/platform-contract";
import { personNamesFor } from "./people.js";
import { registerSource } from "./calendar-registry.js";
import { baseKindOf, detailPathForEntity, getEntityWriterFor, listKindsForOrg, lookup, titleForEntity } from "./entities.js";
import { isRealDay } from "@cobblr/platform-contract/day";

export interface LendDetails {
  /** Who has it, as said; filled from the People entry when only holder_id is given. */
  holder?: string | null;
  expected_loan?: RecordLoan | null;
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

export interface ReturnDetails {
  onlyIfHolder?: string | null;
  repaired?: boolean;
  work?: string | null;
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


/** Lend these records to someone. Refuses the whole call, before writing,
 *  when a record is missing: half a batch lent is worse than none. Lending a
 *  thing that is already out requires its current loan as expected_loan;
 *  the History keeps both. */
export async function lend(
  orgId: string,
  userId: string | null,
  kind: string,
  ids: readonly string[],
  details: LendDetails,
): Promise<{ ok: true; done: CustodyOutcome[]; holder: string; loan: RecordLoan } | { ok: false; error: string }> {
  const holderId = details.holder_id?.trim() || null;
  const holder = details.holder?.trim() || (holderId ? ((await personNamesFor(orgId).catch(() => new Map<string, string>())).get(holderId) ?? "") : "");
  if (!holder) return { ok: false as const, error: holderId ? "no one on the People list has that id" : "who has it (holder) is required" };
  if (details.due_back && !isRealDay(details.due_back.slice(0, 10))) return { ok: false as const, error: "due_back is a day that exists, YYYY-MM-DD" };
  if (details.since && !isRealDay(details.since.slice(0, 10))) return { ok: false as const, error: "since is a day that exists, YYYY-MM-DD" };
  if (details.due_back && details.since && details.due_back.slice(0, 10) < details.since.slice(0, 10)) {
    return { ok: false as const, error: "due_back is before the day it was lent (since)" };
  }
  return platform().exclusive.serial(`custody:${orgId}`, async () => {
    const f = await found(orgId, kind, ids);
    if (!f.ents) return { ok: false as const, error: f.error };
    const changed = f.ents.find((ent) => JSON.stringify(loanOfFields(ent.fields)) !== JSON.stringify(readRecordLoan({ loan: details.expected_loan })));
    if (changed) return { ok: false as const, error: `${changed.title} is already lent out or its loan changed. Review the current loan before transferring it.` };
    const today = await platform().accounts.dayFor(userId);
    // A kind nobody lent before wears the Lending face from now on.
    await switchFaceOn(orgId, kind, "lendable").catch((err) => console.error(`[custody] Lending face for ${kind}:`, (err as Error).message));
    const done: CustodyOutcome[] = [];
    const loan: RecordLoan = {
      holder,
      holder_id: holderId,
      reason: details.reason?.trim() || null,
      // A loan recorded after its due day began no later than that day: leaving
      // the day it is recorded as its start would date it after its own due day.
      since: details.since ? details.since.slice(0, 10) : details.due_back && details.due_back.slice(0, 10) < today ? details.due_back.slice(0, 10) : today,
      due_back: details.due_back ? details.due_back.slice(0, 10) : null,
      note: details.note?.trim() || null,
    };
    for (const ent of f.ents) {
      const fields = (ent.fields ?? {}) as Record<string, unknown>;
      const before = loanOfFields(fields);
      await platform().entities.mergeMetadata(orgId, kind, ent.id, { [LOAN_KEY]: loan });
      await f.writer.onLoan?.(orgId, ent.id, { holder_id: loan.holder_id, due_back: loan.due_back });
      await activity.log({ orgId, userId, action: LENT, ref: await refOf(orgId, kind, ent.id), diff: { name: ent.title, said: sayLoan(loan), ...loan } });
      done.push({ id: ent.id, title: ent.title, before });
    }
    return { ok: true as const, done, holder, loan };
  });
}

/** It is back: the loan ends, and the record is as it was, at its own place,
 *  in its own state. A record that was not out is refused by name. */
export async function returnLoan(
  orgId: string,
  userId: string | null,
  kind: string,
  ids: readonly string[],
  details: ReturnDetails = {},
): Promise<{ ok: true; done: CustodyOutcome[] } | { ok: false; error: string }> {
  return platform().exclusive.serial(`custody:${orgId}`, async () => {
    const f = await found(orgId, kind, ids);
    if (!f.ents) return { ok: false as const, error: f.error };
    const home = f.ents.find((e) => !loanOfFields(e.fields));
    if (home) return { ok: false as const, error: `${home.title} is not lent out.` };
    // A loan's own Undo ends that loan and no other: lent again since, it is
    // someone else's loan now, and ending it would say the thing is on its
    // shelf while a borrower has it (#7899).
    if (details.onlyIfHolder) {
      const moved = f.ents.find((e) => loanOfFields(e.fields)?.holder !== details.onlyIfHolder);
      if (moved) return { ok: false as const, error: `${moved.title} was lent to ${loanOfFields(moved.fields)?.holder ?? "someone else"} since, so this Undo would end their loan. Nothing was changed.` };
    }
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
        diff: {
          name: ent.title, said: `Back from ${before.holder}`, holder: before.holder, reason: before.reason, since: before.since,
          ...(typeof details.repaired === "boolean" ? { repaired: details.repaired } : {}),
          ...(details.work?.trim() ? { work: details.work.trim() } : {}),
        },
      });
      done.push({ id: ent.id, title: ent.title, before });
    }
    return { ok: true as const, done };
  });
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
  registerSource("loans", loanCalendarEvents, { module: PLATFORM_OWNER });
}
