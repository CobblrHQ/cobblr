// One camera frame from a camera's own address on the shop network: a snapshot URL that answers a JPEG or
// PNG, or an MJPEG stream URL, from which the first whole JPEG is taken. The server fetches it so a page
// served over https can show a camera that only speaks plain http on the LAN; the address is held to the
// same guard as a machine's, and the read is bounded in time and size.
import { machineFetch } from "./drivers/machine-fetch.js";
import type { MachineDriver } from "./drivers/types.js";

const LIMIT = 4 * 1024 * 1024;
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);

export async function frameFromAddress(url: string, timeoutMs = 6000, headers: Record<string, string> = {}): Promise<{ bytes: Buffer; type: string } | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await machineFetch(url, { headers, signal: controller.signal, redirect: "error" });
    if (!res.ok || !res.body) return null;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const stream = type.startsWith("multipart/");
    if (!stream && !/^image\/(jpeg|png)/.test(type)) return null;
    const reader = res.body.getReader();
    let got = Buffer.alloc(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (value) got = Buffer.concat([got, Buffer.from(value)]);
      if (got.length > LIMIT) { await reader.cancel().catch(() => {}); return null; }
      if (stream) {
        const start = got.indexOf(SOI), end = start < 0 ? -1 : got.indexOf(EOI, start + 2);
        if (end > 0) { await reader.cancel().catch(() => {}); return { bytes: got.subarray(start, end + 2), type: "image/jpeg" }; }
      }
      if (done) break;
    }
    return stream || got.length === 0 ? null : { bytes: got, type: type.startsWith("image/png") ? "image/png" : "image/jpeg" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Where a machine's camera frame comes from: a Bambu's own camera over the LAN, then an address someone
 *  typed for it, then the camera its manager names. A typed address wins over the manager's, so a person
 *  can always point the card at the camera they mean; the manager is not even asked then. */
export async function cameraSourceFor(
  lan: MachineDriver | null,
  typed: string | null | undefined,
  manager: () => Promise<MachineDriver | null>,
): Promise<{ driver: MachineDriver } | { address: string } | null> {
  if (lan?.getCameraFrame) return { driver: lan };
  if (typed) return { address: typed };
  const driver = await manager();
  return driver?.getCameraFrame ? { driver } : null;
}
