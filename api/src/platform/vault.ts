// The Vault (#5242, docs/design-decisions/vault.md): folders of personal
// documents, each readable only by the people its folder names.
//
// The folder's access list decides, and nothing else: a workspace admin not on
// it is a stranger here. A folder or file someone cannot open answers exactly
// as one that does not exist (404, "not here"), and every list leaves it out,
// so nobody learns a name, a count or that one exists. Files are encrypted
// with the workspace credential key (db/crypto.ts, the secret fields' key) and
// decrypted only to hand them to someone on the list. Vault files are not
// records and not core-files files, so search, Cobb's record tools, shares,
// sends, public pages and the scan inbox cannot reach them by construction.
// Every open, download, move and access change is a vault_events row, read by
// the folder's owner; the workspace activity log, which everyone reads, never
// names a vault file.

/** The largest document the Vault keeps. */
export const VAULT_MAX_BYTES = 25 * 1024 * 1024;

export class VaultError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

const gone = () => new VaultError(404, "not_found", "That is not in your Vault.");
const ownersOnly = (what: string) => new VaultError(403, "owner_only", `Only the folder's owner can ${what}.`);

async function db() {
  return (await import("../db/meta.js")).meta;
}

export interface VaultPerson { id: string; name: string }
export interface VaultFolder {
  id: string;
  name: string;
  owner: VaultPerson | null;
  mine: boolean;
  people: VaultPerson[];
  file_count: number;
  created_at: string;
}
export interface VaultFile {
  id: string;
  folder_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  record: { kind: string; id: string } | null;
  added_by: VaultPerson | null;
  created_at: string;
}

async function people(ids: Array<string | null>): Promise<Map<string, VaultPerson>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const rows = await (await db()).selectFrom("users").select(["id", "display_name", "email"]).where("id", "in", want).execute();
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.display_name || r.email }]));
}

/** The folders this person may open: their own and those that name them. */
async function openableIds(orgId: string, userId: string): Promise<string[]> {
  const m = await db();
  const rows = await m
    .selectFrom("vault_folders as f")
    .leftJoin("vault_folder_members as fm", (j) => j.onRef("fm.folder_id", "=", "f.id").on("fm.user_id", "=", userId))
    .select("f.id")
    .where("f.org_id", "=", orgId)
    .where((eb) => eb.or([eb("f.owner_id", "=", userId), eb("fm.user_id", "=", userId)]))
    .execute();
  return [...new Set(rows.map((r) => r.id))];
}

async function folderRow(orgId: string, userId: string, folderId: string) {
  const m = await db();
  const f = await m.selectFrom("vault_folders").selectAll().where("id", "=", folderId).where("org_id", "=", orgId).executeTakeFirst();
  if (!f) throw gone();
  if (f.owner_id === userId) return f;
  const member = await m.selectFrom("vault_folder_members").select("id").where("folder_id", "=", folderId).where("user_id", "=", userId).executeTakeFirst();
  if (!member) throw gone();
  return f;
}

async function fileRow(orgId: string, userId: string, fileId: string) {
  const m = await db();
  const file = await m.selectFrom("vault_files").selectAll().where("id", "=", fileId).where("org_id", "=", orgId).executeTakeFirst();
  if (!file) throw gone();
  const folder = await folderRow(orgId, userId, file.folder_id);
  return { file, folder };
}

async function event(orgId: string, folderId: string | null, userId: string, action: string, file?: { id: string; name: string } | null, detail: Record<string, unknown> = {}) {
  await (await db())
    .insertInto("vault_events")
    .values({ org_id: orgId, folder_id: folderId, file_id: file?.id ?? null, file_name: file?.name ?? null, user_id: userId, action, detail: JSON.stringify(detail) as never })
    .execute();
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : String(d));

