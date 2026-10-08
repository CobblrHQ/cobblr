// The source half of "bring what I built": a trial, read back for another
// deployment to replay. docs/design-decisions/trial-ledger.md, "The replay".
//
// The sandbox lives on the demo box and the real account lives somewhere else,
// with its own database. Nothing is copied between databases. The person gets a
// carry token (their own grant to read this one workspace), the other side
// presents it, and this file answers with a PACKAGE: what the ending page listed
// (the same trialLedger read, so the other side offers exactly the list they
// saw), the shape half as a Blueprint filtered to those lines (the door the
// sandbox seed already applies), and every listed record as the person would
// read it, through its kind's own endpoint with their session.
//
// The package also carries each record's HOME when the home is not on the list:
// the collection a record lives in, and the bundle that made it. A person who
// added three things to the sandbox's grocery list built three groceries, and
// three groceries with nowhere to live is not what they asked to bring.
import { randomBytes } from "node:crypto";
import { meta } from "../db/meta.js";
import { signSession } from "../auth/jwt.js";
import { hashToken } from "./try-sandbox-token.js";
import * as activity from "./activity.js";
import { trialLedger, type TrialLedger } from "./trial-ledger.js";
import { captureBlueprint, type BlueprintManifestT } from "../routes/blueprint.js";
import { listKindsForOrg } from "./entities.js";
import { fileIdFromRawPath } from "./file-paths.js";
import { platform, type EntityKindRecord } from "@cobblr/platform-contract";
import { apiFetch, selfOrigin } from "@cobblr/platform-contract/self-api";

/** Long enough to sign up on the other side and come back to a retry; short
 *  enough that a link found in a browser history a month later opens nothing. */
export const CARRY_TOKEN_HOURS = 48;

export interface CarryRecord {
  /** The kind as the ledger names it: a module's own, or `<instance>:item`. */
  kind: string;
  id: string;
  /** What a create of this kind accepts, as the record is now: its declared,
   *  writable fields that have a value, and its custom fields. */
  body: Record<string, unknown>;
  /** The stored picture the record shows, when it is one of this workspace's
   *  files. An external picture stays in `body.image_path` and travels as is. */
  picture_file_id: string | null;
  /** The record's own words, for a result line: its title. */
  title: string;
  /** The record IS a stored file (its picture is itself): it travels as bytes,
   *  not through a create, and usually as the picture of another record. */
  stored_file: boolean;
}

export interface CarryPackage {
  /** Always 1 today: the destination refuses a shape it does not know. */
  version: 1;
  /** The trial itself: its name for the page, its id so a replay into the
   *  very workspace it came from (one box playing both sides) is refused. */
  workspace: { id: string; name: string };
  ledger: TrialLedger;
  /** The shape half: modules, collections, bundles (as installed here), field
   *  defs and automations, each one a line of the ledger or a record's home. */
  blueprint: BlueprintManifestT;
  /** The homes carried because a record needs them, not because the person
   *  made them: said on the other side as "and the collection it was in". */
  homes: { bundles: string[]; instances: string[]; modules: string[] };
  records: CarryRecord[];
  /** Records the ledger lists that could not be read here, and why. */
  unread: Array<{ kind: string; id: string; reason: string }>;
  /** Where the visitor came from (the QR or link that started the sandbox,
   *  `sandbox_started.detail.source`), so the account it lands in can say.
   *  Absent from a package built before it existed. */
  origin?: { source: string | null };
}

export async function mintCarryToken(orgId: string, userId: string): Promise<string> {
  const plain = randomBytes(24).toString("base64url");
  await meta
    .insertInto("try_carry_tokens")
    .values({
      org_id: orgId,
      user_id: userId,
      token_hash: hashToken(plain),
      expires_at: new Date(Date.now() + CARRY_TOKEN_HOURS * 3_600_000),
    })
    .execute();
  return plain;
}

