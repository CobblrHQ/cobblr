import { isMaskedSecret, isStoredSecret, mayRevealSecret, type SecretReadContext, type StoredSecretField } from "@cobblr/platform-contract/secret-field";
import { fieldValueProblemsOf, InvalidFieldValueError } from "@cobblr/platform-contract/entity-metadata";
import { fieldKindOf } from "@cobblr/platform-contract/kind-label";
import { currentActor, perRequest } from "../lib/request-context.js";
import { resolveFieldDefsForKind } from "./field-defs.js";
import type { EntityWriter, ResolvedEntity } from "@cobblr/platform-contract";
import { currentHistoryWrite } from "./record-history.js";

const sealed = new WeakSet<object>();

export class SecretFieldError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status = 422, code = "invalid_secret", message = "A secret field takes a new text value or null.") { super(message); this.status = status; this.code = code; }
  toJSON() { return { error: { code: this.code, message: this.message } }; }
}

async function secretKindFor(orgId: string, kind: string, instance: unknown): Promise<string> {
  if (typeof instance !== "string" || !instance) return kind;
  const { baseKindOf } = await import("./entities.js");
  const base = await baseKindOf(orgId, kind);
  return instance === base.split(":")[0] ? base : fieldKindOf({ kind, instance });
}

async function creatorOf(orgId: string, kind: string, id?: string): Promise<string | null> {
  const actor = currentActor();
  if (!id) return actor?.userId ?? null;
  const { baseKindOf } = await import("./entities.js");
  const [module, type] = (await baseKindOf(orgId, kind)).split(":");
  const { meta } = await import("../db/meta.js");
  const first = await meta.selectFrom("activity_log").select("user_id")
    .where("org_id", "=", orgId).where("module_name", "=", module ?? "")
    .where("entity_type", "=", type ?? "").where("entity_id", "=", id)
    .where((eb) => eb.or([eb("action", "=", "created"), eb("action", "=", `${type}_created`)]))
    .orderBy("id", "asc").executeTakeFirst();
  return first?.user_id ?? null;
}

export async function sealSecretFields(orgId: string, kind: string, fields: Record<string, unknown>, id?: string, current?: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (id && !current) current = currentHistoryWrite(orgId, kind, id)?.before;
  if (id && !current && currentActor()) {
    const { getEntityWriterFor } = await import("./entities.js");
    const writer = await getEntityWriterFor(orgId, kind);
    current = await (writer?.snapshot ?? writer?.read)?.call(writer, orgId, id) ?? undefined;
  }
  const effectiveKind = await secretKindFor(orgId, kind, fields.instance ?? current?.instance);
  const defs = await perRequest(`secret-defs:${orgId}:${effectiveKind}`, () => resolveFieldDefsForKind(orgId, effectiveKind));
  const problems = fieldValueProblemsOf(fields, defs, current ?? null).filter((p) => p.code === "full_card_number");
  if (problems.length) throw new InvalidFieldValueError(effectiveKind, problems);
  const secrets = defs.filter((def) => def.type === "secret");
  if (!secrets.length) return fields;
  const metadata = fields.metadata && typeof fields.metadata === "object" && !Array.isArray(fields.metadata) ? { ...fields.metadata as Record<string, unknown> } : !id ? {} : null;
  const out: Record<string, unknown> = { ...fields, ...(metadata ? { metadata } : {}) };
  const previous = current?.metadata && typeof current.metadata === "object" ? current.metadata as Record<string, unknown> : current ?? {};
  let creator: Promise<string | null> | undefined;
  for (const def of secrets) {
    if (!id && metadata && !Object.prototype.hasOwnProperty.call(out, def.name) && !Object.prototype.hasOwnProperty.call(metadata, def.name)) metadata[def.name] = null;
    for (const bag of [out, metadata]) {
      if (!bag || !Object.prototype.hasOwnProperty.call(bag, def.name)) continue;
      const value = bag[def.name];
      if (isMaskedSecret(value)) {
        const old = previous[def.name];
        if (isStoredSecret(old)) { sealed.add(old); bag[def.name] = old; }
        else delete bag[def.name];
        continue;
      }
      if (isStoredSecret(value) && sealed.has(value)) continue;
      if (value === undefined) { delete bag[def.name]; continue; }
      const text = value === null ? "" : value;
      if (typeof text !== "string") throw new SecretFieldError();
      const old = previous[def.name];
      const creatorId = isStoredSecret(old) ? old.creator_id ?? null : await (creator ??= creatorOf(orgId, effectiveKind, id));
      const { baseKindOf } = await import("./entities.js");
      const base = await baseKindOf(orgId, effectiveKind);
      const { encryptCreds, tenantCredsKeyId } = await import("../db/crypto.js");
      const encrypted: StoredSecretField = { __cobblr_secret: 1, key_id: tenantCredsKeyId, ciphertext: encryptCreds(JSON.stringify({ orgId, field: def.name, value: text })), creator_id: creatorId, kind: effectiveKind, base_kind: base, has_value: text.length > 0 };
      sealed.add(encrypted);
      bag[def.name] = encrypted;
    }
  }
  return out;
}

