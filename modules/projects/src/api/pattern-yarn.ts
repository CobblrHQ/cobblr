// A pattern's yarns against the stash: what fits, which yarn each one is made
// with, what goes on the shopping list, and what a finished pattern takes off.
//
// Each yarn requirement is a LINE (its row id) of the pattern, and inventory
// keeps that line's balls: the unopened ones held for it and the open ones
// bound to it (inventory target-lines.ts). So a two-colour blanket's Main
// Color and Contrast A each draw on their own balls, each has its own "used
// so far", and one can change yarn halfway without touching the other.
//
// Nothing here moves stock itself. Every quantity goes through inventory's
// actions, and they through its one writer, so what a pattern used is a line
// on the statement of each ball it came from (consumption-ledger.md).
//
//   use      pick the yarn a requirement is made with. Its balls are held.
//            Picking a different one halfway is a swap: what the old yarn
//            gave stays on its balls (plus anything said "used so far" beyond
//            what was logged), its balls go back to the pool, and the rest is
//            held on the new yarn. Matches and the shopping line follow.
//   shop     put what is missing on the shopping list, and keep that line
//            true when the yarn changes or the stash catches up.
//   settle   the pattern is done: each requirement's still-to-use length is
//            taken off its yarn, its own balls first. Abandoned: let it go.

import type { Kysely } from "kysely";
import { countOf, platform } from "@cobblr/platform-contract";
import type { ProjectsDB } from "../db.js";
import { listNeeds, type PatternNeed } from "./pattern-needs.js";
import { shoppingLine, toolFits, yarnFits, type StashTool, type YarnFit } from "./pattern-match.js";
import { readStash, type Stash } from "./pattern-stash.js";

export const PATTERN_TARGET = { for_kind: "projects:project" } as const;

async function tenant(orgId: string): Promise<Kysely<ProjectsDB>> {
  return (await platform().tenants.getDb(orgId)) as Kysely<ProjectsDB>;
}

async function inventory(action: string, orgId: string, userId: string | null, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  return invokeAction(`inventory:${action}`, orgId, userId, args);
}

async function invokeAction(actionId: string, orgId: string, userId: string | null, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    return (await platform().actions.invoke(actionId, {
      orgId,
      userId,
      scope: "workspace",
      event: {
        name: "projects.pattern.yarn",
        payload: {},
        actor: { user_id: userId, display_name: null, auth_method: "session", api_token_id: null, api_token_name: null },
        timestamp: new Date().toISOString(),
        trigger_type: "user-invoked",
      },
      args,
    })) as Record<string, unknown> | null;
  } catch (e) {
    // No inventory (or lists) in this workspace, or the action refused: the pattern still works.
    console.warn(`[projects] ${actionId} unavailable:`, (e as Error).message);
    return null;
  }
}

interface LineUsage {
  line: string;
  used_measure: number;
  used_units: number;
  reserved: { part_id: string; part_name: string; qty: number }[];
  bound: { part_id: string; part_name: string; model_id: string | null; left: number }[];
  models: string[];
}

async function usageOf(orgId: string, userId: string | null, projectId: string): Promise<Map<string, LineUsage>> {
  const r = await inventory("line-usage", orgId, userId, { ...PATTERN_TARGET, for_id: projectId });
  const lines = (r?.lines as LineUsage[] | undefined) ?? [];
  return new Map(lines.map((l) => [l.line, l]));
}

export interface NeedMatch {
  /** The yarn this is being made with, when one was picked. */
  chosen: { id: string; name: string } | null;
  /** Taken off the stash for it so far (logged on its balls), all yarns it used. */
  used_m: number;
  used_units: number;
  /** What it still needs, in the pattern's terms. */
  still_m: number | null;
  still_units: number | null;
  /** What it has: the open balls bound to it and unopened ones held. */
  bound: { name: string; left_m: number }[];
  held_units: number;
  /** have: the chosen (or best) yarn covers it. short: it does not. none: nothing fits. unknown: no amount to compare. */
  status: "have" | "short" | "none" | "unknown";
  short_m: number | null;
  short_units: number | null;
  /** The stash yarns that fit, best first (a few). */
  fits: YarnFit[];
  /** For a hook or needle: the ones of that size the stash has. */
  tools: StashTool[];
}

