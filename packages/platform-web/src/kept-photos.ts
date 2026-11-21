// A photo chosen for a record whose upload could not reach the server, kept on
// this device until it lands (#4115).
//
// Offline, a part's photo was dropped: a toast said the upload was cut off and
// to try again, while the banner above it said changes wait until you're back,
// and the picture the person had just taken was gone. A photo is kept here
// (IndexedDB: too big for localStorage) under the place it was meant for, sent
// again by itself when the connection is back (useKeptPhotos), and offered with
// Retry and Discard until it lands. The scan camera keeps its own shots
// (web/src/lib/keptShots.ts); this is every other photo door.
//
// Never in the way: a device with no IndexedDB, or one that refuses it (a
// private window), keeps nothing and the door works as it did.

const DB = "cobblr-kept-photos";
const STORE = "photos";

export interface KeptPhoto {
  /** This photo's own id, which is also its upload's Idempotency-Key. */
  key: string;
  /** The door it was meant for: workspace, door and record, e.g. "acme:cover:part:42". A gallery keeps several. */
  door: string;
  /** The photo's bytes. Never a Blob: WebKit refuses a Blob in IndexedDB in a
   *  private window, so an iPhone kept nothing (scan pipeline #9680). */
  bytes?: ArrayBuffer;
  /** An earlier record's photo, read as before. */
  blob?: Blob;
  name: string;
  type: string;
  lastModified: number;
  /** Its upload failed for want of a connection, so it sends itself when the connection is back. */
  lost: boolean;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) return resolve(null);
      const req = idb.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
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

/** Keeps a photo meant for `door` under its own `key`, replacing that key's.
 *  False when this device would not keep it (no IndexedDB, a private window,
 *  storage full): the door then says so, never that it is waiting. */
export async function keepPhoto(door: string, key: string, file: File, lost: boolean): Promise<boolean> {
  const base = { key, door, name: file.name, type: file.type, lastModified: file.lastModified, lost };
  // Its bytes where the browser will read them; else the file itself. Either
  // one a browser refuses (a private window, a file it will not read) leaves
  // the other to try, and only both refused is "not kept".
  const bytes = await file.arrayBuffer().catch(() => null);
  if (bytes && (await run("readwrite", (s) => s.put({ ...base, bytes } satisfies KeptPhoto))) !== null) return true;
  return (await run("readwrite", (s) => s.put({ ...base, blob: file } satisfies KeptPhoto))) !== null;
}

/** The photos kept for `door`, oldest first, as the files they were. */
export async function keptPhotos(door: string): Promise<{ key: string; file: File; lost: boolean }[]> {
  const all = ((await run("readonly", (s) => s.getAll())) ?? []) as KeptPhoto[];
  return all
    .filter((k) => k.door === door)
    .sort((a, b) => a.lastModified - b.lastModified)
    .filter((k) => k.bytes || k.blob)
    .map((k) => ({ key: k.key, file: new File([(k.bytes ?? k.blob)!], k.name, { type: k.type, lastModified: k.lastModified }), lost: k.lost }));
}

/** Every kept photo on this device, for sign-out: another person must never see or send one. */
export async function forgetKeptPhotos(): Promise<void> {
  await run("readwrite", (s) => s.clear());
}

/** It landed, or the person let it go. */
export async function forgetPhoto(key: string): Promise<void> {
  await run("readwrite", (s) => s.delete(key));
}

/** An upload that failed for want of a connection (no answer, a gateway, or an
 *  offline worker standing in for the api), as opposed to a refusal. */
export function lostConnection(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : null;
  return status === 0 || status === 502 || status === 503 || status === 504;
}
