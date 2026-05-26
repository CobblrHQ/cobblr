// url-archive — real-world sandboxed module.
//
// Workflow:
//   POST /add          { url, note? } → INSERT row, RESPOND with id
//   POST /list         → SELECT all rows, RESPOND with JSON array
//   POST /refresh-all  → for each row without a title, HOST_FETCH the
//                        url, extract <title>, UPDATE row
//   POST /clear        → DELETE all rows
//
// The wasm never parses JSON itself. The request body is stored
// verbatim in the payload jsonb column; Postgres extracts fields
// via SQL operators (payload->>'url'). For HOST_FETCH responses
// the wasm hands the body back to Postgres via parameter binding;
// regexp_replace pulls out the <title>.

import {
  activityLog,
  tenantQuery,
  tenantExec,
  fetchHost,
  getRequestBody,
  respond,
  log,
  jsonStr,
} from "./sdk";

// Re-export the SDK's host-callable allocator so AS doesn't DCE it.
// The host runtime probes for `cobblr_alloc` first when assigning a
// buffer for kernel-call responses — it pins the bytes so they
// survive AS's GC between the host writing them and our SDK reading.
export { cobblr_alloc, cobblr_dealloc } from "./sdk";

export function add(): void {
  const req = getRequestBody();
  // The host's HOST_GET_REQUEST_BODY response is JSON:
  //   { "body": "...", "query": {...}, "route": "..." }
  // We need to extract the body string and pass it to Postgres
  // as ?::jsonb. Cheap extraction by string search; format is
  // known to be a single key "body" at the top level.
  const body = extractStringField(req, "body");
  if (body.length === 0) {
    respond('{"error":"empty body"}', 400);
    return;
  }
  const exec = tenantExec(
    "INSERT INTO url_archive_items (payload) VALUES (?::jsonb) RETURNING id",
    "[" + jsonStr(body) + "]",
  );
  activityLog("add", body);
  respond(exec, 201);
}

export function list(): void {
  const rows = tenantQuery(
    "SELECT id::text AS id, payload->>'url' AS url, payload->>'note' AS note, title, fetched_at::text AS fetched_at, created_at::text AS created_at FROM url_archive_items ORDER BY created_at DESC LIMIT 200",
  );
  respond(rows, 200);
}

export function refresh_all(): void {
  // 1. Find rows without a title.
  const pending = tenantQuery(
    "SELECT id::text AS id, payload->>'url' AS url FROM url_archive_items WHERE title IS NULL LIMIT 20",
  );
  log("refresh_all: pending=" + pending);
  // 2. For each row, fetch + extract title + update.
  //    Hand-roll a tiny iterator over the rows JSON. AS doesn't
  //    ship a JSON parser; we do enough char-scan to pull "id"
  //    and "url" pairs out of the well-formed rows array. Format
  //    is { "rows": [{"id":"...","url":"..."}, ...] }.
  let refreshed: i32 = 0;
  let pos = pending.indexOf('"rows":');
  if (pos < 0) {
    respond('{"refreshed":0}', 200);
    return;
  }
  while (pos < pending.length) {
    const idStart = pending.indexOf('"id":"', pos);
    if (idStart < 0) break;
    const idValStart = idStart + 6;
    const idValEnd = pending.indexOf('"', idValStart);
    if (idValEnd < 0) break;
    const id = pending.substring(idValStart, idValEnd);
    const urlStart = pending.indexOf('"url":"', idValEnd);
    if (urlStart < 0) break;
    const urlValStart = urlStart + 7;
    const urlValEnd = pending.indexOf('"', urlValStart);
    if (urlValEnd < 0) break;
    const url = pending.substring(urlValStart, urlValEnd);
    pos = urlValEnd;

    const fetched = fetchHost("GET", url, "{}");
    // Extract <title> in the wasm so Postgres sees a small string,
    // not 100KB+ of HTML. AS string concat is O(N^2) per
    // re-allocation; never round-trip large blobs through the SDK
    // helpers. indexOf is bytes-only + fast.
    const body = extractStringField(fetched, "body");
    const title = extractTitle(body);
    tenantExec(
      "UPDATE url_archive_items SET title = ?, fetched_at = now() WHERE id = ?::uuid",
      "[" + jsonStr(title) + "," + jsonStr(id) + "]",
    );
    refreshed++;
  }
  activityLog("refresh_all", "refreshed " + refreshed.toString() + " row(s)");
  respond('{"refreshed":' + refreshed.toString() + '}', 200);
}

export function clear(): void {
  const r = tenantExec("DELETE FROM url_archive_items");
  activityLog("clear", r);
  respond(r, 200);
}

// Extract the contents of the first <title>…</title> tag (case-
// insensitive). Returns "" if not found. Uses indexOf — O(N), no
// regex engine in AS.
function extractTitle(html: string): string {
  const lower = html.toLowerCase();
  const start = lower.indexOf("<title");
  if (start < 0) return "";
  const closeOfOpen = lower.indexOf(">", start);
  if (closeOfOpen < 0) return "";
  const end = lower.indexOf("</title>", closeOfOpen);
  if (end < 0) return "";
  return html.substring(closeOfOpen + 1, end).trim();
}

// Find a top-level JSON string-valued field + unescape the captured
// value. Caller knows the envelope shape from the host (e.g.
// { "body": "...", "query": {}, ... }). We walk to the key + capture
// between matching quotes, decoding common JSON escapes (\" \\ \n
// \r \t \/ \b \f). Unicode escapes (\uXXXX) we DON'T handle — the
// host doesn't emit them for our payloads.
function extractStringField(jsonStr: string, key: string): string {
  const marker = '"' + key + '":';
  const at = jsonStr.indexOf(marker);
  if (at < 0) return "";
  let i = at + marker.length;
  while (i < jsonStr.length) {
    const c = jsonStr.charCodeAt(i);
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
      i++;
      continue;
    }
    break;
  }
  if (i >= jsonStr.length || jsonStr.charCodeAt(i) !== 0x22) return "";
  i++;
  let out = "";
  while (i < jsonStr.length) {
    const c = jsonStr.charCodeAt(i);
    if (c === 0x5c && i + 1 < jsonStr.length) {
      const next = jsonStr.charCodeAt(i + 1);
      if (next === 0x22) out += '"';
      else if (next === 0x5c) out += "\\";
      else if (next === 0x2f) out += "/";
      else if (next === 0x6e) out += "\n";
      else if (next === 0x72) out += "\r";
      else if (next === 0x74) out += "\t";
      else if (next === 0x62) out += "";
      else if (next === 0x66) out += "";
      else out += String.fromCharCode(next); // unknown — keep raw
      i += 2;
      continue;
    }
    if (c === 0x22) return out;
    out += String.fromCharCode(c);
    i++;
  }
  return out;
}
