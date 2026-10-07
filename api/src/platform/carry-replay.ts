// The destination half of "bring what I built": a trial's package, replayed
// into a real workspace as the person. docs/design-decisions/trial-ledger.md.
//
// Replay of intent, not a data migration. Nothing here writes another
// workspace's rows: the shape goes in through the Blueprint door (the one the
// sandbox seed applies), and every record through its kind's own create
// endpoint with the person's own session, so validation, defaults, events and
// activity fire exactly as they do for something made by hand.
//
// Every line of the ending's list comes back with what happened to it, read
// back from the workspace rather than assumed from the call that was made: a
// done line is one the workspace now shows. A step that cannot be taken is
// skipped and named, never silent.
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { signSession } from "../auth/jwt.js";
import * as activity from "./activity.js";
import { trackProductEvent } from "./product-events.js";
import { hashToken } from "./try-sandbox-token.js";
import { applyBlueprint, type BlueprintManifestT } from "../routes/blueprint.js";
import { getFlagshipManifest } from "../lib/flagship-bundles.js";
import { getInstance } from "./instances.js";
import { listKindsForOrg } from "./entities.js";
import { rawPathFor } from "./file-paths.js";
import type { CarryPackage, CarryRecord } from "./trial-carry.js";
import type { EntityKindRecord } from "@cobblr/platform-contract";
import { platform } from "@cobblr/platform-contract";

export const CARRY_REPLAYED = "carry_replayed";

export class CarryError extends Error {
  constructor(
    public code: "not_accepted" | "unknown_source" | "expired" | "unreachable" | "bad_package" | "already" | "same_workspace",
    message: string,
  ) {
    super(message);
  }
}

export type LineState = "done" | "skipped" | "partly";
export interface CarryLine {
  group: "bundles" | "modules" | "instances" | "fields" | "automations" | "contents" | "homes";
  words: string;
  state: LineState;
  /** What happened that the words do not say: a version, a reason, a drop. */
  note?: string;
}
export interface CarryResult {
  /** The source said it ended the sandbox. False when it could not be told;
   *  the sandbox then ends at its own time. */
  source_ended?: boolean;
  lines: CarryLine[];
  /** Count per state, for a one-line summary. */
  done: number;
  skipped: number;
  partly: number;
}

