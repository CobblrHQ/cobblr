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

/** Resolve "draw the code in the QR center" PER ENTITY, honouring a per-GROUP
 *  override before the kind default. An entity's group is its labels_codes row;
 *  that group may carry an explicit `overlay_center` (a per-instance toggle set
 *  in the Codes panel), otherwise it inherits the kind's default (per-kind
 *  config, then the module-declared default). This is what lets two instances of
 *  one kind differ — 3d-printers on, cnc off. Keyed by entity id. */
export async function getOverlayForRefs(
  db: Kysely<LabelsDB>,
  refs: ReadonlyArray<{ kind: string; id: string }>,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (refs.length === 0) return out;
  const ids = [...new Set(refs.map((r) => r.id))];
  const rows = await db
    .selectFrom("labels_codes")
    .innerJoin("labels_code_prefixes", "labels_code_prefixes.group_key", "labels_codes.group_key")
    .select(["labels_codes.entity_id as entity_id", "labels_code_prefixes.overlay_center as override"])
    .where("labels_codes.entity_id", "in", ids)
    .execute();
  const override = new Map(rows.map((r) => [r.entity_id, r.override]));
  const kindOverlay = await getOverlayCenter(db, refs.map((r) => r.kind));
  for (const ref of refs) {
    const o = override.get(ref.id);
    out.set(ref.id, o == null ? kindOverlay.get(ref.kind) ?? true : o);
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
      const minted = await mintOne(trx, ref.kind, ref.id, key, label);
      if (minted !== null) out.set(ref.id, minted); // null = list opted out of a code
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

/** Is `prefix` claimed by any group OTHER than `exceptKey`? Checks the active
 *  prefixes AND retired ones that still carry live codes — a going-forward rename
 *  (keep_existing) moves a group's active prefix but leaves its old codes in
 *  labels_codes, and `code` is UNIQUE, so a retired prefix can't be handed out
 *  again or its next mint would collide. */
export async function prefixTakenByOther(
  db: Kysely<LabelsDB>,
  prefix: string,
  exceptKey: string,
): Promise<boolean> {
  const active = await db
    .selectFrom("labels_code_prefixes")
    .select("group_key")
    .where("prefix", "=", prefix)
    .where("group_key", "!=", exceptKey)
    .executeTakeFirst();
  if (active) return true;
  const retired = await db
    .selectFrom("labels_codes")
    .select("group_key")
    .where("prefix", "=", prefix)
    .where("group_key", "!=", exceptKey)
    .executeTakeFirst();
  return Boolean(retired);
}

/** Mint one code inside an already-locked transaction. Returns null when the
 *  group is opted out of a code (prefix NULL) — its items carry no code. */
async function mintOne(
  trx: Transaction<LabelsDB>,
  kind: string,
  entityId: string,
  groupKey: string,
  label: string,
): Promise<string | null> {
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
    // Reserve retired prefixes too: a going-forward rename (keep_existing) moves a
    // group's active prefix but leaves its old codes in labels_codes, and `code`
    // is UNIQUE — so an auto-derived prefix must dodge every prefix that still
    // carries live codes, not just the currently-active ones.
    const [active, retired] = await Promise.all([
      trx.selectFrom("labels_code_prefixes").select(["prefix"]).execute(),
      trx.selectFrom("labels_codes").select("prefix").distinct().execute(),
    ]);
    // Opted-out groups have a NULL prefix; drop those so they don't poison the set.
    const taken = new Set([...active, ...retired].map((t) => t.prefix).filter((p): p is string => p !== null));
    const prefix = derivePrefix(label, taken);
    group = await trx
      .insertInto("labels_code_prefixes")
      .values({ group_key: groupKey, entity_kind: kind, prefix, label })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  // A pre-existing group with a NULL prefix is opted out of a code: mint nothing.
  // (A group we just auto-created above always has a real prefix, so this only
  // catches groups a user deliberately cleared.)
  const groupPrefix = group.prefix;
  if (groupPrefix === null) return null;

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
  const code = `${groupPrefix}${seq}`;

  await trx
    .insertInto("labels_codes")
    .values({ entity_kind: kind, entity_id: entityId, group_key: groupKey, prefix: groupPrefix, seq, code })
    .execute();
  return code;
}

/** Result of {@link renameCodeGroup}: a discriminated union so the HTTP route
 *  and the labels:set-code action branch the same way (no thrown control flow). */
export type RenameCodeGroupResult =
  | {
      ok: true;
      group_key: string;
      prefix: string;
      codes_rewritten: number;
      kept_existing: boolean;
    }
  | {
      ok: false;
      code: "bad_prefix" | "not_found" | "frozen" | "prefix_taken";
      message: string;
    };

/** Rename a code group's prefix. Shared by PATCH /codes/groups/:key and the
 *  labels:set-code workspace action, so the HTTP surface and the AI surface can
 *  never drift on the freeze / keep-existing / reservation semantics.
 *
 *  Default (keepExisting=false): rejected once the group is frozen (printed);
 *  otherwise REWRITES the group's already-minted codes to the new prefix
 *  (c1 -> loc1), which is safe before anything is printed.
 *
 *  keepExisting=true: the override for a printed group — moves the active prefix
 *  for FUTURE mints only and leaves every minted code untouched, so a sticker
 *  already in the world still scans to its item. The retired prefix stays
 *  reserved (its codes remain in labels_codes; prefixTakenByOther sees them), so
 *  nothing else can reuse it and collide on the UNIQUE code. */
export async function renameCodeGroup(
  db: Kysely<LabelsDB>,
  groupKey: string,
  rawPrefix: string,
  keepExisting: boolean,
): Promise<RenameCodeGroupResult> {
  // A blank prefix means "opt this list out of a code": free the letter (prefix
  // -> NULL), unbind its items (delete their unprinted codes), and reset the
  // counter so re-enabling starts clean. Rejected once frozen — a printed sticker
  // still carries the code, so the group can't quietly lose it. Shared here so the
  // HTTP route and the labels:set-code action clear a code the same way.
  if (rawPrefix.trim() === "") {
    const g = await db
      .selectFrom("labels_code_prefixes")
      .select(["frozen"])
      .where("group_key", "=", groupKey)
      .executeTakeFirst();
    if (!g) return { ok: false, code: "not_found", message: "code group not found" };
    if (g.frozen) {
      return {
        ok: false,
        code: "frozen",
        message:
          "labels have already been printed under this prefix, so this list's code can't be removed, a sticker out in the world still reads it.",
      };
    }
    const removed = await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("labels_code_prefixes")
        .set({ prefix: null, next_seq: 1, updated_at: sql`now()` })
        .where("group_key", "=", groupKey)
        .execute();
      const rows = await trx
        .deleteFrom("labels_codes")
        .where("group_key", "=", groupKey)
        .returning("code")
        .execute();
      return rows.length;
    });
    return { ok: true, group_key: groupKey, prefix: "", codes_rewritten: removed, kept_existing: false };
  }
  let prefix: string;
  try {
    prefix = normalizePrefix(rawPrefix);
  } catch (e) {
    return { ok: false, code: "bad_prefix", message: (e as Error).message };
  }
  const grp = await db
    .selectFrom("labels_code_prefixes")
    .selectAll()
    .where("group_key", "=", groupKey)
    .executeTakeFirst();
  if (!grp) return { ok: false, code: "not_found", message: "code group not found" };
  if (grp.frozen && !keepExisting) {
    return {
      ok: false,
      code: "frozen",
      message:
        "labels have already been printed under this prefix. Rename with keep_existing to keep the printed codes valid and use the new prefix from now on.",
    };
  }
  if (await prefixTakenByOther(db, prefix, groupKey)) {
    return { ok: false, code: "prefix_taken", message: `prefix '${prefix}' is already used` };
  }
  if (keepExisting) {
    // Going-forward rename: only the active prefix moves. Existing codes stay in
    // labels_codes exactly as printed; the next mint uses the new prefix.
    await db
      .updateTable("labels_code_prefixes")
      .set({ prefix, updated_at: sql`now()` })
      .where("group_key", "=", groupKey)
      .execute();
    return { ok: true, group_key: groupKey, prefix, codes_rewritten: 0, kept_existing: true };
  }
  // Default (only reachable when NOT frozen): rewrite the group's already-minted
  // codes too. labels_codes.code stores the whole <prefix><seq> string (what a
  // scan/typed lookup matches), so renaming only the group would strand every
  // existing code under the old prefix. One transaction: prefix + codes move together.
  const renamed = await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("labels_code_prefixes")
      .set({ prefix, updated_at: sql`now()` })
      .where("group_key", "=", groupKey)
      .execute();
    const rows = await trx
      .updateTable("labels_codes")
      .set({ prefix, code: sql`${prefix} || seq::text` })
      .where("group_key", "=", groupKey)
      .returning("code")
      .execute();
    return rows.length;
  });
  return { ok: true, group_key: groupKey, prefix, codes_rewritten: renamed, kept_existing: false };
}

