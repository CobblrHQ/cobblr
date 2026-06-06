// Real-CUPS smoke test — the leg that can't run in CI (no CUPS reachable from
// Docker-on-Mac). Run from the host, on the LAN with the printer:
//
//   CUPS_URL=http://printhost.lan:631 CUPS_QUEUE=Rollo \
//     npx tsx modules/core-print/src/scripts/smoke-cups.ts [path/to/test.pdf]
//
// With no file arg it sends a tiny text document. Prints the resolved job id +
// state. This exercises the exact CupsDriver path the API uses.

import { readFileSync } from "node:fs";
import { CupsDriver } from "../drivers/cups.js";

const baseUrl = process.env.CUPS_URL;
const queue = process.env.CUPS_QUEUE;
if (!baseUrl || !queue) {
  console.error("set CUPS_URL and CUPS_QUEUE");
  process.exit(2);
}

const driver = new CupsDriver({
  baseUrl,
  queue,
  username: process.env.CUPS_USER,
  password: process.env.CUPS_PASS,
});

const path = process.argv[2];
const doc = path
  ? { bytes: new Uint8Array(readFileSync(path)), filename: path.split("/").pop() ?? "doc", contentType: "application/pdf" }
  : { bytes: new Uint8Array(Buffer.from("cobblr core-print smoke\n")), filename: "smoke.txt", contentType: "text/plain" };

console.log(`testing ${baseUrl} queue=${queue} …`);
console.log("test:", await driver.test());
console.log("submitting", doc.filename, `(${doc.bytes.length} bytes) …`);
console.log("job:", await driver.print(doc, { jobName: "cobblr-smoke" }));