async function shapeFolders(userId: string, rows: Array<{ id: string; name: string; owner_id: string | null; created_at: Date }>): Promise<VaultFolder[]> {
  if (!rows.length) return [];
  const m = await db();
  const ids = rows.map((r) => r.id);
  const [members, counts] = await Promise.all([
    m.selectFrom("vault_folder_members").select(["folder_id", "user_id"]).where("folder_id", "in", ids).execute(),
    m.selectFrom("vault_files").select(["folder_id", (eb) => eb.fn.countAll<string>().as("n")]).where("folder_id", "in", ids).groupBy("folder_id").execute(),
  ]);
  const who = await people([...rows.map((r) => r.owner_id), ...members.map((x) => x.user_id)]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    owner: r.owner_id ? (who.get(r.owner_id) ?? null) : null,
    mine: r.owner_id === userId,
    people: members.filter((x) => x.folder_id === r.id && x.user_id).map((x) => who.get(x.user_id!)).filter((p): p is VaultPerson => !!p),
    file_count: Number(counts.find((c) => c.folder_id === r.id)?.n ?? 0),
    created_at: iso(r.created_at),
  }));
}

export async function listVaultFolders(orgId: string, userId: string): Promise<VaultFolder[]> {
  const ids = await openableIds(orgId, userId);
  if (!ids.length) return [];
  const rows = await (await db()).selectFrom("vault_folders").select(["id", "name", "owner_id", "created_at"]).where("id", "in", ids).orderBy("name").execute();
  return shapeFolders(userId, rows);
}

const cleanName = (raw: unknown, what: string): string => {
  const name = typeof raw === "string" ? raw.trim().replace(/[\u0000-\u001f]/g, "") : "";
  if (!name) throw new VaultError(400, "name_required", `Give the ${what} a name.`);
  if (name.length > 200) throw new VaultError(400, "name_too_long", `A ${what} name is at most 200 characters.`);
  return name;
};

export async function createVaultFolder(orgId: string, userId: string, name: unknown): Promise<VaultFolder> {
  const row = await (await db())
    .insertInto("vault_folders")
    .values({ org_id: orgId, name: cleanName(name, "folder"), owner_id: userId })
    .returning(["id", "name", "owner_id", "created_at"])
    .executeTakeFirstOrThrow();
  await event(orgId, row.id, userId, "folder_created");
  return (await shapeFolders(userId, [row]))[0]!;
}

export async function vaultFolder(orgId: string, userId: string, folderId: string): Promise<VaultFolder & { files: VaultFile[] }> {
  const f = await folderRow(orgId, userId, folderId);
  const [shaped] = await shapeFolders(userId, [f]);
  const files = await (await db())
    .selectFrom("vault_files")
    .select(["id", "folder_id", "name", "mime_type", "size_bytes", "record_kind", "record_id", "created_by", "created_at"])
    .where("folder_id", "=", folderId)
    .orderBy("created_at", "desc")
    .execute();
  const who = await people(files.map((x) => x.created_by));
  return {
    ...shaped!,
    files: files.map((x) => ({
      id: x.id,
      folder_id: x.folder_id,
      name: x.name,
      mime_type: x.mime_type,
      size_bytes: x.size_bytes,
      record: x.record_kind && x.record_id ? { kind: x.record_kind, id: x.record_id } : null,
      added_by: x.created_by ? (who.get(x.created_by) ?? null) : null,
      created_at: iso(x.created_at),
    })),
  };
}

export async function renameVaultFolder(orgId: string, userId: string, folderId: string, name: unknown): Promise<void> {
  const f = await folderRow(orgId, userId, folderId);
  if (f.owner_id !== userId) throw ownersOnly("rename it");
  const next = cleanName(name, "folder");
  await (await db()).updateTable("vault_folders").set({ name: next, updated_at: new Date() }).where("id", "=", folderId).execute();
  await event(orgId, folderId, userId, "folder_renamed", null, { from: f.name, to: next });
}

/** The folder's owner sets who else may open it, from the workspace's members.
 *  Nobody adds themselves: only the owner edits the list. */
