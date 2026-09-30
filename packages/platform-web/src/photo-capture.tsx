// Adding a photo of a thing opens the camera on a phone.
//
// In a dedicated inventory app, "add a photo" on an item opens the camera and
// the picture lands on the item; the library is the second choice. Cobblr's
// record photos were plain <input type=file accept="image/*">: on a phone that
// is the OS chooser, library first on iOS, a detour away from the thing you
// are standing in front of, and a picture that skips the in-app camera's lens
// choice and focus (#4140).
//
// Modules cannot import the web app's camera (web/src/components/
// CameraCaptureSheet), so this is the seam: the app mounts one host
// (usePhotoCaptureHost) that shows its camera for a request, and every
// "add a photo of this" surface asks through usePhotoPick. On a touch screen
// with a host mounted it opens that camera (which offers "Choose from
// library" itself); anywhere else, or with no host, it opens the file picker.
// capability row photo:add-to-record keeps a new surface from hand-rolling
// the file input again.

import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactElement } from "react";

export interface PhotoRequest {
  /** The camera's title ("Photo of the drill"). */
  title?: string;
  resolve: (file: File | null) => void;
}

let current: PhotoRequest | null = null;
let hosts = 0;
const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((f) => f());

function isTouchScreen(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
}

/** Ask the mounted host for a photo. Null when there is no host, or the
 *  device is not a touch screen: the caller opens its file picker instead. */
export function requestCapturedPhoto(title?: string): Promise<File | null> | null {
  if (hosts === 0 || !isTouchScreen()) return null;
  current?.resolve(null);
  return new Promise((resolve) => {
    current = { title, resolve };
    notify();
  });
}

/** The app's one host: what it should show, and how to answer it. */
export function usePhotoCaptureHost(): { request: PhotoRequest | null; done: (file: File | null) => void } {
  useEffect(() => {
    hosts += 1;
    return () => {
      hosts -= 1;
    };
  }, []);
  const request = useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => current,
    () => null,
  );
  const done = useCallback((file: File | null) => {
    const r = current;
    current = null;
    notify();
    r?.resolve(file);
  }, []);
  return { request, done };
}

/** A captured Blob as a File a caller can upload like any picked one. */
export function photoFile(blob: Blob): File {
  const type = blob.type || "image/jpeg";
  const ext = type.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return new File([blob], `photo-${stamp}.${ext}`, { type });
}

/** `pick()` opens the camera on a phone, else the file picker; render `input`
 *  once beside the button. `onFiles` gets what was taken or chosen.
 *  `camera: false` is for a picture that is not a photo of the thing in front
 *  of you (a catalog image, a screenshot): the file picker, everywhere. */
export function usePhotoPick(
  onFiles: (files: File[]) => void,
  opts: { multiple?: boolean; title?: string; label?: string; camera?: boolean } = {},
): { pick: () => void; input: ReactElement } {
  const ref = useRef<HTMLInputElement>(null);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  const camera = opts.camera !== false;
  const pick = useCallback(() => {
    const asked = camera ? requestCapturedPhoto(opts.title) : null;
    if (!asked) {
      ref.current?.click();
      return;
    }
    void asked.then((f) => {
      if (f) onFilesRef.current([f]);
    });
  }, [camera, opts.title]);
  const input = (
    <input
      ref={ref}
      type="file"
      accept="image/*"
      multiple={opts.multiple}
      className="sr-only"
      tabIndex={-1}
      aria-label={opts.label ?? "Choose a photo"}
      onChange={(e) => {
        const files = e.target.files ? Array.from(e.target.files) : [];
        e.target.value = "";
        if (files.length) onFilesRef.current(files);
      }}
    />
  );
  return { pick, input };
}
