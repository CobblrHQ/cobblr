// Paperless-ngx as a library of documents: the four library.* capabilities,
// spoken in Paperless's own REST API (https://docs.paperless-ngx.com/api/).
//
// One adapter (the group "paperless"): a person connects their Paperless once
// on Add a service, with its address, an API token and how to reach it
// (directly, or through their bridge when it lives on a home network), and
// that one connection finds, reads, links and copies. Every request goes
// through ctx.fetch, so the adapter never picks a transport and never holds
// a bridge. The token rides the Authorization header of each request and
// nowhere else: not in a job's input or output, not in an error, not in a log.

import type { AdapterFetch, AdapterResponse, BuiltInConnectionDef, BuiltInServiceContext, BuiltInServiceDef } from "@cobblr/platform-contract/services";
import { ADAPTER_TRANSIT_PROPERTY } from "@cobblr/platform-contract/services";
import { platform } from "@cobblr/platform-contract";

import {
  LIBRARY_CAPABILITY_DECLS,
  LIBRARY_COPY,
  LIBRARY_FIND,
  LIBRARY_GET,
  LIBRARY_LINK,
  type LibraryItem,
  type LibraryCopyInput,
  type LibraryFindInput,
  type LibraryGetInput,
  type LibraryLinkInput,
} from "@cobblr/platform-contract/library";

export const PAPERLESS_GROUP = "paperless";
/** The custom field Paperless keeps the Cobblr address in. */
export const PAPERLESS_LINK_FIELD = "Cobblr";
const EXCERPT = 2000;
const THUMB_MAX = 400 * 1024;

export const PAPERLESS_PUSH = {
  setup: {
    library: "Paperless",
    arrives: "new documents",
    before: ["In Paperless, open Workflows and add one.", "Trigger: Document Added.", "Action: Webhook, with this address:"],
    after: [
      "Turn on Use parameters for webhook body.",
      "Add a parameter named doc_url with value {{doc_url}}.",
      "Turn on Send webhook payload as JSON.",
    ],
  },
  refs: [
    ...["document_id", "doc_id", "id"].map(key => ({ path: [key], pattern: "^\\d{1,12}$" })),
    ...["doc_url", "document_url", "url"].map(key => ({ path: [key], pattern: "/documents/(\\d{1,12})(?:/|$)" })),
  ],
};
const connection: BuiltInConnectionDef = {
  title: "Paperless-ngx",
  summary: "Your receipts, manuals and warranties, matched to the things they belong to. Cobblr links to them where they are; nothing is copied unless you ask.",
  disconnect: {
    stops: "Matching, previews, and new links or copies from Paperless stop until you reconnect.",
    keeps: "Existing links stay on records, and copies already brought into Cobblr stay in Files.",
  },
  group: PAPERLESS_GROUP,
  metadata: { library: { push: PAPERLESS_PUSH } },
  config_schema: {
    type: "object",
    properties: {
      base_url: { type: "string", title: "Address", format: "uri", description: "Where Paperless answers, e.g. http://192.168.1.20:8000" },
      token: { type: "string", title: "API token", writeOnly: true, description: "From Paperless: your profile, then API auth token." },
      transit: ADAPTER_TRANSIT_PROPERTY,
    },
    required: ["base_url", "token"],
  },
  async test(config, ctx) {
    if (!ctx.fetch) return { ok: false, reason: "unreachable", error: "Give the address Paperless answers at." };
    const started = Date.now();
    let res: AdapterResponse;
    try {
      res = await ctx.fetch({ path: "/api/documents/?page_size=1", headers: auth(config) });
    } catch (err) {
      return { ok: false, reason: "unreachable", error: `Paperless did not answer: ${plainError(err)}` };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid_key", error: "Paperless did not accept this token. Copy it again from your Paperless profile." };
    if (res.status >= 500) return { ok: false, reason: "busy", error: `Paperless answered ${res.status}.` };
    const body = res.json as { count?: unknown } | null;
    if (res.status !== 200 || typeof body?.count !== "number") return { ok: false, reason: "unknown", error: `That address answered ${res.status}, not like Paperless does.` };
    const version = res.headers["x-version"];
    return { ok: true, note: `Paperless${version ? ` ${version}` : ""}, ${body.count} document${body.count === 1 ? "" : "s"}, answered in ${Date.now() - started} ms` };
  },
};

function auth(config: Record<string, string> | undefined): Record<string, string> {
  return { authorization: `Token ${config?.token ?? ""}`, accept: "application/json" };
}

/** An error in words a person can read, never a header or a body. */
function plainError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/Token\s+\S+/gi, "Token [hidden]").slice(0, 200);
}

