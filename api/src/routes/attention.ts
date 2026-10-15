// GET /orgs/:slug/attention — the dashboard's "what needs me" feed (redesign
// B2). Derived ENTIRELY from field semantics the workspace's trackers already
// declare (derive-from-fields, zero per-bundle code):
//
//   · low stock     — inventory-family items where qty ≤ min_qty
//   · overdue/due   — any tracker whose field defs include a date field whose
//                     name/label reads like a deadline (renew/expire/due/
//                     refill/return/service/maintain); items with that date
//                     overdue or within the next 30 days
//   · pending scans — the capture inbox
//
// Aggregates over the SAME public per-module HTTP endpoints the web client
// uses (quickstart.ts precedent) — the host never reaches into module tables.
// Small workspaces by design: caps at 15 instances × 200 items; the client
// caches for 30s.
import { listTidySuggestions } from "../platform/tidy-suggestions.js";
import type { TidyCandidate } from "@cobblr/platform-contract";
import { Router } from "express";
import { readAttentionCollection } from "./attention-reads.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { facesForKind } from "../platform/faces.js";
import { listApplicable } from "../platform/actions.js";
import { detailPathForEntity, titleForEntity } from "../platform/entities.js";
import { hasPrimaryRouter } from "../modules/mount.js";
import { countdownWords, fieldDay, fieldDayUnreadable, viewQuery } from "@cobblr/platform-contract";
import { dueState, todayFrom } from "../lib/due-day.js";
import { listShareEdits } from "../platform/share-edits.js";
import { listAdditions } from "../platform/share-additions.js";
import { listOpenLoans, type OpenLoan } from "../platform/custody.js";
import { daysUntil } from "@cobblr/platform-contract/day";
import { apiFetch, selfOrigin } from "@cobblr/platform-contract/self-api";

export const attentionRouter = Router({ mergeParams: true });

const INTERNAL_API = selfOrigin();
const DUE_RE = /(renew|expir|due|refill|return|service|maintain|deadline)/i;
const WINDOW_DAYS = 30;
const INSTANCE_CAP = 15;
const ITEM_CAP = 200;

/** The instances whose items this feed reads: domain modules only, and only
 *  those that answer an items request. A module with no primary router
 *  (`lists`, `digifab`, the hosted overlay) has a default instance like any
 *  other, and asking it is a 501 over loopback per instance per poll, which
 *  the error counter read as failures (#3044). Decided here, in process. */
export function instancesToAsk<T extends { module_name: string }>(rows: T[], answersItems: (moduleName: string) => boolean): T[] {
  return rows.filter((i) => !i.module_name.startsWith("core-") && answersItems(i.module_name));
}

interface AttentionEntry {
  id: string;
  title: string;
  /** Kind-specific action payload: tasks carry {task}; bed-clear carries
   *  {connection_id, device_id} — enough for the client's inline actions. */
  action?: Record<string, string>;
  /** The record the entry is about, by the kind the registry names it (a
   *  named instance's own `<name>:item`; the default instance's records are
   *  the module's kind, `inventory:part`) and its bare name. This is what
   *  lets an answer built from the feed open the thing it names: "what is
   *  low?" named Cumin in plain text with nothing to open when the feed
   *  carried titles only (2026-09-13). Absent for a capture or a device. */
  record?: { kind: string; id: string; name: string };
  /** For a dated entry: when, in the reader's words ("3d ago", "in 2d"). */
  when?: string;
}

/** The collection a dated row belongs to. Its overdue, due-today and
 *  coming-up rows share it, so a surface can show them as ONE thing ("22
 *  overdue and 4 coming up in Groceries" was two cards). `due` says how the
 *  dates behave, which decides what finishing an entry means: `goes-off`
 *  goes off (used up, tossed, still good), a `window` is past its best, and a
 *  `deadline` is something to do. */
interface AttentionCollection {
  key: string;
  label: string;
  route: string;
  due: "goes-off" | "window" | "deadline";
  /** The verbs that settle a due entry here, as the collection's applicable
   *  actions declare them (`finishes`): used up, thrown out, still good. */
  finish?: Array<{ action_id: string; label: string; finishes: "used" | "discarded" | "still-good" }>;
}

