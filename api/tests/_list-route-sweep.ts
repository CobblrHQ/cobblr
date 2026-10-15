// Every list the api serves costs a bounded number of meta statements,
// however many rows it returns.
//
// A lookup made once per row on a list takes the whole meta pool: resolveKind
// and getFieldReadScopes on the record lists (#4876), then the activity feed
// asking per entry what its kind hides and whether it restores (run 37036: one
// request held 78 of the CI api's 80 meta clients, 22 waiting). The third was
// found by the CI api starving, because the bounded-checkouts test named its
// routes by hand. What would be expensive if this were wrong: the fourth found
// the same way, by a red main and a starved production pool, instead of here.
//
// So the routes are DISCOVERED (the api's own route table) and the exemptions
// CURATED. Two workspaces with every module on: one left empty, one seeded
// with SEED records of every kind that declares a create route. Every
// workspace GET route is read in both with x-meta-probe; where the seeded one
// returned at least GREW_BY more rows, its meta statements may grow by at most
// GROWTH. A route whose rows did not grow (nothing the seed makes, or a
// single-record route) is not measured, and is listed in the output so the
// gap is visible.
//
// One file read all 372 routes in turn and became the floor under the whole
// test job (108s against a 91s packing floor, run 48936), so the routes are
// split into groups, one test file each, run in parallel forks. Every route
// falls in exactly one group (sweepGroupOf), and every file checks that each
// group still has its file, so a route cannot fall between them.
import "./_stub-env.js";
import { mapLimit } from "./map-limit.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fetchKinds, resolveCreatePath, type KindRec, type WorkspaceApi } from "@cobblr/workspace-tools";
import { BASE, FRESH_ORG_BUDGET_MS, enableAllModulesForTests, isApiUp, org, personDay, signupFreshOrg, type TestSession } from "./helpers.js";
import { worn } from "../../scripts/lib/load-factor.mjs";
import { testSupport } from "./test-support.js";
import { WAITING_READS, waitsInsteadOfAnswering } from "./_waiting-reads.js";

const live = await isApiUp();
const SEED = 12;
const FEW = 2;
const GROWTH = 3;
const GREW_BY = 5;
const SEED_AT_ONCE = 3;

/** Routes whose meta cost may grow with their rows, each with why. Keep it
 *  short: an entry here is a per-row lookup someone chose to keep. */
const EXEMPT: Record<string, string> = {};

type Probe = { total: number; statements: Array<{ text: string; count: number }>; cold_ttl_caches?: true };

