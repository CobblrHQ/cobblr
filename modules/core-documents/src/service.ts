// What every door does with a record's library items (documents, games):
// the panel's routes, the
// actions Cobb and MCP invoke, and the undo. One copy, so an item linked by
// a person and one linked by the assistant are the same link.

import { platform } from "@cobblr/platform-contract";
import { publicBaseUrl } from "@cobblr/platform-contract/public-url";
import {
  LIBRARY_ITEM_KIND,
  LIBRARY_LINK_REL,
  LIBRARY_COPY,
  LIBRARY_FIND,
  LIBRARY_LINK,
  libraryTargetId,
  scoreItemMatch,
  type LibraryItem,
} from "@cobblr/platform-contract/library";
import type { ServiceConnectionHolder, ServiceJobRef } from "@cobblr/platform-contract/services";
import { findOn, getOn, holdersOf, readFacts, type Db } from "./matching.js";

/** The libraries this person may ask, here: the connections in their
 *  own order for library.find (theirs, then the workspace's shared ones),
 *  or the shared ones alone when no person is asking. */
export async function systemsFor(orgId: string, userId: string | null): Promise<ServiceConnectionHolder[]> {
  const all = await holdersOf(orgId);
  if (!userId) return all.filter((h) => h.shared);
  const chain = await platform().services.chainFor(orgId, userId, LIBRARY_FIND).catch(() => ({ steps: [] }));
  const ids = new Set(chain.steps.map((s) => s.credential_id).filter((id): id is string => !!id));
  return all.filter((h) => ids.has(h.credentialId) && (h.shared || h.ownerUserId === userId));
}

function activityRef(record: { kind: string; id: string }) {
  const [module, type] = record.kind.split(":", 2);
  return { module: module ?? null, entityType: type ?? "item", entityId: record.id };
}

/** What each library this person can ask here does beyond find and get:
 *  write the record's address back onto an item, bring a copy in. A library
 *  that cannot is never offered the button. */
export async function abilitiesOf(orgId: string): Promise<Map<string, { link: boolean; copy: boolean; provider: string | null }>> {
  const [link, copy] = await Promise.all([
    platform().services.connectionsFor(orgId, LIBRARY_LINK).catch(() => []),
    platform().services.connectionsFor(orgId, LIBRARY_COPY).catch(() => []),
  ]);
  const can = new Map<string, { link: boolean; copy: boolean; provider: string | null }>();
  const at = (id: string) => can.get(id) ?? can.set(id, { link: false, copy: false, provider: null }).get(id)!;
  for (const h of await platform().services.connectionsFor(orgId, LIBRARY_FIND).catch(() => [])) at(h.credentialId).provider = h.provider;
  for (const h of link) at(h.credentialId).link = true;
  for (const h of copy) at(h.credentialId).copy = true;
  return can;
}

export class LibraryRefusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "LibraryRefusal";
  }
}

async function systemOf(orgId: string, userId: string | null, connectionId: string): Promise<ServiceConnectionHolder> {
  const s = (await systemsFor(orgId, userId)).find((h) => h.credentialId === connectionId);
  if (!s) throw new LibraryRefusal(403, "That library is not one you can use in this workspace.");
  return s;
}

/** Find, fresh, across every system this person may ask: what they typed,
 *  or the record's own facts. Each system's answer or why it gave none. */
export async function findFresh(
  orgId: string,
  userId: string | null,
  record: { kind: string; id: string },
  query?: string,
): Promise<Array<{ connection_id: string; label: string; items: Array<LibraryItem & { score: number }>; error?: string }>> {
  const facts = (await readFacts(orgId, record.kind, record.id)) ?? { name: "" };
  const out = [];
  for (const s of await systemsFor(orgId, userId)) {
    try {
      const docs = await findOn(orgId, s.credentialId, query?.trim() ? { query: query.trim(), facts, limit: 20 } : { facts, limit: 20 });
      out.push({
        connection_id: s.credentialId,
        label: s.label,
        // The excerpt is for scoring, never for a page.
        items: docs.map(({ excerpt: _excerpt, ...d }) => ({ ...d, score: scoreItemMatch(facts, { title: d.title, excerpt: _excerpt ?? "", match: d.match ?? null }).score })),
      });
    } catch (err) {
      out.push({ connection_id: s.credentialId, label: s.label, items: [], error: `${s.label} didn't answer: ${(err as Error).message}` });
    }
  }
  return out;
}

/** Where the record is, as an address a library can store. */
async function recordUrl(orgId: string, kind: string, id: string, origin?: string | null): Promise<string> {
  const path = (await platform().entities.detailPathForEntity(orgId, kind, id).catch(() => undefined)) ?? "";
  const base = (origin ?? "").replace(/\/+$/, "") || publicBaseUrl();
  return `${base}${path}`;
}

export interface LinkResult {
  linked: { connection_id: string; ref: string; title: string; system: string };
  /** The write-back job, when one was asked for. */
  write_back: ServiceJobRef | null;
  already: boolean;
}

/** Link one item to one record: the pairing (the link itself), what the
 *  panel shows of it, and, when asked, the record's address written onto the
 *  item. The person must be able to use the library it is in. */
