// A public page as a stranger sees it (#4502; docs/design-decisions/share-scope.md).
//
// The records come from the page's scope and each is projected through the
// link's visibility: the same two definitions, and the same projection, a
// share's mirror uses (scope-eval.ts, share-mirror.ts `project`), so a page
// and a share cannot disagree about what "prices off" means. Nothing internal
// reaches the page: a record is addressed by an opaque ref made from the link
// and the record, never its id, and references to other records are never
// projected at all.

import { createHmac } from "node:crypto";
import type { Kysely } from "kysely";
import { readScope, readVisibility, type ScopeRef, type VisibilityDef } from "@cobblr/platform-contract/share-scope";
import { saidLabel } from "@cobblr/platform-contract/activity-said";
import { env } from "../env.js";
import { gatedFields, recordsInScope } from "./scope-eval.js";
import { project } from "./share-mirror.js";
import { putFrameDoc } from "./frame-docs.js";
import { kindRecordForOrg } from "./entities.js";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";

/** Most records a page shows. */
const PAGE_CAP = 300;
const HIDDEN = new Set(["id", "name", "created_at", "updated_at", "instance", "image_path", "location_name"]);

export interface PublicRecord {
  ref: string;
  title: string;
  photo: string | null;
  place: string | null;
  fields: Array<{ name: string; label: string; value: unknown }>;
}

/** Each field of a kind in the words a person reads: the kind's own label,
 *  a custom field's display label, else the name spelt out. */
async function labelsOf(orgId: string, kind: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // A field the kind derives on read (a count of unnamed units, an object of
  // units) is bookkeeping, not something about the thing to show a stranger.
  for (const f of (await kindRecordForOrg(orgId, kind))?.fields ?? []) {
    if ((f as { readOnly?: boolean }).readOnly) out.set(f.name, "");
    else out.set(f.name, saidLabel(f.name, (f as { label?: string }).label));
  }
  for (const d of await platform().entities.fieldsFor(orgId, kind)) out.set(d.name, saidLabel(d.name, d.display_label));
  return out;
}

/** The handle a page uses for one of its records: stable for the link,
 *  meaningless anywhere else, and not the record's id. */
export function publicRef(linkId: string, r: ScopeRef): string {
  return createHmac("sha256", env.JWT_SECRET).update(`${linkId}\u0000${r.entity_kind}\u0000${r.id}`).digest("base64url").slice(0, 22);
}

async function oneRecord(
  orgId: string,
  linkId: string,
  token: string,
  ref: ScopeRef,
  vis: VisibilityDef,
  gated: ReadonlySet<string>,
  labels: Map<string, Map<string, string>>,
  showFields: readonly string[] | null = null,
): Promise<PublicRecord | null> {
  const p = await project(orgId, ref, vis, gated);
  if (!p) return null;
  if (!labels.has(ref.entity_kind)) labels.set(ref.entity_kind, await labelsOf(orgId, ref.entity_kind));
  const said = labels.get(ref.entity_kind)!;
  const fields: PublicRecord["fields"] = [];
  // A custom field is read out at the top level and in metadata both: once.
  const once = new Set<string>();
  for (const [k, v] of [...Object.entries(p.fields), ...Object.entries(p.metadata)]) {
    if (once.has(k)) continue;
    once.add(k);
    if (HIDDEN.has(k) || k.startsWith("origin_") || k.endsWith("_label") || v === null || v === undefined || v === "" || typeof v === "object") continue;
    if (said.get(k) === "") continue;
    fields.push({ name: k, label: said.get(k) ?? saidLabel(k), value: v });
  }
  // The page's chosen fields, in its order: never more than the visibility
  // let through above, only fewer.
  const chosen = showFields && showFields.length ? showFields.map((n) => fields.find((f) => f.name === n)).filter((f): f is PublicRecord["fields"][number] => !!f) : fields;
  return {
    ref: publicRef(linkId, ref),
    title: p.title,
    photo: p.photo ? `/api/v1/public/${token}/files/${p.photo.fileId}/raw` : null,
    place: p.place.text ?? (p.place.path ? p.place.path.join(" › ") : null),
    fields: chosen,
  };
}

