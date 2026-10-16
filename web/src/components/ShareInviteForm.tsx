// Inviting someone new into a share (#5365): one field, their email or
// nothing, the place their Cobblr is, and Share. The same form on a list's,
// a selection's and a record's share page and in Settings → Sharing.
//
// With an email the invite is bound to it and, when this Cobblr has mail,
// emailed there; the link shows either way, with Copy and (on a phone) the
// system share sheet, in case the email lands in spam.
import { withArticle } from "@cobblr/platform-contract/plural";
import { productName } from "@cobblr/platform-web";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Share } from "lucide-react";
import { SegmentedChoice } from "@cobblr/platform-web";
import { api, type ShareInviteMade } from "../lib/api";

const WHERE_KEY = "cobblr.share.where";

function lastWhere(): string | null {
  try {
    return window.localStorage.getItem(WHERE_KEY);
  } catch {
    return null;
  }
}

function rememberWhere(label: string) {
  try {
    window.localStorage.setItem(WHERE_KEY, label);
  } catch {
    // quiet: the place is a per-viewer convenience; the default is the first
  }
}

const canShareSheet = () => typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

export function InviteForm({ slug, onDone, collection }: { slug: string; onDone: (made: ShareInviteMade) => void; collection?: { kind: string; ids?: string[] } }) {
  const places = useQuery({ queryKey: ["share-destinations", slug], queryFn: () => api.shareDestinations(slug), staleTime: 300_000 });
  const destinations = places.data?.destinations ?? [];
  const [email, setEmail] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const remembered = destinations.findIndex((d) => d.label === lastWhere());
  const where = picked ?? (remembered >= 0 ? remembered : 0);
  const [made, setMade] = useState<ShareInviteMade | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canEmail = places.data?.can_email ?? false;
  return (
    <div className="space-y-4">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api.createShareLink(slug, { ...(email.trim() ? { email: email.trim() } : {}), where, ...(collection ? { collection } : {}) });
            if (destinations[where]) rememberWhere(destinations[where]!.label);
            setMade(r);
            setEmail("");
            onDone(r);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block space-y-1">
          <span className="text-sm font-medium text-content">Their email (optional)</span>
          <input
            type="email"
            inputMode="email"
            autoComplete="off"
            data-testid="share-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-content sm:text-sm dark:border-slate-600"
          />
          <span className="block text-xs text-muted" data-testid="share-email-hint">
            {places.isLoading ? " " : canEmail ? "We email them the invite. Leave it empty to just make a link." : "This server can't send email, so you get a link to send them yourself."}
          </span>
        </label>
        {destinations.length > 1 && (
          <div className="space-y-1" data-testid="share-invite-where">
            <span className="text-sm font-medium text-content">Where is their {productName()}?</span>
            <SegmentedChoice
              stack
              label={`Where is their ${productName()}?`}
              value={String(where)}
              onChange={(v) => setPicked(Number(v))}
              options={destinations.map((d, i) => ({ value: String(i), label: d.label, hint: d.note, testId: "share-invite-where-option" }))}
            />
          </div>
        )}
        {error && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
        <button type="submit" disabled={busy} data-testid="share-make-invite" className="rounded-lg bg-cobble-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? "Sharing…" : "Share"}
        </button>
      </form>
      {made && <InviteMadeResult made={made} />}
    </div>
  );
}

function InviteMadeResult({ made }: { made: ShareInviteMade }) {
  const [copied, setCopied] = useState(false);
  const url = made.invite_url;
  return (
    <div className="space-y-2 rounded-lg border border-line bg-subtle p-3 dark:border-slate-600" data-testid="share-invite-made">
      <p role="status" className="text-sm font-medium text-content">{made.said ?? "Invite link made. Send it to them yourself."}</p>
      <div className="flex flex-wrap gap-2">
        <input readOnly value={url} aria-label="Invite link" data-testid="share-invite-url" className="min-w-0 flex-1 basis-48 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-content dark:border-slate-600" onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard?.writeText(url).catch(() => undefined);
            setCopied(true);
          }}
          className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-line px-3 text-sm text-muted hover:text-accent dark:border-slate-600"
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
        {canShareSheet() && (
          <button
            type="button"
            data-testid="share-invite-sheet"
            onClick={() => void navigator.share({ title: `${withArticle(productName()).replace(/^a/, "A")} invite`, url }).catch(() => undefined)}
            className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-line px-3 text-sm text-muted hover:text-accent dark:border-slate-600"
          >
            <Share size={14} aria-hidden />
            Share…
          </button>
        )}
      </div>
      <p className="text-xs text-muted" data-testid="share-invite-rules">
        Works once, for a week. {made.email ? `Only ${made.email} can use it.` : "Anyone with the link can use it."}
      </p>
    </div>
  );
}
