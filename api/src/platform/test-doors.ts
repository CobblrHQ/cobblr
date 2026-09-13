// Test doors: controls a reviewer with no camera or printer uses to feed the
// product's real paths (the camera page's "scan an image file", #2891). They
// exist on a deployment whose job is to be tested, and NEVER on a hosted
// production surface, whatever the environment says otherwise.
//
// The decision is one function so the web never guesses from the deploy
// label: /healthz reports `test_doors`, and the pages read that.

/** Labels a hosted production surface runs under. canary holds real
 *  production data, so it counts as production here. */
const PRODUCTION = new Set(["production", "prod", "canary"]);

/** Labels that are test surfaces by nature. */
const TEST_SURFACES = new Set(["staging", "development", "dev", "test"]);

/**
 * Are test doors open on this deployment?
 *
 * `override` is COBBLR_TEST_DOORS: "1"/"true" opens them on a box with an
 * unusual label; "0"/"false" closes them on a staging that wants the product
 * exactly as shipped. Neither reaches past the production floor: a
 * production or canary label is closed whatever the override says.
 */
export function testDoorsEnabled(deployEnv: string | undefined, override: string | undefined): boolean {
  const label = (deployEnv ?? "").trim().toLowerCase();
  if (PRODUCTION.has(label)) return false;
  const o = (override ?? "").trim().toLowerCase();
  if (o === "0" || o === "false" || o === "off") return false;
  if (o === "1" || o === "true" || o === "on") return true;
  return TEST_SURFACES.has(label);
}