/** Every record a public page's link shows, as a stranger sees it. */
export async function publicPageRecords(orgId: string, linkId: string, token: string, scope: unknown, vis: VisibilityDef, showFields: readonly string[] | null = null): Promise<PublicRecord[]> {
  const gated = new Set((await gatedFields(orgId)).map((f) => f.name));
  const { refs } = await recordsInScope(orgId, readScope(scope), { cap: PAGE_CAP });
  const labels = new Map<string, Map<string, string>>();
  const out: PublicRecord[] = [];
  for (const r of refs) {
    const one = await oneRecord(orgId, linkId, token, r, vis, gated, labels, showFields).catch(() => null);
    if (one) out.push(one);
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** One record of a page, by its ref, only if the scope still selects it. */
export async function publicPageRecord(orgId: string, linkId: string, token: string, scope: unknown, vis: VisibilityDef, ref: string, showFields: readonly string[] | null = null): Promise<PublicRecord | null> {
  const { refs } = await recordsInScope(orgId, readScope(scope), { cap: PAGE_CAP });
  const hit = refs.find((r) => publicRef(linkId, r) === ref);
  if (!hit) return null;
  return oneRecord(orgId, linkId, token, hit, vis, new Set((await gatedFields(orgId)).map((f) => f.name)), new Map(), showFields);
}

interface LabelDoorPage {
  id: string;
  name: string;
  scope: unknown;
  visibility: unknown;
  contact: string | null;
  public_until: Date | null;
  footer: boolean;
  show_fields: string[] | null;
  about: string | null;
  links: Array<{ label: string; url: string }>;
  skin_html: string | null;
  indexable: boolean;
  accent: string | null;
  created_by: string | null;
}

/** What a public record's page says around it: its words and its links. */
export interface PublicPageFrame {
  name: string;
  contact: string | null;
  public_until: string | null;
  footer: boolean;
  about: string | null;
  links: Array<{ label: string; url: string }>;
  /** The page has a custom look (Tier B): ask for its document. */
  skin: boolean;
  /** Search engines may list it; false, the page says noindex. */
  indexable: boolean;
  /** The workspace's brand, with the page's own accent over it. */
  theme: PublicTheme | null;
}

/** The brand tokens a public page wears: colours, font, corners and logo.
 *  Only these; a font address is left out, so a visitor's browser fetches
 *  nothing the page did not carry. */
export interface PublicTheme {
  bg?: string;
  surface?: string;
  text?: string;
  muted?: string;
  accent?: string;
  accent_text?: string;
  border?: string;
  font?: string;
  radius?: number;
  logo?: string;
}

const THEME_KEYS = ["bg", "surface", "text", "muted", "accent", "accent_text", "border", "font", "radius", "logo"] as const;

/** The workspace's brand (Settings, the dashboard's theme), with the page's
 *  accent over it; null when there is neither. */
export async function publicTheme(orgId: string, accent: string | null): Promise<PublicTheme | null> {
  const row = await meta.selectFrom("orgs").select("portal_config").where("id", "=", orgId).executeTakeFirst();
  const brand = ((row?.portal_config as { admin_theme?: Record<string, unknown> | null } | null)?.admin_theme ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of THEME_KEYS) if (brand[k] !== undefined && brand[k] !== null && brand[k] !== "") out[k] = brand[k];
  if (typeof out.logo === "string" && !/^(https:\/\/|data:image\/)/.test(out.logo)) delete out.logo;
  if (accent) out.accent = accent;
  return Object.keys(out).length ? (out as PublicTheme) : null;
}

/** The fields of a page row its frame reads. */
export interface FramedPage {
  name: string;
  contact: string | null;
  public_until: Date | null;
  footer: boolean;
  about: string | null;
  links: Array<{ label: string; url: string }> | null;
  skin_html: string | null;
  indexable: boolean;
  accent: string | null;
}

/** What a page says around its records, the same for a link and a label. */
export async function pageFrame(orgId: string, page: FramedPage): Promise<PublicPageFrame> {
  return {
    name: page.name,
    contact: page.contact,
    public_until: page.public_until ? new Date(page.public_until).toISOString() : null,
    footer: page.footer,
    about: page.about,
    links: page.links ?? [],
    skin: !!page.skin_html,
    indexable: page.indexable,
    theme: await publicTheme(orgId, page.accent),
  };
}

/** Booth mode: a page whose end has passed is private, links and labels. */
export function pageIsLive(page: { public_until: Date | null }, now = Date.now()): boolean {
  return !page.public_until || page.public_until.getTime() > now;
}

async function labelDoorPages(orgId: string): Promise<LabelDoorPage[]> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Kysely<{ core_public_surfaces_pages: LabelDoorPage & { label_door: boolean } }>;
  const rows = await db
    .selectFrom("core_public_surfaces_pages")
    .select(["id", "name", "scope", "visibility", "contact", "public_until", "footer", "show_fields", "about", "links", "skin_html", "indexable", "accent", "created_by"])
    .where("label_door", "=", true)
    .execute()
    .catch(() => []);
  return rows.filter((p) => pageIsLive(p));
}

/** The page that opens a record's label to strangers, if one does: a live
 *  page with its label door on whose scope selects the record. */
async function pageForLabel(orgId: string, id: string): Promise<LabelDoorPage | null> {
  for (const p of await labelDoorPages(orgId)) {
    const { refs } = await recordsInScope(orgId, readScope(p.scope), { cap: PAGE_CAP });
    if (refs.some((r) => r.id === id)) return p;
  }
  return null;
}

/** Does a stranger's scan of this record's label open a public view? */
export async function labelIsPublic(orgId: string, id: string): Promise<boolean> {
  return !!(await pageForLabel(orgId, id).catch(() => null));
}

/** The public pages a record can be seen through right now: live, its scope
 *  selects the record, and something opens it (a link that works, or its
 *  label door). For the chip on the record's own header. */
export async function recordPublicPages(orgId: string, id: string): Promise<Array<{ name: string; public_until: string | null; label_door: boolean; links: number }>> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Kysely<{
    core_public_surfaces_pages: { id: string; name: string; scope: unknown; public_until: Date | null; label_door: boolean };
    core_public_surfaces_surfaces: { id: string; scope_type: string; scope_id: string; enabled: boolean; revoked_at: Date | null; expires_at: Date | null };
  }>;
  const pages = await db.selectFrom("core_public_surfaces_pages").select(["id", "name", "scope", "public_until", "label_door"]).execute().catch(() => []);
  if (!pages.length) return [];
  const now = new Date();
  const links = await db
    .selectFrom("core_public_surfaces_surfaces")
    .select(["scope_id"])
    .where("scope_type", "=", "page")
    .where("enabled", "=", true)
    .where("revoked_at", "is", null)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
    .execute();
  const out: Array<{ name: string; public_until: string | null; label_door: boolean; links: number }> = [];
  for (const p of pages) {
    if (!pageIsLive(p)) continue;
    const n = links.filter((l) => l.scope_id === p.id).length;
    if (!n && !p.label_door) continue;
    const { refs } = await recordsInScope(orgId, readScope(p.scope), { cap: PAGE_CAP });
    if (!refs.some((r) => r.id === id)) continue;
    out.push({ name: p.name, public_until: p.public_until ? p.public_until.toISOString() : null, label_door: p.label_door, links: n });
  }
  return out;
}

