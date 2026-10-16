// Files through a bridge: Cobblr's end of the blob side-channel.
//
// A relayed call whose body or answer is a file carries only a blob id; the
// bytes travel on GET/HEAD/PUT <relay>/blobs/<id>, streamed on both ends:
//
//   down  Cobblr offers a file it already holds (a path on its disk, nothing
//         copied). The bridge fetches it, with Range to resume, and checks it
//         against the sha256 in the relayed item before handing it on.
//   up    Cobblr expects a file. The bridge delivers it with Content-Range,
//         resuming from what HEAD says Cobblr holds; when the last byte lands
//         Cobblr hashes what it holds and refuses it (422) unless it matches
//         the sha256 the bridge sent.
//
// Neither end holds a file in memory, and no 1 MB or 20 MB body limit applies:
// the route is outside every JSON parser. Only the bridge whose channel a blob
// belongs to may read or write it.
//
// The spool is COBBLR_EDGE_BLOB_DIR, else the system temp directory: files in
// transit are minutes old and are not backed up. Two api processes that do
// not share that directory cannot hand a transfer between them; a bridge that
// lands on the other one is told the file is gone and the call fails in words.

import { productName } from "./product-name.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, statSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { meta } from "../db/meta.js";

/** How long a file may sit in transit before it is removed. */
const BLOB_TTL_MS = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function blobDir(): string {
  const dir = process.env.COBBLR_EDGE_BLOB_DIR || join(tmpdir(), "cobblr-edge-blobs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function drop(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export async function sha256OfFile(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Remove expired transfers: their rows, and the spool files Cobblr wrote.
 *  A "down" row points at a file Cobblr holds for its own reasons, never removed. */
async function reapExpired(): Promise<void> {
  const gone = await meta
    .deleteFrom("edge_blobs")
    .where("expires_at", "<", new Date())
    .returning(["direction", "path"])
    .execute();
  for (const g of gone) if (g.direction === "up") drop(g.path);
}

/** Offer a file Cobblr holds to a bridge. */
export async function blobOffer(key: string, file: { path: string; sha256: string; size: number }): Promise<string> {
  await reapExpired().catch(() => {});
  const id = randomUUID();
  await meta
    .insertInto("edge_blobs")
    .values({
      id,
      channel_key: key,
      direction: "down",
      path: file.path,
      sha256: file.sha256.toLowerCase(),
      size: file.size,
      received: file.size,
      complete: true,
      expires_at: new Date(Date.now() + BLOB_TTL_MS),
    })
    .execute();
  return id;
}

/** Make room for a file a bridge will deliver. */
export async function blobExpect(key: string): Promise<string> {
  await reapExpired().catch(() => {});
  const id = randomUUID();
  await meta
    .insertInto("edge_blobs")
    .values({ id, channel_key: key, direction: "up", path: join(blobDir(), `${id}.up`), expires_at: new Date(Date.now() + BLOB_TTL_MS) })
    .execute();
  return id;
}

/** A delivered file, once whole and checked; null while it is not. */
export async function blobReceived(key: string, id: string): Promise<{ path: string; sha256: string; size: number } | null> {
  const row = await meta
    .selectFrom("edge_blobs")
    .select(["path", "sha256", "size", "complete"])
    .where("id", "=", id)
    .where("channel_key", "=", key)
    .where("direction", "=", "up")
    .executeTakeFirst();
  if (!row?.complete || !row.sha256) return null;
  return { path: row.path, sha256: row.sha256, size: Number(row.size) };
}

/** Done with a transfer: drop its row, and its spool file if Cobblr wrote one. */
export async function blobRelease(id: string): Promise<void> {
  const row = await meta.deleteFrom("edge_blobs").where("id", "=", id).returning(["direction", "path"]).executeTakeFirst();
  if (row?.direction === "up") drop(row.path);
}

function end(res: ServerResponse, status: number, message?: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { ...(message ? { "content-type": "application/json" } : {}), ...headers });
  res.end(message ? JSON.stringify({ error: { code: "edge_blob", message } }) : undefined);
}

/** GET, HEAD and PUT <relay>/blobs/:id for the bridge whose channel is `key`.
 *  One implementation for every relay door. */
export async function serveBlob(key: string, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!UUID.test(id)) return end(res, 404, "No such file.");
  const row = await meta
    .selectFrom("edge_blobs")
    .selectAll()
    .where("id", "=", id)
    .where("channel_key", "=", key)
    .where("expires_at", ">", new Date())
    .executeTakeFirst();
  if (!row) return end(res, 404, `${productName()} is not holding a file by that id for this bridge (it may have expired).`);
  const method = (req.method ?? "GET").toUpperCase();

  if (row.direction === "down") {
    if (method !== "GET" && method !== "HEAD") return end(res, 405, `This file is ${productName()}'s to send, not the bridge's.`, { allow: "GET, HEAD" });
    const size = sizeOf(row.path);
    if (size !== Number(row.size)) return end(res, 410, `The file ${productName()} offered is no longer there.`);
    const m = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ""));
    const start = m ? Number(m[1]) : 0;
    if (start > size) return end(res, 416, undefined, { "content-range": `bytes */${size}` });
    res.writeHead(m ? 206 : 200, {
      "content-type": "application/octet-stream",
      "content-length": String(size - start),
      "accept-ranges": "bytes",
      "x-sha256": String(row.sha256),
      ...(m ? { "content-range": `bytes ${start}-${Math.max(start, size - 1)}/${size}` } : {}),
    });
    if (method === "HEAD" || size === start) return void res.end();
    await pipeline(createReadStream(row.path, { start }), res).catch(() => res.destroy());
    return;
  }

  // up
  const received = sizeOf(row.path);
  if (method === "HEAD") {
    return end(res, 200, undefined, { "x-received": String(received), "x-complete": row.complete ? "1" : "0" });
  }
  if (method !== "PUT") return end(res, 405, "This file is the bridge's to deliver.", { allow: "HEAD, PUT" });
  if (row.complete) return end(res, 409, `${productName()} already holds this file whole.`, { "x-received": String(received) });
  const cr = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(String(req.headers["content-range"] ?? ""));
  const sha = String(req.headers["x-sha256"] ?? "").toLowerCase();
  if (!cr || !/^[0-9a-f]{64}$/.test(sha)) return end(res, 400, "A delivered file needs Content-Range and x-sha256.");
  const start = cr[1] !== undefined ? Number(cr[1]) : 0;
  const total = Number(cr[3]);
  if (start !== received) return end(res, 409, `${productName()} holds ${received} bytes of this file; send from there.`, { "x-received": String(received) });
  try {
    await pipeline(req, createWriteStream(row.path, { flags: start > 0 ? "a" : "w" }));
  } catch {
    // The link dropped part way; what landed stays for the resume.
    return end(res, 400, `The delivery broke off; send the rest from where ${productName()}'s HEAD says.`);
  }
  const now = sizeOf(row.path);
  await meta.updateTable("edge_blobs").set({ received: now }).where("id", "=", id).execute();
  if (now < total) return end(res, 202, undefined, { "x-received": String(now) });
  if (now > total || (await sha256OfFile(row.path)) !== sha) {
    drop(row.path);
    await meta.updateTable("edge_blobs").set({ received: 0 }).where("id", "=", id).execute();
    return end(res, 422, `The file arrived different from what the bridge sent (its sha256 does not match), so ${productName()} refused it.`);
  }
  await meta.updateTable("edge_blobs").set({ complete: true, sha256: sha, size: now }).where("id", "=", id).execute();
  return end(res, 200, undefined, { "x-received": String(now) });
}