/** The workspace and person a live token reads for, or null. Counts the read. */
export async function resolveCarryToken(plain: string): Promise<{ orgId: string; userId: string } | null> {
  if (!plain || plain.length > 200) return null;
  const row = await meta
    .selectFrom("try_carry_tokens")
    .select(["id", "org_id", "user_id", "expires_at"])
    .where("token_hash", "=", hashToken(plain))
    .executeTakeFirst();
  if (!row || row.expires_at.getTime() <= Date.now()) return null;
  await meta
    .updateTable("try_carry_tokens")
    .set((eb) => ({ last_read_at: new Date(), read_count: eb("read_count", "+", 1) }))
    .where("id", "=", row.id)
    .execute();
  return { orgId: row.org_id, userId: row.user_id };
}

/** Where a kind's records are served: a named collection's own path, or the
 *  module's. Relative endpoints are the kind's own declaration. */
function kindBase(slug: string, k: EntityKindRecord): string {
  return k.instance_name
    ? `/api/v1/orgs/${encodeURIComponent(slug)}/instances/${encodeURIComponent(k.instance_name)}`
    : `/api/v1/orgs/${encodeURIComponent(slug)}/modules/${encodeURIComponent(k.module_name)}`;
}

/** The one record's URL: a kind that declares no `get` serves the record at
 *  the same address it updates and deletes it. */
export function resourcePath(k: EntityKindRecord): string | null {
  const ep = k.endpoints ?? {};
  return ep.get ?? ep.update ?? ep.delete ?? null;
}

/** What a create of this kind accepts, from a record as it is served: the
 *  kind's declared fields that are not read-only and have a value, plus its
 *  custom fields (`metadata`). Everything else a read carries (ids, stamps,
 *  label codes, derived names) is the source workspace's own and stays. */
export function createBody(k: EntityKindRecord, served: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of k.fields ?? []) {
    if (f.readOnly) continue;
    let v = served[f.name];
    if (v === null || v === undefined || v === "") continue;
    if (f.name === "metadata" && (typeof v !== "object" || Object.keys(v as object).length === 0)) continue;
    // A numeric column is served as text ("2.000"); a create takes the number.
    if (f.type === "number" && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) v = Number(v);
    body[f.name] = v;
  }
  return body;
}

function titleOf(k: EntityKindRecord, served: Record<string, unknown>): string {
  const t = (k.fields ?? []).find((f) => f.role === "title")?.name;
  const v = (t && served[t]) ?? served.name ?? served.title ?? served.filename;
  return typeof v === "string" && v.trim() ? v.trim() : "something";
}

