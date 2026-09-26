// /carry: the receiving end of a sandbox's "bring what I built".
//
// The demo box sends the person here with a grant to read their trial. They
// usually arrive signed out, so the page is sign-up first, then the list their
// ending showed (the same words, from the same read), then one button, then
// what happened to every line. docs/design-decisions/trial-ledger.md.
import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { pickDefaultOrg, urlHandleFor } from "../auth/ActiveOrgContext";
import { BuiltHere } from "../components/BuiltHere";
import { api, ApiError, type CarryPreview, type CarryResult } from "../lib/api";
import { dropCarry, type PendingCarry } from "../lib/carry-pending";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { usePageTitle } from "@cobblr/platform-web";

const PRIMARY = "rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white font-medium px-4 py-2 transition";
const SECONDARY = "rounded-md border border-line dark:border-slate-700 px-4 py-2 font-medium hover:bg-subtle transition";

/** What a failed read or replay means, in words, from the server's code. */
function sayError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "carry_expired") return "The link to bring your trial along has run out. Open your trial again and use its door once more for a fresh one.";
    if (err.code === "carry_already") return "This trial has already been brought into that workspace.";
    if (err.code === "carry_same_workspace") return "That is the trial itself. Bring it into another workspace.";
    if (err.code === "carry_not_accepted" || err.code === "carry_unknown_source") return "This server does not take trials from where that link points.";
    if (err.code === "carry_unreachable") return "Your trial could not be reached just now. Try again in a minute.";
    return err.message;
  }
  return "Something went wrong. Try again?";
}

/** Signed in, with the grant the address (or the browser) held. Signed out,
 *  App shows the sign-up form here first; see CarryRoute in App.tsx. */
export function CarryPage({ grant }: { grant: PendingCarry | null }) {
  usePageTitle("Bring what you built");
  const { orgs } = useAuth();
  if (!grant) {
    return (
      <Frame>
        <h1 className="mt-2 text-2xl font-bold text-slate-700 dark:text-mortar-100">Nothing to bring</h1>
        <p className="mt-2 text-muted" data-testid="carry-nothing">
          This page brings what somebody built in a trial into a real account, and it came without one. Open your trial
          and use its "Bring what I built" door.
        </p>
      </Frame>
    );
  }
  return <CarryInto grant={grant} orgs={orgs} />;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid place-items-center bg-canvas text-content px-6 py-10" data-testid="carry-page">
      <div className="max-w-lg w-full">
        <p className="font-mono text-xs uppercase tracking-widest text-faint">from your trial</p>
        {children}
      </div>
    </div>
  );
}

/** How new a workspace can be and still count as the one made for this carry. */
const FRESH_WORKSPACE_MS = 30 * 60_000;

/** The workspace to bring a sandbox into without asking: the person's only
 *  one, and made in the last half hour. Null otherwise, or when the server
 *  does not say when it was made. */
export function autoBringTarget<O extends { slug: string; created_at?: string }>(all: O[], writable: O[], now: number = Date.now()): O | null {
  if (all.length !== 1 || writable.length !== 1) return null;
  const made = Date.parse(writable[0]!.created_at ?? "");
  return Number.isFinite(made) && now - made < FRESH_WORKSPACE_MS ? writable[0]! : null;
}