function apiFor(s: TestSession): WorkspaceApi {
  return {
    async request(method, path, body) {
      const r = await fetch(`${BASE}${org(s, path.startsWith("/") ? path : `/${path}`)}`, {
        method,
        headers: { authorization: `Bearer ${s.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        /* not JSON */
      }
      return { status: r.status, body: parsed };
    },
  };
}

/** A value for each required field, by its type, so a create is accepted. */
function fieldsFor(k: KindRec, n: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const title = k.fields?.find((f) => f.role === "title")?.name ?? "name";
  out[title] = `bounded ${k.id} ${n}`;
  for (const f of k.fields ?? []) {
    if (!f.required || f.name in out || f.readOnly) continue;
    const t = String(f.type ?? "string");
    out[f.name] = /int|number|decimal|money|qty/.test(t) ? 1 : /bool/.test(t) ? false : /date/.test(t) ? personDay() : `bounded ${n}`;
  }
  return out;
}

/** The rows a list answered: a bare array, or the longest array at its top. */
function rowsOf(body: unknown): number {
  if (Array.isArray(body)) return body.length;
  if (!body || typeof body !== "object") return 0;
  return Math.max(0, ...Object.values(body as Record<string, unknown>).map((v) => (Array.isArray(v) ? v.length : 0)));
}

// A list whose default page is smaller than what enabling every module already
// writes: both workspaces filled one page, so the feed read as no growth and
// went unmeasured (/activity pages 25; enabling the modules logs more, 2026-10-08).
const PAGE: Record<string, string> = { "/activity": "?limit=200" };

async function read(s: TestSession, route: string): Promise<{ status: number; rows: number; probe: Probe | null }> {
  // This request owns its cold caches: a background read cannot warm the small
  // side between resetting shared entries and measuring it, or pay for its load.
  const id = `sweep-${Math.random().toString(36).slice(2, 10)}`;
  let status = 0;
  let text = "";
  try {
    // A stream never ends; a read that does not answer in time is not a list.
    const r = await fetch(`${BASE}${org(s, route)}${PAGE[route] ?? ""}`, { headers: { authorization: `Bearer ${s.token}`, "x-meta-probe": id, "x-meta-probe-cold": "1" }, signal: AbortSignal.timeout(worn(20_000)) });
    status = r.status;
    text = await r.text();
  } catch {
    return { status: 0, rows: 0, probe: null };
  }
  let rows = 0;
  try {
    rows = rowsOf(JSON.parse(text));
  } catch {
    /* a CSV or a page: no rows to count */
  }
  const p = await testSupport(`meta-probe/${id}`, { allow: [404] });
  const probe = p.ok ? ((await p.json()) as Probe) : null;
  if (probe) expect(probe.cold_ttl_caches, "the cold-probe header was ignored").toBe(true);
  return { status, rows, probe };
}

/** Each group's test file, by the group it sweeps. */
export const SWEEP_FILES = {
  "digifab-and-labels": "every-digifab-and-labels-list-route-costs-a-bounded-number-of-meta-checkouts.test.ts",
  "scan-ai-and-inventory": "every-scan-ai-and-inventory-list-route-costs-a-bounded-number-of-meta-checkouts.test.ts",
  "other-modules": "every-other-module-list-route-costs-a-bounded-number-of-meta-checkouts.test.ts",
  "edge-and-entities": "every-edge-and-entity-list-route-costs-a-bounded-number-of-meta-checkouts.test.ts",
  workspace: "every-workspace-list-route-costs-a-bounded-number-of-meta-checkouts.test.ts",
} as const;
export type SweepGroup = keyof typeof SWEEP_FILES;

/** The one group a workspace route is swept in. The last two branches take
 *  whatever the earlier ones leave, so a new module or prefix lands somewhere. */
export function sweepGroupOf(route: string): SweepGroup {
  if (/^\/modules\/(digifab|labels)\//.test(route)) return "digifab-and-labels";
  if (/^\/modules\/(core-scan|core-ai|inventory)\//.test(route)) return "scan-ai-and-inventory";
  if (route.startsWith("/modules/")) return "other-modules";
  if (/^\/(edge|entities)(\/|$)/.test(route)) return "edge-and-entities";
  return "workspace";
}

const grew = (big: Probe, small: Probe) =>
  big.statements
    .map((b) => ({ text: b.text, more: b.count - (small.statements.find((x) => x.text === b.text)?.count ?? 0) }))
    .filter((d) => d.more > 0)
    .map((d) => `    +${d.more} ${d.text}`)
    .join("\n");

/** One group's sweep: `mustMeasure` are routes of the group known to grow with
 *  the seed, the positive control that the group is really being measured. */
export function sweepListRoutes(group: SweepGroup, opts: { mustMeasure: string[]; minMeasured: number }): void {
  describe.skipIf(!live)(`every ${group} list route costs a bounded number of meta checkouts`, () => {
    let empty: TestSession;
    let seeded: TestSession;
    let all: string[] = [];
    let routes: string[] = [];
    const seededKinds: string[] = [];
    const partIds = { seeded: [] as string[], empty: [] as string[] };
    let queued = 0;

    beforeAll(async () => {
      [empty, seeded] = await Promise.all([signupFreshOrg("meta-sweep-empty"), signupFreshOrg("meta-sweep-seeded")]);
      await Promise.all([enableAllModulesForTests(empty), enableAllModulesForTests(seeded)]);
      const api = apiFor(seeded);
      const few = apiFor(empty);
      const kinds = await fetchKinds(api);
      for (const k of kinds) {
        const path = resolveCreatePath(k.id, kinds);
        if (!path) continue;
        // The small side has a FEW rows of every kind, never none: an empty list
        // skips the once-per-request loads (field defs, overrides), and 0 -> 12
        // then read those as growth with the rows.
        // SEED_AT_ONCE creates at a time, not all fourteen: five sweep files seed together when the
        // helper changes, and seventy creates at once took every client of the api's meta pool, timing
        // out another file's sign-up (run 50248, 2026-10-15).
        const [made, madeFew] = await Promise.all([
          mapLimit(Array.from({ length: SEED }, (_, n) => n), SEED_AT_ONCE, (n) => api.request("POST", `/${path}`, fieldsFor(k, n))),
          mapLimit(Array.from({ length: FEW }, (_, n) => n), 1, (n) => few.request("POST", `/${path}`, fieldsFor(k, n))),
        ]);
        if (made.filter((m) => m.status < 300).length === SEED) seededKinds.push(k.id);
        if (k.id === "inventory:part") {
          partIds.seeded = made.map((m) => String(m.body.id ?? "")).filter(Boolean);
          partIds.empty = madeFew.map((m) => String(m.body.id ?? "")).filter(Boolean);
        }
      }
      // A label queued for each part: the queue is a list whose rows are records
      // the seed made, and it resolved each row's title and kind on its own, which
      // took the whole meta pool on staging's walker workspace (60 labels, #5875).
      const queue = (w: WorkspaceApi, ids: string[]) =>
        mapLimit(ids, SEED_AT_ONCE, (id) => w.request("POST", "/modules/labels/queue", { module_name: "inventory", entity_type: "part", entity_id: id, qr_payload: `${BASE}/q/${id}`, description: `bounded ${id.slice(0, 8)}` }));
      queued = (await queue(api, partIds.seeded)).filter((r) => r.status < 300).length;
      await queue(few, partIds.empty);
      const listed = (await (await fetch(`${BASE}/api/v1/test/routes`)).json()) as { routes: string[] };
      all = listed.routes
        .filter((r) => r.startsWith("GET /api/v1/orgs/:slug/"))
        .map((r) => r.slice("GET /api/v1/orgs/:slug".length))
        .flatMap((r) => (/:(kind|entityKind)\b/.test(r) ? seededKinds.map((k) => r.replace(/:(kind|entityKind)\b/, encodeURIComponent(k))) : [r]))
        .filter((r) => !/:[A-Za-z_]+/.test(r));
      routes = all.filter((r) => sweepGroupOf(r) === group && !waitsInsteadOfAnswering(r));
    }, worn(FRESH_ORG_BUDGET_MS * 6));

    it("seeds enough of the workspace to measure (the positive control)", () => {
      expect(seededKinds, "kinds that took every one of their seed records").toEqual(expect.arrayContaining(["inventory:part"]));
      expect(seededKinds.length).toBeGreaterThanOrEqual(5);
      expect(queued, "labels queued for the seeded parts").toBe(SEED);
      expect(all.length, "the api listed its own routes").toBeGreaterThan(50);
      expect(routes.length, `routes in the ${group} group`).toBeGreaterThan(0);
    });

    it(`no route's meta statements grow by more than ${GROWTH} with its rows`, async () => {
      const over: string[] = [];
      const measured: string[] = [];
      const unmeasured: string[] = [];
      await mapLimit(routes, 4, async (route) => {
        // The two workspaces at once, each with its own cold caches, so neither
        // warms the other and background work cannot warm either measurement.
        const [small, big] = await Promise.all([read(empty, route), read(seeded, route)]);
        if (small.status !== 200 || big.status !== 200 || !small.probe || !big.probe || big.rows < small.rows + GREW_BY) {
          unmeasured.push(route);
          return;
        }
        measured.push(route);
        const more = big.probe.total - small.probe.total;
        if (more > GROWTH && !(route in EXEMPT)) over.push(`${route}: ${small.rows} -> ${big.rows} rows, +${more} meta statements\n${grew(big.probe, small.probe)}`);
      });
      console.log(`${group}: measured ${measured.length} list routes (${measured.join(", ")}); ${unmeasured.length} not measured (no rows the seed makes, or not a list):\n  ${unmeasured.join("\n  ")}`);
      for (const r of opts.mustMeasure) expect(measured, `${r}, which grows with the seed, is among the measured`).toContain(r);
      expect(measured.length, "enough lists measured for this to mean something").toBeGreaterThanOrEqual(opts.minMeasured);
      expect(over, "lists whose meta statements grew with their rows (a lookup made per row: resolve it once per request or per kind)").toEqual([]);
    }, worn(600_000));

    it("every exemption still names a route the api serves", () => {
      for (const r of Object.keys(EXEMPT)) expect(all, `exempt route ${r} is gone: drop it`).toContain(r);
      for (const r of Object.keys(WAITING_READS)) expect(all, `waiting read ${r} is gone: drop it from _waiting-reads.ts`).toContain(r);
    });

    it("every group a route falls in has its own test file, so no route goes unswept", () => {
      const groups = new Set(all.map(sweepGroupOf));
      for (const g of groups) {
        const file = join(import.meta.dirname, SWEEP_FILES[g]);
        expect(existsSync(file), `${SWEEP_FILES[g]} sweeps the ${g} routes`).toBe(true);
        expect(readFileSync(file, "utf8"), `${SWEEP_FILES[g]} sweeps the ${g} group`).toContain(`sweepListRoutes("${g}"`);
      }
      expect(groups.size, "every group has routes; drop an empty one").toBe(Object.keys(SWEEP_FILES).length);
    });
  });
}
