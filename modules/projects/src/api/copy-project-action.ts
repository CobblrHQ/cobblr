// Do it again from this project (projects:copy-project): the handler its manifest entry names. Wired in ./index.ts.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { ProjectsDB } from "../db.js";
import { copyProject } from "./copy-project.js";

export function registerCopyProjectAction(): void {
  platform().actions.registerHandler("projects.copy-project", async (ctx) => {
    const record = requireActionEntity(ctx);
    const name = typeof ctx.args?.name === "string" ? ctx.args.name.trim() : "";
    if (!name) return { ok: false, error: "Say what to call the new project." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<ProjectsDB>;
    const made = await copyProject(db, ctx.orgId, ctx.userId ?? null, record.id, name.slice(0, 200));
    if (!made) return { ok: false, error: "That project is not here any more." };
    return { ok: true, result: { project_id: made.project.id, tasks: made.tasks }, summary: `Started ${made.project.name} with its ${made.tasks} task${made.tasks === 1 ? "" : "s"}.` };
  });
}
