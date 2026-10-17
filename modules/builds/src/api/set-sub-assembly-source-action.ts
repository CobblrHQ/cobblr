// Use stock first or always make (builds:set-sub-assembly-source): the handler its manifest entry names. Wired in ./index.ts.
// The same switch as a sub-assembly line's toggle on the build page (PATCH …/components/:cid).
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";

type Args = { build?: unknown; sub_assembly?: unknown; use_stock?: unknown };
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A build by its id or its name, or a sentence naming what there is. */
async function findBuild(db: Kysely<BuildsDB>, said: string, among?: string[]): Promise<{ id: string; name: string } | string> {
  let q = db.selectFrom("builds_builds").select(["id", "name"]);
  if (among) q = q.where("id", "in", among.length ? among : ["00000000-0000-0000-0000-000000000000"]);
  const rows = await q.execute();
  const hit = rows.filter((r) => r.id === said || r.name.toLowerCase() === said.toLowerCase());
  if (hit.length === 1) return hit[0]!;
  if (hit.length > 1) return `More than one build is called ${said}.`;
  const names = rows.map((r) => r.name).slice(0, 8);
  return among
    ? `${said} is not a sub-assembly of this build.${names.length ? ` Its sub-assemblies are: ${names.join(", ")}.` : " It has none."}`
    : `No build is called ${said}.`;
}

export async function setSubAssemblySource(db: Kysely<BuildsDB>, args: Args): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const useStock = args.use_stock === true || args.use_stock === "true" ? true : args.use_stock === false || args.use_stock === "false" ? false : null;
  if (useStock == null) return { ok: false, error: "Say whether to take it from stock first (yes) or always make it (no)." };
  const build = await findBuild(db, text(args.build));
  if (typeof build === "string") return { ok: false, error: build };
  const lines = await db.selectFrom("builds_components").select(["sub_assembly_build_id"]).where("build_id", "=", build.id).where("sub_assembly_build_id", "is not", null).execute();
  const sub = await findBuild(db, text(args.sub_assembly), lines.map((l) => l.sub_assembly_build_id!));
  if (typeof sub === "string") return { ok: false, error: sub };
  await db.updateTable("builds_components").set({ use_stock: useStock }).where("build_id", "=", build.id).where("sub_assembly_build_id", "=", sub.id).execute();
  return { ok: true, summary: useStock ? `${build.name} now takes ${sub.name} from stock before making more.` : `${build.name} now always makes ${sub.name} from its parts.` };
}

export function registerSetSubAssemblySourceAction(): void {
  platform().actions.registerHandler("builds.set-sub-assembly-source", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    return setSubAssemblySource(db, (ctx.args ?? {}) as Args);
  });
}
