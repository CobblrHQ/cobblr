// A write made offline waits on this device, not only in the page (#7863).
//
// Offline, a page's write waits for the connection: the banner says "Changes
// wait until you're back", and the page sends it when the connection returns.
// But what waited was the page's own mutation, in memory: a reload took it,
// and a note typed in a basement was gone with the banner still promising it.
// Every write passes one of two doors (the web's request, the modules'
// workspaceFetch), and each tells this store what it could not send because
// the browser is offline. A write the browser never sent can be sent later
// without doubling, so the store keeps it, per signed-in person: an edit
// (PATCH, PUT, DELETE), and since #7928 a create (POST), which carries a key of
// its own (Idempotency-Key) so a send cut short and sent again is one create
// to a server that holds answers by key (#7923). A POST that only asks (a
// lookup, a search, a preview) is not kept: sent later it changes nothing and
// would be reported as saved.
//   - the page that made it still sends it itself when the connection returns,
//     and the store forgets it when it lands;
//   - a page loaded after it (a reload, a new tab) shows it over what it reads
//     and sends it once it can (sendWaitingWrites), in the order it was made;
//   - a waiting write the store did not keep (a create, a file, anything
//     sent some other way) makes leaving the page ask first, so nothing is thrown
//     away without a word: the page counts what it kept against what waits.
// Since #8638 a person's write is kept as it leaves, not only when the browser
// says it is offline: on a weak signal a reload before the answer dropped it
// without a word, and a phone's Safari never asks before leaving. Marked
// "sending", it is neither counted nor sent by the page that made it, and is
// forgotten when it lands; a page loaded after sends it under the key it left
// with, which the server answers as the first (#7923).

import { applyJsonbMerge } from "@cobblr/platform-contract/jsonb-merge";
import { decodeEditedFrom, type EditedFrom } from "@cobblr/platform-contract/edited-from";
import { randomId } from "@cobblr/platform-contract/random-id";

const KEY = "cobblr:waiting-writes";
const WRITES = new Set(["PUT", "PATCH", "DELETE", "POST"]);
/** A POST whose last step only asks: nothing to keep. */
const ASKS = /\/(?:search|lookup|look-up|preview|resolve|suggest|suggestions|match|parse|read|estimate|check|validate|dry-run|ticket|stream-ticket|answer|query|count)(?:\?|$)/;
/** The header a kept create is sent again with. */
export const IDEMPOTENCY_KEY = "Idempotency-Key";

export interface WaitingWrite {
  method: string;
  /** Under /api/v1, without its query string's absence mattering: as sent. */
  path: string;
  body?: unknown;
  /** What its fields were when the form opened (edited-from.ts): sent with it
   *  later, a change someone made meanwhile is not overwritten (#7925). */
  editedFrom?: EditedFrom;
  /** Whose write: the account its token was for. */
  who: string;
  /** The document that made it, which sends it itself while it is open. */
  page: string;
  at: string;
  /** A create's own key, sent with it as Idempotency-Key. */
  key?: string;
  /** Kept from a form, not a mutation: no page sends it again by itself, so
   *  the store sends it as soon as it can, from this page too (#8637). */
  orphan?: boolean;
  /** On its way from the page that made it, answer not yet back: that page
   *  neither counts nor sends it, and forgets it when it lands; a page loaded
   *  after (a reload mid-save) sends it, under its key (#8638). */
  sending?: boolean;
}

let personsWrites = 0;

/** Run a write a person asked for (a mutation's function): a door it reaches
 *  in this same turn may keep it. The page's own writes (a chat's history, a
 *  setting it syncs) are never kept: sent from a later page they would put
 *  back what the person has since changed. */
export function asAPersonsWrite<T>(fn: () => T): T {
  personsWrites += 1;
  try {
    return fn();
  } finally {
    personsWrites -= 1;
  }
}

/** A create from a form a person just submitted is theirs too (#7928). A
 *  form's handler sends it from an async function, not a mutation, so the
 *  mark above has gone by then: the New part form's create was never kept,
 *  and a part added offline was lost on reload. A create is the only write
 *  this window keeps: an edit the page syncs on its own just after a submit
 *  (a chat's history) must never be sent from a later page. */
const SUBMITTED_WINDOW_MS = 10_000;
let submittedAt = Number.NEGATIVE_INFINITY;
if (typeof document !== "undefined") {
  document.addEventListener("submit", (e) => {
    if (e.isTrusted) submittedAt = Date.now();
  }, true);
}

