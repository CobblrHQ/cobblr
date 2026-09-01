// The books and food a fresh sandbox actually opens on.
//
// The blueprint beside this builds the SHAPE - modules, bundles, fields, views -
// and stops there, because that is what a blueprint is: a workspace's design,
// not its contents. Which meant a sandbox came up correct and completely empty,
// the one outcome its own seed was written to prevent. A visitor who lands on an
// empty table has been handed a spreadsheet and asked to imagine.
//
// So contents are a separate file and a separate step, and the blueprint stays
// what it is.
//
// Records are written through the ORDINARY api the same way a person would, over
// loopback with the sandbox's own session:
//
//   - it is the instance-addressed path (/instances/<name>/items) the platform
//     mounts for every primary entity, so this file names no module and the
//     kernel keeps its distance from what a bundle happens to be built on;
//   - validation, defaults, activity and events all fire exactly as they do for
//     a real write, so a seeded sandbox is not a special shape of workspace that
//     behaves differently the moment somebody touches it.
//
// Everything is best-effort. A sandbox with nine books instead of ten is fine; a
// visitor who gets no sandbox because a cover image 404'd is not.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../env.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Same directory as the blueprints, same override for tests. */
function seedDir(): string {
  return process.env.COBBLR_TRY_SEED_DIR ?? path.resolve(HERE, "../../../deploy/seeds");
}

/** Dates have to be relative or the kitchen is stale the day after it is
 *  written - a fridge full of food that expired last month reads as abandoned
 *  test data, which is worse than an empty one. */
interface RelativeDate {
  $daysFromNow: number;
}

function isRelativeDate(v: unknown): v is RelativeDate {
  return typeof v === "object" && v !== null && typeof (v as RelativeDate).$daysFromNow === "number";
}

function resolveDates(body: Record<string, unknown>, now: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (isRelativeDate(v)) {
      const d = new Date(now + v.$daysFromNow * 86_400_000);
      out[k] = d.toISOString().slice(0, 10);
    } else {
      out[k] = v;
    }
  }
  return out;
}

interface SeedRequest {
  instance: string;
  entity_kind: string;
  body: Record<string, unknown>;
  image_url?: string;
}

interface RecordSeedDoc {
  kind?: string;
  requests?: SeedRequest[];
}

export interface RecordSeedOutcome {
  created: number;
  failed: number;
  reason?: string;
  /** Covers land AFTER the visitor does. Resolves with how many arrived; the
   *  route ignores it and tests can await it. */
  images: Promise<number>;
}

/** How long to wait on one cover before giving up. Generous, because nobody is
 *  waiting on it any more - see the background note below. */
const IMAGE_TIMEOUT_MS = 8_000;

function base(): string {
  return `http://127.0.0.1:${env.API_PORT}`;
}

/** Apply the contents that go with a blueprint, if there are any.
 *
 *  `name` is the seed name; the contents live beside it as <name>.records.json.
 *  A seed with no contents file is not an error - most blueprints are shapes. */
