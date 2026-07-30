// "Your app", generated (redesign B5): every workspace can press one button
// and get a member-facing app derived from what it ALREADY has — a capture
// page (scan + quick add) plus one page per tracker (add-form + saved-view
// list). Deterministic, no AI, idempotent (upserts the `your-app` slug); rerun
// it any time your trackers change. The /build "page for members" prompt now
// STARTS from something real instead of a blank textarea.
import { api, type AppBlock, type AppPage, type WorkspaceApp } from "./api";

const APP_SLUG = "your-app";

export interface GenerateResult {
  app: WorkspaceApp;
  created: boolean;
  pages: number;
}

export async function generateYourApp(slug: string): Promise<GenerateResult> {
  const instances = (await api.listInstances(slug)).items.filter(
    (i) => !i.module_name.startsWith("core-"),
  );
  const domain = instances.slice(0, 8);

  const pages: AppPage[] = [];
  // Page 1 — capture-first, always.
  pages.push({
    slug: "capture",
    title: "Capture",
    blocks: [
      {
        type: "markdown",
        body: "## Add to the workspace\nScan a barcode or snap a photo: it files itself. Or use a tracker page to add by hand.",
      } as AppBlock,
      { type: "scan" } as AppBlock,
    ],
  });

  for (const inst of domain) {
    const kind = `${inst.instance_name}:item`;
    const blocks: AppBlock[] = [];
    // The tracker's saved views become list blocks (bundles ship them).
    try {
      const views = (await api.listSavedViews(slug, kind)).items;
      for (const v of views.slice(0, 2)) {
        blocks.push({ type: "view", view_id: v.id, title: v.name } as AppBlock);
      }
    } catch {
      /* no views → form-only page */
    }
    blocks.push({ type: "form", kind, mode: "create" } as AppBlock);
    pages.push({
      slug: inst.instance_name.replace(/[^a-z0-9-]/g, "-"),
      title: inst.display_name,
      blocks,
    });
  }

  const body: Partial<WorkspaceApp> = {
    slug: APP_SLUG,
    name: "Your app",
    pages,
  };
  try {
    const existing = await api.getApp(slug, APP_SLUG);
    const app = await api.updateApp(slug, existing.slug, body);
    return { app, created: false, pages: pages.length };
  } catch {
    const app = await api.createApp(slug, body);
    return { app, created: true, pages: pages.length };
  }
}