export async function setVaultFolderPeople(orgId: string, userId: string, folderId: string, userIds: unknown): Promise<VaultFolder> {
  const f = await folderRow(orgId, userId, folderId);
  if (f.owner_id !== userId) throw ownersOnly("change who can open it");
  if (!Array.isArray(userIds) || userIds.some((x) => typeof x !== "string")) throw new VaultError(400, "bad_people", "List the people by id.");
  const wanted = [...new Set(userIds as string[])].filter((x) => x !== userId);
  const m = await db();
  if (wanted.length) {
    const members = await m.selectFrom("org_memberships").select("user_id").where("org_id", "=", orgId).where("user_id", "in", wanted).execute();
    const known = new Set(members.map((r) => r.user_id));
    const strangers = wanted.filter((x) => !known.has(x));
    if (strangers.length) throw new VaultError(400, "not_a_member", "Only people in this workspace can be given a Vault folder.");
  }
  const before = (await m.selectFrom("vault_folder_members").select("user_id").where("folder_id", "=", folderId).execute()).map((r) => r.user_id).filter((x): x is string => !!x);
  const added = wanted.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !wanted.includes(x));
  await m.transaction().execute(async (tx) => {
    if (removed.length) await tx.deleteFrom("vault_folder_members").where("folder_id", "=", folderId).where("user_id", "in", removed).execute();
    if (added.length) await tx.insertInto("vault_folder_members").values(added.map((id) => ({ org_id: orgId, folder_id: folderId, user_id: id, added_by: userId }))).onConflict((oc) => oc.columns(["folder_id", "user_id"]).doNothing()).execute();
  });
  if (added.length || removed.length) {
    const who = await people([...added, ...removed]);
    await event(orgId, folderId, userId, "access_changed", null, { added: added.map((x) => who.get(x)?.name ?? x), removed: removed.map((x) => who.get(x)?.name ?? x) });
  }
  return (await shapeFolders(userId, [{ ...f }]))[0]!;
}

/** Only the owner deletes a folder, with every file in it. */
export async function deleteVaultFolder(orgId: string, userId: string, folderId: string): Promise<{ files: number }> {
  const f = await folderRow(orgId, userId, folderId);
  if (f.owner_id !== userId) throw ownersOnly("delete it");
  const m = await db();
  const n = await m.selectFrom("vault_files").select((eb) => eb.fn.countAll<string>().as("n")).where("folder_id", "=", folderId).executeTakeFirst();
  await m.deleteFrom("vault_folders").where("id", "=", folderId).execute();
  return { files: Number(n?.n ?? 0) };
}

export interface VaultUpload {
  name: string;
  mimeType?: string | null;
  bytes: Uint8Array;
  record?: { kind: string; id: string } | null;
}

/** File a document into a folder this person may open. The one way bytes
 *  enter the Vault: encrypted here, before anything is stored. */
export async function addVaultFile(orgId: string, userId: string, folderId: string, up: VaultUpload): Promise<VaultFile> {
  await folderRow(orgId, userId, folderId);
  if (!up.bytes?.length) throw new VaultError(400, "empty_file", "That file is empty.");
  if (up.bytes.length > VAULT_MAX_BYTES) throw new VaultError(413, "too_large", "A Vault document is at most 25 MB.");
  const { encryptBytes, tenantCredsKeyId } = await import("../db/crypto.js");
  const record = up.record && up.record.kind && up.record.id ? up.record : null;
  const row = await (await db())
    .insertInto("vault_files")
    .values({
      org_id: orgId,
      folder_id: folderId,
      name: cleanName(up.name, "document"),
      mime_type: up.mimeType || "application/octet-stream",
      size_bytes: up.bytes.length,
      key_id: tenantCredsKeyId,
      ciphertext: encryptBytes(up.bytes).toString("base64"),
      record_kind: record?.kind ?? null,
      record_id: record?.id ?? null,
      created_by: userId,
    })
    .returning(["id", "folder_id", "name", "mime_type", "size_bytes", "record_kind", "record_id", "created_by", "created_at"])
    .executeTakeFirstOrThrow();
  await event(orgId, folderId, userId, "file_added", row, record ? { record } : {});
  const who = await people([userId]);
  return {
    id: row.id,
    folder_id: row.folder_id,
    name: row.name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    record: row.record_kind && row.record_id ? { kind: row.record_kind, id: row.record_id } : null,
    added_by: who.get(userId) ?? null,
    created_at: iso(row.created_at),
  };
}