export async function linkItem(
  orgId: string,
  db: Db,
  userId: string | null,
  record: { kind: string; id: string },
  connectionId: string,
  ref: string,
  opts: { writeBack?: boolean; origin?: string | null } = {},
): Promise<LinkResult> {
  const system = await systemOf(orgId, userId, connectionId);
  const existing = await db
    .selectFrom("core_documents_linked")
    .select(["title"])
    .where("record_id", "=", record.id)
    .where("connection_id", "=", connectionId)
    .where("ref", "=", ref)
    .executeTakeFirst();
  let title = existing?.title ?? "";
  if (!existing) {
    const got = await getOn(orgId, connectionId, ref).catch((err) => {
      throw new LibraryRefusal(502, `${system.label} didn't answer: ${(err as Error).message}`);
    });
    const d = got.item;
    title = d.title;
    await db
      .insertInto("core_documents_linked")
      .values({
        record_kind: record.kind,
        record_id: record.id,
        connection_id: connectionId,
        ref,
        title: d.title,
        created: d.created ?? null,
        tags: JSON.stringify(d.tags ?? []),
        open_url: d.open_url ?? null,
        has_thumb: d.has_thumb === true,
        item_type: d.type,
        item_type_label: d.type_label,
        subtitle: d.subtitle ?? null,
        open_label: d.open_label ?? null,
        system_label: system.label,
        linked_by: userId,
      })
      .onConflict((oc) => oc.columns(["record_id", "connection_id", "ref"]).doNothing())
      .execute();
    await platform().pairings.create({
      orgId,
      sourceKind: record.kind,
      sourceId: record.id,
      targetKind: LIBRARY_ITEM_KIND,
      targetId: libraryTargetId(connectionId, ref),
      relationshipKind: LIBRARY_LINK_REL,
      createdBy: userId,
      notes: `${d.title} (in ${system.label})`,
    });
    await platform()
      .activity.log({ orgId, userId, action: "library_item_linked", ref: activityRef(record), diff: { item: d.title, type: d.type, system: system.label } })
      .catch(() => undefined);
  }
  // A suggestion that is now a link is no longer a suggestion, for anyone.
  await db.deleteFrom("core_documents_suggestions").where("record_id", "=", record.id).where("connection_id", "=", connectionId).where("ref", "=", ref).execute();

  let job: ServiceJobRef | null = null;
  if (opts.writeBack) {
    const entity = await platform().entities.lookup(orgId, record.kind, record.id).catch(() => null);
    job = await platform().services.invoke({
      orgId,
      capability: LIBRARY_LINK,
      input: { ref, record_url: await recordUrl(orgId, record.kind, record.id, opts.origin), record_title: entity?.title ?? "" },
      via: { credentialId: connectionId },
      attachTo: { kind: record.kind, id: record.id },
    });
    if (job.status === "done") {
      await db.updateTable("core_documents_linked").set({ written_back: true }).where("record_id", "=", record.id).where("connection_id", "=", connectionId).where("ref", "=", ref).execute();
    }
  }
  return { linked: { connection_id: connectionId, ref, title, system: system.label }, write_back: job, already: !!existing };
}

/** Take a link away. Removing one that is not there is nothing, not an error. */
export async function unlinkItem(orgId: string, db: Db, userId: string | null, record: { kind: string; id: string }, connectionId: string, ref: string): Promise<{ removed: boolean; title: string | null }> {
  const row = await db
    .deleteFrom("core_documents_linked")
    .where("record_id", "=", record.id)
    .where("connection_id", "=", connectionId)
    .where("ref", "=", ref)
    .returning(["title"])
    .executeTakeFirst();
  await platform().pairings.remove({
    orgId,
    sourceKind: record.kind,
    sourceId: record.id,
    targetKind: LIBRARY_ITEM_KIND,
    targetId: libraryTargetId(connectionId, ref),
    relationshipKind: LIBRARY_LINK_REL,
  });
  if (row) {
    await platform()
      .activity.log({ orgId, userId, action: "library_item_unlinked", ref: activityRef(record), diff: { item: row.title } })
      .catch(() => undefined);
  }
  return { removed: !!row, title: row?.title ?? null };
}

/** Bring a copy of a linked or suggested item into Cobblr, attached to
 *  the record: a job, since a file can take a while. */
export async function copyItem(orgId: string, userId: string | null, record: { kind: string; id: string }, connectionId: string, ref: string): Promise<ServiceJobRef> {
  await systemOf(orgId, userId, connectionId);
  return platform().services.invoke({ orgId, capability: LIBRARY_COPY, input: { ref }, via: { credentialId: connectionId }, attachTo: { kind: record.kind, id: record.id } });
}

/** The item a sentence names ("the warranty PDF", "the Zelda cartridge"), among what this
 *  person's systems hold for this record: the best answer to those words,
 *  or null when nothing answers. */
export async function pickItem(orgId: string, userId: string | null, record: { kind: string; id: string }, words: string): Promise<{ connectionId: string; doc: LibraryItem } | null> {
  const found = await findFresh(orgId, userId, record, words);
  let best: { connectionId: string; doc: LibraryItem; score: number } | null = null;
  const facts = { name: words };
  for (const s of found) {
    for (const d of s.items) {
      const score = scoreItemMatch(facts, { title: d.title }).score + d.score / 10;
      if (!best || score > best.score) best = { connectionId: s.connection_id, doc: d, score };
    }
  }
  return best ? { connectionId: best.connectionId, doc: best.doc } : null;
}
