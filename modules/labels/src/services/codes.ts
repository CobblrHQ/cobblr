// Human-readable label codes: <prefix><number>, e.g. m1, p42, b7.
//
// The prefix is unique per code GROUP; the number runs per group. Since the
// prefix is unique, <prefix><number> is globally unique in the workspace even
// though the number is only per-group. The group is a per-kind setting
// (group_field, default 'instance'): each distinct value of that field owns a
// prefix + counter, so per-kind and per-instance and per-category are all the
// same mechanism parameterized.
//
// Alphabet: "Crockford's confusability rules, not Crockford's encoding" — the
// prefix drops the three look-alike letters i/l/o (read as 1/1/0), the number
// stays plain decimal (so it reads m1..m10, not base32), and lookups fold the
// look-alikes + case so a mis-transcribed code still resolves. See
// docs/design-decisions/label-codes.md.

import { sql, type Kysely, type Transaction } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { LabelsDB } from "../db.js";

/** Allowed prefix letters: the 26 lowercase letters minus the look-alikes
 *  i, l, o. Kept `u` (not a look-alike; Crockford drops it only for obscenity
 *  in random strings, which our name-derived prefixes aren't). */
export const PREFIX_ALPHABET = "abcdefghjkmnpqrstuvwxyz";
const ALLOWED = new Set(PREFIX_ALPHABET.split(""));
const MAX_PREFIX_LEN = 4;

/** Fold a typed/scanned code to canonical form for matching: trim, lowercase,
 *  and map the look-alikes to the digits they're mistaken for. Safe because a
 *  canonical code's prefix never contains i/l/o, so these only ever land on the
 *  numeric tail (folding a canonical code is a no-op). */
export function foldCode(input: string): string {
  return input.trim().toLowerCase().replace(/[il]/g, "1").replace(/o/g, "0");
}

/** The allowed letters of a label, lowercased, in order. */
function letters(label: string): string {
  return label
    .toLowerCase()
    .split("")
    .filter((c) => ALLOWED.has(c))
    .join("");
}

/** Auto-derive a prefix from a group's label, avoiding `taken` (all lowercase).
 *  Prefers 1 char, extends to 2/3 on collision, then appends allowed letters.
 *  Result is always allowed letters only (never i/l/o). */
export function derivePrefix(label: string, taken: ReadonlySet<string>): string {
  const src = letters(label) || "x"; // fallback when the label had no usable letters
  for (let len = 1; len <= Math.min(3, src.length); len++) {
    const cand = src.slice(0, len);
    if (!taken.has(cand)) return cand;
  }
  const base = src.slice(0, Math.min(3, src.length)) || "x";
  for (const c of PREFIX_ALPHABET) {
    if (!taken.has(base + c)) return base + c;
  }
  for (const a of PREFIX_ALPHABET) {
    for (const b of PREFIX_ALPHABET) {
      if (!taken.has(a + b)) return a + b;
    }
  }
  return base; // unreachable in practice
}

/** Validate + canonicalize a user-typed prefix, or throw with a clear reason. */
export function normalizePrefix(input: string): string {
  const p = input.trim().toLowerCase();
  if (!p) throw new Error("prefix required");
  if (p.length > MAX_PREFIX_LEN) throw new Error(`prefix too long (max ${MAX_PREFIX_LEN})`);
  for (const c of p) {
    if (!ALLOWED.has(c)) {
      throw new Error(
        `prefix can't contain '${c}' — it's mistaken for a digit or isn't an allowed letter. Use letters from: ${PREFIX_ALPHABET}`,
      );
    }
  }
  return p;
}

/** The stable group key + a human label for prefix derivation, from a resolved
 *  entity's fields. Falls back to the whole kind when the group field is absent
 *  or empty (so a single-instance / fieldless kind is one line). */
export function groupValueOf(
  kind: string,
  groupField: string,
  fields: Record<string, unknown>,
): { key: string; label: string } {
  const raw = fields[groupField];
  const val = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  const value = val ?? kind;
  return { key: `${kind}|${groupField}|${value}`, label: value };
}

