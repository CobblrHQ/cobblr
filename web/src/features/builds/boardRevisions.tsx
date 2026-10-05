import { BoardProjectPanel as Panel, BuildsApi } from "@cobblr/builds/ui";
import { getToken } from "../../lib/api";
import type { EntityDetailPanelCtx } from "@cobblr/platform-web";
export function BoardProjectPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  return <Panel ctx={ctx} api={new BuildsApi(ctx.slug, getToken)} />;
}