/** Whether a person's mutation is sending this write (it sends it again by
 *  itself when the connection returns), read as a door is entered. */
export function madeByAMutation(): boolean {
  return personsWrites > 0;
}

/** Read by a door as it is entered, before it waits on anything. */
export function madeByAPerson(method?: string): boolean {
  return personsWrites > 0 || (method?.toUpperCase() === "POST" && Date.now() - submittedAt < SUBMITTED_WINDOW_MS);
}

const PAGE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const listeners = new Set<() => void>();
const keptHere = new Map<string, number>();

/** The account a Bearer header is for: its token's `sub`, or the token. */
export function writerOf(authorization: string | null | undefined): string {
  const token = (authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return "";
  try {
    const part = token.split(".")[1];
    if (!part) return token;
    const sub = (JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub ? sub : token;
  } catch {
    return token;
  }
}

function read(): WaitingWrite[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as WaitingWrite[]) : [];
  } catch {
    return [];
  }
}

function save(list: WaitingWrite[]): boolean {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    return false;
  } finally {
    listeners.forEach((l) => l());
  }
  return true;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bare = (path: string) => path.split("?")[0]!;

/** Whether the browser says it is offline: a write made then was never sent. */
export function browserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Keep a write the browser could not send because it is offline. `body` is
 *  the request's body as JSON text, or undefined; anything else (a file, a
 *  form) cannot be kept, and leaving the page then asks first. Two edits of
 *  one record fold into one, the later value winning, as they would have
 *  landed. Says whether it was kept. */
export function keepWaitingWrite(method: string, path: string, body: BodyInit | null | undefined, authorization: string | null | undefined, editedFromHeader?: string | null, opts: { key?: string; orphan?: boolean; sending?: boolean } = {}): boolean {
  const m = method.toUpperCase();
  if (!WRITES.has(m) || (m === "POST" && ASKS.test(path))) return false;
  let parsed: unknown;
  if (body != null) {
    if (typeof body !== "string") return false;
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  }
  const editedFrom = decodeEditedFrom(editedFromHeader) ?? undefined;
  const who = writerOf(authorization);
  const list = read();
  if (opts.sending) {
    // Kept as it is sent, under the request's own key, so a reload before
    // its answer sends it again as the same write (#8638). Sent again from
    // this page (a mutation's retry, a form pressed again), it is the one
    // already kept under that key.
    const again = opts.key ? list.findIndex((w) => w.page === PAGE && w.key === opts.key) : -1;
    if (again >= 0) {
      const was = list[again]!;
      if (!was.sending) uncount(was.method, was.path);
      list[again] = { ...was, sending: true };
    } else {
      list.push({ method: m, path, ...(parsed === undefined ? {} : { body: parsed }), ...(editedFrom ? { editedFrom } : {}), who, page: PAGE, at: new Date().toISOString(), ...(opts.key ? { key: opts.key } : {}), ...(opts.orphan ? { orphan: true } : {}), sending: true });
    }
    return save(list);
  }
  return waitIn(list, { method: m, path, ...(parsed === undefined ? {} : { body: parsed }), ...(editedFrom ? { editedFrom } : {}), who, page: PAGE, at: new Date().toISOString(), ...(opts.key ? { key: opts.key } : {}), ...(opts.orphan ? { orphan: true } : {}) });
}

/** Put a write among those waiting: two edits of one record fold into one,
 *  the later value winning, as they would have landed; a create waits with
 *  its own key. Says whether it was kept. */