/** The origins this deployment reads a trial from (COBBLR_CARRY_SOURCES). */
export function carrySources(): string[] {
  return env.COBBLR_CARRY_SOURCES.split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** The listed source a `from=` names, or null. Compared as origins, so a path,
 *  a query or a trailing slash on either side never widens it. */
export function acceptedSource(from: string): string | null {
  let want: string;
  try {
    want = new URL(from).origin;
  } catch {
    return null;
  }
  for (const s of carrySources()) {
    try {
      if (new URL(s).origin === want) return want;
    } catch {
      /* a malformed entry accepts nothing */
    }
  }
  return null;
}

/** Fetch the package from a listed source. Plain fetch on purpose: the source
 *  is operator-configured, not a URL a visitor chose (docs/architecture/platform-spec.md §14.1). */
export async function fetchCarryPackage(from: string, token: string): Promise<{ source: string; pkg: CarryPackage }> {
  if (carrySources().length === 0) throw new CarryError("not_accepted", "This server does not take trials from anywhere.");
  const source = acceptedSource(from);
  if (!source) throw new CarryError("unknown_source", "This server does not take trials from there.");
  let res: Response;
  try {
    res = await fetch(`${source}/api/v1/try/carry/${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new CarryError("unreachable", `Could not reach the trial: ${(err as Error).message}`);
  }
  if (res.status === 410 || res.status === 404) throw new CarryError("expired", "The link to bring this trial along has run out.");
  if (!res.ok) throw new CarryError("unreachable", `The trial answered ${res.status}.`);
  const pkg = (await res.json()) as CarryPackage;
  if (pkg?.version !== 1 || !pkg.ledger || !pkg.blueprint || !Array.isArray(pkg.records)) {
    throw new CarryError("bad_package", "The trial sent something this server does not understand.");
  }
  return { source, pkg };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function kindBase(slug: string, k: EntityKindRecord): string {
  return k.instance_name
    ? `/api/v1/orgs/${encodeURIComponent(slug)}/instances/${encodeURIComponent(k.instance_name)}`
    : `/api/v1/orgs/${encodeURIComponent(slug)}/modules/${encodeURIComponent(k.module_name)}`;
}

/** The carried ids a record points at, so a record is made after what it
 *  points to (an item after its list). */
function pointsAt(r: CarryRecord, carried: Set<string>): string[] {
  const out: string[] = [];
  for (const [key, v] of Object.entries(r.body)) {
    if (key === "metadata" || typeof v !== "string") continue;
    if (carried.has(v) && v !== r.id) out.push(v);
  }
  return out;
}

function orderByReferences(records: CarryRecord[]): CarryRecord[] {
  const carried = new Set(records.map((r) => r.id));
  const done = new Set<string>();
  const out: CarryRecord[] = [];
  let left = [...records];
  while (left.length) {
    const ready = left.filter((r) => pointsAt(r, carried).every((id) => done.has(id)));
    // A cycle: take the rest as they are; their references to each other are
    // dropped and named like any other.
    const take = ready.length ? ready : left;
    for (const r of take) {
      out.push(r);
      done.add(r.id);
    }
    left = left.filter((r) => !take.includes(r));
  }
  return out;
}

async function copyPicture(
  source: string,
  token: string,
  fileId: string,
  orgId: string,
  slug: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${source}/api/v1/try/carry/${encodeURIComponent(token)}/files/${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) return null;
    const cd = res.headers.get("content-disposition") ?? "";
    const filename = decodeURIComponent(/filename="([^"]+)"/.exec(cd)?.[1] ?? "picture");
    const written = await platform().files.write(orgId, bytes, {
      filename,
      mimeType: res.headers.get("content-type") ?? "application/octet-stream",
    });
    return written ? rawPathFor(slug, written.fileId) : null;
  } catch {
    return null;
  }
}

/** Replay a package into `orgId`, as `userId`. */
export async function replayCarry(opts: {
  orgId: string;
  slug: string;
  userId: string;
  source: string;
  token: string;
  pkg: CarryPackage;
}): Promise<CarryResult> {
  const { orgId, token } = opts;
  const tokenHash = hashToken(token);
  // Where one box plays both sides, the person may still be signed in as the
  // trial: bringing it into itself would make everything twice.
  if (opts.pkg.workspace.id === orgId) throw new CarryError("same_workspace", "That is the trial itself; bring it into another workspace.");

  // One token, one replay per workspace: a reload must not double everything.
  const prior = await meta
    .selectFrom("activity_log")
    .select("id")
    .where("org_id", "=", orgId)
    .where("action", "=", CARRY_REPLAYED)
    .where("entity_id", "=", tokenHash)
    .executeTakeFirst();
  if (prior) throw new CarryError("already", "This trial was already brought into this workspace.");
  // And one at a time: a double click reaches here twice before either has
  // written its row.
  const key = `${orgId}\u0000${tokenHash}`;
  if (inFlight.has(key)) throw new CarryError("already", "This trial is already on its way into this workspace.");
  inFlight.add(key);
  let result: CarryResult;
  try {
    result = await replay(opts, tokenHash);
  } finally {
    inFlight.delete(key);
  }
  // Landed: the sandbox it came from ends, and only now. Told after the replay
  // and never before, so a carry that failed half way leaves the person their
  // sandbox to try again from. Best-effort: the replay is done either way, and
  // a sandbox never told ends at its own time.
  const sourceEnded = await tellSourceItLanded(opts.source, token);
  // The door the visitor came in by (the booth's QR, a link), onto this side's
  // account, so the funnel reads show → sandbox → account in one place.
  trackProductEvent({
    orgId,
    userId: opts.userId,
    event: "sandbox_carried_in",
    detail: { source: opts.pkg.origin?.source ?? null, from: opts.source, done: result.done, skipped: result.skipped },
  });
  return { ...result, source_ended: sourceEnded };
}

async function tellSourceItLanded(source: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${source}/api/v1/try/carry/${encodeURIComponent(token)}/done`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`[carry] ${source} did not take the confirmation (HTTP ${res.status}); the sandbox ends at its own time`);
    return res.ok;
  } catch (err) {
    console.error(`[carry] could not tell ${source} the carry landed (${(err as Error).message}); the sandbox ends at its own time`);
    return false;
  }
}

const inFlight = new Set<string>();

async function replay(
  opts: { orgId: string; slug: string; userId: string; source: string; token: string; pkg: CarryPackage },
  tokenHash: string,
): Promise<CarryResult> {
  const { orgId, slug, userId, source, token, pkg } = opts;
  const lines: CarryLine[] = [];
  const ledger = pkg.ledger;

  // ── 1. The shape. Each bundle as the catalog has it NOW, and said so; one
  //       the catalog does not have (made in the trial) as it was built there.
  const bundleNotes = new Map<string, string>();
  const bundles: unknown[] = [];
  for (const carried of pkg.blueprint.bundles) {
    const id = String((carried as { id?: unknown }).id ?? "");
    const trialVersion = String((carried as { version?: unknown }).version ?? "");
    const current = id ? await getFlagshipManifest(id).catch(() => null) : null;
    if (current) {
      const now = String((current as { version?: unknown }).version ?? "");
      bundles.push(current);
      bundleNotes.set(
        id,
        now && trialVersion && now !== trialVersion
          ? `the current version, ${now}; your trial had ${trialVersion}`
          : `the current version${now ? `, ${now}` : ""}`,
      );
    } else {
      bundles.push(carried);
      bundleNotes.set(id, "as you built it in your trial; it is not in the catalog here");
    }
  }
  const blueprint: BlueprintManifestT = { ...pkg.blueprint, bundles, saved_views: [], public_surfaces: [] };
  const applied = await applyBlueprint(orgId, { id: userId, auth_method: "session" }, blueprint);
  const warnings = new Map(applied.bundle_warnings.map((w) => [w.id, w.error]));

  // Read back what the workspace now has, so every line is measured.
  const haveBundles = new Map(
    (await meta.selectFrom("bundles").select(["external_id", "version"]).where("org_id", "=", orgId).execute()).map((b) => [
      b.external_id,
      b.version,
    ]),
  );
  const haveModules = new Set(
    (await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", orgId).execute()).map((m) => m.module_name),
  );
  const haveFields = new Set(
    (await meta.selectFrom("module_field_defs").select(["entity_kind", "name"]).where("org_id", "=", orgId).execute()).map(
      (f) => `${f.entity_kind}\u0000${f.name}`,
    ),
  );
  const haveWires = (
    await meta.selectFrom("entity_action_bindings").select(["source_kind", "action_id"]).where("org_id", "=", orgId).execute()
  ).map((w) => `${w.source_kind}\u0000${w.action_id}`);

  const bundleLine = (id: string, words: string, group: CarryLine["group"]): CarryLine =>
    haveBundles.has(id)
      ? { group, words, state: "done", note: bundleNotes.get(id) }
      : { group, words, state: "skipped", note: warnings.get(id) ?? "it did not install here" };
  for (const b of ledger.bundles) lines.push(bundleLine(b.external_id, b.words, "bundles"));
  for (const m of ledger.modules) {
    lines.push(haveModules.has(m.module_name) ? { group: "modules", words: m.words, state: "done" } : { group: "modules", words: m.words, state: "skipped", note: "it would not turn on here" });
  }
  for (const i of ledger.instances) {
    const got = await getInstance(orgId, i.instance_name);
    lines.push(got ? { group: "instances", words: i.words, state: "done" } : { group: "instances", words: i.words, state: "skipped", note: "it could not be made here" });
  }
  for (const f of ledger.fields) {
    const ok = haveFields.has(`${f.entity_kind}\u0000${f.name}`);
    lines.push(ok ? { group: "fields", words: f.words, state: "done" } : { group: "fields", words: f.words, state: "skipped", note: "the field could not be added here" });
  }
  const wireKeys = new Set(pkg.blueprint.wires.map((w) => `${w.source_kind}\u0000${w.action_id}`));
  for (const a of ledger.automations) {
    const ok = haveWires.includes(`${a.source_kind}\u0000${a.action_id}`) && wireKeys.has(`${a.source_kind}\u0000${a.action_id}`);
    lines.push(ok ? { group: "automations", words: a.words, state: "done" } : { group: "automations", words: a.words, state: "skipped", note: "the automation could not be set up here" });
  }
  for (const id of pkg.homes.bundles) {
    const name = String((pkg.blueprint.bundles.find((b) => (b as { id?: unknown }).id === id) as { name?: unknown } | undefined)?.name ?? id);
    lines.push(bundleLine(id, `Installed ${name}, where your things live`, "homes"));
  }
  for (const inst of pkg.homes.instances) {
    const row = pkg.blueprint.instances.find((i) => i.instance_name === inst);
    const words = `Made ${row?.display_name ?? inst}, where your things live`;
    const got = await getInstance(orgId, inst);
    lines.push(got ? { group: "homes", words, state: "done" } : { group: "homes", words, state: "skipped", note: "it could not be made here" });
  }

  // ── 2. The records, each through its kind's own create, as the person.
  const kinds = new Map((await listKindsForOrg(orgId)).map((k) => [k.id, k]));
  const session = await signSession(userId);
  const scanPhoto = new Map(ledger.scans.map((s) => [`${s.entity_kind}\u0000${s.entity_id}`, s.photo_file_ids[0]]));
  const idMap = new Map<string, string>();
  const outcome = new Map<
    string,
    { made: number; missed: Array<{ title: string; why: string }>; dropped: Set<string>; pictureless: number; cameWith: string[] }
  >();
  const of = (kind: string) => {
    let o = outcome.get(kind);
    if (!o) outcome.set(kind, (o = { made: 0, missed: [], dropped: new Set(), pictureless: 0, cameWith: [] }));
    return o;
  };
  // Each stored file crosses once, however many records show it.
  const copied = new Map<string, string | null>();
  const copyOnce = async (fileId: string): Promise<string | null> => {
    if (!copied.has(fileId)) copied.set(fileId, await copyPicture(source, token, fileId, orgId, slug));
    return copied.get(fileId) ?? null;
  };
  const picturedBy = new Map<string, string>();
  for (const r of pkg.records) if (r.picture_file_id && !r.stored_file) picturedBy.set(r.picture_file_id, r.title);

  const ordered = orderByReferences(pkg.records.filter((r) => !r.stored_file));
  for (const r of ordered) {
    const o = of(r.kind);
    const k = kinds.get(r.kind);
    const create = k?.endpoints?.create;
    if (!k || !create) {
      o.missed.push({ title: r.title, why: k ? "there is no way to make one here" : "there is nowhere here to put it" });
      continue;
    }
    const body: Record<string, unknown> = { ...r.body };
    // References: re-pointed at what was just made, or left behind and said.
    for (const [key, v] of Object.entries(body)) {
      if (key === "metadata" || key === "image_path" || typeof v !== "string" || !UUID.test(v)) continue;
      const mapped = idMap.get(v);
      if (mapped) body[key] = mapped;
      else {
        delete body[key];
        o.dropped.add(key);
      }
    }
    // The picture: bytes from the trial into this workspace's own store.
    const pictureId = r.picture_file_id ?? (typeof body.image_path === "string" ? null : scanPhoto.get(`${r.kind}\u0000${r.id}`) ?? null);
    if (pictureId) {
      const path = await copyOnce(pictureId);
      if (path) body.image_path = path;
      else {
        delete body.image_path;
        o.pictureless++;
      }
    }
    try {
      // loopback-ok: #5153 moves this onto selfFetch
      const res = await fetch(`http://127.0.0.1:${env.API_PORT}${kindBase(slug, k)}${create}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const why = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message;
        o.missed.push({ title: r.title, why: why ?? `making it answered ${res.status}` });
        continue;
      }
      const made = (await res.json()) as { id?: string };
      if (made.id) idMap.set(r.id, made.id);
      o.made++;
    } catch (err) {
      o.missed.push({ title: r.title, why: (err as Error).message });
    }
  }

  // Stored files: the picture of a record that came (already across), or an
  // upload of its own, carried as bytes.
  for (const r of pkg.records.filter((x) => x.stored_file)) {
    const o = of(r.kind);
    const owner = picturedBy.get(r.id);
    const path = await copyOnce(r.id);
    if (!path) o.missed.push({ title: r.title, why: "its bytes could not be read in the trial" });
    else {
      o.made++;
      if (owner) o.cameWith.push(owner);
    }
  }

  for (const group of ledger.records) {
    const o = outcome.get(group.entity_kind) ?? { made: 0, missed: [], dropped: new Set<string>(), pictureless: 0, cameWith: [] };
    const unread = (pkg.unread ?? []).filter((u) => u.kind === group.entity_kind);
    const notes: string[] = [];
    if (o.missed.length) notes.push(`not brought: ${o.missed.map((m) => `${m.title} (${m.why})`).join("; ")}`);
    if (unread.length) notes.push(`${unread.length} could not be read in the trial`);
    if (o.dropped.size) notes.push(`left behind a link to something that stays in the trial (${[...o.dropped].join(", ")})`);
    if (o.pictureless) notes.push(`${o.pictureless} arrived without ${o.pictureless === 1 ? "its picture" : "their pictures"}`);
    const total = group.ids.length;
    const state: LineState = o.made === 0 ? "skipped" : o.made < total || notes.length ? "partly" : "done";
    const said = [...(o.made < total || notes.length ? [`${o.made} of ${total} brought`] : []), ...notes];
    if (o.cameWith.length) said.push(`the picture of ${o.cameWith.join(", ")}`);
    lines.push({ group: "contents", words: group.words, state, ...(said.length ? { note: said.join(". ") } : {}) });
  }

  const result: CarryResult = {
    lines,
    done: lines.filter((l) => l.state === "done").length,
    skipped: lines.filter((l) => l.state === "skipped").length,
    partly: lines.filter((l) => l.state === "partly").length,
  };
  await activity.log({
    orgId,
    userId,
    action: CARRY_REPLAYED,
    ref: { module: null, entityType: "carry", entityId: tokenHash },
    // `name` is the row's title in every feed: "brought in their trial: <name>".
    diff: { name: pkg.workspace.name, from: source, done: result.done, skipped: result.skipped, partly: result.partly },
  });
  console.log(`[carry] org ${orgId}: replayed from ${source}: ${result.done} done, ${result.partly} partly, ${result.skipped} skipped`);
  return result;
}