function still(need: PatternNeed, u: LineUsage | undefined): { m: number | null; units: number | null } {
  const usedM = u?.used_measure ?? 0;
  const usedU = u?.used_units ?? 0;
  return {
    m: need.length_m != null ? Math.max(0, need.length_m - usedM) : null,
    units: need.quantity != null && need.length_m == null ? Math.max(0, need.quantity - usedU) : null,
  };
}

/** Each need's match, for the page. The stash is read once. */
export async function matchNeeds(orgId: string, userId: string | null, projectId: string, needs: PatternNeed[], stash?: Stash): Promise<Map<string, NeedMatch>> {
  const out = new Map<string, NeedMatch>();
  if (needs.length === 0) return out;
  const s = stash ?? (await readStash(orgId));
  const usage = await usageOf(orgId, userId, projectId);
  for (const n of needs) {
    if (n.kind !== "yarn") {
      const tools = n.size_mm != null ? toolFits(n.size_mm, s.tools) : [];
      out.set(n.id, {
        chosen: null, used_m: 0, used_units: 0, still_m: null, still_units: null, bound: [], held_units: 0,
        status: tools.length ? "have" : "none", short_m: null, short_units: null, fits: [], tools,
      });
      continue;
    }
    const u = usage.get(n.id);
    const left = still(n, u);
    // What the line already holds counts toward it: bound balls and held units.
    const heldM = (u?.bound ?? []).reduce((a, b) => a + b.left, 0);
    const heldUnits = (u?.reserved ?? []).reduce((a, b) => a + b.qty, 0);
    const fits = yarnFits(n, s.yarns, left.m, left.units);
    const chosenFit = n.part_id ? fits.find((f) => f.yarn.id === n.part_id) : undefined;
    const chosenYarn = n.part_id ? (s.yarns.find((y) => y.id === n.part_id) ?? null) : null;
    let status: NeedMatch["status"] = "none";
    let shortM: number | null = null;
    let shortU: number | null = null;
    if (n.settled_at) {
      status = "have";
    } else if (chosenYarn) {
      // The chosen yarn: what it holds for this line plus what is still free.
      const unitLen = chosenYarn.unit_length_m;
      const freeM = unitLen != null ? chosenYarn.free_units * unitLen : null;
      if (left.m != null && unitLen != null) {
        shortM = Math.max(0, Math.round(left.m - heldM - heldUnits * unitLen - (freeM ?? 0)));
        status = shortM === 0 ? "have" : "short";
      } else if (left.units != null) {
        shortU = Math.max(0, Math.ceil(left.units - heldUnits - chosenYarn.free_units));
        status = shortU === 0 ? "have" : "short";
      } else status = "unknown";
    } else if (fits[0]?.fit === "same") {
      const best = fits[0];
      status = best.enough === false ? "short" : best.enough === true ? "have" : "unknown";
      shortM = best.short_m;
      shortU = best.short_units;
    } else if (left.m != null) {
      // Only a stand-in (another colour, another yarn of the weight): it is
      // offered, but it covers none of what this pattern asks for.
      shortM = Math.round(left.m);
    } else if (left.units != null) {
      shortU = Math.ceil(left.units);
    }
    out.set(n.id, {
      chosen: chosenYarn ? { id: chosenYarn.id, name: chosenYarn.name } : n.part_id ? { id: n.part_id, name: "a yarn no longer in the stash" } : null,
      used_m: Math.round(u?.used_measure ?? 0),
      used_units: u?.used_units ?? 0,
      still_m: left.m,
      still_units: left.units,
      bound: (u?.bound ?? []).map((b) => ({ name: b.part_name, left_m: b.left })),
      held_units: heldUnits,
      status,
      short_m: shortM,
      short_units: shortU,
      fits: (chosenFit ? [chosenFit, ...fits.filter((f) => f !== chosenFit)] : fits).slice(0, 5),
      tools: [],
    });
  }
  return out;
}

async function projectName(db: Kysely<ProjectsDB>, projectId: string): Promise<string> {
  return (await db.selectFrom("projects_projects").select("name").where("id", "=", projectId).executeTakeFirst())?.name ?? "a pattern";
}

function lineRef(projectId: string, needId: string) {
  return { ...PATTERN_TARGET, for_id: projectId, for_line: needId };
}

/**
 * Make a requirement with this yarn. The first pick holds what the pattern
 * still needs; a later pick is a swap: `usedSoFarM` (what the person says the
 * old yarn has given, when more than was logged) is taken off the old yarn's
 * balls, they go back to the pool, and the rest is held on the new one.
 */