function need(ctx: BuiltInServiceContext): { fetch: AdapterFetch; config: Record<string, string> } {
  if (!ctx.fetch || !ctx.config) throw new Error("This Paperless connection has no address.");
  return { fetch: ctx.fetch, config: ctx.config };
}

async function call(ctx: BuiltInServiceContext, path: string, init: { method?: "GET" | "POST" | "PATCH"; body?: unknown } = {}): Promise<AdapterResponse> {
  const { fetch, config } = need(ctx);
  const res = await fetch({ path, method: init.method ?? "GET", headers: auth(config), ...(init.body !== undefined ? { body: init.body } : {}) });
  if (res.status === 401 || res.status === 403) throw new Error("Paperless did not accept the token on this connection.");
  if (res.status === 404) throw new Error("Paperless has no such document.");
  if (res.status >= 400) throw new Error(`Paperless answered ${res.status}.`);
  return res;
}

interface PaperlessDoc {
  id: number;
  title?: string;
  created?: string;
  created_date?: string;
  tags?: number[];
  content?: string;
  custom_fields?: Array<{ field: number; value: unknown }>;
}

async function tagNames(ctx: BuiltInServiceContext, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  try {
    const res = await call(ctx, `/api/tags/?id__in=${[...new Set(ids)].join(",")}&page_size=100`);
    for (const t of ((res.json as { results?: Array<{ id: number; name: string }> } | null)?.results ?? [])) out.set(t.id, t.name);
  } catch {
    // Tags are a nicety; a document without its tag names is still the document.
  }
  return out;
}

function summaryOf(d: PaperlessDoc, base: string, tags: Map<number, string>): LibraryItem {
  return {
    ref: String(d.id),
    type: "document",
    type_label: "Documents",
    open_label: "Open in Paperless",
    title: (d.title ?? "").slice(0, 500) || `Document ${d.id}`,
    created: d.created_date ?? (d.created ? d.created.slice(0, 10) : null),
    tags: (d.tags ?? []).map((t) => tags.get(t)).filter((t): t is string => !!t),
    open_url: base ? `${base}/documents/${d.id}/details` : null,
    has_thumb: true,
    ...(d.content ? { excerpt: d.content.slice(0, EXCERPT) } : {}),
  };
}

/** The address a person opens Paperless at: the connection's own, so a link
 *  works wherever Paperless itself does. */
function baseOf(ctx: BuiltInServiceContext): string {
  return (ctx.config?.base_url ?? "").trim().replace(/\/+$/, "");
}

/** Words Paperless's full-text search reads as a phrase or as words that
 *  must all appear, never as its own query syntax. */
function phrase(s: string): string {
  return `"${s.replace(/["\\]/g, " ").trim()}"`;
}
function wordsOf(s: string): string {
  return s
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 8)
    .join(" ");
}

async function search(ctx: BuiltInServiceContext, params: string, limit: number, page = 1): Promise<{ results: PaperlessDoc[]; more: boolean }> {
  const res = await call(ctx, `/api/documents/?${params}&page_size=${limit}&page=${page}`);
  const body = res.json as { results?: PaperlessDoc[]; next?: string | null } | null;
  return { results: body?.results ?? [], more: !!body?.next };
}

const find: BuiltInServiceDef = {
  id: "paperless.find",
  name: "Paperless-ngx",
  capability: LIBRARY_CAPABILITY_DECLS[LIBRARY_FIND],
  connection,
  async run(ctx) {
    const input = (ctx.input ?? {}) as LibraryFindInput;
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const docs = new Map<number, PaperlessDoc>();
    const add = (list: PaperlessDoc[]) => {
      for (const d of list) if (!docs.has(d.id)) docs.set(d.id, d);
    };
    // A cursor is Paperless's own page number, for the two searches that can
    // run long (what someone typed, what was added since).
    const page = Math.max(1, Number(input.cursor) || 1);
    let more = false;
    if (typeof input.query === "string" && input.query.trim()) {
      const r = await search(ctx, `query=${encodeURIComponent(wordsOf(input.query))}`, limit, page);
      add(r.results);
      more = r.more;
    } else if (input.since) {
      // What was added since the last look: the catch-up for a workspace
      // whose Paperless sends no webhook.
      const r = await search(ctx, `added__gt=${encodeURIComponent(input.since)}&ordering=-added`, limit, page);
      add(r.results);
      more = r.more;
    } else {
      const f = input.facts;
      // A code printed on the document is the strongest match there is: ask
      // for it as a phrase first, then for the name's words.
      const codes = [...new Set([f?.serial, f?.barcode, f?.model, ...(f?.identifiers ?? [])].filter((code): code is string => !!code))];
      for (const code of codes) {
        if (code && code.trim().length >= 4 && docs.size < limit) add((await search(ctx, `query=${encodeURIComponent(phrase(code))}`, limit)).results);
      }
      const name = wordsOf(f?.name ?? "");
      if (name && docs.size < limit) add((await search(ctx, `query=${encodeURIComponent(name)}`, limit)).results);
    }
    const list = [...docs.values()].slice(0, limit);
    const tags = await tagNames(ctx, list.flatMap((d) => d.tags ?? []));
    return { output: { items: list.map((d) => summaryOf(d, baseOf(ctx), tags)), next: more ? String(page + 1) : null } };
  },
};

