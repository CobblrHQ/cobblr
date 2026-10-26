// A module's contributed fields reach every workspace that has it on.
//
// BORN WITH: enableModuleForOrg (enabling a module writes its contributed field defs through applyContributedFieldDefs; a collection made later gets them from createInstance)
//
// PERMANENT RECONCILE. A module declares fields on its own kinds, or on
// other modules' kinds, in `contributes.fieldDefs`, and enabling the module
// writes them into the workspace (cobblr_meta.module_field_defs). Enabling
// happens once. A field a module adds in a later release never reached a
// workspace that had already enabled it: the task's `assignee` and the
// asset's `assigned_to` existed on a fresh signup and nowhere else, so the
// same page read differently by the age of the workspace.
//
// Every boot, each registered module's contributed defs are written, in one
// statement per def, into every workspace with that module on that lacks
// them, on the kind and on each named collection of it (`tools:item` for a
// collection of assets). A def that says whether its list learns brings the
// rows it made earlier into line with that, so the answer does not depend on
// when the workspace enabled the module (#4516). A declared semantic role
// fills a missing role on module-owned rows too, preserving explicit choices.
// Cost on a current instance: small metadata reads, one INSERT per contributed
// def that adds no rows, and no-op UPDATEs for its declared properties. cobblr_meta only:
// it opens no tenant pool.

import { meta } from "../db/meta.js";
import { list } from "../modules/registry.js";
import { applyContributedFieldDefs } from "./contributed-fields.js";
import { notePassFailure } from "./pass-failures.js";

type ModuleWithFields = { name: string; contributes?: { fieldDefs?: Parameters<typeof applyContributedFieldDefs>[1] } };

/** `from` is every registered module; a test passes its own to add a field a
 *  module did not have when the workspace enabled it. */
export async function reconcileContributedFields(from: readonly ModuleWithFields[] = list()): Promise<{ added: number; modules: string[]; failed: Array<{ module: string; error: string }> }> {
  let added = 0;
  const modules: string[] = [];
  // One module failing never stops boot (each is caught), but the caller is
  // told which and why: a test that saw "the field did not arrive" used to
  // have no way to tell a skipped workspace from a write that failed (#4937).
  const failed: Array<{ module: string; error: string }> = [];
  for (const m of from) {
    const defs = m.contributes?.fieldDefs ?? [];
    if (defs.length === 0) continue;
    try {
      const rows = await meta.selectFrom("org_modules").select("org_id").where("module_name", "=", m.name).execute();
      const n = await applyContributedFieldDefs(m.name, defs, rows.map((r) => r.org_id));
      if (n > 0) {
        added += n;
        modules.push(m.name);
        console.log(`[reconcile] contributed fields: ${m.name} added ${n} field def(s)`);
      }
    } catch (err) {
      notePassFailure("reconcileContributedFields", m.name, err);
      console.error(`[reconcile] contributed fields: ${m.name} failed`, err);
      failed.push({ module: m.name, error: (err as Error).message });
    }
  }
  return { added, modules, failed };
}
