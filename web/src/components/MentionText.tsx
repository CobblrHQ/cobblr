// Typing `@`, and reading back what it wrote.
//
// A mention is stored as a stable token — `[[user:<uuid>]]`,
// `[[<module>:<type>:<uuid>]]`, `[[cobb]]` — and never as the name it showed
// when you typed it. So renaming a printer or a person updates every mention of
// them, everywhere, with no migration. The same rule tags follow, for the same
// reason: a stored name is a copy, and copies go stale.
//
// Which means the raw body is unreadable, and this file is what makes it
// readable: a composer that inserts tokens by picking a name, and chips that
// turn them back into names at read time.
//
// The GRAMMAR is not here. It lives in @cobblr/platform-contract/entity-tokens
// and is imported by the server too, because a browser that disagreed with the
// server about what a token is would fail silently in both directions: a link
// written for text shown as prose, or a chip drawn for something never stored.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AtSign } from "lucide-react";
import { api, type SearchHit } from "../lib/api";
import { splitMentions } from "@cobblr/platform-contract/entity-tokens";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useDetailRoute } from "../lib/useDetailRoute";
import { Link } from "react-router-dom";

/** A comment body with its mentions rendered as live chips. */
export function MentionText({
  body,
  names,
}: {
  body: string;
  /** user id → display name, resolved by the caller (which already holds the
   *  member list). */
  names: (userId: string) => string;
}) {
  const { activeSlug } = useActiveOrg();
  const detailRoute = useDetailRoute(activeSlug ?? "");
  const pieces = useMemo(() => splitMentions(body), [body]);


  const chip =
    "inline-flex items-center rounded px-1 py-0.5 text-[0.95em] bg-cobble-50 dark:bg-cobble-900 " +
    "text-cobble-800 dark:text-cobble-100 border border-cobble-200 dark:border-cobble-800";

  return (
    <span className="whitespace-pre-wrap break-words">
      {pieces.map((p, i) => {
        if (p.t === "text") return <span key={i}>{p.value}</span>;
        if (p.t === "cobb") return <span key={i} className={chip}>@Cobb</span>;
        if (p.t === "user") return <span key={i} className={chip}>@{names(p.id)}</span>;
        return <RecordChip key={i} kind={p.kind} id={p.id} className={chip} to={detailRoute(p.kind, p.id)} />;
      })}
    </span>
  );
}

/** One record mention, resolved to its CURRENT name.
 *
 *  Its own component so each ref is its own cached query: the same printer
 *  named in ten comments is looked up once, and a comment naming nothing costs
 *  no request at all. The title is read at render time, never stored, so
 *  renaming the printer renames every mention of it. */
function RecordChip({
  kind,
  id,
  className,
  to,
}: {
  kind: string;
  id: string;
  className: string;
  to: string | null;
}) {
  const { activeSlug } = useActiveOrg();
  const q = useQuery({
    queryKey: ["entity", activeSlug, kind, id],
    queryFn: () => api.lookupEntity(activeSlug, kind, id),
    enabled: !!activeSlug,
    staleTime: 60_000,
    retry: false,
  });
  // A record that has since been deleted still leaves its mention in the text.
  // Saying so is better than showing a uuid or an endless spinner.
  const label = q.isError ? "(deleted)" : (q.data?.title ?? "…");
  return to && !q.isError ? (
    <Link to={to} className={className + " hover:border-cobble-400"}>
      {label}
    </Link>
  ) : (
    <span className={className}>{label}</span>
  );
}

interface Candidate {
  token: string;
  label: string;
  hint: string;
}

/** What a chosen mention LOOKS like while you are still writing.
 *
 *  Exported because the composer's round trip is worth testing on its own: the
 *  label is the only thing tying a draft back to the token it stands for, so a
 *  change here silently changes which mentions survive being sent. */
export function mentionLabel(c: Pick<Candidate, "label">): string {
  return `@${c.label}`;
}

/** A mention the writer actually chose out of the picker. */
export interface PickedMention {
  /** What it reads as in the box — "@Bo Test". */
  shown: string;
  /** What it is stored as — "[[user:<uuid>]]". */
  token: string;
}

/**
 * Turn a draft written in NAMES into the body the server stores, in TOKENS.
 *
 * Only what was chosen from the picker is converted. A name that merely appears
 * in the sentence ("ask Bo Test about it") is prose and stays prose — the
 * audience is computed from the tokens, so inventing one would address somebody
 * nobody meant to address. A chosen mention the writer then deleted is simply
 * not found, and quietly stops being a mention, which is the same rule read the
 * other way round.
 *
 * Longest label first: two members can be "Bo" and "Bo Test", and taking them
 * in pick-order would let "@Bo" consume the front of "@Bo Test" and strand
 * " Test" in the middle of the sentence.
 */
export function resolveMentions(draft: string, picked: readonly PickedMention[]): string {
  let out = draft;
  for (const m of [...picked].sort((a, b) => b.shown.length - a.shown.length)) {
    const at = out.indexOf(m.shown);
    if (at < 0) continue;
    out = out.slice(0, at) + m.token + out.slice(at + m.shown.length);
  }
  return out;
}

/** The `@` picker.
 *
 *  Deliberately keyboard-first: `@` opens it, typing filters, Enter takes the
 *  top match, Escape closes. Reaching for the mouse mid-sentence is what makes
 *  a mention feature go unused. */
