// Grab a single JPEG frame from a camera URL — a snapshot endpoint that returns
// one JPEG, OR an MJPEG stream (we read until the first complete JPEG). For
// embedding a live webcam snapshot in a notification (the Discord print-update
// post). Best-effort: a hard timeout, a size cap, JPEG-only.
//
// Reachability: the server must be able to REACH the camera, so a LAN webcam
// only works from a self-hosted / same-network Cobblr (a cloud instance can't
// dial a home camera — the same NAT boundary the edge tunnel addresses).
// SSRF: http/https only + timeout + size cap; the URL is OPERATOR-set (the
// printer's camera URL, owner/admin-only), not arbitrary end-user input.

const TIMEOUT_MS = 4000;
const MAX_BYTES = 5 * 1024 * 1024;

function extractJpeg(buf: Buffer): Buffer | null {
  const soi = buf.indexOf(Buffer.from([0xff, 0xd8])); // start-of-image
  if (soi < 0) return null;
  const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2); // end-of-image
  if (eoi < 0) return null;
  return buf.subarray(soi, eoi + 2);
}

export async function grabJpegFrame(url: string): Promise<Buffer | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "cobblr-notifications/1" } });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    let buf = Buffer.alloc(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf = Buffer.concat([buf, Buffer.from(value)]);
      const jpeg = extractJpeg(buf);
      if (jpeg) {
        void reader.cancel().catch(() => {});
        return jpeg;
      }
      if (done || buf.length >= MAX_BYTES) break;
    }
    return extractJpeg(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
