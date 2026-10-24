// The shared client every area file calls through: the session token, the
// one `request<T>` wrapper and its error shape, connectivity and upload.
// Endpoints never live here; each goes in its area file (lint:api-client-by-area).
import { getShareViewToken, setShareViewToken } from "../share-view";
import { getStationTokenOverride } from "../station-token";
import { sessionChanged, sessionIdentityOf } from "../session-identity";
import { getImpersonationToken } from "../impersonation";
import { forgetDashboardCopies } from "../../dashboard/device-copy";
import { UploadError, browserOffline, describeUnreadableBody, keepWaitingWrite, landedWrite, madeByAPerson, networkFailureMessage, noteWorkspaceWrite, OFFLINE_SENTENCE, primedRead, productName, resetPrimedReads, sendUpload, sharedRead, uploadErrorOf, withWaitingWrites } from "@cobblr/platform-web";
import { approvalDedupeKey } from "@cobblr/platform-contract/blocked-action";
import type { BlockedAction } from "@cobblr/platform-contract/blocked-action";
import { counted } from "../in-flight";
import { AI_AVAILABILITY_WRITE } from "../ai-availability-keys";
import { awaitBlockedAction, carriesOnItself, isMutating, raiseBlockedAction, refusedRequestFor } from "../blocked-action";
import { GUEST_NOT_SHARED, refusedForGuest } from "../acting-role";
import { isPageLeaving } from "../page-leaving";
import { busySentence, parseRetryAfter } from "../request-wait";
import { markSandboxEnded } from "../sandbox-session";
import { markWorkspaceUnfinished, slugOfRequest } from "../workspace-unfinished";
import { announceScanFiled } from "../scanFiled";
import type { ScanFiledChange } from "../scanFiled";

const TOKEN_KEY = "cobblr.token";

/** The signed-in account's own token: not a share's View as, not a station's. */
export function accountToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  return getShareViewToken() ?? getStationTokenOverride() ?? localStorage.getItem(TOKEN_KEY);
}

/** Who the page is answering for: the account and any View as grant (session-identity.ts). */
export function sessionIdentity(): string {
  return sessionIdentityOf(getToken(), getImpersonationToken());
}

export function setToken(token: string | null) {
  const before = sessionIdentity();
  // Signing out of a View as ends the view in this tab, never the account
  // signed in on this browser.
  if (!token && getShareViewToken()) setShareViewToken(null);
  else if (token) localStorage.setItem(TOKEN_KEY, token);
  else {
    localStorage.removeItem(TOKEN_KEY);
    // What the dashboard kept on this device goes with the session (#6563).
    forgetDashboardCopies();
  }
  // Someone else now: nothing the last account read answers them (#6970).
  if (sessionIdentity() !== before) {
    resetPrimedReads();
    sessionChanged();
  }
}

/** An answer that arrived after the page began answering for someone else:
 *  it is the earlier account's, so it is never handed over (#6970). */
export const SESSION_CHANGED = "session_changed";

/** Fetch a binary endpoint with auth → an object URL (for <img>). Caller must
 *  revokeObjectURL when done. Returns null on any error. */
export async function fetchAuthBlobUrl(path: string): Promise<string | null> {
  try {
    const token = getToken();
    const res = await fetch(`/api/v1${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

/** A CSV the server writes for this reader, fetched with the session: the
 *  file, the name the server gave it, and whether it is the whole collection
 *  (a list past its cap says so in a header rather than passing as all of it). */
export async function fetchCsv(path: string): Promise<{ blob: Blob; filename: string; complete: boolean; secretsOmitted?: boolean }> {
  const token = getToken();
  const res = await fetch(`/api/v1${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, body?.error?.code ?? "export_failed", body?.error?.message ?? "The file could not be made. Try again.");
  }
  const named = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
  return { blob: await res.blob(), filename: named ?? "export.csv", complete: res.headers.get("x-export-complete") !== "false", secretsOmitted: res.headers.get("x-export-secrets") === "omitted" };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    /** A refusal explained: the prerequisite in words and whether asking is a
     *  remedy (blocked-action.ts). The sheet in the shell reads it; a caller
     *  that shows `message` in a toast needs to know nothing about it. */
    public readonly blocked?: BlockedAction,
    /** Retry-After, in seconds, when the server said how long to wait (429,
     *  503). Null when it did not; see request-failure.ts for what it means. */
    public readonly retryAfterSec: number | null = null,
  ) {
    super(message);
  }
}