/** Set the per-kind code config (grain + QR-center toggle). The caller supplies
 *  at least one of the two. Shared by PATCH /codes/config and the labels:set-code
 *  workspace action. Returns the fully-resolved config after the write. */
export async function setCodeConfig(
  db: Kysely<LabelsDB>,
  kind: string,
  opts: { group_field?: string; overlay_center?: boolean },
): Promise<{ entity_kind: string; group_field: string; overlay_center: boolean }> {
  // Insert only the provided columns; on conflict update just what was sent so
  // the two settings stay independent. When only the grain is set and the row is
  // CREATED, seed overlay_center with the kind's module-declared default (not the
  // column default of true) so a grain edit can't silently flip a default-OFF
  // kind (e.g. a location) back ON. Put on the insert `values` only, never the
  // conflict `set`, so an existing row's saved toggle is preserved.
  const values: Record<string, unknown> = { entity_kind: kind, updated_at: sql`now()` };
  const set: Record<string, unknown> = { updated_at: sql`now()` };
  if (opts.group_field !== undefined) {
    values.group_field = opts.group_field;
    set.group_field = opts.group_field;
  }
  if (opts.overlay_center !== undefined) {
    values.overlay_center = opts.overlay_center;
    set.overlay_center = opts.overlay_center;
  } else {
    values.overlay_center = await declaredOverlayDefault(kind);
  }
  await db
    .insertInto("labels_code_config")
    .values(values as never)
    .onConflict((oc) => oc.column("entity_kind").doUpdateSet(set as never))
    .execute();
  const row = await db
    .selectFrom("labels_code_config")
    .select(["group_field", "overlay_center"])
    .where("entity_kind", "=", kind)
    .executeTakeFirst();
  return {
    entity_kind: kind,
    group_field: row?.group_field ?? "instance",
    overlay_center: row?.overlay_center ?? (await declaredOverlayDefault(kind)),
  };
}

/** Set a single code GROUP's per-group QR-center override (the per-instance
 *  toggle). `null` clears it back to inheriting the kind default. Returns false
 *  if the group doesn't exist. Shared by PATCH /codes/groups/:key/overlay and
 *  the labels:set-code action, so the HTTP and AI surfaces stay in step. */
export async function setGroupOverlay(
  db: Kysely<LabelsDB>,
  groupKey: string,
  overlayCenter: boolean | null,
): Promise<boolean> {
  const updated = await db
    .updateTable("labels_code_prefixes")
    .set({ overlay_center: overlayCenter })
    .where("group_key", "=", groupKey)
    .returning("group_key")
    .executeTakeFirst();
  return Boolean(updated);
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
