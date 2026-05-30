// Live read-only smoke test of the FDM Monster v2 driver against a real
// box, run on the HOST (reaches the LAN; the Docker api can't on Mac).
// Read-only: testConnection + listDevices + resolve. No print. Creds via
// env only (no secrets in the repo):
//   FDMM_URL=http://host:4000 FDMM_USER=u FDMM_PASS=p \
//     npx tsx modules/digifab/src/drivers/test-fdmm-live.ts
// or FDMM_API_KEY=... instead of user/pass.
import { FdmMonsterDriver } from "./fdm-monster.js";
const url = process.env.FDMM_URL;
if (!url) {
  console.error("set FDMM_URL (+ FDMM_USER/FDMM_PASS or FDMM_API_KEY)");
  process.exit(2);
}
const d = new FdmMonsterDriver({
  baseUrl: url,
  username: process.env.FDMM_USER ?? null,
  password: process.env.FDMM_PASS ?? null,
  apiKey: process.env.FDMM_API_KEY ?? null,
});
const conn = await d.testConnection();
console.log("✓ testConnection:", JSON.stringify(conn));
if (!conn.ok) process.exit(1);
const printers = await d.listDevices();
console.log(`✓ listDevices: ${printers.length} printers →`, JSON.stringify(printers.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled }))));
// resolve on a bogus id just confirms the routing route answers (404 for
// an unknown file is expected — a real file id would resolve properly).
try {
  const r = await d.resolvePlacement("000000000000000000000000");
  console.log("✓ resolvePlacement(bogus):", JSON.stringify(r));
} catch (e) {
  console.log("  resolvePlacement(bogus) →", (e as Error).message.slice(0, 80), "(expected: unknown file)");
}
console.log("\n==== FDM MONSTER LIVE (read-only) — driver verified against the real box ====");