/** A document's bytes, for someone on its folder's list. Audited. */
export async function readVaultFile(orgId: string, userId: string, fileId: string, how: "opened" | "downloaded"): Promise<{ name: string; mimeType: string; bytes: Buffer }> {
  const { file } = await fileRow(orgId, userId, fileId);
  const { decryptBytes, tenantCredsKeyId } = await import("../db/crypto.js");
  if (file.key_id !== tenantCredsKeyId) throw new VaultError(503, "key_unavailable", "This document was stored with a key this server does not hold.");
  let bytes: Buffer;
  try {
    bytes = decryptBytes(Buffer.from(file.ciphertext, "base64"));
  } catch {
    throw new VaultError(503, "unreadable", "This document could not be read.");
  }
  await event(orgId, file.folder_id, userId, `file_${how}`, file);
  return { name: file.name, mimeType: file.mime_type, bytes };
}

/** Rename a document, link it to a record (or unlink it), or move it to
 *  another folder: a move needs access to both. */
export async function changeVaultFile(orgId: string, userId: string, fileId: string, change: { name?: unknown; folder_id?: unknown; record?: { kind: string; id: string } | null }): Promise<VaultFile> {
  const { file } = await fileRow(orgId, userId, fileId);
  const m = await db();
  const set: Record<string, unknown> = {};
  if (change.name !== undefined) set.name = cleanName(change.name, "document");
  if (change.record !== undefined) {
    const r = change.record;
    if (r !== null && (typeof r?.kind !== "string" || typeof r?.id !== "string" || !r.kind || !r.id)) throw new VaultError(400, "bad_record", "Name the record by its kind and id.");
    set.record_kind = r?.kind ?? null;
    set.record_id = r?.id ?? null;
  }
  if (change.folder_id !== undefined && change.folder_id !== file.folder_id) {
    if (typeof change.folder_id !== "string") throw new VaultError(400, "bad_folder", "Name the folder to move it to.");
    // Both ends: a person may only move between folders they can open.
    await folderRow(orgId, userId, change.folder_id);
    set.folder_id = change.folder_id;
  }
  if (!Object.keys(set).length) return (await vaultFolder(orgId, userId, file.folder_id)).files.find((x) => x.id === fileId)!;
  await m.updateTable("vault_files").set(set as never).where("id", "=", fileId).execute();
  if (set.folder_id) {
    await event(orgId, file.folder_id, userId, "file_moved_out", file, { to: set.folder_id });
    await event(orgId, set.folder_id as string, userId, "file_moved_in", file, { from: file.folder_id });
  }
  if (set.name) await event(orgId, file.folder_id, userId, "file_renamed", file, { to: set.name });
  if ("record_kind" in set) await event(orgId, (set.folder_id as string) ?? file.folder_id, userId, set.record_id ? "file_linked" : "file_unlinked", file, set.record_id ? { record: { kind: set.record_kind, id: set.record_id } } : {});
  const folderId = (set.folder_id as string) ?? file.folder_id;
  return (await vaultFolder(orgId, userId, folderId)).files.find((x) => x.id === fileId)!;
}

/** The folder's owner, or whoever added it, removes a document. */
export async function deleteVaultFile(orgId: string, userId: string, fileId: string): Promise<void> {
  const { file, folder } = await fileRow(orgId, userId, fileId);
  if (folder.owner_id !== userId && file.created_by !== userId) throw new VaultError(403, "not_yours", "Only the folder's owner or whoever added it can remove this document.");
  await (await db()).deleteFrom("vault_files").where("id", "=", fileId).execute();
  await event(orgId, file.folder_id, userId, "file_removed", file);
}

/** The documents a record has in the Vault, of those this person may open.
 *  Someone not on a folder's list learns nothing: not a name, not a count. */
