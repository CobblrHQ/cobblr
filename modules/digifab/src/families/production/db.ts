// The electronics production family's tables, added to the core's DigifabDB by declaration
// merging, so the core's db.ts never names a family.
import type { Generated } from "kysely";

export interface DigifabReflowProfilesTable {
  id: Generated<string>; paste_kind: string; paste_id: string; fingerprint: string;
  profile: import("@cobblr/platform-contract/reflow-profile").ReflowProfile;
  created_by: string | null; created_at: Generated<Date>;
}

declare module "../../db.js" {
  interface DigifabDB {
  digifab_reflow_profiles: DigifabReflowProfilesTable;
  digifab_test_numbering: import("./production-store.js").TestNumbering;
  digifab_test_delivery: import("./production-store.js").TestDelivery;
  digifab_test_plans: import("./production-store.js").TestPlanHead;
  digifab_test_plan_versions: import("./production-store.js").TestPlanVersion;
  digifab_test_units: import("./production-store.js").TestUnit;
  digifab_test_jigs: import("./production-store.js").TestJig;
  digifab_test_runs: import("./production-store.js").TestRun;
  digifab_test_dispositions: import("./production-store.js").TestDisposition;
  }
}
export {};