interface AttentionRow {
  suggestion?: { id: string; candidate: TidyCandidate };
  kind: "tidy" | "low_stock" | "overdue" | "due_today" | "upcoming" | "pending_scans" | "photo_wanted" | "unreadable_date" | "suggested_edits";
  label: string;
  count: number;
  /** Up to 3 item names, for the row's detail line. */
  sample: string[];
  route: string;
  /** Up to 8 individual items for the row's inline expansion (act-in-place). */
  entries?: AttentionEntry[];
  /** The collection a dated row belongs to (overdue / due_today / upcoming). */
  collection?: AttentionCollection;
  /** Every record the row counts, beyond the eight entries, for an action on
   *  all of them ("mark all overdue as tossed"). Capped at the item cap. */
  all_ids?: string[];
}

async function j<T>(path: string, token: string): Promise<T | null> {
  try {
    const res = await apiFetch(`${INTERNAL_API}/api/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

attentionRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const rows: AttentionRow[] = [];
    for (const s of await listTidySuggestions(req.tenant!.org.id, req.tenant!.role)) rows.push({ kind: "tidy", label: s.candidate.why, count: s.candidate.records.length, sample: s.candidate.records.slice(0, 3).map((r) => r.name), route: s.candidate.action.route, suggestion: s });

    // Pending captures first — always actionable.
    const inbox = await j<{ items: Array<{ id: string }> }>(
      `/orgs/${slug}/modules/core-scan/inbox?status=pending`,
      token,
    );
    if (inbox && inbox.items.length > 0) {
      rows.push({
        kind: "pending_scans",
        label: "captures waiting to be filed",
        count: inbox.items.length,
        sample: [],
        route: "/scan",
      });
    }

    // Edits someone you share with suggested on your things (share-spaces.md
    // §10): one row, whoever and however many.
    const waiting = await listShareEdits(req.tenant!.org.id, { open: true }, 500).catch(() => []);
    const added = await listAdditions(req.tenant!.org.id).catch(() => []);
    if (waiting.length + added.length > 0) {
      const records = new Map<string, AttentionEntry>();
      for (const e of waiting) {
        const k = `${e.entity_kind}/${e.entity_id}`;
        if (!records.has(k)) records.set(k, { id: e.entity_id, title: e.title ?? "A record", record: { kind: e.entity_kind, id: e.entity_id, name: e.title ?? "A record" } });
      }
      for (const a of added) if (!records.has(`a/${a.id}`)) records.set(`a/${a.id}`, { id: a.id, title: a.title });
      const by = [...new Set([...waiting, ...added].map((e) => e.by_name ?? "someone"))];
      rows.push({
        kind: "suggested_edits",
        label: `${waiting.length && added.length ? "suggested edits and additions" : waiting.length ? "suggested edits" : "things added to a share"} by ${by.join(" and ")}`,
        count: waiting.length + added.length,
        sample: [...records.values()].slice(0, 3).map((r) => r.title),
        route: "/suggestions",
        entries: [...records.values()].slice(0, 8),
      });
    }

    // "I'll photograph this" — marks a person set at a desk, surfaced where they
    // will next be holding a phone. Reads the SAME facet the scanner's prompt
    // does (platform-contract/scan-triage), so the dashboard and the viewfinder
    // can never disagree about what is waiting. `total` rather than the page
    // length, or the count would silently cap at the entry limit.
    const wantPhoto = await j<{
      items: Array<{ id: string; suggested_name: string | null }>;
      total?: number;
    }>(`/orgs/${slug}/modules/core-scan/inbox?triage=photo_wanted&limit=8`, token);
    if (wantPhoto && wantPhoto.items.length > 0) {
      const name = (i: { suggested_name: string | null }) => i.suggested_name?.trim() || "an unnamed capture";
      rows.push({
        kind: "photo_wanted",
        label: `waiting for a photo from you`,
        count: wantPhoto.total ?? wantPhoto.items.length,
        sample: wantPhoto.items.slice(0, 3).map(name),
        route: "/scan",
        // Each entry deep-links the camera straight at that item, which is the
        // whole point: the row exists so nobody scrolls an inbox on a phone.
        entries: wantPhoto.items.slice(0, 8).map((i) => ({
          id: i.id,
          title: name(i),
          action: { want: i.id },
        })),
      });
    }

    const instances = await j<{
      items: Array<{ module_name: string; instance_name: string; display_name: string; is_default: boolean }>;
    }>(`/orgs/${slug}/instances`, token);
    const domain = instancesToAsk(instances?.items ?? [], hasPrimaryRouter).slice(0, INSTANCE_CAP);

    const now = Date.now();
    // By DAY, the way the schedule beside this feed reads a date, and on the
    // client's day when it says (?today=YYYY-MM-DD). A date is midnight, so a
    // clock comparison called anything due today overdue from 00:01 and the
    // headline said "6 overdue" over a schedule that said 5 and 1 today.
    const today = todayFrom(req.query.today);

    await Promise.all(
      domain.map(async (inst) => {
        const collectionRead = await readAttentionCollection(req.tenant!.org.id, slug, inst, ITEM_CAP, (path) => j(path, token));
        if (!collectionRead) return;
        const { recordKind, rowsOf, defs } = collectionRead;
        const route = inst.is_default ? `/${inst.module_name}` : `/instances/${inst.instance_name}`;
        const recordOf = (id: string, name: string) => ({ kind: recordKind, id, name });

        // Low stock: real columns on inventory-family rows, compared on what
        // is on hand (the list derives it: unopened count plus every open
        // unit still holding something), so an open skein with metres left
        // is not "out".
        const onHandOf = (r: Record<string, unknown>) => Number(r.on_hand ?? r.qty);
        const low = rowsOf.filter((r) => {
          const q = onHandOf(r), m = Number(r.min_qty);
          return Number.isFinite(q) && Number.isFinite(m) && r.min_qty !== null && q <= m;
        });
        if (low.length > 0) {
          rows.push({
            kind: "low_stock",
            label: `low in ${inst.display_name}`,
            count: low.length,
            sample: low.slice(0, 3).map((r) => String(r.name ?? "item")),
            route,
            entries: low.slice(0, 8).map((r) => ({
              id: String(r.id ?? r.name ?? "item"),
              title: `${String(r.name ?? "item")} — ${onHandOf(r)} left (min ${Number(r.min_qty)})`,
              ...(r.id ? { record: recordOf(String(r.id), String(r.name ?? "item")) } : {}),
            })),
          });
        }

        // A date field holding a value that names no day ("see lid", a date
        // that does not exist) is something a person has to fix, and it must
        // be SAID here: the sweeper, the calendar and this feed all read the
        // value as none, so the record simply vanishes from every deadline
        // surface, and one such value used to take a whole workspace's expiry
        // reminders with it (#3279). Every date field, not only the deadline
        // ones: the calendar reads them all.
        const dateFields = (defs?.items ?? []).filter((d) => d.type === "date");
        const kindHere = `${inst.instance_name}:item`;
        const unreadable: Array<{ id: string; name: string; field: string; value: string }> = [];
        for (const r of rowsOf) {
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          for (const f of dateFields) {
            const raw = meta[f.name];
            if (!fieldDayUnreadable(raw)) continue;
            unreadable.push({ id: String(r.id ?? r.name ?? "item"), name: String(r.name ?? "item"), field: f.display_label ?? f.name, value: String(raw) });
          }
        }
        if (unreadable.length > 0)
          rows.push({
            kind: "unreadable_date",
            label: `dates that can't be read in ${inst.display_name}`,
            count: unreadable.length,
            sample: unreadable.slice(0, 3).map((d) => d.name),
            route,
            entries: unreadable.slice(0, 8).map((d) => ({
              id: `${d.id}:${d.field}`,
              title: `${d.name} — ${d.field}: "${d.value}"`,
              action: { record: d.id, kind: kindHere },
              record: recordOf(d.id, d.name),
            })),
          });

        // Deadline-semantic date fields, from the tracker's own declarations.
        // A declared role says it outright: an expiry goes off, and the end of
        // a window (a wine's drink-by) is past its best. The label words are
        // for fields nobody declared.
        const dueFields = dateFields.filter(
          (d) => d.field_role === "expiry" || d.field_role === "ready-until" || DUE_RE.test(`${d.name} ${d.display_label ?? ""}`),
        );
        if (dueFields.length === 0) return;
        // A stock-face record with nothing on hand has nothing left to date:
        // exhausted milk is not overdue, it is gone (the calendar and the
        // expiry sweeper apply the same rule through the kernel's date query).
        let stockFace = false;
        try {
          stockFace = (await facesForKind(req.tenant!.org.id, `${inst.instance_name}:item`)).faces.includes("stock");
        } catch {
          stockFace = false;
        }
        type Dated = { id: string; name: string; when: number; day: string; field: string };
        const overdue: Dated[] = [];
        const dueToday: Dated[] = [];
        const upcoming: Dated[] = [];
        for (const r of rowsOf) {
          if (stockFace && r.qty != null && Number(r.qty) <= 0) continue;
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          for (const f of dueFields) {
            const raw = meta[f.name];
            if (typeof raw !== "string" || !raw) continue;
            // The day the one rule reads (field-day): a month-only date is
            // the last day of its month, here as on the calendar and in the
            // sweeper. Date.parse read it as the first.
            const day = fieldDay(raw);
            if (day === null) continue; // said above, as unreadable
            const t = Date.parse(`${day}T00:00:00Z`);
            const dated = { id: String(r.id ?? r.name ?? "item"), name: String(r.name ?? "item"), when: t, day, field: f.name };
            // By calendar day, the way the schedule reads it: due today is
            // today, never overdue (due-day.ts).
            const state = dueState(raw, today, WINDOW_DAYS);
            if (state === "none") continue;
            if (state === "overdue") overdue.push(dated);
            else if (state === "today") dueToday.push(dated);
            else if (state === "upcoming") upcoming.push(dated);
            break; // one signal per item is enough
          }
        }
        // The alert should land on the rows it counted, in the order that
        // matters. A saved view on this collection that ORDERS by one of its
        // due fields ("Use it or lose it", soonest first) is that landing, so
        // the row's route opens it; otherwise the bare table. The reviewer's
        // arrow used to open the whole grocery table with nothing selected
        // and the overdue rows to be found again by hand (2026-09-12).
        const dueNames = new Set(dueFields.map((f) => f.name));
        const views = await j<{ items: Array<{ id: string; config?: Record<string, unknown> }> }>(
          `/orgs/${slug}/modules/core-views/views?kind=${encodeURIComponent(`${inst.instance_name}:item`)}`,
          token,
        );
        const dueView = (views?.items ?? []).find((v) =>
          (viewQuery(v.config).sort ?? []).some((spec) => dueNames.has(spec.replace(/^-/, ""))),
        );
        const dueRoute = dueView ? `${route}?view=${encodeURIComponent(dueView.id)}` : route;
        // Calendar days from the reader's day (the one countdown, day.ts):
        // this used to round an instant, and read "in 4d" beside Up next's
        // "in 5 days" for the same banana (#3641).
        const ago = (day: string) => countdownWords(day, today);
        const ahead = (day: string) => countdownWords(day, today);
        // Soonest first, both lists: the most overdue leads, the nearest
        // upcoming leads.
        overdue.sort((a, b) => a.when - b.when);
        upcoming.sort((a, b) => a.when - b.when);
        const kind = `${inst.instance_name}:item`;
        const roleOf = new Map(dueFields.map((f) => [f.name, f.field_role ?? null]));
        const roles = new Set([...overdue, ...dueToday, ...upcoming].map((d) => roleOf.get(d.field)));
        const collection: AttentionCollection = {
          key: kind,
          label: inst.display_name,
          route: dueRoute,
          due: roles.has("expiry") ? "goes-off" : roles.has("ready-until") ? "window" : "deadline",
        };
        // The verbs that settle one, from what the collection's own actions
        // declare, never a list of action ids kept here.
        const ORDER = { used: 0, discarded: 1, "still-good": 2 } as const;
        const finish = (await listApplicable(kind, req.tenant!.org.id).catch(() => []))
          .filter((a) => a.finishes && a.user_invokable !== false)
          .map((a) => ({ action_id: a.id, label: a.label, finishes: a.finishes! }))
          .sort((a, b) => ORDER[a.finishes] - ORDER[b.finishes]);
        if (finish.length > 0) collection.finish = finish;
        if (overdue.length > 0)
          rows.push({
            kind: "overdue",
            label: `overdue in ${inst.display_name}`,
            count: overdue.length,
            sample: overdue.slice(0, 3).map((d) => d.name),
            route: dueRoute,
            collection,
            all_ids: overdue.map((d) => d.id),
            entries: overdue.slice(0, 8).map((d) => ({ id: d.id, title: `${d.name} — ${ago(d.day)}`, when: ago(d.day), action: { record: d.id, kind }, record: recordOf(d.id, d.name) })),
          });
        if (dueToday.length > 0)
          rows.push({
            kind: "due_today",
            label: `due today in ${inst.display_name}`,
            count: dueToday.length,
            sample: dueToday.slice(0, 3).map((d) => d.name),
            route: dueRoute,
            collection,
            entries: dueToday.slice(0, 8).map((d) => ({ id: d.id, title: `${d.name} — today`, when: "today", action: { record: d.id, kind }, record: recordOf(d.id, d.name) })),
          });
        if (upcoming.length > 0)
          rows.push({
            kind: "upcoming",
            label: `coming up in ${inst.display_name}`,
            count: upcoming.length,
            sample: upcoming.slice(0, 3).map((d) => d.name),
            route: dueRoute,
            collection,
            entries: upcoming.slice(0, 8).map((d) => ({ id: d.id, title: `${d.name} — ${ahead(d.day)}`, when: ahead(d.day), action: { record: d.id, kind }, record: recordOf(d.id, d.name) })),
          });
      }),
    );

    // NATIVE-column deadlines the field-semantics sweep can't see: projects
    // tasks keep due_date as a real column (not instance-item metadata), so
    // the classic "overdue to-do" never surfaced here (found seeding a demo
    // workspace — two overdue tasks, zero attention rows). 404s harmlessly
    // when the projects module is off (j() → null).
    const tasks = await j<{ items: Array<{ id: string; title: string; status: string; due_date: string | null }> }>(
      `/orgs/${slug}/modules/projects/tasks?limit=${ITEM_CAP}`,
      token,
    );
    if (tasks) {
      const openTasks = tasks.items.filter(
        (t) => t.due_date && !["done", "cancelled"].includes(t.status),
      );
      const overdueTasks = openTasks.filter((t) => dueState(t.due_date, today, WINDOW_DAYS) === "overdue");
      const upcomingTasks = openTasks.filter((t) => ["today", "upcoming"].includes(dueState(t.due_date, today, WINDOW_DAYS)));
      const tasksCollection: AttentionCollection = { key: "projects:task", label: "Tasks", route: "/projects", due: "deadline" };
      const taskEntry = (t: { id?: string; title: string }) => ({
        id: String(t.id ?? t.title),
        title: t.title,
        action: { task: String(t.id ?? "") },
        ...(t.id ? { record: { kind: "projects:task", id: String(t.id), name: t.title } } : {}),
      });
      if (overdueTasks.length > 0)
        rows.push({
          kind: "overdue",
          label: `overdue ${overdueTasks.length === 1 ? "task" : "tasks"}`,
          count: overdueTasks.length,
          sample: overdueTasks.slice(0, 3).map((t) => t.title),
          route: "/projects",
          collection: tasksCollection,
          all_ids: overdueTasks.map((t) => String(t.id ?? t.title)),
          entries: overdueTasks.slice(0, 8).map(taskEntry),
        });
      if (upcomingTasks.length > 0)
        rows.push({
          kind: "upcoming",
          label: `${upcomingTasks.length === 1 ? "task" : "tasks"} due soon`,
          count: upcomingTasks.length,
          sample: upcomingTasks.slice(0, 3).map((t) => t.title),
          route: "/projects",
          collection: tasksCollection,
          entries: upcomingTasks.slice(0, 8).map(taskEntry),
        });
    }

    // Things lent out: due back, overdue, or out a month with no day set
    // (record-loans.md). One read of every loan, whatever kind it is on.
    const loans: OpenLoan[] = await listOpenLoans(req.tenant!.org.id).catch(() => []);
    const lentKeys = new Set(loans.map((l) => `${l.kind}:${l.id}`));
    {
      const loanEntry = (l: OpenLoan, words: string) => ({
        id: l.id,
        title: `${l.title}, with ${l.loan.holder}: ${words}`,
        action: { record: l.id, kind: l.kind },
        record: { kind: l.kind, id: l.id, name: l.title },
      });
      const byState = { overdue: [] as OpenLoan[], today: [] as OpenLoan[], upcoming: [] as OpenLoan[], long: [] as OpenLoan[] };
      for (const l of loans) {
        if (l.dueElsewhere) continue;
        if (!l.loan.due_back) {
          if (-daysUntil(l.loan.since, today) >= WINDOW_DAYS) byState.long.push(l);
          continue;
        }
        const state = dueState(l.loan.due_back, today, WINDOW_DAYS);
        if (state === "overdue") byState.overdue.push(l);
        else if (state === "today") byState.today.push(l);
        else if (state === "upcoming") byState.upcoming.push(l);
      }
      const push = async (kind: "overdue" | "due_today" | "upcoming", label: (n: number) => string, list: OpenLoan[], words: (l: OpenLoan) => string) => {
        if (!list.length) return;
        // The row opens the first thing it names; each entry opens its own.
        const route = (await detailPathForEntity(req.tenant!.org.id, list[0]!.kind, list[0]!.id).catch(() => undefined)) ?? "/";
        rows.push({ kind, label: label(list.length), count: list.length, sample: list.slice(0, 3).map((l) => l.title), route, entries: list.slice(0, 8).map((l) => loanEntry(l, words(l))) });
      };
      const back = (l: OpenLoan) => (l.loan.due_back ? countdownWords(l.loan.due_back, today) : "");
      await push("overdue", (n) => `${n === 1 ? "thing" : "things"} lent out, overdue back`, byState.overdue, back);
      await push("due_today", (n) => `${n === 1 ? "thing" : "things"} lent out, due back today`, byState.today, back);
      await push("upcoming", (n) => `${n === 1 ? "thing" : "things"} lent out, due back soon`, byState.upcoming, back);
      await push("upcoming", (n) => `${n === 1 ? "thing" : "things"} lent out for over a month`, byState.long, (l) => `out ${-daysUntil(l.loan.since, today)} days`);
    }

    // Scheduled maintenance: every open service in the log, including each
    // schedule's next occurrence ("Oil change on the van, overdue by 4 days";
    // a printer whose print hours passed its mark, dated today by the
    // sweeper). A native column, so the field sweep above never saw it; it
    // only surfaced when a tracker happened to name a date field "service"
    // (#3876). 404s harmlessly when core-maintenance is off.
    const maint = await j<{
      items: Array<{ id: string; name: string; entity_module: string; entity_type: string; entity_id: string; scheduled_at: string | null; schedule_id?: string | null }>;
    }>(`/orgs/${slug}/modules/core-maintenance/entries?kind=scheduled&due_within_days=${WINDOW_DAYS}&limit=${ITEM_CAP}`, token);
    if (maint && maint.items.length > 0) {
      const orgId = req.tenant!.org.id;
      // A thing lent out is not here to service: its reminders wait until
      // it is back (record-loans.md).
      maint.items = maint.items.filter((e) => !lentKeys.has(`${e.entity_module}:${e.entity_type}:${e.entity_id}`));
      // An occurrence of a schedule says where it stands in the schedule's own
      // words: a printer past its service hours is "overdue by 125 print
      // hours", not "due today" because the sweeper dated it today.
      const schedules = maint.items.some((e) => e.schedule_id)
        ? await j<{ items: Array<{ id: string; due: { state: "ok" | "due-soon" | "overdue"; reason: string } }> }>(
            `/orgs/${slug}/modules/core-maintenance/schedules`,
            token,
          )
        : null;
      const dueBySchedule = new Map((schedules?.items ?? []).map((sc) => [sc.id, sc.due]));
      const titled = await Promise.all(
        maint.items.map(async (e) => {
          const kind = `${e.entity_module}:${e.entity_type}`;
          const title = await titleForEntity(orgId, kind, e.entity_id).catch(() => null);
          return { ...e, kind, title };
        }),
      );
      const entryOf = (e: (typeof titled)[number], words: string) => ({
        id: e.id,
        title: `${e.name}${e.title ? ` on ${e.title}` : ""}: ${words}`,
        action: { record: e.entity_id, kind: e.kind, maintenance_entry: e.id },
        record: { kind: e.kind, id: e.entity_id, name: e.title ?? e.name },
      });
      const byState = { overdue: [] as typeof titled, today: [] as typeof titled, upcoming: [] as typeof titled };
      for (const e of titled) {
        const day = e.scheduled_at ? e.scheduled_at.slice(0, 10) : null;
        const own = e.schedule_id ? dueBySchedule.get(e.schedule_id) : undefined;
        const state = own?.state === "overdue" ? "overdue" : day ? dueState(day, today, WINDOW_DAYS) : "none";
        if (state === "overdue") byState.overdue.push(e);
        else if (state === "today") byState.today.push(e);
        else if (state === "upcoming") byState.upcoming.push(e);
      }
      const words = (e: (typeof titled)[number]) =>
        (e.schedule_id ? dueBySchedule.get(e.schedule_id)?.reason : undefined) ??
        (e.scheduled_at ? countdownWords(e.scheduled_at.slice(0, 10), today) : "");
      const push = (kind: "overdue" | "due_today" | "upcoming", label: string, list: typeof titled) => {
        if (list.length === 0) return;
        list.sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
        rows.push({
          kind,
          label,
          count: list.length,
          sample: list.slice(0, 3).map((e) => (e.title ? `${e.name} on ${e.title}` : e.name)),
          route: "/maintenance",
          entries: list.slice(0, 8).map((e) => entryOf(e, words(e))),
        });
      };
      push("overdue", `overdue maintenance`, byState.overdue);
      push("due_today", `maintenance due today`, byState.today);
      push("upcoming", `maintenance coming up`, byState.upcoming);
    }

    // Digifab (prototype, the author sign-off pending): printers holding a finished
    // plate for the bed-clear verdict + recent failed prints. Both read
    // digifab's own endpoints (fleet serves its SWR snapshot — instant); 404
    // harmlessly when the module is off.
    const fleet = await j<{ connections: Array<{ connection_id: string; devices: Array<{ id: string; name: string; needs_attention: { reason: string } | null }> }> }>(
      `/orgs/${slug}/modules/digifab/fleet`,
      token,
    );
    if (fleet) {
      const waiting = fleet.connections.flatMap((c) => c.devices.map((d) => ({ ...d, conn: c.connection_id }))).filter((d) => d.needs_attention);
      if (waiting.length > 0)
        rows.push({
          kind: "overdue",
          label: `printer${waiting.length === 1 ? "" : "s"} waiting for a bed-clear verdict`,
          count: waiting.length,
          sample: waiting.slice(0, 3).map((d) => d.name),
          route: "/digifab",
          entries: waiting.slice(0, 8).map((d) => ({ id: `${d.conn}:${d.id}`, title: d.name, action: { connection_id: d.conn, device_id: d.id } })),
        });
    }
    const failed = await j<{ items: Array<{ file_ref: string; updated_at: string }> }>(
      `/orgs/${slug}/modules/digifab/jobs?status=failed&limit=25`,
      token,
    );
    if (failed) {
      const recent = failed.items.filter((f) => Date.parse(f.updated_at) > now - 7 * 86_400_000);
      if (recent.length > 0)
        rows.push({
          kind: "overdue",
          label: `failed print${recent.length === 1 ? "" : "s"} this week`,
          count: recent.length,
          sample: recent.slice(0, 3).map((f) => f.file_ref),
          route: "/digifab",
        });
    }

    // Severity order: overdue → low stock → a date nothing can read (a
    // reminder that will never fire) → someone waiting on your answer →
    // pending scans → upcoming.
    const rank = { tidy: 5, overdue: 0, due_today: 1, low_stock: 2, unreadable_date: 3, suggested_edits: 4, photo_wanted: 5, pending_scans: 6, upcoming: 7 } as const;
    rows.sort((a, b) => rank[a.kind] - rank[b.kind] || b.count - a.count);
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});