export async function useYarn(
  orgId: string,
  userId: string | null,
  projectId: string,
  needId: string,
  partId: string | null,
  usedSoFar?: { m?: number; units?: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = await tenant(orgId);
  const need = (await listNeeds(db, projectId)).find((n) => n.id === needId);
  if (!need || need.kind !== "yarn") return { ok: false, error: "no such yarn on this pattern" };
  if (need.settled_at) return { ok: false, error: "This pattern is finished; its yarn was already taken off the stash." };
  const name = await projectName(db, projectId);
  const ref = lineRef(projectId, needId);
  const label = `${name}${need.label ? ` (${need.label})` : ""}`;

  if (need.part_id && need.part_id !== partId) {
    // A swap. Whatever the old yarn gave beyond what was logged comes off it
    // first, so its balls end the switch holding what they really hold.
    const usage = (await usageOf(orgId, userId, projectId)).get(needId);
    const extraM = usedSoFar?.m != null ? usedSoFar.m - (usage?.used_measure ?? 0) : 0;
    const extraU = usedSoFar?.units != null ? usedSoFar.units - (usage?.used_units ?? 0) : 0;
    if (extraM > 0 || extraU > 0) {
      await inventory("use-for-line", orgId, userId, {
        ...ref,
        part_id: need.part_id,
        ...(extraM > 0 ? { measure: extraM } : { units: extraU }),
        reason: label,
      });
    }
    await inventory("release-line", orgId, userId, ref);
  }
  if (!partId) {
    if (need.part_id) await inventory("release-line", orgId, userId, ref);
    await db.updateTable("projects_pattern_needs").set({ part_id: null, updated_at: new Date() }).where("id", "=", needId).execute();
    await syncShoppingLine(orgId, userId, projectId, needId);
    return { ok: true };
  }

  await db.updateTable("projects_pattern_needs").set({ part_id: partId, updated_at: new Date() }).where("id", "=", needId).execute();
  // Hold what it still needs, in whole units of the new yarn, as far as the stash goes.
  const stash = await readStash(orgId);
  const yarn = stash.yarns.find((y) => y.id === partId);
  const usage = (await usageOf(orgId, userId, projectId)).get(needId);
  const left = still({ ...need, part_id: partId }, usage);
  const heldUnits = (usage?.reserved ?? []).filter((r) => r.part_id === partId).reduce((a, b) => a + b.qty, 0);
  const boundM = (usage?.bound ?? []).filter((b) => b.model_id === partId).reduce((a, b) => a + b.left, 0);
  let want = 0;
  if (left.m != null && yarn?.unit_length_m) want = Math.ceil(Math.max(0, left.m - boundM) / yarn.unit_length_m);
  else if (left.units != null) want = Math.ceil(left.units);
  else if (need.quantity != null) want = Math.ceil(need.quantity);
  // The pattern gives no amount at all: hold one ball, so the stash knows it
  // is spoken for (finishing uses what was held).
  else want = 1;
  want = Math.min(Math.max(0, want - heldUnits), Math.max(0, Math.floor(yarn?.free_units ?? 0)));
  if (want > 0) {
    await inventory("reserve-for-line", orgId, userId, { ...ref, part_id: partId, qty: want, reason: label });
  }
  await syncShoppingLine(orgId, userId, projectId, needId);
  return { ok: true };
}

/** The shopping-list line for a requirement: added when asked, then kept
 *  true. A line whose shortfall is gone comes off; one whose shortfall
 *  changed is replaced by the new amount. */
export async function syncShoppingLine(
  orgId: string,
  userId: string | null,
  projectId: string,
  needId: string,
  opts: { add?: boolean; withdraw?: boolean } = {},
): Promise<{ ok: true; listed: boolean; title?: string } | { ok: false; error: string }> {
  const db = await tenant(orgId);
  const needs = await listNeeds(db, projectId);
  const need = needs.find((n) => n.id === needId);
  if (!need) return { ok: false, error: "no such need on this pattern" };
  if (!need.list_item_id && !opts.add) return { ok: true, listed: false };
  const m = (await matchNeeds(orgId, userId, projectId, [need])).get(needId);
  const missing = !!m && (m.status === "none" || m.status === "short");
  const line =
    need.kind === "yarn"
      ? shoppingLine(need, m?.short_m ?? null, m?.short_units ?? null)
      : { title: `${need.kind === "needle" ? "Knitting needle" : "Crochet hook"} ${need.size_mm} mm${need.size_label ? ` (${need.size_label})` : ""}`, qty: null };
  const name = await projectName(db, projectId);

  // Whatever the line said before, it comes off; a true one goes back on.
  if (need.list_item_id) {
    await invokeAction("lists:withdraw-item", orgId, userId, { item_id: need.list_item_id });
    await db.updateTable("projects_pattern_needs").set({ list_item_id: null }).where("id", "=", needId).execute();
  }
  if (!missing || opts.withdraw) return { ok: true, listed: false };
  const r = await invokeAction("lists:add-item", orgId, userId, {
    listTitle: "Shopping list",
    title: line.title,
    ...(line.qty ? { qty: line.qty } : {}),
    note: `For ${name}`,
  });
  const res = (r ?? {}) as { ok?: boolean; itemId?: string; error?: string };
  const itemId = res.itemId ?? null;
  if (itemId) await db.updateTable("projects_pattern_needs").set({ list_item_id: itemId }).where("id", "=", needId).execute();
  if (!itemId) return { ok: false, error: res.error ?? "The shopping list could not be reached." };
  return { ok: true, listed: true, title: line.title };
}

/**
 * The pattern is finished: each yarn it was made with gives what the pattern
 * still needs, taken off its own balls first, and the line is let go (a half
 * ball goes back to the pool). A yarn with no pick is said, not guessed.
 * Idempotent: a settled requirement is never taken off twice.
 */
export async function settlePattern(orgId: string, userId: string | null, projectId: string, outcome: "done" | "abandoned"): Promise<void> {
  const db = await tenant(orgId);
  const needs = (await listNeeds(db, projectId)).filter((n) => n.kind === "yarn" && !n.settled_at);
  const name = await projectName(db, projectId);
  const usage = needs.length ? await usageOf(orgId, userId, projectId) : new Map<string, LineUsage>();
  for (const n of needs) {
    const ref = lineRef(projectId, n.id);
    if (outcome === "abandoned") {
      if (n.part_id) await inventory("release-line", orgId, userId, ref);
      continue;
    }
    if (!n.part_id) {
      await db
        .updateTable("projects_pattern_needs")
        .set({ settled_at: new Date(), settle_note: "No yarn was picked for this, so nothing was taken off the stash." })
        .where("id", "=", n.id)
        .execute();
      continue;
    }
    const left = still(n, usage.get(n.id));
    const label = `${name}${n.label ? ` (${n.label})` : ""}`;
    let note: string;
    // No amount in the pattern: what was held for it is what it used.
    const held = (usage.get(n.id)?.reserved ?? []).filter((r) => r.part_id === n.part_id).reduce((a, b) => a + b.qty, 0);
    if (left.m == null && left.units == null && held > 0) left.units = held;
    if (left.m != null || left.units != null) {
      const r = (await inventory("use-for-line", orgId, userId, {
        ...ref,
        part_id: n.part_id,
        ...(left.m != null ? { measure: left.m } : { units: left.units }),
        reason: label,
      })) as { ok?: boolean; took?: { part_name: string; amount: number; left: number }[]; short?: number; unit?: string | null } | null;
      const took = r?.took ?? [];
      const total = took.reduce((a, b) => a + b.amount, 0);
      const unit = left.m != null ? (r?.unit ?? "m") : n.quantity_unit ?? "ball";
      const earlier = left.m != null ? Math.round(usage.get(n.id)?.used_measure ?? 0) : usage.get(n.id)?.used_units ?? 0;
      const amount = (v: number) => (left.m != null ? `${Math.round(v)} ${unit}` : countOf(Math.round(v), unit)); // count-unit-ok: a measured unit (m) takes no plural; a count goes through countOf
      note =
        `Took ${amount(total)} off ${countOf(took.length, "ball")}.` +
        (earlier > 0 ? ` ${amount(earlier)} had already come off while you worked.` : "") +
        (r?.short ? ` The stash was ${amount(r.short)} short.` : "");
    } else {
      note = "The pattern gives no amount for this yarn, so nothing was taken off; log what you used on its balls.";
    }
    await inventory("release-line", orgId, userId, ref);
    await db.updateTable("projects_pattern_needs").set({ settled_at: new Date(), settle_note: note }).where("id", "=", n.id).execute();
  }
  // Whatever was reserved for the pattern as a whole (the Materials panel).
  await inventory("settle-target", orgId, userId, { ...PATTERN_TARGET, for_id: projectId, outcome });
}