/** A multipart upload through the page's one upload door (sendUpload): a
 *  refusal thrown as an ApiError carrying the server's own sentence (which
 *  names the size and the limit), a dropped connection as one that says so. */
export function upload<T>(url: string, form: FormData, file: File | null): Promise<T> {
  return counted(() => sendUploadCounted<T>(url, form, file));
}

async function sendUploadCounted<T>(url: string, form: FormData, file: File | null): Promise<T> {
  let res: Response;
  try {
    res = await sendUpload(url, form, { token: getToken(), file });
  } catch (err) {
    if (err instanceof UploadError) throw new ApiError(err.status, err.code, err.message);
    throw err;
  }
  if (!res.ok) {
    const e = await uploadErrorOf(res, file);
    throw new ApiError(res.status, e.code, e.message, e.personalCardOpened ? { personalCardOpened: true } : undefined);
  }
  return (await res.json()) as T;
}

// ── Connectivity signal ──────────────────────────────────────────────────
// One app-wide "can we reach the API?" flag. request() flips it: a fetch
// rejection (offline / server unreachable) or a gateway 5xx (502/503/504 =
// api/proxy down) marks us DOWN; any real HTTP response — even a 4xx — proves
// connectivity and clears it. <ConnectivityBanner> subscribes so a service
// outage shows one calm "reconnecting…" bar instead of raw per-request errors.
type ConnListener = (down: boolean) => void;
const connListeners = new Set<ConnListener>();
let apiDown = false;
function setApiDown(down: boolean): void {
  if (down === apiDown) return;
  apiDown = down;
  connListeners.forEach((l) => l(down));
}
export function subscribeConnectivity(listener: ConnListener): () => void {
  connListeners.add(listener);
  listener(apiDown);
  return () => {
    connListeners.delete(listener);
  };
}
// ── Offline copies ───────────────────────────────────────────────────────
// Offline, the service worker answers a read it kept with the time it was
// fetched (x-cobblr-offline-as-of) and a read it never kept with 503
// x-cobblr-offline (src/sw/sw-logic.js). The earliest such time on screen is
// what the banner says ("what you had as of 14:02"), so a kept copy is never
// shown as live. A real answer from the network clears it.
type OfflineListener = (asOf: string | null) => void;
const offlineListeners = new Set<OfflineListener>();
let offlineAsOf: string | null = null;
function setOfflineAsOf(next: string | null): void {
  if (next === offlineAsOf) return;
  offlineAsOf = next;
  offlineListeners.forEach((l) => l(next));
}
export function subscribeOfflineCopies(listener: OfflineListener): () => void {
  offlineListeners.add(listener);
  listener(offlineAsOf);
  return () => {
    offlineListeners.delete(listener);
  };
}
/** What a person reads when a write or an unopened read is made offline. */
export { OFFLINE_SENTENCE };

/** The 5xx the api itself answers with a reason: never a gateway's "down". */
const API_ANSWERED_5XX = new Set(["tenant_unprovisioned"]);
async function answeredByTheApi(res: Response): Promise<boolean> {
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return false;
  const code = await res.clone().json().then((b: { error?: { code?: string } }) => b?.error?.code).catch(() => undefined);
  return !!code && API_ANSWERED_5XX.has(code);
}

/** Liveness ping the banner polls while down, so it auto-clears on recovery
 *  even when the user is idle (no in-flight request to flip the flag). */
export async function pingHealth(): Promise<boolean> {
  try {
    const res = await fetch(`/api/v1/healthz`, { cache: "no-store" });
    setApiDown(res.status >= 502 && res.status <= 504);
    return res.ok;
  } catch {
    setApiDown(true);
    return false;
  }
}

// ── Workspace shape ──────────────────────────────────────────────────────
// Every workspace response carries the workspace's SHAPE version: which modules
// are on, which collections and bundles it has (api platform/workspace-shape.ts).
// When it moves, whatever changed it (an install inside a receipt filing, an
// enable from another tab), the app's cached menu, destinations and counts for
// that workspace are stale, and useWorkspaceShapeRefresh refetches them. Read
// here because every workspace call passes through here: one door, not a list
// of mutations that remember to invalidate (#3582).
type ShapeListener = (slug: string) => void;
const shapeListeners = new Set<ShapeListener>();
const seenShape = new Map<string, string>();
export function subscribeWorkspaceShape(listener: ShapeListener): () => void {
  shapeListeners.add(listener);
  return () => {
    shapeListeners.delete(listener);
  };
}
/** Note a response's shape version; tell listeners when a workspace's moved.
 *  The first sighting only records: the page loaded against it already. */