function CarryInto({ grant, orgs }: { grant: PendingCarry; orgs: ReturnType<typeof useAuth>["orgs"] }) {
  const [preview, setPreview] = useState<CarryPreview | null>(null);
  // Somewhere they can build, and never the trial itself (one box can play
  // both sides, with the person still signed in to their trial).
  const writable = orgs.filter((o) => roleSatisfies(o.role, ["owner", "admin"]) && o.id !== preview?.workspace.id);
  const [chosen, setSlug] = useState<string>("");
  const slug = writable.some((o) => o.slug === chosen) ? chosen : (pickDefaultOrg(writable)?.slug ?? writable[0]?.slug ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CarryResult | null>(null);

  useEffect(() => {
    let gone = false;
    api.carryPreview(grant.from, grant.token).then(
      (p) => !gone && setPreview(p),
      (err) => !gone && setError(sayError(err)),
    );
    return () => {
      gone = true;
    };
  }, [grant]);

  const target = writable.find((o) => o.slug === slug) ?? null;
  // Straight in, without a question, when the only workspace they have was
  // made moments ago: the account they just made for exactly this. Anyone
  // with a workspace they have been using picks, and presses Bring it in.
  const fresh = autoBringTarget(orgs, writable);
  const [auto, setAuto] = useState(false);
  useEffect(() => {
    if (auto || !preview || !fresh || fresh.slug !== target?.slug) return;
    setAuto(true);
    void bring();
  }, [preview, fresh, target, auto]);

  async function bring() {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.carryInto(target.slug, grant.from, grant.token);
      setResult(r);
      dropCarry();
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(false);
    }
  }

  function notNow() {
    dropCarry();
    window.location.assign("/");
  }

  if (result && target) {
    const open = `/w/${urlHandleFor(target, orgs)}`;
    return (
      <Frame>
        <h1 className="mt-2 text-2xl font-bold text-slate-700 dark:text-mortar-100">
          {result.skipped === 0 && result.partly === 0 ? "Everything came along." : "Here is what came along."}
        </h1>
        <p className="mt-2 text-muted">
          Into <strong className="text-content dark:text-mortar-100">{target.name}</strong>, the same way you would have
          made it here yourself.
        </p>
        <ul className="mt-4 space-y-2 text-sm" data-testid="carry-result">
          {result.lines.map((l, i) => (
            <li key={`${l.words}-${i}`} className="flex gap-2" data-state={l.state}>
              <span aria-hidden className={l.state === "done" ? "text-accent" : l.state === "partly" ? "text-amber-600 dark:text-amber-400" : "text-ember-600 dark:text-ember-400"}>
                {l.state === "done" ? "✓" : l.state === "partly" ? "◐" : "✕"}
              </span>
              <span>
                <span className="text-content dark:text-mortar-100">{l.words}</span>
                {l.note && <span className="block text-xs text-muted">{l.note}</span>}
              </span>
            </li>
          ))}
        </ul>
        <a href={open} className={"mt-6 inline-block " + PRIMARY} data-testid="carry-open">
          Open {target.name}
        </a>
      </Frame>
    );
  }

  return (
    <Frame>
      <h1 className="mt-2 text-2xl font-bold text-slate-700 dark:text-mortar-100">Bring what you built</h1>
      <p className="mt-2 text-muted">
        {preview ? (
          <>
            From <strong className="text-content dark:text-mortar-100">{preview.workspace.name}</strong>, your trial. It is
            made again here, the way you would make it yourself; nothing is copied across as it was.
          </>
        ) : error ? null : (
          "Reading your trial…"
        )}
      </p>
      {preview && (
        <BuiltHere preview={preview.ledger} heading="What you built there" staysLabel="Stays in the trial" />
      )}
      {error && (
        <p className="mt-4 text-sm text-ember-600 dark:text-ember-400" data-testid="carry-error">
          {error}
        </p>
      )}
      {preview && writable.length === 0 && (
        <p className="mt-4 text-sm text-muted" data-testid="carry-no-workspace">
          You need a workspace of your own to bring it into. Make one first, then come back to this page.
        </p>
      )}
      {preview && writable.length > 0 && (
        <div className="mt-6 space-y-3">
          {writable.length > 1 && (
            <label className="block text-sm">
              <span className="text-muted">Bring it into</span>
              <select value={slug} onChange={(e) => setSlug(e.target.value)} className="input mt-1 w-full" aria-label="Workspace">
                {writable.map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void bring()} disabled={busy || !target} className={PRIMARY} data-testid="carry-bring">
              {busy ? "Bringing it…" : `Bring it into ${target?.name ?? "my workspace"}`}
            </button>
            <button type="button" onClick={notNow} className={SECONDARY}>
              Not now
            </button>
          </div>
        </div>
      )}
    </Frame>
  );
}