export function useMentionPicker(
  value: string,
  onChange: (next: string) => void,
  taRef: React.RefObject<HTMLTextAreaElement | null>,
) {
  const { activeSlug } = useActiveOrg();
  const [query, setQuery] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const anchorRef = useRef(0);
  /** Every mention actually chosen from the list, in the order chosen. Cleared
   *  when the draft is resolved (i.e. when it is sent). */
  const picked = useRef<PickedMention[]>([]);

  const members = useQuery({
    queryKey: ["members", activeSlug],
    queryFn: () => api.listMembers(activeSlug),
    enabled: !!activeSlug && query !== null,
    staleTime: 5 * 60_000,
  });
  const hits = useQuery({
    queryKey: ["mention-search", activeSlug, query],
    queryFn: () => api.search(activeSlug, { q: query ?? "" }),
    enabled: !!activeSlug && !!query && query.length >= 2,
    staleTime: 15_000,
  });

  const candidates = useMemo<Candidate[]>(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    const people = (members.data?.items ?? [])
      .filter((m) => (m.display_name || m.email).toLowerCase().includes(q))
      .slice(0, 5)
      .map((m) => ({
        token: `[[user:${m.user_id}]]`,
        label: m.display_name || m.email,
        hint: "person",
      }));
    const cobb = "cobb".includes(q) ? [{ token: "[[cobb]]", label: "Cobb", hint: "assistant" }] : [];
    const records = ((hits.data?.items ?? []) as SearchHit[])
      .slice(0, 6)
      .map((h) => ({ token: `[[${h.kind}:${h.id}]]`, label: h.title, hint: h.kind }));
    return [...people, ...cobb, ...records];
  }, [query, members.data, hits.data]);

  useEffect(() => setSel(0), [query]);

  /** Insert the chosen mention in place of the half-typed "@thing".
   *
   *  WHAT GOES IN THE BOX IS THE NAME. The draft used to receive the token
   *  itself, so picking a person out of the list replaced "@Bo" with
   *  "[[user:24ef75ca-3ab4-4b34-b0da-a1a0f5c3d13c]]" and the writer spent the
   *  rest of the sentence looking at a uuid. The stored form is still the
   *  token — that is the whole point of tokens — but the composer is a surface
   *  for a person, and a person is owed the name.
   *
   *  The pairing is remembered here, in `picked`, rather than re-derived by
   *  searching the text at submit time: two members can share a display name,
   *  and a name that appears in prose ("ask Bo Test about it") was never a
   *  mention. Only what was actually chosen from the list becomes a token. */
  const choose = (c: Candidate) => {
    const el = taRef.current;
    const caret = el?.selectionStart ?? value.length;
    const shown = mentionLabel(c);
    const next = value.slice(0, anchorRef.current) + shown + " " + value.slice(caret);
    picked.current = [...picked.current, { shown, token: c.token }];
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      const pos = anchorRef.current + shown.length + 1;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  /** Watch what is being typed just before the caret. */
  const onInput = (next: string, caret: number) => {
    // Look back to the nearest "@" that starts a word. Anything with a space in
    // it is prose, not a half-typed mention.
    const upto = next.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at < 0 || (at > 0 && !/\s/.test(upto[at - 1] ?? ""))) {
      setQuery(null);
      return;
    }
    const frag = upto.slice(at + 1);
    if (/\s/.test(frag)) {
      setQuery(null);
      return;
    }
    anchorRef.current = at;
    setQuery(frag);
  };

  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (query === null || candidates.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (s + 1) % candidates.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (s - 1 + candidates.length) % candidates.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      choose(candidates[sel]!);
      return true;
    }
    if (e.key === "Escape") {
      setQuery(null);
      return true;
    }
    return false;
  };

  const element =
    query !== null && candidates.length > 0 ? (
      <div className="mb-2 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg overflow-hidden">
        {candidates.map((c, i) => (
          <button
            key={c.token}
            type="button"
            onMouseDown={(e) => {
              // mousedown, not click: the textarea must not lose focus first.
              e.preventDefault();
              choose(c);
            }}
            className={
              "w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition " +
              (i === sel
                ? "bg-subtle dark:bg-slate-800 text-content dark:text-mortar-100"
                : "text-muted hover:bg-subtle/60 dark:hover:bg-slate-800/60")
            }
          >
            <AtSign size={12} className="shrink-0 text-faint" />
            <span className="truncate">{c.label}</span>
            <span className="ml-auto shrink-0 text-[10px] font-mono uppercase tracking-widest text-faint">
              {c.hint}
            </span>
          </button>
        ))}
      </div>
    ) : null;

  /** The draft, with every chosen mention turned back into its token.
   *
   *  Call this on send. Anything the writer deleted or typed over simply is not
   *  found, and so is not a mention — which is the honest reading: the audience
   *  is computed from the tokens, and a name nobody picked was never addressed.
   *
   *  Longest label first, so "@Bo" cannot consume the front of "@Bo Test" and
   *  leave " Test" stranded in the sentence. */
  const resolve = (draft: string): string => resolveMentions(draft, picked.current);

  /** Forget what was picked. Call this when the draft is GONE — i.e. after it
   *  sent — never merely because it was resolved: a post that failed leaves the
   *  writer looking at their sentence, and pressing send again must still
   *  address the people they chose. */
  const reset = () => {
    picked.current = [];
  };

  return { onInput, onKeyDown, element, resolve, reset, open: query !== null };
}
