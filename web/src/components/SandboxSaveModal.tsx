// "Don't lose this" — the ONE place a sandbox visitor is shown every way out.
//
// This used to be two separate doors: a "Take your work" button that opened a
// modal, and a "Keep this workspace" button that unfolded an email field in the
// bar beside it. Each hid the other, so whichever you pressed first was the
// only one you learned existed — and they are not alternatives to weigh in the
// abstract, they are two answers to one question a person asks once: *how do I
// not lose this?*
//
// So both live here, over ONE email field, because both want the same address
// and asking twice is the sort of thing that makes someone close the tab:
//
//   · Keep this workspace — it stops being a sandbox and becomes theirs.
//   · Email me a copy     — the smaller ask, for someone not ready for an
//                           account. One file, and the two ways to carry on.
//
// Keep is the primary because it is the one that saves the work in place;
// copy is offered plainly beside it rather than buried, since for most people
// twenty minutes into a first look it is the likelier yes.
//
// Once kept, the modal is a different thing: the person has walked through
// this door, so the copy / hosted / self-host section goes, and what remains is
// the one success line and the two ways back in. Keep sends a sign-in link,
// and if that were the only door then a spam folder would lock them out of
// the workspace they just decided to keep. So they can choose a password
// right here, and the strip at the foot of the page opens this same view.
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

export interface KeptWorkspace {
  email: string;
  expires_at: string;
  emailed: boolean;
}

