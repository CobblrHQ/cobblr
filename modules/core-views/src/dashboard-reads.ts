// The views pinned to the dashboard and each one's first page, by the rule the
// page draws them by (choosePinnedViews), for the one-request dashboard
// snapshot (#6563). A table folded into a family is left out on the page and
// read here anyway: one unread answer costs less than a second request.
import { registerDashboardRead } from "@cobblr/platform-contract/dashboard-reads";
import { choosePinnedViews } from "@cobblr/platform-contract/dashboard-pinned";

interface SavedViewLite {
  id: string;
  entity_kind: string;
  pinned?: boolean | null;
  owner_user_id?: string | null;
}

export function registerViewsDashboardReads(): void {
  registerDashboardRead({
    id: "core-views.pinned",
    module: "core-views",
    paths: async ({ slug, today, read }) => {
      const views = (await read<{ items: SavedViewLite[] }>(`/orgs/${slug}/modules/core-views/views`))?.items ?? [];
      return [`/orgs/${slug}/modules/core-views/views`, ...choosePinnedViews(views).map((v) => `/orgs/${slug}/modules/core-views/views/${v.id}/data?today=${today}`)];
    },
  });
}