export async function carryPackage(orgId: string, userId: string): Promise<CarryPackage> {
  const org = await meta.selectFrom("orgs").select(["name", "slug"]).where("id", "=", orgId).executeTakeFirstOrThrow();
  const ledger = await trialLedger(orgId);
  const kinds = await listKindsForOrg(orgId);
  const kindOf = new Map(kinds.map((k) => [k.id, k]));

  // Every listed record, read as the person reads it.
  const session = await signSession(userId);
  const records: CarryRecord[] = [];
  const unread: CarryPackage["unread"] = [];
  for (const group of ledger.records) {
    const k = kindOf.get(group.entity_kind);
    const path = k ? resourcePath(k) : null;
    for (const id of group.ids) {
      if (!k || !path) {
        unread.push({ kind: group.entity_kind, id, reason: "this kind has no address to read a record at" });
        continue;
      }
      try {
        // lint-allow-detail-substitution: the kind's declared API endpoint, not a page route
        const res = await apiFetch(`${selfOrigin()}${kindBase(org.slug, k)}${path.replace("{id}", encodeURIComponent(id))}`, {
          headers: { Authorization: `Bearer ${session}` },
        });
        if (!res.ok) {
          unread.push({ kind: group.entity_kind, id, reason: `reading it answered ${res.status}` });
          continue;
        }
        const served = (await res.json()) as Record<string, unknown>;
        const picture = fileIdFromRawPath(served.image_path);
        // A record with no create of its own whose id is a stored file IS that
        // file (an upload): it travels as bytes through the files seam, not
        // through a create nothing offers.
        const storedFile =
          picture === id || (!k.endpoints?.create && (await platform().files.read(orgId, id, "original").catch(() => null)) !== null);
        records.push({
          kind: group.entity_kind,
          id,
          body: createBody(k, served),
          picture_file_id: picture,
          title: titleOf(k, served),
          stored_file: storedFile,
        });
      } catch (err) {
        unread.push({ kind: group.entity_kind, id, reason: (err as Error).message });
      }
    }
  }

  // Each record's home, when the ledger does not already bring it.
  const claims = await meta
    .selectFrom("bundle_resource_claims")
    .select(["source", "resource_type", "resource_key"])
    .where("org_id", "=", orgId)
    .execute();
  const listedInstances = new Set(ledger.instances.map((i) => i.instance_name));
  const listedBundles = new Set(ledger.bundles.map((b) => b.external_id));
  const listedModules = new Set(ledger.modules.map((m) => m.module_name));
  const homes: CarryPackage["homes"] = { bundles: [], instances: [], modules: [] };
  for (const r of records) {
    const k = kindOf.get(r.kind);
    if (!k) continue;
    if (!listedModules.has(k.module_name) && !homes.modules.includes(k.module_name)) homes.modules.push(k.module_name);
    const inst = k.instance_name;
    if (!inst || listedInstances.has(inst)) continue;
    const bundle = claims.find((c) => c.resource_type === "instance" && c.resource_key === inst && c.source !== "user")?.source;
    if (bundle) {
      if (!listedBundles.has(bundle) && !homes.bundles.includes(bundle)) homes.bundles.push(bundle);
    } else if (!homes.instances.includes(inst)) {
      homes.instances.push(inst);
    }
  }

  // The shape, through the same capture the Blueprint export uses, kept to the
  // ledger's lines and the homes above. Bundles travel as installed here; the
  // other side swaps in its catalog's current version where it has one.
  const full = await captureBlueprint(orgId);
  const wantBundles = new Set([...listedBundles, ...homes.bundles]);
  const wantInstances = new Set([...listedInstances, ...homes.instances]);
  const wantModules = new Set([...listedModules, ...homes.modules]);
  const carriedKinds = new Set(records.map((r) => r.kind));
  const listedFields = new Set(ledger.fields.map((f) => `${f.entity_kind}\u0000${f.name}`));
  const automationIds = ledger.automations.map((a) => a.id);
  const wires = automationIds.length
    ? await meta
        .selectFrom("entity_action_bindings")
        .select(["source_kind", "action_id", "trigger_type", "trigger_event", "trigger_schedule", "template", "filter", "args", "target"])
        .where("org_id", "=", orgId)
        .where("id", "in", automationIds)
        .execute()
    : [];
  const blueprint: BlueprintManifestT = {
    ...full,
    modules: full.modules.filter((m) => wantModules.has(m.name)).concat(
      [...wantModules].filter((n) => !full.modules.some((m) => m.name === n)).map((name) => ({ name })),
    ),
    // registry-filter-ok: the blueprint's own collection rows, kept to the ones the ledger or a record's home names
    instances: full.instances.filter((i) => wantInstances.has(i.instance_name)),
    bundles: full.bundles.filter((b) => wantBundles.has(String((b as { id?: unknown }).id ?? ""))),
    // A listed field, or one a carried record's collection shows its values in:
    // a custom field the stock made on the groceries is how their groceries read.
    field_defs: full.field_defs.filter(
      (f) => listedFields.has(`${f.entity_kind}\u0000${f.name}`) || carriedKinds.has(f.entity_kind),
    ),
    wires: wires.map((w) => ({
      source_kind: w.source_kind,
      action_id: w.action_id,
      trigger_type: w.trigger_type,
      trigger_event: w.trigger_event ?? undefined,
      trigger_schedule: w.trigger_schedule ?? undefined,
      template: w.template ?? undefined,
      filter: w.filter ?? undefined,
      args: w.args ?? undefined,
      target: w.target && w.target !== "self" && typeof w.target === "object" ? (w.target as Record<string, unknown>) : undefined,
    })),
    saved_views: [],
    public_surfaces: [],
  };

  return { version: 1, workspace: { id: orgId, name: org.name }, ledger, blueprint, homes, records, unread, origin: { source: await startedFrom(orgId) } };
}