function waitIn(list: WaitingWrite[], w: WaitingWrite): boolean {
  const { method: m, path, who, editedFrom } = w;
  const parsed = w.body;
  let last = list.length - 1;
  while (last >= 0 && !(list[last]!.who === who && list[last]!.path === path)) last -= 1;
  // A write still on its way is never folded into: it is forgotten when it lands.
  const prior = last >= 0 && m !== "POST" && !list[last]!.sending ? list[last]! : null;
  if (m === "POST") {
    // The request's own key, so the same create pressed again is one create (#8637).
    list.push({ ...w, key: w.key ?? randomId() });
  } else if (prior && m === "PATCH" && prior.method === "PATCH" && isRecord(prior.body) && isRecord(parsed)) {
    const body = { ...prior.body, ...parsed };
    if (isRecord(prior.body.metadata) && isRecord(parsed.metadata)) {
      // Keep null deletion markers until the server applies the combined patch.
      body.metadata = { ...prior.body.metadata, ...parsed.metadata };
    }
    // A field's opened value is the first edit's: that is what the form showed.
    const was = prior.editedFrom || editedFrom ? { ...(editedFrom ?? {}), ...(prior.editedFrom ?? {}) } : undefined;
    list[last] = { ...prior, body, ...(was ? { editedFrom: was } : {}), page: PAGE, ...(prior.orphan || w.orphan ? { orphan: true } : {}) };
  } else if (prior && (m === "PUT" || m === "DELETE") && (prior.method === "PATCH" || prior.method === "PUT")) {
    list[last] = { ...w, ...(prior.orphan || w.orphan ? { orphan: true } : {}) };
  } else {
    list.push(w);
  }
  if (!save(list)) return false;
  const k = `${m} ${path}`;
  keptHere.set(k, (keptHere.get(k) ?? 0) + 1);
  return true;
}

/** A waiting write this page counted as kept goes back on its way. */
function uncount(method: string, path: string): void {
  const k = `${method} ${path}`;
  const n = keptHere.get(k);
  if (n === undefined) return;
  if (n > 1) keptHere.set(k, n - 1);
  else keptHere.delete(k);
}

/** The write kept as it was sent, by its key, from this page. */
const sentAs = (list: WaitingWrite[], key: string) => list.findIndex((w) => w.page === PAGE && w.sending && w.key === key);

/** A write kept as it was sent could not go because the browser is offline:
 *  it waits now, counted and sent like any kept write. Says whether it was kept. */
export function sendingWaits(key: string): boolean {
  const list = read();
  const i = sentAs(list, key);
  if (i < 0) return false;
  const { sending: _sending, ...waiting } = list[i]!;
  list.splice(i, 1);
  return waitIn(list, waiting);
}

/** Set as the page goes (a reload, a pull to refresh): the browser then
 *  cancels what is on its way, which is not a failure the page can report,
 *  so what was kept stays for the next page to send (#8638). */
let pageGoing = false;
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    pageGoing = true;
  });
  window.addEventListener("pageshow", () => {
    pageGoing = false;
  });
}

/** A write kept as it was sent failed online (the server unreachable, the
 *  page told so): the page reports it, so the device does not keep it. */
export function sendingFailed(key: string): void {
  if (pageGoing) return;
  const list = read();
  const i = sentAs(list, key);
  if (i < 0) return;
  list.splice(i, 1);
  save(list);
}

/** A write reached the server (answered at all): it no longer waits. One
 *  sent with a key is found by it, so the right one of two goes. */
export function landedWrite(method: string, path: string, authorization: string | null | undefined, key?: string): void {
  const m = method.toUpperCase();
  if (!WRITES.has(m)) return;
  const list = read();
  if (key) {
    const i = sentAs(list, key);
    if (i >= 0) {
      list.splice(i, 1);
      save(list);
      return;
    }
  }
  uncount(m, path);
  const who = writerOf(authorization);
  const i = list.findIndex((w) => w.page === PAGE && w.who === who && w.method === m && w.path === path && !w.sending);
  if (i < 0) return;
  list.splice(i, 1);
  save(list);
}

/** One waiting edit over a record. */
function edited(record: Record<string, unknown>, w: WaitingWrite): Record<string, unknown> {
  if (!isRecord(w.body) || (w.method !== "PATCH" && w.method !== "PUT")) return record;
  const metadata = w.method === "PATCH" && isRecord(w.body.metadata)
    ? { metadata: applyJsonbMerge(isRecord(record.metadata) ? record.metadata : undefined, w.body.metadata) }
    : {};
  return { ...record, ...w.body, ...metadata };
}

/** The rows a read carries (a list's lines, a page of records): the answer
 *  itself when it is an array, else each array of records it holds. A row's
 *  waiting edit is written to the row's own address, `<base>/<rows>/<id>`,
 *  under the same module as the read, so it is matched by its id: a list's
 *  line ticked or removed offline showed as it was after a reload, under a
 *  banner counting that very change as waiting (#8636). */