export async function secretReadContextFor(orgId: string, userId: string, role: string): Promise<SecretReadContext> {
  return perRequest(`secret-reader:${orgId}:${userId}:${role}`, async () => {
  // role-gate: exact: secret access is explicitly limited to owner/admin, creator or the configured field capability.
    if (role === "owner" || role === "admin") return { role, userId, held: new Set(), scopes: new Map() };
    const { meta } = await import("../db/meta.js");
    const { effectiveCapabilities } = await import("../auth/effective-capabilities.js");
    const [configured, manifests, caps] = await Promise.all([
      meta.selectFrom("workspace_field_scopes").select(["kind", "field", "capability"]).where("org_id", "=", orgId).execute(),
      meta.selectFrom("entity_kinds").select(["id", "field_read_scopes"]).where("field_read_scopes", "is not", null).execute(),
      effectiveCapabilities(orgId, userId, role),
    ]);
    const scopes = new Map<string, string>();
    for (const row of manifests) for (const [field, cap] of Object.entries((row.field_read_scopes ?? {}) as Record<string, string>)) scopes.set(`${row.id}\0${field}`, cap);
    for (const row of configured) scopes.set(`${row.kind}\0${row.field}`, row.capability);
    return { role, userId, scopes, held: caps.all ? new Set(scopes.values()) : caps.caps };
  });
}

function refused(status: number, code: string, message: string): Error {
  return new SecretFieldError(status, code, message);
}

export async function revealSecretField(orgId: string, kind: string, id: string, field: string, viewer: { userId: string; role: string }, operation: "reveal" | "copy"): Promise<{ value: string }> {
  const { getHistoryWriterFor } = await import("./history-store.js");
  const writer = await getHistoryWriterFor(orgId, kind);
  const row = await writer?.snapshot(orgId, id);
  if (!row) throw refused(404, "record_missing", "This record is not here.");
  const actualKind = await secretKindFor(orgId, kind, row.instance);
  const defs = await resolveFieldDefsForKind(orgId, actualKind);
  const def = defs.find((item) => item.name === field && item.type === "secret");
  if (!def) throw refused(404, "secret_missing", "This secret field is not here.");
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
  const stored = metadata[field] ?? row[field];
  const access = await secretReadContextFor(orgId, viewer.userId, viewer.role);
  const { baseKindOf } = await import("./entities.js");
  const base = await baseKindOf(orgId, actualKind);
  const creatorId = isStoredSecret(stored) ? stored.creator_id : null;
  if (!mayRevealSecret({ ...viewer, creatorId, capability: access.scopes.get(`${actualKind}\0${field}`) ?? access.scopes.get(`${base}\0${field}`), held: access.held })) throw refused(403, "secret_hidden", "You cannot reveal this field.");
  if (!isStoredSecret(stored)) throw refused(404, "secret_empty", "This secret field is empty.");
  if (stored.has_value === false) throw refused(404, "secret_empty", "This secret field is empty.");
  const value = await secretValue(orgId, field, stored);
  const { log } = await import("./activity.js");
  const [module, type] = base.split(":");
  await log({ orgId, userId: viewer.userId, action: operation === "copy" ? "secret_field_copied" : "secret_field_revealed", ref: { module: module ?? null, entityType: type ?? kind, entityId: id }, diff: { field, field_label: def.display_label } });
  return { value };
}

async function secretValue(orgId: string, field: string, stored: StoredSecretField): Promise<string> {
  let payload: { orgId?: string; field?: string; value?: unknown };
  try {
    const { decryptCreds, tenantCredsKeyId } = await import("../db/crypto.js");
    if (stored.key_id && stored.key_id !== tenantCredsKeyId) throw new Error("The encryption key is unavailable.");
    payload = JSON.parse(decryptCreds(stored.ciphertext));
  } catch { throw refused(503, "secret_unavailable", "This secret could not be read."); }
  if (payload.orgId !== orgId || payload.field !== field || typeof payload.value !== "string") throw refused(403, "secret_hidden", "You cannot reveal this field.");
  return payload.value;
}

export async function secretValuesForExport(orgId: string, kind: string, rows: ResolvedEntity[], viewer: { role?: string }): Promise<ResolvedEntity[]> {
  // role-gate: exact: only the owner and admin may explicitly export secret values.
  if (viewer.role !== "owner" && viewer.role !== "admin") throw refused(403, "secret_hidden", "Only an owner or admin can export secrets.");
  const defs = await perRequest(`secret-defs:${orgId}:${kind}`, () => resolveFieldDefsForKind(orgId, kind));
  const names = defs.filter((def) => def.type === "secret").map((def) => def.name);
  const out: ResolvedEntity[] = [];
  for (const row of rows) {
    const fields = { ...row.fields } as Record<string, unknown>;
    const metadata = fields.metadata && typeof fields.metadata === "object" ? { ...fields.metadata as Record<string, unknown> } : {};
    for (const name of names) {
      const stored = fields[name] ?? metadata[name];
      const value = isStoredSecret(stored) ? await secretValue(orgId, name, stored) : null;
      fields[name] = value;
      metadata[name] = value;
    }
    fields.metadata = metadata;
    out.push({ ...row, fields });
  }
  return out;
}

export function secretWriter(kind: string, writer: EntityWriter): EntityWriter {
  const read = writer.snapshot?.bind(writer) ?? writer.read?.bind(writer);
  const seal = async (orgId: string, id: string, fields: Record<string, unknown>) => sealSecretFields(orgId, kind, fields, id, currentHistoryWrite(orgId, kind, id)?.before ?? (read ? await read(orgId, id) ?? undefined : undefined));
  const out = Object.assign(Object.create(writer) as EntityWriter, {
    create: async (orgId: string, fields: Record<string, unknown>) => writer.create(orgId, await sealSecretFields(orgId, kind, fields)),
    update: async (orgId: string, id: string, fields: Record<string, unknown>) => writer.update(orgId, id, await seal(orgId, id, fields)),
  });
  if (writer.mergeMetadata) out.mergeMetadata = async (orgId, id, fields) => {
    const safe = await seal(orgId, id, { metadata: fields });
    await writer.mergeMetadata!(orgId, id, safe.metadata as Record<string, unknown>);
  };
  return out;
}
