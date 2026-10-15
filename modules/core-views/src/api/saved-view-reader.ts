// The views a wire can be narrowed to (#6070): a shared view, read for the
// wire engine through the contract (saved-view-reader.ts), so the kernel
// never reads this module's table. A member's private view answers nothing.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerSavedViewReader } from "@cobblr/platform-contract/saved-view-reader";
import type { CoreViewsDB } from "../db.js";

export function registerWireViewReader(): void {
  registerSavedViewReader(async (orgId, viewId) => {
    if (!/^[0-9a-f-]{36}$/i.test(viewId)) return null;
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreViewsDB>;
    const view = await db
      .selectFrom("core_views_views")
      .select(["entity_kind", "config", "name"])
      .where("id", "=", viewId)
      .where("owner_user_id", "is", null)
      .executeTakeFirst();
    return view ? { entityKind: view.entity_kind, config: (view.config ?? {}) as Record<string, unknown>, name: view.name } : null;
  });
}
