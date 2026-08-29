// "Take your work with you" — the smaller door out of a sandbox.
//
// Keeping the workspace means committing to an account. This asks for far less:
// an address to send one file to. Somebody twenty minutes into their first look
// at Cobblr is much likelier to do the small thing, and the small thing is still
// their whole workspace plus the two ways to carry on.
//
// The two paths are the point, not a footer. A person who has just built
// something in a sandbox is exactly the one who has not decided between "hosted,
// nothing to run" and "on my own machine", and the export opens either door, so
// saying both here is honest rather than a hedge. The email mirrors this
// deliberately: same two paths, same order, so it reads as a copy of what they
// were looking at when they typed their address.
import { useEffect, useState } from "react";
import { Modal } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";
import { Cloud, Server, Download } from "lucide-react";

interface Paths {
  /** Null when this deployment does not offer that path. */
  cloud_url: string | null;
  selfhost_url: string | null;
  export_days: number;
}

export function TakeYourWorkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paths, setPaths] = useState<Paths | null>(null);
  const [done, setDone] = useState<{ emailed: boolean; link: string; days: number } | null>(null);

  // The destinations come from the server so this and the email can never
  // disagree about where "carry on" goes.
  useEffect(() => {
    if (!open) return;
    void api.sandboxPaths().then(setPaths).catch(() => setPaths(null));
  }, [open]);

  useEffect(() => {
    if (!open) {
      setDone(null);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  if (!open) return null;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.takeSandboxWork(email.trim());
      setDone({ emailed: r.emailed, link: r.link, days: r.days });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 413
          ? "That workspace is too big to email. Keep it instead and it stays where it is."
          : "Could not build your file. Try again?",
      );
    } finally {
      setBusy(false);
    }
  }

  const days = done?.days ?? paths?.export_days ?? 7;

  return (
    <Modal open={open} onClose={onClose} title="Take your work with you" size="md">
      {done ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {done.emailed
              ? `Sent. The link works for ${days} days, then the file is deleted.`
              : `We could not send the email, so here is the link. It works for ${days} days.`}
          </p>
          <a
            href={done.link}
            className="inline-flex items-center gap-2 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-4 py-2 transition"
          >
            <Download size={16} /> Download it now
          </a>
          {paths && <TwoPaths paths={paths} />}
        </div>
      ) : (
        <form onSubmit={send} className="space-y-4">
          <p className="text-sm text-muted">
            We will email you everything you made here as one file. Your sandbox still ends when its hour is up;
            the file is kept for {days} days so you can pick it up, and nothing else is.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              aria-label="Your email"
              className="input flex-1 min-w-[14rem]"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white font-medium px-4 py-2 transition"
            >
              {busy ? "Packing it up…" : "Send it to me"}
            </button>
          </div>
          {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
          {paths && <TwoPaths paths={paths} />}
        </form>
      )}
    </Modal>
  );
}

/** The same two doors the email lists, in the same order. */
function TwoPaths({ paths }: { paths: Paths }) {
  if (!paths.cloud_url && !paths.selfhost_url) return null;
  return (
    <div className="pt-1">
      <p className="text-xs uppercase tracking-widest text-faint mb-2">Two ways to carry on</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {paths.cloud_url && (
        <a
          href={paths.cloud_url}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-line dark:border-slate-700 p-3 hover:bg-subtle transition"
        >
          <span className="flex items-center gap-2 font-medium text-sm">
            <Cloud size={15} /> Hosted by us
          </span>
          <span className="block text-xs text-muted mt-1">Nothing to run. Make a workspace and restore your file into it.</span>
        </a>
        )}
        {paths.selfhost_url && (
        <a
          href={paths.selfhost_url}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-line dark:border-slate-700 p-3 hover:bg-subtle transition"
        >
          <span className="flex items-center gap-2 font-medium text-sm">
            <Server size={15} /> On your own machine
          </span>
          <span className="block text-xs text-muted mt-1">Your hardware, your data. The same file restores there too.</span>
        </a>
        )}
      </div>
    </div>
  );
}