export async function vaultDocumentsFor(orgId: string, userId: string, kind: string, id: string): Promise<Array<Pick<VaultFile, "id" | "folder_id" | "name" | "mime_type" | "size_bytes">>> {
  const ids = await openableIds(orgId, userId);
  if (!ids.length) return [];
  // A record has more than one spelling (a car is `vehicles:item` in its
  // collection and `assets:asset` to the page that draws it): a document
  // linked under one is the record's under every one (#5837).
  const { recordKindSpellings } = await import("./record-kind-spellings.js");
  const kinds = await recordKindSpellings(orgId, kind);
  return (await db())
    .selectFrom("vault_files")
    .select(["id", "folder_id", "name", "mime_type", "size_bytes"])
    .where("org_id", "=", orgId)
    .where("record_kind", "in", kinds)
    .where("record_id", "=", id)
    .where("folder_id", "in", ids)
    .orderBy("created_at", "desc")
    .execute();
}

export interface VaultEvent { at: string; who: VaultPerson | null; action: string; file: string | null; detail: Record<string, unknown> }

/** A folder's history: who opened, downloaded, added, moved or changed
 *  access to what, and when. The folder's owner reads it. */
export async function vaultFolderHistory(orgId: string, userId: string, folderId: string, limit = 200): Promise<VaultEvent[]> {
  const f = await folderRow(orgId, userId, folderId);
  if (f.owner_id !== userId) throw ownersOnly("read its history");
  const rows = await (await db())
    .selectFrom("vault_events")
    .select(["at", "user_id", "action", "file_name", "detail"])
    .where("folder_id", "=", folderId)
    .orderBy("at", "desc")
    .orderBy("id", "desc")
    .limit(Math.min(Math.max(limit, 1), 500))
    .execute();
  const who = await people(rows.map((r) => r.user_id));
  return rows.map((r) => ({
    at: iso(r.at),
    who: r.user_id ? (who.get(r.user_id) ?? null) : null,
    action: r.action,
    file: r.file_name,
    detail: (typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail ?? {}) as Record<string, unknown>,
  }));
}

/** The folder a document filed for this person goes in when no folder is
 *  named: their own, made the first time. */
export const PERSONAL_FOLDER = "Personal documents";

/** File a document into a folder this person OWNS: named by id or by name, or
 *  their own "Personal documents" folder, made the first time. The door the
 *  assistant and other parts of Cobblr use (platform().vault.file): they may
 *  put a document in, never read one out. */
export async function fileIntoVault(
  orgId: string,
  userId: string,
  doc: VaultUpload & { folder?: string | null },
): Promise<{ file: VaultFile; folder: { id: string; name: string } }> {
  const m = await db();
  const named = typeof doc.folder === "string" ? doc.folder.trim() : "";
  const mine = await m.selectFrom("vault_folders").select(["id", "name"]).where("org_id", "=", orgId).where("owner_id", "=", userId).execute();
  let folder =
    named && /^[0-9a-f-]{36}$/i.test(named)
      ? mine.find((f) => f.id === named)
      : mine.find((f) => f.name.toLowerCase() === (named || PERSONAL_FOLDER).toLowerCase());
  if (!folder && named && /^[0-9a-f-]{36}$/i.test(named)) throw new VaultError(404, "not_your_folder", "Documents can be filed only into a Vault folder you own.");
  if (!folder) {
    const made = await createVaultFolder(orgId, userId, named || PERSONAL_FOLDER);
    folder = { id: made.id, name: made.name };
  }
  const file = await addVaultFile(orgId, userId, folder.id, doc);
  return { file, folder };
}

/** Say which record a document filed for this person belongs to, once that
 *  is known (an inbox item becomes the car when the person taps "It's this
 *  one"). The same rule as fileIntoVault: only a document in a folder the
 *  person OWNS; anything else answers as not there. Null unlinks it. */
export async function linkVaultFile(orgId: string, userId: string, fileId: string, record: { kind: string; id: string } | null): Promise<void> {
  const { file, folder } = await fileRow(orgId, userId, fileId);
  if (folder.owner_id !== userId) throw gone();
  if (record !== null && (typeof record?.kind !== "string" || typeof record?.id !== "string" || !record.kind || !record.id)) throw new VaultError(400, "bad_record", "Name the record by its kind and id.");
  await (await db()).updateTable("vault_files").set({ record_kind: record?.kind ?? null, record_id: record?.id ?? null }).where("id", "=", file.id).execute();
  await event(orgId, file.folder_id, userId, record ? "file_linked" : "file_unlinked", file, record ? { record } : {});
}