function overRows(answer: unknown, readPath: string, writes: WaitingWrite[]): unknown {
  const rowWrites = writes.flatMap((w) => {
    const parts = bare(w.path).split("/");
    const id = parts.pop();
    parts.pop();
    const base = parts.join("/");
    return id && base && readPath.startsWith(`${base}/`) && bare(w.path) !== readPath ? [{ id, w }] : [];
  });
  if (!rowWrites.length) return answer;
  const rows = (list: unknown[]): unknown[] => {
    let changed = false;
    const out: unknown[] = [];
    for (const row of list) {
      if (!isRecord(row) || typeof row.id !== "string" || !rowWrites.some((r) => r.id === row.id)) {
        out.push(row);
        continue;
      }
      changed = true;
      let shown: Record<string, unknown> | null = row;
      for (const { id, w } of rowWrites) {
        if (id !== row.id || !shown) continue;
        shown = w.method === "DELETE" ? null : edited(shown, w);
      }
      if (shown) out.push(shown);
    }
    return changed ? out : list;
  };
  if (Array.isArray(answer)) return rows(answer);
  if (!isRecord(answer)) return answer;
  let out = answer;
  for (const [k, v] of Object.entries(answer)) {
    if (!Array.isArray(v)) continue;
    const shown = rows(v);
    if (shown !== v) out = { ...out, [k]: shown };
  }
  return out;
}

/** What a read of `path` shows while edits to it wait: the edits over the
 *  answer, so a field still says what was typed into it, and the edits and
 *  removals of the rows it carries over those rows. */
export function withWaitingWrites<T>(path: string, answer: T, authorization: string | null | undefined): T {
  if (!isRecord(answer) && !Array.isArray(answer)) return answer;
  const who = writerOf(authorization);
  const p = bare(path);
  const mine = read().filter((w) => w.who === who);
  let out: unknown = answer;
  if (isRecord(out)) for (const w of mine) if (bare(w.path) === p) out = edited(out as Record<string, unknown>, w);
  return overRows(out, p, mine) as T;
}

/** The writes waiting for this person that no open page will send: the ones
 *  an earlier page made, and this page's own that no mutation sends again
 *  (a form's create, #8637). */
export function waitingWritesToSend(authorization: string | null | undefined): WaitingWrite[] {
  const who = writerOf(authorization);
  return read().filter((w) => w.who === who && (w.page !== PAGE || (w.orphan && !w.sending)));
}

/** The creates waiting at `path` (a POST to it), this page's own included, so a
 *  page can show what was added while the signal was gone instead of the list
 *  as the server last had it (#8834). */
export function waitingCreates(path: string, authorization: string | null | undefined): WaitingWrite[] {
  const who = writerOf(authorization);
  return read().filter((w) => w.who === who && w.method === "POST" && bare(w.path) === bare(path) && !(w.sending && w.page === PAGE));
}

/** How many writes wait for this person, this page's own included. */
export function waitingWriteCount(authorization: string | null | undefined): number {
  const who = writerOf(authorization);
  return read().filter((w) => w.who === who && !(w.sending && w.page === PAGE)).length;
}

export type SendOutcome = "landed" | "refused" | "unreachable";

/** Send what an earlier page left waiting, oldest first, through `send`. A
 *  refusal (the record went, a rule says no) is dropped and reported, so it
 *  never waits forever; an unreachable server stops the run, and the rest
 *  wait for the next one. */
export async function sendWaitingWrites(
  authorization: string | null | undefined,
  send: (w: WaitingWrite) => Promise<{ outcome: SendOutcome; reason?: string }>,
): Promise<{ landed: number; refused: Array<{ write: WaitingWrite; reason: string }> }> {
  const refused: Array<{ write: WaitingWrite; reason: string }> = [];
  let landed = 0;
  for (const w of waitingWritesToSend(authorization)) {
    const { outcome, reason } = await send(w);
    if (outcome === "unreachable") break;
    const list = read();
    const i = list.findIndex((x) => x.page === w.page && x.at === w.at && x.method === w.method && x.path === w.path);
    if (i >= 0) list.splice(i, 1);
    save(list);
    if (outcome === "landed") landed += 1;
    else refused.push({ write: w, reason: reason ?? "" });
  }
  return { landed, refused };
}

/** How many of this page's writes, waiting for the connection, are kept on
 *  the device. Fewer than the page has waiting means leaving loses one. */
export function keptByThisPage(): number {
  let n = 0;
  keptHere.forEach((c) => (n += c));
  return n;
}

export function subscribeWaitingWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Signing out forgets them, with everything else kept on this device. */
export function forgetWaitingWrites(): void {
  keptHere.clear();
  save([]);
}
