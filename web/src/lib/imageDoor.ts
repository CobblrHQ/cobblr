// The camera page's image door: an image file stands in for a live frame.
//
// A reviewer driving a real browser with no camera (the review test pack,
// #2891) still has to exercise the camera flow: the decode, the result
// sheet, the strip, the photo path. So a test door on the camera page takes
// a file, draws it into a canvas exactly the size a captured frame would be,
// and hands it to the SAME decoder the live loop runs (decodeCanvasSmart) and
// the same shot path the shutter takes. Nothing here is a second pipeline:
// the door only makes a frame.
//
// It renders only where /healthz says `test_doors` (platform/test-doors.ts:
// staging, a dev box, CI; never production or canary).
import { CAPTURE_MAX_SIDE, scaledDims } from "./barcodeScanner";

export interface DoorFrame {
  /** The frame, at capture size, for the decoder. */
  canvas: HTMLCanvasElement;
  /** The same frame as the JPEG a captured frame would be, for the inbox row. */
  blob: Blob;
}

/** Draw an image file into a capture-sized canvas and JPEG. */
export async function frameFromImage(file: Blob, maxSide = CAPTURE_MAX_SIDE): Promise<DoorFrame> {
  const bitmap = await createImageBitmap(file);
  try {
    const { w, h } = scaledDims(bitmap.width, bitmap.height, maxSide);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) throw new Error("no 2d context for the image door");
    g.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("could not encode the image as a frame");
    return { canvas, blob };
  } finally {
    bitmap.close();
  }
}

/** What the door does with a frame, decided in one place so the e2e and the
 *  page agree: a Cobblr label routes, a product code looks up, anything else
 *  is a photo of something. */
export type DoorPlan =
  | { kind: "route-qr"; token: string }
  | { kind: "lookup"; code: string }
  | { kind: "photo" };

export function doorPlan(verdict: { action: string; token?: string; code?: string } | null): DoorPlan {
  if (verdict?.action === "route-qr" && verdict.token) return { kind: "route-qr", token: verdict.token };
  if (verdict?.action === "lookup" && verdict.code) return { kind: "lookup", code: verdict.code };
  return { kind: "photo" };
}