/** The DECLARED "draw the code in the QR center" default for a kind, read
 *  generically off the kernel entity-kind registry — NOT by branching on any
 *  kind string. The owning module declares its preference via the manifest's
 *  `labelCodeOverlayDefault` (e.g. core-locations sets it `false` because a
 *  location is name-unique and a code is noise); labels just reads it. A kind
 *  that declares nothing (or an unknown/unreadable kind) falls back to `true`,
 *  today's behavior. This is the kernel seam that keeps labels ignorant of
 *  other modules' kinds. See docs/design-decisions/label-codes.md. */
export async function declaredOverlayDefault(kind: string): Promise<boolean> {
  const rec = await platform().entities.getKind(kind).catch(() => null);
  return rec?.label_code_overlay_default ?? true;
}

/** Per-kind "draw the code in the QR center" flag, fully resolved for every
 *  requested kind: an explicit config row wins; else the kind's module-declared
 *  default (via the registry seam above); else `true`. Because the resolver
 *  fills in the declared default, a kind that ships with the default OFF (e.g.
 *  a location) prints without the center code with NO data migration and no
 *  saved config row — flip the declaration and existing installs self-heal.
 *  Callers may still treat a missing key as `true` defensively. */
export async function getOverlayCenter(
  db: Kysely<LabelsDB>,
  kinds: ReadonlyArray<string>,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const uniq = [...new Set(kinds)];
  if (uniq.length === 0) return out;
  const rows = await db
    .selectFrom("labels_code_config")
    .select(["entity_kind", "overlay_center"])
    .where("entity_kind", "in", uniq)
    .execute();
  const configured = new Map(rows.map((r) => [r.entity_kind, r.overlay_center]));
  // Resolve the declared defaults for the unconfigured kinds concurrently.
  const unconfigured = uniq.filter((k) => !configured.has(k));
  const defaults = await Promise.all(unconfigured.map((k) => declaredOverlayDefault(k)));
  const declaredFor = new Map(unconfigured.map((k, i) => [k, defaults[i]!]));
  for (const kind of uniq) {
    out.set(kind, configured.has(kind) ? configured.get(kind)! : declaredFor.get(kind) ?? true);
  }
  return out;
}

/** Read already-assigned codes for a set of entity ids (no minting). */
export async function getCodes(
  db: Kysely<LabelsDB>,
  ids: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return out;
  const rows = await db
    .selectFrom("labels_codes")
    .select(["entity_id", "code"])
    .where("entity_id", "in", uniq)
    .execute();
  for (const r of rows) out.set(r.entity_id, r.code);
  return out;
}

/**
 * Get-or-assign codes for a batch of entities. Returns entity_id -> code (only
 * for entities that currently resolve). Idempotent — an entity with a code
 * returns it unchanged. All minting runs under a workspace-wide advisory lock
 * so prefix derivation + counter claims never race (minting is infrequent —
 * only an entity's first label — so the coarse lock is cheap).
 */
