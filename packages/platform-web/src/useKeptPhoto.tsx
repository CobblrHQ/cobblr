// A photo door that never loses a photo (#4115): what useKeptPhotos gives a
// door, and the note it shows while photos wait.
//
//   const kept = useKeptPhotos(`${slug}:cover:${kind}:${id}`, (file) => upload(file), { one: true });
//   kept.send(file)        // instead of upload(file) when the person picks one
//   <KeptPhotoNote kept={kept} />
//
// `send` tries the upload. A failure for want of a connection keeps the photo
// on the device (kept-photos.ts) and sends it again by itself when the
// connection is back: on the window's online event, and once when the door
// opens with the phone already online (a reload, a later visit). One try per
// photo runs at a time, a photo the person discarded is never sent, and a
// refusal is kept for Retry or Discard, never sent again on every reconnect.
// Each photo's key is kept with it and handed to the upload, which sends it as
// its Idempotency-Key: a resend of a photo that did land, after a reload too,
// is answered as the first and stays one file. `one`: a door that holds one photo (a cover) keeps
// only the newest; a gallery keeps every one.
import { useCallback, useEffect, useRef, useState } from "react";
import { forgetPhoto, keepPhoto, keptPhotos, lostConnection } from "./kept-photos";
import { writerOf } from "./waiting-writes";

interface Waiting {
  key: string;
  file: File;
  lost: boolean;
  /** This device stored it; false when it would not (storage full, a private window). */
  stored?: boolean;
}

export interface KeptPhotoState {
  /** The photos waiting to land, oldest first. */
  waiting: File[];
  /** Every one waiting failed for want of a connection, so they send themselves when it is back. */
  lost: boolean;
  /** Some this device could not keep: they last only while this page is open. */
  unstored: boolean;
  busy: boolean;
  send: (file: File) => Promise<void>;
  retry: () => Promise<void>;
  discard: () => Promise<void>;
}

let seq = 0;
// Its own id, never the door: it is also the upload's Idempotency-Key, which
// the server takes as 8 to 128 letters, digits or . _ : - (request-replays.ts).
const newKey = () => `kept-photo.${Date.now().toString(36)}.${(seq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function useKeptPhotos(where: string, upload: (file: File, key: string) => Promise<void>, opts: { one?: boolean; onError?: (e: unknown) => void; token?: string | null } = {}): KeptPhotoState {
  // A kept photo is the signed-in person's: the door names them, so another
  // person signing in on this phone is never offered or sends it. No one
  // signed in, nothing is kept on the device.
  const person = writerOf(opts.token ? `Bearer ${opts.token}` : "");
  const door = person ? `${person}:${where}` : "";
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [busyCount, setBusyCount] = useState(0);
  const now = useRef(waiting);
  now.current = waiting;
  const trying = useRef(new Set<string>());
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  const errorRef = useRef(opts.onError);
  errorRef.current = opts.onError;
  const one = opts.one === true;

  const attempt = useCallback(
    async (w: Waiting) => {
      if (trying.current.has(w.key)) return;
      trying.current.add(w.key);
      setBusyCount((n) => n + 1);
      try {
        // Its key goes with every try, after a reload too: a resend of a
        // photo that did land is answered as the first (Idempotency-Key).
        await uploadRef.current(w.file, w.key);
        // The same file picked again and landed: any copy of it still kept is done too.
        const same = (x: Waiting) => x.key === w.key || (x.file.name === w.file.name && x.file.size === w.file.size && x.file.lastModified === w.file.lastModified);
        for (const x of now.current) if (same(x) && x.key !== w.key) await forgetPhoto(x.key);
        await forgetPhoto(w.key);
        setWaiting((list) => list.filter((x) => !same(x)));
      } catch (e) {
        // Discard never lets go of a photo while it is being tried, so one
        // that failed is still wanted: kept, with why it failed.
        const lost = lostConnection(e);
        const stored = door ? await keepPhoto(door, w.key, w.file, lost) : false;
        setWaiting((list) => [...list.filter((x) => x.key !== w.key), { ...w, lost, stored }]);
        errorRef.current?.(e);
      } finally {
        trying.current.delete(w.key);
        setBusyCount((n) => n - 1);
      }
    },
    [door],
  );

  const send = useCallback(
    async (file: File) => {
      if (one) {
        // A cover holds one photo: a new one replaces any still waiting.
        for (const w of now.current) await forgetPhoto(w.key);
        setWaiting([]);
      }
      await attempt({ key: newKey(), file, lost: false });
    },
    [attempt, door, one],
  );

  const retry = useCallback(async () => {
    await Promise.all(now.current.map((w) => attempt(w)));
  }, [attempt]);

  // Kept from before (a reload, a later visit): offered again, and those
  // waiting for a connection that is already here are tried once.
  useEffect(() => {
    let live = true;
    if (!door) return;
    void keptPhotos(door).then((kept) => {
      if (!live || !kept.length) return;
      setWaiting(kept.map((k) => ({ ...k, stored: true })));
      if (typeof navigator !== "undefined" && navigator.onLine !== false) for (const w of kept) if (w.lost) void attempt(w);
    });
    return () => {
      live = false;
    };
  }, [door, attempt]);

  useEffect(() => {
    const back = () => {
      for (const w of now.current) if (w.lost) void attempt(w);
    };
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, [attempt]);

  const discard = useCallback(async () => {
    const letGo = now.current.filter((w) => !trying.current.has(w.key));
    for (const w of letGo) await forgetPhoto(w.key);
    setWaiting((list) => list.filter((x) => !letGo.some((g) => g.key === x.key)));
  }, []);

  return { waiting: waiting.map((w) => w.file), lost: waiting.length > 0 && waiting.every((w) => w.lost), unstored: waiting.some((w) => w.stored === false), busy: busyCount > 0, send, retry, discard };
}

/** What a door shows while its photos wait: never a photo gone without a word. */
export function KeptPhotoNote({ kept, noun = "photo" }: { kept: KeptPhotoState; noun?: "photo" | "file" }) {
  const n = kept.waiting.length;
  if (!n) return null;
  const what = n === 1 ? (noun === "photo" ? "Photo didn't save" : "File didn't save") : `${n} ${noun === "photo" ? "photos" : "files"} didn't save`;
  return (
    <div data-testid="kept-photo" role="status" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
      <span className="min-w-0 flex-1">
        {kept.unstored
          ? `${what}, and this phone could not keep ${n === 1 ? "it" : "them"} (its storage is full or private). Try again when you have signal; leaving this page loses ${n === 1 ? "it" : "them"}.`
          : kept.lost ? `${what} yet. ${n === 1 ? "It is" : "They are"} kept here and ${n === 1 ? "sends itself" : "send themselves"} when you're back online.` : `${what}. ${n === 1 ? "It is" : "They are"} kept here until you retry or let ${n === 1 ? "it" : "them"} go.`}
      </span>
      <button type="button" className="btn" onClick={() => void kept.retry()} disabled={kept.busy}>
        {kept.busy ? "Sending…" : "Retry"}
      </button>
      <button type="button" className="min-h-[44px] px-2 text-sm text-muted underline-offset-2 hover:underline disabled:opacity-50 dark:text-slate-400" onClick={() => void kept.discard()} disabled={kept.busy}>
        Discard
      </button>
    </div>
  );
}