export function noteWorkspaceShape(path: string, header: string | null): void {
  const m = /^\/orgs\/([^/?#]+)/.exec(path);
  if (!m || !header) return;
  const slug = decodeURIComponent(m[1]!);
  const prev = seenShape.get(slug);
  seenShape.set(slug, header);
  if (prev !== undefined && prev !== header) shapeListeners.forEach((l) => l(slug));
}

// A write that landed in a workspace: the numbers waiting in its nav (the
// Scan Inbox row's pending count, any module's declared count) may have
// moved. They poll, but a person who just filed the last item should not see
// "1" beside the inbox for another fifteen seconds (#3582). Told here for the
// same reason as the shape: every workspace write passes through here.
// The door itself is shared with the modules' own clients
// (@cobblr/platform-web workspace-writes), so their writes are told too.
export { subscribeWorkspaceWrite } from "@cobblr/platform-web";

// A write that can change whether AI works here (a connection or its routing,
// a share, the AI switch, a provider): every reader of AI availability is
// stale. Told here, where every such write passes, so the refresh does not
// depend on each mutation remembering which keys to invalidate (#3654: a
// saved route left Cobb saying AI was off until a reload).
const aiListeners = new Set<() => void>();
export function subscribeAiAvailability(listener: () => void): () => void {
  aiListeners.add(listener);
  return () => {
    aiListeners.delete(listener);
  };
}
function noteAiAvailabilityWrite(path: string): void {
  if (AI_AVAILABILITY_WRITE.test(path)) aiListeners.forEach((l) => l());
}

/** Ids, in order, as many as keep a query string well under what a proxy
 *  accepts (8 KB): what an older api's GET door can be asked. */
export function idsThatFitAUrl(ids: readonly string[], budget = 6_000): string[] {
  const out: string[] = [];
  let used = 0;
  for (const id of ids) {
    const cost = encodeURIComponent(id).length + 3;
    if (used + cost > budget) break;
    out.push(id);
    used += cost;
  }
  return out;
}

/** A lookup whose ids ride in a body (#4653), asked of an api that may still
 *  be the one before it. The web and the api roll out separately, so for a
 *  while the new page can meet the old api, which has only the GET door and
 *  answers the POST 404 (#4673: every machines, assets and project page on a
 *  staging walk mid-deploy). A 404 asks the older door instead, with as many
 *  ids as fit in its URL. */
export async function lookupInBody<T>(postPath: string, body: unknown, olderGet: () => string): Promise<T> {
  try {
    return await request<T>("POST", postPath, body);
  } catch (err) {
    // 404-is: an-older-api: a web deployed ahead of its api asks the older GET door
    if (err instanceof ApiError && err.status === 404) return request<T>("GET", olderGet());
    throw err;
  }
}

export { subscribeDeletedRecord } from "@cobblr/platform-web";

/** Every request the app makes, counted while it is in flight (in-flight.ts). */
export function request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const askedAs = sessionIdentity();
  const stale = () => new ApiError(0, SESSION_CHANGED, "Signed in as someone else since this was asked.");
  return carryingOn<T>(method, path, body, extraHeaders, null).then(
    (answer) => (sessionIdentity() === askedAs ? answer : Promise.reject(stale())),
    (e: unknown) => Promise.reject(sessionIdentity() === askedAs ? e : stale()),
  );
}

/** A refusal whose switch the person holds waits for them, uncounted (it is
 *  their choice, not the network): turned on, the same request runs again and
 *  its answer, done or a second refusal, is what the caller gets (#5890). */
async function carryingOn<T>(method: string, path: string, body: unknown, extraHeaders: Record<string, string> | undefined, applied: string | null): Promise<T> {
  try {
    return await counted(() => sendRequest<T>(method, path, body, extraHeaders));
  } catch (e) {
    const refused = e instanceof ApiError ? carriesOnItself(e.blocked, method, path, body) : null;
    if (!refused || !(e instanceof ApiError) || !e.blocked) throw e;
    const key = approvalDedupeKey(e.blocked.remedies);
    if (key === applied) {
      raiseBlockedAction({ blocked: e.blocked, refused, subject: null });
      throw e;
    }
    if ((await awaitBlockedAction({ blocked: e.blocked, refused, subject: null })) !== "applied") throw e;
    return carryingOn<T>(method, path, body, extraHeaders, key);
  }
}

async function sendRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  // Read before anything is waited on: whether a person's mutation sent this (waiting-writes.ts).
  const byAPerson = madeByAPerson();
  // A guest's read the server would refuse is refused here, unsent (acting-role.ts).
  if (refusedForGuest(method, path)) throw new ApiError(403, "guest_not_shared", GUEST_NOT_SHARED);
  // The page is going, with other credentials than it ran on (leaving View
  // as, opening a share's View as): it asks nothing more (page-leaving.ts).
  if (isPageLeaving()) return new Promise<T>(() => {});
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Kept for the blocked-action sheet: `body` is shadowed by the response
  // below, and a refusal needs the request as it was sent.
  const sent = body;
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // Operator impersonation: the grant rides alongside the operator's own Bearer.
  // withTenant resolves the tenant as the target member + enforces read-only.
  const impToken = getImpersonationToken();
  if (impToken) headers["X-Impersonation"] = impToken;

  let res: Response;
  try {
    // The dashboard's one snapshot may already hold this read; any other
    // method drops what it held (primed-reads.ts, #6563). A read already on
    // its way is answered by that one request (shared-reads.ts, #6613).
    const primed = await primedRead(method, path);
    res = primed
      ? new Response(JSON.stringify(primed.body), { status: primed.status, headers: { "content-type": "application/json" } })
      : await sharedRead(method, `${token ?? ""} ${impToken ?? ""} ${path}`, () =>
          fetch(`/api/v1${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
  } catch {
    // fetch only rejects on a network-level failure (offline, server
    // unreachable, DNS) — raise the app-wide "down" banner + a clear error.
    setApiDown(true);
    if (browserOffline()) {
      // Never sent, so it can be sent later without doubling: it waits on
      // this device, not only in this page (waiting-writes.ts, #7863).
      if (byAPerson && !impToken && !headers["x-cobblr-waited"]) keepWaitingWrite(method, path, body === undefined ? undefined : JSON.stringify(body), headers["Authorization"]);
      throw new ApiError(0, "offline", networkFailureMessage());
    }
    throw new ApiError(0, "network_error", networkFailureMessage());
  }
  // Offline, the service worker answered: a kept copy (marked with when it was
  // fetched) or "never kept". Either way we are not connected, and a kept copy
  // must be read as what you HAD, never as live.
  const keptAsOf = res.headers.get("x-cobblr-offline-as-of");
  if (keptAsOf !== null || res.headers.get("x-cobblr-offline") === "1") {
    setApiDown(true);
    if (keptAsOf !== null) setOfflineAsOf(offlineAsOf && offlineAsOf < keptAsOf ? offlineAsOf : keptAsOf || new Date(0).toISOString());
    else throw new ApiError(0, "offline", OFFLINE_SENTENCE);
  } else {
    // A gateway 5xx = proxy up but api/web down; any other response (even a
    // 4xx) proves connectivity and clears the banner. A 503 the api answers
    // itself, with a reason (a workspace not set up yet, #5146), is the api
    // up and saying why: "can't reach" over it was the wrong sentence.
    const down = res.status >= 502 && res.status <= 504 && !(await answeredByTheApi(res));
    setApiDown(down);
    if (!down) setOfflineAsOf(null);
  }
  noteWorkspaceShape(path, res.headers.get("x-cobblr-workspace-shape"));
  if (isMutating(method) && !impToken) landedWrite(method, path, headers["Authorization"]);
  if (res.ok && isMutating(method)) {
    noteWorkspaceWrite(path, res);
    noteAiAvailabilityWrite(path);
  }

  // Always try to parse JSON — our error responses are always JSON.
  // 204 is no-content; some 201s also send empty bodies (e.g.
  // /role-assignments). Treat any successful empty body as void.
  if (res.status === 204) return undefined as T;
  const contentLength = res.headers.get("content-length");
  if (res.ok && contentLength === "0") return undefined as T;

  // Read the body as TEXT first. `res.json()` CONSUMES it, so when parsing
  // threw, the one thing that said what actually went wrong was already gone —
  // and the error raised in its place, "Non-JSON response (502)", named the
  // transport rather than the cause. A user hit that on a long Ask Cobb turn
  // and it took hours of proxy, container and relay logs to recover a sentence
  // the response had been carrying the whole time (2026-08-18).
  const raw = await res.text();
  let parsed: unknown;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Empty-body success → treat as void rather than failing. Some
      // POST endpoints return 201 with no body (no content-length set
      // because the server didn't write one).
      if (res.ok) return undefined as T;
      if (res.status === 429) throw new ApiError(429, "rate_limited", busySentence(parseRetryAfter(res.headers.get("retry-after"))), undefined, undefined, parseRetryAfter(res.headers.get("retry-after")));
      throw new ApiError(res.status, "non_json", describeUnreadableBody(res.status, raw));
    }
  } else {
    if (res.ok) return undefined as T;
    if (res.status === 429) throw new ApiError(429, "rate_limited", busySentence(parseRetryAfter(res.headers.get("retry-after"))), undefined, undefined, parseRetryAfter(res.headers.get("retry-after")));
    throw new ApiError(res.status, "non_json", describeUnreadableBody(res.status, ""));
  }

  if (!res.ok) {
    const retryAfterSec = parseRetryAfter(res.headers.get("retry-after"));
    const body = parsed as {
      error?: { code?: string; message?: string; details?: unknown; blocked?: BlockedAction };
      message?: string;
    };
    const err = body.error;
    // A refusal that carries its explanation reaches the ONE sheet in the
    // shell, whichever surface made the call (#3073): the prerequisite in
    // words, the ask when there is one, and the refused request kept so a
    // yes can finish it. The surface's own toast still shows the sentence.
    // Any refusal that carries one, not only a 403: an app that is off
    // answers 409 with the ask attached (#3610).
    // A View as refuses every write, the page's own background ones too (a
    // lookup, a draft saved). Its refusal is raised by the mutation a person
    // started (main.tsx, the mutation cache), never here, or the sheet would
    // open on every page (#4687).
    const viewRefusal = err?.code === "share_view_read_only";
    if (res.status >= 400 && res.status < 500 && err?.blocked && isMutating(method) && !viewRefusal && !carriesOnItself(err.blocked, method, path, sent)) {
      raiseBlockedAction({ blocked: err.blocked, refused: refusedRequestFor(method, path, sent), subject: null });
    }
    // A route that answers `{ok:false,message}` is still TELLING us why. Reading
    // only `error.message` turned "a designs:item needs a name" into "HTTP 400"
    // for the person who had just pressed Confirm, and for the assistant that
    // could have corrected it. Take the reason from wherever it actually is.
    // A blank message is no reason: a server error thrown without one (a
    // failed connection's AggregateError says "") reached a toast as "" and
    // the toast showed nothing, so a failed save looked like no save at all.
    const reason =
      (err?.message?.trim() ? err.message : null) ??
      (typeof body.message === "string" && body.message.trim() ? body.message : null) ??
      (res.status >= 500 ? `${productName()} hit a problem on its side and did not say what (${res.status}). Try again.` : null);
    // The server saying the sandbox's hour is up ends it for the whole app,
    // whichever request heard it first; the workspace shell becomes the ending.
    if (res.status === 410 && err?.code === "sandbox_expired") markSandboxEnded("sandbox");
    // A kept trial past the length the person chose: the other ending.
    if (res.status === 410 && err?.code === "trial_expired") markSandboxEnded("trial");
    // A workspace whose database was never made: the shell says so and offers to finish it (#5146).
    if (res.status === 503 && err?.code === "tenant_unprovisioned") {
      const slug = slugOfRequest(path);
      if (slug) markWorkspaceUnfinished(decodeURIComponent(slug));
    }
    // A 429 is the server asking us to wait, and says so in the same words on
    // every page, whatever sentence the limiter that sent it happened to carry.
    const message =
      res.status === 429 && (err?.code ?? "rate_limited") === "rate_limited" ? busySentence(retryAfterSec) : reason ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, err?.code ?? "unknown", message, err?.details, err?.blocked, retryAfterSec);
  }
  return (method === "GET" && !impToken ? withWaitingWrites(path, parsed, headers["Authorization"]) : parsed) as T;
}

/** Primary-entity base for a host module (machines/assets/purchases).
 *  Instance-scoped when an instance slug is given (the platform's
 *  /instances/:name/items dispatches to the module's primary router);
 *  the legacy module route otherwise. `moduleRoute` is "<module>/<entity>"
 *  e.g. "machines/machines", "purchases/orders". */
export function primaryBase(slug: string, moduleRoute: string, instance?: string): string {
  return instance
    ? `/orgs/${slug}/instances/${instance}/items`
    : `/orgs/${slug}/modules/${moduleRoute}`;
}

/** A call that files (or sends back) scans: on success every screen showing
 *  the inbox refreshes, whichever door made the call (lib/scanFiled.ts). */
export function filed<T>(slug: string, p: Promise<T>, change?: (r: T) => ScanFiledChange): Promise<T> {
  return p.then((r) => {
    announceScanFiled(slug, change ? change(r) : {});
    return r;
  });
}

/** This browser's IANA zone, for a server that counts the reader's days. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