export async function assignCodes(
  orgId: string,
  db: Kysely<LabelsDB>,
  refs: ReadonlyArray<{ kind: string; id: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (refs.length === 0) return out;

  const have = await getCodes(db, refs.map((r) => r.id));
  for (const [id, code] of have) out.set(id, code);

  const missing = refs.filter((r) => !have.has(r.id));
  if (missing.length === 0) return out;

  // Resolve the missing entities once to read their group value.
  const resolved = await platform().entities.lookupMany(orgId, missing);
  const byId = new Map(resolved.map((e) => [e.id, e]));

  const kinds = [...new Set(missing.map((r) => r.kind))];
  const cfgRows = await db
    .selectFrom("labels_code_config")
    .select(["entity_kind", "group_field"])
    .where("entity_kind", "in", kinds)
    .execute();
  const groupFieldFor = new Map(cfgRows.map((r) => [r.entity_kind, r.group_field]));

  await db.transaction().execute(async (trx) => {
    // Serialize all minting in this workspace so concurrent prints can't collide
    // on a prefix or a sequence number.
    await sql`select pg_advisory_xact_lock(hashtext('labels_code_mint'))`.execute(trx);
    for (const ref of missing) {
      const ent = byId.get(ref.id);
      if (!ent) continue; // deleted / not readable — no code, skip
      const gf = groupFieldFor.get(ref.kind) ?? "instance";
      const { key, label } = groupValueOf(ref.kind, gf, ent.fields);
      out.set(ref.id, await mintOne(trx, ref.kind, ref.id, key, label));
    }
  });

  return out;
}

/** Lock the prefixes of everything just PRINTED. A printed code is out in the
 *  world on a sticker, so its prefix can't change any more; until then a group
 *  stays renameable (and a rename rewrites its codes — see PATCH /groups/:key).
 *  Idempotent; only touches groups that aren't frozen yet. */
export async function freezePrintedGroups(
  db: Kysely<LabelsDB>,
  refs: ReadonlyArray<{ kind: string; id: string }>,
): Promise<void> {
  if (refs.length === 0) return;
  const ids = [...new Set(refs.map((r) => r.id))];
  const rows = await db
    .selectFrom("labels_codes")
    .select("group_key")
    .where("entity_id", "in", ids)
    .execute();
  const keys = [...new Set(rows.map((r) => r.group_key))];
  if (keys.length === 0) return;
  await db
    .updateTable("labels_code_prefixes")
    .set({ frozen: true, updated_at: sql`now()` })
    .where("group_key", "in", keys)
    .where("frozen", "=", false)
    .execute();
}

/** Mint one code inside an already-locked transaction. */
async function mintOne(
  trx: Transaction<LabelsDB>,
  kind: string,
  entityId: string,
  groupKey: string,
  label: string,
): Promise<string> {
  const already = await trx
    .selectFrom("labels_codes")
    .select(["code"])
    .where("entity_kind", "=", kind)
    .where("entity_id", "=", entityId)
    .executeTakeFirst();
  if (already) return already.code;

  let group = await trx
    .selectFrom("labels_code_prefixes")
    .selectAll()
    .where("group_key", "=", groupKey)
    .executeTakeFirst();
  if (!group) {
    const taken = await trx.selectFrom("labels_code_prefixes").select(["prefix"]).execute();
    const prefix = derivePrefix(label, new Set(taken.map((t) => t.prefix)));
    group = await trx
      .insertInto("labels_code_prefixes")
      .values({ group_key: groupKey, entity_kind: kind, prefix, label })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  // NOT frozen here. Minting only RESERVES a code — the row exists, nothing
  // exists in the world. A prefix becomes unchangeable when a label is
  // physically printed (freezePrintedGroups, from the print paths), because
  // that's when a sticker reading `c1` is stuck to a shelf. Freezing at mint
  // meant an auto-derived prefix locked itself on first use, so a workspace
  // could never pick one: open the label queue once and it was permanent.
  const claimed = await trx
    .updateTable("labels_code_prefixes")
    .set({ next_seq: sql`next_seq + 1`, updated_at: sql`now()` })
    .where("group_key", "=", groupKey)
    .returning("next_seq")
    .executeTakeFirstOrThrow();
  const seq = Number(claimed.next_seq) - 1;
  const code = `${group.prefix}${seq}`;

  await trx
    .insertInto("labels_codes")
    .values({ entity_kind: kind, entity_id: entityId, group_key: groupKey, prefix: group.prefix, seq, code })
    .execute();
  return code;
}

/** Resolve a typed/scanned code to its entity, tolerant of look-alike typos. */
export async function resolveCode(
  db: Kysely<LabelsDB>,
  input: string,
): Promise<{ entity_kind: string; entity_id: string; code: string } | null> {
  const code = foldCode(input);
  if (!code) return null;
  const row = await db
    .selectFrom("labels_codes")
    .select(["entity_kind", "entity_id", "code"])
    .where("code", "=", code)
    .executeTakeFirst();
  return row ?? null;
}
