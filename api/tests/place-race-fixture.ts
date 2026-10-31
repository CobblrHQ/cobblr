// The races of "a place deleted while something moves into it" (#4115,
// locations pass 4): one workspace per file, a place with KEPT things in it so
// its delete is still at work when the move lands, and the helpers both files
// race with. Split in two files so neither runs past its budget (#8975).
import { beforeAll } from "vitest";
import { FRESH_ORG_BUDGET_MS, http, org, signupFreshOrg, type TestSession } from "./helpers.js";
import { worn } from "../../scripts/lib/load-factor.mjs";
import { mapLimit } from "./map-limit.js";

export const LOC = "/modules/core-locations/locations";
export const ROUNDS = 3;
// A place with this many things in it takes a while to empty, so the move,
// sent once the first of them is out, lands while the delete is at work.
export const KEPT = 30;

export function placeRace() {
  let s!: TestSession;
  const tag = () => Math.random().toString(36).slice(2, 7);
  const place = async (name: string, parent?: string) =>
    (await http<{ id: string }>(s, org(s, LOC), { method: "POST", body: { name: `${name} ${tag()}`, kind: parent ? "container" : "area", ...(parent ? { parent_id: parent } : {}) } })).id;
  const part = async (name: string, location_id: string | null) =>
    (await http<{ id: string }>(s, org(s, "/modules/inventory/parts"), { method: "POST", body: { name, qty: 1, ...(location_id ? { location_id } : {}) } })).id;
  // A place's things are made eight at a time: made one by one, the races' 300
  // of them were most of the file's time and ran it past its budget (#8975).
  const things = (n: string, at: string | null) => mapLimit(Array.from({ length: KEPT }, (_, k) => k), 8, (k) => part(`${n}.${k}`, at));
  const partAt = async (id: string) => (await http<{ location_id: string | null }>(s, org(s, `/modules/inventory/parts/${id}`))).location_id;
  const onTree = async () => new Set((await http<{ items: Array<{ id: string }> }>(s, org(s, LOC))).items.map((l) => l.id));
  const raw = (method: string, path: string, body?: unknown, as: TestSession = s) =>
    fetch(`${process.env.COBBLR_TEST_API}/api/v1/orgs/${s.slug}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as.token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  /** Send a delete, and once it has begun taking things out (the first or the
   *  last of `kept` reads nowhere), send `then`. Both answers, in that order. */
  const midDelete = async (placeId: string, kept: string[], then: () => Promise<Response>, by: TestSession = s) => {
    const deleting = raw("DELETE", `${LOC}/${placeId}`, undefined, by);
    const deadline = Date.now() + worn(30_000);
    while (Date.now() < deadline) {
      const [first, last] = await Promise.all([partAt(kept[0]!), partAt(kept[kept.length - 1]!)]);
      if (first === null || last === null) break;
    }
    return Promise.all([deleting, then()]);
  };

  beforeAll(async () => {
    s = await signupFreshOrg("place-delete-race");
    for (const m of ["core-locations", "inventory"]) await http(s, org(s, `/modules/${m}/enable`), { method: "POST" });
  }, FRESH_ORG_BUDGET_MS);

  return {
    get s() { return s; },
    place, part, things, partAt, onTree, raw, midDelete, tag,
  };
}
