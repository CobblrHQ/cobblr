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
// Never in the way: a device with no IndexedDB, or one that refuses it (a
// private window), keeps nothing and the camera works as it did.

import { newCapture, type Capture, type CaptureStamps } from "./scanCapture";

const DB = "cobblr-kept-shots";
const STORE = "shots";

interface KeptShot {
  id: string;
  slug: string;
  takenAt: number;
  blob: Blob;
  stamps: CaptureStamps;
  fileId?: string;
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

/** Keep a capture whose save failed, with what its tries settled. */
export async function keepShot(slug: string, c: Capture): Promise<void> {
  const kept: KeptShot = { id: c.id, slug, takenAt: c.file.lastModified, blob: c.file, stamps: c.stamps, ...(c.fileId ? { fileId: c.fileId } : {}), ...(c.batchId !== undefined ? { batchId: c.batchId } : {}) };
  await run("readwrite", (s) => s.put(kept));
}

/** It landed, or the person let it go. */
export async function forgetShot(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}

/** The captures kept for this workspace, oldest first, as the captures they were. */
export async function keptShots(slug: string): Promise<Capture[]> {
  const all = ((await run("readonly", (s) => s.getAll())) ?? []) as KeptShot[];
  return all
    .filter((k) => k.slug === slug)
    .sort((a, b) => a.takenAt - b.takenAt)
    .map((k) => {
      const c = newCapture(k.blob, k.stamps, k.takenAt, k.id);
      if (k.fileId) c.fileId = k.fileId;
      if (k.batchId !== undefined) c.batchId = k.batchId;
      return c;
    });
}