export async function seedSandboxRecords(
  slug: string,
  sessionToken: string,
  name: string,
  now: number = Date.now(),
): Promise<RecordSeedOutcome> {
  const trimmed = (name ?? "").trim();
  if (!trimmed || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(trimmed)) {
    return { created: 0, failed: 0, images: Promise.resolve(0), reason: "no seed" };
  }

  let raw: string;
  try {
    raw = await readFile(path.join(seedDir(), `${trimmed}.records.json`), "utf8");
  } catch {
    return { created: 0, failed: 0, images: Promise.resolve(0), reason: "no contents file" };
  }

  let doc: RecordSeedDoc;
  try {
    doc = JSON.parse(raw) as RecordSeedDoc;
  } catch (err) {
    return { created: 0, failed: 0, images: Promise.resolve(0), reason: `not valid JSON: ${(err as Error).message}` };
  }
  const requests = Array.isArray(doc.requests) ? doc.requests : [];
  if (requests.length === 0) return { created: 0, failed: 0, images: Promise.resolve(0), reason: "no requests" };

  const auth = { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" };
  let created = 0;
  let failed = 0;
  const withImages: Array<{ id: string; entity_kind: string; instance: string; image_url: string }> = [];

  for (const r of requests) {
    // Instance names are workspace data, but they land in a URL, so they are
    // pinned to the same shape the platform allows rather than trusted.
    if (!/^[a-z0-9][a-z0-9_-]{0,60}$/i.test(r.instance ?? "")) {
      failed++;
      continue;
    }
    try {
      const res = await fetch(`${base()}/api/v1/orgs/${encodeURIComponent(slug)}/instances/${encodeURIComponent(r.instance)}/items`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(resolveDates(r.body ?? {}, now)),
      });
      if (!res.ok) {
        failed++;
        continue;
      }
      created++;
      if (r.image_url) {
        const item = (await res.json()) as { id?: string };
        if (item.id) {
          withImages.push({ id: item.id, entity_kind: r.entity_kind, instance: r.instance, image_url: r.image_url });
        }
      }
    } catch {
      failed++;
    }
  }

  // Covers come AFTER the visitor does.
  //
  // Measured on the box: the public catalogue answers a single request in about
  // a second and throttles a burst hard - five at once queued to ~6s each and
  // one timed out outright, so a "faster" concurrent fetch delivered ONE cover
  // where one-at-a-time delivered ten. Fetching them in parallel was the wrong
  // lever entirely.
  //
  // The right one is not making anybody wait. Ten sequential fetches is ten
  // seconds of somebody looking at a loading page for pictures they have not
  // asked for yet; the books themselves are already written. So this is started
  // and deliberately not awaited: the visitor lands on their shelf immediately
  // and the covers fill in underneath them while they look around.
  //
  // Never rejects. A failure here must not become an unhandled rejection in a
  // process that is otherwise fine.
  const images = (async (): Promise<number> => {
    let got = 0;
    for (const it of withImages) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), IMAGE_TIMEOUT_MS);
        const res = await fetch(`${base()}/api/v1/orgs/${encodeURIComponent(slug)}/modules/core-scan/entity-image`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            entity_kind: it.entity_kind,
            entity_id: it.id,
            instance: it.instance,
            image_url: it.image_url,
          }),
          signal: ctl.signal,
        });
        clearTimeout(timer);
        if (res.ok) got++;
      } catch {
        /* a book without a cover is still a book */
      }
    }
    return got;
  })().catch(() => 0);

  return { created, failed, images };
}

/** Empty a sandbox of its RECORDS, leaving its shape alone.
 *
 *  The alternative was asking at the door — "stocked, or blank?" — which makes
 *  somebody choose before either word means anything to them. A button instead:
 *  arrive stocked, poke at real data, and clear it out once you know what you
 *  want your own to look like. That is also the honest order, because the
 *  seeded kitchen is ours, not theirs.
 *
 *  Deliberately records only. The modules, fields and saved views stay, because
 *  those are the part somebody just spent twenty minutes deciding they like;
 *  wiping them would be a factory reset wearing the word "clear".
 *
 *  Writes through the ordinary instance API over loopback, same as the seed, so
 *  deletes fire the same events and activity a person's delete would. */
export async function emptySandboxRecords(
  slug: string,
  sessionToken: string,
): Promise<{ deleted: number; failed: number }> {
  const auth = { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" };
  const org = encodeURIComponent(slug);
  let deleted = 0;
  let failed = 0;

  let instances: Array<{ instance_name?: string }> = [];
  try {
    const res = await fetch(`${base()}/api/v1/orgs/${org}/instances`, { headers: auth });
    if (!res.ok) return { deleted: 0, failed: 1 };
    instances = ((await res.json()) as { items?: Array<{ instance_name?: string }> }).items ?? [];
  } catch {
    return { deleted: 0, failed: 1 };
  }

  for (const inst of instances) {
    const name = inst.instance_name;
    // Instance names are workspace data that lands in a URL, so they are pinned
    // to the shape the platform allows rather than trusted.
    if (!name || !/^[a-z0-9][a-z0-9_-]{0,60}$/i.test(name)) continue;
    const items = `${base()}/api/v1/orgs/${org}/instances/${encodeURIComponent(name)}/items`;
    // Page by re-reading rather than by offset: rows are disappearing under us.
    for (let guard = 0; guard < 200; guard++) {
      let rows: Array<{ id?: string }> = [];
      try {
        const res = await fetch(`${items}?limit=100`, { headers: auth });
        if (!res.ok) { failed++; break; }
        rows = ((await res.json()) as { items?: Array<{ id?: string }> }).items ?? [];
      } catch {
        failed++;
        break;
      }
      if (rows.length === 0) break;
      let progressed = false;
      for (const row of rows) {
        if (!row.id) continue;
        try {
          const res = await fetch(`${items}/${encodeURIComponent(row.id)}`, { method: "DELETE", headers: auth });
          if (res.ok) { deleted++; progressed = true; } else failed++;
        } catch {
          failed++;
        }
      }
      // Nothing in this page could be deleted, so the next read returns the
      // same page. Stop instead of spinning until the guard runs out.
      if (!progressed) break;
    }
  }
  return { deleted, failed };
}
