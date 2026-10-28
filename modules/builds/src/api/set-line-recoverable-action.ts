// Comes back if a print is scrapped (builds:set-line-recoverable): the handler its manifest entry names. Wired in ./index.ts.
// The same switch as a part line's toggle on the build page. A line is used up by default: a print melts
// its filament whatever the verdict (#8758); a brass insert or a bracket kit that was never fitted can come back.
import { platform } from "@cobblr/platform-contract";
import { withArticle } from "@cobblr/platform-contract/plural";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";

type Args = { build?: unknown; part?: unknown; recoverable?: unknown };
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function setLineRecoverable(db: Kysely<BuildsDB>, orgId: string, args: Args): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const recoverable = args.recoverable === true || args.recoverable === "true" ? true : args.recoverable === false || args.recoverable === "false" ? false : null;
  if (recoverable == null) return { ok: false, error: "Say whether this part comes back to stock when a print is scrapped (yes) or stays used up (no)." };
  const said = text(args.build);
  const builds = await db.selectFrom("builds_builds").select(["id", "name"]).execute();
  const hits = builds.filter((b) => b.id === said || b.name.toLowerCase() === said.toLowerCase());
  if (hits.length !== 1) return { ok: false, error: hits.length ? `More than one build is called ${said}.` : `No build is called ${said}.` };
  const build = hits[0]!;
  const lines = await db.selectFrom("builds_components").select(["id", "part_id"]).where("build_id", "=", build.id).where("part_id", "is not", null).execute();
  const named = await Promise.all(lines.map(async (l) => ({ ...l, name: (await platform().entities.lookup(orgId, "inventory:part", l.part_id!).catch(() => null))?.title ?? "" })));
  const part = text(args.part);
  const line = named.filter((l) => l.part_id === part || l.name.toLowerCase() === part.toLowerCase());
  if (line.length !== 1) {
    const names = named.map((l) => l.name).filter(Boolean).slice(0, 8);
    return { ok: false, error: `${part} is not a part line of ${build.name}.${names.length ? ` Its parts are: ${names.join(", ")}.` : " It has none."}` };
  }
  await db.updateTable("builds_components").set({ recoverable }).where("id", "=", line[0]!.id).execute();
  const name = line[0]!.name || "That part";
  return { ok: true, summary: recoverable ? `${name} goes back to stock when ${withArticle(build.name)} print is scrapped.` : `${name} stays used up when ${withArticle(build.name)} print is scrapped.` };
}

export function registerSetLineRecoverableAction(): void {
  platform().actions.registerHandler("builds.set-line-recoverable", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    return setLineRecoverable(db, ctx.orgId, (ctx.args ?? {}) as Args);
  });
}