/** The source the sandbox was started from, if a link or QR named one. */
async function startedFrom(orgId: string): Promise<string | null> {
  const row = await meta
    .selectFrom("product_events")
    .select("detail")
    .where("org_id", "=", orgId)
    .where("event", "=", "sandbox_started")
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  const s = (row?.detail as { source?: unknown } | null | undefined)?.source;
  return typeof s === "string" && s ? s : null;
}

/** The activity row that says a sandbox was carried into a real account: its
 *  presence is what "the carry is confirmed" means on this side. */
export const SANDBOX_CARRIED = "sandbox_carried";

/** How long a sandbox is held open once its person has left to make it
 *  theirs: long enough to make an account and confirm an email, after which a
 *  sandbox that was never carried ends the way any other does. */
export const CARRY_HOLD_MS = 2 * 3_600_000;

/** Hold a sandbox open for its carry: the package is read through the
 *  workspace's own routes, which refuse a sandbox past its hour. Never
 *  shortens one. */
export async function holdSandboxForCarry(orgId: string, now: number = Date.now()): Promise<void> {
  const until = new Date(now + CARRY_HOLD_MS);
  await meta
    .updateTable("orgs")
    .set({ trial_expires_at: until })
    .where("id", "=", orgId)
    .where("sandbox", "=", true)
    .where((eb) => eb.or([eb("trial_expires_at", "is", null), eb("trial_expires_at", "<", until)]))
    .execute();
}

/** The other side says the carry landed: the sandbox (or kept trial) it came
 *  from ends now, and the grant stops working. Idempotent, and only ever on a
 *  live token: nothing but the grant's holder can end a workspace this way.
 *  Returns false for an unknown or expired token. */
export async function confirmCarry(plain: string, decisionMs: number, now: number = Date.now()): Promise<boolean> {
  if (!plain || plain.length > 200) return false;
  const row = await meta
    .selectFrom("try_carry_tokens as t")
    .innerJoin("orgs as o", "o.id", "t.org_id")
    .select(["t.id", "t.org_id", "t.user_id", "t.expires_at", "o.sandbox"])
    .where("t.token_hash", "=", hashToken(plain))
    .executeTakeFirst();
  if (!row || row.expires_at.getTime() <= now) return false;
  await meta.transaction().execute(async (trx) => {
    // A sandbox is over and past its hold at once, so the next sweep deletes
    // it: there is nothing left to decide. A kept trial is over at the door.
    await trx
      .updateTable("orgs")
      .set({ trial_expires_at: new Date(row.sandbox ? now - decisionMs - 60_000 : now) })
      .where("id", "=", row.org_id)
      .execute();
    await trx.updateTable("try_carry_tokens").set({ expires_at: new Date(now) }).where("id", "=", row.id).execute();
  });
  await activity.log({
    orgId: row.org_id,
    userId: row.user_id,
    action: SANDBOX_CARRIED,
    ref: { module: null, entityType: "carry", entityId: hashToken(plain) },
    diff: { name: "moved to a real account" },
  });
  return true;
}

/** The file ids a package names, so the file door serves those and nothing else. */
export function packageFileIds(pkg: CarryPackage): Set<string> {
  const ids = new Set<string>();
  for (const r of pkg.records) {
    if (r.picture_file_id) ids.add(r.picture_file_id);
    if (r.stored_file) ids.add(r.id);
  }
  for (const s of pkg.ledger.scans) for (const f of s.photo_file_ids) ids.add(f);
  return ids;
}
