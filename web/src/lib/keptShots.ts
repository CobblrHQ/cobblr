// Shots whose save failed, kept on this device until they land (#4115).
//
// The camera kept a failed shot for its retry tap in the page's memory only:
// a reload, the phone closing the tab, or a second failed shot replacing the
// first, and the picture was gone, though the drawer had said "still here".
// So each failed capture is kept here (IndexedDB: a photo is too big for
// localStorage) until it lands or the person discards it, and the camera
// offers them again when it opens. A kept capture is the same capture, with
// the same id, so its retry carries the same keys (lib/scanCapture.ts).
//
// A picture added at the desk (useScanIntake) is kept here the same way
// (#9678), marked "desk" with its own name and type, and offered again as a
// failed card in the inbox, never by the camera.
//
// Never in the way: a device with no IndexedDB, or one that refuses it
// outright, keeps nothing and the camera works as it did.

import { newCapture, pickedCapture, type Capture, type CaptureStamps } from "./scanCapture";

const DB = "cobblr-kept-shots";
const STORE = "shots";

interface KeptShot {
  id: string;
  slug: string;
  takenAt: number;
  /** The picture's bytes. WebKit refuses a Blob in IndexedDB in a session it
   *  keeps nothing for (a private window, and every Playwright WebKit run), so
   *  the picture was never kept on an iPhone there; bytes it keeps (#9678). */
  bytes?: ArrayBuffer;
  /** How shots were kept before #9678. */
  blob?: Blob;
  stamps: CaptureStamps | null;
  /** Absent on a camera shot (all kept before #9678 were). */
  door?: "desk";
  name?: string;
  type?: string;
  code?: string | null;
  fileId?: string;
  /** Its save failed for want of a connection: sent by itself when the
   *  connection is back, after a reload too (#4115). */
  lost?: boolean;
  batchId?: string | null;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) return resolve(null);
      const req = idb.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(STORE, mode);
      const req = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result ?? null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Landed or let go since a keep that waits for the connection was armed. */
const forgotten = new Set<string>();

/** Keep a capture whose save failed, with what its tries settled.
 *
 *  Its bytes are kept when they can be read. When they cannot (a picked file
 *  can be unreadable while the device is offline), the picture itself is kept
 *  instead, and if the store refuses that too, it tries again when the
 *  connection is back: a failed shot is never dropped for want of a read. */
export async function keepShot(slug: string, c: Capture, lost = false): Promise<void> {
  const kept: KeptShot = {
    id: c.id,
    slug,
    takenAt: c.file.lastModified,
    type: c.file.type,
    stamps: c.stamps,
    ...(c.door ? { door: c.door, name: c.file.name } : {}),
    ...(lost ? { lost: true } : {}),
    ...(c.code !== undefined ? { code: c.code } : {}),
    ...(c.fileId ? { fileId: c.fileId } : {}),
    ...(c.batchId !== undefined ? { batchId: c.batchId } : {}),
  };
  const bytes = await c.file.arrayBuffer().catch(() => null);
  if (bytes) {
    await run("readwrite", (s) => s.put({ ...kept, bytes }));
    return;
  }
  const stored = await run("readwrite", (s) => s.put({ ...kept, blob: c.file }));
  if (stored !== null) return;
  const later = (globalThis as { addEventListener?: typeof addEventListener }).addEventListener;
  forgotten.delete(c.id);
  later?.("online", () => void (forgotten.has(c.id) ? undefined : keepShot(slug, c, lost)), { once: true });
}

/** It landed, or the person let it go. */
export async function forgetShot(id: string): Promise<void> {
  forgotten.add(id);
  await run("readwrite", (s) => s.delete(id));
}

/** The captures kept for this workspace through one door, oldest first, as
 *  the captures they were. */
export async function keptShots(slug: string, door: "camera" | "desk" = "camera"): Promise<{ capture: Capture; lost: boolean }[]> {
  const all = ((await run("readonly", (s) => s.getAll())) ?? []) as KeptShot[];
  return all
    .filter((k) => k.slug === slug && (k.door ?? "camera") === door)
    .sort((a, b) => a.takenAt - b.takenAt)
    .flatMap((k) => {
      const blob = k.bytes ? new Blob([k.bytes], { type: k.type || "image/jpeg" }) : k.blob;
      if (!blob) return [];
      const c =
        k.door === "desk"
          ? pickedCapture(new File([blob], k.name ?? "picture", { type: blob.type, lastModified: k.takenAt }), k.id)
          : newCapture(blob, k.stamps, k.takenAt, k.id);
      if (k.code !== undefined) c.code = k.code;
      if (k.fileId) c.fileId = k.fileId;
      if (k.batchId !== undefined) c.batchId = k.batchId;
      return [{ capture: c, lost: k.lost === true }];
    });
}