/** A record as a stranger who scanned its label sees it, through the page
 *  that opens its label; null when no live page does. */
export async function labelPublicRecord(
  orgId: string,
  kind: string,
  id: string,
  qrToken: string,
): Promise<{ page: PublicPageFrame; record: PublicRecord; photoFileId: string | null; skinHtml: string | null; pageId: string; ownerId: string | null } | null> {
  const page = await pageForLabel(orgId, id);
  if (!page) return null;
  const { refs } = await recordsInScope(orgId, readScope(page.scope), { cap: PAGE_CAP });
  const ref = refs.find((r) => r.id === id) ?? { entity_kind: kind, id };
  const vis = readVisibility(page.visibility);
  const gated = new Set((await gatedFields(orgId)).map((f) => f.name));
  const p = await project(orgId, ref, vis, gated);
  const record = await oneRecord(orgId, `label:${page.id}`, "", ref, vis, gated, new Map(), page.show_fields);
  if (!record || !p) return null;
  const photoFileId = p.photo?.fileId ?? null;
  return {
    page: await pageFrame(orgId, page),
    record: { ...record, photo: photoFileId ? `/api/v1/public/label/photo/${photoFileId}?t=${encodeURIComponent(qrToken)}` : null },
    photoFileId,
    skinHtml: page.skin_html,
    pageId: page.id,
    ownerId: page.created_by,
  };
}

/** A stranger opened a record through its label: count it, and nothing else. */
export async function countLabelScan(orgId: string, pageId: string, ownerId: string | null): Promise<void> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Kysely<{ core_public_surfaces_label_scans: { page_id: string; day: string; count: number } }>;
  // The owner's day: they read the count, on their own calendar.
  const day = await platform().accounts.dayFor(ownerId);
  await db
    .insertInto("core_public_surfaces_label_scans")
    .values({ page_id: pageId, day, count: 1 })
    .onConflict((oc) => oc.columns(["page_id", "day"]).doUpdateSet((eb) => ({ count: eb("core_public_surfaces_label_scans.count", "+", 1) })))
    .execute();
}

/** A page's custom look (Tier B) as a sandboxed document: the owner's HTML,
 *  handed the record exactly as this page shows it and nothing more. The
 *  document has no network (frameDocPolicy), so what it was handed is all it
 *  can ever read. Answers the one-shot address to load it from. */
export function skinDocument(skinHtml: string, data: { record: PublicRecord; page: PublicPageFrame }): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const doc =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<script>window.__PUBLIC_DATA__=${json};window.cobblr={record:window.__PUBLIC_DATA__.record,page:window.__PUBLIC_DATA__.page};</script>` +
    `</head><body>${skinHtml}</body></html>`;
  return `/api/v1/frame-docs/${putFrameDoc(doc, "app-block")}`;
}

/** Every field a page's records show under its visibility, once each, for the
 *  owner choosing which a stranger sees and in what order. */
export async function publicPageFieldChoices(orgId: string, pageId: string): Promise<Array<{ name: string; label: string }>> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Kysely<{ core_public_surfaces_pages: { id: string; scope: unknown; visibility: unknown } }>;
  const page = await db.selectFrom("core_public_surfaces_pages").select(["scope", "visibility"]).where("id", "=", pageId).executeTakeFirst();
  if (!page) return [];
  const records = await publicPageRecords(orgId, `choices:${pageId}`, "", page.scope, readVisibility(page.visibility));
  const out = new Map<string, string>();
  for (const r of records.slice(0, 50)) for (const f of r.fields) if (!out.has(f.name)) out.set(f.name, f.label);
  return [...out].map(([name, label]) => ({ name, label }));
}