const get: BuiltInServiceDef = {
  id: "paperless.get",
  name: "Paperless-ngx",
  capability: LIBRARY_CAPABILITY_DECLS[LIBRARY_GET],
  connection,
  async run(ctx) {
    const input = (ctx.input ?? {}) as LibraryGetInput;
    const id = refOf(input.ref);
    const doc = (await call(ctx, `/api/documents/${id}/`)).json as PaperlessDoc | null;
    if (!doc || typeof doc.id !== "number") throw new Error("Paperless answered without the document.");
    const tags = await tagNames(ctx, doc.tags ?? []);
    let thumb: { type: string; base64: string } | null = null;
    if (input.include === "thumb") {
      try {
        const res = await call(ctx, `/api/documents/${id}/thumb/`);
        if (res.bytes.byteLength && res.bytes.byteLength <= THUMB_MAX) {
          thumb = { type: (res.headers["content-type"] ?? "image/webp").split(";")[0]!.trim(), base64: Buffer.from(res.bytes).toString("base64") };
        }
      } catch {
        thumb = null;
      }
    }
    return { output: { item: summaryOf(doc, baseOf(ctx), tags), thumb } };
  },
};

/** Paperless's id for a document, from Cobblr's ref for it. */
function refOf(ref: unknown): number {
  const n = Number(String(ref ?? "").trim());
  if (!Number.isInteger(n) || n <= 0) throw new Error("That is not a Paperless document.");
  return n;
}

const link: BuiltInServiceDef = {
  id: "paperless.link",
  name: "Paperless-ngx",
  capability: LIBRARY_CAPABILITY_DECLS[LIBRARY_LINK],
  connection,
  async run(ctx) {
    const input = (ctx.input ?? {}) as LibraryLinkInput;
    const id = refOf(input.ref);
    // The field Cobblr writes into: made once, found by name after that.
    const fields = ((await call(ctx, "/api/custom_fields/?page_size=100")).json as { results?: Array<{ id: number; name: string }> } | null)?.results ?? [];
    let field = fields.find((f) => f.name.toLowerCase() === PAPERLESS_LINK_FIELD.toLowerCase())?.id;
    if (!field) {
      const made = (await call(ctx, "/api/custom_fields/", { method: "POST", body: { name: PAPERLESS_LINK_FIELD, data_type: "url" } })).json as { id?: number } | null;
      field = made?.id;
      if (!field) throw new Error("Paperless did not make the Cobblr field.");
    }
    const doc = (await call(ctx, `/api/documents/${id}/`)).json as PaperlessDoc | null;
    const others = (doc?.custom_fields ?? []).filter((c) => c.field !== field);
    await call(ctx, `/api/documents/${id}/`, { method: "PATCH", body: { custom_fields: [...others, { field, value: input.record_url }] } });
    return { output: { linked: true } };
  },
};

const copy: BuiltInServiceDef = {
  id: "paperless.copy",
  name: "Paperless-ngx",
  capability: LIBRARY_CAPABILITY_DECLS[LIBRARY_COPY],
  connection,
  async run(ctx) {
    const input = (ctx.input ?? {}) as LibraryCopyInput;
    const id = refOf(input.ref);
    const res = await call(ctx, `/api/documents/${id}/download/`);
    const type = (res.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();
    const disposition = res.headers["content-disposition"] ?? "";
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    const name = named ? decodeURIComponent(named) : `paperless-${id}${type === "application/pdf" ? ".pdf" : ""}`;
    // Where the job keeps its outputs decides (the requester's Vault for a
    // personal document, #5871); written here, a bill of sale would always
    // meet the shared-Files refusal.
    const stored = ctx.keepFile ? await ctx.keepFile(res.bytes, { filename: name, mimeType: type }) : await platform().files.write(ctx.orgId, res.bytes, { filename: name, mimeType: type });
    if (!stored) throw new Error("This workspace cannot store files right now.");
    return { output: { name, type }, files: { file: stored.fileId } };
  },
};

export const PAPERLESS_BUILT_INS: BuiltInServiceDef[] = [find, get, link, copy];

let registered = false;
export function registerPaperless(): void {
  if (registered) return;
  registered = true;
  for (const def of PAPERLESS_BUILT_INS) platform().services.registerBuiltIn(def);
}
