// A write made offline waits on this device, not only in the page (#7863).
//
// Offline, a page's write waits for the connection: the banner says "Changes
// wait until you're back", and the page sends it when the connection returns.
// But what waited was the page's own mutation, in memory: a reload took it,
// and a note typed in a basement was gone with the banner still promising it.
// Every write passes one of two doors (the web's request, the modules'
// workspaceFetch), and each tells this store what it could not send because
// the browser is offline. An edit (PATCH, PUT, DELETE) the browser never sent
// can be sent later without doubling or meaning something else, so the store
// keeps it, per signed-in person. A POST is not kept: the app sends some that
// change nothing (a stream's ticket, a lookup), and a create sent from a
// later page could not finish what the page that asked for it meant to do.
//   - the page that made it still sends it itself when the connection returns,
//     and the store forgets it when it lands;
//   - a page loaded after it (a reload, a new tab) shows it over what it reads
//     and sends it once it can (sendWaitingWrites), in the order it was made;
//   - a waiting write the store did not keep (a create, a file, anything
//     sent some other way) makes leaving the page ask first, so nothing is thrown
//     away without a word: the page counts what it kept against what waits.

import { applyJsonbMerge } from "@cobblr/platform-contract/jsonb-merge";

const KEY = "cobblr:waiting-writes";
const WRITES = new Set(["PUT", "PATCH", "DELETE"]);

export interface WaitingWrite {
  method: string;
  /** Under /api/v1, without its query string's absence mattering: as sent. */
  path: string;
  body?: unknown;
  /** Whose write: the account its token was for. */
  who: string;
  /** The document that made it, which sends it itself while it is open. */
  page: string;
  at: string;
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

/** Read by a door as it is entered, before it waits on anything. */
export function madeByAPerson(): boolean {
  return personsWrites > 0;
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
export function keepWaitingWrite(method: string, path: string, body: BodyInit | null | undefined, authorization: string | null | undefined): boolean {
  const m = method.toUpperCase();
  if (!WRITES.has(m)) return false;
  let parsed: unknown;
  if (body != null) {
    if (typeof body !== "string") return false;
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  }
  const who = writerOf(authorization);
  const list = read();
  let last = list.length - 1;
  while (last >= 0 && !(list[last]!.who === who && list[last]!.path === path)) last -= 1;
  const prior = last >= 0 ? list[last]! : null;
  if (prior && m === "PATCH" && prior.method === "PATCH" && isRecord(prior.body) && isRecord(parsed)) {
    const body = { ...prior.body, ...parsed };
    if (isRecord(prior.body.metadata) && isRecord(parsed.metadata)) {
      // Keep null deletion markers until the server applies the combined patch.
      body.metadata = { ...prior.body.metadata, ...parsed.metadata };
    }
    list[last] = { ...prior, body, page: PAGE };
  } else if (prior && (m === "PUT" || m === "DELETE") && (prior.method === "PATCH" || prior.method === "PUT")) {
    list[last] = { method: m, path, body: parsed, who, page: PAGE, at: new Date().toISOString() };
  } else {
    list.push({ method: m, path, ...(parsed === undefined ? {} : { body: parsed }), who, page: PAGE, at: new Date().toISOString() });
  }
  if (!save(list)) return false;
  const k = `${m} ${path}`;
  keptHere.set(k, (keptHere.get(k) ?? 0) + 1);
  return true;
}

/** A write reached the server (answered at all): it no longer waits. */
export function landedWrite(method: string, path: string, authorization: string | null | undefined): void {
  const m = method.toUpperCase();
  if (!WRITES.has(m)) return;
  const k = `${m} ${path}`;
  const n = keptHere.get(k);
  if (n !== undefined) {
    if (n > 1) keptHere.set(k, n - 1);
    else keptHere.delete(k);
  }
  const who = writerOf(authorization);
  const list = read();
  const i = list.findIndex((w) => w.page === PAGE && w.who === who && w.method === m && w.path === path);
  if (i < 0) return;
  list.splice(i, 1);
  save(list);
}

/** What a read of `path` shows while edits to it wait: the edits over the
 *  answer, so a field still says what was typed into it. */
export function withWaitingWrites<T>(path: string, answer: T, authorization: string | null | undefined): T {
  if (!isRecord(answer)) return answer;
  const who = writerOf(authorization);
  const p = bare(path);
  let out: Record<string, unknown> = answer;
  for (const w of read()) {
    if (w.who !== who || bare(w.path) !== p || !isRecord(w.body)) continue;
    if (w.method === "PATCH" || w.method === "PUT") {
      const metadata = w.method === "PATCH" && isRecord(w.body.metadata)
        ? { metadata: applyJsonbMerge(isRecord(out.metadata) ? out.metadata : undefined, w.body.metadata) }
        : {};
      out = { ...out, ...w.body, ...metadata };
    }
  }
  return out as T;
}

/** The writes waiting for this person that no open page will send: the ones
 *  an earlier page made. */
export function waitingWritesToSend(authorization: string | null | undefined): WaitingWrite[] {
  const who = writerOf(authorization);
  return read().filter((w) => w.who === who && w.page !== PAGE);
}

/** How many writes wait for this person, this page's own included. */
export function waitingWriteCount(authorization: string | null | undefined): number {
  const who = writerOf(authorization);
  return read().filter((w) => w.who === who).length;
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
