// Standalone driver test — no platform, no DB, no hardware.
// Run: npx tsx modules/digifab/src/drivers/test-drivers.ts
import { MockDriver } from "./mock.js";
import { FdmMonsterDriver } from "./fdm-monster.js";

const checks: { l: string; ok: boolean }[] = [];
const note = (l: string, ok: boolean, d = "") => { checks.push({ l, ok }); console.log(`${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };

const d = new MockDriver();

// 1. connection + capabilities
const conn = await d.testConnection();
note("testConnection ok + routing capability", conn.ok && conn.capabilities.routing);

// 2. list printers (for the machine↔printer mapping)
const printers = await d.listDevices();
note("listDevices returns the fleet", printers.length === 2 && printers.some((p) => p.name === "Voron 2.4"));

// 3. upload + routing resolve (the approve-and-send preview)
const upPrinter = await d.uploadFile(new Uint8Array([1, 2, 3]), "bracket@Voron 2.4.gcode");
const rPrinter = await d.resolvePlacement(upPrinter.fileId);
note("resolve a printer-targeted file → kind=printer, 1 printer", rPrinter.kind === "printer" && rPrinter.deviceIds.length === 1 && rPrinter.matchedName === "Voron 2.4");

const upTag = await d.uploadFile(new Uint8Array([1]), "batch#pla.gcode");
const rTag = await d.resolvePlacement(upTag.fileId);
note("resolve a tag-targeted file (2 printers) → kind=tag, ambiguous for auto-queue", rTag.kind === "tag" && rTag.deviceIds.length === 2);

// 4. explicit-printer submit → queued, then poll to completion
const up = await d.uploadFile(new Uint8Array([9]), "thing.gcode");
const sub = await d.submitJob({ fileId: up.fileId, deviceId: "p1" });
note("submitJob(explicit printer) → queued with a jobId", sub.queued && sub.status === "queued" && !!sub.jobId);

const seen: string[] = [];
let st = await d.getJobStatus(sub.jobId!);
for (let i = 0; i < 6 && st.state !== "completed"; i++) { seen.push(st.state); st = await d.getJobStatus(sub.jobId!); }
seen.push(st.state);
note("poll walks queued/printing → completed", st.state === "completed" && seen.includes("printing"), seen.join("→"));

// 5. routed submit by tag: 2 printers → awaiting-assignment; 1 → queued
const subTagMulti = await d.submitJob({ fileId: upTag.fileId, tag: "pla" });
note("submitJob(tag, 2 printers) → awaiting-assignment (no auto-pick)", !subTagMulti.queued && subTagMulti.status === "awaiting-assignment");
const subTagOne = await d.submitJob({ fileId: up.fileId, tag: "corexy" });
note("submitJob(tag, 1 printer) → queued", subTagOne.queued && subTagOne.deviceId === "p1");

// 6. failure path
const subF = await d.submitJob({ fileId: up.fileId, deviceId: "p2" });
d.failJob(subF.jobId!);
const sf = await d.getJobStatus(subF.jobId!);
note("a failed job reports state=failed", sf.state === "failed");

// 7. outbound enable/disable
await d.setDeviceEnabled("p1", false);
note("setDeviceEnabled toggles the printer", (await d.listDevices()).find((p) => p.id === "p1")!.enabled === false);

// 8. FDM Monster driver constructs cleanly (live calls are the dev-instance test)
const fdm = new FdmMonsterDriver({ baseUrl: "http://example.invalid/", apiKey: "k" });
note("FdmMonsterDriver constructs without error", fdm instanceof FdmMonsterDriver);

const fail = checks.filter((c) => !c.ok);
console.log(`\n==== FARM DRIVERS — ${checks.length - fail.length}/${checks.length} ====`);
if (fail.length) { console.log("FAILED:", fail.map((c) => c.l).join(" | ")); process.exit(1); }
