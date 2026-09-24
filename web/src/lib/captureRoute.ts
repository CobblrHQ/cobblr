// Where a captured image goes, whichever door it came through.
//
// "+Photo" arms the camera: the next shot joins the item it was pressed on.
// The live shutter honoured that; the image door (the test door a reviewer
// with no camera uses) decoded the picture and saved it as a new shot, so a
// kettle photographed after +Photo became a second draft while the prompt
// stayed armed (#3629). A door that routes around the real handler tests a
// path nobody runs, so every capture source asks this one question, and the
// camera page lands every capture through one handler that follows it.

import type { DoorPlan } from "./imageDoor";

export type CaptureSource = "shutter" | "image-door";

export type CaptureRoute =
  | { kind: "attach" }
  | { kind: "route-qr"; token: string }
  | { kind: "lookup"; code: string }
  | { kind: "new-shot" };

/** An armed camera attaches the image to the armed item, whatever the image
 *  holds: a shot of a label carries a barcode, and it still belongs to the
 *  item the person armed it for. Unarmed, a decoded QR routes, a decoded
 *  code is looked up, and anything else is a new shot. The shutter decodes
 *  nothing (the live loop reads codes before the shutter is pressed), so it
 *  passes no plan. */
export function captureRoute(armed: boolean, plan: DoorPlan | null): CaptureRoute {
  if (armed) return { kind: "attach" };
  if (plan?.kind === "route-qr") return { kind: "route-qr", token: plan.token };
  if (plan?.kind === "lookup") return { kind: "lookup", code: plan.code };
  return { kind: "new-shot" };
}
