// Read the pattern (projects:read-pattern): the handler its manifest entry names. Wired in ./index.ts.
// The project page's own reads: pasted materials text (POST /:id/extract-pattern),
// the attached PDF again (POST /:id/extract-pattern-file), or its photo pulled
// out again (POST /:id/extract-pattern-images). Each is a model call the page
// makes the same way.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import { readPastedMaterials, readPatternNeedsState } from "./pattern-needs.js";
import { latestPatternFileId, runPatternPhoto } from "./pattern-photo.js";
import { readPatternNow } from "./projects.js";

export function registerReadPatternAction(): void {
  platform().actions.registerHandler("projects.read-pattern", async (ctx) => {
    const project = requireActionEntity(ctx);
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const text = typeof a.text === "string" ? a.text.trim().slice(0, 20_000) : "";
    if (text) {
      const r = await readPastedMaterials(ctx.orgId, project.id, text, ctx.userId);
      if ("error" in r) return { ok: false, error: `Those materials could not be read: ${r.error}` };
      const state = await readPatternNeedsState(ctx.orgId, project.id, ctx.userId);
      return { ok: true, summary: `Read ${state.items.length} need${state.items.length === 1 ? "" : "s"} from the text.`, data: { needs: state.items.length } };
    }
    const fileId = (typeof a.file_id === "string" && a.file_id.trim()) || (await latestPatternFileId(ctx.orgId, project.id));
    if (!fileId) return { ok: false, error: "This project has no pattern PDF attached; paste its materials as text instead." };
    if (a.photo === true || a.photo === "true") {
      const st = await runPatternPhoto(ctx.orgId, project.id, fileId, { force: true });
      if (st.error) return { ok: false, error: `Couldn't read images from that PDF (${st.error}).` };
      return { ok: true, summary: st.extracted ? "Pulled the pattern's photo out again." : "No usable photos were embedded in that PDF.", data: { extracted: st.extracted } };
    }
    const state = await readPatternNow(ctx.orgId, project.id, fileId, ctx.userId);
    return { ok: true, summary: `Read the pattern again: ${state.items.length} need${state.items.length === 1 ? "" : "s"}.`, data: { needs: state.items.length, status: state.read.status } };
  });
}
