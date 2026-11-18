// One shutter capture, from the moment it is taken until it is in the inbox.
//
// A capture whose save failed is kept for a retry tap (garage corners and
// elevators drop POSTs). The retry rebuilt the picture as a new File named by
// the time it was retried, so its upload looked like a new upload and carried
// a new Idempotency-Key. When the first try had in fact landed and only its
// answer was lost, the retry stored the picture again and made a second inbox
// row for one thing (#4115).
//
// So a capture has an id from the moment it is taken, and every write it
// makes is keyed from that id, never from its File or the time: the upload
// and the scan are the same writes on every try, and the server answers a
// repeat from the first (api/src/platform/request-replays.ts). What a try
// already settled (the stored picture, the batch) is kept on the capture, so
// a retry sends the same scan body the first try sent.

import type { ScanPurpose } from "@cobblr/platform-contract/scan-triage";

export interface CaptureStamps {
  purpose: ScanPurpose;
  areaName: string | null;
  areaId: string | null;
  container: { kind: string; id: string } | null;
}

export interface Capture {
  /** Given when the picture is taken; every write of this capture is keyed by it. */
  readonly id: string;
  /** Made once, so its name and time never change between tries. */
  readonly file: File;
  readonly stamps: CaptureStamps;
  /** The stored picture, once an upload of it has landed. */
  fileId?: string;
  /** The batch it was filed under, once asked (null: none could be made). */
  batchId?: string | null;
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

/** A capture of `blob`, taken now where `stamps` say. */
export function newCapture(blob: Blob, stamps: CaptureStamps, now = Date.now(), id = newId()): Capture {
  return { id, file: new File([blob], `scan-${now}.jpg`, { type: "image/jpeg", lastModified: now }), stamps };
}

/** The keys a capture's writes carry: the same on every try. */
export function captureKeys(c: Pick<Capture, "id">): { upload: string; scan: string } {
  return { upload: `capture:${c.id}:upload`, scan: `capture:${c.id}:scan` };
}

/** The scan a capture makes, the same body on every try. */
export function captureScanBody(c: Capture & { fileId: string }) {
  return {
    purpose: c.stamps.purpose,
    source_kind: "photo" as const,
    image_file_id: c.fileId,
    scan_area: c.stamps.areaName ?? undefined,
    target_location_id: c.stamps.areaId ?? undefined,
    target_container_kind: c.stamps.container?.kind,
    target_container_id: c.stamps.container?.id,
    scan_batch_id: c.batchId ?? undefined,
  };
}

export interface CaptureDoors<Item> {
  uploadFile: (file: File, opts: { idempotencyKey: string }) => Promise<{ id: string }>;
  ensureBatchId: () => Promise<string | null>;
  scanBarcode: (body: ReturnType<typeof captureScanBody>, opts: { idempotencyKey: string }) => Promise<Item>;
}

/** Store the capture's picture and put it in the inbox. Call it again with
 *  the same capture to retry: what landed is not sent as new. */
export async function saveCapture<Item>(c: Capture, doors: CaptureDoors<Item>): Promise<Item> {
  const keys = captureKeys(c);
  const [rec, batchId] = await Promise.all([
    c.fileId ? Promise.resolve({ id: c.fileId }) : doors.uploadFile(c.file, { idempotencyKey: keys.upload }),
    c.batchId !== undefined ? Promise.resolve(c.batchId) : doors.ensureBatchId(),
  ]);
  c.fileId = rec.id;
  c.batchId = batchId;
  return doors.scanBarcode(captureScanBody(c as Capture & { fileId: string }), { idempotencyKey: keys.scan });
}
