// The app's one answer to "take a photo of this" from any record surface,
// module pages included (platform-web photo-capture). It is the same camera
// the scan surfaces use, not a second one.
import { photoFile, usePhotoCaptureHost } from "@cobblr/platform-web";
import { CameraCaptureSheet } from "./CameraCaptureSheet";

export function PhotoCaptureHost() {
  const { request, done } = usePhotoCaptureHost();
  return (
    <CameraCaptureSheet
      open={!!request}
      title={request?.title ?? "Take a photo"}
      onCapture={(blob) => done(photoFile(blob))}
      onClose={() => done(null)}
    />
  );
}