export function SandboxSaveModal({
  open,
  onClose,
  onKept,
  onPasswordSet,
  initial = "save",
  email: knownEmail = null,
}: {
  open: boolean;
  onClose: () => void;
  /** The bar switches from counting down to "yours until" once the workspace is theirs. */
  onKept?: (kept: KeptWorkspace) => void;
  /** The anonymous link is closed once a password exists; the bar stops offering the two. */
  onPasswordSet?: () => void;
  /** "password": open straight into the kept view with the password form up,
   *  which is what the strip's Set a password button does. */
  initial?: "save" | "password";
  /** The address keep bound, for the kept view when opened after the fact. */
  email?: string | null;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<null | "keep" | "copy" | "resend" | "password">(null);
  const [error, setError] = useState<string | null>(null);
  const [paths, setPaths] = useState<Paths | null>(null);
  const [kept, setKept] = useState<{ emailed: boolean; email: string } | null>(null);
  const [copied, setCopied] = useState<{ emailed: boolean; link: string; days: number } | null>(null);
  const [resent, setResent] = useState<null | "sent" | "failed">(null);
  const [password, setPassword] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordSet, setPasswordSet] = useState(false);

  // The destinations come from the server so this and the email can never
  // disagree about where "carry on" goes. Not needed once kept: that section
  // no longer renders.
  useEffect(() => {
    if (!open || initial === "password") return;
    void api.sandboxPaths().then(setPaths).catch(() => setPaths(null));
  }, [open, initial]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setBusy(null);
      setPasswordOpen(false);
      setPassword("");
      return;
    }
    if (initial === "password") {
      setKept((k) => k ?? { emailed: true, email: knownEmail ?? "" });
      setPasswordOpen(true);
    }
  }, [open, initial, knownEmail]);

  if (!open) return null;
  const days = copied?.days ?? paths?.export_days ?? 7;

  async function keep() {
    if (!email.trim() || busy) return;
    setBusy("keep");
    setError(null);
    try {
      const to = email.trim();
      const res = await api.keepSandbox(to);
      setKept({ emailed: res.emailed, email: to });
      onKept?.({ email: to, expires_at: res.expires_at, emailed: res.emailed });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "That email already has an account. Sign in with it instead."
          : "Could not save that. Try again?",
      );
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!email.trim() || busy) return;
    setBusy("copy");
    setError(null);
    try {
      const r = await api.takeSandboxWork(email.trim());
      setCopied({ emailed: r.emailed, link: r.link, days: r.days });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 413
          ? "That workspace is too big to email. Keep it instead and it stays where it is."
          : "Could not build your file. Try again?",
      );
    } finally {
      setBusy(null);
    }
  }

  async function resend() {
    if (busy) return;
    setBusy("resend");
    setError(null);
    try {
      const r = await api.resendSandboxLink();
      setResent(r.emailed ? "sent" : "failed");
    } catch {
      setResent("failed");
    } finally {
      setBusy(null);
    }
  }

  async function savePassword() {
    if (busy || password.length < 8) return;
    setBusy("password");
    setError(null);
    try {
      await api.setSandboxPassword(password);
      setPasswordSet(true);
      setPasswordOpen(false);
      setPassword("");
      onPasswordSet?.();
    } catch {
      setError("Could not set that password. Try again?");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={kept ? "This workspace is yours" : "Don't lose this"} size="md">
      <div className="space-y-4">
        {kept ? (
          <div className="space-y-3" data-testid="kept-view">
            <p className="text-sm text-content dark:text-mortar-100">
              <strong>Saved. This workspace is yours now.</strong>{" "}
              {passwordSet
                ? `Sign in with ${kept.email} and your password from now on.`
                : kept.emailed
                  ? `A sign-in link went to ${kept.email}. This tab keeps working for a week either way.`
                  : "We could not send your sign-in link, so keep this tab open and this page's address: it still works for a week."}
            </p>
            {!passwordSet && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={resend}
                  disabled={!!busy}
                  className="rounded-md border border-line dark:border-slate-600 disabled:opacity-50 px-3 py-1.5 text-sm font-medium hover:bg-subtle transition"
                >
                  {busy === "resend" ? "Sending…" : resent === "sent" ? "Sent again" : resent === "failed" ? "Could not send" : "Resend the link"}
                </button>
                {!passwordOpen && (
                  <button
                    type="button"
                    onClick={() => setPasswordOpen(true)}
                    className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium transition"
                  >
                    Set a password
                  </button>
                )}
              </div>
            )}
            {passwordOpen && !passwordSet && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void savePassword();
                }}
              >
                <p className="text-xs text-muted">
                  So you can get back in without the email. At least 8 characters.
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    autoFocus
                    autoComplete="new-password"
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Choose a password"
                    aria-label="New password"
                    className="input flex-1"
                  />
                  <button
                    type="submit"
                    disabled={!!busy || password.length < 8}
                    className="rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm font-medium transition"
                  >
                    {busy === "password" ? "Saving…" : "Save"}
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : copied ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {copied.emailed
                ? `Sent. The link works for ${days} days, then the file is deleted.`
                : `We could not send the email, so here is the link. It works for ${days} days.`}
            </p>
            <a
              href={copied.link}
              className="inline-flex items-center gap-2 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-4 py-2 transition"
            >
              <Download size={16} /> Download it now
            </a>
            <p className="text-xs text-muted">
              Your sandbox still ends when its hour is up. Want to keep the workspace itself instead?{" "}
              <button type="button" onClick={() => setCopied(null)} className="text-accent hover:underline">
                Go back
              </button>
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted">
              Your sandbox ends when its hour is up and everything in it is deleted. Two ways to
              stop that, and both use this address.
            </p>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              aria-label="Your email"
              className="input w-full"
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={keep}
                disabled={!!busy || !email.trim()}
                className="rounded-lg bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-2.5 text-left transition"
              >
                <span className="block font-medium text-sm">
                  {busy === "keep" ? "Saving…" : "Keep this workspace"}
                </span>
                <span className="block text-xs opacity-90 mt-0.5">
                  It stops being a sandbox. Everything stays exactly where it is.
                </span>
              </button>
              <button
                type="button"
                onClick={copy}
                disabled={!!busy || !email.trim()}
                className="rounded-lg border border-line dark:border-slate-600 disabled:opacity-50 px-3 py-2.5 text-left hover:bg-subtle transition"
              >
                <span className="block font-medium text-sm">
                  {busy === "copy" ? "Packing it up…" : "Just email me a copy"}
                </span>
                <span className="block text-xs text-muted mt-0.5">
                  One file with everything you made, kept for {days} days. No account.
                </span>
              </button>
            </div>
          </>
        )}
        {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
        {/* The other door out of a sandbox. Gone once they have taken this one. */}
        {!kept && paths && <TwoPaths paths={paths} />}
      </div>
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
